# Independent correctness review: Pi incremental append work

## Verdict and scope

Reviewed **873ee68257a9075b4c09a386331d2519350b615b** against master **0f8f341c8c4b27df6bf9678e022250ef3a9b8ac4**, after reading `pi-session-local-append-cost.md`. This is a **report-only** delivery; no runtime, existing test, architecture, or structure file is changed. Reproduction assets live in `docs/reports/pi-append-cost-review/`, outside the package suites.

**Do not treat the snapshot as correct for every initialized writer yet.** There is a new current-version clear/recreate revision alias, a new foreign `REPLACE` invalidation hole, and a new hygiene duplicate-key transition discrepancy. The explicitly documented uninitialized-writer limit is also real. Ordinary initialized DML, append output, exact extension-content validation, LKG digest reuse, and the existing issue-650 contracts passed the checks below.

All database execution, builds, suites, and mutation runs were on Linux with `runon: "linux,8c"`. No Pi/OpenCode/macOS host was launched, and no live store or live configuration was opened, read, written, or migrated. Temporary roots were removed after execution. The remote runner refused one setup containing an archived root lockfile plus symlinked `node_modules`; removing the archive's root manifest/lockfile corrected the setup, without a local test fallback.

## Findings by severity

### High — an initialized foreign clear/recreate can reuse the cached full-row revision

**New regression.** `deleteTagIdentityRevisions` now deletes `tag_revision:<session>` when no tags remain (`packages/plugin/src/features/magic-context/storage-tag-identity-revision.ts:86–93`). The next insertion starts that counter at one again. Pi compares only `[local, total - local]`, not a session incarnation or authoritative row shape (`packages/pi-plugin/src/tag-snapshot-pi.ts:43–56,86–107`). A reader that never observes the empty interval can therefore see exactly the same revision for different rows.

Minimal observed sequence, using initialized connections throughout:

1. Foreign connection inserts `(message=before, number=1, active)`. Reader caches external revision **1**.
2. Foreign connection calls the **production `clearSession` helper**, which deletes the tags and their revision key.
3. Foreign connection inserts `(message=after, number=7, dropped)`, restarting revision **1**.
4. Reader returns the old active §1 row. Full reload returns only the dropped §7 row.

Failing test: **`review initialized foreign clear and recreate must not alias a cached revision`**. It passes against the archived base reader. Clear routes through `storage-meta-session.ts:318–337` and `storage-session-tables.ts:110–137`; this is not an unsupported raw-client scenario. Clone can repopulate a cleared destination with preserved tag numbers (`storage-clone.ts:456–485,545–606`), making the same counter-reset pattern relevant to reimports/clones as well.

The stale row reaches the active heuristic projection and Channel-1 accounting (`context-handler.ts:8730–8733,8792–8825,9768–9784`). The test proves stale identity/status/size at the actual snapshot API, **not** a measured wrong provider request from a live host. Such stale inputs can select or omit the wrong reclamation candidates or report obsolete tag identities; SQL-backed replay elsewhere does not make this snapshot equal to the store.

**Recommendation:** retain a monotonic full-row revision through clear, or fence it with a never-reused session incarnation. Checking the revision once per pass is insufficient when the revision itself resets.

### Medium — initialized foreign `REPLACE` can delete an old session row without invalidating it

**New regression for foreign writes; an inherited local-journal variant also exists.** SQLite's replacement conflict deletes do not invoke DELETE triggers with the normal `recursive_triggers=OFF` setting. Both journal and shared full-row installer depend on those DELETE triggers (`tag-snapshot-pi.ts:25–40`; `storage-tag-identity-revision.ts:62–74`). An explicit-id `INSERT OR REPLACE` moving a row from session A to B bumps B's insertion revision but leaves A's full-row revision unchanged.

Failing new test: **`review initialized foreign REPLACE session move invalidates the old session`**. A still serves the deleted original §1 row instead of `[]`. This passes at base, whose foreign `data_version` fence sees the replacement commit. The sibling same-session replacement control remains green: **`review initialized foreign REPLACE renumber must remove the old snapshot row`**.

The local counterpart, **`review initialized local REPLACE renumber must remove the old snapshot row`**, leaves both the phantom old §1 and replacement §7 with the same database id in the snapshot. It fails at **both** base and reviewed commit: the old-number deletion was already absent from the journal. Do not attribute that local defect to this optimization.

