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

  // Return a function that creates language models with our custom metadata extractor
  const provider = (modelId: string): LanguageModelV2 => {
    return new OpenAICompatibleChatLanguageModel(modelId, {
      provider: "qbraid.chat",
      headers: () => headers,
      url: ({ path }) => `${baseURL}${path}`,
      fetch: options.fetch,
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
