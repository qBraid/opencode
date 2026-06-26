# Branch model: `dev` mirrors upstream; qBraid ships from `staging`/`main`

## Status

accepted

## Decision

`dev` is kept as a read-only **mirror of upstream `sst/opencode`** (whose own default branch is `dev`). All qBraid work — branding, the model surface, features — targets **`staging`** (pre-prod) and is promoted to **`main`** (prod). The GitHub default branch is `main`. `dev` is never used as an integration branch for qBraid changes; it only receives `upstream/dev` merges, which then flow up into `staging`/`main`.

## Why

The obvious setup — treat `dev` as the integration branch and merge everything there — was rejected. Keeping `dev` as a pristine upstream mirror means upstream syncs are a clean `upstream/dev` → `dev` fast-forward/merge with no qBraid changes tangled in, which minimizes conflict surface during the (large, periodic) upstream catch-up merges. qBraid's divergence lives entirely on `staging`/`main`, so the branding re-application and conflict resolution happen in one predictable place.

This is surprising on first read (the GitHub default is `main`, yet features are PR'd into `staging`, and `dev` — despite its name — is not where work lands), which is exactly why it's recorded here.

## Consequences

- CI: pushes to `^staging$` and `^main$` build/publish the `codeq` binary (staging and prod buckets respectively); `dev` has no trigger. See `qbraid-infrastructure` `cloud-build-codeq.tf`.
- Feature PRs must explicitly target `staging` even though the repo default is `main`.
- Upstream syncs are a two-step flow: `upstream/dev` → `dev`, then `dev` merged up into `staging`/`main` (re-applying branding).
