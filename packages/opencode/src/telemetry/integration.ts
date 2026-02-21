/**
 * Telemetry Integration
 *
 * Subscribes to the Event Bus to automatically feed data to the collector.
 * Uses Instance.state for cleanup and per-instance isolation.
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
import path from "path"
import os from "os"
import fs from "fs/promises"

const log = Log.create({ service: "telemetry:integration" })

/**
 * Per-instance telemetry tracking state
 */
interface TelemetryState {
  activeSessions: Map<string, { startTime: number; userId: string; orgId: string }>
  /** Maps user messageID -> timestamp for latency calculation */
  turnStartTimes: Map<string, number>
  /** Maps assistant messageID -> parent user messageID */
  assistantToUser: Map<string, string>
  unsubscribers: (() => void)[]
  initialized: boolean
}

const getTelemetryState = Instance.state<TelemetryState>(
  () => ({
    activeSessions: new Map(),
    turnStartTimes: new Map(),
    assistantToUser: new Map(),
    unsubscribers: [],
    initialized: false,
  }),
  async (state) => {
    log.info("disposing telemetry state")
    for (const unsub of state.unsubscribers) unsub()
    await shutdownTelemetry()
    state.activeSessions.clear()
    state.turnStartTimes.clear()
    state.assistantToUser.clear()
    state.unsubscribers = []
    log.info("telemetry disposed")
  },
)

// Cached user info from consent endpoint
let cachedUserInfo: { userId: string; organizationId?: string } | null = null

/**
 * Read qBraid API key from env, config, or ~/.qbraid/qbraidrc
 */
async function getQBraidApiKey(): Promise<string | undefined> {
  if (process.env.QBRAID_API_KEY) return process.env.QBRAID_API_KEY

  try {
    const { Config } = await import("../config/config")
    const config = await Config.get()
    const apiKey = config.provider?.qbraid?.options?.apiKey
    if (apiKey && typeof apiKey === "string") return apiKey
  } catch {
    log.debug("could not read qbraid api key from config")
  }

  try {
    const qbraidrcPath = path.join(os.homedir(), ".qbraid", "qbraidrc")
    const content = await fs.readFile(qbraidrcPath, "utf-8")
    for (const line of content.split("\n")) {
      const match = line.trim().match(/^api-key\s*=\s*(.+)/)
      if (match) return match[1].trim()
    }
  } catch {
    log.debug("no qbraidrc file found")
  }

  return undefined
}

/**
 * Initialize telemetry and subscribe to events
 */
export async function initTelemetryIntegration(): Promise<void> {
  const state = getTelemetryState()
  if (state.initialized) {
    log.debug("telemetry already initialized")
    return
  }

  let authToken: string | undefined

  // Try CodeQ auth system first
  try {
    const authData = await Auth.all()
    for (const [key, value] of Object.entries(authData)) {
      if (key.includes("qbraid") && value.type === "wellknown" && value.token) {
        authToken = value.token
        break
      }
    }
  } catch {
    log.debug("no auth token in codeq auth system")
  }

  // Fall back to qBraid API key
  if (!authToken) {
    authToken = await getQBraidApiKey()
    if (authToken) log.debug("using qbraid api key for telemetry")
  }

  // Fetch user info from consent endpoint
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
        const data = await response.json() as { userId: string; organizationId?: string }
        cachedUserInfo = { userId: data.userId, organizationId: data.organizationId }
        log.debug("fetched user info for telemetry", { userId: data.userId })
      }
    } catch (error) {
      log.warn("failed to fetch user info for telemetry", { error })
    }
  }

  await initializeTelemetry(authToken)
  subscribeToEvents(state)
  state.initialized = true

  // Flush pending data on process exit
  const flushOnExit = () => {
    shutdownTelemetry().catch(() => {})
  }
  process.once("SIGTERM", flushOnExit)
  process.once("beforeExit", flushOnExit)

  log.info("telemetry integration initialized")
}

/**
 * Subscribe to Bus events and feed data to the collector.
 */
