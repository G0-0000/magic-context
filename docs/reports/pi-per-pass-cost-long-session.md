# Pi per-pass cost on a long session (ANTAUTH shape)

## Summary

* **ANTAUTH runs v0.48.0, not master.** The Pi log records `loaded v0.48.0` at
  2026-10-12T11:15:39Z for that project. None of the 12:00–14:00 `transform stage:`
  lines has the `pressureResolution` label, which master added. The tag-cache
  fixes in `873ee68257`, `00a1d29944` and `f01bba51d8` are on master, but none of them
  is in `v0.48.0`.
* **Why every pass loaded 62,847 tags.** In v0.48.0 the Pi tag snapshot is thrown
  away when `PRAGMA data_version` changes. That value changes on every commit to
  the shared `context.db` by any other connection, whether OpenCode, workers,
  dreamer or another Pi process. Unrelated sessions and metadata writes count too.
  The whole session is therefore reread on almost every pass. On the fixture, a
  v0.48.0 append pass spends 108 ms in that stage. Master spends 2.1 ms and this
  branch 0.56 ms. Master already uses a per-session cross-process signal, the
  `tag_revision:<session>` key in `schema_migrations_meta`, so no migration is
  needed for this.
* This branch makes each append pass cost proportional to the change wherever
  served bytes can stay identical:
  * The active projection is maintained incrementally.
  * Fallback rows are maintained incrementally.
  * Served-number lookup is limited to the pass's targets.
  * Protected-tool selection reads only active rows.
  * After a foreign write, a reload keeps the existing objects for unchanged rows.
  * The assignable-tag lookup is pinned to its owner index.
* On the steady append fixture, the median hook total falls from **87.1 ms** on
  master to **55.5 ms** on this branch. The mean falls from 89.4 to 63.3 ms; one
  lkgCapture outlier is described below. On v0.48.0 the median is 273.7 ms.
* **Byte identity.** Across 263 passes, master and this branch produced the same
  literal served-JSON SHA-256, persisted tag-row hash, served byte count and
  message counts on every pass. The passes were two seeded randomized runs of 114
  passes each plus 35 steady append passes.

## Fixture and isolation

The data is synthetic. No live session file, store or configuration was opened.
The only live input was the Pi `magic-context.log`. From it I extracted only
`transform stage:` timing lines, the `loaded vX` lines and `transform completed`
counts.

The harness is `packages/pi-plugin/scripts/experiments/perf/run.ts`, driving the
real `registerPiContextHandler`. New flags:

* `--hidden-messages 87600` hides 87,600 message entries behind a Magic
  Context-owned Pi compaction entry. The branch has 90k entries; Pi sends the
  roughly 2,400 after the compaction.
* `--historical-tags 60000 --historical-mix` seeds 60,000 old tags. Two thirds
  are tool tags with owners, one third are dropped and the rest compacted.
* `--foreign-tag-interleave 3` puts three tags of other sessions after each
  seeded tag, so one session's rows span many pages, as in a shared `context.db`.
* `--external-writes` and `--pi087` were already available. Another connection
  commits before every pass, and Pi 0.87's withheld system entry is modelled.
  `--lingering-fallback` adds one `pi-msg-*` row that never settles.

Final shape: 2,461 to 2,565 request messages, 62.4k to 62.6k tags (about 2.4k to 2.5k
of them active), 90k branch entries, and about 0.82 to 0.85 MB of served JSON.

The live log shows ANTAUTH's real requests had **157–303 messages**, for example
`transform completed … (288 messages, 169 targets)`. The fixture follows the
brief's 2,400 messages, so request-bounded stages in it are larger than ANTAUTH's.

All runs were on Linux (`ck-motor`) with Bun 1.4.2. Each run uses a fresh
`$TMPDIR/magic-context/pi-append-perf-*` root. `XDG_DATA_HOME`,
`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR` and `MAGIC_CONTEXT_TEST_DATA_DIR` all point inside
that root. `lsof` on a running benchmark showed only these files:

