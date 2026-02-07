#!/usr/bin/env bun
/**
 * Branding Application Script
 *
 * This script applies branding transformations to the opencode codebase.
 * It's designed to work with any future version of opencode by using
 * pattern-based replacements rather than hardcoded line numbers.
 *
 * Usage:
 *   bun branding/apply.ts <brand-id> [--dry-run] [--verbose]
 *
 * Example:
 *   bun branding/apply.ts qbraid
 *   bun branding/apply.ts qbraid --dry-run
 */

import { parseArgs } from "util"
import path from "path"
import fs from "fs/promises"
import { Glob } from "bun"
import { BrandingSchema, type Branding } from "./schema"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
})

if (values.help || positionals.length === 0) {
  console.log(`
Usage: bun branding/apply.ts <brand-id> [options]

Arguments:
  brand-id    The brand configuration to apply (e.g., "qbraid")

Options:
  --dry-run   Preview changes without modifying files
  --verbose   Show detailed output
  --help      Show this help message

Examples:
  bun branding/apply.ts qbraid
  bun branding/apply.ts qbraid --dry-run --verbose
`)
  process.exit(0)
}

const brandId = positionals[0]
const dryRun = values["dry-run"]
const verbose = values.verbose

const ROOT = path.resolve(import.meta.dir, "..")
const BRAND_DIR = path.join(import.meta.dir, brandId)
const BRAND_CONFIG = path.join(BRAND_DIR, "brand.json")

// Statistics
const stats = {
  filesScanned: 0,
  filesModified: 0,
  replacements: 0,
}

function log(msg: string) {
  if (verbose) console.log(msg)
}

function info(msg: string) {
  console.log(`\x1b[36m${msg}\x1b[0m`)
}

function success(msg: string) {
  console.log(`\x1b[32m${msg}\x1b[0m`)
}

function warn(msg: string) {
  console.log(`\x1b[33m${msg}\x1b[0m`)
}

function error(msg: string) {
  console.error(`\x1b[31m${msg}\x1b[0m`)
}

async function loadConfig(): Promise<Branding> {
  const exists = await Bun.file(BRAND_CONFIG).exists()
  if (!exists) {
    error(`Brand configuration not found: ${BRAND_CONFIG}`)
    process.exit(1)
  }

  const json = await Bun.file(BRAND_CONFIG).json()
  const result = BrandingSchema.safeParse(json)

  if (!result.success) {
    error("Invalid brand configuration:")
    console.error(result.error.format())
    process.exit(1)
  }

  return result.data
}

function shouldSkip(filePath: string, skipPatterns: string[]): boolean {
  const relative = path.relative(ROOT, filePath)
  for (const pattern of skipPatterns) {
    const glob = new Glob(pattern)
    if (glob.match(relative)) return true
  }
  return false
}

interface Replacement {
  search: string | RegExp
  replace: string
  description: string
}

