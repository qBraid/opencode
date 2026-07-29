import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { QBRAID_BASE_URL } from "@/provider/qbraid-models"

/**
 * Built-in qBraid auth plugin.
 *
 * Enables `opencode auth login` -> "qBraid" -> paste API token.
 * The token is a qBraid access token (qbr-at_...) or API key, stored as a
 * standard API credential and sent to the qBraid AI proxy as a Bearer token
 * by the qBraid provider SDK.
 */
export async function QBraidAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "qbraid",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "api") return {}
        return {
          apiKey: info.key,
          baseURL: QBRAID_BASE_URL,
        }
      },
      methods: [
        {
          type: "api",
          label: "qBraid API Key",
          prompts: [
            {
              type: "text",
              key: "key",
              message: "Enter your qBraid API token",
              placeholder: "qbr-at_...",
              validate: (value) => {
                if (!value) return "API token is required"
                if (!value.startsWith("qbr-at_") && !value.startsWith("qbr_"))
                  return "Expected a qBraid token (qbr-at_... or qbr_...)"
                return undefined
              },
            },
          ],
          async authorize(inputs = {}) {
            const key = inputs.key
            if (!key) return { type: "failed" as const }
            return {
              type: "success" as const,
              key,
              provider: "qbraid",
            }
          },
        },
      ],
    },
  }
}
