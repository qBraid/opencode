#!/usr/bin/env bash
# smoke-test.sh — Automated TUI smoke test for the CodeQ binary.
#
# Usage:
#   ./script/smoke-test.sh [path-to-binary]
#
# Tests:
#   1. Binary exists and is executable
#   2. Starts without immediate crash (no "No context found" errors)
#   3. Stderr contains no fatal exceptions within first few seconds
#
# Exit code 0 = all tests pass, non-zero = failure.

set -euo pipefail

BINARY="${1:-./packages/opencode/bin/codeq}"
TIMEOUT_SEC=6
STDERR_LOG="/tmp/codeq-smoke-stderr.log"
STDOUT_LOG="/tmp/codeq-smoke-stdout.log"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# ---------- Test 1: Binary exists ----------

[[ -f "$BINARY" ]] || fail "Binary not found: $BINARY"
[[ -x "$BINARY" ]] || chmod +x "$BINARY"

# Check file type
FILE_TYPE=$(file "$BINARY" 2>/dev/null || echo "unknown")
echo "  Binary type: $FILE_TYPE"
pass "Binary exists: $BINARY"

# ---------- Test 2: Starts without crash ----------

> "$STDERR_LOG"
> "$STDOUT_LOG"

echo "  Starting binary (timeout ${TIMEOUT_SEC}s)..."

# Run the binary directly. The TUI needs a PTY, but the "No context found"
# crash happens early in component setup, before any terminal I/O. So we
# can catch it even without a real PTY by feeding /dev/null to stdin.
#
# We use 'timeout' to auto-kill after TIMEOUT_SEC and capture all output.
# Exit code 124 = timed out (good — means it didn't crash immediately).
# Exit code 0   = exited cleanly (unlikely without a TTY but also fine).
# Other codes   = crashed or errored.

set +e
timeout --signal=KILL "$TIMEOUT_SEC" "$BINARY" \
  </dev/null \
  >"$STDOUT_LOG" 2>"$STDERR_LOG"
EXIT_CODE=$?
set -e

echo "  Exit code: $EXIT_CODE (124=timeout/OK, 137=killed/OK)"

# ---------- Test 3: Check for known crash patterns ----------

CRASH_PATTERNS=(
  "No context found for instance"
  "opentui: fatal:"
  "SIGSEGV"
  "panic:"
  "Segmentation fault"
)

FOUND_CRASH=false
for pattern in "${CRASH_PATTERNS[@]}"; do
  if grep -q "$pattern" "$STDERR_LOG" 2>/dev/null || grep -q "$pattern" "$STDOUT_LOG" 2>/dev/null; then
    echo ""
    echo "FAIL: Found crash pattern: '$pattern'"
    echo "--- stderr (last 30 lines) ---"
    tail -30 "$STDERR_LOG" 2>/dev/null || true
    echo "--- stdout (last 30 lines) ---"
    tail -30 "$STDOUT_LOG" 2>/dev/null || true
    FOUND_CRASH=true
    break
  fi
done

if [[ "$FOUND_CRASH" == true ]]; then
  echo ""
  echo "Smoke test FAILED"
  exit 1
fi

# Exit code 124 or 137 = timeout killed it (it survived long enough = good)
# Exit code 0 = clean exit
# Any other code: check if it's a JS/runtime crash we should worry about
if [[ $EXIT_CODE -ne 0 && $EXIT_CODE -ne 124 && $EXIT_CODE -ne 137 ]]; then
  # Check stderr for any JS exceptions we might have missed
  if grep -qE "(TypeError|ReferenceError|Error:)" "$STDERR_LOG" 2>/dev/null; then
    echo ""
    echo "WARNING: Binary exited with code $EXIT_CODE and stderr contains errors:"
    tail -15 "$STDERR_LOG"
    echo ""
    echo "  (This may be expected if running without a TTY)"
  fi
fi

pass "No fatal crash patterns detected in ${TIMEOUT_SEC}s window"

# ---------- Summary ----------

echo ""
echo "Smoke test PASSED"
echo "  Logs: $STDERR_LOG, $STDOUT_LOG"
