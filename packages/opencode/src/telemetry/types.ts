/**
 * Telemetry Types
 *
 * Type definitions for CodeQ telemetry data.
 * These match the schema expected by the qbraid-telemetry microservice.
 */

/**
 * User tier for consent-based telemetry
 */
export type UserTier = "free" | "standard" | "pro"

/**
 * Data collection level
 */
export type DataLevel = "full" | "metrics-only"

/**
 * Environment where CodeQ is running
 */
export type Environment = "local" | "lab"

/**
 * Session state for implicit feedback
 */
export type SessionState = "completed" | "abandoned" | "error"

/**
 * Consent status from the telemetry service
 */
export interface ConsentStatus {
  userId: string
  tier: UserTier
  telemetryEnabled: boolean
  dataLevel: DataLevel
}

/**
 * Session metrics aggregated across all turns
 */
export interface SessionMetrics {
  turnCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  toolCallCount: number
  toolErrorCount: number
  filesModified: number
  linesAdded: number
  linesDeleted: number
}

/**
 * Implicit feedback signals derived from session behavior
 */
export interface SessionSignals {
  retryCount: number
  compactionCount: number
  abandonedMidTurn: boolean
  finalState: SessionState
  errorTypes?: string[]
}

/**
 * Model usage breakdown
 */
export interface ModelUsage {
  [modelId: string]: {
    turns: number
    inputTokens: number
    outputTokens: number
  }
}

/**
 * CodeQ Session telemetry payload
 */
export interface TelemetrySession {
  // Identity
  userId: string
  organizationId: string

  // Session metadata
  sessionId: string
  codeqVersion: string
  environment: Environment
  projectHash?: string

  // Timing
  startedAt: string // ISO 8601
  endedAt?: string // ISO 8601
  durationSeconds: number

  // Consent
  consentTier: UserTier
  dataLevel: DataLevel

  // Aggregated data
  metrics: SessionMetrics
  signals: SessionSignals
  modelUsage: ModelUsage
}

/**
 * Tool call metadata for a turn
 */
export interface ToolCallData {
  name: string
  status: "success" | "error"
  durationMs: number
  inputSizeBytes?: number
  outputSizeBytes?: number
  errorType?: string
}

/**
 * File change metadata for a turn
 */
export interface FileChangeData {
  pathHash: string // SHA-256 of relative path
  extension: string
  additions: number
  deletions: number
}

/**
 * User message data for a turn
 */
export interface UserMessageData {
  content: string
  contentLength: number
  hasImages: boolean
  hasFiles: boolean
}

/**
 * Assistant message data for a turn
 */
export interface AssistantMessageData {
  content: string
  contentLength: number
  modelId: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

/**
 * A single turn (user message + assistant response) in a session
 */
export interface TelemetryTurn {
  turnIndex: number
  createdAt: string // ISO 8601

  userMessage: UserMessageData
  assistantMessage: AssistantMessageData

  toolCalls: ToolCallData[]
  fileChanges?: FileChangeData[]

  wasRetried: boolean
  userEditedAfter?: boolean
}

/**
 * Request payload for creating/updating a session
 */
export interface CreateSessionRequest {
  session: TelemetrySession
  turns?: TelemetryTurn[]
}

/**
 * Request payload for adding turns to a session
 */
export interface AddTurnsRequest {
  turns: TelemetryTurn[]
}

/**
 * Response from session creation
 */
export interface SessionResponse {
  id: string
  sessionId: string
  created: boolean
  turnsAdded: number
}