```
/motor-home/tmp/magic-context/pi-append-perf-OVtsUA/context.db
/motor-home/tmp/magic-context/pi-append-perf-OVtsUA/context.db-shm
/motor-home/tmp/magic-context/pi-append-perf-OVtsUA/context.db-wal
```

No Pi or OpenCode host process was started.

Commands used. `summarize-stages.ts` reports per-stage mean, median, p90 and max,
the SQL with the highest per-pass cost, and per-pass hashes.

```sh
cd packages/pi-plugin
bun scripts/experiments/perf/run.ts --messages 2460 --hidden-messages 87600 \
  --points 88300,89000,89700,90000,90002,…,90060 --pi087 --external-writes \
  --lingering-fallback --historical-tags 60000 --historical-mix \
  --foreign-tag-interleave 3 --output r.json
bun scripts/experiments/perf/summarize-stages.ts r.json --skip 4
# randomized differential: same flags, --messages 2600 --points 88300,89000,89700,90000 \
#   --chaos-seed 7|11 --chaos-passes 110
```

Baselines were `git archive` copies of `v0.48.0` and of master
`43ddbe1bec`. The same `run.ts` and `fixtures.ts` were copied into each copy.

## Steady append passes (31 measured, 2-message appends)

Values in ms are mean / p90. The first four warm-up passes are excluded.

| stage | v0.48.0 | master | this branch |
|---|---:|---:|---:|
| total (hook) | 291.6 / 333.7 | 89.4 / 103.8 | **63.3 / 82.0** (median 55.5) |
| runPipeline | 224.3 / 238.2 | 63.3 / 73.0 | **37.2 / 49.9** |
| getTagsBySessionSnapshot | 108.0 / 127.1 | 2.1 / 2.3 | **0.56 / 0.76** |
| tagSnapshotSync (new label) | — | — | under 0.1 |
| tag:identity (inside tagMessages) | 62.8 / 53.8 | 28.0 / 34.8 | **2.8 / 3.8** |
| channelNudgeAccounting | 45.1 / 54.8 | 12.9 / 15.7 | 11.8 / 15.7 |
| fallbackIdentityAndAdoption | 8.6 / 10.8 | 6.1 / 7.1 | 6.5 / 8.8 |
| tokenAccounting | 5.4 / 6.1 | 3.4 / 4.1 | 3.8 / 5.2 |
| modelChangeDetection | 0.29 / 0.32 | under 0.5 | under 0.5 |
| lkgCapture | 9.0 / 9.6 | 7.1 / 7.9 | 39.8 / 12.4 (median 6.3, one 1,013 ms outlier) |
| entryParseAndBranchResolution | 12.9 / 18.7 | 7.5 / 8.4 | 8.4 / 11.2 |

Two things to keep in mind when reading this table:

* **lkgCapture outliers are not specific to this branch.** Deferred capture
  sometimes takes several hundred milliseconds in both trees. Master's maxima in
  the randomized runs below were 1,396 and 2,007 ms. The median is unchanged.
* **The fixture does not reproduce ANTAUTH's fallback cost.** ANTAUTH's v0.48.0
  fallback stage has a 112 ms mean and a 741 ms max; on the fixture, v0.48.0 takes
  8.6 ms. The live spikes fall on the first pass after 15–25 minutes of idle time
  (12:11:43, 12:29:39, 12:38:18, 13:04:15). The fixture has no such idle gaps,
  and it is not ANTAUTH's data.

## Randomized differential against master (2 seeds × 114 passes)

Before each pass, the seeded schedule draws these events:

* append 0–3 messages
* queue a `ctx_reduce` drop
* force an execute pass with 96% usage, which flushes pending ops
* publish a compartment from a second connection (fold)
* switch the model between `claude-sonnet-4-5` and `claude-opus-4-1`
* from the second connection, rewrite or drop one of this session's tags

