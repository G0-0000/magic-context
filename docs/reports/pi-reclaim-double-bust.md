# Pi reclaim "double bust" on 2026-10-12: the second bust is provider-side

Session `019e8905-3b53-7442-b79f-4ee106474820` (Pi, openai-codex `gpt-6.1-sol`, 375k window,
project `~/Work/Projects/CortexKit/antigravity-auth`). The brief named the reclaim at
15:28:51Z and the next request at 15:29:12Z.

## Verdict

- **Magic Context sent one rewrite per threshold crossing.** The 15:28:51 reclaim request
  already carried the refreshed m[1] (`## 38073-38120 …`) together with the trim. The
  15:29:12 request repeats every byte of it and only appends two items.
- **The second bust is a provider short read on byte-identical bytes.** openai-codex served
  only the 24,448-token instructions+tools prefix again, even though the reclaim request had
  just sent the whole prompt.
- **The "stale m[1]" was an analyzer artifact.** `analyze-pi-cache-busts.ts` paired request
  bodies with passes by file number. The capture extension's counter runs one ahead of Magic
  Context's ledger sequence, so the analyzer:
  - diffed the request before the reclaim against the reclaim request's predecessor, which
    is why it showed "message[907] … (message absent)" and `provider_short_read_identical_bytes`;
  - showed the reclaim's own m[1] change on the 15:29:12 row instead.
- **Invariants 2 and 4 held** for what Magic Context put on the wire. No Pi context-handler
  change is needed for the head; the regression guard below pins it.
- **Two real defects were found and fixed:**
  - the analyzer's body join, plus the misclassification that followed from it;
  - in the sentinel: starvation, and no rule that turns a second bust after a reclaim into an
    alert.
- **One more real Pi plugin defect was found and fixed.** A completed reclaim's
  `transform_decisions` row is dropped whenever the next pass starts 25 s or more after the
  reclaim started. That is why the reclaims read as `no_mc_pass_row`, and why the sentinel's
  "single reclaim" alert on `019de471` today was an unaccounted false alarm.

## 1. Which code path produced the stale m[1]: none

### Wire evidence for every reclaim in this session today

Method:
- Bodies are matched to ledger passes by file write time, not by file number.
- Hashes are taken over the provider `input[]` items.
- "Head fields" means `instructions`, `tools`, `prompt_cache_key`, `model` and `reasoning`.

All read-only; script `quantify.py`, see the appendix.

| rewrite (UTC) | bodies prev/reclaim/next | ledger seq (reclaim, next) | body write − pass (ms) | input[0] reclaim = next | input[1] reclaim = next | next is pure append | head fields equal | next request read |
|---|---|---|---|---|---|---|---|---|
| 01:07:03 | 504/505/506 | 504, 505 | 6, 11 | yes (43ef1b96) | yes (619b9f2d) | yes (387→393) | yes | 24,064 after 73.7 s |
| 01:45:12 | 538/539/540 | 538, 539 | 13, 16 | yes | yes | yes (381→388) | yes | 24,064 after 22.8 s |
| 02:07:09 | 557/558/559 | 557, 558 | 8, 7 | yes | yes | yes (437→444) | yes | 24,448 after 25.8 s |
| 02:37:56 | 575/576/577 | 575, 576 | 10, 6 | yes | yes | yes (477→486) | yes | 0 after 17.3 s |
| 02:54:17 | 581/582/583 | 581, 582 | 9, 112 | yes | yes | yes (497→504) | yes | 24,448 after 38.9 s |
| 03:14:21 | 598/599/600 | 598, 599 | 11, 7 | yes | yes | yes (547→554) | yes | 24,448 after 14.4 s |
| 03:40:39 | 634/635/636 | 634, 635 | 10, 10 | yes | yes | yes (579→583) | yes | 24,448 after 55.1 s |
| 04:09:34 | 668/669/670 | 668, 669 | 9, 8 | yes | yes | yes (571→576) | yes | 24,448 after 16.1 s |
| 10:20:17 | 740/741/742 | 740, 741 | 12, 10 | yes | yes | yes (716→725) | yes | 24,448 after 18.4 s |
| 11:36:08 | 835/836/837 | 835, 836 | 8, 10 | yes | yes | yes (728→744) | yes | 24,448 after 216.0 s |
| 12:29:21 | 870/871/872 | 870, 871 | 6, 7 | yes | yes | yes (672→681) | yes | 24,448 after 21.4 s |
| 13:45:24 | 1007/1008/1009 | 1007, 1008 | 8, 8 | yes | yes | yes (582→586) | yes | 24,448 after 43.3 s |
| 14:37:39 | 1086/1087/1088 | 1086, 1087 | 8, 10 | yes | yes | yes (619→621) | yes | 24,448 after 12.6 s |
| **15:28:51** | **1176/1177/1178** | **1176, 1177** | 8, 21 | yes (1c2760cb) | yes (5dea5e02) | yes (547→549) | yes | 24,448 after 20.9 s |

