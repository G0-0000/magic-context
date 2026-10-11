# Pi large-session append cost: session-local tags and incremental identity

## Scope and evidence

Compared production context handlers at base `0f8f341c8c4b27df6bf9678e022250ef3a9b8ac4` and the implementation delivered with this report. Linux, 8 vCPUs, Bun 1.4.2. Synthetic Pi projection with a persisted system entry withheld from the hook, tool calls/results, reasoning, images, reused call IDs, and a lingering unadoptable fallback. The final projection contains **13,930 messages, 99,931 tags, and 5,105,660 served JSON bytes**.

A second **initialized** connection commits unrelated metadata before every pass. Six checkpoints warm the handler; 86,000 compacted, out-of-projection tags are then inserted. The first append absorbs those rows and is excluded from latency statistics. There are **64 subsequent two-message append samples**. Across all **71 passes**, 284 comparisons verify identical literal served JSON SHA-256, canonical output SHA-256, behavioral tag-row SHA-256, and served byte count. The oracle is the independent base handler, not an expected value derived by the new cache.

This is not a replay of private ANTAUTH data or a live provider test. In particular, its fallback median does not reproduce the live 116 ms / 2.5 s conflict workload. No live store or live configuration was opened. All database execution, suites and benchmarks ran on Linux against test-owned roots; no macOS Pi/OpenCode host was launched, so the host-PID `lsof` requirement was not exercised. The benchmark explicitly assigns all XDG roots, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, and the test data root below its throwaway directory. It removes that directory on exit.

## Before and after

Milliseconds; independent stage percentiles, not additive accounting:

| Stage | Before median / p90 | After median / p90 |
|---|---:|---:|
| Entire hook (`total`) | 517.542 / 637.110 | **302.677 / 344.652** |
| Tag snapshot including active projection | 114.929 / 136.428 | **2.832 / 3.404** |
| Fallback identity/adoption | 9.524 / 15.960 | 11.366 / 12.933 |
| Channel accounting | 112.458 / 140.466 | **59.515 / 66.472** |
| Post-transform phase (includes channel accounting) | 118.784 / 151.518 | **65.215 / 73.016** |
| LKG capture | 47.422 / 513.035 | 37.693 / 363.140 |
| Model-change timing label | 0.134 / 0.191 | 0.008 / 0.011 |
| Newly separated pressure resolution | not separately timed | 0.096 / 0.138 |

Whole-hook median improves **41.5%**, p90 **45.9%**. Fallback median is slightly worse in this fixture: exact primitive validation is not free, and the base already hashes very little when the lingering fingerprint matches no message. Do not interpret the new model-change timing as an equivalent speedup: the old timer included pressure handling and scheduler work.

## What changed

* **Tags:** the old reader discarded its full session snapshot on every foreign `data_version` change, including unrelated sessions and metadata. It now uses a full-row session revision beside the existing identity-only revision, in the same KV table and shared connection-only trigger installer. Identity/owner-summary semantics remain unchanged. The local changed-number journal supplies this connection's replacements; subtracting the local session counter from the shared session counter detects foreign writes to that session only. Inserts, deletes, renumbers, session moves, status/size edits and rollbacks are covered. Every reopened connection starts with a full load. The public snapshot API still returns editable copies; the handler's internal projection retains frozen row objects and publishes a new array on changes.
* **Fallback identity:** exact detached primitive-field comparison identifies the first changed input. Only the suffix gets fingerprints, tool-owner memberships and real-ID positions rebuilt. Historical fingerprint selection uses header buckets; writer-admitted expansion reuses those buckets rather than hashing or resolving all history again. Known tagged prefix messages no longer enter the tool-allocation guard. The issue-650 pairing, served-number survivor, refusal, once-repair and tagger-binding decisions are unchanged. Rewrites, reordered IDs, context edits, deletions and fallback-to-real settlement invalidate at the first exact mismatch. LKG's existing detached input fields are reused where temporal markers are disabled and thinking strips occur at the end; otherwise only identity-relevant primitive fields are flattened. Session teardown and a different database handle discard the index.
* **Hygiene:** cached tag attribution maps fold changed immutable rows instead of rebuilding every historical tag map. Canonically ordered old/new rows are compared by primitive number and row identity. Changed owners alone have their bounds recomputed. Duplicate-number/key legacy stores retain the full last-row-wins path. The already-required rendered-part walk also supplies the real-user count, removing its second walk.
* **LKG:** reuse the result of exact input-prefix validation for the same accepted in-memory slot, while retaining the digest-format fence. Foreign/reopened slots use the ordinary id/signature validation. Output validation and transactional persisted-chunk checks remain intact.
* **Model spikes:** `modelChangeDetection` previously spanned pressure reconciliation, recovery writes, rejected-usage full request tokenization and scheduling. Model seeding walks the branch only on restart. Legacy proven-floor re-derivation is also one-time. Pressure now has its own timing label. This fixture does not reproduce the live 990 ms spike, so it cannot distinguish SQLite writer contention from rejected-usage recovery in that historical sample.

