/**
 * Telemetry Consent
 *
 * Manages user consent for telemetry based on tier, local preferences, and
 * the remote consent service. Defaults to OFF unless explicitly enabled by
 * the user through the first-run dialog or config.
 */

import { Log } from "../util/log"
import { Config } from "../config/config"
import { Flag } from "../flag/flag"
import type { ConsentStatus, DataLevel, UserTier } from "./types"

const log = Log.create({ service: "telemetry:consent" })

const DEFAULT_TELEMETRY_ENDPOINT = "https://qbraid-telemetry-314301605548.us-central1.run.app"

let cachedConsent: ConsentStatus | null = null
let cacheExpiry: number = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function getTelemetryEndpoint(): string {
  return DEFAULT_TELEMETRY_ENDPOINT
}

async function fetchConsentFromService(
  endpoint: string,
  authToken: string,
): Promise<ConsentStatus | null> {
  try {
    const response = await fetch(`${endpoint}/api/v1/consent`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      log.warn("failed to fetch consent status", { status: response.status })
      return null
    }

    return (await response.json()) as ConsentStatus
  } catch (error) {
    log.error("error fetching consent status", { error })
    return null
  }
}

/**
 * Local consent value read from the KV store file.
 * Set by the first-run dialog or the `Telemetry.setLocalConsent()` API.
 * `null` means no local decision has been recorded yet.
 */
let localConsent: boolean | null = null

/**
 * Set the local consent value (called by the TUI consent dialog).
 */
export function setLocalConsent(enabled: boolean): void {
  localConsent = enabled
}

/**
 * Load local consent from the KV store file if available.
 * This is called once during initialization.
 */
export function loadLocalConsent(value: boolean | null): void {
  localConsent = value
}

/**
 * Get the current consent status.
 *
 * Priority order:
 * 1. CODEQ_DISABLE_TELEMETRY env var — always wins
 * 2. Config `qbraid.telemetry.enabled` — explicit config override
 * 3. Remote consent service (for authenticated users)
 * 4. Local consent from first-run dialog (KV store)
 * 5. Default: OFF (telemetry is opt-in until the user makes a choice)
 */
export async function getConsentStatus(authToken?: string): Promise<ConsentStatus> {
  const config = await Config.get()
  const qbraidConfig = config.qbraid?.telemetry
  const userId = "unknown"

  // 1. Env var kill switch
  if (Flag.CODEQ_DISABLE_TELEMETRY) {
    return { userId, tier: "standard", telemetryEnabled: false, dataLevel: "metrics-only" }
  }

  // 2. Explicit config override
  if (qbraidConfig?.enabled === false) {
    return { userId, tier: "standard", telemetryEnabled: false, dataLevel: "metrics-only" }
  }

  if (qbraidConfig?.enabled === true) {
    return {
      userId,
      tier: "standard",
      telemetryEnabled: true,
      dataLevel: qbraidConfig.dataLevel ?? "full",
    }
  }

  // 3. Remote consent service (authenticated users)
  if (authToken) {
    if (cachedConsent && Date.now() < cacheExpiry) return cachedConsent

    const endpoint = qbraidConfig?.endpoint ?? getTelemetryEndpoint()
    const serviceConsent = await fetchConsentFromService(endpoint, authToken)

    if (serviceConsent) {
      if (qbraidConfig?.dataLevel) serviceConsent.dataLevel = qbraidConfig.dataLevel

      cachedConsent = serviceConsent
      cacheExpiry = Date.now() + CACHE_TTL_MS
      return serviceConsent
    }
  }

  // 4. Local consent from first-run dialog
  if (localConsent !== null) {
    return {
      userId,
      tier: "free",
      telemetryEnabled: localConsent,
      dataLevel: qbraidConfig?.dataLevel ?? "full",
    }
  }

  // 5. Default: OFF until user makes a choice
  return { userId, tier: "free", telemetryEnabled: false, dataLevel: "metrics-only" }
}

export async function isTelemetryEnabled(authToken?: string): Promise<boolean> {
  const consent = await getConsentStatus(authToken)
  return consent.telemetryEnabled
}

export async function getDataLevel(authToken?: string): Promise<DataLevel> {
  const consent = await getConsentStatus(authToken)
  return consent.dataLevel
}

export function clearConsentCache(): void {
  cachedConsent = null
  cacheExpiry = 0
}
