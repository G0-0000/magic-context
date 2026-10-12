# Independent correctness review, round 2: Pi append and shared tag epochs

## Scope and verdict

Reviewed **00a1d299441ce7456136df9d4a4d301db3cb8fcb**, on **873ee68257a9075b4c09a386331d2519350b615b** and round-1 report **46185b24**. Read [the round-1 findings](pi-append-cost-review.md) first: they identified revision reuse after clear, missing REPLACE invalidation, duplicate-key hygiene attribution and duplicate-ID fallback-index membership, plus the documented raw-writer limit. This delivery changes only this report and reproducible report assets; no product or package test was changed.

**The reusable-clear and REPLACE repairs hold in the tested initialized-writer domain.** The duplicate hygiene and fallback-index regressions are repaired. No ordinary-pass or first-upgraded-pass served-byte change was observed in the three synthetic host adapters. The shared before-insert conflict observer, which stamps rows that an INSERT may displace, has measurable insert overhead. One additional **conditional lifecycle gap** remains: permanent retirement followed by reuse of the same session ID can alias an already-open foreign reader. A new process with cleaned caches starts correctly; these are different contracts.

All execution was on Linux, `runon: "linux,8c"`, Bun **1.4.2**, Node **24.21.0**, TypeScript **5.9.3**, Biome **2.5.1**. No macOS Pi/OpenCode application or provider was launched. The OpenCode/Pi byte checks invoke production hooks with synthetic host interfaces, not live host binaries.

## Findings by severity

### Medium, conditional lifecycle correctness — terminal retirement reintroduces a revision alias if an ID is reused while another reader remains open

**Failing test:** `r2 permanent deletion and same-ID reuse must invalidate an already-open foreign reader` in [checks.test.ts](pi-append-cost-review-r2/checks.test.ts).

Minimal sequence, with initialized connections throughout:

1. A second initialized SQLite connection (foreign to the reader connection) inserts `before:p0`, active tag number 1 (rendered as §1), explicit primary ID 1. A Pi snapshot and shared tagger on a separate connection warm this session.
2. The writer calls the production `clearSession(db, id, false, true)` permanent-deletion API. Both counters and owner markers are retired.
3. It imports `after:p0`, dropped §7, using the same session ID and primary ID. The full-row revision is again 1, `tags_version` is again 1, and the identity revision is again absent.
4. Without reading the empty interval, the warm snapshot returns `before:p0 / §1 / active`; authoritative SQL returns `after:p0 / §7 / dropped`. The warm tagger still binds the old message to 1 and has no new-message assignment.

Captured output:

```text
TERMINAL_REUSE warmAssignment=1 newAssignment=undefined snapshot=[["before:p0",1,"active"]]
(fail) r2 permanent deletion and same-ID reuse must invalidate an already-open foreign reader
Expected messageId/status/tagNumber: after:p0 / dropped / 7
Received messageId/status/tagNumber: before:p0 / active / 1
```

Cause: `storage-session-tables.ts:180–204` intentionally removes the `tag_revision:<session>` and `tag_identity_revision:<session>` keys on final retirement; `tag-snapshot-pi.ts:62–75,107–126` only compares local and external full-row revisions. The tagger's `(tags_version, identityRevision, floor, db)` equality at `tagger.ts:787–798` also becomes equal again. An inequality check handles a *different* lower stamp, not a stamp reset to the identical cached value.

**Qualification:** terminal deletion is documented as a session that cannot resume (`storage-meta-session.ts:318–335`). Real host UUID reuse was not demonstrated. The ordinary host deletion path cleans its own in-memory state; this reproduction deliberately retains another connection's caches. Treat this as a gap in the requested **delete-and-reuse** property, not evidence that ordinary administrative clear still fails or that normal host UUID allocation routinely reuses IDs. `r2 terminal deletion then ID reuse starts with a clean counter and no inherited drop` passes when teardown releases caches and the next reader starts cold.

**Recommendation:** explicitly require that retired IDs cannot be reused while any old reader can survive, or carry a unique session-generation value through terminal retirement so reuse can be distinguished from the previous session. Do not describe terminal ID reuse as universally clean based only on deleted database keys and a fresh reader.

