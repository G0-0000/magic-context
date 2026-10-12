# OpenCode main-thread read stalls (2026-10-12)

## Stack attribution

The three supplied profiler reports were initially inaccessible to the worker's
file reader. The reviewer copied them, and excerpts of the deployed chunks, into
this checkout for inspection; those temporary copies were removed before commit.
The deployed code was matched by content, not by an assumed deployment commit.
No live OpenCode or Magic Context database or configuration was opened.

Both **17:37:51Z (3,470 ms)** and **18:27:41Z (3,890 ms)** have this stack:

```
all [native]
readRawMessagePageRows                 index-pc4tb9yw.js:337
readRawSessionMessagePageFromDb2       index-pc4tb9yw.js:302
anonymous                             index-npah0p63.js:13164
anonymous                             index-npah0p63.js:13153
anonymous                             index-npah0p63.js:13123
anonymous                             index-npah0p63.js:13122
processTicksAndRejections
```

There are respectively 280 and 289 samples in the page reader. The reviewer-supplied
`index-npah0p63.js:13100–13185` excerpt identifies the anonymous frames as
`reconcileSessionIndex` and its per-session promise lock. This is asynchronous
scheduling **on the host event loop**, not a worker. Source:
`packages/plugin/src/features/magic-context/message-index-async.ts`,
`reconcileSessionIndex`. It reads **100 ordinal-bearing messages per batch**,
starting at the durable reconciliation ordinal, possibly rewound to a dirty floor.
It yields *after* reading and indexing the page. The first page has no keyset anchor;
subsequent pages recover one from the last message only when its ordinal equals
the durable cursor.

The old first-page SQL applied the summary JSON predicate before `OFFSET cursor`.
It could therefore parse the entire previously indexed prefix to return only 100
rows. LIMIT bounded the returned rows, not examined JSON or I/O. At a cursor near
150k, it inspected roughly 150k message JSON records. The reports do not contain
arguments or row counts, so that is the fixture's count, **not an assertion about
an instrumented historical cursor**. The old anchored OR predicate could also
revisit earlier messages sharing the anchor's timestamp.

The **19:15:10Z (3,754 ms)** report contains:

```
207 samples:
all [native] → bound #all → withAutocommitTimeout (index-kb9nn0a0.js:578)
  → value → markTagsCompactedByMessageIds2 (index-s5a5hjqp.js:3172)
  → runPostTransformPhase2 (:6591, :5905) → processTicksAndRejections

29 samples:
all [native] → withCompartmentDates (index-s8pm3yk5.js:15054)
  → renderM1WithMetadata → softRefreshCachedM1 → injectM0M1
  → runPostTransformPhase2 (:6563, :5905) → processTicksAndRejections
```

The supplied live `markTagsCompactedByMessageIds` definition proves that the
207-sample operation is **a read-only `WITH ids AS MATERIALIZED ... SELECT`**, not
UPDATE/RETURNING and not evidence of lock acquisition. The shared SQLite wrapper
conservatively routes WITH statements through `withAutocommitTimeout` because
CTEs can introduce writes. The discovered tags were scanned by the session prefix
of `(session_id, tag_number)`; eligibility was filtered only after discovery.
The protected-tool retirement caller immediately following injection already
supplies an eligibility set: `transform-postprocess-phase.ts` builds it from
current/previous protected-tool policies and `args.tags`. Most scanned historical
rows could never be retired by that call.

The same report also has 24 native `#run` samples: visible stacks include pending
`updateTagStatus` writes and an auto-search decision append. These are separate
operations, not a reason to label the dominant SELECT a lock wait. The profiler
cannot identify a competing writer process or distinguish read CPU from cold
read I/O. Fixture lock measurements below establish the timeout behavior separately.

## Changes and work bounds

1. **Raw restart/dirty-floor pages reuse already-warmed ordinal ranks.** Binary
   search finds the nearest worker-built 256-stored-row checkpoint at or below the
   requested ordinal. It then uses a composite `(time_created, id)` seek, including
   timestamp ties. Candidate index keys are limited *before* JSON is inspected;
   the selected page reads at most `skip + pageSize + 512` message rows. Normally
   `skip < 256`, and anchored continuation has `skip = 0`. Rank validation/extension
   retains its existing separate 513-row bound. A cold deep seek refuses with
   `RawOrdinalsNotReady` and requests existing off-thread preparation instead of
   doing a prefix scan. A dense excluded-summary run cannot create an unlimited
   filtered scan; continuation may return a shorter page or require preparation.
   Existing reconciliation preparation/retry handles this readiness exception.
   Message/part data is not truncated or changed. Large newly requested parts can
   still be expensive; this change removes repeated historical work, not arbitrary
   payload-size or disk-latency guarantees.

