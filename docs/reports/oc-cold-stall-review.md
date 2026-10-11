# OpenCode cold-session stall correctness review

Subject: `881fa02095f56ed2156b35195258447566a51669..9fd10c8085893746aca06b9d68f97473a118654b`.

The performance report is not a correctness certificate. This review found four reproducible counterexamples. No product code was changed. All witnesses and positive controls are in `packages/plugin/src/hooks/magic-context/oc-cold-stall-review.test.ts`, disabled unless `MC_OC_COLD_STALL_REVIEW=1`.

## Findings

### P1 — The new owner wait can serve a stale reasoning-removal set

- **Location:** `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:2707` (new suspension), `:2358-2361` (snapshot before suspension), `:2782-2818` (conditional committed-union reread), `:4223-4229` (final application).
- **Failing test:** `cold stall independent review > a cold owner wait replays reasoning removals committed by a peer before serving`.

The pass reads persisted reasoning removals into a local set, then awaits the cold owner digest. Another connection can commit a removal during that await. If the digest stays cold, `budgetCutoff` is zero, no new IDs are selected, and the committed union is never reread. Final representation applies the stale local set and serves the reasoning that the other connection has just removed. The following ordinary defer reads the committed set and removes that reasoning again: the two served JSON strings differ.

The witness uses two actual connections to the same WAL context database. Only the owner wait is stubbed, to model an unavailable/slow worker and deterministically place the peer commit at the new suspension point. The peer uses the real `addRemovedReasoningIds` persistence API. Assertions establish that the wait was reached, the union is durable, and the following defer really omits the part before comparing served bytes. The failing output contains `Previously removed private chain of thought.` on the racing pass and not on replay.

This requires overlapping same-session work across connections/processes; it is not a claim that a single serialized session resurrects reasoning without a concurrent writer. There is no cross-process turn lock in this witness. The new await introduces a suspension into the previously synchronous snapshot-to-selection stretch.

### P1 — A reused worker seed certifies an incorrect large-session ordinal

- **Location:** `packages/plugin/src/hooks/magic-context/read-session-raw.ts:1247-1253` and `:1271-1280`.
- **Failing test:** `cold stall independent review > file worker rewarm excludes a finished summary moved into a warm large session`.

The worker reuses summary candidates when its remembered rowid anchors survive. Moving a previously stored finished summary from another session into the destination does not append a row above those anchors. The summary's ID is absent from the seed. The rank-building SQL evaluates the exclusion predicate only for candidate IDs and assigns `excluded = 0` to every other row. A fresh, successfully installed checkpoint therefore counts that finished summary as a normal ordinal.

The fixture has 1,024 ordinary destination messages and a summary inserted earlier in another session. It warms the destination, moves the summary using another connection, and successfully rewarms. An independent full JSON-predicate count gives **1,024**, but the warm APIs return **1,025** for the total, the last message's ordinal-by-ID, and its hydrated raw-message ordinal. There is no deferral or exception. Forgetting the candidate seed and preparing again restores **1,024** on the same database, before the assertion against the captured wrong answers goes red.

The old candidate cache at `881fa020` already had the session-move limitation; the changes through `9fd10c80` do not generally fix it for file-worker checkpoints. The existing small randomized witnesses now pass because bounded serving-thread reads inspect their small prefixes directly. They do not establish that a reused large-session worker seed is exact. This is an unfulfilled exact-ordinal claim, not a claim that the old large-session candidate cache was correct. These are the shared ordinal primitives used by raw reads and downstream boundary consumers; a separate end-to-end historian/`ctx_expand` boundary-shift trace was not run.

### P1 — Incremental indexing's second writer can refuse a foreground turn

- **Location:** `packages/plugin/src/features/magic-context/message-index-async.ts:405-433`, `packages/plugin/src/hooks/magic-context/raw-ordinal-warmup-worker.ts:23-54`, and `packages/plugin/src/shared/sqlite.ts:932-933,984-994`.
- **Failing test:** `cold stall independent review > incremental indexing worker does not make a concurrent foreground turn refuse with SQLITE_BUSY`.

Moving insertion/COMMIT to another connection permits the serving thread to attempt writes while its own background indexer holds SQLite's writer lock. Background acquisition retries do not bound the duration of the acquired indexing transaction. The foreground transform has a 250 ms acquisition budget and can exhaust it before the indexer finishes.

