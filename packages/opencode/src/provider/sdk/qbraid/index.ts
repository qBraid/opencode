/**
 * qBraid Provider for OpenCode
 *
 * This provider extends @ai-sdk/openai-compatible with support for
 * Gemini 3 thought signatures in multi-turn function calling.
 */
import { createOpenAICompatible, OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible"
import type { LanguageModelV2 } from "@ai-sdk/provider"
import { type FetchFunction, withoutTrailingSlash } from "@ai-sdk/provider-utils"

export interface QBraidProviderSettings {
  /**
   * API key for authenticating requests.
   */
  apiKey?: string

  /**
   * Base URL for the qBraid API calls.
   * Defaults to https://api.qbraid.com/ai/v1
   */
  baseURL?: string

  /**
   * Custom headers to include in the requests.
   */
  headers?: Record<string, string>

  /**
   * Custom fetch implementation.
   */
  fetch?: FetchFunction
}

// Store for thought signatures keyed by tool call ID
// This allows us to retrieve them when building the next request
const thoughtSignatureStore = new Map<string, string>()

/**
 * Get thought signature for a tool call ID
 */
export function getThoughtSignature(toolCallId: string): string | undefined {
  return thoughtSignatureStore.get(toolCallId)
}

/**
 * Clear thought signatures (call after they've been used)
 */
export function clearThoughtSignatures(): void {
  thoughtSignatureStore.clear()
}

/**
 * Create a metadata extractor that captures _thought_signature from tool calls
 */
function createThoughtSignatureExtractor() {
  return {
    extractMetadata: async ({ parsedBody }: { parsedBody: unknown }) => {
      const body = parsedBody as {
        choices?: Array<{
          message?: {
            tool_calls?: Array<{
              id?: string
              _thought_signature?: string
            }>
          }
        }>
      }

      // Extract thought signatures from tool calls in non-streaming response
      const toolCalls = body?.choices?.[0]?.message?.tool_calls
      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc.id && tc._thought_signature) {
            thoughtSignatureStore.set(tc.id, tc._thought_signature)
          }
        }
      }

      // Return metadata with thought signatures for this response
      const signatures: Record<string, string> = {}
      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc.id && tc._thought_signature) {
            signatures[tc.id] = tc._thought_signature
          }
        }
      }

      if (Object.keys(signatures).length > 0) {
        return {
          qbraid: {
            thoughtSignatures: signatures,
          },
        }
      }

      return undefined
    },

    createStreamExtractor: () => {
      const signatures: Record<string, string> = {}

      return {
        processChunk(parsedChunk: unknown): void {
          const chunk = parsedChunk as {
            choices?: Array<{
              delta?: {
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  _thought_signature?: string
                }>
              }
            }>
          }

          // Extract thought signatures from streaming tool call deltas
          const toolCalls = chunk?.choices?.[0]?.delta?.tool_calls
          if (toolCalls) {
            for (const tc of toolCalls) {
              if (tc.id && tc._thought_signature) {
                signatures[tc.id] = tc._thought_signature
                thoughtSignatureStore.set(tc.id, tc._thought_signature)
              }
            }
          }
        },

        buildMetadata() {
          if (Object.keys(signatures).length > 0) {
            return {
              qbraid: {
                thoughtSignatures: signatures,
              },
            }
          }
          return undefined
        },
      }
    },
  }
}

// -----------------------------------------------------------------------------
// IAP identity-token injection (qBraid staging)
// -----------------------------------------------------------------------------
// In qBraid staging, the AI Proxy (account-v2-staging.qbraid.com/api/ai/v1) sits
// behind Google Identity-Aware Proxy. CodeQ runs in a Lab user pod with Workload
// Identity, so it can mint a Google-signed ID token for the IAP client from the
// GKE metadata server and present it to pass IAP.
//
// Activation is gated entirely on the IAP_CLIENT_ID env var: staging user pods
// set it, prod pods and developer machines do not, so this code is inert
// everywhere IAP is not in play. When the var IS set but a token cannot be
// obtained, we fail fast with a descriptive error — without the token the
// request is doomed anyway, and IAP's alternative (a 302 to a Google login page)
// is far harder to diagnose through the OpenAI-compatible client.

// Reach the metadata server by its link-local IP, not the
// metadata.google.internal hostname. In GKE pods, resolv.conf sets ndots:5 with
// a long search list, and Bun's DNS resolver (unlike glibc, which curl and Node
// use) stalls resolving the hostname through that search-domain expansion — so
// the hostname form times out under Bun even though curl/Node resolve it in
// milliseconds. The IP is the canonical, DNS-free GCE metadata address. Honor
// GCE_METADATA_HOST (host[:port]) as an override, matching the Google
// auth-library convention.
const IAP_METADATA_HOST = process.env["GCE_METADATA_HOST"]?.trim() || "169.254.169.254"
const IAP_METADATA_IDENTITY_URL = `http://${IAP_METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/identity`
const IAP_METADATA_TIMEOUT_MS = 5_000
const IAP_METADATA_ATTEMPTS = 2
// Refresh this far ahead of the token's exp so in-flight requests never carry an
// almost-expired token (IAP ID tokens live ~1 hour).
const IAP_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

