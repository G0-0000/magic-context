# ALF: historian overlap split one execute into two cache busts

## Finding

Session `ses_227ce5788ffeRPA9THoPLOQreO`, 2026-09-07 07:15:46Z, TypeScript transform. This is a **#4975 cache-path change**; the ride-only policy is deliberately separated from the historian-overlap fix in two commits.

The historian veto did **not** distinguish `shouldApplyPendingOps` from `shouldRunHeuristics`. Both were closed. The escaping lane was the subsequent **tool-reclaim age sweep**, which did not share their final cache-busting permission. It removed five arcs while m[1] replayed its previously cached bytes. The later pass delivered the pending published compartments and refolded, causing a second priced rewrite.

The chair recovered the rotated log after the initial investigation. These supplied excerpts are reproduced verbatim, in order:

```text
transform scheduler: percentage=75.0% inputTokens=654172 cacheTtl=never lastResponseTime=… decision=execute
system prompt date frozen: real=Today's date: Mon Sep 07 2026, using=Today's date: Sun Sep 06 2026 (defer pass)
transform: deferring pending ops — compartment agent in progress
tool reclaim auto-drop: targets=5 mutated=true
transform: injected m[0]/m[1] (rematerialized=false, reason=cache_hit)
final representation: clearedParts=20 mergedReasoningParts=7
transform completed in 595.2ms (517 messages, 840 targets, watermark: 102094)
```

Evidence provenance: the chair supplied these from `$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context/magic-context.log.1`. This task did not read operator files outside its worktree. The requested local triage skill was absent; its knowhow search entry existed but fetching it failed. The chair authorized proceeding using these excerpts and ARCHITECTURE.md.

The date message's **“defer pass” on a byte-changing execute** is a particularly useful symptom: the age sweep changed bytes outside the permission used by the other lanes. `materialized=0` or the log's `reason=cache_hit` alone would not establish unchanged m[1]; the chair's provider-wire comparison does. The first request diverged at message[99] while merged m0+m1 at message[0] was byte-identical. At 07:18:59, the next execute delivered 1132+1133 and reported `pressure_refold`.

## Source-level predicates and their differences

References in this section describe base `532cc2fa9047a7dc4aad5ee9c18eedfa39d580f2`, unless stated otherwise.

| Site | Opportunity / veto | Running-state source |
| --- | --- | --- |
| `transform.ts:1422–1435`, early deferred-history consumption | Effective, mid-turn-adjusted execute or force band; helper veto below force; explicit history refresh separately bypasses deferred gating | `getActiveCompartmentRun(sessionId) !== undefined OR sessionMeta.compartmentInProgress`; in-memory run plus persisted restart-recovery flag, not a direct lease query |
| `transform.ts:2203–2211`, late deferred consumption | Same helper, but `justAwaitedPublication` returns true before the veto/scheduler checks | **Only** the active-run map; no persisted `compartmentInProgress` operand |
| `prepareCompartmentInjection`, `inject-compartments.ts:331–654` | No running-state test of its own. Receives `isCacheBusting`; false replays the cached boundary/block, true rebuilds | None |
| `transform-postprocess-phase.ts:1168–1174,1307–1373` | Pending ops: execute OR materialization request OR primary force OR executed fold. Heuristics additionally have emergency/subagent and once-per-turn rules. Both require `!compartmentRunning OR forceMaterialization OR foldExecutedThisPass` | `canRunCompartments AND !awaitedCompartmentRun AND activeRun !== undefined`; map-only, with capability and awaited-run exclusions absent from the early check |
| Age sweep, `transform-postprocess-phase.ts:1733–1745` | Separate execute/ride predicate, **not** the final `isCacheBustingPass` veto | No running-state operand |
| Final m[1], `transform-postprocess-phase.ts:1926–1939`; `inject-compartments.ts:3306–3313` | Receives `isCacheBustingPass = shouldApplyPendingOps OR shouldRunHeuristics`; false replays cached m[1], true reads published rows | No additional historian veto inside the renderer |
| Pi, `context-handler.ts:4755–4758,4891–4910,5097–5099` | Deferred consumption already lacked the OpenCode early veto; pending ops/heuristics had a map veto with force/executed-fold bypass. Detached publication has no inline-awaited-publication exception | `inFlightHistorian.has(sessionId)` only |
| Rust, `transform.rs:2820–2830,4132–4150,4334–4355` | `ordinary_historian_veto` suppressed ordinary execute opportunities; initialized/render-config/HARD/explicit-refresh/reconcile/emergency-latch conditions supplied exemptions. Force85/Emergency95 are scheduler variants, unlike TS booleans | `lib.rs:4537–4549,8600`: live historian-session map **or** durable `historian.state != Idle`, not a direct compartment-lease probe |

