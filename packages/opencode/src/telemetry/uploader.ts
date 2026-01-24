/**
 * Telemetry Uploader
 *
 * Handles batching and uploading telemetry data to the qBraid telemetry service.
 * Includes retry logic, offline handling, and graceful degradation.
 */

import { Log } from "../util/log"
import type {
  AddTurnsRequest,
  CreateSessionRequest,
  SessionResponse,
  TelemetrySession,
  TelemetryTurn,
} from "./types"

const log = Log.create({ service: "telemetry:uploader" })

// Default configuration
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_FLUSH_INTERVAL_MS = 30000 // 30 seconds
const MAX_RETRY_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 1000

/**
 * Configuration for the uploader
 */
export interface UploaderConfig {
  endpoint: string
  authToken: string
  batchSize: number
  flushIntervalMs: number
}

/**
 * Telemetry uploader for sending session data to the service
 */
export class TelemetryUploader {
  private config: UploaderConfig
  private pendingTurns: TelemetryTurn[] = []
  private sessionDocId: string | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private isOnline = true
  private offlineQueue: TelemetryTurn[] = []

  constructor(config: Partial<UploaderConfig> & { endpoint: string; authToken: string }) {
    this.config = {
      endpoint: config.endpoint,
      authToken: config.authToken,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    }
  }

  /**
   * Create or update a session on the telemetry service
   */
  async createSession(session: TelemetrySession, initialTurns?: TelemetryTurn[]): Promise<string | null> {
    const request: CreateSessionRequest = {
      session,
      turns: initialTurns,
    }

    try {
      const response = await this.makeRequest<SessionResponse>("POST", "/api/v1/sessions", request)

      if (response) {
        this.sessionDocId = response.id
        log.info("session created", { id: response.id, created: response.created })
        return response.id
      }
    } catch (error) {
      log.error("failed to create session", { error })
    }

    return null
  }

  /**
   * Add a turn to the pending batch
   */
  addTurn(turn: TelemetryTurn): void {
    this.pendingTurns.push(turn)

    // Check if we should flush
    if (this.pendingTurns.length >= this.config.batchSize) {
      this.flush().catch((error) => log.error("flush failed", { error }))
    } else {
      // Start flush timer if not already running
      this.startFlushTimer()
    }
  }

  /**
   * Flush pending turns to the service
   */
  async flush(): Promise<void> {
    this.stopFlushTimer()

    if (this.pendingTurns.length === 0) {
      return
    }

    if (!this.sessionDocId) {
      log.warn("cannot flush turns: no session created")
      return
    }

    if (!this.isOnline) {
      // Queue for later when back online
      this.offlineQueue.push(...this.pendingTurns)
      this.pendingTurns = []
      log.debug("queued turns for offline", { count: this.offlineQueue.length })
      return
    }

    const turnsToSend = [...this.pendingTurns]
    this.pendingTurns = []

    const request: AddTurnsRequest = {
      turns: turnsToSend,
    }

    try {
      await this.makeRequest("POST", `/api/v1/sessions/${this.sessionDocId}/turns`, request)
      log.debug("turns uploaded", { count: turnsToSend.length })
    } catch (error) {
      // Put turns back in queue
      this.pendingTurns = [...turnsToSend, ...this.pendingTurns]
      log.error("failed to upload turns", { error, count: turnsToSend.length })
    }
  }

  /**
   * Update the session (e.g., when it ends)
   */
  async updateSession(updates: Partial<TelemetrySession>): Promise<void> {
    if (!this.sessionDocId) {
      log.warn("cannot update session: no session created")
      return
    }

    try {
      await this.makeRequest("PATCH", `/api/v1/sessions/${this.sessionDocId}`, updates)
      log.debug("session updated", { id: this.sessionDocId })
    } catch (error) {
      log.error("failed to update session", { error })
    }
  }

  /**
   * Graceful shutdown - flush all pending data
   */
  async shutdown(): Promise<void> {
    this.stopFlushTimer()

    // Flush any remaining turns
    if (this.pendingTurns.length > 0) {
      await this.flush()
    }

    // Try to send offline queue
    if (this.offlineQueue.length > 0 && this.isOnline) {
      const offlineTurns = [...this.offlineQueue]
      this.offlineQueue = []
      this.pendingTurns = offlineTurns
      await this.flush()
    }
  }

  /**
   * Set online status
   */
  setOnline(online: boolean): void {
    const wasOffline = !this.isOnline
    this.isOnline = online

    if (online && wasOffline && this.offlineQueue.length > 0) {
      // Try to send queued data
      log.info("back online, flushing offline queue", { count: this.offlineQueue.length })
      const offlineTurns = [...this.offlineQueue]
      this.offlineQueue = []
      this.pendingTurns = [...this.pendingTurns, ...offlineTurns]
      this.flush().catch((error) => log.error("offline flush failed", { error }))
    }
  }

  /**
   * Make an HTTP request with retry logic
   */
  private async makeRequest<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const url = `${this.config.endpoint}${path}`

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.authToken}`,
          },
          body: body ? JSON.stringify(body) : undefined,
        })

        if (response.ok) {
          return (await response.json()) as T
        }

        // Don't retry client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          const error = await response.text()
          log.warn("client error", { status: response.status, error })
          return null
        }

        // Retry server errors (5xx)
        log.warn("server error, retrying", { status: response.status, attempt })
      } catch (error) {
        log.warn("request failed, retrying", { error, attempt })

        // Check if we're offline
        if (error instanceof TypeError && error.message.includes("fetch")) {
          this.setOnline(false)
        }
      }

      // Wait before retry with exponential backoff
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * Math.pow(2, attempt)))
      }
    }

    return null
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return

    this.flushTimer = setTimeout(() => {
      this.flush().catch((error) => log.error("timer flush failed", { error }))
    }, this.config.flushIntervalMs)
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }
}

/**
 * Create a new telemetry uploader
 */
export function createUploader(config: Partial<UploaderConfig> & { endpoint: string; authToken: string }): TelemetryUploader {
  return new TelemetryUploader(config)
}
