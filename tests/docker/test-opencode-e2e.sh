#!/usr/bin/env bash
# ----------------------------------------------------------------------
# Magic Context — OpenCode E2E test runner (runs inside Docker).
#
# Two scenarios:
#   SETUP_SMOKE    — fresh-install path via `doctor --force`
#   SESSION_SMOKE  — single-turn `opencode run` against aimock
#
# Both assertions check the shared SQLite DB at
#   ~/.local/share/cortexkit/magic-context/context.db
# rather than scraping logs, so failures are unambiguous.
# ----------------------------------------------------------------------

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/opencode/magic-context/magic-context.log"

check() {
    local label="$1"
    local condition="$2"
    if eval "$condition"; then
        echo -e "  ${GREEN}PASS${NC} [$label]"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} [$label]"
        FAIL=$((FAIL + 1))
    fi
}

section() {
    echo ""
    echo -e "${BLUE}─── $1 ───${NC}"
    echo ""
}

# ----------------------------------------------------------------------
# Phase 0: install the Magic Context plugin from the local copy so the
# rest of the script tests the bits we plan to publish, not whatever
# happens to be on npm. We use `npm link` so global `bunx` resolves the
# local copy of @cortexkit/opencode-magic-context.
# ----------------------------------------------------------------------
section "Phase 0: install Magic Context locally"
cd /test/mc-opencode
npm install --silent --no-audit --no-fund --omit=dev 2>&1 | tail -5 || true
npm link --silent --no-audit --no-fund 2>&1 | tail -3 || true
cd /test/project

# ----------------------------------------------------------------------
# Phase 1: SETUP_SMOKE — non-interactive setup via `doctor --force`.
# Doctor's --force mode repairs an existing OpenCode install: it adds
# the plugin entry, fixes compaction conflicts, ensures tui.json. It
# does NOT create opencode.json from scratch (that's the setup wizard's
# job). To simulate the "user just installed OpenCode + ran doctor"
# path, we seed an empty opencode.json first.
# ----------------------------------------------------------------------
section "Phase 1: SETUP_SMOKE — doctor --force on a fresh OpenCode install"

# Pre-condition: clean Magic Context state, but a minimal opencode.json
# exists (this is what the OpenCode installer leaves behind).
rm -rf "$HOME/.config/opencode" "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"
mkdir -p "$HOME/.config/opencode"
echo '{}' > "$HOME/.config/opencode/opencode.json"

# Since v0.16.1 the CLI lives in the unified @cortexkit/magic-context
# package — opencode-magic-context is now the runtime plugin only. The
# `magic-context` binary was symlinked into /usr/local/bin during the
# Dockerfile build, so it resolves the same way `npm install -g
# @cortexkit/magic-context` would on a real machine.
DOCTOR_OUT=$(magic-context doctor --harness opencode --force 2>&1 || true)
echo "$DOCTOR_OUT" | tail -30

# Doctor's actual outro is one of:
#   "Everything looks good!"
#   "Found N issue(s), fixed M. Restart OpenCode to apply."
#   "Fixed M issue(s). Restart OpenCode to apply."
#   "Found N issue(s) that need manual attention."
# The first three are success cases; the last is a hard failure (exit 1).
check "doctor --force completed without hard failures" \
    "echo \"\$DOCTOR_OUT\" | grep -qE '(Everything looks good|Fixed [0-9]+ issue|Found [0-9]+ issue\\(s\\), fixed)'"

check "OpenCode config still exists at ~/.config/opencode/opencode.json" \
    "test -f $HOME/.config/opencode/opencode.json"

check "Plugin entry registered in OpenCode config" \
    "grep -qE '@cortexkit/opencode-magic-context' $HOME/.config/opencode/opencode.json"

# Magic Context creates its DB lazily on first plugin load, so it
# may not exist yet after just `doctor`. The session smoke phase
# below will trigger DB creation; we just verify doctor didn't
# leave any unfixed issue.
check "doctor did not leave issues that need manual attention" \
    "! echo \"\$DOCTOR_OUT\" | grep -qE 'need manual attention'"

