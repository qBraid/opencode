/**
 * qBraid Quantum API Client
 *
 * TypeScript HTTP client for the qBraid quantum runtime API.
 * Replaces the Python SDK dependency for device listing, job submission,
 * and result retrieval — keeping everything in-process.
 */

import { Log } from "../util/log"
import { Auth } from "../auth"
import path from "path"
import os from "os"
import fs from "fs/promises"

const log = Log.create({ service: "quantum:client" })

const DEFAULT_API_URL = "https://api-v2.qbraid.com/api/v1"

export interface QuantumDevice {
  id: string
  name: string
  vendor: string
  provider: string
  type: string
  status: string
  qubits: number
  paradigm: string
  pricing?: {
    perShot?: number
    perTask?: number
    perMinute?: number
  }
}

export interface QuantumJob {
  id: string
  device: string
  status: string
  shots: number
  createdAt: string
  endedAt?: string
  cost?: number
}

export interface JobResult {
  jobId: string
  status: string
  measurements?: Record<string, number>
  success: boolean
}

export interface CostEstimate {
  deviceId: string
  shots: number
  estimatedCredits: number
  breakdown: {
    perShot: number
    perTask: number
  }
}

/**
 * Resolve the qBraid API key and base URL.
 * Priority: env var > config provider > ~/.qbraid/qbraidrc
 */
async function resolveAuth(): Promise<{ apiKey: string; baseUrl: string } | null> {
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
        if (keyMatch) apiKey = keyMatch[1].trim()
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
  return { apiKey, baseUrl }
}

async function request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
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
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`qBraid API ${method} ${endpoint} failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<T>
}

/**
 * List available quantum devices with optional filters.
 */
export async function listDevices(filters?: {
  status?: string
  provider?: string
}): Promise<QuantumDevice[]> {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.provider) params.set("provider", filters.provider)

  const query = params.toString()
  const endpoint = `/quantum/devices${query ? `?${query}` : ""}`
  const data = await request<QuantumDevice[] | { devices: QuantumDevice[] }>("GET", endpoint)
  return Array.isArray(data) ? data : data.devices ?? []
}

/**
 * Get details for a specific device.
 */
export async function getDevice(deviceId: string): Promise<QuantumDevice> {
  return request<QuantumDevice>("GET", `/quantum/devices/${encodeURIComponent(deviceId)}`)
}

/**
 * Estimate the cost of running a job on a device.
 */
export async function estimateCost(deviceId: string, shots: number): Promise<CostEstimate> {
  const device = await getDevice(deviceId)
  const perShot = device.pricing?.perShot ?? 0
  const perTask = device.pricing?.perTask ?? 0
  const estimatedCredits = perShot * shots + perTask

  return {
    deviceId,
    shots,
    estimatedCredits,
    breakdown: { perShot: perShot * shots, perTask },
  }
}

/**
 * Submit a QASM circuit to a device.
 */
export async function submitJob(params: {
  deviceId: string
  qasm: string
  shots: number
}): Promise<QuantumJob> {
  return request<QuantumJob>("POST", "/quantum/jobs", {
    device: params.deviceId,
    openQasm: params.qasm,
    shots: params.shots,
  })
}

/**
 * Get the status and metadata of a job.
 */
export async function getJob(jobId: string): Promise<QuantumJob> {
  return request<QuantumJob>("GET", `/quantum/jobs/${encodeURIComponent(jobId)}`)
}

/**
 * Get the results of a completed job.
 */
export async function getResult(jobId: string): Promise<JobResult> {
  return request<JobResult>("GET", `/quantum/jobs/${encodeURIComponent(jobId)}/result`)
}

/**
 * Cancel a running or queued job.
 */
export async function cancelJob(jobId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("POST", `/quantum/jobs/${encodeURIComponent(jobId)}/cancel`)
}

/**
 * List recent jobs with optional filters.
 */
export async function listJobs(filters?: {
  status?: string
  limit?: number
}): Promise<QuantumJob[]> {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.limit) params.set("limit", String(filters.limit))

  const query = params.toString()
  const endpoint = `/quantum/jobs${query ? `?${query}` : ""}`
  const data = await request<QuantumJob[] | { jobs: QuantumJob[] }>("GET", endpoint)
  return Array.isArray(data) ? data : data.jobs ?? []
}

/**
 * Get account credit balance.
 */
export async function getCredits(): Promise<{ balance: number }> {
  return request<{ balance: number }>("GET", "/user/credits")
}

/**
 * Check if qBraid API access is configured.
 */
export async function isConfigured(): Promise<boolean> {
  const auth = await resolveAuth()
  return auth !== null
}