function buildReplacements(config: Branding): Replacement[] {
  const r = config.replacements
  const replacements: Replacement[] = []

  // Product name replacements (case-sensitive)
  // Use negative lookbehind/lookahead to avoid matching:
  // - @opencode-ai package names
  // - Directory paths like /opencode/ (but allow /bin/opencode at end of path)
  // - File extensions like opencode.json
  replacements.push({
    search: /(?<!@)(?<!\/opencode)opencode(?!-ai|\/|\.(json|ts|tsx|js))/g,
    replace: r.productName,
    description: `opencode -> ${r.productName}`,
  })

  replacements.push({
    search: /\bOpenCode\b/g,
    replace: r.displayName,
    description: `OpenCode -> ${r.displayName}`,
  })

  replacements.push({
    search: /\bOPENCODE\b/g,
    replace: r.envPrefix,
    description: `OPENCODE -> ${r.envPrefix}`,
  })

  // NPM package name - NOTE: We do NOT rename @opencode-ai/ workspace imports
  // since those are internal package references that need to stay as-is
  // Only rename the published package name in specific contexts
  if (r.npmPackage) {
    // Only rename opencode-ai when NOT preceded by @ (to preserve workspace refs)
    replacements.push({
      search: /(?<!@)opencode-ai(?!\/)/g,
      replace: r.npmPackage,
      description: `opencode-ai -> ${r.npmPackage}`,
    })
  }

  // URL replacements
  if (r.urls?.website) {
    replacements.push({
      search: /https:\/\/opencode\.ai/g,
      replace: r.urls.website,
      description: `opencode.ai -> ${r.urls.website}`,
    })
  }

  if (r.urls?.api) {
    replacements.push({
      search: /https:\/\/api\.opencode\.ai/g,
      replace: r.urls.api,
      description: `api.opencode.ai -> ${r.urls.api}`,
    })
    replacements.push({
      search: /https:\/\/api\.dev\.opencode\.ai/g,
      replace: r.urls.api,
      description: `api.dev.opencode.ai -> ${r.urls.api}`,
    })
  }

  if (r.urls?.github) {
    replacements.push({
      search: /https:\/\/github\.com\/anomalyco\/opencode/g,
      replace: r.urls.github,
      description: `github repo -> ${r.urls.github}`,
    })
  }

  return replacements
}

async function applyReplacements(filePath: string, replacements: Replacement[]): Promise<boolean> {
  const content = await Bun.file(filePath).text()
  let modified = content

  for (const { search, replace, description } of replacements) {
    const before = modified
    modified = modified.replace(search, replace)
    if (before !== modified) {
      log(`  ${description}`)
      stats.replacements++
    }
  }

  if (modified !== content) {
    if (!dryRun) {
      await Bun.write(filePath, modified)
    }
    return true
  }

  return false
}

// File-specific transformations
interface FileTransform {
  pattern: string
  transform: (content: string, config: Branding) => string | Promise<string>
}