### Low, performance — ordinary inserts pay for the conflict observer even when nothing conflicts

The observer is not free; measurements below isolate its incremental cost while keeping the other triggers and indexes unchanged. Median cost rises about **8–11% for autocommit inserts**, **20% for message bulk inserts**, and **32% for owned-tool bulk inserts** in this fixture. This is a tradeoff, not evidence of a table-scan catastrophe or a correctness failure. Bulk migration/backfill budgets should include it.

### Retained documented compatibility limit — uninitialized/older writers are still unsupported

Round 1's arbitrary raw-client freshness claim remains **not closed**. The current explicitly named test, `known limit: uninitialized foreign writes stay stale until a recognized session change or reopen`, passes by asserting staleness and later recovery. This is the previously approved contract boundary, not a new observer omission. The triggers remain TEMP and connection-scoped (`storage-tag-identity-revision.ts:65–76`); a raw or older process can still change served identity/drop inputs without advancing the new revision. No live mixed-version deployment was tested.

## 1. Round-1 findings, checked in order

| Round-1 property | Independent round-2 evidence | Result |
|---|---|---|
| Initialized reusable clear/recreate cannot reuse a snapshot stamp | Original regression; expanded 15,000-operation differential; new 40-cycle test where the reader misses every empty interval and rows become dropped/skeleton_real | Closed for reusable clear. Permanent retirement is the separate finding above. |
| Foreign REPLACE must invalidate the displaced session | Original foreign move and renumber; explicit ID moves A → B → C → A → C → B with each former owner warmed before every move | Closed for initialized writes. |
| Local REPLACE must journal the old number | Original inherited local-renumber probe; four primary/number/owned-tool conflict tests with recursive triggers both OFF and ON and transactional rollback | Closed, including the inherited defect. |
| First lower-number duplicate-key transition must retain canonical last-row-wins | Original reproduction and immutable-hygiene tests, including rewritten/deleted/reowned rows and the independent full-walk comparison | Closed in the exercised duplicate transition. |
| Leaving duplicate stable IDs must retain survivor fallback membership/position | Original duplicate-to-unique probe, plus cold-index parity for rewrites/reorder/deletion/settlement | Closed at this helper boundary; valid real host entry IDs remain unique. |
| Raw foreign drops must refresh without initialization | Named compatibility-limit test | Still intentionally unsupported, not a freshness pass. |

The expanded differential compares **literal snapshot JSON against authoritative `getTagsBySession` JSON** after every operation, not a revision-derived expected result. It executed **15,000 operations, three seeds, four initialized connections, three sessions**, including **1,653 clears, 812 recreations and 846 REPLACEs**, as well as commit/rollback and transactional reads. All 24 permanent review regressions passed.

**Clear versus another process:** the new race probe holds an outer SQLite writer transaction around the real `clearSession` helper, then admits an initialized appender in a different process. Before release the old committed row remains visible; after the clear commits the blocked append completes. The snapshot equals SQL and contains only `after / §7 / dropped`. This is a controlled clear-first writer-lock interleaving, not a random concurrency stress test or an assertion that append-before-clear should survive.

**Crash between observer and insertion:** a Node `node:sqlite` child installs the production TEMP observer, adds a callback at the end of the observer's SQL trigger body, and blocks before insertion. Its callback observes `identity revision=1` and the old row still present. The parent sees only committed pre-observer metadata, sends **SIGKILL**, and verifies both revision keys, `tags_version` and rows are unchanged after recovery. A subsequent insertion succeeds. The added pause remains TEMP; this is a real killed process, not merely a thrown SQL exception or a simulated manual epoch update.

Two initial crash-fixture attempts were rejected before accepting evidence: Bun's native SQLite has no `.function` callback API, and reconstructing the trigger from `sqlite_temp_master.sql` without re-adding `TEMP` created a durable synthetic trigger. The final Node fixture explicitly restores `CREATE TEMP TRIGGER`; no product file was altered to enable the probe.

## 2. Shared mechanics on OpenCode 1, OpenCode 2 and Pi