How to read the table:
- The "reclaim" body is the request the meter billed as the reclaim bust.
- Body file N always belongs to ledger sequence N−1. That off-by-one is the analyzer bug.
- In every row, the next request re-sends the reclaim request byte for byte, then appends.
  It still reads only the instructions+tools prefix (24,064 or 24,448 tokens), or 0.

15:28:51 in detail:
- **`1176-req.json` (15:27:37):** m[1] is 6,483 JSON bytes and ends `…I made no file
  changes.\n</new-compartments>`.
- **`1177-req.json`:**
  - Written at 15:28:51.749Z, 9 ms after ledger pass seq 1176 (15:28:51.740Z).
  - 547 items, against 909 before.
  - m[1] is 15,458 JSON bytes and contains `## 38073-38120 · Built and verified local 3.0.0
    outputs in staging`.
- **`1178-req.json`:**
  - Written at 15:29:12.702Z, against ledger seq 1177.
  - The same 547 items, with identical hashes, plus 2 appended.
  - `instructions`, `tools`, `prompt_cache_key`, `model`, `reasoning`, `include` and
    `text` are byte-identical.

### The five candidates

| candidate | finding |
|---|---|
| Second compartment preparation at 15:28:51.435Z | **Not the cause.** On an execute pass, the soft-refresh preflight (`context-handler.ts` ~7966-7982, `injectM0M1PiForRun(..., [], undefined, softRefreshOpportunity)`) refreshes m[1] and persists it before mutations open. That preflight emits the early `injected m[0]/m[1] … 15296 bytes` log at 15:28:48.492, right after `transcriptBuild`. The `prepareCompartmentInjection` stage at 15:28:51.435 is the wire injection: it replays that persisted pair into the outgoing array, so it logs no second "injected" line. A defer pass has no preflight, so its only "injected" line comes from the wire injection, which is why the 15:29:12 log shows it later. Both passes logged 15,296 bytes for the same m[1], and the bodies agree. |
| Compaction-marker drain re-rendering or replaying a cached head | **Not the cause.** The drain runs after injection (`context-handler.ts` ~9494-9626), only when the pending marker is covered by the rendered boundary (`pendingPiMarkerCoveredByRenderedBoundary`). It never touches the head bytes. |
| LKG capture/replay with the pre-refresh m[1] | **Not the cause.** The served bytes (1177) already carry the refreshed m[1]. The defer pass (1178) replays the same bytes. |
| Explicit-flush ride materializing m[1] after the request was built | **Not the cause.** Same body evidence: 1177 already carries the new m[1]. |
| Pi rebuilding context from the newly persisted compaction entry | **Not the cause.** The 15:29:12 pass got 870 raw messages, against 1,171 before, because Pi rebuilt from the compaction entry. MC still served 549 items whose first 547 equal 1177. |

### Regression guard

`packages/pi-plugin/src/pi-reclaim-single-bust.test.ts` drives one real Pi context handler
through three passes:
1. A low-usage baseline.
2. An execute-threshold pass at 75%, with:
   - a compartment published while deferring;
   - `signalPiDeferredHistoryRefresh` + `signalPiDeferredMaterialization`, which give
     `pending ops WILL APPLY — reason=deferred_publication`;
   - a queued drop;
   - a pending native compaction marker that drains through `sessionManager.appendCompaction`.
3. A defer pass at 40% with Pi's fresh `AgentMessage[]` plus a new turn.

It asserts:
- the defer pass serves the reclaim request's bytes as an exact prefix, then appends;
- the reclaim did all its queued work in its own request (pending ops drained,
  `appendCompaction` called once, marker cleared);
- that request carried the refreshed head and the trim together.

The test passes on master. That is expected, because the defect the brief hypothesised does
not exist (agreed with the parent). Mutation control: in the preflight branch, point the
wire injection back at the pre-refresh prefix (`piM0State.preparedPrefix =
cachedPrefixBeforePreflight`, which is the "LKG replays the pre-refresh m[1]" candidate). The
test then fails on the byte-identity assertion and shows the two heads the brief described:
- the reclaim request serves `<session-history-since>(no new content since last
  materialization)` with the untrimmed tail;
