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
        ? `${d.pricing.perShot ?? 0}/shot + ${d.pricing.perTask ?? 0}/task`
        : "N/A"
      const queue = d.queueDepth > 0 ? `queue:${d.queueDepth}` : "idle"
      return `${d.id} | ${d.name} | ${d.vendor} | ${d.type} | ${d.status} | ${d.qubits}q | ${queue} | ${pricing}`
    })

    const header = "ID | Name | Vendor | Type | Status | Qubits | Queue | Pricing"
    const separator = "-".repeat(100)
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

// ============================================================================
// quantum_environments — List and search software environments
// ============================================================================

export const QuantumEnvironmentsTool = Tool.define("quantum_environments", {
  description: [
    "List and search qBraid software environments.",
    "Environments are pre-built Python packages (Qiskit, Cirq, PennyLane, CUDA-Q, etc.)",
    "that can be installed into a qBraid compute server.",
    "Returns environment slug, name, description, tags, and installed packages.",
    "Use the slug to get full package details with quantum_environment_packages.",
  ].join("\n"),
  parameters: z.object({
    search: z.string().optional()
      .describe("Filter environments by name, tag, or package (e.g., 'qiskit', 'cirq', 'gpu')."),
    limit: z.number().int().min(1).max(50).default(10)
      .describe("Maximum number of environments to return."),
  }),
  async execute(params, ctx) {
    const result = await client.listEnvironments({ limit: params.limit }, ctx.abort)

    let envs = result.environments
    if (params.search) {
      const q = params.search.toLowerCase()
      envs = envs.filter((e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase().includes(q)) ||
        e.packages.some((p) => p.toLowerCase().startsWith(q)),
      )
    }

    if (envs.length === 0) {
      return {
        title: "No environments found",
        metadata: { count: 0, total: result.total },
        output: "No environments match the given search. Try a different term.",
      }
    }

    const lines = envs.map((e) => {
      const tags = e.tags.slice(0, 5).join(", ")
      return `${e.slug} | ${e.name} | ${tags} | ${e.packages.length} packages`
    })

    const header = "Slug | Name | Tags | Packages"
    const output = [header, "-".repeat(80), ...lines].join("\n")

    return {
      title: `${envs.length} environments`,
      metadata: { count: envs.length, total: result.total },
      output,
    }
  },
})

// ============================================================================
// quantum_environment_packages — Get detailed package list for an environment
// ============================================================================

export const QuantumEnvironmentPackagesTool = Tool.define("quantum_environment_packages", {
  description: [
    "Get the full list of installed packages for a qBraid environment.",
    "Returns every pip package and version installed in the environment.",
    "Use quantum_environments first to find the environment slug.",
  ].join("\n"),
  parameters: z.object({
    slug: z.string().describe("The environment slug (e.g., 'qiskit_9vrlwn')."),
  }),
  async execute(params, ctx) {
    const env = await client.getEnvironment(params.slug, ctx.abort)

    const pkgList = env.packages.length > 0
      ? env.packages.join("\n")
      : "No package data available."

    return {
      title: `${env.name}: ${env.packages.length} packages`,
      metadata: { slug: params.slug, count: env.packages.length },
      output: [
        `Environment: ${env.name}`,
        `Slug: ${env.slug}`,
        `Description: ${env.description}`,
        `Tags: ${env.tags.join(", ")}`,
        `Platform: ${env.platform.join(", ")}`,
        env.python ? `Python: ${env.python}` : null,
        ``,
        `Installed packages (${env.packages.length}):`,
        pkgList,
      ].filter(Boolean).join("\n"),
    }
  },
})

// ============================================================================
// quantum_compute_profiles — List available compute server configurations
// ============================================================================

