/**
 * Telemetry Collector
 *
 * Collects session telemetry per-instance. Uses Instance.state so each project
 * context gets its own collector that is disposed when the instance shuts down.
 */

import { Log } from "../util/log"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { createSanitizer } from "./sanitizer"
import { createSignalTracker, type SignalTracker } from "./signals"
import { createUploader, type TelemetryUploader } from "./uploader"
import { getConsentStatus, getTelemetryEndpoint } from "./consent"
import type {
  Environment,
  FileChangeData,
  ModelUsage,
  SessionMetrics,
  TelemetrySession,
  TelemetryTurn,
  ToolCallData,
} from "./types"

const log = Log.create({ service: "telemetry:collector" })

const CODEQ_VERSION = process.env.npm_package_version ?? "0.0.0"

/**
 * State for tracking the current session
 */
interface SessionState {
  sessionId: string
  startedAt: Date
  userId: string
  organizationId: string
  environment: Environment
  metrics: SessionMetrics
  modelUsage: ModelUsage
  currentTurnIndex: number
  currentTurn: Partial<TelemetryTurn> | null
  /** Tracks which assistant messageIDs have already been finalized */
  finalizedMessages: Set<string>
}

/**
 * Telemetry collector — one per Instance (project context)
 */
export class TelemetryCollector {
  private uploader: TelemetryUploader | null = null
  private signalTracker: SignalTracker
  private sanitizer: ReturnType<typeof createSanitizer>
  private sessionState: SessionState | null = null
  private isEnabled = false
  private authToken: string | null = null
  private dataLevel: "full" | "metrics-only" = "full"

  constructor() {
    this.signalTracker = createSignalTracker()
    this.sanitizer = createSanitizer()
  }

  async initialize(authToken?: string): Promise<void> {
    this.authToken = authToken ?? null

    const consent = await getConsentStatus(authToken)

    if (!consent.telemetryEnabled) {
      log.info("telemetry disabled by consent", { tier: consent.tier })
      this.isEnabled = false
      return
    }

    this.dataLevel = consent.dataLevel

    const config = await Config.get()
    const telemetryConfig = config.qbraid?.telemetry

    if (telemetryConfig?.excludePatterns) {
      this.sanitizer = createSanitizer({
        excludePatterns: telemetryConfig.excludePatterns,
      })
    }

    const endpoint = telemetryConfig?.endpoint ?? getTelemetryEndpoint()

    if (authToken) {
      this.uploader = createUploader({
        endpoint,
        authToken,
        batchSize: telemetryConfig?.batchSize,
        flushIntervalMs: telemetryConfig?.flushIntervalMs,
      })
    }

    this.isEnabled = true
    log.info("telemetry initialized", { endpoint, dataLevel: consent.dataLevel })
  }

  async startSession(sessionId: string, userId: string, organizationId: string): Promise<void> {
    if (!this.isEnabled) return

    const consent = await getConsentStatus(this.authToken ?? undefined)

    this.sessionState = {
      sessionId,
      startedAt: new Date(),
      userId,
      organizationId,
      environment: this.detectEnvironment(),
      metrics: {
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        toolErrorCount: 0,
        filesModified: 0,
        linesAdded: 0,
        linesDeleted: 0,
      },
      modelUsage: {},
      currentTurnIndex: 0,
      currentTurn: null,
      finalizedMessages: new Set(),
    }

    this.signalTracker.reset()

    if (this.uploader) {
      const session: TelemetrySession = {
        userId,
        organizationId,
        sessionId,
        codeqVersion: CODEQ_VERSION,
        environment: this.sessionState.environment,
        startedAt: this.sessionState.startedAt.toISOString(),
        durationSeconds: 0,
        consentTier: consent.tier,
        dataLevel: consent.dataLevel,
        metrics: this.sessionState.metrics,
        signals: this.signalTracker.getSignals(false),
        modelUsage: {},
      }

      await this.uploader.createSession(session)
    }

    log.debug("session started", { sessionId })
  }

  async endSession(wasExplicitlyEnded = true): Promise<void> {
    if (!this.isEnabled || !this.sessionState) return

    if (this.sessionState.currentTurn) {
      this.finalizeTurn()
    }

    const durationSeconds = Math.floor((Date.now() - this.sessionState.startedAt.getTime()) / 1000)

    if (this.uploader) {
      await this.uploader.updateSession({
        endedAt: new Date().toISOString(),
        durationSeconds,
        metrics: this.sessionState.metrics,
        signals: this.signalTracker.getSignals(wasExplicitlyEnded),
        modelUsage: this.sessionState.modelUsage,
      })

      await this.uploader.shutdown()
    }

    log.debug("session ended", {
      sessionId: this.sessionState.sessionId,
      duration: durationSeconds,
      turns: this.sessionState.metrics.turnCount,
    })

    this.sessionState = null
  }

