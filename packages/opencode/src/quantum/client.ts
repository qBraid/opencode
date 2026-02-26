/**
 * qBraid Quantum API Client
 *
 * TypeScript HTTP client for the qBraid quantum runtime API.
 * Replaces the Python SDK dependency for device listing, job submission,
 * and result retrieval — keeping everything in-process.
 */

import { Log } from "../util/log"
import { Auth } from "../auth"
import z from "zod"
import path from "path"
import os from "os"
import fs from "fs/promises"

const log = Log.create({ service: "quantum:client" })

const DEFAULT_API_URL = "https://api-v2.qbraid.com/api/v1"
const MAX_ERROR_BODY = 500

// --- Zod schemas for API response validation ---

// Schemas match qBraid API v1 wire format and normalize to internal types.
// Devices use qrn as ID; jobs use jobQrn. Both use passthrough() to
// tolerate extra fields from the API without failing.

const QuantumDeviceSchema = z.object({
  _id: z.string().optional(),
  qrn: z.string().optional(),
  name: z.string(),
  vendor: z.string(),
  paradigm: z.string().default("unknown"),
  deviceType: z.string().default("unknown"),
  status: z.string(),
  numberQubits: z.number().nullable().default(0),
  pricing: z.object({
    perShot: z.number().optional(),
    perTask: z.number().optional(),
    perMinute: z.number().optional(),
  }).nullable().optional(),
  queueDepth: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  modality: z.string().nullable().optional(),
}).passthrough().transform((d) => ({
  id: d.qrn ?? d._id ?? "",
  name: d.name,
  vendor: d.vendor,
  provider: d.vendor,
  type: d.deviceType,
  status: d.status,
  qubits: d.numberQubits ?? 0,
  paradigm: d.paradigm,
  pricing: d.pricing ?? undefined,
  queueDepth: d.queueDepth ?? 0,
  description: d.description ?? undefined,
  modality: d.modality ?? undefined,
}))

const QuantumJobSchema = z.object({
  _id: z.string().optional(),
  jobQrn: z.string().optional(),
  status: z.string(),
  shots: z.number(),
  cost: z.number().optional(),
  createdAt: z.string().optional(),
  timeStamps: z.object({
    createdAt: z.string().optional(),
    endedAt: z.string().optional(),
  }).nullable().optional(),
  // In list response, device is a populated object; in single it may differ
  device: z.union([z.string(), z.object({ qrn: z.string().optional(), name: z.string().optional() }).passthrough()]).optional(),
  deviceQrn: z.string().optional(),
}).passthrough().transform((j) => {
  const device = typeof j.device === "string"
    ? j.device
    : j.device?.qrn ?? j.device?.name ?? j.deviceQrn ?? "unknown"
  return {
    id: j.jobQrn ?? j._id ?? "",
    device,
    status: j.status,
    shots: j.shots,
    createdAt: j.createdAt ?? j.timeStamps?.createdAt ?? "",
    endedAt: j.timeStamps?.endedAt,
    cost: j.cost,
  }
})

const JobResultSchema = z.object({
  jobId: z.string().optional(),
  jobQrn: z.string().optional(),
  status: z.string().optional(),
  measurements: z.record(z.string(), z.number()).optional(),
  success: z.boolean().optional(),
}).passthrough()

const CreditsBalanceSchema = z.object({
  qbraidCredits: z.number().default(0),
  awsCredits: z.number().default(0),
  autoRecharge: z.union([z.boolean(), z.string()]).optional(),
  organizationId: z.string().optional(),
  userId: z.string().optional(),
}).passthrough()

const ComputeStatusSchema = z.object({
  status: z.enum(["running", "stopped", "starting", "stopping", "error"]).catch("stopped"),
  profile: z.string().optional(),
  uptime: z.number().optional(),
}).passthrough()

export type QuantumDevice = z.infer<typeof QuantumDeviceSchema>
export type QuantumJob = z.infer<typeof QuantumJobSchema>
export type JobResult = z.infer<typeof JobResultSchema>
export type CreditsBalance = z.infer<typeof CreditsBalanceSchema>
export type ComputeStatus = z.infer<typeof ComputeStatusSchema>

