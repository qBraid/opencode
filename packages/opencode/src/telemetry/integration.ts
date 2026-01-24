/**
 * Telemetry Integration
 *
 * Integrates the telemetry system with OpenCode's Event Bus.
 * This module subscribes to relevant events and feeds data to the collector.
 */

import { Bus } from "../bus"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionCompaction } from "../session/compaction"
import { File } from "../file"
import { Log } from "../util/log"
import { Auth } from "../auth"
import { Instance } from "../project/instance"
import { getCollector, initializeTelemetry, shutdownTelemetry } from "./collector"

const log = Log.create({ service: "telemetry:integration" })

/**
 * Telemetry state managed by Instance.state for automatic cleanup
 */
interface TelemetryState {
  activeSessions: Map<string, { startTime: number; userId?: string; orgId?: string }>
  messageStartTimes: Map<string, number>
  unsubscribers: (() => void)[]
  initialized: boolean
}

/**
 * Get or create telemetry state with automatic disposal on instance cleanup
 */
const getTelemetryState = Instance.state<TelemetryState>(
  () => ({
    activeSessions: new Map(),
    messageStartTimes: new Map(),
    unsubscribers: [],
    initialized: false,
  }),
  async (state) => {
    // Dispose handler - called when Instance.dispose() is invoked
    log.info("disposing telemetry state")

    // Unsubscribe from all events
    for (const unsub of state.unsubscribers) {
      unsub()
    }

    // Shutdown telemetry (flushes pending data)
    await shutdownTelemetry()

    // Clear tracking maps
    state.activeSessions.clear()
    state.messageStartTimes.clear()
    state.unsubscribers = []

    log.info("telemetry disposed")
  },
)

/**
 * Initialize telemetry and subscribe to events
 */
export async function initTelemetryIntegration(): Promise<void> {
  const state = getTelemetryState()

  // Avoid double initialization
  if (state.initialized) {
    log.debug("telemetry already initialized")
    return
  }

  // Get auth token if available
  let authToken: string | undefined
  try {
    const authData = await Auth.all()
    // Find qBraid auth if available
    for (const [key, value] of Object.entries(authData)) {
      if (key.includes("qbraid") && value.token) {
        authToken = value.token
        break
      }
    }
  } catch (error) {
    log.debug("no auth token available for telemetry")
  }

  // Initialize the telemetry system
  await initializeTelemetry(authToken)

  // Subscribe to session events
  subscribeToEvents(state)

  state.initialized = true
  log.info("telemetry integration initialized")
}

/**
 * Subscribe to all relevant events
 */
function subscribeToEvents(state: TelemetryState): void {
  const collector = getCollector()

  // Session created - start tracking
  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Created, async (event) => {
      const { info } = event.properties
      log.debug("session created", { sessionId: info.id })

      state.activeSessions.set(info.id, {
        startTime: Date.now(),
        // TODO: Get actual user ID from qBraid auth
        userId: "unknown",
        orgId: "unknown",
      })

      // Start telemetry session
      const sessionData = state.activeSessions.get(info.id)
      if (sessionData) {
        await collector.startSession(info.id, sessionData.userId ?? "unknown", sessionData.orgId ?? "unknown")
      }
    }),
  )

  // Session deleted - end tracking
  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Deleted, async (event) => {
      const { info } = event.properties
      log.debug("session deleted", { sessionId: info.id })

      if (state.activeSessions.has(info.id)) {
        await collector.endSession(true)
        state.activeSessions.delete(info.id)
      }
    }),
  )

  // Message updated - track user/assistant messages
  state.unsubscribers.push(
    Bus.subscribe(MessageV2.Event.Updated, (event) => {
      const { info } = event.properties

      if (info.role === "user") {
        // User message - start of a turn
        state.messageStartTimes.set(info.id, Date.now())
      }
    }),
  )

  // Message part updated - track tool calls and text content
  state.unsubscribers.push(
    Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
      const { part } = event.properties

      // Handle completed tool calls
      if (part.type === "tool" && (part.state === "completed" || part.state === "error")) {
        const duration = part.time?.end && part.time?.start ? part.time.end - part.time.start : 0
        const status = part.state === "completed" ? "success" : "error"

        collector.recordToolCall(
          part.tool,
          status,
          duration,
          part.input ? JSON.stringify(part.input).length : undefined,
          part.output ? part.output.length : undefined,
          status === "error" ? "tool_error" : undefined,
        )
      }

      // Handle text parts for assistant messages
      if (part.type === "text" && part.time?.end) {
        // This is a completed text part - we'll aggregate these
        // The full message content will be captured when the message is finalized
      }
    }),
  )

  // Compaction event
  state.unsubscribers.push(
    Bus.subscribe(SessionCompaction.Event.Compacted, (event) => {
      log.debug("compaction occurred", { sessionId: event.properties.sessionID })
      collector.recordCompaction()
    }),
  )

  // File edited event - track file changes
  state.unsubscribers.push(
    Bus.subscribe(File.Event.Edited, (event) => {
      const { path, diff } = event.properties

      // Count additions and deletions from diff
      let additions = 0
      let deletions = 0

      if (diff) {
        const lines = diff.split("\n")
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            additions++
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            deletions++
          }
        }
      }

      collector.recordFileChange(path, additions, deletions)
    }),
  )

  // Session error event
  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Error, (event) => {
      const { error } = event.properties
      if (error) {
        // Record error in signals
        const collector = getCollector()
        // The collector tracks errors internally via recordToolCall with error status
        log.debug("session error", { error: error.name })
      }
    }),
  )

  log.debug("subscribed to telemetry events")
}

/**
 * Finalize a turn when assistant response is complete
 *
 * Called from the session processor when a message is fully processed.
 */
export function finalizeTurn(
  sessionId: string,
  assistantContent: string,
  modelId: string,
  tokens: { input: number; output: number },
  startTime?: number,
): void {
  const collector = getCollector()

  // Calculate latency
  const latencyMs = startTime ? Date.now() - startTime : 0

  // Record the assistant message
  collector.recordAssistantMessage(assistantContent, modelId, tokens.input, tokens.output, latencyMs)
}

/**
 * Record that a user message was sent
 */
export function recordUserTurn(content: string, hasImages = false, hasFiles = false): void {
  const collector = getCollector()
  collector.recordUserMessage(content, hasImages, hasFiles)
}

/**
 * Record that a turn was retried
 */
export function recordRetry(): void {
  const collector = getCollector()
  collector.recordRetry()
}

/**
 * Shutdown telemetry and unsubscribe from events
 *
 * Note: This is normally handled automatically by Instance.dispose()
 * via the state disposal mechanism. This function is provided for
 * explicit shutdown in non-standard scenarios.
 */
export async function shutdownTelemetryIntegration(): Promise<void> {
  const state = getTelemetryState()

  if (!state.initialized) {
    return
  }

  // Unsubscribe from all events
  for (const unsub of state.unsubscribers) {
    unsub()
  }
  state.unsubscribers = []

  // Shutdown telemetry (flushes pending data)
  await shutdownTelemetry()

  // Clear tracking maps
  state.activeSessions.clear()
  state.messageStartTimes.clear()
  state.initialized = false

  log.info("telemetry integration shutdown")
}
