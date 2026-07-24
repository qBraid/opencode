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
