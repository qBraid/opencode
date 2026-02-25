/**
 * Quantum Tools
 *
 * Native Codeq tool definitions for quantum computing operations.
 * These replace the pod_mcp MCP server for core quantum workflows,
 * running in-process with access to Codeq's auth, permissions, and telemetry.
 */

import z from "zod"
import { Tool } from "../tool/tool"
import * as client from "./client"
import * as QuantumState from "./state"

// ============================================================================
// quantum_devices — List available quantum devices
// ============================================================================

export const QuantumDevicesTool = Tool.define("quantum_devices", {
  description: [
    "List available quantum computing devices (QPUs and simulators) from qBraid.",
    "Returns device ID, name, vendor, status, qubit count, and pricing.",
    "Use the status and provider filters to narrow results.",
    "Device IDs from this list are needed for job submission and cost estimation.",
  ].join("\n"),
  parameters: z.object({
    status: z.enum(["online", "offline", "all"]).optional()
      .describe("Filter devices by status. Defaults to all."),
    provider: z.string().optional()
      .describe("Filter by provider (e.g., 'ibm', 'aws', 'ionq', 'rigetti')."),
  }),
  async execute(params, ctx) {
    const devices = await client.listDevices({
      status: params.status === "all" ? undefined : params.status,
      provider: params.provider,
    }, ctx.abort)

    if (devices.length === 0) {
      return {
        title: "No devices found",
        metadata: { count: 0 },
        output: "No quantum devices match the given filters.",
      }
    }

    const lines = devices.map((d) => {
      const pricing = d.pricing
        ? `${d.pricing.perShot ?? 0}/shot + ${d.pricing.perTask ?? 0}/task credits`
        : "N/A"
      return `${d.id} | ${d.name} | ${d.vendor} | ${d.status} | ${d.qubits}q | ${d.paradigm} | ${pricing}`
    })

    const header = "ID | Name | Vendor | Status | Qubits | Paradigm | Pricing"
    const separator = "-".repeat(80)
    const output = [header, separator, ...lines].join("\n")

    return {
      title: `${devices.length} quantum devices`,
      metadata: { count: devices.length },
      output,
    }
  },
})

// ============================================================================
// quantum_estimate_cost — Estimate cost before submitting a job
// ============================================================================

export const QuantumEstimateCostTool = Tool.define("quantum_estimate_cost", {
  description: [
    "Estimate the cost in qBraid credits for running a quantum job on a specific device.",
    "Use this BEFORE submitting a job to check the cost and user's credit balance.",
    "Returns the estimated cost breakdown and the user's current credit balance.",
  ].join("\n"),
  parameters: z.object({
    device_id: z.string().describe("The quantum device ID to estimate cost for."),
    shots: z.number().int().min(1).default(1024)
      .describe("Number of measurement shots."),
  }),
  async execute(params, ctx) {
    const [estimate, credits] = await Promise.all([
      client.estimateCost(params.device_id, params.shots, ctx.abort),
      client.getCredits(ctx.abort).catch(() => null),
    ])

    const balance = credits ? credits.qbraidCredits + credits.awsCredits : -1
    const balanceStr = balance >= 0 ? `${balance.toFixed(2)}` : "unknown"
    const sufficient = balance >= 0
      ? (balance >= estimate.estimatedCredits ? "Yes" : "NO — insufficient credits")
      : "unknown"

    const pricingNote = estimate.pricingAvailable
      ? ""
      : "\nWARNING: Pricing data unavailable for this device. Actual cost may differ."

    const output = [
      `Device: ${params.device_id}`,
      `Shots: ${params.shots}`,
      `Estimated cost: ${estimate.estimatedCredits.toFixed(4)} credits`,
      `  Per-shot: ${estimate.breakdown.perShot.toFixed(4)}`,
      `  Per-task: ${estimate.breakdown.perTask.toFixed(4)}`,
      `Current balance: ${balanceStr} credits`,
      `Sufficient funds: ${sufficient}`,
      pricingNote,
    ].filter(Boolean).join("\n")

    return {
      title: `Cost estimate: ${estimate.estimatedCredits.toFixed(4)} credits`,
      metadata: { cost: estimate.estimatedCredits, balance, pricingAvailable: estimate.pricingAvailable },
      output,
    }
  },
})