export interface CostEstimate {
  deviceId: string
  shots: number
  estimatedCredits: number
  pricingAvailable: boolean
  breakdown: {
    perShot: number
    perTask: number
  }
}

// --- Auth resolution with short-lived cache ---

let cachedAuth: { apiKey: string; baseUrl: string; expiry: number } | null = null

/**
 * Resolve the qBraid API key and base URL.
 * Priority: env var > config provider > ~/.qbraid/qbraidrc
 * Cached for 5 seconds to avoid repeated disk reads within a single tool call.
 */
async function resolveAuth(): Promise<{ apiKey: string; baseUrl: string } | null> {
  if (cachedAuth && Date.now() < cachedAuth.expiry) {
    return { apiKey: cachedAuth.apiKey, baseUrl: cachedAuth.baseUrl }
  }

  let apiKey: string | undefined
  let baseUrl = DEFAULT_API_URL

  // 1. Environment variable
  if (process.env.QBRAID_API_KEY) {
    apiKey = process.env.QBRAID_API_KEY
  }

  // 2. Auth store — direct lookup by provider ID
  if (!apiKey) {
    try {
      const entry = await Auth.get("qbraid")
      if (entry) {
        if (entry.type === "api") apiKey = entry.key
        else if (entry.type === "wellknown") apiKey = entry.token
      }
    } catch {
      // auth not available
    }
  }

  // 3. ~/.qbraid/qbraidrc
  if (!apiKey) {
    try {
      const rcPath = path.join(os.homedir(), ".qbraid", "qbraidrc")
      const content = await fs.readFile(rcPath, "utf-8")
      for (const line of content.split("\n")) {
        const keyMatch = line.trim().match(/^api-key\s*=\s*(.+)/)
        if (keyMatch) {
          apiKey = keyMatch[1].trim()
          break
        }
        const urlMatch = line.trim().match(/^url\s*=\s*(.+)/)
        if (urlMatch) baseUrl = urlMatch[1].trim()
      }
    } catch {
      // qbraidrc not available
    }
  }

  if (process.env.QBRAID_API_BASE_URL) {
    baseUrl = process.env.QBRAID_API_BASE_URL
  }

  if (!apiKey) return null

  cachedAuth = { apiKey, baseUrl, expiry: Date.now() + 5_000 }
  return { apiKey, baseUrl }
}

// --- HTTP request helper ---

