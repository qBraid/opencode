# OpenCode Branding System

White-label opencode for your organization. This system applies branding transformations at build time, making it maintainable across opencode updates.

## Quick Start

```bash
# Preview changes
bun branding/apply.ts qbraid --dry-run

# Apply branding
bun branding/apply.ts qbraid

# Build
cd packages/opencode && bun run build

# Test
./dist/codeq-darwin-arm64/bin/codeq --help
```

## What Gets Branded

| Component | Original                   | Branded (qBraid)        |
| --------- | -------------------------- | ----------------------- |
| Binary    | `opencode`                 | `codeq`                 |
| CLI Logo  | "open code"                | "code q" (purple Q)     |
| Env Vars  | `OPENCODE_*`               | `CODEQ_*`               |
| App Dir   | `~/.local/share/opencode/` | `~/.local/share/codeq/` |
| Models    | models.dev + all providers | qBraid provider only    |

## Directory Structure

```
branding/
├── apply.ts              # Branding script
├── schema.ts             # Configuration schema
├── README.md
└── qbraid/
    ├── brand.json        # Brand configuration
    └── models.json       # Custom model definitions
```

## Creating a New Brand

1. Create directory: `mkdir branding/mybrand`

2. Create `brand.json`:

```json
{
  "version": 1,
  "id": "mybrand",
  "name": "My Brand",
  "logo": {
    "cli": [
      ["left1", "right1"],
      ["left2", "right2"],
      ["left3", "right3"],
      ["left4", "right4"]
    ],
    "tui": {
      "left": ["row1", "row2", "row3", "row4"],
      "right": ["row1", "row2", "row3", "row4"]
    }
  },
  "replacements": {
    "productName": "mybrand",
    "displayName": "MyBrand",
    "binaryName": "mybrand",
    "envPrefix": "MYBRAND",
    "appDir": "mybrand"
  },
  "models": {
    "exclusive": true,
    "source": "./models.json"
  }
}
```

3. Create `models.json` with your providers (see `qbraid/models.json` for format)

4. Apply: `bun branding/apply.ts mybrand`

## Updating to New OpenCode Versions

```bash
# 1. Pull latest
git fetch upstream && git merge upstream/dev

# 2. Re-apply branding
bun branding/apply.ts qbraid

# 3. Fix any conflicts, build and test
cd packages/opencode && bun run build
./dist/codeq-darwin-arm64/bin/codeq --version
```

## Safe Testing Workflow

Use a git worktree to test without affecting your main checkout:

```bash
git worktree add ../opencode-brand-test HEAD
cp -r branding ../opencode-brand-test/
cd ../opencode-brand-test
bun install
bun branding/apply.ts qbraid
cd packages/opencode && bun run build --single
./dist/codeq-darwin-arm64/bin/codeq --help

# Cleanup
cd ../opencode && git worktree remove ../opencode-brand-test
```

## Configuration Reference

### `brand.json`

| Field                      | Required | Description                                  |
| -------------------------- | -------- | -------------------------------------------- |
| `version`                  | Yes      | Schema version (must be `1`)                 |
| `id`                       | Yes      | Brand identifier                             |
| `name`                     | Yes      | Display name                                 |
| `logo.cli`                 | Yes      | CLI banner (4 rows of [left, right] tuples)  |
| `logo.tui`                 | Yes      | TUI logo with shadow markers (`_`, `^`, `~`) |
| `replacements.productName` | Yes      | Lowercase name for code                      |
| `replacements.displayName` | Yes      | Proper-cased name for UI                     |
| `replacements.binaryName`  | Yes      | CLI command name                             |
| `replacements.envPrefix`   | Yes      | Environment variable prefix                  |
| `replacements.appDir`      | Yes      | XDG directory name                           |
| `models.exclusive`         | No       | If true, only use defined providers          |
| `models.source`            | No       | Path to models.json                          |
| `skipFiles`                | No       | Glob patterns to skip                        |
| `patches`                  | No       | Custom file patches                          |

### `models.json`

```json
{
  "provider-id": {
    "id": "provider-id",
    "name": "Provider Name",
    "env": ["API_KEY_VAR"],
    "npm": "@ai-sdk/provider",
    "api": "https://api.example.com/v1",
    "models": {
      "model-id": {
        "id": "model-id",
        "name": "Model Name",
        "family": "model-family",
        "release_date": "2025-01-01",
        "attachment": true,
        "reasoning": true,
        "temperature": true,
        "tool_call": true,
        "cost": { "input": 3, "output": 15 },
        "limit": { "context": 200000, "output": 16000 },
        "options": {}
      }
    }
  }
}
```

## Troubleshooting

**"oldString not found"**: Upstream code changed. Update the transform in `apply.ts`.

**Models not showing**: Models only appear when their provider has credentials set (e.g., `QBRAID_API_KEY`).

**Build fails**: Check that `@opencode-ai/*` workspace imports weren't accidentally renamed.
