/**
 * Quantum State Poller
 *
 * Registers a Scheduler task that refreshes quantum state on an interval.
 * Uses adaptive polling rates: credits/compute every 60s, jobs every 30s
 * when active. Skipped entirely if no qBraid API key is configured.
 *
 * Timestamps are stored in Instance.state() for per-instance isolation.
 */

import { Scheduler } from "../scheduler"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import * as QuantumState from "./state"

const log = Log.create({ service: "quantum:poller" })

const CREDITS_INTERVAL = 60_000
const JOBS_INTERVAL = 30_000
const COMPUTE_INTERVAL = 60_000

const state = Instance.state(() => ({
  lastCredits: 0,
  lastJobs: 0,
  lastCompute: 0,
}))

export function init() {
  Scheduler.register({
    id: "quantum.poll",
    interval: 15_000,
    run: tick,
    scope: "instance",
  })
}

async function tick() {
  const quantum = QuantumState.get()
  if (!quantum.configured) {
    // Re-check config every tick in case user connects mid-session
    const { isConfigured } = await import("./client")
    const configured = await isConfigured()
    if (!configured) return
    // First time configured — do a full refresh
    log.info("qBraid API key detected, starting quantum polling")
    await QuantumState.refreshAll()
    const s = state()
    s.lastCredits = s.lastJobs = s.lastCompute = Date.now()
    return
  }

  const now = Date.now()
  const s = state()
  const hasActive = (quantum.jobs?.active.length ?? 0) > 0
  const computeRunning = quantum.compute?.status === "running" || quantum.compute?.status === "starting"

  // Credits: always refresh on interval
  if (now - s.lastCredits >= CREDITS_INTERVAL) {
    await QuantumState.refreshCredits()
    s.lastCredits = now
  }

  // Jobs: refresh faster when there are active jobs
  const jobInterval = hasActive ? JOBS_INTERVAL : CREDITS_INTERVAL
  if (now - s.lastJobs >= jobInterval) {
    await QuantumState.refreshJobs()
    s.lastJobs = now
  }

  // Compute: refresh faster when instance is running
  const computeInterval = computeRunning ? JOBS_INTERVAL : COMPUTE_INTERVAL
  if (now - s.lastCompute >= computeInterval) {
    await QuantumState.refreshCompute()
    s.lastCompute = now
  }
}
