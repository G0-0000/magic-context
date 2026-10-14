#!/usr/bin/env bash
# Run the randomized provider-byte differential against the base commit (REVIEW_BASE,
# exported into a temporary directory, never a live checkout) and against this tree.
set -euo pipefail
ROOT=$(pwd)
BASE=${REVIEW_BASE:-9382158d98bc087b397594ab03a611b26827493e}
WORK=$(mktemp -d)
MASTER="$WORK/master"
mkdir -p "$MASTER"
git -C "$ROOT" archive "$BASE" | tar -x -C "$MASTER"
cp -R "$ROOT/review-tests" "$MASTER/"
for dir in node_modules packages/*/node_modules; do
    [ -e "$ROOT/$dir" ] && ln -s "$ROOT/$dir" "$MASTER/$dir"
done
test ! -e "$MASTER/packages/plugin/src/hooks/magic-context/system-prompt-delivery.ts"
(cd "$MASTER" && REVIEW_OUT="$WORK/master.json" bun test --timeout 300000 review-tests/system-delivery-randomized.test.ts)
REVIEW_OUT="$WORK/reviewed.json" bun test --timeout 300000 review-tests/system-delivery-randomized.test.ts
bun review-tests/compare-differential.ts "$WORK/master.json" "$WORK/reviewed.json"