| seed | drops | flushes | folds | foreign tag writes | model switches | identical passes |
|---|---:|---:|---:|---:|---:|---:|
| 7 | 23 | 2 | 6 | 26 | 11 | 114 / 114 |
| 11 | 19 | 12 | 5 | 23 | 5 | 114 / 114 |

The folds change served bytes. In seed 7, pass 111 has no new message, only a
fold, and its wire hash still changes.

Each comparison covers the literal `JSON.stringify` SHA-256 of the served array,
the hash of the persisted behavioural tag rows, the served byte count, and the
input and output message counts. A further 35 steady passes, in the table above,
were also identical.

Stage times for the randomized runs, as mean / p90 in ms:

| stage | seed 7 master | seed 7 branch | seed 11 master | seed 11 branch |
|---|---:|---:|---:|---:|
| total | 162.7 / 254.8 | **106.2 / 180.4** | 147.8 / 253.9 | **108.3 / 191.2** |
| getTagsBySessionSnapshot | 20.3 / 74.2 | 0.86 / 2.1 | 19.5 / 74.2 | 0.86 / 2.4 |
| tagSnapshotSync | — | 23.8 / 101.8 | — | 23.3 / 105.8 |
| channelNudgeAccounting | 34.8 / 93.6 | **12.8 / 16.1** | 33.1 / 86.4 | **13.4 / 18.4** |
| fallbackIdentityAndAdoption | 6.1 / 8.0 | 6.2 / 7.3 | 6.2 / 7.7 | 6.4 / 8.9 |
| tokenAccounting | 8.4 / 5.9 | 3.9 / 5.2 | 4.2 / 5.2 | 4.2 / 5.8 |
| tag:identity | 32.6 / 40.8 | 2.6 / 3.5 | 24.2 / 38.9 | 2.7 / 4.0 |

On passes after a foreign write to this session, the full reread now happens in
`tagSnapshotSync`, before the fallback preflight. It used to happen in
`getTagsBySessionSnapshot`.

That reread is slower than master's. Its p90 is about 100 ms against 74 ms,
because it also compares rows and rescans fallback rows. In return, the
channel-accounting stage on those same passes no longer rebuilds every historical
tag map: its p90 drops from about 90 ms to 16–18 ms.

## What changed, by question

### 1. Tag snapshot

**Does a pass need dropped or compacted tags?** Yes; several per-pass consumers
read non-active rows:

* `computeProtectionWindow`: under token protection, dropped rows still count
  toward chronology and mass.
* Tail-hygiene attribution (`tagAttribution`): it needs the message and tool tags
  of every request message, and null-owner tool rows of any status.
* `servedTagNumbers`: it reads this pass's targets, whatever their status.

Compacted tags of folded history are mostly not read. A targeted per-pass read of
"active plus the targets" would be an O(request) query, about 2.4k rows on every
pass. The incremental snapshot costs O(change) per pass and pays the full read
only once per connection and after a foreign write. So the cache was kept, and
the per-pass O(all) walks over it were removed:

* `tag-snapshot-pi.ts` keeps the active projection beside the full rows and
  merges it from the same changed-number journal (`pi_tag_changes`). The pass no
  longer filters 63k rows. `getPiActiveTagSnapshotView` returns a copied array
  of frozen rows. Inside a transaction it filters the caller's uncached read
  instead.
* `servedTagNumbers` looks up only the pass's target numbers, by binary search on
  the tag-ordered snapshot and in ascending order. Before, it filtered every tag.
* `protectedToolTagNumbers` in channel accounting, and
  `newestActiveTagNumbersByCount`, read the active projection. The output is
  identical: both already skipped non-active rows, and a stable sort keeps the
  same relative order.
* A reread after a foreign write reuses the cached frozen object for every row
  whose id and fields are unchanged. Identity-based delta folds in tail hygiene
  then see only the rows that really changed.

**Remaining O(session) work**

The first pass of each process or connection reads every row of the session.
After a foreign write to this session, the pass rereads them again.