## Remaining linear floor

The task owner explicitly approved retaining exact safety validation rather than introducing a host change protocol or redesigning LKG persistence. Fresh Pi clones and extension rewrites cannot safely be assumed append-only from IDs, lengths or timestamps alone: same-length text and nested tool arguments must be compared too. The following stage measurements bound the remaining visible-history work (inclusive stages overlap):

| Remaining work | After median / p90 (ms) |
|---|---:|
| Branch/event alignment, input field capture, stable-ID reusable set | 31.698 / 36.858 |
| Fallback primitive-prefix validation and indexed discovery | 11.366 / 12.933 |
| Transcript construction | 1.510 / 1.698 |
| Tag identity/source validation | 31.574 / 34.786 |
| Rebuilding § prefixes on fresh raw clones | 5.242 / 6.459 |
| Fresh mutation targets/proxies | 3.948 / 4.725 |
| Token-cache primitive validation | 19.478 / 22.844 |
| Token accounting, including the preceding validation | 20.720 / 24.723 |
| Stable-ID maps after commit | 2.103 / 2.576 |
| Compartment replay/injection | 2.197 / 3.188 |
| Dropped-placeholder scan | 0.378 / 0.462 |
| Processed-image replay scan | 0.692 / 0.908 |
| Reasoning replay/clear scans (each) | 0.232 / 0.266; 0.234 / 0.270 |
| Successful-transform/reusable-ID bookkeeping | 2.422 / 2.781 |
| Note index maps | 1.323 / 1.652 |
| Note/nudge postprocess | 3.434 / 4.281 |
| Final thinking-binding scans | 1.221 / 1.707 |
| Final rendered hygiene validation, attribution-delta comparison and protection checks | 59.515 / 66.472 |
| Assistant usage/work-metrics fold | 0.649 / 0.902 |
| LKG exact final-output capture, digest arrays, chunk hashing and persistence | 37.693 / 363.140 |
| Snapshot row-array copy/merge and active-tag projection (session tags, not only visible messages) | 2.832 / 3.404 |

No claim is made that the whole hook is now O(new messages). Identity rebuilding and tag SQL reads are incremental, but primitive validation, rendered output/proxy reconstruction and durable recovery bytes still scale with visible history; tag-array comparisons/protection still scale with the session's tags. A host-provided append/change protocol is the next structural prerequisite. LKG p90 remains high; persisted recovery-chunk hashing/writes are deliberately not replaced by an in-memory stamp.

## Foreign-writer coverage and known limit

These are TEMP triggers, not durable schema triggers. Current plugin and Pi runtime opens use shared `openDatabase`/`openDatabaseAsync` and install them. CLI `doctor store init` for a missing store, single-store migration, and fresh/salvaged database preparation use initialized opens as well. Ordinary existing-store doctor read/mutation helpers (`packages/cli/src/lib/database-access.ts`) **do not** initialize the connection. The Rust dashboard's read-write `rusqlite` opener (`packages/dashboard/src-tauri/src/db.rs`) **does not** install them either. Uninitialized raw SQLite clients and mixed-version older Magic Context processes lacking the full-row counter are outside this contract. Their same-session edits may remain cached until a recognized session change or reopening. No fallback session scan was added for those writers, per the task owner's decision.

The pre-existing sibling-probe test was changed to initialize its writer and name that prerequisite; its assertions that foreign tags are observed remain unchanged. This deliberately narrows the prior arbitrary-raw-writer contract, rather than silently promising cross-version invalidation.

## Reproduction

