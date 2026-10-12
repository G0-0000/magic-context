# OpenCode 2 marker publication regression reproduction

Baseline: `55e9f18ca9d6a868eb899ac09933ec37c241c7b8`.
Hosts: OpenCode **2.0.22** and the CI-pinned OpenCode 1 control **1.18.31**.
Test runner: Bun **1.4.2** (`744846f84`), on macOS.

Target file: `packages/e2e-tests/tests/opencode2/marker-s3-runtime.test.ts`.
Its sole test, called I10 below, is `I10 real-host counters: v2 fold plus historian
publication plus ten turns invoke no v1 marker members; v1 control invokes all four`.

## Cause and scope of the repair

The baseline error, `historian publication did not complete`, points to line 97
of the test, which waits for the
**OpenCode 1 control** to publish. The OpenCode 2 arm had already published,
passed its marker-state assertions, and printed all four marker counters as zero.

The test builds its own instrumented plugin into a temporary directory. It built
only `index.js`, omitting the `raw-ordinal-warmup-worker.js` sibling shipped by
the production build. Consequently, the worker could not load and the historian
correctly declined decisions requiring exact tag ownership. Emitting the worker
beside the instrumented plugin restores the production packaging contract.
There is no product readiness bypass or synchronous scan fallback in this repair.

Once that omission was repaired, the test exposed a second fixture problem:
`Consume published marker` follows a mock response reporting 160,000 input
tokens, which starts another background historian for the v1 session. The
`s3_direct_historian` control tool sometimes ran before that historian released
its publication lease.
A persisted tool result in the throwaway OpenCode 1 store was:

```json
{"tool":"s3_direct_historian","state":{"status":"error","input":{"deferred":false},"error":"control lease unavailable"}}
```

The test now waits for the v1 control session's active publication lease to finish before
requesting the direct control, and asserts that the tool was requested. All four
original positive-control assertions remain; no assertion was weakened.
Failure diagnostics now read the actual OpenCode 1 plugin log under its isolated
state directory, and also print the OpenCode 2 plugin log.

A bisect was unnecessary because the reproduced logs explicitly identify the
missing `raw-ordinal-warmup-worker.js` sibling, as captured below.
No claim is made about the first failing commit or the last passing master run.

## Captured plugin decisions

These are excerpts from the isolated plugin logs. Paths below use `$TASK_ROOT`
for the throwaway base; the session identifiers and timestamps are unchanged.

Before repair, OpenCode 1:

```text
[2026-10-11T23:20:35.994Z] [magic-context][ses_ed2bb5b5dffeMVP0ObdaOuaioT] transform stage: stage=rawOrdinals.prepare elapsed=0.1ms ready=true
[2026-10-11T23:20:36.031Z] [magic-context][ses_ed2bb5b5dffeMVP0ObdaOuaioT] WARN tag owner warm-up failed: {"failure":"worker-error","detail":"Error: BuildMessage: ModuleNotFound resolving \"$TASK_ROOT/fixtures/mc-s3-markers-4wOajj/raw-ordinal-warmup-worker.js\" (entry point)"}
[2026-10-11T23:20:36.031Z] [magic-context][ses_ed2bb5b5dffeMVP0ObdaOuaioT] WARN tag owner digest unavailable within 250ms; decisions requiring exact owners must defer or retry
```

The baseline OpenCode 2 run completed publication:

```text
[2026-10-11T23:19:59.787Z] [magic-context][ses_ed2bbf742ffeQlyOC6xoOF0UW1] historian publish completed: compartments=1 range=1-2
I10_V2 {"applyDeferredCompactionMarker":0,"reconcileMarkerRepresentation":0,"setPendingCompactionMarkerState":0,"updateCompactionMarkerAfterPublication":0}
```

After repair, OpenCode 2:

```text
[2026-10-11T23:48:01.577Z] [magic-context][ses_ed2a24311ffe0sZ85eqLYNIeAk] compartment trigger: firing (reason=force_band)
[2026-10-11T23:48:01.622Z] [magic-context][ses_ed2a24311ffe0sZ85eqLYNIeAk] historian publish completed: compartments=1 range=1-2
```

After repair, OpenCode 1:

```text
[2026-10-11T23:48:10.584Z] [magic-context][ses_ed2a220daffedIFRPHFTIs5z02] compartment trigger: firing (reason=projected_headroom)
[2026-10-11T23:48:11.686Z] [magic-context][ses_ed2a220daffedIFRPHFTIs5z02] historian publish completed: compartments=1 range=1-2
[2026-10-11T23:48:12.829Z] [magic-context][ses_ed2a220daffedIFRPHFTIs5z02] historian publish completed: compartments=1 range=3-4
[2026-10-11T23:48:13.967Z] [magic-context][ses_ed2a220daffedIFRPHFTIs5z02] historian publish completed: compartments=2 range=5-12
```