I found no ordinary production `insertTag`/adoption path issuing tag `REPLACE`; they use inserts, updates and explicit deletes. These probes exercise valid prepared SQL on initialized current-version connections and disprove the broader “every tag write” claim, rather than establish a currently common product flow. **Recommendation:** either cover replacement deletion semantics or explicitly prohibit this SQL form on tag writers. A `db.prepare` call is not itself a bypass; the implicit, untriggered delete is.

### Medium — hygiene does not preserve last-row-wins on the transition into duplicate keys

**New regression.** The delta attribution path invalidates only when the *previous* cache is already non-simple (`tail-hygiene-walk-pi.ts:407–413`). If a simple cache receives a new lower-number row with the same message key as an unchanged higher-number row, insertion overwrites the message map with the lower row and only then sets `simple=false` (`:460–479`). Canonical full recomputation would let the later, higher-number row win. A subsequent read of the identical tag array returns the incorrect map immediately (`:386–387`).

Failing test: **`review hygiene transition to a lower-number duplicate key retains canonical last-row-wins`**. Starting from active `user:p0` §10, then adding dropped `user:p0` §1 before it, the cached walk reports **§1/dropped/U=0** while the uncached full walk reports **§10/active/U=5** for the same unprefixed extension-rewritten text. Both tag arrays are canonical and immutable. The current schema permits duplicate message keys: the composite uniqueness fence is for owned **tool** tags, not message tags (`migrations.ts:660–662`). This is also within the report's advertised legacy duplicate-key handling.

**Recommendation:** detect duplicate keys in the resulting projection before applying a simple delta, or reconstruct the canonical winner for each dirty key, including unchanged competing rows. The existing test covers replacements/deletions/reownership but not the first transition into duplicates.

### Low / defensive invariant — removing a duplicate stable ID loses surviving fallback memberships

**New helper discrepancy; no valid-host production request was demonstrated.** `pi-fallback-index.ts:64–66` forces a full rebuild when the *new* input contains duplicate IDs. It does not force one when the *prior* input contained duplicates but the new input no longer does. Removing the duplicate suffix calls `positions.delete(old.id)` and deletes set membership also owned by the retained prefix (`:77–87`).

Failing test: **`review removing a duplicate stable ID preserves surviving fallback owner and position`**. Warm `[same, same]`, then update to `[same]`: fingerprints survive, but owner membership disappears; the position is removed as well. A cold index retains both. The owner assertion is the first failing assertion.

Real Pi entry IDs should be unique; LKG preparation also records duplicate-entry failure (`pi-lkg.ts:453–465`). I have not established that the production pipeline admits this fixture as a successful served request. Keep this distinct from the confirmed snapshot bugs. **Recommendation:** remember prior duplicate state and rebuild when leaving it, or enforce/reject duplicate IDs at the index boundary.

### Documented compatibility limit — a raw or older foreign writer really can leave status/drop-mode cached

Failing test: **`review raw foreign drop must reach snapshot even without a TEMP installer`**. After warming an active/full row, an uninitialized connection commits dropped/skeleton_real; Pi still returns active/full. The base reader passes this test. This is the contract narrowing already disclosed by the implementation report and commit message, not an undisclosed installer omission in the main current-version opens.

For an uninitialized writer, all of inserts, status/mode/size changes, deletes and identity changes can miss the new session counter. Wrong-number or wrong-drop decisions are possible wherever the stale snapshot or cached fallback probes are consulted, although a separate SQL replay can observe some of those changes. Reopening forces a cold snapshot; an unrelated initialized write need not rescue it. No product fix was made here.

## Snapshot write coverage and differential

The normal full-row counter has INSERT, unrestricted UPDATE, and DELETE triggers; updates moving a session bump both sessions. The local journal records both old and new numbers/owners' sessions. Both roll back with the statement. Transaction reads bypass publication and do not consume journal entries. Public reads return copies; borrowed rows are frozen and changed rows receive new identities.