Archive base packages/scripts into a scratch directory **inside an isolated worktree**, link its package `node_modules` to the worktree's installed dependencies, and copy the current perf `run.ts` into the archive. This only gives both handlers the same isolation, delayed-seeding and literal-wire-hash instrumentation; runtime source remains independently versioned. Run on Linux with 8 vCPUs:

```sh
POINTS="$(python3 -c 'print(",".join(map(str,[2500,5000,7500,10000,12500,13800]+list(range(13802,13930,2)))))')"
# Run once with each handler's run.ts, producing before.json and after.json:
bun packages/pi-plugin/scripts/experiments/perf/run.ts \
  --messages 13930 --points "$POINTS" --pi087 --external-writes \
  --lingering-fallback --historical-tags 86000 \
  --historical-tags-after-messages 13800 --tool-result-repeat 30 \
  --output <before-or-after.json>
bun packages/pi-plugin/scripts/experiments/perf/summarize-append.ts before.json after.json
```

Seeding 86,000 hidden tags before bulk cold warm-up exceeded the base's 25-second outcome budget during allocation. Delayed seeding avoids benchmarking that unrelated cold-allocation limitation; it does not change the production deadline. The base and optimized append outputs were then compared without weakening the deadline.

## Verification

* Root `bun run typecheck`: passed, TypeScript 5.9.3; four package scripts, including plugin script typecheck.
* Root `bun run lint`: passed, Biome 2.5.1; 1,376 plugin, 304 Pi, 138 CLI and 6 retina files. Existing warnings/infos remain.
* Pi package suite: **1,970 passed, 28 skipped, zero failed**, 1,998 tests across 204 files, Bun 1.4.2. Frozen view consumers, issue-650 behavior and real-change regressions are covered.
* Root `bun run build`: passed on Linux, including plugin, Pi and CLI bundles; TUI checked nine files with no changes.
* Plugin suite after building required worker artifacts: **7,691 passed, 27 skipped, two failed**, 7,720 tests across 779 files. One is the pre-existing offline Node WASM fixture (`onnxruntime-web/webgpu` unavailable from the throwaway wrapper); this same test was reproduced against the archived base. The writer-diagnostics timing test was flaky in the parallel suite; its five-test file passed twice in isolation. No unrelated code was changed to mask either failure.
* Shared owner-summary/writer diagnostics narrow gate: **18 passed**, 168 assertions, including status-only stability, foreign identity edits and the uninitialized-writer residual contract.
* Scoped AFT diagnostics: six implementation files covered, zero diagnostics. Non-diagnostic call-graph categories were unavailable; authoritative root typecheck is the gate.

## Mutation controls

Each control used the staged live implementation as its restore point, recorded a non-empty `git diff --stat` during the mutation, ran the named tests, then used `git checkout -- <path> && touch <path>` and recorded an empty unstaged diff. Mutants carried the literal `NON-VACUITY BREAK` marker and were never committed.

* Ignoring foreign session revisions reddened only `100k-tag snapshots ignore foreign metadata and other sessions, but reload foreign same-session edits and reopened connections`; `tag snapshots refresh only changed numbers on append and preserve canonical bytes` remained green.
* Reusing fallback fingerprints by ID without comparing primitive fields reddened only `fallback index discards stale fingerprints, positions and owner aliases on same-length extension rewrites`; the 13,800-entry append bound and context_edit/reorder/deletion/settlement parity controls remained green.
* Ignoring replaced immutable tag rows reddened only `immutable hygiene tag attribution extends appends and rebuilds rewritten, deleted and reowned rows`; the combined real-user counting control remained green.
* Blessing every LKG input as an exact reusable prefix reddened only `LKG own-slot digest reuse stops at a same-id same-length input rewrite`; the append-only digest-reuse control remained green.
* Rebuilding the fallback index from zero on every pass reddened only `fallback index rebuilds only appended messages at 13,800 entries`; context_edit/reorder/deletion/settlement parity remained green. This proves the append work-bound check is not vacuous.
* After restoring all five mutations, the focused five-file gate passed **50 tests, 459 assertions**, with Pi typecheck and lint green again (TypeScript 5.9.3, Biome 2.5.1). The repository's frozen-lockfile test install checked 1,013 installs across 1,254 packages without changes.