const FILE_TRANSFORMS: FileTransform[] = [
  // CLI logo.ts - update the logo export
  {
    pattern: "packages/opencode/src/cli/logo.ts",
    transform: (content, config) => {
      // Replace the logo export with qbraid logo
      const leftStr = config.logo.tui.left.map((l) => `"${l}"`).join(", ")
      const rightStr = config.logo.tui.right.map((l) => `"${l}"`).join(", ")
      
      return `export const logo = {
  left: [${leftStr}],
  right: [${rightStr}],
}

export const marks = "_^~"
`
    },
  },

  // CLI UI logo() function - update to render Q in purple
  {
    pattern: "packages/opencode/src/cli/ui.ts",
    transform: (content, config) => {
      const logoStr = config.logo.cli.map((row) => `    [\`${row[0]}\`, \`${row[1]}\`],`).join("\n")

      // Add LOGO constant and update logo() function to use it with purple Q
      let result = content.replace(
        /import \{ logo as glyphs \} from "\.\/logo"/,
        `import { logo as glyphs } from "./logo"

const LOGO = [
${logoStr}
  ]`
      )

      // Replace the logo() function to use LOGO with purple Q rendering
      result = result.replace(
        /export function logo\(pad\?: string\) \{[\s\S]*?return result\.join\(""\)\.trimEnd\(\)\n  \}/,
        `export function logo(pad?: string) {
    const result: string[] = []
    const reset = "\\x1b[0m"
    const left = {
      fg: Bun.color("gray", "ansi") ?? "",
      shadow: "\\x1b[38;5;235m",
      bg: "\\x1b[48;5;235m",
    }
    const PURPLE = "\\x1b[38;2;147;112;219m"  // Medium purple RGB for Q
    
    for (const row of LOGO) {
      if (pad) result.push(pad)
      result.push(left.fg)
      result.push(row[0])
      result.push(reset)
      result.push(PURPLE)  // Purple for the Q
      result.push(row[1])
      result.push(reset)
      result.push(EOL)
    }
    return result.join("").trimEnd()
  }`
      )

      return result
    },
  },

  // TUI logo component with purple Q
  {
    pattern: "packages/opencode/src/cli/cmd/tui/component/logo.tsx",
    transform: (content, config) => {
      const left = config.logo.tui.left.map((l) => `\`${l}\``).join(", ")
      const right = config.logo.tui.right.map((l) => `\`${l}\``).join(", ")

      let result = content.replace(/const LOGO_LEFT = \[[\s\S]*?\]/, `const LOGO_LEFT = [${left}]`)
      result = result.replace(/const LOGO_RIGHT = \[[\s\S]*?\]/, `const LOGO_RIGHT = [${right}]`)

      // Add RGBA import if not already there, and add purple constant
      result = result.replace(
        /import \{ TextAttributes, RGBA \} from "@opentui\/core"/,
        `import { TextAttributes, RGBA } from "@opentui/core"

// Purple color for the Q (qBraid branding)
const PURPLE = RGBA.fromHex("#9370DB")`,
      )

      // Use purple instead of theme.text for the right side (Q)
      result = result.replace(
        /\{renderLine\(LOGO_RIGHT\[index\(\)\], theme\.text, true\)\}/,
        `{renderLine(LOGO_RIGHT[index()], PURPLE, true)}`,
      )

      return result
    },
  },

  // Global app directory
  {
    pattern: "packages/opencode/src/global/index.ts",
    transform: (content, config) => {
      return content.replace(/const app = "opencode"/, `const app = "${config.replacements.appDir}"`)
    },
  },

  // Package.json binary
  {
    pattern: "packages/opencode/package.json",
    transform: (content, config) => {
      const pkg = JSON.parse(content)
      const bin = config.replacements.binaryName

      // Update binary name
      pkg.bin = { [bin]: `./bin/${bin}` }
      pkg.name = config.replacements.npmPackage || config.replacements.productName

      return JSON.stringify(pkg, null, 2) + "\n"
    },
  },

  // CLI entry point script name
  {
    pattern: "packages/opencode/src/index.ts",
    transform: (content, config) => {
      return content.replace(/\.scriptName\("opencode"\)/, `.scriptName("${config.replacements.binaryName}")`)
    },
  },

  // Model provider configuration (remove Zen, add qBraid)
  // This replaces the entire models.ts to use embedded models
  {
    pattern: "packages/opencode/src/provider/models.ts",
    transform: async (content, config) => {
      if (!config.models?.exclusive || !config.models?.source) return content

      // Read the models JSON
      const modelsPath = path.join(BRAND_DIR, config.models.source.replace("./", ""))
      const modelsFile = Bun.file(modelsPath)
      if (!(await modelsFile.exists())) {
        warn(`Models file not found: ${modelsPath}`)
        return content
      }

      const modelsJson = await modelsFile.json()
      // Remove schema and comment keys
      delete modelsJson.$schema
      delete modelsJson._comment

      // Replace the get() function with one that returns embedded models directly
      return content.replace(
        /export async function get\(\) \{[\s\S]*?\n  \}/,
        `export async function get() {
    // Branding: embedded models (no external fetch)
    return ${JSON.stringify(modelsJson)} as Record<string, Provider>
  }`,
      )
    },
  },

  // Provider loaders - remove opencode provider if requested
  {
    pattern: "packages/opencode/src/provider/provider.ts",
    transform: (content, config) => {
      if (!config.models?.removeProviders?.includes("opencode")) return content

      // Remove the opencode custom loader
      const loaderRegex = /async opencode\(input\) \{[\s\S]*?\n    \},/

      return content.replace(loaderRegex, "// opencode provider removed by branding")
    },
  },

  // Remove builtin plugins (they don't exist for qBraid branding)
  {
    pattern: "packages/opencode/src/plugin/index.ts",
    transform: (content, config) => {
      if (!config.models?.exclusive) return content

      // Clear the BUILTIN array - these npm packages don't exist for branded versions
      // Match the array with its contents across potential newlines
      return content.replace(
        /const BUILTIN = \["[^"]*"(?:,\s*"[^"]*")*\]/,
        "const BUILTIN: string[] = [] // Cleared by branding - no external plugins",
      )
    },
  },

  // Remove custom loaders for providers that don't exist in exclusive models
  {
    pattern: "packages/opencode/src/provider/provider.ts",
    transform: (content, config) => {
      if (!config.models?.exclusive) return content

      // Comment out all custom loaders when in exclusive mode
      // This prevents "Provider does not exist in model list" errors
      // Match the CUSTOM_LOADERS object definition and replace with empty object
      // The object starts at "const CUSTOM_LOADERS: Record<string, CustomLoader> = {"
      // and ends with "  }" before "export const Model"
      return content.replace(
        /const CUSTOM_LOADERS: Record<string, CustomLoader> = \{[\s\S]*?\n  \}(?=\n\n  export const Model)/,
        `const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    // All custom loaders removed by branding (exclusive mode)
  }`,
      )
    },
  },

  // System prompts - update branding and add qBraid description
  {
    pattern: "packages/opencode/src/session/prompt/anthropic.txt",
    transform: (content, config) => {
      return content.replace(
        /You are OpenCode, the best coding agent on the planet\./,
        `You are CodeQ, built by qBraid - the leading quantum software company. You are the universe's most powerful coding agent.`,
      )
    },
  },
  {
    pattern: "packages/opencode/src/session/prompt/anthropic-20250930.txt",
    transform: (content, config) => {
      return content.replace(
        /You are OpenCode, the best coding agent on the planet\./,
        `You are CodeQ, built by qBraid - the leading quantum software company. You are the universe's most powerful coding agent.`,
      )
    },
  },
  {
    pattern: "packages/opencode/src/session/prompt/gemini.txt",
    transform: (content, config) => {
      return content.replace(
        /You are OpenCode, the best coding agent on the planet\./,
        `You are CodeQ, built by qBraid - the leading quantum software company. You are the universe's most powerful coding agent.`,
      )
    },
  },
  {
    pattern: "packages/opencode/src/session/prompt/beast.txt",
    transform: (content, config) => {
      return content.replace(
        /You are OpenCode, the best coding agent on the planet\./,
        `You are CodeQ, built by qBraid - the leading quantum software company. You are the universe's most powerful coding agent.`,
      )
    },
  },
  {
    pattern: "packages/opencode/src/session/prompt/qwen.txt",
    transform: (content, config) => {
      return content.replace(
        /You are OpenCode, the best coding agent on the planet\./,
        `You are CodeQ, built by qBraid - the leading quantum software company. You are the universe's most powerful coding agent.`,
      )
    },
  },
  {
    pattern: "packages/opencode/src/session/prompt/copilot-gpt-5.txt",
    transform: (content, config) => {
      return content.replace(
        /You are OpenCode, the best coding agent on the planet\./,
        `You are CodeQ, built by qBraid - the leading quantum software company. You are the universe's most powerful coding agent.`,
      )
    },
  },
]

