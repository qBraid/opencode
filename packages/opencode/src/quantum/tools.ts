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
import * as Jupyter from "./jupyter"

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
    "Check the status of all qBraid compute instances.",
    "Shows every running, starting, or stopped instance with its name, profile, and status.",
    "You can run multiple named instances simultaneously (limits depend on billing plan).",
  ].join("\n"),
  parameters: z.object({}),
  async execute(_params, ctx) {
    // Try multi-instance listServers first, fall back to legacy
    try {
      const result = await client.listServers(ctx.abort)
      if (result.servers.length === 0) {
        return {
          title: "No compute instances",
          metadata: { count: 0 },
          output: "No compute instances are running. Use quantum_compute_start to launch one.",
        }
      }
      const lines = result.servers.map((s) => {
        const name = s.name || "(default)"
        return `${name} | ${s.profile ?? "unknown"} | ${s.status}${s.startedAt ? ` | started ${s.startedAt}` : ""}`
      })
      const header = "Name | Profile | Status | Started"
      return {
        title: `${result.servers.length} compute instance(s)`,
        metadata: { count: result.servers.length },
        output: [header, "-".repeat(80), ...lines].join("\n"),
      }
    } catch {
      // Fall back to legacy single-server status
      const status = await client.getServerStatus(ctx.abort)
      const st = status.running ? "running" : status.starting ? "starting" : "stopped"
      const count = st === "stopped" ? 0 : 1
      const lines = [
        `Server status: ${st}`,
        status.profile ? `Active profile: ${status.profile}` : null,
        status.clusterId ? `Cluster: ${status.clusterId}` : null,
      ].filter(Boolean)
      return {
        title: `Compute: ${st}`,
        metadata: { count },
        output: lines.join("\n"),
      }
    }
  },
})

// ============================================================================
// quantum_compute_start — Start a compute server
// ============================================================================

export const QuantumComputeStartTool = Tool.define("quantum_compute_start", {
  description: [
    "Start a qBraid compute instance with a specific profile.",
    "You can run MULTIPLE named instances simultaneously (limits depend on billing plan).",
    "Provide a unique name to launch additional instances alongside existing ones.",
    "Omit name to use the default (unnamed) instance.",
    "Use quantum_compute_profiles to see available profiles first.",
    "Starting an instance costs credits per minute while running.",
  ].join("\n"),
  parameters: z.object({
    profile: z.string().describe("The compute profile slug (e.g., '2vCPU_4GB', '4vCPU_16GB_GPU')."),
    name: z.string().optional().describe("Optional instance name for multi-instance. Use unique names like 'gpu-1', 'sim-worker'. Omit for the default instance."),
  }),
  async execute(params, ctx) {
    const label = params.name ? `${params.name} (${params.profile})` : params.profile
    await ctx.ask({
      permission: "compute_start",
      patterns: [label],
      always: [],
      metadata: {
        profile: params.profile,
        name: params.name,
        summary: `Start compute instance${params.name ? ` "${params.name}"` : ""} with profile: ${params.profile}`,
      },
    })

    const serverName = params.name ?? ""

    // Optimistically show instance in sidebar immediately
    QuantumState.instanceStarting(serverName, params.profile)

    const result = await client.startServer(params.profile, ctx.abort, params.name)

    // Refresh with real status from API
    QuantumState.refreshCompute().catch(() => {})

    return {
      title: `Instance ${result.status}${params.name ? `: ${params.name}` : ""}`,
      metadata: { profile: params.profile, name: params.name, status: result.status },
      output: [
        params.name ? `Instance: ${params.name}` : null,
        `Status: ${result.status}`,
        `Profile: ${params.profile}`,
        result.message,
        "",
        "The instance may take 1-3 minutes to fully start.",
        "Use quantum_compute_status to check when it's ready.",
      ].filter(Boolean).join("\n"),
    }
  },
})

// ============================================================================
// quantum_compute_stop — Stop the running compute server
// ============================================================================