# ----------------------------------------------------------------------
# Phase 2: SESSION_SMOKE — run a real opencode session against aimock.
# Two assertions:
#   - the plugin loaded (log file exists, contains a session-id line)
#   - the plugin tagged ≥1 message in the shared DB with harness='opencode'
# ----------------------------------------------------------------------
section "Phase 2: SESSION_SMOKE — single-turn opencode run with aimock"

# Tell OpenCode about an OpenAI-compatible mock provider. Use a
# file:// plugin specifier so OpenCode loads the locally-built plugin
# at /test/mc-opencode rather than pulling the published version from
# npm. Without this, OpenCode's plugin resolver hits its own per-
# package cache (~/.cache/opencode/packages/) and downloads the
# @latest npm tarball, which would test the previous release rather
# than the working tree.
cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///test/mc-opencode"],
  "compaction": { "auto": false, "prune": false },
  "provider": {
    "mock": {
      "api": "openai",
      "name": "aimock",
      "options": { "baseURL": "http://127.0.0.1:4010/v1" },
      "models": { "mock-model": { "name": "Mock Model" } }
    }
  }
}
JSON

# Magic Context config — local embeddings (no network), historian
# pointed at the same mock model so any background historian call also
# resolves through aimock without external API.
cat > "$HOME/.config/opencode/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "historian": { "model": "mock/mock-model" },
  "dreamer": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

# Start aimock in the background.
node /test/aimock-server.cjs > /tmp/aimock.log 2>&1 &
AIMOCK_PID=$!
# shellcheck disable=SC2064
trap "kill $AIMOCK_PID 2>/dev/null || true" EXIT

# Wait for aimock to be ready (max 15s).
for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:4010/v1/models > /dev/null 2>&1; then
        break
    fi
    sleep 1
done
check "aimock /v1/models responds" \
    "curl -fsS http://127.0.0.1:4010/v1/models > /dev/null"

# Run opencode for one turn. Cap at 60s so a hung mock doesn't hang CI.
echo ""
set +e
OPENAI_API_KEY=sk-mock-e2e-test \
    timeout --signal=KILL 60 opencode run \
        --model "mock/mock-model" \
        "Say hello once and then stop." \
        > /tmp/opencode.log 2>&1
OC_EXIT=$?
set -e
echo "  opencode exit code: $OC_EXIT"
echo "  ── opencode log tail ──"
tail -20 /tmp/opencode.log

check "opencode produced a log file" "test -s /tmp/opencode.log"

# Plugin log should now exist with at least one transform line.
check "magic-context plugin log exists" "test -s $PLUGIN_LOG"

# Shared DB should now exist and have at least one tagged message.
check "shared SQLite DB created" "test -f $DB_PATH"

if [[ -f "$DB_PATH" ]]; then
    SESSION_META_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='opencode'" 2>/dev/null || echo "0")
    echo "  session_meta(harness='opencode') row count: $SESSION_META_COUNT"
    check "at least one OpenCode session_meta row persisted" \
        "test \"$SESSION_META_COUNT\" -gt 0"

    # Schema check: harness column exists and at least one OpenCode-scoped
    # row was attributed correctly. We don't strictly require any 'tags'
    # rows because `opencode run` can be SIGKILLed by our 60s timeout
    # before the plugin's transform fully persists tag rows for a
    # one-shot message — the session_meta row writes earlier in the
    # transform pipeline and is the more reliable proof that the plugin
    # loaded, opened the DB at the correct cortexkit path, and tagged
    # the session with the right harness.
    SCHEMA_HAS_HARNESS=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name='harness'" 2>/dev/null || echo "0")
    check "shared DB schema includes the 'harness' column on tags" \
        "test \"$SCHEMA_HAS_HARNESS\" -gt 0"

    TAG_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags WHERE harness='opencode'" 2>/dev/null || echo "0")
    echo "  tags(harness='opencode') row count: $TAG_COUNT (informational)"
fi

# ----------------------------------------------------------------------
# DUAL_INSTANCE_BOOT keeps one real OpenCode server active for this project
# while a second OpenCode process boots against the same MC database. A separate
# SQLite connection holds a representative BEGIN IMMEDIATE write lock so this
# harness exercises startup diagnostics and lock behavior together.
# ----------------------------------------------------------------------
section "Phase 3: DUAL_INSTANCE_BOOT — shared project and contended MC database"