The checked-out base already contains a partial ride condition on the age sweep, rather than the historical pressure-only form. Its `alreadyMutatingThisPass` includes `didMutateFromFlushedStatuses` and history-prepare observations. Replaying a previously frozen status is not an independently priced new mutation. The regression demonstrates that this partial condition still admitted age-only wire changes. The runtime excerpts establish the escaping lane; the fixture establishes the remaining source-level weakness without assuming the recovered log was produced by this exact base build.

Neither rendering published rows nor applying reductions can alter the historian's raw input. ARCHITECTURE.md's disjoint-DB model remains the safety basis: raw harness history is the historian's source; its raw-only fingerprint excludes drop/tag state. Run registration, producer leases, range validation, publication ownership, and idempotent post-publish drop queuing were not removed.

## Fixes

### Commit 1: published-work drain

`119e91a5` removes the inappropriate published-work historian veto in the TypeScript deferred-consumption helper and the harness drain permissions. The Rust veto yields when a published m[1] revision exists. The TS age sweep must also pass the same permission used by final m[1] injection.

The old tests asserting that an explicit flush or published execute must wait for a historian were intentionally changed: that was the unsafe contract being replaced, not an incidental expectation adjustment.

### Commit 2: ride-only automatic reductions

- `cache-busting-signals.ts:36` defines `hasReclaimRide`, shared by OpenCode and Pi. Automatic cleanup requires an executed fold, force-band eligibility, explicit flush, published prefix work, or an **actually applied** agent drop. Ordinary execute pressure alone is insufficient.
- `transform-postprocess-phase.ts:1207–1244` and `context-handler.ts:4817–4846` pre-execute eligible m[1] refreshes off-wire. A changed persisted m[1] supplies the independent ride; an unchanged refresh does not. This also catches published work without a process-local notification and lets a pressure refold carry reductions in the same pass.
- `transform-postprocess-phase.ts:1311` and `context-handler.ts:4909` assemble the ride signals. An agent drop promotes the permission only after application reports a real mutation, so protected/absent no-op requests do not authorize heuristics.
- TS age selection (`transform-postprocess-phase.ts:1711`), Pi age selection (`context-handler.ts:5608`), processed-image detection, and final m[1] delivery use the shared permission. Frozen status replay cannot originate a ride.
- Rust's `selection.rs:965` shares `reclaim_ride_available` among age, deduplication, and ordinary supersession. Eligible agent decisions can supply a ride only after the same open-arc and reasoning-exemption guards used by final emission; `transform.rs` supplies published m[1] changes as independently priced work. A held emergency latch below the force band is not by itself a ride.
- The former pressure-only prerequisite is removed, not stacked: a low-usage TTL/HARD fold can carry pending age work. Bootstrap and other genuine busts can advance the age watermark. Pure pressure residency cannot.
- Force/emergency selection remains enabled. The full emergency regression suites pass, including force batching, force-band historian overlap, and emergency idempotence.

Representation-focused tests now request an explicit flush where they previously used bare execute as shorthand for a priced bust. Their provider, whitespace, todo, and replay assertions remain intact. Low-usage fold/watermark expectations deliberately change to the new ride-only contract. The Rust injected-selection fixture explicitly seeds an unaged arc so its intended explicit selection, rather than the renderer repair's automatic age sweep, owns the first reduction.

## Reclaimed-token telemetry

The TS postprocess previously returned the literal `droppedTokens = 0`, regardless of actual drops. It now measures the nonnegative estimated outgoing-message token delta around reductions, before history injection adds prefix bytes (`transform-postprocess-phase.ts:1445,1826`). Thus newly applied queued/automatic/emergency reductions report reclaimed mass rather than the placeholder zero. This is a local estimate, **not provider billing tokens**, and does not derive reclaimed mass from the next request's usage (which can include new conversation).

The emergency accounting regression asserts positive `droppedTokens`. Pi and the Rust decision-log adapter still have their pre-existing zero-valued telemetry writers; this change fixes the reported TS specimen's writer, not the cross-engine telemetry schema/API. Late final-representation/image cleanup is outside this reduction-delta measurement.

## Reproduction and mutation evidence

