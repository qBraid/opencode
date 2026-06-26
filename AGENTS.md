- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- This repo is qBraid's branded fork of upstream `opencode`, referred to internally as **CodeQ**. The GitHub repo is `qBraid/opencode` (`origin`).
- The ONLY permitted interaction with the upstream repo is **pulling changes from it**. NEVER open PRs, push branches, comment, or perform any other write operation against upstream. All PRs and pushes target `origin` (`qBraid/opencode`) only. When using `gh pr create`, always pass `--repo qBraid/opencode` explicitly.
- Branch model: qBraid's own branches are `staging` (pre-prod) and `main` (prod). `dev` is the **upstream-tracking mirror** of `sst/opencode` (whose own default branch is `dev`); it is NOT where qBraid work lands. The GitHub default branch is `main`.
- Where to target: qBraid changes (branding, model surface, features) PR into `staging`, then promote `staging` → `main`. Upstream syncs merge `upstream/dev` → qBraid `dev`, then merge `dev` up into `staging`/`main`. NEVER PR features directly into `main`, and never treat `dev` as an integration branch for qBraid work.
- Branch → CI conventions: pushes to `main` and `staging` trigger the **prod** and **staging** Cloud Build pipelines respectively, which build and upload the `codeq` linux-x64 binary. `dev` has no CI trigger. These triggers are defined in the `qbraid-infrastructure` repo: `opencode-prod-main` watches `^main$` → `gs://qbraid-codeq/latest/linux-x64/codeq` (`terraform/environments/prod/gcp/cloud-build-codeq.tf`); `opencode-staging-branch` watches `^staging$` → `gs://qbraid-codeq-staging/latest/linux-x64/codeq` (`terraform/environments/staging/gcp/cloud-build-codeq.tf`).
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests

## Agent skills

### Issue tracker

Issues live in GitHub Issues on the `qBraid/opencode` fork (via the `gh` CLI, scoped to `--repo qBraid/opencode`). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage roles map 1:1 to default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