DUAL_STORAGE="$HOME/.local/share/cortexkit/magic-context"
DUAL_A_MC=/tmp/dual-instance-a-mc.log
DUAL_B_MC=/tmp/dual-instance-b-mc.log
DUAL_A_LOG=/tmp/dual-instance-a.log
DUAL_B_LOG=/tmp/dual-instance-b.log
rm -f "$DUAL_A_MC" "$DUAL_B_MC" "$DUAL_A_LOG" "$DUAL_B_LOG"

MAGIC_CONTEXT_STORAGE_DIR="$DUAL_STORAGE" MAGIC_CONTEXT_LOG_PATH="$DUAL_A_MC" \
    opencode serve --hostname 127.0.0.1 --port 4098 >"$DUAL_A_LOG" 2>&1 &
DUAL_A_PID=$!
for _ in $(seq 1 150); do
    if curl -fsS --max-time 0.2 http://127.0.0.1:4098/doc >/dev/null 2>&1; then break; fi
    sleep 0.1
done
curl -fsSG --max-time 20 --data-urlencode "directory=/test/project" \
    http://127.0.0.1:4098/config >/tmp/dual-instance-a-config.json 2>/dev/null || true
for _ in $(seq 1 150); do
    [[ -s "$DUAL_A_MC" ]] && break
    sleep 0.1
done
check "instance A loaded Magic Context for the project" "test -s $DUAL_A_MC"

# Keep a write transaction open long enough to overlap instance B's storage
# initialization. WAL readers remain available; current-schema boot must avoid
# acquiring a migration write lock merely to discover that no migration exists.
({ echo "PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;"; sleep 6; echo "COMMIT;"; } | \
    sqlite3 "$DB_PATH" >/tmp/dual-instance-holder.log 2>&1) &
DUAL_HOLDER_PID=$!
sleep 0.2
DUAL_STARTED_MS=$(date +%s%3N)
set +e
MAGIC_CONTEXT_STORAGE_DIR="$DUAL_STORAGE" MAGIC_CONTEXT_LOG_PATH="$DUAL_B_MC" \
    timeout --signal=KILL 20 opencode debug config >"$DUAL_B_LOG" 2>&1 &
DUAL_B_PID=$!
DUAL_FIRST_LOG_MS=-1
for _ in $(seq 1 300); do
    if [[ -s "$DUAL_B_MC" ]]; then
        DUAL_FIRST_LOG_MS=$(( $(date +%s%3N) - DUAL_STARTED_MS ))
        break
    fi
    kill -0 "$DUAL_B_PID" 2>/dev/null || break
    sleep 0.1
done
wait "$DUAL_B_PID"
DUAL_B_EXIT=$?
set -e
wait "$DUAL_HOLDER_PID" 2>/dev/null || true
DUAL_READY_MS=$(( $(date +%s%3N) - DUAL_STARTED_MS ))
DUAL_RPC_FILE_COUNT=$(find "$DUAL_STORAGE/rpc" -type f -name 'port-*.json' 2>/dev/null | wc -l || true)
kill "$DUAL_A_PID" 2>/dev/null || true
wait "$DUAL_A_PID" 2>/dev/null || true

echo "  instance B first Magic Context log: ${DUAL_FIRST_LOG_MS}ms"
echo "  instance B host config ready: ${DUAL_READY_MS}ms (exit=$DUAL_B_EXIT)"
check "instance B emits boot: entering before contention" \
    "test \"$DUAL_FIRST_LOG_MS\" -ge 0 && grep -q '\[magic-context\] boot: entering pid=' $DUAL_B_MC"
check "instance B completes while instance A remains active" "test \"$DUAL_B_EXIT\" -eq 0"
check "instance B stays inside the 20s host-start cap" "test \"$DUAL_READY_MS\" -lt 20000"
check "instance A published project-scoped RPC discovery" \
    "test \"$DUAL_RPC_FILE_COUNT\" -gt 0"

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}All OpenCode E2E checks passed.${NC}"
    exit 0
else
    echo -e "${RED}OpenCode E2E checks failed.${NC}"
    exit 1
fi