async function request<T>(method: string, endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const auth = await resolveAuth()
  if (!auth) throw new Error("No qBraid API key found. Run `codeq /connect` to set up qBraid.")

  const url = `${auth.baseUrl}${endpoint}`
  log.debug("quantum api request", { method, url })

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": auth.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY)
    throw new Error(`qBraid API ${method} ${endpoint} failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<T>
}

// --- API functions ---

/**
 * List available quantum devices with optional filters.
 */
export async function listDevices(
  filters?: { status?: string; provider?: string },
  signal?: AbortSignal,
): Promise<QuantumDevice[]> {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.provider) params.set("provider", filters.provider)

  const query = params.toString()
  const endpoint = `/devices${query ? `?${query}` : ""}`
  const data = await request<unknown>("GET", endpoint, undefined, signal)

  const arr = Array.isArray(data)
    ? data
    : (data as { data?: unknown[] }).data ?? []

  return arr.map((d: unknown) => QuantumDeviceSchema.parse(d))
}

/**
 * Get details for a specific device.
 */
export async function getDevice(deviceId: string, signal?: AbortSignal): Promise<QuantumDevice> {
  const data = await request<unknown>("GET", `/devices/${encodeURIComponent(deviceId)}`, undefined, signal)
  return QuantumDeviceSchema.parse(data)
}

/**
 * Estimate the cost of running a job on a device.
 * NOTE: This is a client-side estimate based on device pricing metadata.
 * If pricing is unavailable the estimate is 0 — check `pricingAvailable`.
 */
export async function estimateCost(deviceId: string, shots: number, signal?: AbortSignal): Promise<CostEstimate> {
  const device = await getDevice(deviceId, signal)
  const pricingAvailable = device.pricing != null
  const perShot = device.pricing?.perShot ?? 0
  const perTask = device.pricing?.perTask ?? 0
  const estimatedCredits = perShot * shots + perTask

  return {
    deviceId,
    shots,
    estimatedCredits,
    pricingAvailable,
    breakdown: { perShot: perShot * shots, perTask },
  }
}

/**
 * Submit a QASM circuit to a device.
 */
export async function submitJob(
  params: { deviceId: string; qasm: string; shots: number },
  signal?: AbortSignal,
): Promise<QuantumJob> {
  const data = await request<unknown>("POST", "/jobs", {
    device: params.deviceId,
    openQasm: params.qasm,
    shots: params.shots,
  }, signal)
  return QuantumJobSchema.parse(data)
}

/**
 * Get the status and metadata of a job.
 */
export async function getJob(jobId: string, signal?: AbortSignal): Promise<QuantumJob> {
  const data = await request<unknown>("GET", `/jobs/${encodeURIComponent(jobId)}`, undefined, signal)
  return QuantumJobSchema.parse(data)
}

/**
 * Get the results of a completed job.
 */
export async function getResult(jobId: string, signal?: AbortSignal): Promise<JobResult> {
  const data = await request<unknown>("GET", `/jobs/${encodeURIComponent(jobId)}/result`, undefined, signal)
  return JobResultSchema.parse(data)
}

/**
 * Cancel a running or queued job.
 */
export async function cancelJob(jobId: string, signal?: AbortSignal): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, signal)
}

/**
 * List recent jobs with optional filters.
 */
export async function listJobs(
  filters?: { status?: string; limit?: number },
  signal?: AbortSignal,
): Promise<QuantumJob[]> {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.limit) params.set("limit", String(filters.limit))

  const query = params.toString()
  const endpoint = `/jobs${query ? `?${query}` : ""}`
  const data = await request<unknown>("GET", endpoint, undefined, signal)

  const arr = Array.isArray(data)
    ? data
    : (data as { data?: unknown[] }).data ?? []

  return arr.map((j: unknown) => QuantumJobSchema.parse(j))
}

/**
 * Get account credit balance.
 * Uses /billing/credits/balance which returns qbraidCredits + awsCredits.
 */
export async function getCredits(signal?: AbortSignal): Promise<CreditsBalance> {
  const data = await request<unknown>("GET", "/billing/credits/balance", undefined, signal)
  if (typeof data === "object" && data !== null && "data" in data) {
    return CreditsBalanceSchema.parse((data as Record<string, unknown>).data)
  }
  return CreditsBalanceSchema.parse(data)
}

/**
 * Get compute server status.
 * Returns the current state of the user's JupyterHub compute server.
 */
export async function getComputeStatus(signal?: AbortSignal): Promise<ComputeStatus> {
  try {
    const data = await request<unknown>("GET", "/compute/servers/status", undefined, signal)
    if (typeof data === "object" && data !== null && "data" in data) {
      return ComputeStatusSchema.parse((data as Record<string, unknown>).data)
    }
    return ComputeStatusSchema.parse(data)
  } catch {
    return { status: "stopped" }
  }
}

/**
 * List active/recent jobs (limited to 10 most recent).
 * Convenience wrapper for sidebar polling.
 */
export async function listActiveJobs(signal?: AbortSignal): Promise<QuantumJob[]> {
  const params = new URLSearchParams()
  params.set("limit", "10")
  const endpoint = `/jobs?${params.toString()}`
  const data = await request<unknown>("GET", endpoint, undefined, signal)
  const arr = Array.isArray(data)
    ? data
    : (data as { data?: unknown[] }).data ?? []
  return arr.map((j: unknown) => QuantumJobSchema.parse(j))
}

// --- Environment types & functions ---

const EnvironmentSchema = z.object({
  _id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  packagesInImage: z.array(z.string()).default([]),
  platform: z.array(z.string()).default([]),
  pythonVersion: z.string().nullable().optional(),
  status: z.string().default("unknown"),
  visibility: z.string().default("private"),
}).passthrough().transform((e) => ({
  slug: e.slug,
  name: e.name,
  description: e.description,
  tags: e.tags,
  packages: e.packagesInImage,
  platform: e.platform,
  python: e.pythonVersion ?? undefined,
  status: e.status,
  visibility: e.visibility,
}))

export type Environment = z.infer<typeof EnvironmentSchema>

const ComputeProfileSchema = z.object({
  slug: z.string(),
  display_name: z.string().default(""),
  description: z.string().default(""),
  plan: z.union([z.string(), z.array(z.string())]).default("Free"),
  rateDollar: z.number().default(0),
  rateTimeFrame: z.string().default("min"),
  gpu: z.boolean().default(false),
  ide: z.string().default("jupyterlab"),
  hasCapacity: z.boolean().default(false),
  creditCost: z.number().optional(),
  kubespawner_override: z.object({
    cpu_guarantee: z.number().optional(),
    cpu_limit: z.number().optional(),
    mem_limit: z.string().optional(),
    mem_guarantee: z.string().optional(),
  }).optional(),
}).passthrough().transform((p) => ({
  slug: p.slug,
  name: p.display_name,
  description: p.description,
  plan: Array.isArray(p.plan) ? p.plan.join(", ") : p.plan,
  rate: `${p.rateDollar}/${p.rateTimeFrame}`,
  creditCost: p.creditCost,
  gpu: p.gpu,
  ide: p.ide,
  available: p.hasCapacity,
  cpu: p.kubespawner_override?.cpu_limit,
  memory: p.kubespawner_override?.mem_limit,
}))

export type ComputeProfile = z.infer<typeof ComputeProfileSchema>

const ServerStatusSchema = z.object({
  serverRunning: z.boolean().default(false),
  serverStarting: z.boolean().optional(),
  clusterId: z.string().optional(),
  currentProfile: z.string().nullable().optional(),
}).passthrough().transform((s) => ({
  running: s.serverRunning,
  starting: s.serverStarting ?? false,
  clusterId: s.clusterId,
  profile: s.currentProfile ?? undefined,
}))

export type ServerStatus = z.infer<typeof ServerStatusSchema>

const UserContextSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    userName: z.string().default(""),
    personalInformation: z.object({
      firstName: z.string().default(""),
      lastName: z.string().default(""),
    }).optional(),
  }),
  organizations: z.record(z.string(), z.object({
    name: z.string(),
    subscriptionTier: z.string().default("Free"),
    roles: z.array(z.string()).default([]),
    wallet: z.object({
      qbraidCredits: z.number().default(0),
      awsCredits: z.number().default(0),
    }).optional(),
    diskUsage: z.object({
      totalGB: z.number().default(0),
      quotaGB: z.number().default(0),
    }).optional(),
  }).passthrough()).default({}),
}).passthrough()

export type UserContext = z.infer<typeof UserContextSchema>

/**
 * List software environments available to the user.
 */
export async function listEnvironments(
  filters?: { limit?: number; page?: number },
  signal?: AbortSignal,
): Promise<{ environments: Environment[]; total: number }> {
  const params = new URLSearchParams()
  if (filters?.limit) params.set("limit", String(filters.limit))
  if (filters?.page) params.set("page", String(filters.page))
  const query = params.toString()
  const data = await request<unknown>("GET", `/environments${query ? `?${query}` : ""}`, undefined, signal)
  const wrapper = data as { data?: unknown[]; pagination?: { total?: number } }
  const arr = wrapper.data ?? []
  return {
    environments: arr.map((e: unknown) => EnvironmentSchema.parse(e)),
    total: wrapper.pagination?.total ?? arr.length,
  }
}

/**
 * Get details for a specific environment by slug.
 */
export async function getEnvironment(slug: string, signal?: AbortSignal): Promise<Environment> {
  const data = await request<unknown>("GET", `/environments/${encodeURIComponent(slug)}`, undefined, signal)
  const inner = (data as { data?: unknown }).data ?? data
  return EnvironmentSchema.parse(inner)
}

/**
 * List available compute profiles (server configurations).
 */
export async function listComputeProfiles(
  filters?: { gpu?: boolean },
  signal?: AbortSignal,
): Promise<ComputeProfile[]> {
  const params = new URLSearchParams()
  if (filters?.gpu !== undefined) params.set("gpu", String(filters.gpu))
  params.set("limit", "50")
  const query = params.toString()
  const data = await request<unknown>("GET", `/compute/profiles?${query}`, undefined, signal)
  const arr = (data as { data?: unknown[] }).data ?? []
  return arr.map((p: unknown) => ComputeProfileSchema.parse(p))
}

/**
 * Get detailed compute server status.
 * More detailed than getComputeStatus — returns full server info.
 */
export async function getServerStatus(signal?: AbortSignal): Promise<ServerStatus> {
  try {
    const data = await request<unknown>("GET", "/compute/servers/status", undefined, signal)
    const inner = (data as { data?: unknown }).data ?? data
    return ServerStatusSchema.parse(inner)
  } catch {
    return { running: false, starting: false, clusterId: undefined, profile: undefined }
  }
}

/**
 * Start a compute server with a specific profile.
 */
export async function startServer(
  profileSlug: string,
  signal?: AbortSignal,
): Promise<{ message: string; status: string }> {
  const data = await request<unknown>("POST", "/compute/servers/start", { profileSlug }, signal)
  const inner = (data as { data?: { message?: string; status?: string } }).data ?? {}
  return { message: inner.message ?? "Starting", status: inner.status ?? "starting" }
}

/**
 * Stop the running compute server.
 */
export async function stopServer(signal?: AbortSignal): Promise<{ message: string; status: string }> {
  const data = await request<unknown>("DELETE", "/compute/servers/stop", undefined, signal)
  const inner = (data as { data?: { message?: string; status?: string } }).data ?? {}
  return { message: inner.message ?? "Stopping", status: inner.status ?? "stopping" }
}

/**
 * Get the user's account context (identity, orgs, roles, quotas).
 */
export async function getUserContext(signal?: AbortSignal): Promise<UserContext> {
  const data = await request<unknown>("GET", "/users/context", undefined, signal)
  const inner = (data as { data?: unknown }).data ?? data
  return UserContextSchema.parse(inner)
}

/**
 * Get the ASCII circuit diagram for a submitted job.
 */
export async function getJobCircuit(jobId: string, signal?: AbortSignal): Promise<string> {
  const data = await request<unknown>(
    "GET",
    `/jobs/${encodeURIComponent(jobId)}/program/ascii`,
    undefined,
    signal,
  )
  const inner = (data as { data?: unknown }).data ?? data
  if (typeof inner === "string") return inner
  return String(inner)
}

/**
 * Get AI chat usage and quota info.
 */
export async function getAIChatUsage(signal?: AbortSignal): Promise<{
  used: number
  quota: number
  remaining: number
  percentUsed: number
  renewalDate: string
  usingCredits: boolean
  canSend: boolean
}> {
  const data = await request<unknown>("GET", "/billing/ai-chat/usage", undefined, signal)
  const inner = (data as { data?: Record<string, unknown> }).data ?? (data as Record<string, unknown>)
  return {
    used: Number(inner.used ?? 0),
    quota: Number(inner.quota ?? 0),
    remaining: Number(inner.remaining ?? 0),
    percentUsed: Number(inner.percentageUsed ?? 0),
    renewalDate: String(inner.renewalDate ?? ""),
    usingCredits: Boolean(inner.usingCredits),
    canSend: Boolean(inner.canSendMessages),
  }
}

/**
 * Check if qBraid API access is configured.
 */
export async function isConfigured(): Promise<boolean> {
  const auth = await resolveAuth()
  return auth !== null
}
