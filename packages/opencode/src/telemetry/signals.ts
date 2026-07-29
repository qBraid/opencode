/**
 * Telemetry Signals
 *
 * Tracks implicit feedback signals from user behavior during sessions.
 * These signals help understand session quality without requiring explicit ratings.
 */

import type { SessionSignals, SessionState } from "./types"

/**
 * Tracker for implicit feedback signals within a session
 */
export class SignalTracker {
  private retryCount = 0
  private compactionCount = 0
  private errorTypes = new Set<string>()
  private turnStartTime: number | null = null
  private lastActivityTime: number = Date.now()
  private inProgressTurn = false

  /**
   * Record that a turn was retried
   */
  recordRetry(): void {
    this.retryCount++
  }

  /**
   * Record that a compaction occurred
   */
  recordCompaction(): void {
    this.compactionCount++
  }

  /**
   * Record an error that occurred during the session
   */
  recordError(errorType: string): void {
    this.errorTypes.add(errorType)
  }

  /**
   * Mark the start of a new turn
   */
  startTurn(): void {
    this.turnStartTime = Date.now()
    this.inProgressTurn = true
    this.updateActivity()
  }

  /**
   * Mark the end of the current turn
   */
  endTurn(): void {
    this.turnStartTime = null
    this.inProgressTurn = false
    this.updateActivity()
  }

  /**
   * Update the last activity timestamp
   */
  updateActivity(): void {
    this.lastActivityTime = Date.now()
  }

  /**
   * Get whether the session was abandoned mid-turn
   * (i.e., user closed while assistant was responding)
   */
  isAbandonedMidTurn(): boolean {
    return this.inProgressTurn
  }

  /**
   * Determine the final state of the session
   */
  determineFinalState(hasErrors: boolean, wasExplicitlyEnded: boolean): SessionState {
    if (hasErrors || this.errorTypes.size > 0) {
      return "error"
    }

    if (this.isAbandonedMidTurn() || !wasExplicitlyEnded) {
      return "abandoned"
    }

    return "completed"
  }

  /**
   * Get the aggregated signals for the session
   */
  getSignals(wasExplicitlyEnded: boolean): SessionSignals {
    return {
      retryCount: this.retryCount,
      compactionCount: this.compactionCount,
      abandonedMidTurn: this.isAbandonedMidTurn(),
      finalState: this.determineFinalState(false, wasExplicitlyEnded),
      errorTypes: this.errorTypes.size > 0 ? Array.from(this.errorTypes) : undefined,
    }
  }

  /**
   * Get the time since last activity (for idle detection)
   */
  getIdleTimeMs(): number {
    return Date.now() - this.lastActivityTime
  }

  /**
   * Reset the tracker (for testing or session restart)
   */
  reset(): void {
    this.retryCount = 0
    this.compactionCount = 0
    this.errorTypes.clear()
    this.turnStartTime = null
    this.lastActivityTime = Date.now()
    this.inProgressTurn = false
  }
}

/**
 * Create a new signal tracker instance
 */
export function createSignalTracker(): SignalTracker {
  return new SignalTracker()
}
