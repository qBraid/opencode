/**
 * Quantum Status Components
 *
 * Two components for displaying qBraid quantum resource status:
 * - QuantumSidebarSection: collapsible section for the sidebar panel
 * - QuantumFooterIndicator: compact single indicator for the footer bar
 *
 * Both subscribe to QuantumState bus events for live updates.
 * Design: minimal when idle, progressive disclosure when resources are active.
 */

import { createSignal, Show, For } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import * as QuantumState from "@/quantum/state"
import type { State, JobSummary, ComputeInstance } from "@/quantum/state"

function initial(): State {
  return { configured: false, credits: null, jobs: null, instances: [], updatedAt: 0, error: null }
}

function useQuantumState() {
  // TUI runs in the main thread, server in a worker thread.
  // Module-level state isn't shared across threads, so we read
  // the full state from the event payload delivered via SSE.
  //
  // Events often arrive before this component mounts. Read the
  // cached latest event to pick up state that was published early.
  const sdk = useSDK()
  const cached = sdk.latest.get(QuantumState.Event.Updated.type) as any
  const init = cached?.properties?.state as State | undefined

  const [state, setState] = createSignal<State>(init ?? initial())

  sdk.event.on(QuantumState.Event.Updated.type as any, (event: any) => {
    const s = event.properties?.state as State | undefined
    if (!s) return
    // Merge: keep existing non-null fields when incoming has null.
    // Multiple refresh* calls publish independently; an early publish
    // may have credits=null while a later one has the real value.
    // Using updatedAt ensures we never regress to stale data.
    setState((prev) => {
      if (s.updatedAt >= prev.updatedAt) return s
      return prev
    })
  })

  return state
}

function formatCredits(n: number): string {
  if (n >= 1000) return `${Math.round(n)} cr`
  if (n >= 100) return `${Math.round(n)} cr`
  if (n >= 1) return `${n.toFixed(1)} cr`
  return `${n.toFixed(2)} cr`
}