export const QuantumComputeProfilesTool = Tool.define("quantum_compute_profiles", {
  description: [
    "List available compute server profiles on qBraid.",
    "Shows CPU/GPU configurations, memory, pricing, IDE type, and availability.",
    "Profiles range from free JupyterLab instances to Lambda Cloud GPU servers.",
    "Use a profile slug with quantum_compute_start to launch a server.",
  ].join("\n"),
  parameters: z.object({
    gpu: z.boolean().optional()
      .describe("Filter to GPU-only (true) or CPU-only (false) profiles."),
  }),
  async execute(params, ctx) {
    const profiles = await client.listComputeProfiles(
      { gpu: params.gpu },
      ctx.abort,
    )

    if (profiles.length === 0) {
      return {
        title: "No compute profiles found",
        metadata: { count: 0 },
        output: "No compute profiles match the given filters.",
      }
    }

    const lines = profiles.map((p) => {
      const specs = [
        p.cpu ? `${p.cpu} vCPU` : null,
        p.memory,
        p.gpu ? "GPU" : null,
      ].filter(Boolean).join(", ")
      const cost = p.creditCost ? `${p.creditCost.toFixed(2)} credits/min` : p.rate
      const avail = p.available ? "available" : "full"
      return `${p.slug} | ${p.name} | ${specs} | ${p.ide} | ${cost} | ${p.plan} | ${avail}`
    })

    const header = "Slug | Name | Specs | IDE | Cost | Plan | Status"
    const output = [header, "-".repeat(100), ...lines].join("\n")

    return {
      title: `${profiles.length} compute profiles`,
      metadata: { count: profiles.length },
      output,
    }
  },
})

// ============================================================================
// quantum_compute_status — Check compute server status
// ============================================================================

export const QuantumComputeStatusTool = Tool.define("quantum_compute_status", {
  description: [
    "Check the status of your qBraid compute server.",
    "Shows whether a server is running, starting, or stopped,",
    "and which profile is active.",
  ].join("\n"),
  parameters: z.object({}),
  async execute(_params, ctx) {
    const status = await client.getServerStatus(ctx.abort)

    const state = status.running ? "running" : status.starting ? "starting" : "stopped"
    const lines = [
      `Server status: ${state}`,
      status.profile ? `Active profile: ${status.profile}` : null,
      status.clusterId ? `Cluster: ${status.clusterId}` : null,
    ].filter(Boolean)

    return {
      title: `Compute: ${state}`,
      metadata: { running: status.running, starting: status.starting },
      output: lines.join("\n"),
    }
  },
})

// ============================================================================
// quantum_compute_start — Start a compute server
// ============================================================================

export const QuantumComputeStartTool = Tool.define("quantum_compute_start", {
  description: [
    "Start a qBraid compute server with a specific profile.",
    "This launches a JupyterLab or VS Code instance in the cloud.",
    "Use quantum_compute_profiles to see available profiles first.",
    "Starting a server costs credits per minute while running.",
  ].join("\n"),
  parameters: z.object({
    profile: z.string().describe("The compute profile slug (e.g., '2vCPU_4GB', '4vCPU_16GB_GPU')."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "compute_start",
      patterns: [params.profile],
      always: [],
      metadata: {
        profile: params.profile,
        summary: `Start compute server with profile: ${params.profile}`,
      },
    })

    const result = await client.startServer(params.profile, ctx.abort)

    // Refresh sidebar
    QuantumState.refreshCompute().catch(() => {})

    return {
      title: `Server ${result.status}`,
      metadata: { profile: params.profile, status: result.status },
      output: [
        `Status: ${result.status}`,
        `Profile: ${params.profile}`,
        result.message,
        "",
        "The server may take 1-3 minutes to fully start.",
        "Use quantum_compute_status to check when it's ready.",
      ].join("\n"),
    }
  },
})

// ============================================================================
// quantum_compute_stop — Stop the running compute server
// ============================================================================

export const QuantumComputeStopTool = Tool.define("quantum_compute_stop", {
  description: "Stop your running qBraid compute server. Requires user confirmation.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "compute_stop",
      patterns: [],
      always: [],
      metadata: {
        summary: "Stop your qBraid compute server",
      },
    })

    const result = await client.stopServer(ctx.abort)

    QuantumState.refreshCompute().catch(() => {})

    return {
      title: `Server ${result.status}`,
      metadata: { status: result.status },
      output: `${result.message}\nStatus: ${result.status}`,
    }
  },
})