The TS sequence runs for both **queued** and **age** lanes: bootstrap a stable baseline, publish A, execute with historian B in flight, verify A in the actual m0+m1 message pair and the old output removed, complete the run/publish B, verify complete outgoing-array equality on defer, then verify B appears at the next genuine execute. A separate 75.02% fixture contains eligible age work plus frozen-status replay and verifies unchanged bytes, active tags, zero reclaimed tokens, and no reported new bust.

Rust's `published_history_and_age_reclaim_share_one_bust_during_historian` combines the no-publication execute, publication+age execute during historian overlap, B's deferred replay, and the next genuine execute. Pi's `drains pending ops and heuristics on one bust even while a historian is in flight` includes both an age/heuristic-only 75.02% scenario and queued-drop/historian/force controls. Existing Pi m[1]-only and deferred-marker coverage tests remain green.

Every mutation used `git add -A`, a nonempty diff against the index, a named red test, then `git checkout -- <path> && touch <path>` and an empty restored diff. No deliberate break remains.

| Mutation | Named red test / output | Unaffected control | Applied → restored diff |
| --- | --- | --- | --- |
| TS: restore a historian veto only on prefix preflight and final m[1] refresh | `published A and queued drops drain together during historian B; B then waits for execute`: expected `PUBLISHED_A`, received baseline plus `(no new content since last materialization)`; exit 1 | `age and heuristic candidates alone at 75 percent cannot originate a bust` passed | `transform-postprocess-phase.ts`: 3 insertions, 2 deletions → empty |
| TS: let the age sweep run on scheduler execute without the shared permission | `age and heuristic candidates alone at 75 percent cannot originate a bust`: expected original tool parts, received empty parts; exit 1 | `reports estimated tokens reclaimed by successful emergency tool drops` passed | `transform-postprocess-phase.ts`: 1 insertion, 1 deletion → empty |
| Rust: let scheduler pressure authorize `reclaim_ride_available` | `transform::tests::published_history_and_age_reclaim_share_one_bust_during_historian`: actual `SOFT`, expected `SOFT+`; exit 101 | Only this named test was selected; no other failure | `selection.rs`: 1 insertion → empty; Cargo's unrelated lockfile version normalization was also restored |
| Rust: omit the open/reasoning-arc eligibility filter before deriving an agent-drop ride | `selection::tests::rejected_agent_drop_on_open_arc_cannot_price_automatic_age_reclaim`: `assertion failed: result.decisions.is_empty()`; exit 101 | Only this named test was selected; no other failure | `selection.rs`: 1 insertion, 1 deletion → empty |
| Pi: let ordinary execute authorize heuristics without an independent ride | `registerPiContextHandler > drains pending ops and heuristics on one bust even while a historian is in flight`: expected `readAStatus: active`, actual `dropped`; exit 1 | Only this named test was selected; no other failure | `context-handler.ts`: 1 insertion, 1 deletion → empty |

## Verification

Final gates were unpiped, with captured exit codes:

- `bun run --cwd packages/plugin test`: **exit 0**, 4,564 passed across 407 files.
- `bun run --cwd packages/pi-plugin test`: **exit 0**, 1,014 passed across 88 files.
- `cargo test -p mc-module -- --test-threads=1`: **exit 0**, 1,087 unit tests passed, four ignored, plus four integration/binary tests passed.
- `cargo clippy -p mc-module --all-targets -- -D warnings`: **exit 0**.
- `bun run typecheck`: **exit 0**, all four configured TypeScript packages.
- `bun run --cwd packages/plugin lint` and `bun run --cwd packages/pi-plugin lint`: **exit 0** (Biome).
- `cargo fmt -p mc-module -- --check`: **exit 0**.
- AFT inspection completed but its LSP producers were unavailable; authoritative verification is the compiler and test gates above.
- Comment review: no final changed-comment issues flagged.

Dependencies were installed inside the worktree with `bun install --frozen-lockfile`; no manifest or lockfile change is delivered. Cargo repeatedly normalized an unrelated local `subc-core` version in Cargo.lock; that drift was restored. An intermediate parallel embedding-cache TTL test was flaky and an isolated sidebar test required its package working directory; the final package-script full suites passed. Rust's unchanged `unaffected_transition_golden_is_byte_identical_and_detection_is_constant_time` exceeded its 50µs timing assertion under concurrent suite load (207µs observed), passed in isolation, and the entire final Rust suite passed serially without exclusions. No dists were edited or built, and no master push was performed.

## Gate revision: executed proof, preflight, configuration, and rollback pins

### Executed-fold proof (Q7)