// ============================================================================
// quantum_submit_job — Submit a QASM circuit with cost approval
// ============================================================================

export const QuantumSubmitJobTool = Tool.define("quantum_submit_job", {
  description: [
    "Submit a quantum circuit (OpenQASM format) to a device for execution.",
    "IMPORTANT: This tool uses the native permission system to get user approval",
    "for the estimated cost before submitting. The user will see a cost estimate",
    "and must explicitly approve the submission.",
    "Use quantum_estimate_cost first to check costs, then call this to submit.",
  ].join("\n"),
  parameters: z.object({
    device_id: z.string().describe("The quantum device ID to run on."),
    qasm: z.string().describe("The OpenQASM 2.0 or 3.0 circuit code."),
    shots: z.number().int().min(1).default(1024).describe("Number of measurement shots."),
  }),
  async execute(params, ctx) {
    // Estimate cost first
    const estimate = await client.estimateCost(params.device_id, params.shots, ctx.abort)

    const costNote = estimate.pricingAvailable
      ? `~${estimate.estimatedCredits.toFixed(4)} credits`
      : "unknown (pricing unavailable)"

    // Use Codeq's native permission system for cost approval
    await ctx.ask({
      permission: "quantum_submit",
      patterns: [params.device_id],
      always: [],
      metadata: {
        device: params.device_id,
        shots: params.shots,
        cost: estimate.estimatedCredits,
        pricingAvailable: estimate.pricingAvailable,
        summary: `Submit quantum job to ${params.device_id} (${params.shots} shots, ${costNote})`,
      },
    })

    const job = await client.submitJob({
      deviceId: params.device_id,
      qasm: params.qasm,
      shots: params.shots,
    }, ctx.abort)

    // Refresh sidebar state — new active job + credits may have changed
    QuantumState.refreshJobs().catch(() => {})
    QuantumState.refreshCredits().catch(() => {})

    return {
      title: `Job submitted: ${job.id}`,
      metadata: { jobId: job.id, device: params.device_id },
      output: [
        `Job ID: ${job.id}`,
        `Device: ${job.device}`,
        `Status: ${job.status}`,
        `Shots: ${job.shots}`,
        `Created: ${job.createdAt}`,
        ``,
        `Use quantum_get_result with this job ID to retrieve results when complete.`,
      ].join("\n"),
    }
  },
})

// ============================================================================
// quantum_get_result — Retrieve results from a submitted job
// ============================================================================