[served-hosts.ts](pi-append-cost-review-r2/served-hosts.ts) runs an independently archived **873ee682** runtime and **00a1d299** in separate processes, using the existing opt-in three-adapter fixture. The clock and fixture project path are fixed. Each current adapter reopens the **same synthetic database** the old runtime populated, with an additional unrelated tombstone created between versions. OpenCode 1 receives an explicit fixture database path so the test preload cannot silently give the second process a different store. The first current pass is compared literally with the old accepted wire, not discarded as warm-up.

| Adapter | Literal served bytes | SHA-256 | Result |
|---|---:|---|---|
| Pi, 604 messages with tool call/result | 129,157 | `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85` | First upgraded pass and 30 warmed ordinary passes identical |
| OpenCode 1, synthetic-head plus user message | 599 | `1858cb22d26467847a365974827421103ac1dcc30479b294fdcdc7bf4b4ff80c` | First upgraded pass and 30 warmed ordinary passes identical |
| OpenCode 2, registered context draft | 686 | `16fcdeadebc42355d415381f2b5f53df54188c193b4cb61a86a52d63a2b31ce0` | First upgraded pass and 30 warmed ordinary passes identical |

The target session's full and identity revision values and **complete tag-row JSON** stayed unchanged through tombstone creation and the new adapter's passes. New per-harness tagger controls also hold an idle session warm while 30 unrelated sessions insert the same tag number and another session is cleared: **no identity bump and zero assignment-scan executions** for the idle session. The cross-session-conflict mutation below proves this fence can fail.

The tagger's database-load signature is in-memory, not a persisted versioned format (`tagger.ts:227–237,871–877`). A new process still performs its normal cold map load; “no first-pass rebuild for everyone” means no forced durable retagging or wire transition introduced by the upgrade, **not** zero cold-start SQL. These fixtures demonstrate that distinction, rather than claiming to hot-patch an already-running old tagger object.

The large Pi round-1 oracle was also rerun against archived **873ee682**, with **13,930 messages and 99,931 tags**, including 86,000 hidden tags. It passed **77 literal JSON + 77 wire-hash + 77 behavioral tag-row comparisons**. The final append projection is **4,604,108 bytes**. Same-ID rewrite, revert, context_edit removal, revert after the edit and compaction contraction all agree. Unlike the original optimization comparison against master, this compares the optimization with its repairs; hook median was 270.742 ms before versus 294.899 ms after, p90 330.828 versus 329.425 ms. This single sequential run does not isolate trigger overhead and is not a statistically controlled claim of a 9% whole-hook regression.

OpenCode fixture histories are deliberately small; the shared storage probes cover the counters and invalidation mechanics, while the large-session byte oracle is Pi-only. This is not a three-host provider replay with large real histories or full drop-mode combinatorics.

## 3. Tombstone lifecycle

The `message-index-maintenance.test.ts` maintenance suite passed all **13 tests**, including:

* Tombstone-only discovery, retention when the authoritative host session is live, and exclusion of Pi-only counters.
* Another harness's live compartments retaining the identity/full epochs during an OpenCode-scoped deletion.
* Another harness's **tombstone-only** marker retaining those same epochs until the last producer is retired.
* OpenCode 2 (the v2 host adapter) returns unavailable without opening a host store; Pi/OMP also return unavailable because OpenCode's session table is not authoritative for their sessions. This repair does **not** suddenly enable those sweeps.

The additional `r2 quoted session tombstone is discovered and swept without touching Pi epochs` uses a session ID containing quotes, separators and a backslash. Only the OpenCode orphan is retired; Pi's epoch survives. Its mutation proves the JSON key encoding and discovery are genuinely exercised.

Confirmed final deletion removes both counters and owner provenance; a new tagger subsequently starts at §1 with active/full state and no inherited dropped row. **Already-open foreign caches are not equivalent to that cold restart**; the same-ID-reuse red test above is outside the existing permanent-deletion regression's assertions.

## 4. Observer cost

