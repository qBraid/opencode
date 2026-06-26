#!/usr/bin/env bun

// Emit a standalone production package.json for the shipped CodeQ CLI
// (packages/opencode) so the Cloud Build security gate scans ONLY the binary's
// dependency closure instead of the entire monorepo (web/console/desktop/test
// deps that never ship in the `codeq` binary).
//
// Consumed by the qbraid-infrastructure triggers opencode-staging-branch /
// opencode-prod-main: the `prepare-cli-scan` step pipes this to
// /workspace/.cli-scan/package.json, runs `bun install --lockfile-only` to
// resolve the transitive closure, and Trivy scans the resulting bun.lock.
//
//   - `catalog:` refs are resolved against the root workspace catalog.
//   - root `overrides` are propagated so pinned transitive fixes are honored.
//   - first-party `workspace:*` deps are dropped: they declare no external
//     production dependencies, so they add no scannable surface.
//
// Output: package.json (JSON) on stdout.

import { join } from "path"

const repo = join(import.meta.dir, "..")
const root = await Bun.file(join(repo, "package.json")).json()
const cli = await Bun.file(join(repo, "packages/opencode/package.json")).json()

const catalog: Record<string, string> = root.workspaces?.catalog ?? {}
const overrides: Record<string, string> = root.overrides ?? {}

const dependencies: Record<string, string> = {}
for (const [name, spec] of Object.entries(cli.dependencies ?? {})) {
  if (typeof spec !== "string") continue
  if (spec.startsWith("workspace:")) continue
  const resolved = spec === "catalog:" ? catalog[name] : spec
  if (!resolved) {
    console.error(`cli-scan-manifest: no catalog entry for "${name}" — skipping`)
    continue
  }
  dependencies[name] = resolved
}

const resolvedOverrides: Record<string, string> = {}
for (const [name, spec] of Object.entries(overrides)) {
  resolvedOverrides[name] = spec === "catalog:" ? (catalog[name] ?? spec) : spec
}

process.stdout.write(
  JSON.stringify(
    {
      name: "codeq-cli-scan",
      version: "0.0.0",
      private: true,
      dependencies,
      overrides: resolvedOverrides,
    },
    null,
    2,
  ) + "\n",
)