| Write source | Observed route / coverage |
|---|---|
| Own inserts, tag allocation, size/token/reasoning updates | `storage-tags.ts` helpers use the supplied initialized handle; unrestricted local UPDATE/INSERT triggers observe raw prepared statements too. |
| Status and drop-mode updates, ordinary deletes/renumbers/moves | Local journal and full-row triggers observe these. Renumbers/moves journal old and new keys. `REPLACE` implicit deletes are the exception above. |
| Historian queued drops | `pi-historian-runner.ts:1433–1512` commits compartments and `queuePreparedCompartmentDrops` on its injected `db`; queueing alone does not alter a tag row. The following admitted application pass mutates tags. |
| `ctx_reduce` | `tools/ctx-reduce/tools.ts:293–305` writes `pending_ops` on injected `deps.db`. `apply-operations.ts:338–529` transactionally writes chosen drop mode/status on successful application; protected/deferred work remains pending. |
| Issue-650 repair/adoption | `storage-tags.ts:2308–2443` uses updates and explicit duplicate deletes on the supplied handle; existing survivor-number, pending-drop, once-repair and refuse/serve contracts pass on both runtimes. |
| Emergency and routine drops | `heuristic-cleanup-pi.ts:453–500` calls status/drop-mode helpers on the pass handle after a successful visible mutation; those writes are journaled before the next read. |
| Clear / clone | Ordinary deletes and clone inserts are covered, **but deleting the revision key on clear creates the alias above**. Clone's destination-empty guard is not a reader-incarnation fence. |
| Second current Pi / OpenCode / dreamer extension process | Pi's boot uses `openDatabaseAsync` (`index.ts:1182`). Shared synchronous/async opens install the trigger at `storage-db.ts:2546,2702,2838`; normal tag-writing extension handles therefore install it. The migration worker also initializes its connection (`migration-worker.ts:35–37`). |

The independent randomized differential runs **15,000 operations** (three xorshift seeds: `0x650`, `0xcafe`, `0x5eed`), over three sessions and four independently initialized SQLite connections. It compares **literal `JSON.stringify(snapshot)` to `JSON.stringify(getTagsBySession)` after every operation**, including local transactional reads and after commit/rollback. Operations include append, status/mode updates, size/token/reasoning updates, deletion, renumber/rename, session move, tool-owner/type/fingerprint updates, bulk compaction, clone insertion, multiple writes before a read, unrelated metadata, and session tag deletion. It passes: the finite ordinary-DML domain is equivalent.

That randomized domain deliberately does **not** include revision-key cleanup or replacement-conflict deletion; dedicated adversarial tests cover those and fail. Consequently the requested universal freshness condition is **not met**, notwithstanding 47k passing assertions in the randomized/control run. Foreign connections exercise SQLite's per-connection TEMP-trigger boundary; they are not four independently booted host processes or a stress test of concurrent commits.

## OpenCode owner summary

The identity revision SQL is unchanged in selectivity. It still watches `id, session_id, message_id, tag_number, type, tool_owner_message_id, reasoning_token_count`, excluding status/drop mode/sizes/ordinary token counts. The added full-row counter uses a different key. The owner summary selects exactly its identity/reasoning columns (`storage-tags.ts:757–764,981–1016`) and retains its row-shape and identity fences; no full-row semantics were substituted into it.

The complete owner-summary file passed **13 tests / 153 assertions**, including status-only stability, append/update/delete/replacement behavior, foreign identity writes and the existing uninitialized-writer residual contract. No new owner-summary regression was observed. The Pi clear/recreate failure should not be generalized to that separate cache, which also checks authoritative row shape.

## Served bytes, fallback index, hygiene and LKG

`served-bytes.ts` executes independently archived **base runtime source**, not a full-index instance of the new implementation. Both handlers get the same current perf instrumentation and fresh, separate synthetic stores. It checks the **literal served JSON files**, wire SHA-256 and behavioral tag-row hashes at every pass. Compaction/context-edit timestamps are fixed; a first experimental compaction comparison used wall-clock timestamps and differed only because the fixture constructed different timestamps for the two runs. That fixture error was corrected before accepting parity.

The final run passed **77 literal JSON comparisons + 77 behavioral tag-row comparisons + 77 wire-hash comparisons**: 72 accumulation checkpoints followed by a same-ID extension rewrite, revert, context-edit deletion, revert after context-edit, and a host `buildSessionContext` compaction contraction. The synthetic branch contains a persisted system entry withheld from the context event, tool calls/results, reasoning, images, reused call IDs and a lingering fallback. The final append projection has **13,930 messages**, **13,931 tag rows**, and **4,604,108 served canonical JSON bytes**. This independent run does not reproduce the earlier report's additional 86,000 hidden tags or timing claim. The existing snapshot stress test separately exercises 100,000 rows.

The exact-ID/primitive comparison invalidates the fallback suffix for same-length text and nested tool arguments, IDs settling, reorder/deletion and context edits. Historical header buckets and tool-owner memberships agree with a cold index in the ordinary unique-ID controls. The old full owner-map rebuild is not equivalent in the duplicate-to-unique case described above.