export type IapTokenFetcher = (audience: string) => Promise<string>

/**
 * Fetch a Google-signed ID token for `audience` (the IAP OAuth client ID) from
 * the GKE metadata server. Retries briefly to ride out transient blips, then
 * throws a descriptive error. `fetchImpl` is injectable for testing.
 */
export async function fetchIapIdentityToken(audience: string, fetchImpl: FetchFunction = fetch): Promise<string> {
  const url = `${IAP_METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`
  let lastError: unknown
  for (let attempt = 1; attempt <= IAP_METADATA_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), IAP_METADATA_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`metadata server returned HTTP ${response.status}`)
      const token = (await response.text()).trim()
      if (!token) throw new Error("metadata server returned an empty token")
      return token
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(
    `qBraid IAP: could not obtain an identity token from the GKE metadata server for audience ` +
      `${audience} after ${IAP_METADATA_ATTEMPTS} attempts: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  )
}

/** Read the `exp` claim (ms since epoch) from a JWT, or undefined if unreadable. */
function jwtExpiryMs(token: string): number | undefined {
  const segment = token.split(".")[1]
  if (!segment) return undefined
  try {
    const claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { exp?: number }
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a cached, single-flight identity-token provider for one audience:
 * reuses a token until ~5 min before its exp, and collapses concurrent refreshes
 * into one metadata call. Exported so tests can drive it with a stub fetcher.
 */
export function createIapTokenProvider(audience: string, fetchToken: IapTokenFetcher): () => Promise<string> {
  let cached: { token: string; refreshAt: number } | undefined
  let pending: Promise<string> | undefined
  return () => {
    if (cached && Date.now() < cached.refreshAt) return Promise.resolve(cached.token)
    if (!pending) {
      pending = fetchToken(audience)
        .then((token) => {
          const expiry = jwtExpiryMs(token)
          const refreshAt = expiry ? expiry - IAP_TOKEN_REFRESH_SKEW_MS : Date.now() + 30 * 60 * 1000
          cached = { token, refreshAt }
          return token
        })
        .finally(() => {
          // Clear on success and failure so the next request retries the fetch.
          pending = undefined
        })
    }
    return pending
  }
}

// One shared provider per audience for the whole process.
const iapTokenProviders = new Map<string, () => Promise<string>>()

function iapTokenProviderFor(audience: string): () => Promise<string> {
  let provider = iapTokenProviders.get(audience)
  if (!provider) {
    provider = createIapTokenProvider(audience, (aud) => fetchIapIdentityToken(aud))
    iapTokenProviders.set(audience, provider)
  }
  return provider
}

/**
 * Wrap a fetch so every request carries a fresh IAP identity token in
 * `Proxy-Authorization`. The qBraid access token already occupies
 * `Authorization`; IAP reads its own credential from `Proxy-Authorization` and
 * strips it before forwarding upstream, so the two never collide.
 */
export function createIapFetch(getToken: () => Promise<string>, baseFetch: FetchFunction = fetch): FetchFunction {
  const wrapped = async (
    input: Parameters<FetchFunction>[0],
    init?: Parameters<FetchFunction>[1],
  ): Promise<Response> => {
    const token = await getToken()
    const headers = new Headers(init?.headers)
    headers.set("Proxy-Authorization", `Bearer ${token}`)
    return baseFetch(input, { ...init, headers })
  }
  // FetchFunction resolves to `typeof fetch` (which carries a `preconnect`
  // property) under Bun's lib types; the wrapper is only ever invoked as a
  // plain fetch, so the cast is safe.
  return wrapped as FetchFunction
}

/**
 * Create a qBraid provider instance.
 *
 * This provider uses @ai-sdk/openai-compatible but adds a custom metadata extractor
 * to capture Gemini 3 thought signatures from tool calls.
 */
export function createQBraid(options: QBraidProviderSettings = {}): (modelId: string) => LanguageModelV2 {
  const baseURL = withoutTrailingSlash(options.baseURL ?? "https://api.qbraid.com/ai/v1")

  const headers = {
    ...(options.apiKey && { Authorization: `Bearer ${options.apiKey}` }),
    ...options.headers,
  }

  const metadataExtractor = createThoughtSignatureExtractor()

  // Inject IAP credentials only when IAP_CLIENT_ID is present (qBraid staging
  // pods). Elsewhere this is a no-op and the provider behaves exactly as before.
  const iapClientId = process.env["IAP_CLIENT_ID"]?.trim()
  const requestFetch: FetchFunction | undefined = iapClientId
    ? createIapFetch(iapTokenProviderFor(iapClientId), options.fetch ?? fetch)
    : options.fetch

  // Return a function that creates language models with our custom metadata extractor
  const provider = (modelId: string): LanguageModelV2 => {
    return new OpenAICompatibleChatLanguageModel(modelId, {
      provider: "qbraid.chat",
      headers: () => headers,
      url: ({ path }) => `${baseURL}${path}`,
      fetch: requestFetch,
      metadataExtractor,
    })
  }

  // Add commonly expected methods for compatibility
  ;(provider as any).languageModel = provider
  ;(provider as any).chat = provider
  ;(provider as any).chatModel = provider

  return provider
}

export default createQBraid
