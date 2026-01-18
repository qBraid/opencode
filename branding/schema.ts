/**
 * Branding Configuration Schema
 *
 * This module defines the structure for white-labeling opencode.
 * Create a brand configuration file (e.g., qbraid/brand.json) that
 * conforms to this schema.
 */

import z from "zod"

/**
 * ASCII art logo configuration.
 * The logo is split into left (dimmed) and right (bold) parts.
 * Each part is an array of 4 lines.
 */
export const LogoSchema = z.object({
  /** CLI banner logo (simple format - array of [left, right] tuples) */
  cli: z.array(z.tuple([z.string(), z.string()])),
  /** TUI logo with shadow markers (_, ^, ~) */
  tui: z.object({
    left: z.array(z.string()),
    right: z.array(z.string()),
  }),
})

/**
 * Provider/model configuration for the branded version.
 */
export const ModelsSchema = z.object({
  /** URL or local file path to fetch models from (replaces models.dev) */
  source: z.string().optional(),
  /** Inline model definitions (alternative to source URL) */
  providers: z
    .record(
      z.string(),
      z.object({
        id: z.string(),
        name: z.string(),
        env: z.array(z.string()),
        npm: z.string().optional(),
        api: z.string().optional(),
        models: z.record(z.string(), z.any()),
      }),
    )
    .optional(),
  /** Provider IDs to completely remove */
  removeProviders: z.array(z.string()).optional(),
  /** If true, only use the providers defined in this config */
  exclusive: z.boolean().optional(),
})

/**
 * Text replacements to apply across the codebase.
 */
export const ReplacementsSchema = z.object({
  /** Product name (e.g., "codeq" instead of "opencode") */
  productName: z.string(),
  /** Display name with proper casing (e.g., "CodeQ" instead of "OpenCode") */
  displayName: z.string(),
  /** Package name for npm (e.g., "codeq" instead of "opencode-ai") */
  npmPackage: z.string().optional(),
  /** Binary/command name */
  binaryName: z.string(),
  /** Environment variable prefix (e.g., "CODEQ" instead of "OPENCODE") */
  envPrefix: z.string(),
  /** XDG app directory name */
  appDir: z.string(),
  /** URL replacements */
  urls: z
    .object({
      /** Main website (replaces opencode.ai) */
      website: z.string().url().optional(),
      /** API endpoint (replaces api.opencode.ai) */
      api: z.string().url().optional(),
      /** GitHub repo (replaces github.com/anomalyco/opencode) */
      github: z.string().url().optional(),
    })
    .optional(),
})

/**
 * Complete branding configuration.
 */
export const BrandingSchema = z.object({
  /** Schema version for future compatibility */
  version: z.literal(1),
  /** Brand identifier (e.g., "qbraid") */
  id: z.string(),
  /** Human-readable brand name */
  name: z.string(),
  /** Logo configuration */
  logo: LogoSchema,
  /** Text/name replacements */
  replacements: ReplacementsSchema,
  /** Model/provider configuration */
  models: ModelsSchema.optional(),
  /** Files to skip during branding (glob patterns) */
  skipFiles: z.array(z.string()).optional(),
  /** Additional custom patches (file path -> search/replace pairs) */
  patches: z
    .record(
      z.string(),
      z.array(
        z.object({
          search: z.string(),
          replace: z.string(),
          regex: z.boolean().optional(),
        }),
      ),
    )
    .optional(),
})

export type Branding = z.infer<typeof BrandingSchema>
export type Logo = z.infer<typeof LogoSchema>
export type Models = z.infer<typeof ModelsSchema>
export type Replacements = z.infer<typeof ReplacementsSchema>