A final targeted run of the marker test passed and printed:

```text
I10_V1 {"counts":{"applyDeferredCompactionMarker":1,"reconcileMarkerRepresentation":32,"setPendingCompactionMarkerState":2,"updateCompactionMarkerAfterPublication":1},"latest":{"end_message_id":"msg_12d607f92001q7yXV2y8SM31po"},"source":"fixture RawMessageProvider reads real v1 SDK messages"}
1 pass, 0 fail, 10 expect() calls
```

## Verification and isolation

Every local host run used a throwaway base under the original
`$TMPDIR/magic-context/bg_a0136704840be050/`. Both binaries were installed there;
`MC_E2E_OPENCODE2_CLI` and `MC_E2E_OPENCODE1_CLI` were explicit, with the pinned
1.18.31 directory first on PATH for the v1 harness. HOME and all XDG roots were
isolated too. No live store was opened for comparison.

A descendant-process monitor ran `lsof -p <host pid> -Fn` and rejected database
paths outside that base. For example, the final targeted run observed:

```text
pid=63585 $TASK_ROOT/fixtures/mc-opencode2-qW3XvU/XDG_DATA_HOME/opencode/opencode2.db
pid=63585 $TASK_ROOT/fixtures/mc-opencode2-qW3XvU/XDG_DATA_HOME/cortexkit/magic-context/context.db
pid=64170 $TASK_ROOT/fixtures/opencode-e2e-Rzk2Gx/data/opencode/opencode.db
pid=64170 $TASK_ROOT/fixtures/opencode-e2e-Rzk2Gx/data/cortexkit/magic-context/context.db
HOST_ISOLATION_SUMMARY hosts=2 db_hosts=2 violations=[]
```

WAL/SHM paths were under the same roots. The whole lane monitor observed 81
host processes, 80 with database descriptors sampled, and zero outside-root
paths. This is sampled evidence, not a continuous filesystem audit; the OpenCode
2 runner also checks descriptors at startup and teardown. Throwaway roots and
the temporary monitor were removed after verification.

- Local `bun test --timeout 600000 tests/opencode2/marker-s3-runtime.test.ts`:
  passed, one test with all four v1 positive controls and zero v2 calls.
- Local CI host-lane selection from
  `bun scripts/validate-mode-manifest.ts --mode ts --harness opencode2`, then
  `bun test --timeout 600000 $files`: passed, 39 selected files. The tool truncated
  the aggregate Bun test totals. The command chain exited zero.
- Local sequential conversion regression: passed, 14 tests, 125 assertions;
  subsequent marker regression: passed, one test, 10 assertions.
- Linux, 8 vCPUs: `bun run build` passed; `bun run typecheck` passed with
  TypeScript 5.9.3; `bun run lint` passed with Biome 2.5.1 (1825 files checked,
  existing warnings/info only).
- Linux full plugin suite after building: 7708 passed, 27 skipped, one unrelated
  failure in `Node WASM Transformers fixture > builds with real fs and persists
  a model for offline reuse`: its temporary bundle could not resolve
  `onnxruntime-web/webgpu`. An initial run without Linux bundles also failed nine
  artifact-loading tests; building eliminated those nine failures.
- Linux focused plugin regressions: 38 passed across five files covering owner
  readiness, worker preparation, append readiness, transform preparation and
  marker publication. These used the package test script.
- The additional e2e-package `tsc --noEmit -p packages/e2e-tests/tsconfig.json`
  check reported unrelated existing errors outside the edited test (including
  Bun/BetterSqlite3 type mismatches and ES2022 `findLast` errors). The edited test
  has an authoritative editor diagnostic report with zero errors or warnings.

## Mutation controls

Each mutation used the staged live fixture as its restore point and was marked
`NON-VACUITY BREAK`. In each case, `git diff --stat` was empty before mutation,
showed one insertion/one deletion during mutation, and was empty after restoring
and touching the file. Neither mutation remains in the source.

1. Change the emitted worker filename so the plugin cannot find its sibling:
   only the I10 test failed, with `historian publication did not complete`.
2. Make the lease-wait predicate always true: only the I10 test failed, because
   `updateCompactionMarkerAfterPublication` was absent from the v1 call set.

The restored fixture was rerun afterward: one pass, zero failures.