async function applyFileTransform(filePath: string, config: Branding): Promise<boolean> {
  const relative = path.relative(ROOT, filePath)
  let content = await Bun.file(filePath).text()
  let anyModified = false

  // Apply ALL matching transforms for this file (not just the first one)
  for (const { pattern, transform } of FILE_TRANSFORMS) {
    if (relative === pattern || relative.endsWith(pattern)) {
      const modified = await transform(content, config)

      if (modified !== content) {
        content = modified
        anyModified = true
        log(`  Applied file transform for pattern: ${pattern}`)
      }
    }
  }

  if (anyModified && !dryRun) {
    await Bun.write(filePath, content)
  }

  return anyModified
}

async function applyCustomPatches(config: Branding): Promise<void> {
  if (!config.patches) return

  for (const [filePath, patches] of Object.entries(config.patches)) {
    const fullPath = path.join(ROOT, filePath)
    const exists = await Bun.file(fullPath).exists()

    if (!exists) {
      warn(`Patch target not found: ${filePath}`)
      continue
    }

    let content = await Bun.file(fullPath).text()
    let modified = false

    for (const patch of patches) {
      const search = patch.regex ? new RegExp(patch.search, "g") : patch.search
      const before = content
      content = content.replace(search, patch.replace)
      if (before !== content) modified = true
    }

    if (modified) {
      if (!dryRun) {
        await Bun.write(fullPath, content)
      }
      info(`Patched: ${filePath}`)
      stats.filesModified++
    }
  }
}