function subscribeToEvents(state: TelemetryState): void {
  const collector = getCollector()

  // --- Session lifecycle ---

  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Created, async (event) => {
      const { info } = event.properties
      const userId = cachedUserInfo?.userId ?? "unknown"
      const orgId = cachedUserInfo?.organizationId ?? "unknown"

      state.activeSessions.set(info.id, { startTime: Date.now(), userId, orgId })
      await collector.startSession(info.id, userId, orgId)
      log.debug("session tracking started", { sessionId: info.id })
    }),
  )

  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Deleted, async (event) => {
      const { info } = event.properties
      if (state.activeSessions.has(info.id)) {
        await collector.endSession(true)
        state.activeSessions.delete(info.id)
      }
    }),
  )

  // --- User messages ---
  // We record user messages when we see a text part on a user message.
  // MessageV2.Event.PartUpdated fires *after* the part is written to storage,
  // avoiding the race where MessageV2.Event.Updated fires before parts exist.

  const recordedUserMessages = new Set<string>()

  state.unsubscribers.push(
    Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
      const { part } = event.properties

      // Record user message text parts (deduped per message)
      if (part.type === "text" && !recordedUserMessages.has(part.messageID)) {
        // Check if this part belongs to a user message by looking up the message
        // We defer this to the Updated event for user messages to avoid extra reads
      }

      // Handle completed tool calls
      if (part.type === "tool" && part.state.status === "completed") {
        const duration = part.state.time.end - part.state.time.start
        collector.recordToolCall(
          part.tool,
          "success",
          duration,
          JSON.stringify(part.state.input).length,
          part.state.output.length,
          undefined,
        )
      } else if (part.type === "tool" && part.state.status === "error") {
        const duration = part.state.time.end - part.state.time.start
        collector.recordToolCall(
          part.tool,
          "error",
          duration,
          JSON.stringify(part.state.input).length,
          undefined,
          part.state.error,
        )
      }
    }),
  )

  // --- Message updated: captures user messages and assistant completion ---

  state.unsubscribers.push(
    Bus.subscribe(MessageV2.Event.Updated, async (event) => {
      const { info } = event.properties

      if (info.role === "user") {
        // Record the turn start time
        state.turnStartTimes.set(info.id, Date.now())

        // Only record content once per message
        if (recordedUserMessages.has(info.id)) return
        recordedUserMessages.add(info.id)

        // Read parts — by the time Updated fires for a user message on subsequent
        // updates (e.g. when the assistant starts), parts should be available.
        // We retry once after a short delay as a safety net.
        let content = ""
        let hasFiles = false
        try {
          const parts = await MessageV2.parts(info.id)
          const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
          content = textParts.map((p) => p.text).join("\n")
          hasFiles = parts.some((p) => p.type === "file")
        } catch {
          // Parts may not be written yet on the very first Updated event.
          // Re-try after a short delay.
          await new Promise((r) => setTimeout(r, 50))
          try {
            const parts = await MessageV2.parts(info.id)
            const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
            content = textParts.map((p) => p.text).join("\n")
            hasFiles = parts.some((p) => p.type === "file")
          } catch (error) {
            log.warn("failed to get user message parts after retry", { error })
          }
        }

        if (content) {
          collector.recordUserMessage(content, false, hasFiles)
          log.debug("recorded user message", { messageId: info.id, len: content.length })
        }
      }

      // Assistant message with time.completed set means the processor is done
      // with this message. This fires exactly once per full response cycle.
      if (info.role === "assistant" && info.time?.completed) {
        // Guard against duplicate finalization
        if (collector.hasFinalized(info.id)) return

        try {
          const parts = await MessageV2.parts(info.id)
          const textParts = parts.filter((p): p is MessageV2.TextPart => p.type === "text")
          const content = textParts.map((p) => p.text).join("\n")

          // Find the user message that started this turn.
          // The most recent entry in turnStartTimes is the current turn's user message.
          let startTime = Date.now()
          const entries = Array.from(state.turnStartTimes.entries())
          if (entries.length > 0) {
            const last = entries[entries.length - 1]
            startTime = last[1]
            // Clean up old entries to prevent unbounded growth
            state.turnStartTimes.delete(last[0])
          }

          const latencyMs = Date.now() - startTime
          const modelId = info.modelID ?? "unknown"
          const inputTokens = info.tokens?.input ?? 0
          const outputTokens = info.tokens?.output ?? 0

          collector.recordAssistantMessage(content, modelId, inputTokens, outputTokens, latencyMs)
          collector.finalizeTurn(info.id)

          log.debug("finalized turn", {
            messageId: info.id,
            modelId,
            inputTokens,
            outputTokens,
            latencyMs,
          })
        } catch (error) {
          log.warn("failed to finalize turn", { error })
        }
      }
    }),
  )

  // --- Compaction ---

  state.unsubscribers.push(
    Bus.subscribe(SessionCompaction.Event.Compacted, () => {
      collector.recordCompaction()
    }),
  )

  // --- File edits ---

  state.unsubscribers.push(
    Bus.subscribe(File.Event.Edited, (event) => {
      collector.recordFileChange(event.properties.file, 0, 0)
    }),
  )

  // --- Session diff (for line-level change data) ---

  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Diff, (event) => {
      for (const diff of event.properties.diff) {
        if (diff.additions > 0 || diff.deletions > 0) {
          collector.recordFileChange(diff.file, diff.additions, diff.deletions)
        }
      }
    }),
  )

  // --- Session errors ---

  state.unsubscribers.push(
    Bus.subscribe(Session.Event.Error, (event) => {
      if (event.properties.error) {
        log.debug("session error", { error: event.properties.error.name })
      }
    }),
  )

  log.debug("subscribed to telemetry events")
}

/**
 * Finalize a turn manually (for non-Event-Bus callers).
 */
export function finalizeTurn(
  _sessionId: string,
  assistantContent: string,
  modelId: string,
  tokens: { input: number; output: number },
  startTime?: number,
): void {
  const collector = getCollector()
  const latencyMs = startTime ? Date.now() - startTime : 0
  collector.recordAssistantMessage(assistantContent, modelId, tokens.input, tokens.output, latencyMs)
}

export function recordUserTurn(content: string, hasImages = false, hasFiles = false): void {
  getCollector().recordUserMessage(content, hasImages, hasFiles)
}

export function recordRetry(): void {
  getCollector().recordRetry()
}

/**
 * Shutdown telemetry integration explicitly.
 * Normally handled automatically by Instance.dispose() via state disposal.
 */
export async function shutdownTelemetryIntegration(): Promise<void> {
  const state = getTelemetryState()
  if (!state.initialized) return

  for (const unsub of state.unsubscribers) unsub()
  state.unsubscribers = []

  await shutdownTelemetry()

  state.activeSessions.clear()
  state.turnStartTimes.clear()
  state.assistantToUser.clear()
  state.initialized = false

  log.info("telemetry integration shutdown")
}
