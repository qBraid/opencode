/**
 * Telemetry Integration
 *
 * Integrates the telemetry system with CodeQ's Event Bus.
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
import { Storage } from "../storage/storage"
import { getCollector, initializeTelemetry, shutdownTelemetry } from "./collector"
import path from "path"
import os from "os"
import fs from "fs/promises"

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
 * Get qBraid API key from config or environment
 */
async function getQBraidApiKey(): Promise<string | undefined> {
  // Try environment variable first
  if (process.env.QBRAID_API_KEY) {
    return process.env.QBRAID_API_KEY
  }

  // Try to get from CodeQ config (provider.qbraid.options.apiKey)
  try {
    const { Config } = await import("../config/config")
    const config = await Config.get()
    const apiKey = config.provider?.qbraid?.options?.apiKey
    if (apiKey && typeof apiKey === "string") {
      return apiKey
    }
  } catch (error) {
    log.debug("could not read qbraid api key from config")
  }

  // Fall back to ~/.qbraid/qbraidrc file
  try {
    const qbraidrcPath = path.join(os.homedir(), ".qbraid", "qbraidrc")
    const content = await fs.readFile(qbraidrcPath, "utf-8")

    // Parse INI-style config
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("api-key")) {
        const match = trimmed.match(/api-key\s*=\s*(.+)/)
        if (match) {
          return match[1].trim()
        }
      }
    }
  } catch (error) {
    // File doesn't exist or can't be read
    log.debug("no qbraidrc file found")
  }

  return undefined
}

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

  // First try to get from CodeQ auth system
  try {
    const authData = await Auth.all()
    // Find qBraid auth if available
    for (const [key, value] of Object.entries(authData)) {
      if (key.includes("qbraid") && value.type === "wellknown" && value.token) {
        authToken = value.token
        break
      }
    }
  } catch (error) {
    log.debug("no auth token in codeq auth system")
  }

  // Fall back to qBraid API key from config or qbraidrc
  if (!authToken) {
    authToken = await getQBraidApiKey()
    if (authToken) {
      log.debug("using qbraid api key for telemetry")
    }
  }

  // Fetch user info from consent endpoint before initializing
  if (authToken) {
    try {
      const { Config } = await import("../config/config")
      const config = await Config.get()
      const endpoint = config.qbraid?.telemetry?.endpoint ?? "https://qbraid-telemetry-314301605548.us-central1.run.app"
      
      const response = await fetch(`${endpoint}/api/v1/consent`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
      })
      
      if (response.ok) {
        const consentData = await response.json() as { userId: string; organizationId?: string }
        cachedUserInfo = {
          userId: consentData.userId,
          organizationId: consentData.organizationId,
        }
        log.debug("fetched user info for telemetry", { userId: consentData.userId })
      }
    } catch (error) {
      log.warn("failed to fetch user info for telemetry", { error })
    }
  }

  // Initialize the telemetry system
  await initializeTelemetry(authToken)

  // Subscribe to session events
  subscribeToEvents(state)

  state.initialized = true
  log.info("telemetry integration initialized")
}

// Store user info from consent endpoint
let cachedUserInfo: { userId: string; organizationId?: string } | null = null

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

      // Get user ID from cached consent info
      const userId = cachedUserInfo?.userId ?? "unknown"
      const orgId = cachedUserInfo?.organizationId ?? "unknown"

      state.activeSessions.set(info.id, {
        startTime: Date.now(),
        userId,
        orgId,
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

  // Track which user messages we've already recorded
  const recordedUserMessages = new Set<string>()

  // Message updated - track user/assistant messages
  state.unsubscribers.push(
    Bus.subscribe(MessageV2.Event.Updated, async (event) => {
      const { info } = event.properties

      if (info.role === "user") {
        // User message - start of a turn
        state.messageStartTimes.set(info.id, Date.now())

        // Only record each user message once
        if (recordedUserMessages.has(info.id)) {
          return
        }

        // Get user message content from parts
        try {
          const parts = await MessageV2.parts(info.id)
          const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
          const content = textParts.map((p) => p.text).join("\n")
          const hasFiles = parts.some((p) => p.type === "file")

          if (content) {
            recordedUserMessages.add(info.id)
            collector.recordUserMessage(content, false, hasFiles)
            log.debug("recorded user message", { messageId: info.id, contentLength: content.length })
          }
        } catch (error) {
          log.warn("failed to get user message content", { error })
        }
      }
    }),
  )

  // Message part updated - track tool calls, text content, and step finishes
  state.unsubscribers.push(
    Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
      const { part } = event.properties

      // Handle completed tool calls
      if (part.type === "tool" && part.state.status === "completed") {
        const toolState = part.state
        const duration = toolState.time.end - toolState.time.start
        collector.recordToolCall(
          part.tool,
          "success",
          duration,
          JSON.stringify(toolState.input).length,
          toolState.output.length,
          undefined,
        )
        log.debug("recorded tool call", { tool: part.tool, duration })
      } else if (part.type === "tool" && part.state.status === "error") {
        const toolState = part.state
        const duration = toolState.time.end - toolState.time.start
        collector.recordToolCall(
          part.tool,
          "error",
          duration,
          JSON.stringify(toolState.input).length,
          undefined,
          toolState.error,
        )
        log.debug("recorded tool error", { tool: part.tool, error: toolState.error })
      }

      // Handle step-finish - this signals end of assistant response
      if (part.type === "step-finish") {
        // Get the parent message to extract text content
        ;(async () => {
          try {
            const parts = await MessageV2.parts(part.messageID)
            const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
            const content = textParts.map((p) => p.text).join("\n")

            // Calculate latency from turn start
            const userMessageId = Array.from(state.messageStartTimes.keys()).pop()
            const startTime = userMessageId ? state.messageStartTimes.get(userMessageId) : Date.now()
            const latencyMs = Date.now() - (startTime ?? Date.now())

            // Get model and tokens from the message info (more reliable than step-finish)
            const messageInfo = await Storage.read<MessageV2.Assistant>(["message", part.sessionID, part.messageID])
            const modelId = messageInfo?.modelID ?? "unknown"
            
            // Prefer message-level tokens (cumulative), fall back to step-finish tokens
            const inputTokens = messageInfo?.tokens?.input ?? part.tokens.input
            const outputTokens = messageInfo?.tokens?.output ?? part.tokens.output

            collector.recordAssistantMessage(
              content,
              modelId,
              inputTokens,
              outputTokens,
              latencyMs,
            )

            // Finalize the turn - this uploads it to the service
            collector.finalizeTurn()

            log.debug("recorded assistant message and finalized turn", {
              messageId: part.messageID,
              modelId,
              inputTokens,
              outputTokens,
              latencyMs,
            })
          } catch (error) {
            log.warn("failed to record assistant message", { error })
          }
        })()
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
  // Note: The event only provides the file path, not the diff
  // Detailed diff tracking would need to be done at the tool level
  state.unsubscribers.push(
    Bus.subscribe(File.Event.Edited, (event) => {
      const { file } = event.properties
      // Record that a file was modified (without detailed line counts)
      collector.recordFileChange(file, 0, 0)
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