LKG's new digest fast path is gated on its own accepted slot, matching digest-array lengths, exact input-prefix validation and a nonlegacy digest fence (`pi-lkg.ts:994–1055`). Foreign/reloaded slots retain the ordinary id/signature path; output-field validation and durable serialized-output/chunk checks are unchanged. No LKG regression was found. The planted unsafe-prefix mutant does change the accepted input digest and is caught. The combined real-user count matches the old separate walk in its existing control. Hygiene equivalence holds for the existing canonical unique-key immutable-row controls, **not** the newly reproduced duplicate-key transition.

Issue-650 conflict behavior was checked separately against both revisions: **110 pass / 18 skip / 0 fail** at base; those same cases plus the five optimization files give **160 pass / 18 skip / 0 fail** at HEAD. Cases include identical same-millisecond pairs, served-number survivors, no-proof refusal, once-repair, pending drops surviving byte-identical defer passes, compaction conflicts and execute application. The 18 opt-in publication/OMP interop tests remain skipped by their existing gate; no external OMP host was launched. This is not an assertion of a live concurrent-provider replay.

## Named uninitialized-writer limit: which producers actually write tags?

| Producer today | Actual tag-write activity / stale-snapshot consequence |
|---|---|
| Existing-store CLI doctor mutation helpers | `database-access.ts:102–155` does not install the TEMP revision triggers. The inspected v22 retry/rekey, migration-recovery, session/project move and doctor metadata helpers do **not** mutate tag rows. Project-identity merging discovers `project_path`/`project_identity` columns (`storage-identity-merge.ts:4,57–82`); `tags` has neither. No active tag-number/drop mismatch was established from these ordinary doctor helpers today. Merely opening read-write is not a tag writer. |
| CLI doctor missing-store initialization / migration preparation | Uses initialized opens. There is no pre-existing reader snapshot for a missing store. Tag-affecting schema work is not an ordinary uninitialized same-session edit. |
| CLI doctor repair/salvage | External SQLite `.recover` **does recreate tag rows**, but in a fresh scratch database from a copied recovery snapshot (`doctor-repair-db.ts:296–329,581–620`). Recovered/fresh preparation calls `initializeDatabase` before migrations (`:403–420,464–467`). The command checks holders before backup and again before replacement (`:565–567,674–682`); it is not intended to mutate an actively served database. No accepted live-tag-cache coexistence was established for this path. |
| CLI `doctor single-store migrate` / Rust `ck-mc single-store-migrate` | The migration copies named memory/note/compartment/etc. `mc_*` tables, **not tags or mc_tags** (`single_store_migrate.rs:649–669`; `single_store_schema.rs:71–93`). The CLI performs database/RPC/Pi holder checks first (`doctor-single-store.ts:145–157,266–283`). This command is not an uninitialized tag writer today. |
| Rust dashboard | It has writable native connections but its tag access is a read-only table count (`packages/dashboard/src-tauri/src/db.rs:8627–8645`). Its dynamic write SQL changes memories/embeddings, not tags (`:6423–6440,6506–6513`). No tag-number/drop staleness producer was found in today's dashboard. |
| Raw SQLite clients | They can write any tag column/delete/insert without the TEMP installer. The raw foreign drop reproduction above proves an actual missed status/mode update. Renumbering, reownership and deletion can similarly leave obsolete snapshot identities. |
| Older Magic Context Pi/OpenCode versions | They actually allocate/update/delete tag rows in their normal transforms but do not maintain this new full-row key. The schema version did not change here; an older same-schema process can coexist. Its identity-only counter is not a substitute for the Pi full-row counter. A stale number/status/drop is possible, as with the raw probe. This is the knowingly narrowed compatibility contract. |

The documented limit should distinguish **capable of writing** from **currently writes tags**. I did not run CLI repair or dashboard against real user data; all of the inventory above is source review. Live repair holder discovery is best-effort safety machinery, not a mathematical guarantee against an out-of-band writer.

The writable branches of `auto-search-worker.ts` and `raw-ordinal-warmup-worker.ts` are also outside the installer, but write embeddings and message-index state respectively, not legacy tags (`auto-search-worker.ts:99–140`; `embedding-backfill.ts:39–69`; `raw-ordinal-warmup-worker.ts:23–70`; `message-index.ts:630–691`). Their tag/ordinal scans are read-only. Native Rust production tag mints/token updates use **`mc_tags`**, not legacy `tags` (`crates/mc-store/src/lib.rs:9415–9506`); the native context-write fence omits `tags` (`context_writes.rs:34–43`). These are not additional current legacy-tag writers silently bypassing the Pi revision. Host-side OpenCode Rust-mode postprocessing still receives the JS tagger (`rust-mode-transform.ts:4317–4319`); that handle must be distinguished from the native SQLite connection.

