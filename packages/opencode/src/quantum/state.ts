/**
 * Quantum State Store
 *
 * Centralized reactive state for qBraid quantum resources.
 * Tracks credits, active jobs, and compute instance status.
 * Updated by the background poller and quantum tool executions.
 *
 * Uses Instance.state() for per-instance isolation and automatic
 * disposal when the project instance is torn down.
 */

import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util/log"
import z from "zod"
import * as Client from "./client"

const log = Log.create({ service: "quantum:state" })

// --- Types ---

export interface JobSummary {
  id: string
  device: string
  status: string
  createdAt: number
  shots: number
  cost?: number
}

export type InstanceStatus = "running" | "stopped" | "starting" | "stopping" | "error"

export interface ComputeInstance {
  /** Server name — empty string for JupyterHub default server */
  name: string
  /** Compute profile slug (e.g. "cuda-quantum-try") */
  profile: string
  status: InstanceStatus
  /** Cluster hosting this instance */
  clusterId?: string
  /** Epoch ms when the server started */
  startedAt?: number
  /** Credit cost per minute while running */
  rate?: number
  /** Number of active Jupyter kernels on this instance */
  kernels: number
  /** Currently executing code (shows in sidebar) */
  executing?: string
}

export interface State {
  configured: boolean
  credits: {
    qbraid: number
    aws: number
  } | null
  jobs: {
    active: JobSummary[]
    recentDone: number
    recentFailed: number
  } | null
  /** Active compute instances — array for multi-instance support */
  instances: ComputeInstance[]
  updatedAt: number
  error: string | null
}

const ACTIVE_STATUSES = new Set(["INITIALIZING", "QUEUED", "RUNNING", "VALIDATING"])

// --- Per-instance state via Instance.state() ---

function initial(): State {
  return {
    configured: false,
    credits: null,
    jobs: null,
    instances: [],
    updatedAt: 0,
    error: null,
  }
}

// Module-level singleton — safe to call from any context (server or TUI SolidJS).
// Instance.state() is intentionally avoided because AsyncLocalStorage is not
// available inside SolidJS reactive computations.
let _state: State = initial()
const state = () => _state

// --- Bus event for TUI reactivity ---
// The event payload carries the full state snapshot because the TUI
// runs in the main thread while the server runs in a worker thread.
// Module-level variables are not shared across threads.

export const Event = {
  Updated: BusEvent.define(
    "quantum.state.updated",
    z.object({ state: z.any() }),
  ),
}

function publish() {
  state().updatedAt = Date.now()
  const snap: State = JSON.parse(JSON.stringify(state()))
  Bus.publish(Event.Updated, { state: snap })
}

// --- Public API ---

export function get(): Readonly<State> {
  return state()
}

export async function refreshCredits(signal?: AbortSignal) {
  try {
    const balance = await Client.getCredits(signal)
    const s = state()
    s.credits = {
      qbraid: balance.qbraidCredits,
      aws: balance.awsCredits,
    }
    s.error = null
    publish()
  } catch (e) {
    log.warn("credits refresh failed", { error: String(e) })
    state().error = "credits unavailable"
    publish()
  }
}

export async function refreshJobs(signal?: AbortSignal) {
  try {
    const jobs = await Client.listActiveJobs(signal)
    const active: JobSummary[] = []
    let done = 0
    let failed = 0
    const dayAgo = Date.now() - 86_400_000

    for (const j of jobs) {
      const normalized = j.status.toUpperCase()
      if (ACTIVE_STATUSES.has(normalized)) {
        active.push({
          id: j.id,
          device: j.device,
          status: normalized,
          createdAt: new Date(j.createdAt).getTime(),
          shots: j.shots,
          cost: j.cost,
        })
      } else if (new Date(j.createdAt).getTime() > dayAgo) {
        if (normalized === "COMPLETED") done++
        if (normalized === "FAILED" || normalized === "CANCELLED") failed++
      }
    }

    const s = state()
    s.jobs = { active, recentDone: done, recentFailed: failed }
    s.error = null
    publish()
  } catch (e) {
    log.warn("jobs refresh failed", { error: String(e) })
    state().error = "jobs unavailable"
    publish()
  }
}

export async function refreshCompute(signal?: AbortSignal) {
  try {
    // Try multi-instance listServers endpoint first.
    // Falls back to legacy getServerStatus for older API versions.
    let updated = false
    try {
      const result = await Client.listServers(signal)
      const s = state()
      const live = result.servers.filter((srv) => srv.status !== "stopped")
      // Merge: preserve local-only fields (kernels, executing, rate)
      const merged: ComputeInstance[] = live.map((srv) => {
        const prev = s.instances.find((i) => i.name === srv.name)
        return {
          name: srv.name,
          profile: srv.profile ?? "unknown",
          status: srv.status as InstanceStatus,
          clusterId: result.clusterId,
          startedAt: srv.startedAt ? new Date(srv.startedAt).getTime() : prev?.startedAt,
          rate: prev?.rate,
          kernels: prev?.kernels ?? 0,
          executing: prev?.executing,
        }
      })
      s.instances = merged
      s.error = null
      updated = true
      publish()
    } catch {
      // listServers not available — fall back to legacy status
    }

    if (!updated) {
      const status = await Client.getServerStatus(signal)
      const s = state()
      const st: InstanceStatus = status.running ? "running" : status.starting ? "starting" : "stopped"
      if (st === "stopped") {
        s.instances = []
      } else {
        const existing = s.instances.find((i) => i.name === "")
        if (existing) {
          existing.status = st
          existing.profile = status.profile ?? existing.profile
          existing.clusterId = status.clusterId ?? existing.clusterId
        } else {
          s.instances = [{
            name: "",
            profile: status.profile ?? "unknown",
            status: st,
            clusterId: status.clusterId,
            kernels: 0,
          }]
        }
      }
      s.error = null
      publish()
    }
  } catch (e) {
    log.warn("compute refresh failed", { error: String(e) })
    state().error = "compute unavailable"
    publish()
  }
}

/**
 * Mark an instance as executing code (shows in sidebar).
 * Call with `undefined` label to clear.
 */
export function setExecuting(name: string, label?: string) {
  const inst = state().instances.find((i) => i.name === name)
  if (!inst) return
  inst.executing = label
  publish()
}

/**
 * Update kernel count for an instance after starting/stopping kernels.
 */
export function setKernels(name: string, count: number) {
  const inst = state().instances.find((i) => i.name === name)
  if (!inst) return
  inst.kernels = count
  publish()
}

/**
 * Record that an instance was started with a specific profile.
 * Called from the compute_start tool before the API confirms.
 */
export function instanceStarting(name: string, profile: string, rate?: number) {
  const s = state()
  const existing = s.instances.find((i) => i.name === name)
  if (existing) {
    existing.status = "starting"
    existing.profile = profile
    existing.rate = rate
  } else {
    s.instances.push({
      name,
      profile,
      status: "starting",
      kernels: 0,
      rate,
      startedAt: Date.now(),
    })
  }
  publish()
}

export async function refreshAll(signal?: AbortSignal) {
  const configured = await Client.isConfigured()
  state().configured = configured
  if (!configured) {
    publish()
    return
  }
  await Promise.allSettled([refreshCredits(signal), refreshJobs(signal), refreshCompute(signal)])
}
