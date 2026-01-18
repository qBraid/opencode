#!/usr/bin/env bun
/**
 * qBraid Model Generator
 *
 * This script helps generate the models.json configuration for qBraid.
 * It can be run to update the available models based on qBraid's API.
 *
 * Usage:
 *   bun branding/qbraid/generate-models.ts [--output models.json]
 */

import { parseArgs } from "util"
import path from "path"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o", default: "models.json" },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun branding/qbraid/generate-models.ts [options]

Options:
  --output, -o  Output file path (default: models.json)
  --help, -h    Show this help message

This script generates the models.json configuration for qBraid CodeQ.
It defines the AI models available through qBraid's platform.
`)
  process.exit(0)
}

// Default model configuration for qBraid
// This can be extended to fetch from qBraid's API in the future
const models = {
  qbraid: {
    id: "qbraid",
    name: "qBraid",
    env: ["QBRAID_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.qbraid.com/ai/v1",
    models: {
      "claude-sonnet-4": {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        family: "claude",
        release_date: "2025-05-22",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
        limit: {
          context: 200000,
          output: 16000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        options: {},
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        family: "claude",
        release_date: "2025-05-22",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 0.8,
          output: 4,
          cache_read: 0.08,
          cache_write: 1,
        },
        limit: {
          context: 200000,
          output: 8192,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        options: {},
      },
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
        release_date: "2024-05-13",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 10,
          cache_read: 1.25,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        options: {},
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        family: "gpt",
        release_date: "2024-07-18",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 0.15,
          output: 0.6,
          cache_read: 0.075,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        options: {},
      },
    },
  },
  // Include standard providers that users can configure with their own API keys
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com",
    models: {
      "claude-sonnet-4-20250514": {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        family: "claude",
        release_date: "2025-05-14",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        interleaved: true,
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
        },
        limit: {
          context: 200000,
          output: 16000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        options: {},
      },
      "claude-haiku-4-5-20250514": {
        id: "claude-haiku-4-5-20250514",
        name: "Claude Haiku 4.5",
        family: "claude",
        release_date: "2025-05-14",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 0.8,
          output: 4,
          cache_read: 0.08,
          cache_write: 1,
        },
        limit: {
          context: 200000,
          output: 8192,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        options: {},
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt",
        release_date: "2024-05-13",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 10,
          cache_read: 1.25,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        options: {},
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        family: "gpt",
        release_date: "2024-07-18",
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 0.15,
          output: 0.6,
          cache_read: 0.075,
        },
        limit: {
          context: 128000,
          output: 16384,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        options: {},
      },
      o1: {
        id: "o1",
        name: "o1",
        family: "o1",
        release_date: "2024-12-17",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 15,
          output: 60,
          cache_read: 7.5,
        },
        limit: {
          context: 200000,
          output: 100000,
        },
        modalities: {
          input: ["text", "image"],
          output: ["text"],
        },
        options: {},
      },
    },
  },
}

const outputPath = path.resolve(import.meta.dir, values.output)
await Bun.write(outputPath, JSON.stringify(models, null, 2))

console.log(`Generated models configuration: ${outputPath}`)
console.log(`
Providers configured:
  - qbraid (${Object.keys(models.qbraid.models).length} models)
  - anthropic (${Object.keys(models.anthropic.models).length} models)
  - openai (${Object.keys(models.openai.models).length} models)
`)
