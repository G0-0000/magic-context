# Review: the Rust signed-prefix hold (issue 665)

Range under review: `dda49e38..00bfed90`, which covers commit `b554fea7` ("hold every bust
input inside an active signed thinking turn") and commit `00bfed90` (comments, relief tests).
Files: `crates/mc-module/src/transform.rs` and `crates/mc-module/src/tests/signed_prefix_hold.rs`.
This is a report-only review. It adds tests in
`crates/mc-module/src/tests/signed_prefix_hold_review.rs` and changes no product code.
Line numbers refer to `transform.rs` at `00bfed90`.

## Verdict

The hold does what the 62fa1e27 review's High finding asked for, below the force band and
outside the unavoidable-rewrite exemptions. A randomized driver made 349 held passes on
prefix-bound models with active signed thinking. Every one served the previous messages
unchanged, appending only the new tail, and kept every queued drop and flush. In 19 out of
19 releases, the first pass after the user message applied all the held work in one SOFT or
HARD, and the same request sent again replayed that output. Sessions the hold does not
cover are byte-identical to `dda49e38` over 372 passes. The same driver fails on `dda49e38`,
because a held flush there goes SOFT, so it can detect the bug.

One exemption is wrong and is a regression: **idle TTL expiry**. The commit treats an
expired cache as an "unavoidable rewrite". An expired cache does not make the content
change: the cached m0/m1 pair can still be replayed byte for byte. Under strict prefix
binding, re-rendering m0/m1 invalidates every signed thinking block after it. At
`00bfed90` an idle-expired pass inside an open signed turn re-renders m0/m1 and keeps
serving the turn's signed thinking. The TypeScript hold does not do this.

Findings, most severe first:

| # | Severity | Finding | New in range? |
|---|---|---|---|
| H1 | High | An idle-expired pass re-renders m0/m1 while the turn's kept signed thinking is still served | Yes for the resend case; the fold case is unchanged from base |
| M1 | Medium | The force band lifts the whole hold, so the m0/m1 fold and refresh run while signed thinking is kept (TS keeps m0/m1 frozen) | No (pre-existing; the commit's relief tests now pin it) |
| M2 | Medium | A HARD from `cache_sections_discarded` or lineage `force_hard` on a scheduler-Defer pass drains nothing (ARCHITECTURE invariant 1) | No (pre-existing; this is question 5) |
| L1 | Low | `render_config_changed` reaches `classify` unvetoed and busts a held pass, and nothing rides that bust | No |
| L2 | Low | `reconcile_pending && !boundary_present` reaches `classify` unvetoed (rule 5 HARD) | No (code reading only) |
| L3 | Low | A held subagent pass still goes Soft on a tag-surface transition | No (code reading only) |
| I1–I4 | Info | Pressure relief inside a signed turn; recut flag on a CAS retry; how subagents are released; exemptions | — |

## Gates (Linux runner, `linux,8c`)

| Gate | Result |
| --- | --- |
| `cargo test -p mc-module` (cargo 1.99.0) | lib: 1717 passed, 0 failed, 27 ignored (the ignored set includes the 5 review witnesses). The integration binaries `boundary_counter_durability`, `cold_flip_adversarial`, `fleet_logging`, `launch_nonce_source_scan`, `protection_window_golden` and `mc-caveman-live-differ` all pass. `tests/real_daemon.rs` has 4 failures (see below). |
| `cargo clippy -p mc-module --all-targets -- -D warnings` (clippy 0.1.99) | exit 0 |
| `cargo fmt -p mc-module --check` (rustfmt 1.10.0) | exit 0. The review file is `include!`d, so it was formatted with `rustfmt --edition 2021` directly. |
| `cargo test -p mc-module --lib -- signed_prefix_hold review_` | 39 passed, 5 ignored (the witnesses) |
| `cargo test -p mc-module --lib -- --ignored review_witness` | 5 failed. These are the failing witnesses quoted below. |

`tests/real_daemon.rs` fails 4 tests at `real_daemon.rs:1098`: `fs::canonicalize` of a
sibling `subconscious` checkout, which the runner does not have. This is an environment
failure, unrelated to the hold.

**Base comparison.** To compare with base, I swapped `dda49e38`'s `transform.rs` plus the
review `include!` into the worktree, ran the review tests on Linux, then restored the file.
The results are in the table under each finding.

## H1 — idle expiry re-renders m0/m1 under kept signed thinking (regression)

`prefix_rewrite_unavoidable` (lines 5194-5199) starts with `scheduler_outcome.idle_ttl_fired`.
On an idle-expired pass inside an open signed turn this has three effects:

- `signed_prefix_hold` is false (line 5203).
- The new `independent_rebuild` term `(!req.is_subagent && protected_signed_prefix && prefix_rewrite_unavoidable)` is true (line 5348).
- `hard_fold_requested`, including `idle_fold_due`, is no longer vetoed (line 5250).

`classify` therefore selects SOFT for a pending m1 delta (rule 7) or HARD for the idle fold
(rule 4). Both re-render the synthetic m0/m1 head. `active_thinking_prefix_edit_ids`
(line 16849) protects only live message blocks, not the head. So the comment at lines
5189-5191 ("Blocks before the turn's kept signed thinking stay untouched either way") is
wrong for m0/m1.

Why this is a bug: `docs/reports/anthropic-thinking-binding.md:27` quotes Anthropic's page:
"a thinking block stays valid only while everything you sent before it is unchanged". Line
151 of the same report applies this to an m0/m1 re-render ("Invalid for every thinking
block"). The live probe failed with HTTP 400 "The block is bound to a different
conversation" (`:122`), and enforcement is the default for accounts created on or after
2026-08-31 (`:28-29`). An expired provider cache does not relax binding; it only makes the
rewrite cheap.

In practice: a tool call inside a signed turn that runs longer than the cache TTL (5 minutes
by default), while a historian publication is pending. The historian runs in the
background during long turns, so this combination is common.

Failing witnesses (`#[ignore]`d so the suite stays green; run with `--ignored`):

| Test | `dda49e38` | `00bfed90` |
| --- | --- | --- |
| `review_witness_idle_expiry_resend_rewrites_head_under_kept_signed_thinking` | pass (Defer) | **FAIL**: `action SOFT reason Some("ttl_idle"): m0/m1 changed while the turn's signed thinking (think 8) is still served` |
| `review_witness_idle_expiry_fold_rewrites_head_under_kept_signed_thinking` | FAIL: `action HARD reason Some("ttl_expiry") …` | FAIL: same message |

The two witnesses differ in timing:

- The "fold" witness places the last provider response after the last HARD. That is the usual case, and `idle_fold_due` is true.
- The "resend" witness models the resend after an aborted or failed expiry pass, where `idle_fold_due` was already consumed.

Base already busted in the fold case because `idle_fold_due` was never vetoed. The commit
did not fix that, and it added the resend case.

**Cause, confirmed.** In a probe run (remote copy only; never committed) I replaced
`scheduler_outcome.idle_ttl_fired` in `prefix_rewrite_unavoidable` with `false`. Both
witnesses then pass. The same probe (mutation M12 below) reddens
`signed_prefix_hold_idle_expiry_carries_queued_drops` and
`review_subagent_hold_is_released_by_the_force_band_and_idle_expiry`, so the change has
real consequences.

**Fix.**

- Keep idle expiry unavoidable only for subagents, which have no m0/m1 head:
  `(req.is_subagent && scheduler_outcome.idle_ttl_fired) || cache_sections_discarded || (!req.is_subagent && (…))`.
- For a primary session, an idle-expired pass inside a held turn stays held. This matches
  the TypeScript rule `idleExpiryRebuild = !freezeM0M1 && …`
  (`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:2276`).
- The worker's `signed_prefix_hold_idle_expiry_carries_queued_drops` would then have to
  change to expect a Defer.

## M1 — the force band re-renders m0/m1 under kept signed thinking (pre-existing; TS divergence)

`signed_prefix_hold` is false at or above `force_materialize_percentage` (line 5201). That
lifts every veto, including `hard_fold_requested` and the m1 delta ride into `classify`, not
only the drains. The TypeScript hold does not do this: `freezeM0M1` has no force exception.
At 85% TS lets drains ride (`(!freezeM0M1 || emergencyDropEligible) && hasReclaimRide(...)`,
from `7fe8bc66`), but the fold and refresh stay gated on `!freezeM0M1`
(`transform-postprocess-phase.ts:2062`).

| Test | `dda49e38` | `00bfed90` |
| --- | --- | --- |
| `review_witness_force_band_rewrites_head_under_kept_signed_thinking` | FAIL | FAIL: `action SOFT reason Some("coverage_fold"): m0/m1 changed while the turn's signed thinking (think 8) is still served` |

This is not a regression. However, the commit's `check_signed_hold_relief` tests assert that
"the marker HARD is not held" at 86%, 95% and an armed recovery. That pins a full m0/m1
rebuild inside a signed turn as intended behaviour.

**Fix.** While `protected_signed_prefix` is true, lift only the drain and reduction rides at
the force band. Keep `hard_fold_requested` and the `m1_revision_changed` input vetoed until
the turn ends. The randomized driver also observed this in passing: 5 in-turn pressure or
idle passes changed the head, listed in its `in_turn_head_rewrites` output.

## M2 — answer to question 5: a discarded-sections HARD on a Defer pass drains nothing

Yes, this is a real gap against ARCHITECTURE invariant 1: "A HARD bust means the prefix is
already gone → drain EVERYTHING into it" (`ARCHITECTURE.md:80`). It affects unprotected
sessions too.

**Exact cause.** `selection_class` depends on `producer_gate(scheduler_outcome.pass, hard_advisory)`
(lines 5392-5408; the function is at line 8700). The `hard_advisory` argument is
`!initialized || render_config_changed || reconcile_hard_due || hard_fold_prices_mutations || cached_m1_missing_due`.
It omits `lineage_state.force_hard`, and `cache_sections_discarded` sets that flag
(line 4347).

On a scheduler-Defer pass, selection therefore runs with `PassClass::Defer` and selects no
agent drop. This happens even though `pass_already_busting` (via `independent_rebuild`'s
`force_hard` term) is true and `select_agent_drops` (`selection.rs:1182`) would accept the
drop. The forced HARD (line 5686) applies nothing, and the queued drop waits for a second
bust. A lineage descent on a Defer pass goes through the same predicate (code reading; not
witnessed).

| Test | `dda49e38` | `00bfed90` |
| --- | --- | --- |
| `review_witness_discarded_sections_hard_drops_nothing_on_a_defer_pass` (20% usage) | FAIL | FAIL: `unprotected left {"r9#0"}; signed turn left {"r9#0"}` |
| `review_discarded_sections_hard_carries_a_drop_on_an_execute_pass` (66%, unprotected) | pass | pass |
| `review_discarded_sections_hard_carries_a_drop_in_a_signed_turn` (66%) | FAIL | pass (the commit's unavoidable ride fixed it) |

**Cause, confirmed.** In a probe run (remote copy only; never committed) I added
`|| lineage_state.force_hard` to the `producer_gate` advisory. All three tests then pass.

This also limits one of the commit's claims. The unavoidable rides for lineage descent and
discarded sections carry queued drops only when the scheduler is not Defer.

## L1 — `render_config_changed` busts a held pass and carries nothing

`classify` rule 3 (`crates/mc-core/src/lib.rs:132`) returns HARD before any
bust-opportunity check, and the hold does not veto `render_config_changed`. The render
identity covers the model key, the provider, the system/prompt-surface hash, the host
`render_config` and the workspace fingerprint (lines 8486-8618). If any of these changes
inside a held turn, the pass is HARD.

`independent_rebuild`'s `render_config_changed` term is gated by
`prefix_materialization_enabled`, which is false in a protected turn. So nothing rides the
HARD, and the queue costs a second bust at the next user message. That is the issue-665
pattern.

| Test | `dda49e38` | `00bfed90` |
| --- | --- | --- |
| `review_witness_render_config_change_busts_a_held_pass` | FAIL | FAIL: `left: "HARD" right: "SOFT+"`, `reason Some("epoch_change"), pending after {"r9#0"}` |

Most realistic triggers (model, system or tool-surface changes) also change the host's own
prefix, so the cache and the binding are already broken by the host. The defect is mainly
that nothing rides the HARD.

**Fix.** Count `render_config_changed` in `prefix_rewrite_unavoidable` for primaries. It is a
HARD in either case.

## L2, L3 (code reading only, not witnessed)

- **L2.** `reconcile_pending && !boundary_present` reaches `classify` unchanged, and rule 5
  returns HARD (`lib.rs:140`). It needs a revert that removes the boundary message; such a
  revert normally ends the turn.
- **L3.** A held subagent pass becomes Soft on a tag-surface transition:
  `plan = if surface_transition || subagent_execute_permitted` (line 5678). This is
  unchanged from base.

## Question 3 — drops before kept signed thinking, the HTTP 400 risk, and subagents

Queued drops never touched a block before the turn's kept signed thinking.

- The driver checked 20 unheld in-turn passes (16 pressure, 4 idle). On each, every newly
  applied drop targeted a message after the newest reasoning-bearing step. Every non-synthetic
  served message before that step was byte-identical to the previous serve.
- The commit's own tests check the same thing on each unavoidable rewrite (first render,
  missing m1, lineage, idle, seed, legacy), and so does
  `review_discarded_sections_hard_carries_a_drop_in_a_signed_turn`.
- Caveman and strip units use the same `active_thinking_prefix_edit_ids` (lines 8935 and 14163).

Strict-binding exposure therefore comes only from the m0/m1 head (H1, M1), not from drops.
Missing m1, no cached pair, lineage descent and discarded sections genuinely cannot replay a
coherent head, so their rewrite is inherent. Idle expiry can replay the head (H1).

**Subagents cannot be stranded.**
`review_subagent_hold_is_released_by_the_force_band_and_idle_expiry` shows:

- a subagent held at 70% for 7 passes, serving the same messages and keeping its queue;
- 86% applying the drop that comes after the last signed thinking;
- an idle expiry applying the next queued drop.

`review_subagent_discarded_sections_hard_carries_a_drop_in_a_signed_turn` covers the other
subagent exemption. A drop before the kept signed thinking stays queued for the whole
subagent run, because no user message ever ends that turn. This is thinking protection, the
same as before the commit.

## Question 2 — pressure

- `signed_prefix_hold_yields_to_the_force_band`, `…_95_percent_emergency` and
  `…_armed_overflow_recovery` pass, and mutations M01 and M02 show the exemptions are
  defended.
- The driver ran 16 pressure passes (86%, 96%, recovery armed); none was held.
- **I1.** Relief inside a signed turn can only drop blocks after the turn's newest signed
  thinking, plus the oldest-prefix reasoning strip. That is per-target protection, which the
  commit does not change. In a long signed turn the transform cannot guarantee that nothing
  is sent over the limit: at 95% almost everything sits before the kept thinking. This
  predates the range.

## Question 4 — exemptions

- **`bootstrap_seed_fold_pending` is a correct exemption.** It is set by state-sync seed
  adoption over an older materialized boundary (`crates/mc-store/src/lib.rs:11302`).
  `classify` receives `initialized && !bootstrap_seed_fold_pending` and returns HARD at
  rule 1 whatever the hold decides. The cached head no longer matches the adopted coverage,
  so replaying it is not coherent. Holding would only produce a HARD that carries nothing.
- **`is_legacy_baseline` is a correct exemption.** `classify` rule 2 makes it MigrateHard, and
  there is no m0/m1 pair to replay. Mutations M04 and M05 show both exemptions are defended.
- **`render_config_changed` can still bust a held pass** (L1, witnessed).
  **`reconcile_pending` can too, through rule 5** (L2, code reading). Rule 6
  (`reconcile_pending` with the boundary present) is a Defer and cannot bust.

## Question 6 — parity with TypeScript

The in-progress TS revision for issue 665 is not visible from this branch. This comparison
uses `7fe8bc66` (the TS fix, not in this branch's history) and the 62fa1e27 review.

| Behaviour inside an open signed turn on a prefix-bound model | TS (`7fe8bc66`) | Rust (`00bfed90`) |
| --- | --- | --- |
| Drains, heuristics, todo, strip below 85% | held (`!freezeM0M1 \|\| emergencyDropEligible`) | held — **match** |
| Drains at ≥85% | ride (`emergencyDropEligible`) | ride — **match** |
| m0/m1 fold or refresh at ≥85% | frozen (`freezeM0M1` has no force exception) | runs (hold fully lifted) — **diverges** (M1) |
| Idle expiry | held (`idleExpiryRebuild = !freezeM0M1 && …`) | rewrites m0/m1 and rides — **diverges** (H1) |
| Riders on first render or other forced rebuilds | held (62fa1e27 Low: "a held pass that busts anyway still holds its riders") | ride under per-target protection — **diverges, in the cheaper direction** |
| Subagent execute ride | vetoed below 85% | vetoed below 85% — **match** |
| Armed overflow recovery at low usage | not verified on the TS side (`emergencyDropEligible` is percentage-based) | exempt (`Emergency95`) — **verify** |

If the TS revision adopts "queued work rides an unavoidable rewrite", both twins need the
same unavoidable set. I recommend: no cached pair or first render, missing m1, lineage
descent, discarded sections, plus classify-forced HARDs (seed, legacy) and, per L1,
render-identity changes. **Not idle expiry** for primary sessions.

## Question 7 — mutation controls

I did not have the worker's list of 13 controls. I ran my own 19 mutations against the
same hold. For each one, the index held the live tree; the mutation was applied on the
runner copy only; the runner's `git diff --stat` was non-empty during the mutation and back
to the baseline (just the review `include!` line) afterwards. The test filter was
`signed_prefix_hold review_`: 39 tests, with the 5 witnesses ignored.

| Mutation | Red tests |
| --- | --- |
| M01 hold also in the force band | `signed_prefix_hold_yields_to_the_force_band`, `review_subagent_hold_is_released_by_the_force_band_and_idle_expiry` |
| M02 hold also in Emergency95 | `signed_prefix_hold_yields_to_an_armed_overflow_recovery` only. At 95% usage the force-band exemption already covers it. |
| M03 hold also on unavoidable rewrites | `signed_prefix_hold_idle_expiry_carries_queued_drops`, `review_subagent_hold_…` |
| M04 hold on bootstrap-seed passes | `signed_prefix_hold_bootstrap_seed_fold_carries_queued_drops` |
| M05 hold on legacy-baseline passes | `signed_prefix_hold_legacy_baseline_migration_carries_queued_drops` |
| M06 flush veto removed | `signed_prefix_hold_defers_flush_and_queued_drops_to_the_next_user_turn`, `review_signed_hold_randomized_driver_holds_then_releases_once` |
| M07 reduction-ride veto removed | `signed_prefix_hold_keeps_a_selected_reduction_pending` |
| M08 `hard_fold_requested` veto removed | `signed_prefix_hold_keeps_a_marker_hard_pending` |
| M09 subagent execute veto removed | `signed_prefix_hold_keeps_subagent_execute_drops_pending`, `review_subagent_hold_…` |
| M10 unavoidable-rewrite ride removed | first-render, idle, lineage and missing-m1 tests, `review_discarded_sections_hard_carries_a_drop_in_a_signed_turn` |
| M11 lineage `force_hard` not unavoidable | `signed_prefix_hold_lineage_descent_carries_queued_drops` |
| M12 idle not unavoidable | `signed_prefix_hold_idle_expiry_carries_queued_drops`, `review_subagent_hold_…` |
| M13 missing m1 not unavoidable | `signed_prefix_hold_missing_m1_carries_queued_drops` |
| M14 `cache_sections_discarded` not unavoidable | **undefended by the commit's tests**. Now `review_subagent_discarded_sections_hard_carries_a_drop_in_a_signed_turn` only. For primaries the mutant is equivalent, because discarded sections also set `force_hard`. |
| M15 `pre_snapshot_inputs_changed` veto removed | **undefended by the commit's tests**. Now `review_held_pass_keeps_a_changed_protection_floor_for_the_release` only. |
| M16 recut pending count reset while held | **undefended** (no test). The recut needs a constructed boundary divergence inside a signed turn. |
| M17 recut kept while held | **undefended**. Nearly equivalent: `hard_fold_requested` vetoes the recut anyway, and only `materialize_reason` and the detected flag change. |
| M18 hold disabled entirely | 6 tests, including the driver |
| M19 (unheld path) `prefix_materialization_enabled && idle_ttl_fired` removed | `review_unheld_sessions_match_the_code_before_the_hold` only. This shows the 372-pass digest test is not vacuous. |

**I2.** `*boundary_divergence_detected` is assigned at line 5021, before the hold filters
the recut at line 5211. On a CAS retry of a held pass, `boundary_divergence_retry` then
resets the pending count to 0 (line 4991). That undoes the "keep the count" intent of lines
5208-5214 in that narrow case. Not witnessed.

## Tests added (`crates/mc-module/src/tests/signed_prefix_hold_review.rs`)

- `review_signed_hold_randomized_driver_holds_then_releases_once`. 6 seeds × 70 steps on
  Opus 5.5 and Sonnet 5.5 with signed thinking. Events: tool steps, user turns, queued drops,
  flushes, execute crossings below 85%, historian publications, model switches at user turns,
  store reopens, and occasional 86%, 96%, recovery and idle passes. Last run: 449 passes,
  349 held, 19 of 19 releases with work, 16 pressure, 4 idle.
- `review_unheld_sessions_match_the_code_before_the_hold`. Six configurations: unbound
  thinking, unbound subagent, unbound without thinking, bound without thinking, bound subagent
  without thinking, and bound-alt. 372 passes in total. The golden digests were recorded on
  `dda49e38` and are identical at `00bfed90`.
- Defending tests:
  - `review_discarded_sections_hard_carries_a_drop_on_an_execute_pass`
  - `review_discarded_sections_hard_carries_a_drop_in_a_signed_turn`
  - `review_subagent_hold_is_released_by_the_force_band_and_idle_expiry`
  - `review_subagent_discarded_sections_hard_carries_a_drop_in_a_signed_turn`
  - `review_held_pass_keeps_a_changed_protection_floor_for_the_release`
- Five `#[ignore]`d witnesses for H1 (two), M1, M2 and L1. Run them with
  `cargo test -p mc-module --lib -- --ignored review_witness`.

The worker's existing golden test `signed_prefix_hold_leaves_unheld_sessions_byte_identical`
covers 224 passes, fewer than the 300 the brief asks for. The new digest test covers 372.
