#!/usr/bin/env bash
set -euo pipefail
: "${MC668_ROOT:?Set MC668_ROOT to a throwaway directory under TMPDIR/magic-context}"
case "$MC668_ROOT" in */magic-context/*) ;; *) exit 2 ;; esac
variant="${1:-fixed}"
root="$(mktemp -d "$MC668_ROOT/$variant.XXXXXX")"
root="$(cd "$root" && pwd -P)"
export MC668_RUN_ROOT="$root"
export HOME="$root" CFFIXED_USER_HOME="$root" TMPDIR="$root"
export XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" XDG_CACHE_HOME="$root/cache"
export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime"
export PI_CODING_AGENT_DIR="$root/.omp/agent"
export MAGIC_CONTEXT_STORAGE_DIR="$root/data/cortexkit/magic-context"
export OPENCODE_DB="$root/data/opencode/opencode.db"
export MAGIC_CONTEXT_LOG_PATH="$root/magic-context.log"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_NO_TITLE=1 MC_E2E_KEEP=1
printf 'host evidence: %s\n' "$root"
nice -n 10 bun "$(dirname "$0")/host.ts" "$@" > "$root/output.txt" 2>&1
bun -e 'console.log(await Bun.file(process.argv[1]).text())' "$root/output.txt"
printf 'host completed: %s\n' "$root"
