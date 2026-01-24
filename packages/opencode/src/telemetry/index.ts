/**
 * CodeQ Telemetry Module
 *
 * Collects session telemetry for analysis and model improvement.
 * This module is qBraid-specific and not part of upstream codeq.
 *
 * Usage:
 *   import { Telemetry } from "./telemetry"
 *
 *   // Initialize at startup (with Event Bus integration)
 *   await Telemetry.initIntegration()
 *
 *   // Or initialize manually without Event Bus
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
import {
  initTelemetryIntegration,
  shutdownTelemetryIntegration,
  finalizeTurn,
  recordUserTurn,
  recordRetry,
} from "./integration"
import type { ConsentStatus, TelemetrySession, TelemetryTurn } from "./types"

export namespace Telemetry {
  /**
   * Initialize the telemetry system with Event Bus integration
   *
   * This is the recommended way to initialize telemetry. It:
   * - Checks consent based on user tier
   * - Subscribes to relevant Event Bus events
   * - Automatically tracks sessions, messages, tool calls, and file changes
   */
  export async function initIntegration(): Promise<void> {
    await initTelemetryIntegration()
  }

  /**
   * Shutdown the telemetry system with Event Bus integration
   *
   * Unsubscribes from events and flushes pending data.
   * Should be called on application exit.
   */
  export async function shutdownIntegration(): Promise<void> {
    await shutdownTelemetryIntegration()
  }

  /**
   * Initialize the telemetry system (manual mode, no Event Bus)
   *
   * Use this if you want to manually control telemetry collection
   * without automatic Event Bus integration.
   *
   * @param authToken - Optional qBraid auth token for consent lookup
   */
  export async function initialize(authToken?: string): Promise<void> {
    await initializeTelemetry(authToken)
  }

  /**
   * Shutdown the telemetry system (manual mode)
   *
   * Flushes any pending data and cleans up resources.
   * Should be called on application exit.
   */
  export async function shutdown(): Promise<void> {
    await shutdownTelemetry()
  }

  /**
   * Finalize a turn when assistant response is complete
   *
   * Called to record the assistant's response and complete the turn.
   * This should be called after the LLM streaming is complete.
   */
  export const completeTurn = finalizeTurn

  /**
   * Record a user message (start of a turn)
   *
   * Use this for manual recording when not using Event Bus integration.
   */
  export const userMessage = recordUserTurn

  /**
   * Record that a turn was retried
   */
  export const retry = recordRetry

  /**
   * Start collecting for a new session
   *
   * @param sessionId - CodeQ session ID
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