export const QuantumGetResultTool = Tool.define("quantum_get_result", {
  description: [
    "Retrieve the measurement results from a previously submitted quantum job.",
    "If the job is still running, returns the current status.",
    "Measurement results are returned as a dictionary of bitstring counts.",
  ].join("\n"),
  parameters: z.object({
    job_id: z.string().describe("The quantum job ID to retrieve results for."),
  }),
  async execute(params, ctx) {
    const job = await client.getJob(params.job_id, ctx.abort)
    const status = job.status.toUpperCase()

    // Refresh sidebar — job status may have transitioned
    QuantumState.refreshJobs().catch(() => {})

    if (status !== "COMPLETED") {
      return {
        title: `Job ${params.job_id}: ${job.status}`,
        metadata: { jobId: params.job_id, status: job.status },
        output: [
          `Job ID: ${params.job_id}`,
          `Status: ${job.status}`,
          `Device: ${job.device}`,
          status === "QUEUED" || status === "RUNNING"
            ? "The job is still processing. Try again in a moment."
            : `The job ended with status: ${job.status}`,
        ].join("\n"),
      }
    }

    let result: client.JobResult
    try {
      result = await client.getResult(params.job_id, ctx.abort)
    } catch (error) {
      return {
        title: `Job ${params.job_id}: completed (results unavailable)`,
        metadata: { jobId: params.job_id, status: job.status },
        output: [
          `Job ID: ${params.job_id}`,
          `Status: ${job.status}`,
          `Device: ${job.device}`,
          `Error retrieving results: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n"),
      }
    }

    const measurements = result.measurements
      ? Object.entries(result.measurements)
          .sort(([, a], [, b]) => b - a)
          .map(([state, count]) => `  ${state}: ${count}`)
          .join("\n")
      : "No measurement data available"

    return {
      title: `Results: ${params.job_id}`,
      metadata: { jobId: params.job_id, status: job.status },
      output: [
        `Job ID: ${params.job_id}`,
        `Status: ${job.status}`,
        `Device: ${job.device}`,
        `Cost: ${job.cost ?? "N/A"} credits`,
        ``,
        `Measurement results:`,
        measurements,
      ].join("\n"),
    }
  },
})

// ============================================================================
// quantum_cancel_job — Cancel a running or queued job
// ============================================================================

export const QuantumCancelJobTool = Tool.define("quantum_cancel_job", {
  description: "Cancel a queued or running quantum job. Requires user confirmation. Returns whether the cancellation succeeded.",
  parameters: z.object({
    job_id: z.string().describe("The quantum job ID to cancel."),
  }),
  async execute(params, ctx) {
    // Cancellation is destructive — require user approval
    await ctx.ask({
      permission: "quantum_cancel",
      patterns: [params.job_id],
      always: [],
      metadata: {
        jobId: params.job_id,
        summary: `Cancel quantum job ${params.job_id}`,
      },
    })

    const result = await client.cancelJob(params.job_id, ctx.abort)

    // Refresh sidebar — job removed from active, credits may be refunded
    QuantumState.refreshJobs().catch(() => {})
    QuantumState.refreshCredits().catch(() => {})

    return {
      title: result.success ? `Cancelled: ${params.job_id}` : `Cancel failed: ${params.job_id}`,
      metadata: { success: result.success },
      output: result.success
        ? `Successfully cancelled job ${params.job_id}.`
        : `Failed to cancel job ${params.job_id}. It may have already completed or been cancelled.`,
    }
  },
})

// ============================================================================
// quantum_list_jobs — List recent quantum jobs
// ============================================================================

export const QuantumListJobsTool = Tool.define("quantum_list_jobs", {
  description: "List recent quantum jobs with optional status filter. Shows job IDs, devices, status, and costs.",
  parameters: z.object({
    status: z.string().optional().describe("Filter by job status (e.g., 'COMPLETED', 'RUNNING', 'QUEUED', 'FAILED')."),
    limit: z.number().int().min(1).max(100).default(10).describe("Maximum number of jobs to return."),
  }),
  async execute(params, ctx) {
    const jobs = await client.listJobs({
      status: params.status,
      limit: params.limit,
    }, ctx.abort)

    if (jobs.length === 0) {
      return {
        title: "No jobs found",
        metadata: { count: 0 },
        output: "No quantum jobs match the given filters.",
      }
    }

    const lines = jobs.map((j) =>
      `${j.id} | ${j.device} | ${j.status} | ${j.shots} shots | ${j.cost ?? "N/A"} credits | ${j.createdAt}`,
    )

    const header = "ID | Device | Status | Shots | Cost | Created"
    const output = [header, "-".repeat(80), ...lines].join("\n")

    return {
      title: `${jobs.length} quantum jobs`,
      metadata: { count: jobs.length },
      output,
    }
  },
})

/**
 * All quantum tools for registration in the tool registry.
 */
export const QUANTUM_TOOLS = [
  QuantumDevicesTool,
  QuantumEstimateCostTool,
  QuantumSubmitJobTool,
  QuantumGetResultTool,
  QuantumCancelJobTool,
  QuantumListJobsTool,
]
