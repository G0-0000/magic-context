#!/usr/bin/env bash
# Opt-in real-host witness. Fetch the 2.0.26 Linux platform tarball locally and
# pass its path as R3_HOST_TARBALL; the Linux runner never needs network access.
set -euo pipefail
if [[ ${MC_665_R3:-} != 1 ]]; then
    echo 'skipped: set MC_665_R3=1 to run the isolated host witness'
    exit 0
fi
: "${R3_HOST_TARBALL:?locally fetched cli-linux-x64-2.0.26.tgz required}"
command -v lsof
root=$(mktemp -d "${TMPDIR:-/tmp}/mc-665-r3-host.XXXXXX")
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/cli" "$root/home" "$root/data" "$root/config" "$root/cache" "$root/state" "$root/runs"
tar -xzf "$R3_HOST_TARBALL" -C "$root/cli"
export HOME="$root/home" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state"
export TMPDIR="$root/runs"
export MC_E2E_OPENCODE2_CLI="$root/cli/package/bin/opencode"
export MC_HOLD_REPORT="$root/host-result.json"
"$MC_E2E_OPENCODE2_CLI" --version
bun --version
bun run --cwd packages/plugin build
bun test packages/e2e-tests/tests/opencode2/active-thinking-prefix-hold.test.ts
# The test samples the whole host process group with lsof, then the host PID
# directly, and refuses any database descriptor outside its throwaway root.
python3 - "$MC_HOLD_REPORT" <<'PY'
import json,sys
report=json.load(open(sys.argv[1]))
print('R3_HOST_EVIDENCE='+json.dumps(report))
PY