- the defer serves `## 1-2 · Published while deferring` with the trim.

A first attempt, flipping `isCacheBustingPass` on the wire injection, left the test green.
The preflight, not the wire injection, decides m[1] on execute passes.

### OpenCode twin

OpenCode does not have the split either. In `transform-postprocess-phase.ts`:
- `injectM0M1` (~3203) renders m[0]/m[1] with `isCacheBustingPass` before the marker drain
  (~3496-3595);
- the drain refuses unless the delivered prefix was trimmed through the pending boundary in
  this same pass (`trimWasProven` ~3511, refusal ~3530-3551: "the boundary only advances on
  a pass that actually trimmed through it").

Tests pin it in `transform-postprocess-phase.test.ts`:
- "keeps the marker-consuming fold byte-identical with the rebuilt defer wire" (~2534);
- "keeps execute and following defer bytes pinned while draining the same operations"
  (~3519);
- "replays byte-identical arrays after marker state is cleared between defer passes" (~1627).

All three pass on this branch (the 522-test run below).

## 2. Provider-side short read after a large rewrite

### Byte-verified (captured bodies, openai-codex)

Each row is a rewrite request (prefix changed) whose next request is a pure byte-identical
append.

| session | day | rewrites | next is pure append | next read short (< ½ of rewrite prompt) | gaps when short (s) | gaps when served (s) |
|---|---|---|---|---|---|---|
| 019de471 | 10-09 | 3 | 3 | 0 | – | 7.4, 7.8, 21.2 |
| 019de471 | 10-10 | 14 | 14 | 5 | 7.7, 10.3, 12.6, 13.5, 25.2 | 6.3 … 42.1 (9) |
| 019de471 | 10-12 | 15 | 15 | 10 | 7.9 … 235.9 (10) | 12.8, 48.6, 53.1, 64.4, 142.7 |
| 019e8905 | 10-08 | 24 | 24 | 0 | – | 6.9 … 243.3 (24) |
| 019e8905 | 10-09 | 1 | 1 | 0 | – | 10.5 |
| 019e8905 | 10-10 | 3 | 3 | 0 | – | 6.2, 6.2, 12.8 |
| 019e8905 | 10-11 | 12 | 12 | 3 | 8.6, 11.4, 13.5 | 4.7 … 22.4 (9) |
| 019e8905 | 10-12 | 19 | 19 | 14 | 12.6 … 216.0 (14) | 8.9, 11.5, 12.0, 14.9, 98.4 |

Totals and observations:
- **Totals:** 91 rewrites, all followed by a pure append. 32 of those appends (35%) read
  short. The median gap is 18.4 s when the read was short and 14.4 s when the prefix was
  served, so the gap does not explain it.
- **What a short read returned:** 24,448 tokens ×16, 24,064 ×7, 20,864 ×5 and 0 ×4. That is
  always the instructions+tools prefix, or nothing.
- **When it started:** 0 of 28 on 10-08…10-10 for `019e8905`, then 3/12 on 10-11 (from
  22:45Z) and 14/19 on 10-12. `019de471` shows the same rise (0/3, 5/14, 10/15). The trend
  is the same across two sessions and two projects.
- **Wider meter-only view:** over the last 30 days across every Pi/OMP session, 86 of 578
  openai-codex busts that were followed within 300 s had a next read below half of the bust
  prompt.

### Anthropic control

No captured Anthropic request bodies exist that contain a rewrite, so there is no
byte-verified control. Meter-only, the last 30 days hold 4 Anthropic busts followed within
300 s. All 4 are in OMP background sessions (`bg_426eaf42…`, `bg_ed0e5353…`). In each:
- the bust request wrote only about 27k (`cacheWrite`, the system/tools breakpoint);
- it billed the rest as uncached `input`;
- so the next request reading about 27k is consistent with what was written, which is a
  different mechanism.

The control therefore cannot rule anything in or out for Anthropic. It is reported, not
relied on.

## 3. Tooling fixes

### (a) Analyzer classification and alignment (`packages/pi-plugin/scripts/analyze-pi-cache-busts.ts`)

- **Why the join broke:**
  - `loadPiBodySnapshots` keyed bodies by the `<n>-req.json` number, and rows looked up
    `ledger.sequence`.
  - The two counters are independent: the capture extension's runs one ahead here, because
    of a request MC never recorded.
  - Both restart per Pi process, and later processes overwrite older files: `1177-req.json`
    has a birth time of Oct 6.
- **Fix:** `joinPassBodies` pairs each ledger pass with the first body written between
  250 ms before it and the next pass (at most 20 s after).
  - Real offsets were 6-112 ms.
  - It falls back to file numbers only when no body time fits any pass, as in copied
    fixtures, and the output then says `Body join: by file number …`.
  - Bodies are keyed by pass value, so a `--since` window still finds them.
- **Cross-check against the ledger:** when a body pair says "pure append" but the ledger's
  served array got shorter, the bodies are ignored. A shorter served array cannot be an
  append. The row then says `(request bodies contradict the ledger; ignored)` and cannot be
  labelled `provider_short_read_identical_bytes`.
- **Output:** each row prints the body files it compared.

Before and after, for `--since 15:27:30Z --until 15:29:30Z`:

| row | before | after |
|---|---|---|
| 15:28:51 BUST | `message[907] … (message absent)`, `provider_short_read_identical_bytes` | `message[2] … <session-history-since> …` diff at char 6413 adding `## 38073-38120`, bodies `1176 → 1177` |
| 15:29:12 BUST | m[1] diff, `no_mc_pass_row` | `message[548]` (append), `provider_short_read_identical_bytes`, bodies `1177 → 1178` |

The 15:28:51 row still says `no_mc_pass_row`, because its decision row was never written
(§4). On reclaims whose row exists, the pair now reads, for example:
- 04:09:34 `accounted_hard_marker_drain`, then 04:09:50 `provider_short_read_after_reclaim
  (cause: provider_short_read_identical_bytes)`;
- likewise 01:45, 02:38, 12:29 and 14:37.

### (b) Sentinel (`packages/plugin/scripts/cache-bust-sentinel.ts`, `cache-bust-attribution.ts`)

**Why 15:29 never alerted: starvation, not a filter.**
- The state file shows this session's watermark stuck at `2026-10-12T01:35:52Z`, while
  `019de471` advanced to 15:34.
- Every run today is `bounded: true`.
- `runSentinelOnce` takes sessions in the store's fixed `SELECT` order and stops at its
  30 s deadline after the session that crosses it. `019de471` came first, and its Pi
  analysis used the whole budget. `019e8905` was never analyzed after 01:37.
- **Fix:** `orderSessionsForScan` puts first the sessions with activity since their last
  scan, then the least recently scanned, then the most recently active.
  `lastScannedAtMs` is persisted per session. Two big sessions now alternate runs.

**The rule that alerts on a second bust.**
- **What the window logic did:** it alerted only on rows with unaccounted classes. Once the
  join is fixed, the 15:29 row's own class (`provider_short_read_identical_bytes`) is
  accounted, so the same window would never have alerted.
- **New classes (both unaccounted):**
  - `provider_short_read_after_reclaim`: a pure-append short read right after an
    `accounted_*` bust. It is named as provider-side, not as a Magic Context rewrite.
  - `double_bust_after_reclaim`: any other accounted class right after an `accounted_*`
    bust.
- **Where they are applied:**
  - by `classifyCacheBust` when given `previousBustClass`;
  - in the Pi analyzer;
  - in `groupBustWindows` for every harness.
- **The wake:**
  - carries `cause=<the row's own class>`;
  - prefers that row as the window's representative.
- **Across runs:** the open window persists `lastBustClass`, so a second bust analyzed in a
  later run than its reclaim still alerts.
- **What does not alert:** a lone reclaim. A short read after a provider-side miss does not
  turn into this class either.

## 4. Pi decision rows dropped for completed reclaims (`packages/pi-plugin/src/pi-context-budget.ts`)

The defect:
- Pi writes a busting pass's `transform_decisions` row late: the *next* context pass names
  the answering assistant and queues the write.
- The queued write is guarded by the reclaim pass's `assertDecisionPublication`. That guard
  threw once `elapsed() >= 25 s`, even after the pass had `completed`. Elapsed is measured
  from the reclaim's start, so the check really measured when the next turn began.
- The log shows `DISCARDED CONTEXT RESULT: pending/queued Pi transform decision` 17 times
  today. Each follows a reclaim whose next pass came 25 s or more later:

| reclaim → discard | gap |
|---|---|
| 01:07:01 → 01:08:16 | 75 s |
| 11:02:53 → 11:04:33 | 100 s |
| 15:28:48 → 15:29:13.8 | 25.4 s (the synchronous check at 15:29:12.4, at 24.0 s, still passed) |

- Reclaims with a quick next pass have no discard: 04:09 (16 s) and 04:57 (10 s).
- Without the row, the analyzer and sentinel see `no_mc_pass_row`. That is the unaccounted
  "single reclaim" alert seen on `019de471`, and it is why the 15:28:51 reclaim cannot be
  recognised as a reclaim.

The fix:
- A completed pass skips the elapsed check. `waitMandatory` already proved it finished inside
  the 25 s window.
- A refused dispatch still blocks the row: it sets `abandoned`, so a result whose request
  never went out records nothing.
- The deadline fence for an unfinished pass is unchanged (the issue 641 rule).
- One existing assertion in `pi-context-budget.test.ts` encoded the defect: "completed, then
  at 25 s, throws". It now asserts that a completed result keeps its row at 30 s, and a new
  test keeps the unfinished-pass fence.
- Rows already discarded today cannot be recovered. The analyzer test "names the pure append
  right after a recorded reclaim…" shows the pair classifies as reclaim, then
  `provider_short_read_after_reclaim`, once the row exists.

## Verification

All gates ran on Linux (ck-motor), bun 1.4.2, tsc 5.9.3, biome 2.5.1.
- **Full Pi suite:** `bun run test` in pi-plugin (8c): 2,047 pass, 28 skip, 1 fail of 2,076.
  The failure is `auto-search-bounded.test.ts` "Pi aborts slow embeddings at the deadline…",
  a wall-clock bound (4,051 ms against < 3,150 ms) under 8-way load. It passes 3/3 in
  isolation and never calls the changed guard.
- **Issue 641/640/663/667 tests + budget + decision-row tests:** 48 pass, 0 fail, 5 skip
  (53 tests).
- **Plugin affected tests:** cache-bust sentinel, scheduler-log, analyze-cache-busts,
  transform-decision-log, transform-postprocess-phase, transform-cache-busting-signals,
  compaction-marker-manager and inject-compartments: 522 pass, 0 fail.
- **Pi analyzer tests:** 14 pass. Sentinel: 40 pass.
- **Typecheck:** `bun run typecheck` in plugin and pi-plugin, exit 0.
- **Extra tsc over the Pi analyzer script and the new tests:** only the pre-existing error at
  `analyze-pi-cache-busts.ts:439` (`loadPiCacheBustDecisions` passes no `activityMs`). That
  file is outside every package's tsconfig.
- **Lint:** `bun run lint` in plugin and pi-plugin, exit 0 (warnings only, all in files this
  change does not touch). Biome on the two Pi analyzer files reports only pre-existing
  findings outside the changed hunks.
- **Mutation controls:** each turned its named tests red; restore was verified by an empty
  `git diff --stat`.

| control | tests that went red |
|---|---|
| Wire injection replays the pre-refresh prefix | the regression guard |
| Old elapsed check put back for completed passes | the 30 s decision-row test and the budget unit test |
| Elapsed fence removed | the expired-pass test and the unfinished-pass unit test |
| Sentinel relabel neutralised | the 3 after-reclaim tests |
| Session ordering removed | the rotation test |
| Write-time join forced to file numbers | the 2 reclaim-pair analyzer tests |
| Ledger cross-check removed | the contradiction test |

## Live stores and host runs

- **No Magic Context host run happened.** No OpenCode or Pi process was started.
- **Read-only diagnostics, all outside the repository:**
  - the Pi log;
  - the `pi-llm-debugging` bodies;
  - the Pi session JSONLs;
  - the served-array ledger JSONL and the sentinel state/log under
    `~/.local/share/cortexkit/magic-context/`.
- **The analyzer the brief prescribes** opens `context.db`/`store.db` read-only through
  `loadPiCacheBustDecisions`. Nothing was written, copied or migrated.

## Follow-ups (not done here)

- openai-codex's post-rewrite short read is new since 10-11 ~22:45Z and costs a second
  ~175k-token write per reclaim. It is worth raising with the provider route owner. A
  pre-warm mitigation was explicitly out of scope.
- The capture extension's file numbers restart per process and overwrite older bodies.
  Analyses of older days only see the newest process's files.

## Appendix: read-only quantification

The quantification scripts lived under `$TMPDIR/magic-context/pi-reclaim-double-bust/`:
- `quantify.py`: joins usage rows to ledger passes to bodies by write time and measures the
  next read after each rewrite;
- `meter_control.py`: per-provider, meter-only;
- `anth_detail.py`.

Core rule: a body belongs to the ledger pass when `pass_ts − 0.25 s ≤ mtime < pass_ts + 20 s`.
A rewrite is a meter bust whose body differs from the previous body before its end. "Next
read short" means `next.cacheRead < 0.5 × (input + cacheRead + cacheWrite)` of the rewrite
request.
