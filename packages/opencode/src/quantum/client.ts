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

const QuantumDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string(),
  provider: z.string(),
  type: z.string().default("unknown"),
  status: z.string(),
  qubits: z.number().default(0),
  paradigm: z.string().default("unknown"),
  pricing: z.object({
    perShot: z.number().optional(),
    perTask: z.number().optional(),
    perMinute: z.number().optional(),
  }).optional(),
})

const QuantumJobSchema = z.object({
  id: z.string(),
  device: z.string(),
  status: z.string(),
  shots: z.number(),
  createdAt: z.string(),
  endedAt: z.string().optional(),
  cost: z.number().optional(),
})

const JobResultSchema = z.object({
  jobId: z.string().optional(),
  status: z.string().optional(),
  measurements: z.record(z.string(), z.number()).optional(),
  success: z.boolean().optional(),
})

export type QuantumDevice = z.infer<typeof QuantumDeviceSchema>
export type QuantumJob = z.infer<typeof QuantumJobSchema>
export type JobResult = z.infer<typeof JobResultSchema>

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

  // 2. CodeQ auth store
  if (!apiKey) {
    try {
      const authData = await Auth.all()
      for (const [key, value] of Object.entries(authData)) {
        if (key.includes("qbraid")) {
          if (value.type === "wellknown" && value.token) {
            apiKey = value.token
            break
          }
          if (value.type === "api" && value.key) {
            apiKey = value.key
            break
          }
        }
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

async function request<T>(
  method: string,
  endpoint: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const auth = await resolveAuth()
  if (!auth) throw new Error("No qBraid API key found. Run `codeq /connect` to set up qBraid.")

  const url = `${auth.baseUrl}${endpoint}`
  log.debug("quantum api request", { method, url })

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "api-key": auth.apiKey,
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
  const endpoint = `/quantum/devices${query ? `?${query}` : ""}`
  const data = await request<unknown>("GET", endpoint, undefined, signal)

  const arr = Array.isArray(data)
    ? data
    : (data as { devices?: unknown[] }).devices ?? []

  return arr.map((d: unknown) => QuantumDeviceSchema.parse(d))
}

/**
 * Get details for a specific device.
 */
export async function getDevice(deviceId: string, signal?: AbortSignal): Promise<QuantumDevice> {
  const data = await request<unknown>("GET", `/quantum/devices/${encodeURIComponent(deviceId)}`, undefined, signal)
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
  const data = await request<unknown>("POST", "/quantum/jobs", {
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
  const data = await request<unknown>("GET", `/quantum/jobs/${encodeURIComponent(jobId)}`, undefined, signal)
  return QuantumJobSchema.parse(data)
}

/**
 * Get the results of a completed job.
 */
export async function getResult(jobId: string, signal?: AbortSignal): Promise<JobResult> {
  const data = await request<unknown>("GET", `/quantum/jobs/${encodeURIComponent(jobId)}/result`, undefined, signal)
  return JobResultSchema.parse(data)
}

/**
 * Cancel a running or queued job.
 */
export async function cancelJob(jobId: string, signal?: AbortSignal): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("POST", `/quantum/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, signal)
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
  const endpoint = `/quantum/jobs${query ? `?${query}` : ""}`
  const data = await request<unknown>("GET", endpoint, undefined, signal)

  const arr = Array.isArray(data)
    ? data
    : (data as { jobs?: unknown[] }).jobs ?? []

  return arr.map((j: unknown) => QuantumJobSchema.parse(j))
}

// --- Zod schemas for credits / compute ---

const CreditsBalanceSchema = z.object({
  qbraidCredits: z.number().default(0),
  awsCredits: z.number().default(0),
  autoRecharge: z.boolean().optional(),
  organizationId: z.string().optional(),
  userId: z.string().optional(),
})

const ComputeStatusSchema = z.object({
  status: z.enum(["running", "stopped", "starting", "stopping", "error"]).catch("stopped"),
  profile: z.string().optional(),
  uptime: z.number().optional(),
})

export type CreditsBalance = z.infer<typeof CreditsBalanceSchema>
export type ComputeStatus = z.infer<typeof ComputeStatusSchema>

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
  const endpoint = `/quantum/jobs?${params.toString()}`
  const data = await request<unknown>("GET", endpoint, undefined, signal)
  const arr = Array.isArray(data)
    ? data
    : (data as { jobs?: unknown[] }).jobs ?? []
  return arr.map((j: unknown) => QuantumJobSchema.parse(j))
}

/**
 * Check if qBraid API access is configured.
 */
export async function isConfigured(): Promise<boolean> {
  const auth = await resolveAuth()
  return auth !== null
}