The TypeScript pin now drives **real `MaterializeContentionError` retry exhaustion** through `beforePhase3ForTest`, not a mocked advisory result. The cached-pair case observes two injection calls with `decision.value=true`, `m0RematerializedThisPass=false`, and `materializationContentionRetryExhausted=true`. Queued drops remain pending and their targets remain active. Pi's existing suppressed-fold observer fixture now explicitly models `contentionExhausted=true` and verifies that pending-op, heuristic, and reasoning gates remain closed.

Rust has no equivalent cached-pair contention fallback in its atomic primary HARD path: failure returns an error rather than committing a partial primary transform. The new pins exercise the **actual non-materializing branch**: an inherited primary prefix reaches a reductions-only subagent request carrying either a requested-HARD or missing-boundary reconcile advisory. Neither advisory executes a prefix plan there. The previous ride expression nevertheless admitted automatic age/dedup work. Prefix-plan operands now require `prefix_materialization_enabled`; actual agent drops, explicit flushes, and force/emergency reclaim remain independent opportunities. Separate HARD and reconcile fixtures assert unchanged frozen units and watermark when no prefix materialization executes.

Restored mutation results:

| Control | Named red test | Captured result |
| --- | --- | --- |
| TS executed-fold proof replaced by `foldDueDecision.value` | `prefix preflight persistence pins > cached contention fallback cannot price ride-only reductions` | Expected active target, received dropped; exit 1. Persisted-m1 replay control passed. |
| Pi executed-fold proof replaced by `foldDueDecision.value` | `registerPiContextHandler > executed m[0] hard-fold folds the execute pass in > keeps every mutation gate closed when a due fold is suppressed` | `foldExecuted`, pending-op, heuristic, and reasoning gates all became true instead of false; exit 1. No other test selected. |
| Rust enables prefix-advisory rides in the non-materializing subagent branch | `transform::tests::hard_advisory_without_prefix_materialization_cannot_price_reductions` | `reconcile=false`: new `red:owner#*` and `red:results#*` frozen units; exit 101. No other test selected. |
| Same Rust mutation, independently staged/restored | `transform::tests::reconcile_advisory_without_prefix_materialization_cannot_price_reductions` | `reconcile=true`: new `red:owner#0` and `red:results#0` full drops; exit 101. No other test selected. |

The initial reconcile fixture used ordinary `read` calls, which do not exercise same-owner dedup while reconciliation suppresses the age watermark: that mutation remained green. The fixture was corrected to eligible `mcp_read` duplicates, then the **same production mutation went red**. Both outcomes are recorded rather than treating the first run as proof. All controls used stage → nonempty indexed diff → named check → checkout-and-touch restore → empty indexed diff. TS and Pi advisory mutations changed one line versus four original lines; each Rust mutation changed one line versus one.

### Persisted preflight delivery and benchmark (Q4)

A prepared history block is no longer accepted as a ride for the modern m0/m1 path when persistence fails. Only the legacy path may use that evidence directly. Contention-exhausted m1 preflights do not supply the changed-prefix signal; Pi likewise excludes a contended preflight from deferred-publication ride admission. Independent force/flush/applied-agent-drop opportunities are not vetoed by this guard.

The fresh and partial-cache tests execute the real fresh non-persisted fallback in `inject-compartments.ts:3241–3275` twice, once off-wire and once on the outgoing array. They assert no persisted m1 buffer, no automatic drops, and no materialization claim. Removing the modern-prefix evidence guard makes `fresh contention fallback cannot price ride-only reductions` fail (active → dropped), while the successful persisted-m1 control stays green. Its indexed diff was one insertion/one deletion, restored to empty.

The successful-path pin samples m1 from the database **immediately after the off-wire call**, requires that those bytes contain `PERSISTED_A`, then compares the independently served m1 text to that captured buffer. It does not compare the database to itself after the wire call.

Benchmark command:

```text
bun test src/hooks/magic-context/transform-postprocess-phase.test.ts -t 'ride-only configuration table|off-wire m1 preflight'
m1-preflight 2000-message execute p50=0.387ms p95=0.462ms samples=25 baselineCompartments=20 deltaCompartments=1
```

The fixture runs thirty real postprocess execute passes with 2,000 outgoing messages, discards five warmups, and times only the actual off-wire `injectM0M1` invocation. It seeds twenty baseline compartments and one published delta. The off-wire call checks prefix identities and renders/persists the m1 delta (published compartments and any eligible memory/profile surfaces), while reusing m0. It does **not** render or scan the 2,000-message tail; the rest of postprocess is outside this timing. The measured p95 is below 5ms. This is a local benchmark line, not a platform-independent performance ceiling.

### Configuration matrix (Q1)