// ============================================================================
// quantum_account — Show account info, credits, quotas, and usage
// ============================================================================

export const QuantumAccountTool = Tool.define("quantum_account", {
  description: [
    "Show your qBraid account information including credits, AI chat usage,",
    "subscription tier, disk usage, and compute hours.",
    "Useful for checking remaining resources before running jobs or starting servers.",
  ].join("\n"),
  parameters: z.object({}),
  async execute(_params, ctx) {
    const [user, credits, aiUsage] = await Promise.all([
      client.getUserContext(ctx.abort),
      client.getCredits(ctx.abort).catch(() => null),
      client.getAIChatUsage(ctx.abort).catch(() => null),
    ])

    const orgs = Object.entries(user.organizations)
    const lines: string[] = [
      `User: ${user.user.userName} (${user.user.email})`,
      ``,
    ]

    if (credits) {
      lines.push(`Credits:`)
      lines.push(`  qBraid: ${credits.qbraidCredits.toFixed(2)}`)
      if (credits.awsCredits > 0) lines.push(`  AWS: ${credits.awsCredits.toFixed(2)}`)
      lines.push(``)
    }

    if (aiUsage) {
      lines.push(`AI Chat:`)
      lines.push(`  Quota used: ${aiUsage.percentUsed.toFixed(1)}% ($${aiUsage.used.toFixed(2)} / $${aiUsage.quota.toFixed(2)})`)
      lines.push(`  Remaining: $${aiUsage.remaining.toFixed(4)}`)
      lines.push(`  Can send: ${aiUsage.canSend ? "yes" : "NO — quota exhausted"}`)
      if (aiUsage.usingCredits) lines.push(`  Using credits: yes`)
      if (aiUsage.renewalDate) lines.push(`  Renews: ${new Date(aiUsage.renewalDate).toLocaleDateString()}`)
      lines.push(``)
    }

    for (const [id, org] of orgs) {
      lines.push(`Organization: ${org.name}`)
      lines.push(`  Tier: ${org.subscriptionTier}`)
      lines.push(`  Roles: ${org.roles.join(", ")}`)
      if (org.wallet) {
        lines.push(`  Wallet: ${org.wallet.qbraidCredits.toFixed(2)} qBraid / ${org.wallet.awsCredits.toFixed(2)} AWS credits`)
      }
      if (org.diskUsage) {
        lines.push(`  Disk: ${org.diskUsage.totalGB.toFixed(1)} / ${org.diskUsage.quotaGB} GB`)
      }
      lines.push(``)
    }

    return {
      title: `Account: ${user.user.userName}`,
      metadata: { email: user.user.email, orgs: orgs.length },
      output: lines.join("\n"),
    }
  },
})

// ============================================================================
// quantum_job_circuit — Get ASCII circuit diagram for a submitted job
// ============================================================================

export const QuantumJobCircuitTool = Tool.define("quantum_job_circuit", {
  description: [
    "Get the ASCII circuit diagram for a previously submitted quantum job.",
    "Renders the quantum circuit in ASCII art, perfect for terminal display.",
    "Use quantum_list_jobs to find job IDs.",
  ].join("\n"),
  parameters: z.object({
    job_id: z.string().describe("The quantum job ID to get the circuit diagram for."),
  }),
  async execute(params, ctx) {
    const circuit = await client.getJobCircuit(params.job_id, ctx.abort)

    return {
      title: `Circuit: ${params.job_id}`,
      metadata: { jobId: params.job_id },
      output: [
        `Circuit diagram for job ${params.job_id}:`,
        ``,
        circuit,
      ].join("\n"),
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
  QuantumEnvironmentsTool,
  QuantumEnvironmentPackagesTool,
  QuantumComputeProfilesTool,
  QuantumComputeStatusTool,
  QuantumComputeStartTool,
  QuantumComputeStopTool,
  QuantumAccountTool,
  QuantumJobCircuitTool,
]