The existing cross-process signal is only a per-session counter; it says nothing
about which rows changed. Making foreign writes O(change) would need a durable
per-row change journal: a main-database table `(session_id, tag_number, seq)`,
filled by the same connection-installed triggers and pruned by readers. That
requires a schema migration, which was **not** added. It is a proposal for the
owner to decide.

Writers that never ran `initializeDatabase`, or older builds such as v0.48.0, do
not advance `tag_revision:<session>`. This is master's existing, approved limit.

### 2. fallbackIdentityAndAdoption (issue 650)

**What was O(session) on an append pass in master.**

* The preflight probe cache was keyed by the full tag revision. Every pass that
  tagged a new message invalidated it, so the pass rescanned the session with
  `LIKE 'pi-msg-%'`.
* `fallbackPiToolCallIds` reran a DISTINCT LIKE scan of all tool tags whenever
  `tags_version` changed, which happens on every append.
* `readPiFallbackFingerprintHeaders` scans the session's message tags whenever a
  lingering fallback row exists.
* Inside the writer, the tool-owner probe scanned every tool tag before it could
  report "none".

**Changes**

* The fallback rows of a session (`pi-msg-*` message ids or tool owners) are
  cached on the snapshot entry. After a reload they are loaded once with the same
  SQL predicate; after that, only changed tag numbers are re-read.
  `hasPiFallbackMessageTags` and `hasPiFallbackToolOwnerTags` in
  `fallback-tag-probes-pi.ts` answer from these rows. Their visibility is the same
  as master's revision-keyed cache.
* The handler syncs the snapshot before `preflightRevision`. Consuming the change
  journal is a TEMP-table write, and must not look like a tag change made after
  preflight.
* The tool-owner existence probe now runs before writer admission. Under the
  writer it is reused only when `PRAGMA data_version` and `total_changes()` are
  unchanged since discovery. These are SQLite-level signals that every writer
  advances. The message probe follows the same rule that master already used for
  its candidate scan.

**Kept as table reads on purpose**

Adoption discovery, the fingerprint headers and the tool-call guard keep master's
semantics: table reads, or the durable `tags_version` trigger.

An intermediate version used the cached fallback rows for adoption discovery as
well. The existing test `review: adoption discovers a racing drop for an
already-served historical message` (`issue-640-review.test.ts`) failed on it. A
sibling connection that never ran `initializeDatabase` committed a fallback row,
the KV revision missed it, and adoption would then not have adopted it. That would
break the guarantee that served numbers never drift. Older Pi builds, which do
not advance `tag_revision:`, are a real case, so those paths stay authoritative.
As a result the fallback stage is **not** faster on the fixture: 6.1 ms on master,
6.5 ms here. Its remaining scans are the tool-owner LIKE probe (about 2.0 ms) and
the DISTINCT callId scan (about 1.8 ms).

Making these O(change) for every writer needs a signal that every writer
advances, for each matching row. The durable `tags_version` counts all tag
writes, so it cannot tell this connection's writes from foreign ones. A second
TEMP counter with the same `UPDATE OF` column list would make the subtraction
exact. That is a proposal; it is not implemented.

No issue 650 decision path changed: pairing, survivors, refusal, the once-only
repair and tagger binding are as before. The issue 650, 640 and append-cache
suites pass unchanged.

### 3. modelChangeDetection, channelNudgeAccounting and tokenAccounting

* **modelChangeDetection.** In v0.48.0 this timer covered pressure
  reconciliation, recovery writes and scheduling, and model seeding walked the
  whole branch. Master moved pressure to its own `pressureResolution` label and
  seeds the model only on restart. On the fixture it is now under 0.5 ms per pass
  on both trees. ANTAUTH's 49 ms is a v0.48.0 measurement.
* **channelNudgeAccounting.** One whole-history walk remained:
  `protectedToolTagNumbers` copied and sorted all 63k tags on every pass. It now
  reads the active projection. Foreign-write passes no longer rebuild every tag
  attribution map (see §1). What remains, about 12 ms at 2.4k messages, is the
  request-bounded walk over the served messages (`memoizedContent`, `partHash`,
  `safeStableStringify`).
