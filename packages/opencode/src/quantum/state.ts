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
  compute: {
    status: "running" | "stopped" | "starting" | "stopping" | "error"
    profile?: string
    uptime?: number
  } | null
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
    compute: null,
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
    const status = await Client.getComputeStatus(signal)
    const s = state()
    s.compute = {
      status: status.status,
      profile: status.profile,
      uptime: status.uptime,
    }
    s.error = null
    publish()
  } catch (e) {
    log.warn("compute refresh failed", { error: String(e) })
    state().error = "compute unavailable"
    publish()
  }
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