## Gates and baseline failures

Linux **Bun 1.4.2**, **TypeScript 5.9.3**, **Biome 2.5.1**. Root scripts were run through the repository's named commands; installed package tool binaries were used for the report assets.

* `bun run build` — passed; plugin/Pi/CLI artifacts built, TUI checked 9 files with no changes.
* `bun run --cwd packages/pi-plugin test` — **1,970 pass / 28 skip / 0 fail**, 1,998 tests across 204 files.
* `bun run --cwd packages/plugin test` — **7,691 pass / 27 skip / 2 fail**, 7,720 tests across 779 files. The offline Node-WASM fixture cannot resolve `onnxruntime-web/webgpu` from its temporary built wrapper. The second failure is `slow embedding aborts at the deadline, freezes skip bytes, and cannot land late`: 3,228.845 ms against its 3,150 ms bound under the parallel suite.
* Shared-suite failure check at **both HEAD and archived base** — 9 tests / 31 assertions each; **8 pass / 1 fail** on each. The WASM failure reproduces unchanged at base; the embedding deadline test passes in isolation at both (about 3,026 / 3,020 ms). Neither test was altered.
* An initial plugin suite run inherited a fixed `OPENCODE_DB` override and produced 207 fixture-addressing failures. Those tests deliberately change XDG to point to their own synthetic OpenCode database; the fixed override defeated that addressing. The corrected remote suite leaves OpenCode resolution to the package's isolated preload/fixture XDG roots. This was an environment correction, not a code correction, and no host/live run occurred.
* Frozen-lockfile install in the package test scripts — checked **1,013 installs / 1,254 packages**, no manifest/lockfile changes.
* `bun run typecheck` — passed, all four package scripts, including plugin script checking.
* `bun run lint` — passed: **1,376 plugin / 304 Pi / 138 CLI / 6 retina files**; existing warnings/infos remain.
* Restored five optimization files plus issue-650 files — **160 pass / 18 skip / 0 fail**, 1,055 assertions, 178 tests across 15 files. Owner summary — **13 pass**, 153 assertions. Archived base issue-650 files — **110 pass / 18 skip / 0 fail**, 596 assertions.
* Report-asset `tsc --project docs/reports/pi-append-cost-review/tsconfig.json` — passed. Report-asset Biome check — passed on 4 files; 12 warnings / 1 info, no errors.
* Final report reproduction file — **3 pass / 6 expected finding failures**, 47,221 assertions, 9 tests. The archived base's six snapshot-only probes give **5 pass / 1 fail**; the only failure is the inherited local `REPLACE` journal defect.
* AFT scoped diagnostics for report assets were **partial**, because the root has no covering TypeScript dependency/formatter marker for the language server. The explicit report-asset TypeScript and Biome gates above are the authoritative checks; partial diagnostics are not counted as a clean result.

The report reproduction file is intentionally not installed in a normal package test directory: the six failing assertions are evidence to fix, not product changes or rewrites of old contracts.

## Mutation controls (all restored)

Each mutation was applied only after staging its precise implementation path and confirming an empty unstaged `git diff --stat`. Each run captured a nonempty diff, ran the selected positive/control tests, then restored with `git checkout -- <path> && touch <path>` and confirmed the unstaged diff was empty. All mutants contained **NON-VACUITY BREAK**. None remains in this delivery.