* **tokenAccounting.** There is no history walk. The remaining 3–4 ms is
  `token:cacheValidation`, a plain-data validation of the served messages
  (O(request)). An earlier audit, `perf-audit/PI.md` (PI-11), deliberately kept
  this check. It is unchanged.

### Additional: assignable tag lookup (shared plugin code)

`getAssignableTagNumberByMessageId` (`storage-tags.ts`) uses `ORDER BY tag_number
LIMIT 1`. Without statistics, SQLite chose the session/tag-number index and
walked the whole session in tag order looking for a message id that a newly seen
message never has. It now pins `INDEXED BY idx_tags_session_message_id`, as its
sibling `getTagNumberByMessageIdStatement` already did. The result order is
unchanged.

On the fixture, `tag:identity` drops from 28 ms to 2.8 ms. ANTAUTH's live
`tagMessages` is only 2–10 ms, so its database probably plans this query
correctly already. The fix protects stores without `ANALYZE`, and OpenCode uses
the same function.

### 4. lkgCapture

Not changed. Medians are the same on both trees (about 6.3–7.1 ms), and both show
occasional deferred-capture outliers of several hundred milliseconds.

### Not addressed: O(branch entries) work

`entryParseAndBranchResolution` costs about 8 ms with 90k entries. Its sub-stage
`mcCompactionSummarySuppression` is timed from the same start, so it is not
separate cost. The stage walks the whole branch: entry-id maps and the
compaction/first-kept scan. These are O(session entries) per pass and are outside
this brief's named stages.

## Mutation controls

Each control followed the same procedure. The file was staged so that
`git diff --stat` was empty. The mutant was marked `NON-VACUITY BREAK` and
`git diff --stat` was non-empty. After the test run, `git checkout -- <file>` plus
`touch` restored it and `git diff --stat` was empty again.

| cache | mutation | red tests (only these failed) |
|---|---|---|
| incremental active projection | keep the old `active` array when rows change | `the active tag projection equals a fresh status filter after local, foreign, rollback, renumber and move writes` (1 of 39) |
| incremental fallback rows | skip the re-read of changed numbers | `cached fallback rows answer every pi-msg probe exactly like the table after mixed writes` and the existing `Pi fallback probes cache metadata-only passes and see local, initialized sibling and rollback tag changes` (2 of 39) |
| unchanged-row reuse on foreign reload | treat rows as unchanged by id alone | new `a foreign write rereads the session but keeps every unchanged row object` plus existing `review randomized snapshot equals full reload after 15000 mixed initialized-writer operations`, `known limit: uninitialized foreign writes stay stale until a recognized session change or reopen`, `full-row session revisions survive repeated clear/recreate and readers notice a lower restored stamp`, `100k-tag snapshots ignore foreign metadata and other sessions, but reload foreign same-session edits and reopened connections` (5 of 39) |
| probe reuse at writer admission | always trust discovery at admission | existing `changed negative-preflight revision rebuilds served fingerprints before the authoritative scan`, `fallback discovery revalidates a sibling commit after its revision snapshot`, `fallback adoption revalidates a negative discovery at the acquired writer` (3 of 46; this control ran locally, because the remote queue was full) |

## Verification

* Linux, 8 vCPUs, Bun 1.4.2.
  * `bun run typecheck` (TypeScript 5.9.3) passed.
  * `bun run lint` (Biome 2.5.1) passed: 308 files, 49 warnings. Master has the
    same 49 warnings on 307 files.
  * `bun run test` in `packages/pi-plugin`: 2,030 passed, 28 skipped, 0 failed;
    2,058 tests in 208 files.
* Plugin tests on the core table code (`storage-tags*`, `tagger*`,
  `tag-transcript`): 142 passed.

## Follow-up: review findings 1 and 2

The independent review in `docs/reports/pi-per-pass-cost-review.md` (cherry-picked
here) found two defects. Both are fixed. Its findings 3 and 4 also exist on master
and are unchanged; that known-gap test stays skipped.