Named tests cover:

- `ride-only defers routine reclaim to force band under historian-disabled`
- `ride-only defers routine reclaim to force band under no_models`
- `ride-only defers routine reclaim to force band under wrapup-only`
- `compaction-off performs no reclaim at any band`

These exercise the post-producer state: no automatic publication exists to price routine cleanup. `no_models` and wrapup-only describe operational states, not new configuration keys. Routine 75% passes preserve all tool bytes; force-band passes reclaim for the three historian modes. Compaction-off preserves bytes at 20%, 75%, 85%, 90%, and 95%.

The chair explicitly resolved the initial Q1 wording conflict in favor of CONFIGURATION.md's existing contract: **compaction-off is the no-reclaim exception**, including the force band, because native compaction owns its window. The configuration reference now documents that automatic tool drops, formerly configured by the removed `auto_drop_tool_age` key, ride folds and flushes instead of creating pressure-only busts.

### Rollback compatibility (Q6)

**No schema movement, migration, serialization-version bump, new persisted enum, or new persisted field.** Rolling back restores the older binary's selection policy; it does not require a data conversion.

| Persisted value | What changed | What an older binary reads |
| --- | --- | --- |
| `transform_decisions.dropped_tokens` | TS changes the former literal-zero placeholder into a nonnegative estimated reduction delta. | An ordinary numeric token count. Existing readers can display/sum it; it is not a control flag. Older writers resume writing zero. Harmless to cache/state decoding. |
| TS/Pi `session_meta.tool_reclaim_watermark` | Advancement follows an independently priced application opportunity, including low-usage folds, rather than requiring execute pressure. Its coordinate remains a tag number. | The same integer tag watermark. Old selection compares tag numbers normally and resumes the old cadence; no unknown representation or reset is needed. |
| Rust module meta `last_execute_ordinal` | Same opportunity/cadence change; coordinate remains a message ordinal. | The same numeric ordinal. Older code applies its prior pressure gate to that watermark. Rollback can restore the old reclaim timing, not corrupt data. |
| Cached m0/m1 bytes and their existing snapshot/coverage markers | Persistence can happen in off-wire preflight earlier in the same pass. Meanings and encodings are unchanged; failed fresh fallbacks are not persisted as successful folds. | The same cached byte pair and numeric/string markers. Older code replays or rematerializes using its normal rules. |
| Existing tag status/drop-mode rows, frozen reduction units, and pending operation rows | Which pass first applies them changes; payload/status meanings do not. | Existing `active`/`dropped` states and established drop/skeleton representations, replayed normally. Remaining queued work is ordinary pending work. |
| Pi `session_meta.pending_pi_compaction_marker_state` | The successful-drain timing can change with the shared permission. The CAS-managed JSON payload is unchanged. | The same existing marker object, or null after successful drain. An older process can rehydrate/drain a remaining marker normally. |

Pi's `pendingMaterializationSessions`, `deferredHistoryRefreshSessions`, and `deferredMaterializationSessions` are **process-local Sets**, not new persisted peek/signal state. Peeks do not consume them; successful drains clear them. On restart, an older binary sees only the unchanged durable marker/compartment state from which its existing code rehydrates work. The new preflight/ride booleans are also process-local. No other persisted value changes meaning; reasoning/image/placeholder decisions and emergency samples retain their established formats and semantics.

### Revision verification

All final revision gates completed unpiped with exit 0:

- Plugin full suite: **4,573 passed**, 407 files (`bun run --cwd packages/plugin test`).
- Pi full suite: **1,014 passed**, 88 files (`bun run --cwd packages/pi-plugin test`).
- Rust: **1,089 unit tests passed, four ignored**, plus four integration/binary tests (`cargo test -p mc-module -- --test-threads=1`).
- `cargo clippy -p mc-module --all-targets -- -D warnings`, `bun run typecheck`, both package Biome lint scripts, and `cargo fmt -p mc-module -- --check`: **passed**.
- The full plugin run independently recorded the benchmark at **p50=0.367ms, p95=0.522ms**, consistent with the isolated measurement above.
- Changed-comment review completed; a flagged selection-class explanation was rewritten to distinguish selection eligibility from automatic-reduction permission. AFT's LSP producers remained unavailable; compiler/typecheck results are authoritative.

The documentation guard initially rejected mentioning the removed configuration-key spelling in CONFIGURATION.md; the final sentence documents automatic-drop behavior without reintroducing that obsolete key. Cargo's unrelated local dependency-version normalization was restored again. No schema, lockfile, dists, or generated-schema changes are delivered.