export const QuantumComputeStopTool = Tool.define("quantum_compute_stop", {
  description: [
    "Stop a running qBraid compute instance. Requires user confirmation.",
    "Provide the instance name to stop a specific named instance.",
    "Omit name to stop the default (unnamed) instance.",
  ].join("\n"),
  parameters: z.object({
    name: z.string().optional().describe("Instance name to stop. Omit to stop the default instance."),
  }),
  async execute(params, ctx) {
    const label = params.name ?? "default"
    await ctx.ask({
      permission: "compute_stop",
      patterns: [label],
      always: [],
      metadata: {
        name: params.name,
        summary: `Stop compute instance${params.name ? ` "${params.name}"` : ""}`,
      },
    })

    const result = await client.stopServer(ctx.abort, params.name)

    QuantumState.refreshCompute().catch(() => {})

    return {
      title: `Instance ${result.status}${params.name ? `: ${params.name}` : ""}`,
      metadata: { name: params.name, status: result.status },
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

// ============================================================================
// Jupyter session helper — shared by all remote tools
// ============================================================================

async function resolveJupyterSession(signal?: AbortSignal, serverName?: string): Promise<Jupyter.JupyterSession> {
  // For named instances, check via listServers; for default, use legacy status
  if (serverName) {
    const result = await client.listServers(signal)
    const srv = result.servers.find((s) => s.name === serverName)
    if (!srv || srv.status !== "running") {
      throw new Error(
        `Compute instance "${serverName}" is not running. Use quantum_compute_start with name="${serverName}" to launch it first.`,
      )
    }
  } else {
    const status = await client.getServerStatus(signal)
    if (!status.running) {
      throw new Error(
        "Compute server is not running. Use quantum_compute_start to launch one first.",
      )
    }
  }

  const data = await client.getSessionToken(signal, serverName)
  return Jupyter.sessionFromApi(data)
}

// ============================================================================
// quantum_remote_exec — Execute Python code on the cloud server
// ============================================================================

export const QuantumRemoteExecTool = Tool.define("quantum_remote_exec", {
  description: [
    "Execute Python code on a running qBraid compute instance.",
    "The code runs in a fresh Python kernel on the cloud instance,",
    "with access to all installed packages (Qiskit, Cirq, PennyLane, etc.).",
    "Returns stdout, stderr, and execution status.",
    "Provide instance name to target a specific named instance.",
    "REQUIRES a running compute instance — use quantum_compute_start first.",
  ].join("\n"),
  parameters: z.object({
    code: z.string().describe("Python code to execute on the remote instance."),
    timeout: z.number().int().min(1000).max(120000).default(30000)
      .describe("Execution timeout in milliseconds. Default 30s, max 120s."),
    kernel: z.string().default("python3")
      .describe("Kernel name to use (default: python3). Use quantum_remote_kernels to see available kernels."),
    instance: z.string().optional()
      .describe("Instance name to execute on. Omit for the default instance."),
  }),
  async execute(params, ctx) {
    const name = params.instance ?? ""
    const session = await resolveJupyterSession(ctx.abort, params.instance)

    // Show execution status in sidebar
    const snippet = params.code.split("\n")[0].slice(0, 40)
    QuantumState.setExecuting(name, snippet + (params.code.length > 40 ? "..." : ""))
    QuantumState.setKernels(name, (QuantumState.get().instances.find((i) => i.name === name)?.kernels ?? 0) + 1)

    try {
      const result = await Jupyter.executeCode(session, params.code, {
        timeout: params.timeout,
        kernelName: params.kernel,
        signal: ctx.abort,
      })

      const output = [
        params.instance ? `Instance: ${params.instance}` : null,
        result.stdout ? `stdout:\n${result.stdout}` : null,
        result.stderr ? `stderr:\n${result.stderr}` : null,
        `\nExecution status: ${result.status}`,
        result.error ? `Error: ${result.error.name}: ${result.error.value}` : null,
      ].filter(Boolean).join("\n")

      return {
        title: result.status === "ok" ? "Executed successfully" : "Execution failed",
        metadata: { status: result.status, instance: params.instance },
        output,
      }
    } finally {
      // Clear execution indicator
      QuantumState.setExecuting(name, undefined)
      const kernels = Math.max(0, (QuantumState.get().instances.find((i) => i.name === name)?.kernels ?? 1) - 1)
      QuantumState.setKernels(name, kernels)
    }
  },
})

// ============================================================================
// quantum_remote_files — List files on the cloud server
// ============================================================================

export const QuantumRemoteFilesTool = Tool.define("quantum_remote_files", {
  description: [
    "List files and directories on a qBraid compute instance.",
    "Shows the remote workspace filesystem.",
    "REQUIRES a running compute instance.",
  ].join("\n"),
  parameters: z.object({
    path: z.string().default("")
      .describe("Directory path to list. Empty string for root."),
    instance: z.string().optional()
      .describe("Instance name to list files on. Omit for the default instance."),
  }),
  async execute(params, ctx) {
    const session = await resolveJupyterSession(ctx.abort, params.instance)
    const files = await Jupyter.listFiles(session, params.path, ctx.abort)

    if (files.length === 0) {
      return {
        title: "Empty directory",
        metadata: { count: 0 },
        output: `No files in ${params.path || "/"}`,
      }
    }

    const lines = files.map((f) => {
      const icon = f.type === "directory" ? "dir " : f.type === "notebook" ? "nb  " : "file"
      const size = f.type === "directory" ? "" : ` (${formatSize(f.size)})`
      return `  ${icon}  ${f.name}${size}`
    })

    return {
      title: `${files.length} items in ${params.path || "/"}`,
      metadata: { count: files.length },
      output: lines.join("\n"),
    }
  },
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

// ============================================================================
// quantum_remote_read — Read a file from the cloud server
// ============================================================================

export const QuantumRemoteReadTool = Tool.define("quantum_remote_read", {
  description: [
    "Read the contents of a file on a qBraid compute instance.",
    "Works with text files, Python scripts, and Jupyter notebooks.",
    "REQUIRES a running compute instance.",
  ].join("\n"),
  parameters: z.object({
    path: z.string().describe("File path to read (e.g., 'my_circuit.py')."),
    instance: z.string().optional()
      .describe("Instance name to read from. Omit for the default instance."),
  }),
  async execute(params, ctx) {
    const session = await resolveJupyterSession(ctx.abort, params.instance)
    const content = await Jupyter.readFile(session, params.path, ctx.abort)

    return {
      title: `File: ${params.path}`,
      metadata: { path: params.path, size: content.length },
      output: content,
    }
  },
})

// ============================================================================
// quantum_remote_write — Write a file to the cloud server
// ============================================================================

export const QuantumRemoteWriteTool = Tool.define("quantum_remote_write", {
  description: [
    "Write a file to a qBraid compute instance.",
    "Creates or overwrites a file in the remote workspace.",
    "Use this to upload Python scripts, quantum circuits, or notebooks",
    "before executing them with quantum_remote_exec.",
    "REQUIRES a running compute instance.",
  ].join("\n"),
  parameters: z.object({
    path: z.string().describe("File path to write (e.g., 'bell_state.py')."),
    content: z.string().describe("File content to write."),
    instance: z.string().optional()
      .describe("Instance name to write to. Omit for the default instance."),
  }),
  async execute(params, ctx) {
    const session = await resolveJupyterSession(ctx.abort, params.instance)
    await Jupyter.writeFile(session, params.path, params.content, ctx.abort)

    return {
      title: `Wrote: ${params.path}`,
      metadata: { path: params.path, size: params.content.length },
      output: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
    }
  },
})

// ============================================================================
// quantum_remote_kernels — List available kernels on the cloud server
// ============================================================================

export const QuantumRemoteKernelsTool = Tool.define("quantum_remote_kernels", {
  description: [
    "List available Jupyter kernels on a qBraid compute instance.",
    "Shows which Python environments and languages are available for execution.",
    "REQUIRES a running compute instance.",
  ].join("\n"),
  parameters: z.object({
    instance: z.string().optional()
      .describe("Instance name to list kernels on. Omit for the default instance."),
  }),
  async execute(params, ctx) {
    const session = await resolveJupyterSession(ctx.abort, params.instance)
    const kernels = await Jupyter.listKernelSpecs(session, ctx.abort)

    if (kernels.length === 0) {
      return {
        title: "No kernels found",
        metadata: { count: 0 },
        output: "No kernel specs found on the remote server.",
      }
    }

    const lines = kernels.map((k) =>
      `  ${k.name} | ${k.displayName} | ${k.language}`,
    )

    return {
      title: `${kernels.length} kernels available`,
      metadata: { count: kernels.length },
      output: ["Name | Display Name | Language", "-".repeat(60), ...lines].join("\n"),
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
  QuantumRemoteExecTool,
  QuantumRemoteFilesTool,
  QuantumRemoteReadTool,
  QuantumRemoteWriteTool,
  QuantumRemoteKernelsTool,
]
