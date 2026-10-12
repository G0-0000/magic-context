#!/usr/bin/env bash
# Pass-by-pass differential of the randomized signed-prefix hold drivers
# (packages/pi-plugin/src/issue-665-hold-review-r2.test.ts and
# packages/plugin/src/hooks/magic-context/issue-665-hold-review-r2.test.ts)
# between the current checkout and a base commit.
#
# The four product files the hold revision changed are replaced by their base
# versions for the second run and restored on exit. Run it in a scratch copy
# of the worktree (the Linux runner's copy), never in a checkout with
# uncommitted product edits.
#
# Usage: differential.sh [base-commit] [output-dir]
set -euo pipefail
base=${1:-62fa1e27}
out=${2:-${TMPDIR:-/tmp}/issue-665-r2-differential}
root=$(git rev-parse --show-toplevel)
here=$(cd "$(dirname "$0")" && pwd)
files=(
	packages/pi-plugin/src/context-handler.ts
	packages/plugin/src/hooks/magic-context/transform.ts
	packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts
	packages/plugin/src/v2/hooks/context.ts
)
rm -rf "$out"
mkdir -p "$out/head" "$out/base" "$out/save"
for f in "${files[@]}"; do
	mkdir -p "$out/save/$(dirname "$f")"
	cp "$root/$f" "$out/save/$f"
done
restore() {
	for f in "${files[@]}"; do cp "$out/save/$f" "$root/$f"; done
}
trap restore EXIT

export R2_SEEDS=${R2_SEEDS:-665,664,650}
export R2_PASSES=${R2_PASSES:-120}
export R2_UNHELD_PASSES=${R2_UNHELD_PASSES:-320}
export R2_VERBOSE=1

run() {
	local label=$1
	(cd "$root/packages/pi-plugin" && R2_TRACE="$out/$label/trace" bun test src/issue-665-hold-review-r2.test.ts) \
		>"$out/$label/pi.log" 2>&1 || echo "$label: Pi driver exited non-zero (see $out/$label/pi.log)"
	(cd "$root/packages/plugin" && R2_TRACE="$out/$label/trace" bun test src/hooks/magic-context/issue-665-hold-review-r2.test.ts) \
		>"$out/$label/opencode.log" 2>&1 || echo "$label: OpenCode driver exited non-zero (see $out/$label/opencode.log)"
}

run head
for f in "${files[@]}"; do
	# BASE_SRC: a directory holding the base versions at the same relative
	# paths, for runners whose checkout has no git objects.
	if [ -n "${BASE_SRC:-}" ]; then cp "$BASE_SRC/$f" "$root/$f"; else git -C "$root" show "$base:$f" >"$root/$f"; fi
done
run base
restore
trap - EXIT
python3 "$here/compare.py" "$out"