[cost.ts](pi-append-cost-review-r2/cost.ts) compares normal initialized connections with otherwise identical connections where only `temp.mc_tag_revision_bi` is removed. Both arms keep all durable tag/version triggers, the identity UPDATE trigger, full-row AFTER triggers, indexes and WAL settings. It uses fresh file-backed databases, 10,000 initial rows, nine samples per cell, alternates arm order, checks actual row counts, and removes all databases. **72 databases; 396,000 measured inserts**, plus unmeasured setup rows. No Pi snapshot journal is installed, so this isolates the shared observer rather than both observers together.

Microseconds per inserted row:

| Operation | No observer median / p90 | Observer median / p90 | Median delta |
|---|---:|---:|---:|
| Message, 1,000 autocommit inserts | 34.460 / 56.203 | 38.118 / 284.446 | +3.658, +10.6% |
| Message, 10,000 inserts in one transaction | 10.774 / 45.012 | 12.939 / 20.800 | +2.164, +20.1% |
| Owned tool, 1,000 autocommit inserts | 48.182 / 329.222 | 52.084 / 245.764 | +3.902, +8.1% |
| Owned tool, 10,000 inserts in one transaction | 12.396 / 12.663 | 16.320 / 16.711 | +3.923, +31.6% |

P90 here is the maximum of only nine batch samples. Large, asymmetric tails show shared-machine/disk noise, not a reliable p90 latency distribution for individual rows. The median effect is measurable, especially in the tight bulk tool path; extrapolating to 100,000 rows would be roughly 0.2–0.4 seconds of extra observer work in this warmed fixture, not a measured 100,000-row backfill result. The benchmark does not establish cold-store scaling, the cost of conflict-heavy ignored inserts/upserts, or full migration wall time.

Source uses separate indexed ID, session/number and owned-tool probes with `UNION`, rather than an unindexed OR scan (`storage-tag-identity-revision.ts:48–63`). Ordinary nonconflicting inserts do not bump identity epochs; conflict/ignored-insert stamps are intentionally conservative and can cause extra reads even when SQLite ignores the insert (`:91–96`). That documented case should not be confused with idle sessions being globally invalidated.

## 5. Tests and mutation controls

