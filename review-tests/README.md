# Host-stall equivalence review

These tests use synthetic stores only, under
`$TMPDIR/magic-context/host-stalls-five-review/`. They assert contracts, not the
current implementation's output. The plugin's `host-stalls-review.test.ts`
imports the storage and cleanup contracts into the normal package suite. The
ordinal witnesses remain separate until the durable-assignment policy is reviewed;
their current-DB OFFSET expectations are not the accepted durable policy. The
standalone commands below remain useful for that design review.

Reviewed commit: `d355645ff5f470a9e0d6db10edb1dfd4005ae17b`.
Comparison base: `baaebec0f389163214d696de84ef8462405e0a3f`.

Run from the repository root (Bun 1.4.2, Linux):

```sh
bun test review-tests/host-stalls-ordinals.test.ts \
  review-tests/host-stalls-storage.test.ts \
  review-tests/host-stalls-orphans.test.ts --timeout 120000
bun run --cwd packages/plugin tsc --noEmit -p ../../review-tests/tsconfig.json
bun run --cwd packages/plugin biome check --config-path ../../review-tests/biome.json ../../review-tests
```

At the reviewed commit, the four ordinal invalidation cases, the clock-skewed /
missing-timestamp marker case, and the live-session insertion race fail. The
remaining ten tests pass. The race test pauses the actual synchronous deletion
body on a worker immediately before its write transaction. The newly active
index control and shutdown rollback control use the same barrier. A subprocess
control also exits normally or receives SIGKILL with the worker transaction open.

For served-byte comparison, extract the base's `packages/plugin`,
`packages/pi-plugin`, `packages/retina-local-fs`, and root package files into a
fresh directory under the fixture root using `git archive`. Link each extracted
package's `node_modules` to this worktree's installed dependencies. No base
source is patched. Use a common, freshly cleared synthetic directory for both
runs so filesystem paths do not introduce unrelated byte differences:

```sh
for host in opencode1 opencode2 pi; do
  export MAGIC_CONTEXT_REVIEW_FIXTURE_ROOT="$TMPDIR/magic-context/host-stalls-five-review/served-fixture"
  rm -rf "$MAGIC_CONTEXT_REVIEW_FIXTURE_ROOT"
  bun review-tests/host-stalls-served-bytes.ts capture "$BASE_SOURCE" "$BASE_OUTPUT" "$host"
  rm -rf "$MAGIC_CONTEXT_REVIEW_FIXTURE_ROOT"
  bun review-tests/host-stalls-served-bytes.ts capture "$PWD" "$TARGET_OUTPUT" "$host"
done
bun review-tests/host-stalls-served-bytes.ts compare "$BASE_OUTPUT" "$TARGET_OUTPUT"
```

All paths above must be disposable paths below the fixture root. Capture calls
run in separate processes. OpenCode 1 uses the shared transform, OpenCode 2 uses
its registered context hook and payload adapter, and Pi uses its registered
context handler. Configuration and storage discovery are fixture-supplied on
OpenCode 2; transforms and token/ownership SQL are not mocked. This is a seeded
adapter differential, not a real-host CLI or performance benchmark.