The witness runs the real indexing worker, with a synthetic 60 MB indexable message to make the overlap reproducible. It observes the durable dirty floor and uses a native zero-timeout `BEGIN IMMEDIATE` probe to establish that the worker actually holds the writer lock. It then runs a normal new-session transform inside the real foreground SQLite pass scope. No fake busy error or artificial sleeping lock holder is used.

The transform raises:

```text
SqliteAcquisitionBusyError: SQLite writer acquisition remained busy
stage: "autocommit", code: "SQLITE_BUSY"
SQLiteError: database is locked
at ensureSessionMetaRow / getOrCreateSessionMeta / transform.ts:875
```

The registered OpenCode messages wrapper maps that transient error to `StorageBusyRefusalError` when compaction is enabled (`packages/plugin/src/plugin/messages-transform.ts:617-632`). Thus the patch's own maintenance writer can refuse a turn; catching/retrying errors in the indexer's scheduler does not protect the foreground writer. The stress fixture proves the concurrency failure mode, not its frequency or message sizes in the inaccessible real 39 GB store. The lock spans indexing and COMMIT; the test does not attribute all hold time specifically to COMMIT.

### P2 — In-memory owner summaries permanently skip tags after a large append

- **Location:** `packages/plugin/src/features/magic-context/storage-tags.ts:1144`, `:1153-1158`, and `:1163`.
- **Failing test:** `cold stall independent review > in-memory owner digest includes every tag after an append larger than its page limit`.

The append query now has an unconditional `LIMIT 513`. Only main-thread **file-backed** readers reject an oversized page. An in-memory reader folds those 513 rows, advances `globalLastRowId` to the actual table maximum, and returns the truncated digest as complete. Later reads no longer fetch the skipped rows.

Warm one tag, append 600 more, and compare the owner estimate map with an independent `COUNT(DISTINCT message_id)`: expected **601**, received **514**. This is a newly introduced regression in the retained in-memory path. It is not evidence of the same truncation on the normal file-backed OpenCode store, which does throw/defer. It also does not prove a production cutoff change: the current whole-message reasoning cutoff implementation does not consume the optional estimate map for pricing.

## Served-byte differential and positive controls

An eight-pass **full `createTransform`** fixture dynamically loads the complete plugin source from the baseline snapshot and the reviewed tree, with separate context databases and one synthetic raw store. It compares actual serialized served message arrays, not two calls to a shared cutoff implementation.

Sequence: cold first pass, pure defer, execute with materialization, defer replay, explicit flush on defer, a cache-losing HARD model fold, close/reopen restart, and first touch of another session six clock-hours later. The HARD step asserts that an actual `reason=model_change executed=true` fold was logged. Both engines must actually remove older reasoning and persist a nonzero materialized watermark, so an inert fixture cannot pass as a byte-parity result.

All **eight outputs were byte-identical** to `881fa020`; byte lengths were `8123, 8123, 8123, 8123, 8123, 8145, 8145, 8145`. This fixture did not deliberately delay workers beyond the 250 ms owner-wait deadline, so it is not a timeout-stress differential. A separate file-backed positive control forces the owner wait to report unavailable: the first cleanup with no prior cutoff selects nothing, a subsequent warm cleanup matches a full in-memory computation, and reopening cold on defer replays the persisted reasoning-removal bytes unchanged. A large first turn with no persisted boundary also remained servable while the preparation callback reported unavailable.

Those controls support the single-writer replay/no-approximation behavior exercised here. They do not address a peer's committed reasoning-removal set becoming stale in an awaiting pass and restoring reasoning on the wire, or establish that every kind of bust waits exactly twice for 250 ms. The source's early wait is gated by history rebuilding; model HARD folds are recognized later in postprocess, so the report's timing language should not be treated as a tested universal two-wait guarantee.

## Execution and isolation

All builds, typechecks, lint checks, and test execution were on Linux with `runon: "linux,8c"`. Versions: Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**, Node **v24.21.0**. Package-test commands did **not** export `OPENCODE_DB`; fixture tests temporarily set it themselves to their own synthetic store or an absent throwaway path and restore it afterward. No live store was opened, copied, read, or migrated.

