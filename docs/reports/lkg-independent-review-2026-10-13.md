# Independent LKG cache-safety and availability review

Reviewed `207e64e298dcb94309e29158a4998e363f66e901..cc47f005bb229f166b405925abd45c17d6569556`.
This is a **report-only review commit**: only witnesses and this report/evidence were added or extended. Product code, live stores, ARCHITECTURE.md and STRUCTURE.md were not changed.

Here, **LKG** means the persisted last-known-good provider request. A **recovery** returns that request's prefix plus new raw, untagged messages when SQLite's writer is busy. The **obligation** is to preserve those exact returned bytes until a declared prefix-rebuilding fold. Tags such as `§2§` are Magic Context's numbered text prefixes. OpenCode 1 and 2 are the legacy and v2 host adapters; Pi is the native Pi context hook.

## Recommendation

**Do not merge the range as-is.** The in-process byte handoff works, but two P1 gaps remain: Pi trusts an asynchronously recorded diagnostic digest as restart safety evidence, and Pi's rebuild strip misses signed thinking once a new user request closes the signed turn.

Keep OpenCode's conservative restart refusal for now. It is necessary with its current evidence, **not an inherent requirement of restart**. Restore availability with a small durable pre-return recovery fence (a record that the saved request may have been superseded), or persist the complete obligation if replay after recovery-and-restart is required. Do not copy Pi's current asynchronous digest scheme to OpenCode.

## Ranked findings

### P1 — Pi's receipt can be stale yet authorize restart replay and late tags

**Location:** `packages/pi-plugin/src/served-array-ledger.ts:128–165,371–403,506–527`; `packages/pi-plugin/src/pi-lkg.ts:587–599`.

`piLastServedMatchesLkg` accepts the last complete on-disk diagnostic row when its digest equals the persisted slot. But `capturePiServedArray` only enqueues that row: the flush is delayed 25 ms and unref'd. `beforeExit` is not a crash guarantee. Flush failures are swallowed, too. A complete *older* row is indistinguishable from proof that no subsequent recovery response was returned. A missing/truncated newest row is rejected only if it actually reached the file; absence of the newest row is not rejected.

**Full-handler, two-process test:** `packages/pi-plugin/src/lkg-review-receipt.test.ts`, test **`review witness: a lost busy receipt authorizes stale Pi restart bytes`**. In a throwaway root:

1. Serve a healthy head and flush its receipt.
2. Acquire SQLite's writer with a second connection; serve head plus `already served raw` through the real Pi handler.
3. Exit the child explicitly after the hook returns, before the queued busy receipt flushes (explicit exit models loss of process-local queues).
4. Start another child with the same files. Its restart proof returns **true** for the old head-only slot.
5. Its healthy output changes the already-returned tail from `already served raw` to `§2§ already served raw`.

The passing witness asserts that this unsafe behavior is present; it is **not** a claim of safety. It ran with seven assertions and printed `REVIEW_LOST_RECEIPT: stale digest trusted; already-sent tail gained a tag after process restart`. No provider request or live database was used. The obligation is created when the hook returns, so the result already contradicts the stated recovered-output invariant; an actual network/crash interleaving is not needed to demonstrate the missing durable fence.

**Required remedy:** stop authorizing restart from a best-effort diagnostic ledger. Persist a fail-closed marker/receipt before returning recovery, with a failure preventing return. Order its clean state after the matching LKG commit, and retain dirty state across any interrupted write. Also test a swallowed diagnostic write failure and concurrent writers. A counter stored only in SQLite alongside the slot cannot record a recovery while that same database is busy.

### P1 — Pi's completed signed turns survive a rebuild behind changed bytes

**Location:** `packages/pi-plugin/src/context-handler.ts:7825–7866,10294–10306`; witnesses in `packages/pi-plugin/src/context-handler-lkg.test.ts`.

The new recovery-rebuild strip is conditioned on `protectedSignedPrefix`, which requires an **active** thinking turn. A newly appended real user request makes the prior signed turn inactive. The later `prefixEditBesidesReasoningTrim` result does not include `recoveryRebuildReason` itself. Consequently a recovery rebuild can add tags before an older signature, or edit its preceding head, without removing that signature.