async function renameBinaryFile(config: Branding): Promise<void> {
  const oldBin = path.join(ROOT, "packages/opencode/bin/opencode")
  const newBin = path.join(ROOT, `packages/opencode/bin/${config.replacements.binaryName}`)

  const exists = await Bun.file(oldBin).exists()
  if (!exists) {
    warn(`Binary file not found: ${oldBin}`)
    return
  }

  if (oldBin !== newBin) {
    if (!dryRun) {
      await fs.rename(oldBin, newBin)
    }
    info(`Renamed binary: opencode -> ${config.replacements.binaryName}`)
  }
}

async function createModelsOverride(config: Branding): Promise<void> {
  if (!config.models?.providers) return

  const overridePath = path.join(BRAND_DIR, "models-override.json")

  if (!dryRun) {
    await Bun.write(overridePath, JSON.stringify(config.models.providers, null, 2))
  }

  info(`Created models override: ${path.relative(ROOT, overridePath)}`)
}

async function processDirectory(dir: string, config: Branding, replacements: Replacement[]): Promise<void> {
  const skipPatterns = config.skipFiles || []
  const entries = await fs.readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    // Skip common non-source directories
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", "build", ".turbo", ".next"].includes(entry.name)) {
        continue
      }
      await processDirectory(fullPath, config, replacements)
      continue
    }

    // Only process relevant file types
    const ext = path.extname(entry.name)
    if (![".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".toml", ".sh", ".txt"].includes(ext)) {
      continue
    }

    // Check skip patterns
    if (shouldSkip(fullPath, skipPatterns)) {
      log(`Skipping: ${path.relative(ROOT, fullPath)}`)
      continue
    }

    stats.filesScanned++

    // Apply file-specific transforms first
    let modified = await applyFileTransform(fullPath, config)

    // Then apply general replacements
    const replacementModified = await applyReplacements(fullPath, replacements)

    if (modified || replacementModified) {
      info(`Modified: ${path.relative(ROOT, fullPath)}`)
      stats.filesModified++
    }
  }
}

async function main() {
  info(`\nApplying branding: ${brandId}`)
  if (dryRun) warn("(dry run - no files will be modified)\n")

  const config = await loadConfig()
  const replacements = buildReplacements(config)

  info(`\nProcessing source files...`)
  await processDirectory(path.join(ROOT, "packages"), config, replacements)

  info(`\nApplying custom patches...`)
  await applyCustomPatches(config)

  info(`\nRenaming binary...`)
  await renameBinaryFile(config)

  info(`\nCreating models override...`)
  await createModelsOverride(config)

  success(`
Branding complete!
  Files scanned: ${stats.filesScanned}
  Files modified: ${stats.filesModified}
  Replacements: ${stats.replacements}
${dryRun ? "\n(This was a dry run - run without --dry-run to apply changes)" : ""}
`)

  if (!dryRun) {
    info(`
Next steps:
  1. Review the changes with: git diff
  2. Build the branded version: bun run build
  3. Test the binary: ./packages/opencode/bin/${config.replacements.binaryName}
`)
  }
}

main().catch((e) => {
  error(`Error: ${e.message}`)
  process.exit(1)
})