The only standalone Node dist smoke ran with all six isolation variables (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`) under `/tmp/magic-context/oc-cold-stall-review-nkiHb5/`. Its in-process `lsof -p <pid>` assertion printed only this database path:

```text
MainThrea   2 motor-job  20u REG 9,5 12288 1879184403 /tmp/magic-context/oc-cold-stall-review-nkiHb5/opencode.db
```

The Pi dist entry imported successfully and the newly built `raw-ordinal-warmup-worker.js` returned an exact one-row scan under Node: **2 smoke checks passed**. This is an artifact/runtime import check, not a complete Pi/OMP host conversation. The initial eval smoke inherited `--input-type=module` into the worker and failed with `ERR_INPUT_TYPE_NOT_ALLOWED`; clearing `execArgv` for that eval-only harness corrected it. No product change was made for that harness failure.

## Verification and reproduction

Passing existing coverage:

- `bun test` on `cold-session-warmup.test.ts`, `storage-tag-owner-summary.test.ts`, and `oc-stall-r2-ordinal-review.test.ts`: **29 passed**, 3,873 assertions. Includes the existing three 6,000-step randomized differentials.
- `bun test` on `raw-ordinal-warmup.test.ts`, `oc-stall-r2-warmup-review.test.ts`, `message-index-async.test.ts`, `message-index.test.ts`, and `oc-stall-r2-served-review.test.ts`: **36 passed**, 156 assertions. Includes startup failure/backoff, no-result timeout, shutdown cancellation, persisted dirty floors, failed replacement reconciliation, overlap deduplication, and prior served-byte goldens.
- `bun run --cwd packages/pi-plugin build` and `bun run --cwd packages/pi-plugin typecheck`: passed; worker artifact emitted. `typebox-bundling.test.ts`: **2 passed**, 5 assertions.
- `bun run --cwd packages/plugin typecheck`: passed (three TypeScript project checks).

The four finding-specific tests above assert the intended behavior and intentionally fail on the reviewed product code when enabled with `MC_OC_COLD_STALL_REVIEW=1`; the three positive controls pass. The final enabled run had **3 passed, 4 failed, 31 assertions**, with only the four named counterexamples failing. With the flag unset, all **7 tests skip**, preserving ordinary package-suite behavior. The final focused Biome check passed for **1 file** using the plugin's explicit config; running it from the repository root without that config initially hit the existing nested-root configuration error. AFT inspection was partial because its checkout call graph was unavailable, so TypeScript's project typecheck was the authoritative diagnostic gate.

To repeat the full differential, materialize baseline `881fa02095f56ed2156b35195258447566a51669` sources **inside the checkout running these tests**, not in another operator-owned checkout:

```sh
mkdir .review-base
git archive 881fa02095f56ed2156b35195258447566a51669 \
  packages/plugin/src packages/plugin/package.json packages/plugin/tsconfig.json \
  packages/retina-local-fs | tar -x -C .review-base
ln -s ../../../packages/plugin/node_modules .review-base/packages/plugin/node_modules
MC_OC_COLD_STALL_REVIEW=1 MC_OC_COLD_STALL_BASE_ROOT="$PWD/.review-base" \
  BUN_JSC_useOMGJIT=0 bun test \
  packages/plugin/src/hooks/magic-context/oc-cold-stall-review.test.ts --timeout 60000
```

`MC_OC_COLD_STALL_BASE_ROOT` is optional: without it only the baseline differential skips, not the four failing tests named under Findings. The snapshot is temporary test input, not part of the delivery. For example, append `--test-name-pattern 'file worker rewarm excludes'` to isolate the wrong-ordinal failure (1,025 instead of 1,024).

## Limits

There was no real-store or full OpenCode/Pi host replay and no throughput benchmark. The existing FTS durability/overlap suites and the new real-worker writer-conflict test are not an exhaustive crash/restart matrix of two independent Pi/OpenCode processes. The per-session tag identity revision tests passed in the owner-summary suite, but no separate Pi-process revision stress test was added. Explicit historian, wrapup, recomp, and `ctx_expand` timeout rules were source-reviewed; this review does not claim end-to-end passing fixtures for every such caller. No production fixes, manifest changes, or changes to `ARCHITECTURE.md`/`STRUCTURE.md` are included.