  recordUserMessage(content: string, hasImages = false, hasFiles = false): void {
    if (!this.isEnabled || !this.sessionState) return

    this.signalTracker.startTurn()

    // Respect dataLevel: metrics-only skips message content
    const sanitizedContent = this.dataLevel === "full"
      ? this.sanitizer.sanitizeContent(content)
      : ""

    this.sessionState.currentTurn = {
      turnIndex: this.sessionState.currentTurnIndex,
      createdAt: new Date().toISOString(),
      userMessage: {
        content: sanitizedContent,
        contentLength: content.length,
        hasImages,
        hasFiles,
      },
      toolCalls: [],
      wasRetried: false,
    }
  }

  recordAssistantMessage(
    content: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    const sanitizedContent = this.dataLevel === "full"
      ? this.sanitizer.sanitizeContent(content)
      : ""

    this.sessionState.currentTurn.assistantMessage = {
      content: sanitizedContent,
      contentLength: content.length,
      modelId,
      inputTokens,
      outputTokens,
      latencyMs,
    }

    if (!this.sessionState.modelUsage[modelId]) {
      this.sessionState.modelUsage[modelId] = {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
      }
    }
    this.sessionState.modelUsage[modelId].turns++
    this.sessionState.modelUsage[modelId].inputTokens += inputTokens
    this.sessionState.modelUsage[modelId].outputTokens += outputTokens

    this.sessionState.metrics.totalInputTokens += inputTokens
    this.sessionState.metrics.totalOutputTokens += outputTokens
  }

  recordToolCall(
    name: string,
    status: "success" | "error",
    durationMs: number,
    inputSize?: number,
    outputSize?: number,
    errorType?: string,
  ): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    const toolCall: ToolCallData = {
      name,
      status,
      durationMs,
      inputSizeBytes: inputSize,
      outputSizeBytes: outputSize,
      errorType,
    }

    this.sessionState.currentTurn.toolCalls?.push(toolCall)

    this.sessionState.metrics.toolCallCount++
    if (status === "error") {
      this.sessionState.metrics.toolErrorCount++
      if (errorType) {
        this.signalTracker.recordError(errorType)
      }
    }
  }

  recordFileChange(filePath: string, additions: number, deletions: number): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    if (this.sanitizer.isSensitiveFile(filePath)) return

    const fileChange: FileChangeData = {
      pathHash: this.sanitizer.hashFilePath(filePath),
      extension: this.sanitizer.getFileExtension(filePath),
      additions,
      deletions,
    }

    if (!this.sessionState.currentTurn.fileChanges) {
      this.sessionState.currentTurn.fileChanges = []
    }
    this.sessionState.currentTurn.fileChanges.push(fileChange)

    this.sessionState.metrics.filesModified++
    this.sessionState.metrics.linesAdded += additions
    this.sessionState.metrics.linesDeleted += deletions
  }

  recordRetry(): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    this.sessionState.currentTurn.wasRetried = true
    this.signalTracker.recordRetry()
  }

  recordCompaction(): void {
    if (!this.isEnabled) return
    this.signalTracker.recordCompaction()
  }

  /**
   * Check if an assistant message has already been finalized (prevents duplicates
   * from multiple step-finish events in multi-step tool-call loops).
   */
  hasFinalized(messageId: string): boolean {
    return this.sessionState?.finalizedMessages.has(messageId) ?? false
  }

  /**
   * Finalize the current turn and queue for upload.
   * Returns false if the turn was incomplete and skipped.
   */
  finalizeTurn(messageId?: string): boolean {
    if (!this.sessionState?.currentTurn) return false

    const turn = this.sessionState.currentTurn as TelemetryTurn

    if (!turn.userMessage || !turn.assistantMessage) {
      log.warn("incomplete turn, skipping", { turnIndex: turn.turnIndex })
      this.sessionState.currentTurn = null
      return false
    }

    if (messageId) {
      this.sessionState.finalizedMessages.add(messageId)
    }

    if (this.uploader) {
      this.uploader.addTurn(turn)
    }

    this.sessionState.metrics.turnCount++
    this.sessionState.currentTurnIndex++
    this.sessionState.currentTurn = null

    this.signalTracker.endTurn()
    return true
  }

  private detectEnvironment(): Environment {
    if (process.env.QBRAID_LAB || process.env.JUPYTERHUB_USER) return "lab"
    return "local"
  }

  async shutdown(): Promise<void> {
    await this.endSession(false)
  }
}

/**
 * Instance-scoped collector state. Each project directory gets its own collector
 * that is automatically disposed when Instance.dispose() is called.
 */
const getCollectorState = Instance.state<{ collector: TelemetryCollector }>(
  () => ({ collector: new TelemetryCollector() }),
  async (state) => {
    await state.collector.shutdown()
  },
)

/**
 * Get the collector for the current Instance context.
 */
export function getCollector(): TelemetryCollector {
  return getCollectorState().collector
}

export async function initializeTelemetry(authToken?: string): Promise<void> {
  const collector = getCollector()
  await collector.initialize(authToken)
}

export async function shutdownTelemetry(): Promise<void> {
  const collector = getCollector()
  await collector.shutdown()
}
