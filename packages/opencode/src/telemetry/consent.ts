/**
 * Telemetry Consent
 *
 * Manages user consent for telemetry collection based on tier and preferences.
 */

import { Log } from "../util/log"
import { Config } from "../config/config"
import type { ConsentStatus, DataLevel, UserTier } from "./types"

const log = Log.create({ service: "telemetry:consent" })

// Default telemetry endpoint
const DEFAULT_TELEMETRY_ENDPOINT = "https://qbraid-telemetry-314301605548.us-central1.run.app"

// Cache consent status to avoid repeated API calls
let cachedConsent: ConsentStatus | null = null
let cacheExpiry: number = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Get the telemetry endpoint from config or default
 */
export function getTelemetryEndpoint(): string {
  // This will be called after config is loaded
  return DEFAULT_TELEMETRY_ENDPOINT
}

/**
 * Fetch consent status from the telemetry service
 */
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

    const data = (await response.json()) as ConsentStatus
    return data
  } catch (error) {
    log.error("error fetching consent status", { error })
    return null
  }
}

/**
 * Get the default consent based on config settings
 */
function getDefaultConsent(config: Config.Info, userId: string): ConsentStatus {
  const qbraidConfig = config.qbraid?.telemetry

  // Default tier assumption for local config
  const tier: UserTier = "free"

  // Determine if telemetry is enabled
  let telemetryEnabled: boolean
  if (qbraidConfig?.enabled === true) {
    telemetryEnabled = true
  } else if (qbraidConfig?.enabled === false) {
    telemetryEnabled = false
  } else {
    // "tier-default" or undefined - use tier-based defaults
    telemetryEnabled = tier === "free" // Only enabled by default for free tier
  }

  // Determine data level
  const dataLevel: DataLevel = qbraidConfig?.dataLevel ?? "full"

  return {
    userId,
    tier,
    telemetryEnabled,
    dataLevel,
  }
}

/**
 * Get the current consent status for the user
 *
 * This checks:
 * 1. Local config overrides (qbraid.telemetry.enabled)
 * 2. Cached consent from service
 * 3. Fresh consent from telemetry service
 * 4. Falls back to tier-based defaults
 */
export async function getConsentStatus(authToken?: string): Promise<ConsentStatus> {
  const config = await Config.get()
  const qbraidConfig = config.qbraid?.telemetry

  // Get user ID from somewhere (placeholder - needs integration with qBraid auth)
  const userId = "unknown"

  // If config explicitly disables telemetry, respect that
  if (qbraidConfig?.enabled === false) {
    log.debug("telemetry disabled by config")
    return {
      userId,
      tier: "standard", // Assume paid tier if they can configure
      telemetryEnabled: false,
      dataLevel: "metrics-only",
    }
  }

  // Try to get from service if we have an auth token
  if (authToken) {
    // Check cache first
    if (cachedConsent && Date.now() < cacheExpiry) {
      return cachedConsent
    }

    // Fetch from service
    const endpoint = qbraidConfig?.endpoint ?? getTelemetryEndpoint()
    const serviceConsent = await fetchConsentFromService(endpoint, authToken)

    if (serviceConsent) {
      // Apply local config overrides
      if (qbraidConfig?.enabled === true) {
        serviceConsent.telemetryEnabled = true
      }
      if (qbraidConfig?.dataLevel) {
        serviceConsent.dataLevel = qbraidConfig.dataLevel
      }

      // Cache the result
      cachedConsent = serviceConsent
      cacheExpiry = Date.now() + CACHE_TTL_MS

      return serviceConsent
    }
  }

  // Fall back to config-based defaults
  return getDefaultConsent(config, userId)
}

/**
 * Check if telemetry is currently enabled
 */
export async function isTelemetryEnabled(authToken?: string): Promise<boolean> {
  const consent = await getConsentStatus(authToken)
  return consent.telemetryEnabled
}

/**
 * Get the data collection level
 */
export async function getDataLevel(authToken?: string): Promise<DataLevel> {
  const consent = await getConsentStatus(authToken)
  return consent.dataLevel
}

/**
 * Clear the consent cache (useful for testing or when user changes settings)
 */
export function clearConsentCache(): void {
  cachedConsent = null
  cacheExpiry = 0
}
