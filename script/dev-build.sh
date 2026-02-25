#!/usr/bin/env bash
# dev-build.sh — One-command branded build cycle for CodeQ development.
#
# Usage:
#   ./script/dev-build.sh              # build only
#   ./script/dev-build.sh --smoke      # build + run smoke test
#   ./script/dev-build.sh --test-only  # smoke test existing binary (skip build)
#
# This script handles the full branding workflow:
#   1. Saves current changes as a patch
#   2. Applies qBraid branding (opencode -> codeq)
#   3. Builds the single-file binary
#   4. Runs smoke test (if --smoke)
#   5. Copies binary to /tmp so it survives cleanup
#   6. Reverts branding
#   7. Re-applies your original changes
#
# The binary is copied to: /tmp/codeq (survives branding revert)
# Build output (pre-copy): packages/opencode/bin/codeq

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_DIR="/tmp/codeq-dev-build"
BUILD_BINARY="$REPO_ROOT/packages/opencode/bin/codeq"
FINAL_BINARY="/tmp/codeq"
SMOKE=false
TEST_ONLY=false
SMOKE_RESULT=0

for arg in "$@"; do
  case "$arg" in
    --smoke)    SMOKE=true ;;
    --test-only) TEST_ONLY=true; SMOKE=true ;;
    --help|-h)
      sed -n '2,/^$/s/^# //p' "$0"
      exit 0
      ;;
  esac
done

mkdir -p "$PATCH_DIR"

# ---------- helpers ----------

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; echo "==> $*"; }

revert_branding() {
  step "Reverting branding"
  cd "$REPO_ROOT"
  git checkout -- .
  git clean -fd -- packages/opencode/bin/ 2>/dev/null || true
}

reapply_patches() {
  step "Re-applying your changes"
  cd "$REPO_ROOT"
  if [[ -s "$PATCH_DIR/unstaged.patch" ]]; then
    git apply "$PATCH_DIR/unstaged.patch" || fail "Could not re-apply unstaged patch"
  fi
  echo "  patches restored"
}

# ---------- build ----------

if [[ "$TEST_ONLY" == false ]]; then
  step "Saving current changes"
  cd "$REPO_ROOT"
  git diff > "$PATCH_DIR/unstaged.patch"
  git diff --staged > "$PATCH_DIR/staged.patch"
  echo "  saved to $PATCH_DIR/"

  # Trap: always revert branding + re-apply on exit (even on failure)
  trap 'revert_branding; reapply_patches' EXIT

  step "Applying qBraid branding"
  sed -i 's/"bun@1.3.5"/"bun@1.3.9"/' package.json
  bun branding/apply.ts qbraid

  step "Building codeq binary"
  cd "$REPO_ROOT/packages/opencode"
  OPENCODE_VERSION="0.0.0-dev" \
  OPENCODE_CHANNEL="feat/quantum-sidebar" \
  PATH="$PATH:/usr/bin" \
    bun run build --single

  # Copy the COMPILED binary (ELF) from dist/, not the launcher script from bin/
  DIST_BINARY="$REPO_ROOT/packages/opencode/dist/codeq-linux-x64/bin/codeq"
  if [[ -f "$DIST_BINARY" ]]; then
    cp "$DIST_BINARY" "$FINAL_BINARY"
  else
    # Fallback: try the launcher script
    cp "$BUILD_BINARY" "$FINAL_BINARY"
  fi
  chmod +x "$FINAL_BINARY"
  echo "  Binary copied to $FINAL_BINARY"

  # Run smoke test BEFORE cleanup (branding is still applied, binary exists)
  if [[ "$SMOKE" == true ]]; then
    step "Running smoke test"
    "$REPO_ROOT/script/smoke-test.sh" "$FINAL_BINARY" || SMOKE_RESULT=$?
  fi

  # EXIT trap fires here: revert branding + re-apply patches
else
  # --test-only mode: just run smoke test on existing binary
  if [[ "$SMOKE" == true ]]; then
    BINARY="${FINAL_BINARY}"
    [[ -f "$BINARY" ]] || BINARY="$BUILD_BINARY"
    step "Running smoke test"
    "$REPO_ROOT/script/smoke-test.sh" "$BINARY" || SMOKE_RESULT=$?
  fi
fi

# The EXIT trap handles revert + re-apply for build mode

if [[ $SMOKE_RESULT -ne 0 ]]; then
  echo ""
  echo "Smoke test FAILED (exit $SMOKE_RESULT)"
  exit $SMOKE_RESULT
fi

echo ""
echo "Done. Binary: $FINAL_BINARY"