function formatElapsed(createdAt: number): string {
  const ms = Date.now() - createdAt
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

function shortDevice(device: string): string {
  // "aws_ionq_aria" → "IonQ Aria", "ibm_brisbane" → "IBM Brisbane"
  const parts = device.replace(/^(aws_|ibm_|google_)/, "").split("_")
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ").slice(0, 16)
}

// --- Sidebar Section ---

export function QuantumSidebarSection(props: { expanded: boolean; onToggle: () => void }) {
  const { theme } = useTheme()
  const state = useQuantumState()

  const hasActivity = () => {
    const s = state()
    if (!s.configured) return false
    const activeJobs = s.jobs?.active.length ?? 0
    const liveInstances = s.instances.filter((i) => i.status === "running" || i.status === "starting").length
    return activeJobs > 0 || liveInstances > 0
  }

  const creditsText = () => {
    const c = state().credits
    if (!c) return ""
    return formatCredits(c.qbraid)
  }

  const lowCredits = () => {
    const c = state().credits
    return c != null && c.qbraid < 10
  }

  return (
    <Show when={state().configured}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
          <text fg={theme.text}>{props.expanded ? "▼" : "▶"}</text>
          <box flexDirection="row" flexGrow={1} justifyContent="space-between">
            <text fg={theme.text}>
              <b>qBraid</b>
              <Show when={hasActivity()}>
                <span style={{ fg: theme.success }}> ●</span>
              </Show>
            </text>
            <Show when={state().credits}>
              <text fg={lowCredits() ? theme.warning : theme.textMuted}>{creditsText()}</text>
            </Show>
          </box>
        </box>

        <Show when={props.expanded}>
          <InstancesSection instances={state().instances} />
          <JobsSection jobs={state().jobs} />
        </Show>
      </box>
    </Show>
  )
}

function JobsSection(props: {
  jobs: State["jobs"]
}) {
  const { theme } = useTheme()

  return (
    <Show
      when={props.jobs}
      fallback={<text fg={theme.textMuted}>  Loading jobs...</text>}
    >
      {(jobs) => (
        <>
          <Show
            when={jobs().active.length > 0}
            fallback={
              <text fg={theme.textMuted}>
                {"  "}No active jobs
                <Show when={jobs().recentDone > 0}>
                  <span style={{ fg: theme.textMuted }}> · {jobs().recentDone} done today</span>
                </Show>
              </text>
            }
          >
            <For each={jobs().active.slice(0, 4)}>
              {(job) => <JobRow job={job} />}
            </For>
            <Show when={jobs().active.length > 4}>
              <text fg={theme.textMuted}>{"  "}+{jobs().active.length - 4} more</text>
            </Show>
          </Show>
          <Show when={jobs().recentFailed > 0}>
            <text fg={theme.error}>{"  "}{jobs().recentFailed} failed</text>
          </Show>
        </>
      )}
    </Show>
  )
}

function JobRow(props: { job: JobSummary }) {
  const { theme } = useTheme()
  const dot = () => {
    const s = props.job.status
    if (s === "RUNNING") return theme.success
    if (s === "QUEUED" || s === "INITIALIZING") return theme.warning
    if (s === "FAILED" || s === "CANCELLED") return theme.error
    return theme.textMuted
  }
  const label = () => {
    if (props.job.status === "RUNNING") return formatElapsed(props.job.createdAt)
    return props.job.status.toLowerCase()
  }

  return (
    <box flexDirection="row" gap={1} justifyContent="space-between">
      <text fg={theme.text}>
        {"  "}<span style={{ fg: dot() }}>●</span> {shortDevice(props.job.device)}
      </text>
      <text fg={theme.textMuted}>{label()}</text>
    </box>
  )
}

function InstancesSection(props: { instances: ComputeInstance[] }) {
  const { theme } = useTheme()

  const live = () => props.instances.filter((i) => i.status !== "stopped")

  return (
    <Show
      when={live().length > 0}
      fallback={<text fg={theme.textMuted}>{"  "}No compute instances</text>}
    >
      <For each={live()}>
        {(inst) => <InstanceRow instance={inst} />}
      </For>
    </Show>
  )
}

function formatUptime(startedAt?: number): string {
  if (!startedAt) return ""
  const ms = Date.now() - startedAt
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function InstanceRow(props: { instance: ComputeInstance }) {
  const { theme } = useTheme()
  const inst = () => props.instance

  const dot = () => {
    const s = inst().status
    if (s === "running") return theme.success
    if (s === "starting") return theme.warning
    if (s === "stopping") return theme.textMuted
    if (s === "error") return theme.error
    return theme.textMuted
  }

  const label = () => {
    const i = inst()
    const name = i.profile || i.name || "instance"
    if (i.status === "starting") return `${name} starting...`
    if (i.status === "stopping") return `${name} stopping...`
    return name
  }

  const detail = () => {
    const i = inst()
    const parts: string[] = []
    if (i.status === "running") {
      const up = formatUptime(i.startedAt)
      if (up) parts.push(up)
      if (i.rate) parts.push(`${i.rate.toFixed(2)} cr/min`)
      if (i.kernels > 0) parts.push(`${i.kernels} kernel${i.kernels > 1 ? "s" : ""}`)
    }
    return parts.join(" · ")
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} justifyContent="space-between">
        <text fg={theme.text}>
          {"  "}<span style={{ fg: dot() }}>●</span> {label()}
        </text>
        <Show when={detail()}>
          <text fg={theme.textMuted}>{detail()}</text>
        </Show>
      </box>
      <Show when={inst().executing}>
        <text fg={theme.textMuted}>{"    "}⟳ {inst().executing}</text>
      </Show>
    </box>
  )
}

// --- Footer Indicator ---

export function QuantumFooterIndicator() {
  const { theme } = useTheme()
  const state = useQuantumState()

  const visible = () => state().configured
  const activeJobs = () => state().jobs?.active.length ?? 0
  const liveInstances = () => state().instances.filter((i) => i.status === "running" || i.status === "starting").length

  const indicator = () => {
    const jobs = activeJobs()
    const inst = liveInstances()
    if (jobs > 0 && inst > 0) return { fg: theme.success, text: `${jobs} QPU · ${inst} compute` }
    if (jobs > 0) return { fg: theme.success, text: `${jobs} QPU` }
    if (inst > 0) return { fg: theme.success, text: `${inst} compute` }
    return { fg: theme.textMuted, text: "qBraid" }
  }

  return (
    <Show when={visible()}>
      <text fg={theme.text}>
        <span style={{ fg: indicator().fg }}>⚛</span>{" "}
        {indicator().text}
      </text>
    </Show>
  )
}