| Control | Sole red test | Tests that stayed green |
|---|---|---|
| Ignore external session revision (`tag-snapshot-pi.ts`) | `100k-tag snapshots ignore foreign metadata and other sessions, but reload foreign same-session edits and reopened connections` | `tag snapshots refresh only changed numbers on append and preserve canonical bytes` |
| Reuse fallback prefix by ID alone (`pi-fallback-index.ts`) | `fallback index discards stale fingerprints, positions and owner aliases on same-length extension rewrites` | `fallback index rebuilds only appended messages at 13,800 entries`; `fallback index follows context_edit, reorder, deletion and fallback-to-real settlement` |
| Ignore immutable same-number row replacements (`tail-hygiene-walk-pi.ts`) | `immutable hygiene tag attribution extends appends and rebuilds rewritten, deleted and reowned rows` | `the hygiene projection counts real user turns without a second message walk` |
| Bless the whole LKG input prefix (`pi-lkg.ts`) | `LKG own-slot digest reuse stops at a same-id same-length input rewrite` | `Pi incremental LKG capture > reuses every prior digest on an append-only pass` |
| Force fallback rebuild from zero (`pi-fallback-index.ts`) | `fallback index rebuilds only appended messages at 13,800 entries` | `fallback index follows context_edit, reorder, deletion and fallback-to-real settlement` |
| **Additional:** omit status/drop-mode from the shared UPDATE trigger (`storage-tag-identity-revision.ts`) | `review randomized snapshot equals full reload after 15000 mixed initialized-writer operations` — seed 0x650, step 3, operation 7: active cached instead of compacted | `review nested tool argument extension rewrite matches a cold fallback index` |
| **Additional:** omit content from fallback primitive capture (`pi-fallback-index.ts`) | `review nested tool argument extension rewrite matches a cold fallback index` — expected changed prefix 1, got 2 | `review randomized snapshot equals full reload after 15000 mixed initialized-writer operations` |

All **five original controls and two additional controls reddened only their named test** in their selected runs. This proves the checks exercise the revisions/content/hygiene/digests/work-bound they claim to defend; it does not prove the adversarial gaps above are covered by the original suite.

## Isolation and reproduction

The Linux isolation probe opened and migrated only its synthetic database, then inspected its **own PID** with `lsof -p <pid> -Fn`. PID 6 in that sandbox reported only `context.db`, `context.db-wal`, and `context.db-shm` under:

```
/tmp/magic-context-review.NbaJuM/magic-context/bg_30c7fb31547a8cb9/review-lsof-QGyDjN/
```

All six requested environment paths were under the surrounding task root. `lsof` warned that the sandbox cannot stat kernel tracefs; the database file descriptors themselves were returned and checked. This is synthetic Linux isolation evidence, not a claim of observing a macOS host PID or continuous FD surveillance over the entire suites. The package preloads further isolate per-worker test roots. No live stores were copied for the oracle.

Run the following **on Linux**, in an isolated worktree with the repository dependencies/build artifacts prepared. Use `runon: "linux,8c"` for execution. Set all runtime roots first, and remove the created root on exit:

```sh
mkdir -p "${TMPDIR:-/tmp}/magic-context/pi-append-cost-review"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/magic-context/pi-append-cost-review/run.XXXXXX")
export XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config"
export XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime"
export OPENCODE_DB="$ROOT/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$ROOT/store"
export MAGIC_CONTEXT_TEST_DATA_DIR="$ROOT/tests" TMPDIR="$ROOT"
mkdir -p "$ROOT/tests"
trap 'rm -rf "$ROOT"' EXIT
bun --version
bun --tsconfig-override packages/pi-plugin/tsconfig.json \
  docs/reports/pi-append-cost-review/isolation.ts
bun test --tsconfig-override packages/pi-plugin/tsconfig.json \
  docs/reports/pi-append-cost-review/checks.test.ts --timeout 120000
# The reproduction suite is expected to report the six failures named above.
bun packages/pi-plugin/node_modules/typescript/bin/tsc \
  --project docs/reports/pi-append-cost-review/tsconfig.json
packages/pi-plugin/node_modules/.bin/biome check docs/reports/pi-append-cost-review
```

To rerun the independent served-byte oracle, make an archive **inside this worktree**, without another root manifest/lockfile (the remote sandbox rejects lockfile-root `node_modules` symlinks):

```sh
mkdir .review-base
# Packages include their own source, configurations and fixture helpers.
git archive 0f8f341c8c4b27df6bf9678e022250ef3a9b8ac4 packages scripts \
  | tar -x -C .review-base
ln -s ../node_modules .review-base/node_modules
ln -s ../../../packages/pi-plugin/node_modules .review-base/packages/pi-plugin/node_modules
ln -s ../../../packages/plugin/node_modules .review-base/packages/plugin/node_modules
bun docs/reports/pi-append-cost-review/served-bytes.ts .review-base
# Remove only the archive this command created, never another checkout.
rm -rf .review-base
```

The oracle removes its own temporary generated runners and wire files in `finally`. Its final summary is the 77/77/77 equality result above. The committed report/scripts are the retained evidence; throwaway databases, archived source, generated runners and raw wire dumps are not retained.