**Opt-in real-handler safety assertions** (enabled by `LKG_REVIEW_SAFETY=1`, because two intentionally fail on the reviewed product):

```sh
LKG_REVIEW_SAFETY=1 bun run --cwd packages/pi-plugin test \
  ./src/context-handler-lkg.test.ts -t 'after signed'
```

Bun 1.4.2: **2 passed, 2 failed, 24 assertions**. Exactly these tests failed:

- `Pi context handler LKG replay > rebuilds an unproven recovery prefix after signed restart`
- `Pi context handler LKG replay > rebuilds an unproven recovery prefix after signed content mismatch`

The same witnesses with an open signed turn passed (the restart cases use the repository's handler-session clear to simulate loss of coordinator state):

- `... after signed active restart`
- `... after signed active content mismatch`

The busy response contains untagged `unsigned before signature`, then a `thinking` block with `thinkingSignature: signed-proof`, with Anthropic/`claude-opus-5-5` assistant and context metadata. After restart plus a new user turn, the preceding unsigned message becomes `§2§ unsigned before signature`, while **the same signature is still returned**. In the mismatch case, `head` becomes `§2§ edited head`, and the unsigned message becomes `§3§ unsigned before signature`, again retaining the old signature. These are complete returned-array comparisons/inspection, not just tag-table checks.

Under the strict binding rule that a block binds to earlier bytes, both changes invalidate the signature. Signatures in these fixtures are placeholders, as in the repository's binding tests; no live Anthropic API was called. Thus the witness proves the invalid request construction, not an observed production HTTP 400.

**Required remedy:** when a declared recovery rebuild changes the prefix, persist omissions for all invalidated reasoning-bearing assistants, not only the active turn, before returning changed bytes. Make recovery rebuild an explicit prefix-edit cause in the completed-turn lane, with a persistence failure refusing the turn. Keep the active-turn controls: they demonstrate the current strip branch works and isolate the gap.

OpenCode's signed busy-tail witnesses refuse safely on both store generations. Its postprocess code also has a persist-before-rewrite path and generic first-edit detection (`transform-postprocess-phase.ts:2094–2117,2340–2349,4335–4398`). I did not obtain an unsafe OpenCode signed return. This does **not** turn the failing Pi result into a confirmed all-host safety guarantee; see limitations below.

### P2 — Intentional OpenCode availability loss; retained logs do not establish its restart frequency

**Location:** `packages/plugin/src/hooks/magic-context/lkg-recovery-prefix.ts:14–18,62–69,108–109`; `messages-transform.ts:301–302`; changed issue-653 restart tests.

OpenCode refuses a busy turn whenever an old persisted slot exists but its process-local served state is gone, including an ordinary clean restart with no prior recovery tail. That is a conservative behavior change, not a byte-safety defect. The two issue-653 expectation changes really remove a previous availability guarantee. Do not describe them as an unchanged contract.

**Live log counts, read-only:** the intended paths both exist after resolving `getconf DARWIN_USER_TEMP_DIR` to `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/`. I read `opencode/magic-context/magic-context.log{,.1}` and `pi/magic-context/magic-context.log{,.1}`; no compatibility shim was created. Counts and per-file sizes/hashes/time windows are preserved in `lkg-independent-review-log-counts.json`, sampled at approximately 12:18 UTC on 2026-10-13.

| Retained host logs | Busy/LKG replay lines | Busy refusal lines | Other LKG refusal lines | Hydration lines | Logged context-entry lines |
|---|---:|---:|---:|---:|---:|
| OpenCode `.1` + current | **0** | **0** | **0** | 57 | 6,486 |
| Pi `.1` + current | **7** | **0** | **0** | 12 | 4,714 |

OpenCode window: 2026-10-12 22:41 through 2026-10-13 12:18 UTC. Pi window: 2026-10-11 00:49 through 2026-10-13 12:16 UTC (the rotated file starts with a truncated line). Pi replay locations: `.1:8882,31013,89080,93264,128571`; current `:11819,12951`. The replay label is `TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG replay served ...`. OpenCode searches also covered `lkg_replay_served`, `lkg_replay_declined`, `lkg_restart_rebuild_required`, `lkg_replay_does_not_fit` and `STORAGE_BUSY_REFUSAL`.

Seven Pi replay events / 4,714 logged context entries is approximately **0.15% of this retained log volume**, not a fleet or restart-conditioned probability. No OpenCode refusal/replay occurred in its retained window. Hydration is not a busy-restart turn, logs can interleave processes, rotation discards history, and these logs do not demonstrate deployment of the reviewed change. In particular, **it is not possible to infer how many turns the new restart policy would refuse** or what fraction of the seven Pi replays immediately followed a restart. The concrete answer is zero observed OpenCode events, seven observed Pi replays, zero observed refusals, with restart-frequency uncertainty—not “restarts never need replay.”

## Availability design recommendation and cost

1. **Now:** keep OpenCode restart refusal and require Pi to refuse without durable safety evidence. Fix the two P1 gaps before merging. Given the retained OpenCode window has no events, do not weaken safety to save an unmeasured number of turns.
2. **Lower-cost follow-up:** store a versioned, session/host/model-scoped recovery-dirty fence keyed to the exact slot generation/digest. Mark it durably **before** any recovery output can be returned. Missing, corrupt, mismatched or dirty evidence refuses restart replay. Publish a clean certificate only **after** a matching successful LKG commit. Make interrupted publication conservative and serialize competing publishers. Never infer a clean state merely from an absent optional sidecar on upgrade.
3. This permits clean restarts to replay the saved request while busy without guessing. It still refuses recovery-then-restart until a healthy rebuild; that is appropriate if only clean-restart availability is required. Cost: a small record (hundreds of bytes), an atomic durable write/fsync on the first recovery since a slot commit, clean publication after commit, cross-process ordering and lifecycle/migration tests. It need not serialize the entire transcript on every defer pass. The fsync latency must be measured, not assumed zero.
4. **Full recovery-restart availability:** persist the complete obligation (ordered input IDs/content evidence, output ownership, exact serialized request including raw tail, withheld IDs, model/provider/system identity). Write it atomically and durably before return; validate it on restart; release only after the rebuilding fold. Cost: O(request bytes) disk write and storage per update plus durability latency and cross-process/crash/session-clear testing. Pi's diagnostic ledger stores a digest, not the obligation, so it cannot reconstruct the tail or prove the negative without reliable publication.

A served-pass counter/digest *with the slot* is useful only if every possibly served recovery advances durable evidence independently of the unavailable writer. Otherwise it repeats the stale-receipt problem. Reusing the SQLite busy store to write that counter is circular.

## Byte identity and ordinary-path differential witnesses

### Recovery, healthy defer, new messages, first fold

- OpenCode 1 and shared OpenCode 2 transform: extended `transform-degraded-pass.test.ts` compares the entire recovered MessageLike array against five healthy replay/defer passes (including new-message tagging). At the first system-hash fold the held answer acquires one marker, not two; a repeat produces exactly the folded bytes and identical tag rows. The older persisted tool drop remains applied. Both store generations passed.
- Pi: both prose-plus-result and two-result sequences compare complete returned arrays over five healthy passes, preserve every already-returned byte, and tag only new messages. The first fold gives each withheld result exactly one marker; the next pass returns identical bytes and tag rows. Existing decision-row attribution and later reduction assertions remain.

### Randomized corpus against master

`packages/pi-plugin/src/lkg-review-no-busy.test.ts` is an opt-in differential fixture derived from the existing independent host harness. Seed `0x653641` generates varied UTF-8, quotes, backslashes, literal marker-shaped text, tabs/newlines and lengths. Each host starts with 90 generated messages and appends a different generated message on each of 32 passes; Pi additionally includes a completed tool round. There is **no busy recovery** in this mode. OpenCode 1 goes through the wrapper; OpenCode 2 goes through real `registerContext`, including adaptation and the full `SessionContext` result; Pi uses its real context handler. The fixture is exported into master from this worktree's own Git objects and executed in a separate process with its own dependencies/stores. Both revisions use the same canonical disposable project directory.

Direct equality of **all 32 complete serialized requests per host**, not just first samples or implementation-derived hashes:

| Host | Requests baseline/candidate | Differences | Serialized corpus bytes | Equal SHA-256 |
|---|---:|---:|---:|---|
| Pi | 32 / 32 | **0** | 1,289,443 | `43d3774b62c82d79dbc79885fdc2329da649d5d6978d8835f8b9e3d57f0db646` |
| OpenCode 1 | 32 / 32 | **0** | 1,550,040 | `69820f3e1e4202cee04e0a94678135a0bdfd4a243343afd8f04eec1b7d5ff0c9` |
| OpenCode 2 | 32 / 32 | **0** | 921,416 | `94989c3b3a01d5e08dc663fc7de1835a512ba88385e677d6b3759b7a211f03cd` |

This is a seeded append/defer corpus, not exhaustive fuzzing of model switches, attachment conversion, all folds or provider network serialization. Failure-ordering witnesses cover additional paths separately.

## Failure ordering and session lifetime

- Twelve OpenCode real-wrapper/shared-transform cases (six each for v1 and v2) establish an outstanding obligation under a real second-connection writer lock, then change content, contract the branch, revert to an alternate branch, switch model, drop the session slot, or use another session with identical message IDs. **All twelve refused the locked request**, rather than returning cached bytes from the old obligation. After unlocking, healthy passes rebuilt; revert output contains the alternate branch and not the removed follow-up, and a cleared session tags its tail afresh. Both store-generation byte/fold cases passed in the same run: **14 passed, 90 assertions**.
- Pi real-handler witnesses passed for content mismatch, contraction, restart, revert, model switch, session clear and another session. Revert excludes the removed raw tail. Cleared/other sessions allocate ordinary tags instead of inheriting withholding state. With both byte/fold cases: **9 passed, 4 signed witnesses skipped by default, 62 assertions**. The signed witnesses were explicitly enabled separately; their two failures are the P1 finding, not skipped verification.
- Clear plumbing is session-keyed: OpenCode `dropSlot` calls `forgetInMemorySlot`, which clears the recovery state (`lkg-slot.ts:753–778`). Production model-switch and removal/compaction/deletion paths drop that slot (`hook-handlers.ts:385–405`, `event-handler.ts:1174–1177,1227–1235,1272–1280`). Pi's handler clear and explicit slot drop are exercised in the lifecycle witness. A fresh session with reused message IDs did not reuse another session's output.

## Two rerun mutation controls

These were the implementation report's controls 2 and 3, not new product changes. Each path was staged in its live state, `git diff --stat` was empty, the marked `NON-VACUITY BREAK` was applied, the nonempty diff captured, then the path restored with `git checkout -- <path> && touch <path>`. The post-restore unstaged diff was empty. Both controls produced **exactly one named failure**, with no other failures and all other tests filtered out:

| Control | Named failing test | Captured result | Applied / restored diff |
|---|---|---|---|
| Return no recovery prefix before OpenCode healthy tagging | `a degraded transform pass is never served > preserves the entire busy raw tail on healthy v1 passes` | Expected raw `answer`/`follow-up`; received `§6§ answer`/`§7§ follow-up`; 0 passed, 26 filtered, 1 failed | `lkg-recovery-prefix.ts`: 1 file, +1/-1 / empty |
| Always trust the older Pi persisted prefix | `Pi served-array digest ledger > restart evidence proves only the latest complete served bytes, never an older prefix` | Expected false, received true; 0 passed, 17 filtered, 1 failed | `served-array-ledger.ts`: 1 file, +1 / empty |

The first live control was rerun green through the extended v1/v2 recovery cases; the second through all 18 ledger tests. **No product mutation remains.**

## Gates, reproduction and limitations

All plugin/Pi tests ran on Linux with `runon: linux,4c`, Bun 1.4.2 (744846f84). TypeScript 5.9.3 package typechecks and Biome 2.5.1 targeted witness-file checks passed. Scoped editor diagnostics reported zero diagnostics but partial graph availability, so the package typechecks are the authoritative result. Targeted lint checked the three Pi witness files and one OpenCode witness file with no diagnostics. A new build/full workspace suite was not needed for report/test-only changes; the prepared base's build success is not claimed as verification of product safety.

Initial existing recovery/restart checks: OpenCode **79 passed, 0 failed, 291 assertions across four files** (`transform-degraded-pass`, `lkg-recovery-prefix`, `issue-653-review`, `messages-transform`); Pi **39 passed, 0 failed, 198 assertions across two files** (`context-handler-lkg`, `served-array-ledger`). Two additional requested filenames in that initial command did not select files; no coverage is claimed for them. After extending the witnesses, final OpenCode `transform-degraded-pass`, `lkg-recovery-prefix` and `issue-653-review` checks passed **56 tests, 271 assertions across three files**. The focused Pi checks above and the **19-pass/70-assertion** ledger-plus-lost-receipt run passed. The final baseline/candidate randomized runs each passed three tests/13 assertions and again produced the table's exact equal corpus files. The new Pi signed safety checks deliberately remain opt-in and red on the reviewed product.

Core reproduction commands (run in this worktree, on Linux):

```sh
# In-process bytes, lifecycle, and safe signed refusal.
bun run --cwd packages/plugin test ./src/hooks/magic-context/transform-degraded-pass.test.ts \
  -t 'review|preserves the entire busy raw tail'
bun run --cwd packages/pi-plugin test ./src/context-handler-lkg.test.ts \
  -t 'preserves complete busy recovery|rebuilds an unproven recovery'
bun run --cwd packages/pi-plugin test ./src/lkg-review-receipt.test.ts ./src/served-array-ledger.test.ts
# Deliberately red safety witness, with active-turn passing controls.
LKG_REVIEW_SAFETY=1 bun run --cwd packages/pi-plugin test ./src/context-handler-lkg.test.ts -t 'after signed'
bun run --cwd packages/plugin typecheck
bun run --cwd packages/pi-plugin typecheck
```

For the no-busy differential, make **fresh** disposable output/data roots for each revision, set `REVIEW_OUTPUT`, set one shared canonical `REVIEW_CWD`, and execute `bun run --cwd packages/pi-plugin test ./src/lkg-review-no-busy.test.ts`. Copy this witness into a `git archive 207e64e2` export, install its committed lockfile, run it there independently, and compare `pi.json`, `oc1.json`, `oc2.json` byte-for-byte with the candidate. The JSON files contain arrays of all 32 serialized outputs. The source-resolution assertion ensures Pi's core imports belong to the selected revision. The report table preserves the comparison evidence outside regenerable directories; generated synthetic request bodies and the export are disposable.

The baseline archive was not synchronized when initially placed only under ignored `target/`; transferring an archive from this worktree's own Git objects resolved that. Its separate package cache initially required network; the frozen-lockfile install then succeeded on `linux,4c,net` (1000 packages installed), with no manifest or lockfile change. Ordinary package test scripts checked 1013 installs across 1254 packages with no changes. A reused output root initially collided with the synthetic v2 table; fresh roots resolved that setup error.

No live stores were opened; only the two hosts' current/rotated logs were read. No provider HTTP calls, process restarts of installed hosts, or production locks were performed. These are hook/adaptation witnesses using disposable hosts and SQLite stores, not end-to-end provider cache telemetry. The randomized corpus is one reproducible seed, mostly append/defer, and does not establish all no-busy behavior. The OpenCode2 no-busy adapter fixture has an empty synthetic host store and does not capture a real LKG: attempts to extend it into a full `SessionContext` busy-handoff witness failed that prerequisite, so that extension was removed. OpenCode2 busy/healthy/fold bytes are proved at the real shared wrapper/transform with v2 seams, **not the entire v2 draft including system/tools/options**. That adapter-level handoff remains a verification gap. OpenCode's signed busy-tail witnesses return refusal rather than reaching a healthy signed-rebuild branch; that broader claim was source-reviewed but is not proved by those two tests. The retained log volume is insufficient to estimate restart-conditioned availability or justify silently removing the safe refusal.