2. **Compartment dates use ordinal/ID lookups.** Each fresh M0/M1 call deduplicates
   both boundary ordinals, queries indexed timestamps, falls back to host message
   IDs for missing times, then formats two dates per complete compartment. Defer
   replay does none of that. The old `message_time_ms IS NOT NULL` predicate made
   SQLite choose the session/time index and scan all non-null session times, with
   ordinal membership only a filter. Unary `+` preserves the predicate but removes
   that index constraint, selecting the composite primary key instead. The host
   fallback similarly excludes the session index, seeking only requested message
   primary keys. Both plans are checked against the SQL actually prepared by the
   renderer, not a copied query that could diverge from production.

3. **Protected-tag discovery seeks the existing eligibility set.** The SQL now
   applies tag-number membership before source/owner matching. The existing
   unique `(session_id, tag_number)` index answers those lookups. Status and identity
   rechecks, ASCII LIKE matching, unusual IDs, batched writes and pending-op removal
   are unchanged. The separate broader retirement caller without an eligibility
   set retains its existing discovery scan; narrowing its semantics would be a
   different change. No schema/index migration is needed.

## Measurement and master differential

`packages/plugin/scripts/bench-host-stall-paths.ts` uses synthetic stores under
`$TMPDIR/magic-context/bg_7204a03b349b5f25/`. It sets HOME and XDG data/config/cache
roots before importing plugin modules, removes OPENCODE_DB from its own process,
then checks **every open `.db`/sidecar path with lsof** against the canonical
throwaway root. It rejects an existing per-run context store rather than accidentally
measuring an already-mutated fixture. No OPENCODE_DB was exported to unit suites.

The fixture has **150,000 messages**, timestamp ties, stopped compaction summaries,
large metadata and text parts; the OpenCode store is **3,986,726,912 bytes**. Its
context store has 150k timestamp mappings and **70,000 dropped historical part-tag
units**, of which only two protected tags are eligible for retirement. The final
context store is 29,802,496 bytes. This models the size and historical/new-work
ratio, not a reconstruction of private live content or exact live cache state.

Baseline source was extracted with `git archive` from master base
`6309150a1afcb4d7ac10f69315937d6218be7f3a` into a temporary directory in this
worktree, with this worktree's dependency directories linked for module resolution.
The same benchmark dynamically loaded either that source or the changed source.
Those temporary source copies were removed. Commands:

```
bun packages/plugin/scripts/bench-host-stall-paths.ts master .stall-baseline/packages/plugin
bun packages/plugin/scripts/bench-host-stall-paths.ts fixed
```

Measured with **Bun 1.4.2**, **SQLite 3.54.0**, on macOS arm64. Blocked time is the
wall duration of each synchronous call on the main thread (not background worker
elapsed time). Both passes use the same synthetic source store and independently
seeded context stores:

| Synchronous operation | Master blocked ms | Fixed blocked ms |
| --- | ---: | ---: |
| Restart raw page, ordinal 149,000, 100 messages | 402.96 | 10.25 |
| Next anchored raw page, 100 messages | 6.15 | 10.12 |
| Full M0 materialization, including date lookup/tokenization | 141.69 | 129.61 |
| M1 new-compartment date render | 7.87 | 0.29 |
| Protected retirement, 70k historical units / 2 eligible | 32.05 | 1.15 |
| Missing indexed times: host-ID fallback M1 render | 17.26 | 0.36 |
| Unscoped autocommit behind separate-process 1,200ms writer | 1,203.49 | 1,198.76 |
| Transform-scoped autocommit behind separate-process writer | 251.73 | 251.61 |

The extra bounded candidates make the already-anchored page a little slower while
removing the restart's historical prefix cost. These timings do not claim a cold
3-second stall reproduction: disk cache state varies. Worker preparation elapsed
29,729.58 ms before and 948.21 ms after; neither is a synchronous serving-thread
scan. The main-thread read costs are listed separately above.

M0 is the cached baseline context; M1 is the new-compartment delta rendered after
that baseline. The fallback-date version renders that delta after indexed times
are removed, forcing the host-message ID lookup. The two raw pages' complete
UTF-8 JSON, M0 text, M1 text, fallback-date M1 text,
retirement count and complete compacted-tag-number list were compared directly
against master, **byte identical**, SHA-256:
`461725c0d5d161dbe186ff7b986d868ecf149ab0616839c153de6e2833175b7b`.
The unit range oracle now freezes master's OFFSET SQL rather than calling the
implementation under test to compute its own expected values. Existing mixed
postprocess wire differential and date/defer replay tests remain in the suite.
This compares the reader/renderer buffers that supply model context; it does not
capture a complete serialized provider HTTP request.

## Busy-lock behavior and known limits deliberately retained

