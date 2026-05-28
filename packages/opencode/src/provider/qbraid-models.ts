import type { ModelsDev } from "./models"

/**
 * Built-in qBraid provider definition.
 *
 * This is the single source of truth for the models qBraid (CodeQ) exposes
 * through opencode. It is injected directly into the models database so the
 * `qbraid` provider is first-class and does not depend on an external
 * models.dev catalog being reachable at build/run time.
 *
 * Model IDs here are the bare names the qBraid AI proxy understands (it
 * resolves aliases like `claude-sonnet-4-6` server-side). The provider
 * namespace (`qbraid`) is applied by opencode, so the model picker shows
 * them as e.g. `qbraid/claude-sonnet-4-6`.
 *
 * Pricing mirrors qbraid-api MODEL_PRICING (USD per 1M tokens). Keep in sync.
 */
export const QBRAID_BASE_URL = "https://account.qbraid.com/api/ai/v1"

const TEXT_IN_OUT = {
  input: ["text", "image"] as ("text" | "audio" | "image" | "video" | "pdf")[],
  output: ["text"] as ("text" | "audio" | "image" | "video" | "pdf")[],
}

function model(
  id: string,
  name: string,
  opts: {
    input: number
    output: number
    context: number
    maxOutput: number
    reasoning: boolean
    release_date: string
    modalities?: { input: ("text" | "audio" | "image" | "video" | "pdf")[]; output: ("text" | "audio" | "image" | "video" | "pdf")[] }
  },
): ModelsDev.Model {
  return {
    id,
    name,
    release_date: opts.release_date,
    attachment: true,
    reasoning: opts.reasoning,
    temperature: true,
    tool_call: true,
    cost: { input: opts.input, output: opts.output },
    limit: { context: opts.context, output: opts.maxOutput },
    modalities: opts.modalities ?? TEXT_IN_OUT,
    options: {},
  }
}

export const QBRAID_MODELS_DEV: ModelsDev.Provider = {
  id: "qbraid",
  name: "qBraid",
  api: QBRAID_BASE_URL,
  npm: "@ai-sdk/qbraid",
  env: ["QBRAID_API_KEY"],
  models: {
    "claude-haiku-4-5": model("claude-haiku-4-5", "Claude 4.5 Haiku", {
      input: 1.0,
      output: 5.0,
      context: 200_000,
      maxOutput: 64_000,
      reasoning: true,
      release_date: "2025-10-01",
    }),
    "claude-sonnet-4-6": model("claude-sonnet-4-6", "Claude 4.6 Sonnet", {
      input: 3.0,
      output: 15.0,
      context: 1_000_000,
      maxOutput: 64_000,
      reasoning: true,
      release_date: "2026-01-01",
    }),
    "claude-opus-4-8": model("claude-opus-4-8", "Claude Opus 4.8", {
      input: 5.0,
      output: 25.0,
      context: 1_000_000,
      maxOutput: 128_000,
      reasoning: true,
      release_date: "2026-01-01",
    }),
    "gemini-3.5-flash": model("gemini-3.5-flash", "Gemini 3.5 Flash", {
      input: 0.5,
      output: 3.0,
      context: 1_048_576,
      maxOutput: 65_535,
      reasoning: true,
      release_date: "2026-05-19",
      modalities: {
        input: ["text", "image", "audio", "video", "pdf"],
        output: ["text"],
      },
    }),
    "gemini-3.1-pro": model("gemini-3.1-pro", "Gemini 3.1 Pro", {
      input: 2.0,
      output: 12.0,
      context: 1_048_576,
      maxOutput: 65_536,
      reasoning: true,
      release_date: "2026-01-01",
      modalities: {
        input: ["text", "image", "audio", "video", "pdf"],
        output: ["text"],
      },
    }),
  },
}
