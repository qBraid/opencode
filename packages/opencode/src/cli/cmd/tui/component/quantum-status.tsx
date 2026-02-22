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

import { createSignal, onMount, onCleanup, Show, For } from "solid-js"
import { useTheme } from "../context/theme"
import { Bus } from "@/bus"
import * as QuantumState from "@/quantum/state"
import type { State, JobSummary } from "@/quantum/state"

function useQuantumState() {
  const [state, setState] = createSignal<State>(QuantumState.get())

  onMount(() => {
    const unsub = Bus.subscribe(QuantumState.Event.Updated, () => {
      setState({ ...QuantumState.get() })
    })
    onCleanup(unsub)
  })

  return state
}

function formatCredits(n: number): string {
  if (n >= 1000) return `$${(n / 100).toFixed(0)}`
  if (n >= 10) return `$${(n / 100).toFixed(2)}`
  return `$${(n / 100).toFixed(2)}`
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
    const computeActive = s.compute?.status === "running" || s.compute?.status === "starting"
    return activeJobs > 0 || computeActive
  }

  const creditsText = () => {
    const c = state().credits
    if (!c) return ""
    return formatCredits(c.qbraid)
  }

  const lowCredits = () => {
    const c = state().credits
    return c != null && c.qbraid < 500 // less than $5
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
          <JobsSection jobs={state().jobs} />
          <ComputeSection compute={state().compute} />
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

function ComputeSection(props: { compute: State["compute"] }) {
  const { theme } = useTheme()

  const label = () => {
    const c = props.compute
    if (!c) return null
    if (c.status === "running") return { text: `${c.profile ?? "instance"} running`, fg: theme.success }
    if (c.status === "starting") return { text: "starting...", fg: theme.warning }
    return null
  }

  return (
    <Show when={label()}>
      {(l) => (
        <text fg={theme.textMuted}>
          {"  "}<span style={{ fg: l().fg }}>▸</span> {l().text}
        </text>
      )}
    </Show>
  )
}

// --- Footer Indicator ---

export function QuantumFooterIndicator() {
  const { theme } = useTheme()
  const state = useQuantumState()

  const visible = () => state().configured
  const activeCount = () => state().jobs?.active.length ?? 0

  const indicator = () => {
    const n = activeCount()
    if (n > 0) return { fg: theme.success, text: `⚛ ${n} QPU` }
    return { fg: theme.textMuted, text: "⚛ qBraid" }
  }

  return (
    <Show when={visible()}>
      <text fg={theme.text}>
        <span style={{ fg: indicator().fg }}>⚛</span>{" "}
        {activeCount() > 0 ? `${activeCount()} QPU` : "qBraid"}
      </text>
    </Show>
  )
}