### 1. Old-build writers were invisible to the cached fallback probes

Builds older than the `tag_revision:` triggers (v0.47.x, v0.48.x), and
connections that never ran `initializeDatabase`, do not advance the shared
revision. Every writer does advance `session_meta.tags_version`, through schema
triggers that fire on tag insert, delete and
`UPDATE OF session_id, message_id, tag_number, type, tool_owner_message_id, status`.

New TEMP triggers, `pi_tag_version_ai/ad/au`, count this connection's firings of
the same events in `pi_tag_version_own`. On each sync, the snapshot reads two
indexed scalars: `tags_version` and its own count. If the durable value moved by
more than this connection's own share, some write was missed by the revision.
The cached fallback rows are then rescanned on next use.

The common pass adds one two-scalar query and scans nothing. Other ways
`tags_version` can move, such as a session clear or the REPLACE-conflict
trigger, only cause an extra rescan.

The cached snapshot rows themselves keep master's approved limit for such
writers. The test `known limit: uninitialized foreign writes stay stale…` is
unchanged.

### 2. A pass could read two different tag states

`getPiActiveTagSnapshotView(db, session, passTags)` returns the cached active rows
only while the snapshot still holds the caller's `passTags` array. Every row
change publishes a new array. If another connection committed between the two
reads, the result is a filter of `passTags`, so both lists come from one state.

### Mutation controls

Each control followed the same procedure as above: stage the file, confirm an
empty `git diff --stat`, apply the mutant (marked `NON-VACUITY BREAK`), confirm a
non-empty diff, run the tests, then restore with checkout plus `touch` and
confirm an empty diff. The test run covered 7 files and 57 tests.

| fix | mutation | red tests |
|---|---|---|
| durable-counter detector | skip the `tags_version` delta check | only `witness (red on the branch, green on master): an old-build sibling's fallback row is visible to the cached probes after a local tag write` (52 pass, 4 skip, 1 fail) |
| one tag state per pass | ignore whether the snapshot moved since `passTags` | only `witness (red on the branch, green on master): a foreign commit between the two snapshot reads of a pass cannot split its active tags from its full tags` (52 pass, 4 skip, 1 fail) |

Both witnesses now run by default. Their names describe the reviewed commit
`b960feedfb`.

### Rerun

All runs were on Linux, Bun 1.4.2, using the same fixture and scripts as above.

* **Steady append.** The median hook total is **61.6 ms**, against 55.5 ms in the
  first delivery. Master measured 90.2 ms in the same job, against 87.1 ms before,
  so the machine was about 3.5% slower this time. Means: master 101.2 ms, branch
  65.1 ms. getTagsBySessionSnapshot is 0.49 ms median. Fallback identity and
  adoption is 6.0 ms against master's 6.1 ms. All 35 passes were identical.
* **Randomized differential.**
  * Seed 7: 114 of 114 passes identical (23 drops, 2 flushes, 6 folds, 26
    foreign writes, 11 model switches). Mean total 148.0 ms on master, 96.9 ms
    on the branch.
  * Seed 11: 114 of 114 identical (19 drops, 12 flushes, 5 folds, 23 foreign
    writes, 5 model switches). Mean total 151.3 ms on master, 104.0 ms on the
    branch.
* **Two-process driver.** Command: `two-process-review.ts --seed 23 --messages 700
  --start 400 --passes 80 --race 30 --historical 3000`. 80 of 80 lockstep turns
  were identical to master: served-JSON SHA-256, bytes, message counts and
  tag-row hash. 30 race rounds on each tree, with 0 invariant violations on
  either.
* **Linux, 8 vCPUs.** `bun run typecheck` passed. `bun run lint` passed: 309
  files and the same 49 warnings as master. `bun run test`: 2,032 passed, 32
  skipped, 0 failed (2,064 tests). An earlier run of the suite reported one
  failure while a benchmark job shared the machine. Its name was not captured;
  the rerun was clean.