`withAutocommitTimeout` does **not** spin in JavaScript: it invokes the native
operation once. SQLite's busy handler can synchronously wait for another process's
writer. Outside a transaction, foreground transforms have a **250ms shared turn
lease**, charged conservatively even for successful operation time. Background
writers have **25ms per attempt**. Async admission retries yield between attempts,
with a separate 16,500ms overall budget. Native timeouts are restored in `finally`.
Already-open transactions and writes outside either scope use the connection's
own busy timeout. Explicit unscoped BEGIN likewise keeps that timeout.

These writer contracts are intentionally retained because the dominant sampled
path is read-only and broad timeout changes would also change startup/tool
behavior. The concurrent writer probe shows the distinction: unscoped writes block
until the 1,200ms writer commits; foreground writes refuse around 250ms. This
remaining **unscoped main-thread blocking is a known limitation, not a fixed lock
stall or a new guarantee**. Concrete callers:

- `compaction-marker.ts`, `runMarkerRemovalTransaction` deliberately enters
  `withoutSqliteTransformPass`, with `MARKER_REMOVAL_BUSY_TIMEOUT_MS = 5000`. Owned/foreign
  marker deletion uses it. The degraded `injectCompartments` fork-orphan cleanup
  can reach `removeForeignCompactionMarker` inside a foreground transform but
  intentionally retains the deletion connection's full timeout.
- `persist-filtered-noise.ts`, `persistFilteredNoise` uses an immediate transaction
  without establishing a scope. `compartment-runner-incremental.ts` calls it for
  chunks empty after filtering; unscoped execution uses the connection timeout.
- `ctx-note/tools.ts` calls `storage-notes.ts`'s `dismissNotes`, whose default
  transaction does not establish a foreground/background scope. Direct tool-style
  transactions can synchronously wait with the original timeout.
- Synchronous `openDatabase`/`runMigrations` use native unscoped admission for
  pending migrations. The async opener dispatches pending migrations to a worker;
  startup admission and off-thread retry are different from the transform lease.

These paths deserve a separately scoped async/refusal design, not an accidental
behavior change caused by attributing every CTE SELECT to writer admission.

## Regression controls

Each control was applied only after staging the live implementation and confirming
an empty unstaged `git diff --stat`. Each deliberate defect had a comment marked
`NON-VACUITY BREAK` so it could not be mistaken for implementation code. Each named
exactly one failing test; other tests in its selected group stayed green. Restoring
with `git checkout -- <path> && touch <path>` produced an empty unstaged diff.

- Disable warmed rank seeking: `restarted raw pages seek warm ranks on 150k tied
  messages and cold pages refuse prefix scans` fails; the independent OFFSET/range
  equivalence test stays green.
- Remove the indexed-time unary `+`: `compartment dates seek boundary ordinals
  instead of all non-null session times` fails with a session/time range plan;
  the four date-content/disabled/replay tests stay green.
- Disable eligible tag-number index seeking: `protected trim discovery seeks only
  eligible tag numbers and preserves retired state` fails with a session-only plan;
  all four other retirement tests stay green.

The delivery declaration records the exact red names, captured output and restore
pairs. A separate fallback-primary-key control and final Linux gates are recorded
there as well.

## Final verification

All build/test/typecheck/lint gates ran on Linux with eight vCPUs. Bun 1.4.2,
TypeScript 5.9.3 and Biome 2.5.1:

- Plugin build passed, including v1/v2 worker bundles, declarations, and all nine
  unchanged generated TUI files. Pi build also passed to supply the worker bundles
  required by plugin bundle-review tests.
- Plugin typecheck passed all three tsconfig invocations. Lint checked 1,383 files,
  exit 0, with ten existing warnings and six informational suggestions outside
  the changed files.
- Full plugin suite: **7,787 passed, 27 skipped, 5 failed**, 7,819 tests across 783
  files. Four failures were missing Pi/OMP worker artifacts in the remote job;
  after building Pi, all worker-bundle review tests passed. The remaining unrelated
  `Node WASM Transformers fixture > builds with real fs and persists a model for
  offline reuse` failure is a temporary-directory dependency-resolution error:
  `Cannot find module 'onnxruntime-web/webgpu'` from the fixture's generated bundle.
  No WASM/dependency code was changed to mask it.
- Final focused run after building both packages: **397 passed, 2 skipped, zero
  failed**, 399 tests across six files: raw keyset pages, compartment injection,
  tag retirement, postprocess/replay differentials, SQLite acquisition routing,
  and worker bundle review. The two skips require unavailable Pi/OMP host executables.
- Fresh scoped diagnostics reported zero errors/warnings for analyzed files;
  graph-based inspection categories were unavailable. Repository typecheck is the
  authoritative TypeScript gate.
- All four mutation controls were restored before these final gates and commit.
  The full nine-file comment review reported no unclear code comments; the report's
  terminology was clarified in response to its prose suggestions.
