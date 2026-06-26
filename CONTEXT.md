# CodeQ

qBraid's branded fork of upstream `opencode` (`sst/opencode`), distributed as the `codeq` binary. Branding is applied at build time so the fork stays mergeable with upstream. This context covers how the fork tracks upstream and how its AI model surface is defined.

## Language

**CodeQ**:
qBraid's branded build of opencode. Same codebase; the `codeq` binary, `CODEQ_*` env vars, and `~/.config/codeq/` paths are produced by the brander.
_Avoid_: "the fork" (ambiguous), "opencode" (means upstream)

**Upstream**:
`sst/opencode`, the project CodeQ is forked from. The ONLY permitted interaction is pulling changes in — never pushing, PRing, or commenting.
_Avoid_: "origin" (that's `qBraid/opencode`)

**Origin**:
The `qBraid/opencode` GitHub repo. GitHub default branch is `main`; qBraid work targets `staging` (see Release model). All CodeQ PRs/pushes target origin.

**Brander**:
`branding/apply.ts` — applies a brand's `brand.json` + `models.json` to the upstream tree at build time via string-replacement transforms. Sensitive to upstream drift.
_Avoid_: "branding script", "white-label tool"

**Exclusive mode**:
Brand setting (`models.exclusive: true`) that strips models.dev and all non-brand providers, leaving only the qBraid provider's models compiled into the binary.

**qBraid provider**:
The single AI provider exposed in a CodeQ build (`id: "qbraid"`). Its models are defined in `branding/qbraid/models.json`, not fetched from models.dev.

**Model surface**:
The canonical set of models CodeQ advertises. As of this work: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`, `gemini-3.5-flash`, `gemini-3.1-pro`. Grok is intentionally dropped.
_Avoid_: "model list" when precision matters

**codeqModelId**:
The `qbraid/<id>` string a CodeQ client sends. The gateway maps it (via alias tables) to an internal provider model. Source of truth for the mapping lives in qbraid-api / qbraid-account, not in CodeQ.

**The gateway**:
The AI endpoint CodeQ talks to: `https://account-v2.qbraid.com/api/ai/v1` (the qbraid-**account** service). qbraid-api is kept in lockstep with it but is a separate service.
_Avoid_: confusing `account-v2.qbraid.com` (real model endpoint) with `api.qbraid.com` (appears only in stale config)

**Release model**:
qBraid work targets `staging` (pre-prod) and is promoted to `main` (prod); each push triggers a `codeq` binary build (`opencode-staging-branch` → staging bucket, `opencode-prod-main` → prod bucket). `dev` is the upstream-tracking mirror of `sst/opencode` and has no CI trigger; upstream syncs land on `dev` then merge up into `staging`/`main`. GitHub default branch is `main`.
_Avoid_: treating `dev` as a qBraid integration branch, or PRing features into `main` directly (features → `staging` → `main`)

## Relationships

- **CodeQ** is built from **Upstream** + a brand applied by the **Brander**.
- A model/surface change merges to `dev`, then becomes a testable artifact only once promoted to `staging` (the gated publish step).
- A CodeQ build in **Exclusive mode** exposes only the **qBraid provider**, whose **Model surface** is hand-defined in `models.json`.
- A client sends a **codeqModelId**; **The gateway** resolves it to an internal model. CodeQ's model surface must stay in sync with what the gateway can resolve.

## Flagged ambiguities

- "qbraid-api" vs "the gateway": the user refers to qbraid-api as the source of truth, but CodeQ's live endpoint is qbraid-**account** (`account-v2.qbraid.com`). The two are kept in lockstep (qbraid-account PR #431 / qbraid-api `feat/ai-gateway-rebuild`); for model-surface purposes they define the same set.
