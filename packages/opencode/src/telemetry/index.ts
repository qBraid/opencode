/**
 * CodeQ Telemetry Module
 *
 * Collects session telemetry for analysis and model improvement.
 * This module is qBraid-specific and not part of upstream opencode.
 *
 * Usage:
 *   import { Telemetry } from "./telemetry"
 *
 *   // Initialize at startup
 *   await Telemetry.initialize(authToken)
 *
 *   // Start a session
 *   await Telemetry.startSession(sessionId, userId, orgId)
 *
 *   // Record events during the session
 *   Telemetry.recordUserMessage(content)
 *   Telemetry.recordAssistantMessage(content, model, tokens, latency)
 *   Telemetry.recordToolCall(name, status, duration)
 *   Telemetry.recordFileChange(path, additions, deletions)
 *
 *   // End the session
 *   await Telemetry.endSession()
 *
 *   // Shutdown on exit
 *   await Telemetry.shutdown()
 */

import {
  getCollector,
  initializeTelemetry,
  shutdownTelemetry,
  type TelemetryCollector,
} from "./collector"
import { getConsentStatus, isTelemetryEnabled, clearConsentCache } from "./consent"
import type { ConsentStatus, TelemetrySession, TelemetryTurn } from "./types"

export namespace Telemetry {
  /**
   * Initialize the telemetry system
   *
   * Must be called before any other telemetry functions.
   * Will check consent and configure collection accordingly.
   *
   * @param authToken - Optional qBraid auth token for consent lookup
   */
  export async function initialize(authToken?: string): Promise<void> {
    await initializeTelemetry(authToken)
  }

  /**
   * Shutdown the telemetry system
   *
   * Flushes any pending data and cleans up resources.
   * Should be called on application exit.
   */
  export async function shutdown(): Promise<void> {
    await shutdownTelemetry()
  }

  /**
   * Start collecting for a new session
   *
   * @param sessionId - OpenCode session ID
   * @param userId - qBraid user ID
   * @param organizationId - Organization ID
   */
  export async function startSession(
    sessionId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const collector = getCollector()
    await collector.startSession(sessionId, userId, organizationId)
  }

  /**
   * End the current session
   *
   * @param wasExplicitlyEnded - Whether the user explicitly ended the session
   */
  export async function endSession(wasExplicitlyEnded = true): Promise<void> {
    const collector = getCollector()
    await collector.endSession(wasExplicitlyEnded)
  }

  /**
   * Record a user message (start of a turn)
   *
   * @param content - Message content
   * @param hasImages - Whether the message includes images
   * @param hasFiles - Whether the message includes file attachments
   */
  export function recordUserMessage(content: string, hasImages = false, hasFiles = false): void {
    const collector = getCollector()
    collector.recordUserMessage(content, hasImages, hasFiles)
  }

  /**
   * Record an assistant response (end of a turn)
   *
   * @param content - Response content
   * @param modelId - Model used for generation
   * @param inputTokens - Number of input tokens
   * @param outputTokens - Number of output tokens
   * @param latencyMs - Response latency in milliseconds
   */
  export function recordAssistantMessage(
    content: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ): void {
    const collector = getCollector()
    collector.recordAssistantMessage(content, modelId, inputTokens, outputTokens, latencyMs)
  }

  /**
   * Record a tool call
   *
   * @param name - Tool name
   * @param status - Execution status
   * @param durationMs - Execution duration in milliseconds
   * @param inputSize - Size of input in bytes
   * @param outputSize - Size of output in bytes
   * @param errorType - Error type if status is "error"
   */
  export function recordToolCall(
    name: string,
    status: "success" | "error",
    durationMs: number,
    inputSize?: number,
    outputSize?: number,
    errorType?: string,
  ): void {
    const collector = getCollector()
    collector.recordToolCall(name, status, durationMs, inputSize, outputSize, errorType)
  }

  /**
   * Record a file change
   *
   * @param filePath - Path to the modified file
   * @param additions - Lines added
   * @param deletions - Lines deleted
   */
  export function recordFileChange(filePath: string, additions: number, deletions: number): void {
    const collector = getCollector()
    collector.recordFileChange(filePath, additions, deletions)
  }

  /**
   * Record that the current turn was retried
   */
  export function recordRetry(): void {
    const collector = getCollector()
    collector.recordRetry()
  }

  /**
   * Record a compaction event
   */
  export function recordCompaction(): void {
    const collector = getCollector()
    collector.recordCompaction()
  }

  /**
   * Check if telemetry is currently enabled
   *
   * @param authToken - Optional auth token for consent lookup
   */
  export async function isEnabled(authToken?: string): Promise<boolean> {
    return isTelemetryEnabled(authToken)
  }

  /**
   * Get the current consent status
   *
   * @param authToken - Optional auth token for consent lookup
   */
  export async function getConsent(authToken?: string): Promise<ConsentStatus> {
    return getConsentStatus(authToken)
  }

  /**
   * Clear cached consent (useful when user changes settings)
   */
  export function clearCache(): void {
    clearConsentCache()
  }
}

// Re-export types for convenience
export type { ConsentStatus, TelemetrySession, TelemetryTurn } from "./types"
