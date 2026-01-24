/**
 * Telemetry Collector
 *
 * Main module that collects session telemetry by subscribing to the Event Bus.
 * Aggregates data and coordinates with sanitizer, signals, and uploader modules.
 */

import { Log } from "../util/log"
import { Config } from "../config/config"
import { createSanitizer, hashFilePath, getFileExtension } from "./sanitizer"
import { createSignalTracker, type SignalTracker } from "./signals"
import { createUploader, type TelemetryUploader } from "./uploader"
import { getConsentStatus, getTelemetryEndpoint } from "./consent"
import type {
  AssistantMessageData,
  Environment,
  FileChangeData,
  ModelUsage,
  SessionMetrics,
  TelemetrySession,
  TelemetryTurn,
  ToolCallData,
  UserMessageData,
} from "./types"

const log = Log.create({ service: "telemetry:collector" })

// Package version (injected at build time or read from package.json)
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
}

/**
 * Telemetry collector instance
 */
export class TelemetryCollector {
  private uploader: TelemetryUploader | null = null
  private signalTracker: SignalTracker
  private sanitizer: ReturnType<typeof createSanitizer>
  private sessionState: SessionState | null = null
  private isEnabled = false
  private authToken: string | null = null
  private unsubscribers: (() => void)[] = []

  constructor() {
    this.signalTracker = createSignalTracker()
    this.sanitizer = createSanitizer()
  }

  /**
   * Initialize the collector
   */
  async initialize(authToken?: string): Promise<void> {
    this.authToken = authToken ?? null

    // Check consent
    const consent = await getConsentStatus(authToken)

    if (!consent.telemetryEnabled) {
      log.info("telemetry disabled by consent", { tier: consent.tier })
      this.isEnabled = false
      return
    }

    // Get config
    const config = await Config.get()
    const telemetryConfig = config.qbraid?.telemetry

    // Update sanitizer with exclude patterns from config
    if (telemetryConfig?.excludePatterns) {
      this.sanitizer = createSanitizer({
        excludePatterns: telemetryConfig.excludePatterns,
      })
    }

    // Create uploader
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

    // Subscribe to events
    this.subscribeToEvents()
  }

  /**
   * Start collecting for a new session
   */
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
    }

    this.signalTracker.reset()

    // Create session on the service
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

  /**
   * End the current session
   */
  async endSession(wasExplicitlyEnded = true): Promise<void> {
    if (!this.isEnabled || !this.sessionState) return

    // Finalize any pending turn
    if (this.sessionState.currentTurn) {
      this.finalizeTurn()
    }

    // Calculate final duration
    const durationSeconds = Math.floor((Date.now() - this.sessionState.startedAt.getTime()) / 1000)

    // Update session with final state
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

  /**
   * Record the start of a new turn (user message)
   */
  recordUserMessage(content: string, hasImages = false, hasFiles = false): void {
    if (!this.isEnabled || !this.sessionState) return

    this.signalTracker.startTurn()

    const consent = getConsentStatus(this.authToken ?? undefined)

    // Create new turn
    this.sessionState.currentTurn = {
      turnIndex: this.sessionState.currentTurnIndex,
      createdAt: new Date().toISOString(),
      userMessage: {
        content: this.sanitizer.sanitizeContent(content),
        contentLength: content.length,
        hasImages,
        hasFiles,
      },
      toolCalls: [],
      wasRetried: false,
    }
  }

  /**
   * Record the assistant response
   */
  recordAssistantMessage(
    content: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    this.sessionState.currentTurn.assistantMessage = {
      content: this.sanitizer.sanitizeContent(content),
      contentLength: content.length,
      modelId,
      inputTokens,
      outputTokens,
      latencyMs,
    }

    // Update model usage
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

    // Update session metrics
    this.sessionState.metrics.totalInputTokens += inputTokens
    this.sessionState.metrics.totalOutputTokens += outputTokens
  }

  /**
   * Record a tool call
   */
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

    // Update metrics
    this.sessionState.metrics.toolCallCount++
    if (status === "error") {
      this.sessionState.metrics.toolErrorCount++
      if (errorType) {
        this.signalTracker.recordError(errorType)
      }
    }
  }

  /**
   * Record a file change
   */
  recordFileChange(filePath: string, additions: number, deletions: number): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    // Skip sensitive files
    if (this.sanitizer.isSensitiveFile(filePath)) {
      return
    }

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

    // Update metrics
    this.sessionState.metrics.filesModified++
    this.sessionState.metrics.linesAdded += additions
    this.sessionState.metrics.linesDeleted += deletions
  }

  /**
   * Record that the current turn was retried
   */
  recordRetry(): void {
    if (!this.isEnabled || !this.sessionState || !this.sessionState.currentTurn) return

    this.sessionState.currentTurn.wasRetried = true
    this.signalTracker.recordRetry()
  }

  /**
   * Record a compaction event
   */
  recordCompaction(): void {
    if (!this.isEnabled) return
    this.signalTracker.recordCompaction()
  }

  /**
   * Finalize the current turn and queue for upload
   */
  private finalizeTurn(): void {
    if (!this.sessionState?.currentTurn) return

    const turn = this.sessionState.currentTurn as TelemetryTurn

    // Ensure we have both user and assistant messages
    if (!turn.userMessage || !turn.assistantMessage) {
      log.warn("incomplete turn, skipping", { turnIndex: turn.turnIndex })
      this.sessionState.currentTurn = null
      return
    }

    // Queue for upload
    if (this.uploader) {
      this.uploader.addTurn(turn)
    }

    // Update state
    this.sessionState.metrics.turnCount++
    this.sessionState.currentTurnIndex++
    this.sessionState.currentTurn = null

    this.signalTracker.endTurn()
  }

  /**
   * Subscribe to Event Bus events
   */
  private subscribeToEvents(): void {
    // Note: These subscriptions would integrate with the actual Event Bus
    // For now, this is a placeholder that shows the intended integration points

    // Example subscriptions (to be wired up with actual Bus events):
    // Bus.subscribe("message.updated", this.handleMessageUpdated.bind(this))
    // Bus.subscribe("session.created", this.handleSessionCreated.bind(this))
    // Bus.subscribe("compaction.completed", this.handleCompaction.bind(this))

    log.debug("event subscriptions registered")
  }

  /**
   * Unsubscribe from all events
   */
  private unsubscribeAll(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe()
    }
    this.unsubscribers = []
  }

  /**
   * Detect the environment (local vs qBraid Lab)
   */
  private detectEnvironment(): Environment {
    // Check for qBraid Lab environment indicators
    if (process.env.QBRAID_LAB || process.env.JUPYTERHUB_USER) {
      return "lab"
    }
    return "local"
  }

  /**
   * Shutdown the collector
   */
  async shutdown(): Promise<void> {
    this.unsubscribeAll()
    await this.endSession(false) // Treat as abandoned if shutdown without explicit end
  }
}

// Singleton instance
let collectorInstance: TelemetryCollector | null = null

/**
 * Get or create the telemetry collector instance
 */
export function getCollector(): TelemetryCollector {
  if (!collectorInstance) {
    collectorInstance = new TelemetryCollector()
  }
  return collectorInstance
}

/**
 * Initialize the telemetry system
 */
export async function initializeTelemetry(authToken?: string): Promise<void> {
  const collector = getCollector()
  await collector.initialize(authToken)
}

/**
 * Shutdown the telemetry system
 */
export async function shutdownTelemetry(): Promise<void> {
  if (collectorInstance) {
    await collectorInstance.shutdown()
    collectorInstance = null
  }
}
