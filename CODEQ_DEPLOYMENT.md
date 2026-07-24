# CodeQ deployment path (staging / prod Lab instances)

How a change to `qBraid/opencode` reaches a JupyterLab singleuser pod as an
updated `codeq` binary, and where staleness can creep in. This is the **anchor
document** for the CodeQ-deployment wayfinder effort
([map #16](https://github.com/qBraid/opencode/issues/16)): every fact below is
cross-checked against the live source of truth so downstream decision tickets
build on correct facts.

> **Scope:** the GKE **staging** (`qbraid-staging`) and **prod** (`qbraid-prod`)
> Lab-instance path only. Mac/Windows/arm64 desktop & CLI distribution (the
> `codeq-gcs-upload.yml` GitHub Actions path) and BMA / multi-cloud AMI-bake
> instances are out of scope here.

## Sources of truth

The GCP side is **not** owned by this repo. The authoritative files are:

| Concern | Repo · path |
| --- | --- |
| Build codeq binary → upload to GCS | `qbraid-infrastructure` · `terraform/environments/{staging,prod}/gcp/cloud-build-codeq.tf` |
| Download binary → bake into Lab image | `qbraid-infrastructure` · `terraform/environments/{staging,prod}/gcp/cloud-build-qbraid-dstacks.tf` |
| Which image singleuser pods run | `qbraid-infrastructure` · `kubernetes/clusters/gcp/gke_{staging,prod}_cluster/helm/jupyterhub/values-{staging,prod}.yaml` |
| Runtime config + token scripts, binary placement | `qbraid-Dstacks` · `qbraid-lab-base/scripts/{setup-codeq-config,update-codeq-token,codeq-wrapper}.sh`, `qbraid-lab-base/Dockerfile` |

*Verified against:* `qbraid-infrastructure` `main` @ `01b278b`; `qbraid-Dstacks`
`origin/staging` (`bbf58c3`) and `origin/main` (`69999a9`) — the branches that
deploy to staging and prod respectively.

## The 3-hop pipeline

```
push to opencode           push to qbraid-Dstacks              new pod spawn
   staging/main    ─▶  (qbraid-lab-base/** changed)   ─▶     (pullPolicy: Always)
        │                        │                                  │
   HOP 1 · AUTO            HOP 2 · NOT AUTO                    HOP 3 · AUTO
   build binary,          download binary from GCS,           pull lab-base:latest,
   upload to GCS          bake into lab-base:latest           run baked binary
```

### Hop 1 — push → binary in GCS · **automatic**

- Trigger **`opencode-staging-branch`** fires on push to `^staging$` of
  `qBraid/opencode`; **`opencode-prod-main`** fires on push to `^main$`.
- Each is a single Cloud Build: install deps → apply qBraid branding → build the
  single-file `codeq` binary (`bun run build --single`, `OPENCODE_BUMP=1`) →
  Trivy CLI-dependency scan → **`upload-gcs`** step (`gsutil cp` the binary) →
  `upload-manifest`.
- Output:
  - staging → `gs://qbraid-codeq-staging/latest/linux-x64/codeq` (+ `latest/manifest.json`)
  - prod → `gs://qbraid-codeq/latest/linux-x64/codeq` (+ `latest/manifest.json`)
- Only `linux-x64` is produced here. `manifest.json` records
  `{"version":"latest","timestamp":"…"}` — it lives in the bucket, not on any pod.

### Hop 2 — binary in GCS → Lab image · **NOT automatic** (Layer 1 gap)

- Trigger **`build-lab-base`** (staging, `^staging$`) and
  **`build-lab-base-prod`** (prod, `^main$`) on `qBraid/qbraid-Dstacks`, each
  narrowed by `included_files = ["qbraid-lab-base/**"]`.
- Their **`download-artifacts`** step inlines a plain
  `gsutil cp gs://qbraid-codeq-staging/latest/linux-x64/codeq …` (staging) /
  `gs://qbraid-codeq/latest/linux-x64/codeq …` (prod) into
  `qbraid-lab-base/codeq_bin/`, `chmod +x`, then the `build` step bakes it into
  `…/jupyterhub/lab-base:latest` (re-tagged `lab-standard:latest`).
- **This `gsutil cp` is an inline pull at build time — it is _not_ chained to the
  codeq upload.** There is no storage notification, Pub/Sub subscription, Cloud
  Function, or Eventarc watching the codeq bucket, and nothing programmatically
  runs the `build-lab-base[-prod]` trigger after an upload. The image rebuild
  fires **only** on a push to `qbraid-Dstacks` `staging`/`main` touching
  `qbraid-lab-base/**` (or a manual
  `gcloud builds triggers run build-lab-base[-prod]`).
- **Consequence (Layer 1):** a freshly built codeq binary can sit in GCS
  indefinitely. It only reaches an image when some *unrelated* `qbraid-lab-base/**`
  change happens to trigger a rebuild, or someone manually re-runs the trigger.
  This is the core decoupling this effort exists to close.
- The same binary is also baked by **`build-lab-intel[-prod]`**
  (`foundation:py310 → lab-base:py310 → lab-intel`; its `included_files` include
  `qbraid-lab-base/**`) and by the **disabled** `build-bma-lab-base` trigger — so
  the layer-1 fix must consider every consumer of the binary, not just lab-base.
- **Cutover nuance:** the prod Cloud Build SA holds `objectViewer` on
  `gs://qbraid-codeq-staging` "so prod lab-base can consume the staging binary
  during cutover bridging (Phase B)." During cutover the environments are not
  strictly bucket-isolated.

### Hop 3 — Lab image → user pod · **automatic for _new_ pods only** (Layer 2 gap)

- `singleuser.image` in `values-{staging,prod}.yaml`:
  `name: …/jupyterhub/lab-base`, `tag: latest`, **`pullPolicy: Always`**.
- Every newly-spawned pod pulls `lab-base:latest` and therefore runs whatever
  binary the current image baked in.
- **Consequence (Layer 2):** already-running pods are **not** refreshed. A user
  keeps their old binary until they restart their server (new spawn → fresh
  pull). "Reached all users on an env" is not true until the last long-running
  pod is recycled.

## Runtime config & the binary on the pod

### Binary placement — outside home, never stale-from-sync

The `Dockerfile` copies the binary to `/usr/local/bin/codeq-bin` and the wrapper
to `/usr/local/bin/codeq` — explicitly **not** under `~/.local/bin`, with the
comment *"which gets overwritten by GCS home sync."* So the binary a user runs is
always the image's baked binary; it is only ever stale via Layers 1–2, never via
home persistence.

`codeq` (the wrapper, `codeq-wrapper.sh`) runs `update-codeq-token.sh` silently,
then `exec`s `/usr/local/bin/codeq-bin "$@"`.

### Home persistence — GCS sync (why config goes stale)

The `data-restore` initContainer runs
`rclone sync gcs:qbraid-<env>-users/$JUPYTERHUB_USER/ /home/jovyan/` on **every**
pod start. So `~/.config/codeq/config.json` (and anything else in home) persists
across pod restarts, restored from GCS.

### Layer 3 — config staleness

On pod start, `before-notebook.d/setup-qbraid.sh` runs `setup-codeq-config.sh`
then `update-codeq-token.sh`:

- **`setup-codeq-config.sh` — only-if-missing.** It writes
  `~/.config/codeq/config.json` **only if the file does not already exist**
  (`if [ ! -f "$CONFIG_FILE" ]`), else it logs "already exists" and leaves it
  untouched. Because the config is GCS-persisted (above), a returning user's
  config is **never regenerated**. New template fields added to this script
  (permissions, provider options, new MCP servers, model default) **do not reach
  existing users.** This is the Layer-3 gap. The template it *would* write pins
  `model: qbraid/gemini-3.5-flash`, `baseURL: <ACCOUNT_URL>/api/ai/v1`,
  `apiKey` seeded from `QBRAID_ACCESS_TOKEN`, a full `permission` allow-block, and
  the `pod_mcp` MCP server.
- **`update-codeq-token.sh` — the only self-healing path for existing configs.**
  Runs on every pod start *and* every codeq launch (via the wrapper). On the
  existing config it re-asserts, via `jq` (sed fallback):
  - `.provider.qbraid.options.apiKey` ← `QBRAID_ACCESS_TOKEN` (fallback: `~/.qbraid/qbraidrc`) — **always**
  - `.provider.qbraid.options.baseURL` ← `<ACCOUNT_URL>/api/ai/v1` (fallback: qbraidrc url map; default `https://account.qbraid.com`) — **always**
  - `.mcp.pod_mcp.command` ← `["/usr/bin/python3","/opt/qbraid-mcp-server/server/main.py"]` — **always**
  - `.mcp.pod_mcp.type` / `.enabled` ← `"local"` / `true` — **only if absent** (`//=`)
  - `.model` — migrates now-dead ids to current (e.g. `gemini-3-flash→gemini-3.5-flash`, `gemini-3-pro→gemini-3.1-pro`, `claude-opus-4-6→claude-opus-4-8`, `claude-sonnet-4-5→claude-sonnet-4-6`, `grok-4.1-fast→gemini-3.5-flash`); empty → `qbraid/gemini-3.5-flash`; a valid user-chosen model is preserved.

  It does **not** touch the `permission` block or any field outside those above.
  So the only config drift that self-heals for existing users is token, gateway
  URL, MCP command, and dead-model migration — nothing else.

## Version detection

- The image is always tagged `:latest`; there is no per-build image tag, no pod
  label, and no version file baked into the image. `manifest.json` records a
  build timestamp but lives in the GCS bucket, not on the pod.
- **On a running pod, `codeq --version` is effectively the only way to tell which
  binary build a user is on.** (`codeq --version` → wrapper → `codeq-bin
  --version`.) Because every build runs with `OPENCODE_BUMP=1`, distinct builds
  report distinct versions, so `--version` is a usable discriminator — but there
  is no at-a-glance external marker (image digest aside, which requires cluster
  access, not a user-visible signal).

## The three staleness layers (summary)

| Layer | Where | Mechanism | Auto-heals? |
| --- | --- | --- | --- |
| **1** binary → image | GCS → `lab-base:latest` | inline `gsutil cp` at image-build time; **no** chain from upload | ❌ needs a `qbraid-lab-base/**` push or manual trigger run |
| **2** image → running pod | `lab-base:latest` → pod | `pullPolicy: Always` on spawn | ⚠️ new pods only; running pods need a restart |
| **3** config persistence | GCS home-sync → `config.json` | `setup-codeq-config.sh` only-if-missing; `update-codeq-token.sh` re-asserts a fixed field set | ⚠️ only token/baseURL/MCP-command/dead-model self-heal |

## Verified but not confirmable without live GCP access

The following depend on live-project state and could not be checked from source:

- Current contents/timestamps of `gs://qbraid-codeq[-staging]/latest/` — i.e.
  whether a newer binary is sitting **un-baked** right now.
- Which image digest `lab-base:latest` currently points to and when it was last
  built (Cloud Build history).
- Whether the triggers are currently enabled/connected in the live projects
  (`local.github_connection_ready`).
- The actual codeq version any given running pod reports.
- Whether any manual `gcloud builds triggers run …` has recently forced a rebuild.

---

## Layer 2 — running-pod refresh policy

**Policy: passive convergence for routine updates; documented manual break-glass for security-critical; no in-Lab banner; no automated drain.** ([decision record #21](https://github.com/qBraid/opencode/issues/21))

A running singleuser pod is pinned to the `codeq` binary baked into the image it spawned with — there is no in-place binary refresh. The only way a live session picks up an update is a full pod restart (stop → spawn → `pullPolicy: Always` re-pulls `lab-base:latest`, see Hop 3 above). Every refresh option reduces to *when/how that restart happens and who triggers it.*

### Routine updates — convergence SLA

No action is taken on rollout. Running sessions converge on their own via idle-cull (an idle singleuser server is stopped; the user's next login spawns a fresh pod on the current image) plus ordinary re-logins. New pods already get the update immediately at spawn — only already-running sessions lag.

| Env | Idle-cull timeout | Cull check interval | Max-server-lifetime cap | Source |
| --- | --- | --- | --- | --- |
| staging | 30 min (`--timeout=1800`) | 5 min (`--cull-every=300`) | *not configured* | `qbraid-infrastructure` · `kubernetes/clusters/gcp/gke_staging_cluster/helm/jupyterhub/values-staging.yaml` · `hub.extraConfig.70_idle_culler` |
| prod | 45 min (`--timeout=2700`) | 5 min (`--cull-every=300`) | *not configured* | `qbraid-infrastructure` · `kubernetes/clusters/gcp/gke_prod_cluster/helm/jupyterhub/values-prod.yaml` · `hub.extraConfig.70_idle_culler` |

Both environments explicitly disable the z2jh chart's own `cull:` block (`cull.enabled: false`) so this `hub.extraConfig.70_idle_culler` service is the *only* culler in effect — the chart-level `cull_idle_timeout: 1200` under `singleuser.extraFiles` config is a notebook-kernel-level `MappingKernelManager` setting (kernel cull, not pod cull) and is not the pod-lifecycle knob. There is no `maxAge`/max-server-lifetime cap configured in either values file, so a continuously-active session (one that never goes idle long enough to be culled) has no absolute upper bound forcing a restart.

**Convergence SLA:** idle sessions converge to the current image within roughly the idle-cull timeout above (≤30 min staging / ≤45 min prod, checked every 5 min) after their last activity. Actively-used sessions converge only when the user restarts their server or logs back in after going idle — there is no absolute time cap forcing convergence for a session that stays continuously active.

### Security-critical updates — break-glass drain

Passive convergence remains the default. For a genuine security-critical update (e.g. a CVE in `codeq`) an operator may force convergence:

- **Who:** a qBraid infra/on-call operator with JupyterHub admin or cluster (`kubectl`) access.
- **One-line step:** force-stop the stale singleuser pods — JupyterHub admin panel "stop server" for affected users, or `kubectl delete pod <singleuser-pod>` in the target namespace — so each user's next login spawns a fresh pod that pulls the patched `lab-base:latest` image.
- **Safeguard:** this is a blunt instrument that interrupts active sessions and any in-progress work (agent runs, unsaved notebook state). Reserve it for the security tier; where practical, warn affected users first and target only pods confirmed stale (old image digest / old `codeq --version`) rather than draining indiscriminately.

### Deliberately not implemented

- **No in-Lab "restart to update" banner.** Not worth the Lab UI work for a passive baseline; users who care can restart themselves, and idle-cull converges the rest.
- **No automated forced drain on every rollout.** Disproportionate to routine changes and destroys in-progress user work; passive convergence handles routine updates and the break-glass runbook above handles urgent ones.

## System-owned config fields registry

CodeQ user config lives at `~/.config/codeq/config.json` and persists forever per user via GCS home-sync. For **existing** users the only convergence surface is `update-codeq-token.sh`, which runs at pod start and on every codeq launch (via `codeq-wrapper.sh`). This registry is the **single source of truth** for the fields that script re-asserts; the Dstacks re-assert block mirrors this table.

**Canonical script copy:** `qbraid-lab-base/scripts/update-codeq-token.sh` in `qbraid-Dstacks` is the canonical copy — it is the image that deploys to the staging/prod K8s Lab path. (`qbraid-overlay/scripts/update-codeq-token.sh` is a secondary, in-flux overlay-path copy that must be kept byte-in-sync with, or folded into, the canonical copy; it must never diverge in the set of fields it asserts.)

### Fields Dstacks re-asserts (system-owned)

Grouped as the two buckets in the script:

**(1) Environment-injected** — pod-environment facts the binary can't self-default:

| Field | Assertion | Notes |
| --- | --- | --- |
| `provider.qbraid.options.apiKey` | always set | qBraid access token (env var `QBRAID_ACCESS_TOKEN`, else `~/.qbraid/qbraidrc`). |
| `provider.qbraid.options.baseURL` | always set | AI gateway `$ACCOUNT_URL/api/ai/v1` (env `QBRAID_ACCOUNT_URL`, else qbraidrc url map, else `https://account.qbraid.com`). |
| `mcp.pod_mcp.command` | always set | `["/usr/bin/python3", "/opt/qbraid-mcp-server/server/main.py"]`. |
| `mcp.pod_mcp.type` | only-if-absent (`//=`) | defaults `"local"`; a user value survives. |
| `mcp.pod_mcp.enabled` | only-if-absent (`//=`) | defaults `true`; a user toggle survives. |

**(2) Migrations / forced corrections** — fix-ups for explicit stale values the binary can't self-correct:

| Field | Assertion | Notes |
| --- | --- | --- |
| `model` | migrate stale id → current; empty → default; valid user id preserved | Uses the retired-ids map below. Empty/absent `.model` → `qbraid/gemini-3.5-flash`. A valid user-chosen model is left untouched. |

### Fields Dstacks must NOT touch (user-owned)

Everything not listed above is user-owned and must never be written by the re-assert. In particular:

- `permission` (the entire block — e.g. `permission.edit`, `permission.bash`)
- any user-added `provider.*` entries other than the specific `provider.qbraid.options.apiKey`/`baseURL` fields above
- any `mcp.*` entry other than `mcp.pod_mcp.command`/`type`/`enabled`
- all other keys (theme, keybinds, layout, agents, etc.)

The CodeQ config schema is almost entirely `.optional()` and the binary merges its own built-in defaults for absent fields, so a genuinely absent field already gets the binary's new default on a fresh pod — it needs no re-assert. Only an **explicit stale value** needs the high-authority correction above.

### Retired ids / renamed fields

Running list, seeded from the current `MODEL_MIGRATIONS` map. Every entry here must be mirrored in the canonical script's `MODEL_MIGRATIONS` (jq) and the paired `sed` fallback.

| Kind | Retired / old | Replacement |
| --- | --- | --- |
| model id | `qbraid/gemini-3-flash` | `qbraid/gemini-3.5-flash` |
| model id | `qbraid/gemini-3-pro` | `qbraid/gemini-3.1-pro` |
| model id | `qbraid/claude-opus-4-6` | `qbraid/claude-opus-4-8` |
| model id | `qbraid/claude-sonnet-4-5` | `qbraid/claude-sonnet-4-6` |
| model id | `qbraid/grok-4.1-fast` | `qbraid/gemini-3.5-flash` |
| default | empty / absent `model` | `qbraid/gemini-3.5-flash` |
| endpoint | `account-v2.qbraid.com` (baseURL host) | `account.qbraid.com` (re-asserted via the always-set `baseURL`) |

### Scoped contract

A codeq change owes a **paired `qbraid-Dstacks` re-assert** update (to the canonical `update-codeq-token.sh`) **only** when it:

1. **renames** a system-owned field,
2. **retires** a value id (a dead model id or dead endpoint),
3. **forces a changed default** onto users who may hold an old explicit value, or
4. adds a **new system-injected field** the binary can't self-default (like `apiKey`/`baseURL`).

Purely additive optional fields with a sane binary default owe **nothing** — do not add busywork re-asserts for them. Any change to this registry (the tables above) is the visible signal that a paired Dstacks PR is due; the codeq PR editing the registry must be paired with a `qbraid-Dstacks` PR updating the canonical `update-codeq-token.sh` before/with the rollout.

### Release-checklist line

> **[ ] System-owned config fields registry** — if this PR changed the *System-owned config fields registry* (added/renamed/retired a system-owned field, retired a model id/endpoint, or forced a changed default), a paired `qbraid-Dstacks` PR updating the canonical `qbraid-lab-base/scripts/update-codeq-token.sh` (both the `jq` and `sed` branches) is merged/queued before rollout, and the overlay copy is kept in sync.

## Rollout smoke-test — is a codeq change live for all users on env X?

The rollout smoke-test asserts exactly **one claim**: `lab-base:latest` carries
the expected codeq SHA. `lab-base:latest` is the on-ramp every user pod draws
from, so **image-correct ⟹ live for all users** — a correct image means every
new or restarted pod runs the correct codeq binary plus re-asserted config.

Truth lives in two places (both stamped by qBraid/opencode#24):

| Side | Source | Meaning |
|---|---|---|
| **Expected** | `sha` key in `gs://<codeq-bucket>/latest/manifest.json` | what the codeq build published (hop 1) |
| **Observed** | `codeq --version` on the `lab-base:latest` binary | what the image bake actually baked in (hop 2) |

Bucket per env: staging `gs://qbraid-codeq-staging`, prod `gs://qbraid-codeq`.
The version string is `0.0.0-<sha>+<build_id>`; the smoke-test compares the
`<sha>` segment. `build_id` is for traceability only — not a gate.

### Check B — operator one-liner (on-demand, no pod shell)

Run the registry-read-only verifier for the target env:

```bash
./scripts/verify-codeq-rollout.sh staging   # or: prod
```

It pulls the **live** `lab-base:latest` from Artifact Registry, runs
`codeq --version`, and SHA-compares to the bucket `manifest.json`. It uses
**registry-read + bucket-read auth only — no `kubectl exec`, no pod access.**
This is the prod go-live confirmation step and the universal spot-check.

**Pass/fail criterion:**

- **PASS** (exit 0) ⟺ `observed.sha == expected.sha` — the live `lab-base:latest`
  is on the SHA the manifest advertises. At that point the change is "live for
  all users on env X": every new/restarted pod runs the correct binary.
- **FAIL** (exit 1) ⟺ SHA mismatch — the live image is **not** on the advertised
  SHA. Investigate a stale/raced manifest `cp`, broken stamping, or a rebuild
  that has not yet run. (Exit 2 = usage/precondition error, e.g. auth or a
  missing `sha` key.)

"Live for all users" means the **image source is correct**, not that every
running pod has already recycled.

### Already-running pods — passive convergence, not gated

Already-running pods converge **by-construction on restart** (correct image ⟹
correct binary + re-asserted config), per the Layer-2 passive-convergence
refresh policy (decision #21). This convergence window is **deliberately not
measured or gated** by the smoke-test — knowing which pods are still stale adds
nothing to the rollout decision, since they self-correct on their next restart.

### Check A — in-build fail-closed gate (automatic)

Every `build-lab-base` (staging) / `build-lab-base-prod` (prod) run executes an
`assert-codeq-sha` step after the build/tag steps but **before** the deferred
`images = [...]:latest` push. Because the push is deferred until every step
passes, a SHA mismatch aborts the build and **`:latest` is never poisoned** — it
stays on the last-good image. This is the fail-closed guard on the staging
auto-rebuild and runs on every prod rebuild; no operator action required.

## Staging auto-rebuild (codeq push → build-lab-base)

**Status: enabled.** Implements Phase 1 of the layer-1 rebuild-mechanism decision (qBraid/opencode#19), closing the HOP-2 gap: a fresh codeq binary landing in `gs://qbraid-codeq-staging` touches no `qbraid-lab-base/**` file in `qbraid-Dstacks`, so `build-lab-base` never fired on its own — `lab-base:latest` kept the old binary until someone ran the trigger by hand.

### Mechanism

`terraform/environments/staging/gcp/cloud-build-codeq.tf` — `opencode-staging-branch`'s build now ends with a `trigger-lab-base-rebuild` step (after `upload-gcs` and `upload-manifest` both succeed):

```
gcloud builds triggers run build-lab-base \
  --project=<staging-project> \
  --region=<staging-region> \
  --branch=staging \
  --impersonate-service-account=codeq-labbase-trigger@<staging-project>.iam.gserviceaccount.com
```

This is a direct, synchronous trigger-run call — **not** a Pub/Sub topic and **not** a `chain-rebuild-*` trigger. That pattern (the one implicated in the 2026-06-11 cascade post-mortem) is being retired, not extended.

### IAM scoping

Cloud Build does not support trigger-level (resource-scoped) IAM — `cloudbuild.googleapis.com` is not among the services covered by GCP's resource-attribute IAM Conditions, so the `cloudbuild.builds.create` permission that `triggers.run` requires can only be granted at the **project** level; there is no way to bind it to just the `build-lab-base` trigger's resource name.

To minimize blast radius anyway:
- A new single-purpose service account, `codeq-labbase-trigger@<staging-project>`, holds a **custom role** (`codeqLabBaseTriggerRunnerStaging`) granting **only** `cloudbuild.builds.create` — not the broader `roles/cloudbuild.builds.editor` bundle (which also allows editing/cancelling arbitrary builds and managing triggers).
- The shared `cloud-build-staging` service account — the executor identity for every staging Cloud Build trigger (foundation, lab-vscode, lab-intel, wheels, jupyterhub, compliance, etc.) — is granted `roles/iam.serviceAccountTokenCreator` scoped to **only that one SA resource** (`google_service_account_iam_member`, not a project-wide grant), so it can impersonate `codeq-labbase-trigger` for exactly this one `gcloud` call. `cloud-build-staging` itself never gains standing `cloudbuild.builds.create` permission.
- Net effect: if `codeq-labbase-trigger`'s credentials were ever compromised, the worst case is "can run any trigger in the staging project" — it cannot touch prod (separate project and SA) and holds no other permissions.

**Documented limitation:** this grant is project-scoped, not trigger-scoped, because Cloud Build doesn't offer a finer grain today. If GCP later adds trigger-level IAM Conditions, the custom-role binding should be tightened to a condition targeting only `projects/<staging-project>/locations/<region>/triggers/build-lab-base`.

### Anti-cascade guardrails satisfied

- **Narrow target**: fires `build-lab-base` only — never `build-foundation`, never any `docker-stacks-*` trigger.
- **Per-env + explicit branch**: `--branch=staging` targets only the staging `build-lab-base` trigger; the impersonated SA has run-permission on staging triggers only (separate project from prod's `build-lab-base-prod`).
- **Idempotent**: `gcloud builds triggers run` is fire-and-forget; a rebuild simply re-pulls `latest/linux-x64/codeq`, so at-least-once firing (e.g. a retried step) is safe — no debounce needed.
- **No Pub/Sub topic, no `chain-rebuild-*` trigger** introduced.

### Observability and safety

The first auto-rebuild fired by this step is guarded by the #25 fail-closed `assert-codeq-sha` gate in `build-lab-base` (a codeq/manifest SHA mismatch aborts the build before the deferred `:latest` image push, leaving the last-good image in place) and is observable via the #24 SHA/build-id stamping baked into `codeq --version` and `manifest.json`. Operators can independently confirm a successful rollout with `scripts/verify-codeq-rollout.sh staging`.