[The implementation report](pi-session-local-append-cost.md#review-repair-mutation-evidence) enumerates **19 control families**: five original optimization controls and fourteen repair/lifecycle controls. Their corresponding positive regression files were rerun: **62 tests / 602 assertions** in the five optimization/owner files, and **37 tests** across the permanent review and maintenance files. This review does **not** claim to have rerun all nineteen old mutant implementations. It independently reapplied the two refined controls and added two new controls.

| Control reapplied or added | Sole red test | Companion that stayed green |
|---|---|---|
| Refined whitespace: omit old-session identity stamp and `tags_version` bump | `foreign REPLACE invalidates cached inert-whitespace replay in the removed session` — cache reads expected 1, received 0 | `review initialized foreign REPLACE renumber must remove the old snapshot row` |
| Refined owner: omit replacement identity stamp, retain `tags_version` and full revision | `owner summary observes REPLACE identity/reasoning changes with preserved count and primary ID` — owner remained `before` instead of `after` | Same foreign-renumber companion |
| **New:** remove session predicate from number-conflict discovery | `r2 opencode unchanged tagger has no epoch bump or assignment rebuild on ordinary passes` — idle epoch expected null, received 1 | `r2 repeated clear and recreate stays canonical over 40 missed empty intervals` |
| **New:** remove JSON quoting from tombstone session keys | `r2 quoted session tombstone is discovered and swept without touching Pi epochs` — deleted expected 1, received 0 | `r2 terminal deletion then ID reuse starts with a clean counter and no inherited drop` |

Each run gave **one pass / one fail**, with only the named target red. All mutations carried the explicit temporary-break marker **NON-VACUITY BREAK**, used a staged live source restore point, and were restored with `git checkout -- <path> && touch <path>`. The first mutant's diff was `1 file changed, 2 insertions(+), 3 deletions(-)`; each other mutant was `1 file changed, 2 insertions(+), 1 deletion(-)`. Unstaged `git diff --stat` was empty before mutation and after restoration every time. No product mutation remains.

**Why the refinements matter:** the whitespace wire assertion still passes under its mutant because the row-existence guard suppresses stale digits; the additional cache-refresh assertion is what fails. It defends freshness/work state, not a newly demonstrated wrong emitted digit in that particular fixture. The owner test preserves row count and primary ID and writes through initialized **native Bun SQLite**, outside shared JS write-generation tracking. It genuinely observes stale cached owners when only the SQLite identity stamp is removed. Both refined tests therefore defend their stated properties rather than being accidentally rescued by another invalidation path.

## Gates and failing tests

* `bun run build` — passed on Linux; seven bundler invocations, TUI checked **9 files**, no drift.
* `bun run typecheck` — passed; all **four package scripts**, including plugin script checking, TypeScript **5.9.3**. Exit zero is the repository's silent TypeScript success signal.
* `bun run lint` — passed, Biome **2.5.1**: **1,376 plugin / 305 Pi / 138 CLI / 6 retina files**; existing warnings/infos remain.
* `bun run --cwd packages/plugin test` — **7,694 pass / 27 skip / 1 fail**, **7,722 tests / 228,809 assertions / 779 files**, 168.22 seconds. The failure is `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`: the throwaway built wrapper cannot resolve `onnxruntime-web/webgpu`. The one-test reproduction fails identically at HEAD and archived 873ee682. No fixture or dependency was changed.
* `bun run --cwd packages/pi-plugin test` — **1,993 pass / 28 skip / 1 fail**, **2,022 tests / 134,848 assertions / 205 files**, 252.49 seconds. `Pi aborts slow embeddings at the deadline and replays byte-identical skip on retry` took **3,335.25 ms** in the parallel suite. Its complete three-test file passes in isolation at HEAD (**3,005.04 ms** for that test); the archived-source file also passes. This is an unrelated timing sensitivity, not a green full-suite claim.
* Frozen-lockfile test installs checked **1,013 installs across 1,254 packages**, no changes to manifests or locks.
* Restored optimization and owner-summary gate — **62 pass / 0 fail**, **602 assertions**, five files. All permanent review and maintenance tests also pass.
* Final review/maintenance run — **46 pass / 1 expected finding failure**, **47 tests / 47,685 assertions**, three files. The only red assertion is the terminal same-ID-reuse finding above; it is outside the package suites and deliberately retained as a report reproduction, not marked skipped or rewritten to assert staleness.
* Three-adapter oracle — **six child fixture tests**, 20 child assertions plus literal first-upgrade/warm byte and database-state checks in the driver. Large Pi oracle — **231 comparisons over 77 passes**.
* Report-asset lint — passed on **6 files**, Biome **2.5.1**, with 8 non-null-assertion warnings and no errors. Scoped AFT diagnostics were **partial**: the root language-server configuration does not cover these report assets; explicit TypeScript and Biome commands are authoritative, not a clean AFT claim.
* Report-asset TypeScript check — passed using `bun packages/pi-plugin/node_modules/typescript/bin/tsc --project docs/reports/pi-append-cost-review-r2/tsconfig.json`, TypeScript **5.9.3**. Report-asset lint/format and diagnostics are recorded in the delivery declaration.

A first baseline file command omitted the `./` prefix for the hidden archive directory; Bun treated it as a filter and ran no tests. It was corrected before accepting baseline evidence. Archive-source aliasing was checked separately after correcting the earlier hybrid baseline run. The final baseline timing check passes **3 tests / 14 assertions**, including the embedding test at **3,006.67 ms**. The earlier OpenCode 1 default-path oracle was also rejected for upgrade evidence when adding database-state assertions exposed the preload's per-process path redirection. The committed driver pins that path explicitly.

## Isolation and reproduction

**No live stores or live configuration were opened, read, written, copied or migrated.** Every execution ran on the Linux server with all six runtime paths assigned below a throwaway task root. Package preloads were allowed to derive their per-worker XDG/database paths inside the test-owned root. For the full plugin suite only, `OPENCODE_DB` was unset after the isolation probe: fixture tests deliberately override XDG to create their own synthetic host databases, and a fixed global database override defeats that addressing. No macOS host run occurred.

A subsequent exact task-layout isolation run put every environment root below `/motor-home/tmp/magic-context/bg_7dcc17731fa2a566/run.oMs7Wz/`; isolation PID **8** and actual writer PIDs **63, 79 and 105** listed only synthetic database descriptors there. The ten report probes again gave **9 pass / 1 expected same-ID-reuse failure**. The initial `lsof -p 6 -Fn` probe listed only `context.db`, WAL and SHM under `/motor-home/tmp/magic-context-r2.YXffWU/magic-context/bg_7dcc17731fa2a566/review-lsof-vV3SyU/`. Actual race/crash children additionally inspect **their own PIDs** and reject any database descriptor outside the throwaway `TMPDIR`. In the final review run these were PIDs **39, 54 and 79**, under `/motor-home/tmp/magic-context-r2-finalchecks.VKjiGK/magic-context/bg_7dcc17731fa2a566/`. `lsof` warned that tracefs could not be statted; the database descriptors were returned and checked. This is not continuous FD surveillance across all package worker processes. Bun printed its existing internal tsconfig directory-mismatch warning on multiple runs; comparisons and exits are recorded independently of that warning.

To reproduce on Linux in this worktree with prepared dependencies:

```sh
TASK_ROOT="${TMPDIR:-/tmp}/magic-context/bg_7dcc17731fa2a566"
mkdir -p "$TASK_ROOT"
ROOT=$(mktemp -d "$TASK_ROOT/run.XXXXXX")
export XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config"
export XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime"
export OPENCODE_DB="$ROOT/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$ROOT/store"
export MAGIC_CONTEXT_TEST_DATA_DIR="$ROOT/tests" TMPDIR="$ROOT"
export REVIEW_CRASH_RUNNER="$ROOT/crash.mjs"
mkdir -p "$ROOT/tests"
trap 'rm -rf "$ROOT"' EXIT
bun --version
node --version
bun --tsconfig-override packages/pi-plugin/tsconfig.json \
  docs/reports/pi-append-cost-review/isolation.ts
bun build docs/reports/pi-append-cost-review-r2/crash-writer.ts \
  --outfile "$REVIEW_CRASH_RUNNER" --target node --external node:sqlite
bun test --tsconfig-override packages/pi-plugin/tsconfig.json \
  docs/reports/pi-append-cost-review-r2/checks.test.ts \
  packages/pi-plugin/src/append-cache-review-regressions.test.ts \
  packages/plugin/src/features/magic-context/message-index-maintenance.test.ts \
  --timeout 120000
# Expected: the terminal same-ID-reuse test is the sole failure.
bun --tsconfig-override packages/pi-plugin/tsconfig.json \
  docs/reports/pi-append-cost-review-r2/cost.ts
bun packages/pi-plugin/node_modules/typescript/bin/tsc \
  --project docs/reports/pi-append-cost-review-r2/tsconfig.json
packages/pi-plugin/node_modules/.bin/biome check docs/reports/pi-append-cost-review-r2
```

For the independent runtime oracle, archive `873ee682`'s **packages and scripts only** into `.review-r2-base` inside this worktree, without another root manifest/lockfile. Link the archive to the worktree's prepared dependencies with the following commands; do not run an install in a second checkout:

```sh
mkdir .review-r2-base
git archive 873ee68257a9075b4c09a386331d2519350b615b packages scripts \
  | tar -x -C .review-r2-base
ln -s ../node_modules .review-r2-base/node_modules
ln -s ../../../packages/pi-plugin/node_modules .review-r2-base/packages/pi-plugin/node_modules
ln -s ../../../packages/plugin/node_modules .review-r2-base/packages/plugin/node_modules
bun --tsconfig-override packages/pi-plugin/tsconfig.json \
  docs/reports/pi-append-cost-review-r2/served-hosts.ts .review-r2-base
bun docs/reports/pi-append-cost-review/served-bytes.ts .review-r2-base
```

The drivers remove generated runners, raw wire files and synthetic stores in `finally`; surrounding shell roots are removed on exit. The scratch archive and build output are disposable and were removed after verification. No `ARCHITECTURE.md`, `STRUCTURE.md`, installed dependencies or `.cortexkit/alfonso` files were edited.
