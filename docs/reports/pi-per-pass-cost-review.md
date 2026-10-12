# Independent review: Pi per-pass cost change

Reviewed: branch `alfonso/task/bg_e539f6f3c236300f-pi-cut-per-pass-cost-on-long-sessions-tag-snapsh`
at `b960feedfb`, against its merge base with master, `43ddbe1bec` (9 files,
+1,308/-133). The author's report is
[`pi-per-pass-cost-long-session.md`](pi-per-pass-cost-long-session.md).

The review changes no product code. It adds:

* `packages/pi-plugin/src/pi-per-pass-cost-review.test.ts`: witness tests,
  skipped by default. Run them with
  `PI_PER_PASS_COST_REVIEW=1 bun test src/pi-per-pass-cost-review.test.ts -t "<name>"`.
  The file loads on master too, so the same tests can be run on both trees.
* `packages/pi-plugin/scripts/experiments/perf/two-process-review.ts`: a
  driver that runs two Pi processes on one session against a shared
  `context.db`.

All runs used Linux (`ck-motor`, Bun 1.4.2). Master runs used a `git archive`
of `43ddbe1bec` in the job's `$TMPDIR`, with the branch's perf scripts copied
in, as the author did. Every database lived under
`$TMPDIR/magic-context/<run>-*` (the harness sets `XDG_*`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR` and `MAGIC_CONTEXT_TEST_DATA_DIR` inside it). No
live store, live config or Pi session file was opened. `OPENCODE_DB` was not
exported for the unit suites. No host (macOS) run was made, so there is no
`lsof` proof to give; the remote runner's job sandbox holds no live stores.

## Verdict

No case was found where the new caches serve a tag number the table no longer
holds when every writer is a current build. The randomized differentials and the
two-process run are byte-identical to master. Two defects remain, both narrow:

| # | severity | finding | witness |
|---|---|---|---|
| 1 | medium-low | The cached fallback probes no longer recheck the table after a local tag write. A `pi-msg-*` row written by an older build (v0.47.x/v0.48.x) to the same session stays invisible until the session's `tag_revision:` changes or the process restarts. Master rechecked on the next local tag write, which is almost every pass. | `witness (red on the branch, green on master): an old-build sibling's fallback row is visible to the cached probes after a local tag write` |
| 2 | low | A pass reads its full tags and its active tags in two calls. A foreign commit between them can make the active list disagree with the full list. On master the active list was always a filter of the full list. | `witness (red on the branch, green on master): a foreign commit between the two snapshot reads of a pass cannot split its active tags from its full tags` |
| 3 | info (pre-existing) | On master too, an old-build sibling's drop for an already-served message, committed between two passes, is not adopted. | `known gap (red on master and on the branch): …` |
| 4 | info (pre-existing) | Two module instances that share one SQLite connection would each consume the other's change journal. Master has the same journal code. | none |
| 5 | info (perf) | `lkgCapture` outliers occur on master too, up to 2.3 s, including a 1,052 ms one. Over five paired runs the count is 10 on master and 12 on the branch. The capture code is unchanged, and I found no link to this change. | §5 |

## 1. Staleness under cross-process writes

### How each cache is invalidated

The branch keeps master's invalidation rule for the tag snapshot. A snapshot
entry stores two values. `revision` is this connection's own count of tag
writes to the session (TEMP table `pi_tag_session_revision`). `foreignRevision`
is the `serial:count` value of `tag_revision:<session>` in
`schema_migrations_meta`, minus the own count. If `foreignRevision` changes, the
entry rereads every row of the session. If only `revision` changes, it rereads
just the tag numbers in this connection's TEMP journal (`pi_tag_changes`).

The new structures are all derived inside that same `sync`:

* `active` and `fallback` are merged from the same changed numbers, or rebuilt
  on a full reload (`fallback` is set to undefined and reloaded on next use).
* Unchanged-row reuse only replaces a fresh row with a cached object when `id`
  and every field compare equal with `Object.is`. A reused object therefore
  equals the row just read. `toTagEntry` always returns the same 15 keys, so
  reading the key list from the first row covers every row.
* `servedTagNumbers` uses a binary search, which needs `allTagsForPass` sorted
  by tag number. Every producer keeps that order: `getTagsBySession` and
  `getTagsByNumbers` both use `ORDER BY tag_number, id`, the journal is read in
  `ORDER BY tag_number`, and both merge paths keep it. The result is a set, so
  the order of the lookups does not matter. Same predicate as master's filter.
* `protectedToolTagNumbers` and `newestActiveTagNumbersByCount` already ignored
  non-active rows. `channelBaselineSnapshot.tags` and `.activeTags` are both
  set from the pass-start reads (`runPipeline`, around line 9852), so the
  compaction-off call site at line 5742 sees the same pass as before. See
  finding 2 for the one exception.
* The `INDEXED BY idx_tags_session_message_id` pin uses a full index created by
  `initializeDatabase` (`storage-db.ts:1947`) that three sibling statements
  already pin. Only the plan changes, not the result.

So the new caches can only be as stale as the snapshot itself. The question
becomes which writers advance `tag_revision:<session>`.

### Who advances `tag_revision:<session>`

The signal comes from the TEMP triggers `mc_tag_revision_bi/ai/au/ad`, installed
by `installTagIdentityRevisionTrigger`. TEMP triggers exist only on the
connection that created them.

| writer | advances `tag_revision:`? | evidence |
|---|---|---|
| current Pi process (handler, adoption, flush, heuristics, historian in-process) | yes | `openDatabase` runs `initializeDatabase`, which installs the triggers (`storage-db.ts:2546`), and installs them again after migrations (`storage-db.ts:2702`, async path `2838`) |
| current OpenCode process on any session | yes | same `openDatabase` |
| migrations | yes | `initializeDatabase` runs before `runMigrations` on the sync path and inside `migration-worker.ts` before the worker migrates. No migration in `migrations.ts` writes `tags` rows; the only `tags` statement is `ALTER TABLE tags ADD COLUMN tool_owner_message_id`. The OpenCode 2 harness relabel rewrites only OpenCode-harness rows. |
| `ck-mc doctor` / CLI | not applicable | CLI opens with `openExistingContextDatabase`, which installs no triggers, but no CLI command writes `tags` (only row counts in `doctor-repair-db.ts:34`, `doctor-pi.ts:114`, `doctor-opencode.ts:158`). `doctor repair-db` runs `initializeDatabase` itself. |
| dashboard (Rust) | not applicable | reads `tags` through `open_readonly` only (`db.rs` around 8620) |
| rollback, renumber, move, REPLACE, clear-and-recreate | yes | the triggers cover BEFORE INSERT conflicts, OLD and NEW sessions on UPDATE, and DELETE; a recreated revision row gets a new serial. The author's suite covers these (`tag-snapshot-pi.test.ts`, `review initialized foreign REPLACE …`, `full-row session revisions survive repeated clear/recreate …`), and my mutation 3 below reddens all of them. |
| issue 650 publication (`saveLkgSlotToDb` with `publishServedNumbers`) | not applicable | writes the LKG slot and served-number ledger, not `tags` |
| a commit between preflight and writer admission | adoption does not rely on the KV signal | see §2 |
| **v0.47.x and v0.48.x builds** | **no** | v0.48.0 installs only `mc_tag_identity_revision_au`, which bumps a different key, and only on UPDATE of identity columns. v0.47.0 installs nothing. The `mc_tag_revision_*` triggers first appear in `873ee68257`, after v0.48.0. |

### Is the "uninitialized foreign writes" limit reachable in production?

Yes, but only through mixed versions. `LATEST_SUPPORTED_VERSION` is 95 at
v0.47.0, v0.48.0 and master, so an older Pi build opens and writes a store that
a newer build already uses; the schema fence does not stop it. An older Pi build
and a newer one serving the **same Pi session** at the same time (for example a
terminal left running across an upgrade) is the case. The project already
treats 0.47.0 interoperability as in scope (`issue 650 release
interoperability` in `issue-650-pairing-review.test.ts`). Current-build writers
never hit it, and I found no current-build path that writes `tags` without
the triggers.

For the tag snapshot itself, this limit is unchanged from master. For the
fallback probes it is wider; that is finding 1.

### Finding 1: the cached fallback probes lost master's recheck on local writes

On master, `fallback-tag-probes-pi.ts` cached each probe under the pair
`(own revision, foreign revision)`. Every pass that tags a new message changes
the own revision, so the next probe queried the table again. That recheck
also caught rows that an old build had committed without advancing the KV
signal.

On the branch the probes answer from `snapshot.fallback`. A local write only
rereads the numbers this connection changed, so a row an old build inserted
under another number is never read. It stays invisible until `tag_revision:`
changes (a current-build writer touches the session) or the connection is
reopened.

The witness sets this up: an initialized connection writes tag 1, the probes
answer "none", an uninitialized sibling inserts a `pi-msg-*` message row and a
`pi-msg-*` tool-owner row, then the initialized connection writes tag 4. On
master both probes then return `true`. On the branch both return `false`:

```
  {
-   "message": true,
-   "tool": true,
+   "message": false,
+   "tool": false,
  }
(fail) witness (red on the branch, green on master): an old-build sibling's fallback row is visible to the cached probes after a local tag write
```

**What the stale answer changes.** Only the preflight at `runPipeline` (line
8207) uses the cached message probe. A false "none" means
`readPiFallbackFingerprintHeaders` is skipped, so fingerprints are not prepared
for already-tagged messages whose header matches a fallback row. Adoption still
probes the table under the writer, but it only adopts fingerprints it was given.
Tool-owner adoption and the tool-call guard do not use the cached probe.

I tried to turn this into a served-byte difference with the full handler (third
witness below) and could not: master also failed to adopt the row in that
interleaving, for a reason unrelated to the probe (finding 3). So the defect is
shown at the probe and its served-byte effect is unproven.

**Suggested fix.** `session_meta.tags_version` is maintained by durable schema
triggers (`tags_version_ai/ad/au`, present since v0.47.0), so it advances for
every writer, old builds and raw connections included. A TEMP counter on this
connection, firing on the same events, would let the reader compute
"durable delta minus own delta". A non-zero result means a foreign write the KV
signal missed, and should trigger a fallback rescan or a full reload. The author
proposes this counter in their report but did not implement it. A smaller
alternative is to keep master's recheck for the fallback rows only: rescan them
when the own revision changed, which costs the `LIKE` scan the branch removed.

### Finding 2: a pass can see two different tag states

`runPipeline` reads `allTagsForPass = getPiTagSnapshotView(...)` and then
`activeTags = getPiActiveTagSnapshotView(db, sessionId, allTagsForPass)`.
Outside a transaction the second call runs `sync` again and ignores
`allTagsForPass`. If another process commits between the two calls, the second
sync reloads and `activeTags` comes from newer table state.

The pass uses both lists. `computeProtectionWindow`, `servedTagNumbers` and the
channel baseline `tags` read the full list. Heuristics,
`newestActiveTagNumbersByCount` and `protectedToolTagNumbers` read the active
list. On master the active list was always `allTagsForPass.filter(...)`.

The witness commits a drop of tag 3 and a new tag 6 between the calls. On the
branch the active list is `[1, 2, 4, 5, 6]` while the full list's active rows
are `[1, 2, 3, 4, 5]`. On master they are equal.

The window is the gap between two adjacent statements, so this needs another
process to commit at that moment. Neither list is wrong on its own; what can
break is any logic that assumes one is a filter of the other. I did not find a
path where this gives a wrong or duplicate served number: `servedTagNumbers`
reads only the full list. **Fix:** return `tags` and `active` from one `sync`,
or fall back to filtering `allTagsForPass` when `snapshot.tags !==
allTagsForPass`.

### Finding 3 (pre-existing): an old-build drop committed between passes

`issue-640-review`'s racing drop expects a sibling's dropped fallback row for an
already-served message to become a pending drop. That test commits during the
pass's preflight. My third witness commits the same row between two passes,
after the session's revision row exists. Master and the branch both leave the
row alone, so no pending op is queued:

```
-   "pending": [ 1 ],
+   "pending": [],
     … { "status": "dropped", "tag_number": 9 } stays
```

On master, the probe and the header read did run. Under the writer, though, no
`findAdoptableFallbackTags` query followed, so the gap lies in adoption's target
selection, not in either tree's caches. I did not trace it further; it is
outside this change.

### Finding 4 (pre-existing): one connection, two module instances

The TEMP journal `pi_tag_changes` belongs to the connection, and every `sync`
deletes the session's entries after reading them. If two copies of
`tag-snapshot-pi.ts` used one connection (an extension reload that kept the
old instance alive), each would delete entries the other had not read. That
copy would then see its revision change with an empty journal and keep stale
rows. Master has the same journal code. The branch adds `active` and `fallback`
to what such a copy would hold stale. I did not find such a reload path; this
is noted, not witnessed.

## 2. Adoption revalidation (`unchangedSinceDiscovery`)

The writer reuses the two existence probes only if `PRAGMA data_version` and
`total_changes()` are unchanged between `beforeDiscovery` and the read made
after `BEGIN IMMEDIATE`.

* `data_version` changes for a commit by any other connection, in this process
  or another, whatever triggers it has. Reading it opens a read transaction,
  so it reflects the newest commit. After `BEGIN IMMEDIATE` it includes every
  commit made before the lock was granted.
* `total_changes()` counts this connection's row changes, including TEMP
  tables and trigger bodies.
* `adoptPiFallbackTags` is synchronous. Between discovery and `BEGIN
  IMMEDIATE` no other JavaScript runs, and the only writes are other
  connections' commits, which `data_version` sees.
* `ownerMap` is the live `fallbackIndex.owners` map. Nothing updates it during
  the synchronous call. When `ownerMap` is empty the probe is skipped, but the
  loop under the lock could match nothing anyway.
* When `expanded` is true and `unchangedSinceDiscovery` is also true, the
  message probe is a table read taken after `beforeDiscovery` with no commit
  since, so it is still correct.

**Interleavings tried.** A sibling commits a `pi-msg-*` tool-owner row after the
tool-owner probe answered "none" and before `BEGIN IMMEDIATE`. It does this
from an initialized sibling and from an uninitialized one. In both cases the
writer reran the probe and re-keyed the row to `real-owner`:

* `a tool-owner fallback row an old-build sibling commits just before writer admission is still re-keyed`: pass
* `a tool-owner fallback row an initialized sibling commits just before writer admission is still re-keyed`: pass

With `unchangedSinceDiscovery` forced to `true` (mutation 2), both go red:
`tool_owner_message_id` stays `pi-msg-0-1-assistant`. A commit landing before
`beforeDiscovery` is seen by the discovery reads themselves. A commit landing
between the `data_version` read and the `total_changes()` read is also seen by
those reads, and it leaves the admitted `data_version` different. I found no
interleaving that adopts a wrong identity.

## 3. Byte identity

Randomized differential with two new seeds. The command is the author's, with
`--chaos-seed 29` and `41`:

```sh
bun scripts/experiments/perf/run.ts --messages 2600 --hidden-messages 87600 \
  --points 88300,89000,89700,90000 --pi087 --external-writes --lingering-fallback \
  --historical-tags 60000 --historical-mix --foreign-tag-interleave 3 \
  --chaos-passes 110 --chaos-seed <seed> --output <tree>-<seed>.json
```

| seed | identical passes (wire SHA-256, tag-row hash, bytes, in/out counts) | events | distinct wire hashes |
|---|---:|---|---:|
| 29 | **114 / 114** | 31 drops, 11 flushes, 9 folds, 6 model switches, 18 foreign rewrites, 9 foreign drops | 94 |
| 41 | **114 / 114** | 20 drops, 4 flushes, 8 folds, 9 model switches, 22 foreign rewrites, 12 foreign drops | 93 |

Seed 7 (the author's) was also rerun sequentially on both trees. Its wire-hash
sequence digest was `22bf4e27ceb14e72` on both. The steady append command (31
measured passes) gave digest `0f646e47de3b8865` on both trees in all four runs.

**Two Pi processes on one session.** Driver:
`two-process-review.ts --seed 23 --messages 700 --start 400 --passes 80 --race 30 --historical 3000`.
Two child processes each open their own connection and handler. The parent
seeds 3,000 historical tags and acts as a third writer: queued drops, direct
drops, row rewrites, flush passes and model switches.

* Lockstep phase. The children alternate turns, so each one's writes are
  foreign to the other. **80 / 80** turns had the same served-JSON SHA-256,
  byte count, message counts and persisted tag-row hash on master and the
  branch.
* Race phase. Both children serve the same transcript at the same moment, for
  30 rounds. Checks: no failed transform, every served `§N§` number exists in
  the table, and no tag number is stored twice. **0 violations** on either tree.
  In 3 of master's 30 rounds the two processes served different bytes; on the
  branch, none did. Race timing differs from run to run, so this count is not a
  comparison between trees.

**Gap.** Neither differential compared the issue 650 served-number ledger. That
ledger is written from `servedTagNumbers`, whose set equals master's: same
predicate, and the lookup sees every row with each target number because the
snapshot stays sorted (§1).

## 4. Mutation controls

Procedure for each: `git add` the file so `git diff --stat` was empty, apply the
mutant marked `NON-VACUITY BREAK` (`git diff --stat` non-empty), run, then
`git checkout -- <file> && touch <file>` (`git diff --stat` empty again). Each
mutant ran against two sets. Set A is this file's green tests
(`-t "initialized sibling|tool-owner fallback row"`). Set B is the six suites
the author's controls touch: `tag-snapshot-projections-pi`, `tag-snapshot-pi`,
`fallback-tag-probes-pi`, `fallback-adoption-cost`,
`append-cache-review-regressions` and `issue-640-review`, 51 tests in all. Both
sets passed unmutated: A 3/3, B 51/51.

| mutation | red in set A | red in set B |
|---|---|---|
| 1 (author's #1): keep the old `active` array on incremental sync | none (that test's foreign write forces a full reload) | `the active tag projection equals a fresh status filter after local, foreign, rollback, renumber and move writes` only (1 of 51). Matches the author. |
| 2 (author's #4): `unchangedSinceDiscovery` always true | both `tool-owner fallback row … just before writer admission` tests (2 of 3) | `changed negative-preflight revision rebuilds served fingerprints before the authoritative scan`, `fallback discovery revalidates a sibling commit after its revision snapshot`, `fallback adoption revalidates a negative discovery at the acquired writer`, `review control: lock-free owner preparation adopts a sibling's later committed tool owner` (4 of 51; the author reported the first three) |
| 3 (mine, on the revision signal): the Pi reader's `foreign_revision` is the constant `'0:0'`, so `tag_revision:<session>` is ignored | `an initialized sibling's writes reach every cached projection after a local write` only (1 of 3) | 14 of 51, including `review randomized snapshot equals full reload after 15000 mixed initialized-writer operations`, `cached fallback rows answer every pi-msg probe exactly like the table after mixed writes`, `a foreign write rereads the session but keeps every unchanged row object`, `full-row session revisions survive repeated clear/recreate …`, `review initialized foreign REPLACE renumber/session move …` and `Pi fallback probes cache metadata-only passes …` |

## 5. `lkgCapture` outliers

`lkgCapture` times the deferred LKG capture (`pi-lkg.ts:979-1141`): digesting
the inputs, then `saveLkgSlotToDb`. The diff does not touch this code.

Maximum `lkgCapture` per run (ms), the first four passes excluded. "Outliers"
counts passes over 150 ms (over 200 ms for the concurrent runs).

| run | master max (outliers) | branch max (outliers) |
|---|---:|---:|
| steady append, run 1 | 12.8 (0) | 12.8 (0) |
| steady append, run 2 | 15.0 (0) | 14.5 (0) |
| chaos seed 7, sequential | 27.8 (0) / 39.5 (0) | 204 (1) / 943 (3) |
| chaos seed 41, sequential | 627 (2) | 1,171 (3) |
| chaos seed 29, 4 runs sharing 8 vCPUs | 188 (0) | 1,346 (2) |
| chaos seed 41, 4 runs sharing 8 vCPUs | 643 (3) | 1,136 (2) |

* **Outliers do occur on master:** 360 and 627 ms (seed 41, sequential) and
  643 ms (concurrent). The author measured master maxima of 1,396 and
  2,007 ms. On both trees, outlier passes are mostly ones that reused almost
  the whole digest prefix (`reusedPrefix` above 2,500), so they are not
  full-digest work.
* **The 1,013 ms steady-append outlier did not reproduce** on either tree in
  two steady runs each; every steady pass stayed under 16 ms.
* **The four paired chaos runs above leaned against the branch.** It had 11
  outliers against master's 5, and a 1.35 s maximum against 0.64 s. Other
  workers' jobs shared the host, and each seed ran once.
* **A fifth pair reversed that.** Seed 7 was run again on both trees with
  `BUN_JSC_logGC=1`, sequentially:

  | tree | `lkgCapture` passes over 150 ms (pass = ms) | five longest GC log timings (ms) |
  |---|---|---|
  | master | 6 = 253, 48 = 539, **102 = 1,052**, 105 = 2,286, 110 = 599 | 262, 377, 384, 404, 474 |
  | branch | 82 = 338 | 174, 185, 203, 218, 299 |

  Master produced a 1,052 ms and a 2,286 ms capture on the same schedule where
  the branch produced one 338 ms capture. Both trees log garbage-collector
  timings of several hundred ms. Across all five pairs the totals are 10
  outliers on master and 12 on the branch.

The outliers come from the environment, most likely garbage collection or the
host, and they occur on master at the same magnitude, including a value just
above 1 s. I found no evidence that this change causes them. The GC
correlation is indirect: the log timings were pulled out with a crude regular
expression, not matched to individual passes.

## Verification

* `bun run test` in `packages/pi-plugin` at `b960feedfb` (Linux, 8 vCPUs,
  Bun 1.4.2): 2,030 passed, 28 skipped, 0 failed; 2,058 tests in 208 files.
  This matches the author.
* With this review's files added (Linux, Bun 1.4.2):
  * `bun run test`: 2,030 passed, 34 skipped (the 28 above plus this file's
    6), 0 failed; 2,064 tests in 209 files.
  * `bun run typecheck` (TypeScript 5.9.3): exit 0.
  * `bun run lint` (Biome 2.5.1): 309 files, 49 warnings, exit 0. The author
    reported the same 49 warnings on 308 files. `biome check` on
    `two-process-review.ts`, which the package lint does not cover: clean.
* `MC_PAIRING_REVIEW=1 bun test src/issue-650-pairing-review.test.ts` (the
  prior issue 650 review controls, skipped by default) gave the same result on
  both trees: 15 passed, 1 failed, 2 skipped. The failure is
  `review: stale pass after commit retains admitted reservations and LKG with
  zero OMP sends`, red on master as well. It passes `two Pi processes and an
  OpenCode namespace writer keep all dispatched numbers` on both trees.
* This file's witnesses, on the branch / master:
  * `witness (red on the branch, green on master): … visible to the cached probes …`: red / green
  * `witness (red on the branch, green on master): … split its active tags …`: red / green
  * `known gap (red on master and on the branch): …`: red / red
  * the other three tests: green / green
