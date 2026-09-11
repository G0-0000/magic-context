# Force-pressure reclaim episodes: Rust/TS audit and regression evidence

## Mechanism (source at base a6446ff968d7f8aa58925c15109b4e75bf60d40b)

The Rust module did **not** have one shared application edge. It had an input-sample guard for emergency tools, a pressure-level gate for age/dedup, and a resulting-bust gate for text/reasoning. No selector has a one-message-per-pass cap.

| Lane | Base source and admission |
| --- | --- |
| Tiered emergency tools | `crates/mc-module/src/selection.rs:1065-1074` rejected only **equal** successive usage samples. Fresh samples reopened selection even with `has_prior_emergency_drop=true`. `1076-1084` computes `fixedFloor + 0.30*(ceiling-fixedFloor)`, with the rounded 2,000-token minimum. `1087-1158` reserves newest 20% of T1/T2, then walks **all** eligible T3/T2/T1 arcs oldest-first until the target is met. The loop can stop after one sufficiently large candidate, but is not capped at one candidate. |
| Two-pass age tools | `selection.rs:926-961` admits every `EmergencyForce` level, independently of the emergency sample latch. It collects all eligible arcs below `last_execute_ordinal`, subject to minimum size and exemplars. `transform.rs:5408-5418` advances that watermark even on empty opportunities. Consequently a reserved/newly admitted arc can become age-eligible on the very next force pass. |
| Duplicate and heuristic cleanup | `selection.rs:1239-1243,1264-1276,1289-1323` dedups and ages before merging emergency/supersession; force pressure opens their ride. `transform.rs:4204-4216` calls **every** Force85 an already-priced bust. This is not an independent mutation. |
| Caveman | The application gate is **not in** `caveman.rs`; that file's `compress` (`586-610`) is a pure text transform. `transform.rs:4629-4651,6844-6926` selects all unprotected eligible text only on `is_bust_pass`, ranks the live population into age tiers, and prevents depth regression. `caveman_age_basis_tag` is not an episode latch; the candidate loop uses the current population. |
| Reasoning and strips | `transform.rs:4551-4555,4610-4626` derives `is_bust_pass` from HARD/MigrateHard/SOFT, then admits reasoning clearing and frozen strips. Reasoning has durable cleared-through watermarks, not a separate emergency episode permission. |

The observed three rewrites are consistent with fresh sample admission + advancing age/protection eligibility + caveman riding each resulting bust. The supplied traces prove repeated Force85 execution and differing fingerprints, but do **not** contain the per-pass candidate snapshots needed to decide whether a particular specimen arc was formerly protected, age-ineligible, or beyond that pass's target. Claiming those exact candidate-level causes would overstate the evidence. The historian head cap (`boundary.rs:524-537`) limits historian chunks, not the reclaim selectors; it cannot directly limit tool selection to one message.

## Change

The persisted `has_prior_emergency_drop` / `last_emergency_input_sample` pair now represents one **shared force-episode opportunity**. Positive observed pressure below the derived force band rearms it; unknown/zero usage does not prove an exit. A changing usage sample while pressure remains high does not reopen it. No schema or new per-lane latch is required.

The first opportunity computes the existing tiered target-driven tool plan and admits age, duplicate, supersession, reasoning/strip and caveman work together. Text/strip candidates are discovered **before classification**, so an empty tool lane cannot prevent a nonempty text-only batch. Empty lanes consume the same opportunity and cannot wake independently on a later pass. Existing protection, arc-safety, tier reserves and the target formula are unchanged.

Candidates that become eligible later wait for **either** pressure exit/re-entry **or** an independent bust. Published folds, HARD/repair, explicit refresh, a command's first applicable agent drop and D5 remain independent opportunities. The >=95% emergency arm bypasses the episode latch and retains its stronger window/reserve yields. The drain latch remains a historian/scheduler mechanism and is not used as a fresh byte-mutation permission.

Three old selector tests supplied `pass_already_busting=true` to represent *idle* force pressure. Their unchanged no-mutation assertions now use `has_prior_drop=true`, matching the corrected contract: a genuinely independently busting pass is allowed to mutate. No expectation was inverted.

## Differential parity

The TS emergency planner already has the intended nonempty-tool-batch episode guard: `packages/plugin/src/hooks/magic-context/emergency-drop.ts:145-153,180-189` rejects any `hasPriorDrop`, not merely equal samples. `transform-postprocess-phase.ts:1171-1175` clears on force exit; `1557-1573` rearms on independent mutation; `1616-1646` explicitly brings routine caveman/dedup/cleanup into a newly nonempty emergency batch on that same pass. Routine cleanup additionally has its execute-pressure episode map (`1159-1170,1574-1584`). These are different admission layers, not a Rust-style sample-equality reopening. `heuristic-cleanup.ts:104-130` feeds the shared sample into the planner and `175-178` arms it only after nonempty **tool** reclaim; `181` separately opens routine cleanup. **Residual TS difference reported, not fixed:** a caveman-only routine mutation with zero emergency tool candidates can leave the emergency sample at zero. Later-arriving tool candidates may therefore originate another force-band mutation (`heuristic-cleanup.ts:175-178`), unlike the Rust shared opportunity implemented here. The differential golden pins the planner's already-latched changed-sample behavior, not complete cross-language orchestrator parity for that empty-tool case. No TS production code is changed.

`gen-selection-golden.ts` now includes a **changed sample within a latched episode** case. It runs the real TS planner, producing an empty decision set, which the Rust differential test consumes. Regenerating also exposed the generator's stale `protectedTags` argument: the current TS planner requires `protectedCutoff`. The generator now projects the identical cutoff used by its Rust fixture. Existing protected-tail golden expectations remain unchanged; this repairs the oracle invocation rather than weakening the Rust comparison. Standalone generator typechecking also exposed its pre-existing omission of the emitted string `"Reasoning"` from `SelItemJson.kind`; the type now includes that existing wire shape.

## Fixture results

| Proposition/control | Test | Result |
| --- | --- | --- |
| P1: one batch, three specimen-shaped targets | `transform::tests::force_episode_coalesces_lanes_and_defers_late_candidates` | First Force85 is SOFT (not bootstrap/HARD), freezes `cav:m3#0`, `red:m8#0` (aft_grep), `red:m111#0` (write); drain and episode latches armed. Two changed-sample follow-ups serialize byte-identically. |
| Late eligibility | Same P1 fixture | A reserved arc cannot trickle via the next age watermark. Later appended tool remains live until independent refresh. |
| Empty tool lane | `transform::tests::force_episode_empty_tool_lane_and_pressure_escape_controls` | Caveman-only first batch succeeds. The initially empty tool lane does not rearm when tools arrive later. |
| Pressure exits/rearms | Same controls test, `exit` row | Positive low-pressure observation clears episode latch; re-entry applies pending age work. |
| Independent exceptions | Same controls test, `refresh`, `hard`, `fold` rows | Each admits pending tool mutation despite held episode latch. |
| >=95% exception | Same controls test, `emergency` row; existing `selection::tests::emergency_95_yields_window_and_reserve_but_retains_open_arcs_and_exemplars` | Emergency still escapes the latch; existing stronger yields and arc protections remain covered. |
| D5 | `transform::tests::force_episode_latch_does_not_block_d5_descent` | Held successor episode/drain latches do not block descended HARD or switch consumption. |
| TS changed-sample parity | `selection::tests::selection_golden_matches_ts_selectors` | 17 real-TS-generated cases pass, including the new latched changed-sample no-op. |
| P2 (separate from P1) | `historian_chunk::tests::substance_is_formatted_content_not_scan_saturation` | A budget-stopped scan still reports <512 tokens, excludes filtered noise, and has the same formatted text/token estimate as the filtered short chunk. Normal tiny substance refuses; real tiny content may still fire through the existing emergency exception. |

The P1 fixture is hermetic and reproduces the **mechanism**, not the private full transcript or its exact token counts. It deliberately includes a reserved arc to make the old next-pass age-watermark leak observable. It tests CK serialized served bytes under `claude-code-anthropic`; the tool inputs are shaped fixtures, not copied private inputs.

Mutation proof: restoring per-pass force admission plus the old per-lane age/equal-sample emergency guards makes **only the selected P1 test** fail (`force follow-up changed served bytes`, divergence at `reserved#0`). Implementation was staged before mutation; diff was nonempty during mutation and empty after checkout/touch restoration. No mutant is delivered.

## Historian throughput: source conclusion and evidence limits

**No drain-latch exemption exists for the assembly substance floor.** `lib.rs:5112-5116,5340-5365` derives `fold_is_only_reclaim = !tail_reclaim(profile)` and passes `in_emergency = parsed.emergency_recovery_armed`. All shipping profiles currently support tail reclaim, so Claude Code is no longer automatically a fold-only profile. `historian_chunk.rs:724-741` refuses a formatted chunk below `min_chunk_tokens` unless recovery is armed or fold is the sole reclaim path. The drain latch is not consulted there.

The earlier **trigger** is distinct: `boundary.rs:813-848` admits runnable force-band windows before the ordinary minimum-eligible-content gate at `880-881`; it can still refuse protected-only windows or projected post-drop satisfaction. Passing that trigger does not guarantee assembler/producer admission. `historian.rs:323-339` maps both the trigger's `BelowMinimumEligibleContent` and assembler's `BelowSubstanceFloor` (also filtered-empty chunks) to `below_min_chunk`, so the canonical string alone is insufficient diagnosis.

No historian policy change is made: the floor's comment explicitly retains it where tail reducers exist, and the supplied live evidence does not prove that the floor caused this session's throughput problem. Removing it under drain would be a separate policy decision, not a proven defect. The Sep-8 substance protections remain intact: `historian_chunk.rs:453-467` returns actual formatted `builder.total_tokens`, with scan progress separately represented by `has_more`; existing boundary tests `trailing_filtered_rows_do_not_inflate_chunk_progress`, `real_formatted_budget_stop_preserves_measured_progress`, and `thin_filtered_tail_refuses_without_blocking_pressure_folds` also pass.

### Supplied session evidence

Read-only exports: `.cortexkit/alfonso/evidence/cc-15bf744d/{mc_pass_trace,mc_cache_state_meta,mc_compartments}.json` (not committed). Session `15bf744d-5485-492e-b671-b22d5837d4ef␟1789137699837`.

- Seq 1: lineage boundary only, ordinal 1025, `created_at=1789137699839`.
- Seq 2: ordinals 1026–1037 (12 messages), `created_at=1789145269042` (2026-09-11 16:47:49.042Z). This is the durable publication timestamp, **not** an independently recorded producer-completion or first-apply timestamp.
- Current meta: `folded_compartment_seq=2`, `coverage_ordinal=1037`; seq 2 has been applied by the snapshot, but its first application time is absent.
- Current historian: `state=idle`, `firing_seq=8`, `chunk_range=null`, `fired_at_ms=null`, producer IDs null, `last_no_fire=null`. There are **no last_no_fire rows in this export** to cite as floor refusals.
- Last failure: `validate rejected: Historian output must be one complete <output> root document.` Backoff deadline `1789148296622`. This proves a validation failure was recorded, not when each producer started/completed or what happened on all seven preceding firings.
- Current drain entered at `1789145703489`; current diagnostic emergency sample `164511`. No per-pass numeric usage series or producer completion/apply series is present.

| Observation(s), timestamp_ms | Scheduler evidence | Historian firing eligibility / fold pressure evidence |
| --- | --- | --- |
| 1789137699839 (seq 1) | Force85, drain true | Boundary-only publication. Exact before/after pressure and producer chronology unavailable. |
| 1789137704641–1789137719609 (3 rows) | Defer / scheduler_defer, drain true | Scheduler deferral is **not** a historian no-fire record. Historian eligibility unavailable. |
| 1789144756649–1789145263549 (6 rows) | Defer / scheduler_defer, drain false | Same evidence limit; these do not prove a substance-floor refusal. |
| 1789145269042 (seq 2 publication) through 1789145337241 (8 rows) | Defer / mid_turn_boundary, drain false | Publication exists; producer completion, exact apply time, and numeric pressure before/after fold absent. |
| 1789145663229 | Execute, drain false | No historian per-pass diagnostic in export. |
| 1789145666857–1789145700293 (7 rows) | Defer / mid_turn_boundary, drain false | No historian per-pass diagnostic in export. |
| 1789145703489 onward (40 rows) | Force85 / execute, drain true | Force trigger potentially eligible subject to boundary/projected reclaim; assembler floor/backoff/in-flight state per pass unavailable. |
| request 1789148213536 / trace timestamp 1789148213545 | Force85, fingerprint `63684095…` | No historian cause/timestamps or pressure sample in this row. |
| request 1789148224760 / trace timestamp 1789148224770 | Force85, fingerprint `a2bd5b12…` | Same. |
| request 1789148233606 / trace timestamp 1789148233612 | Force85, fingerprint `8f6b1e03…` | Same. |

The export contains 66 scheduler-history rows and 16 interesting-history rows; the latter three match the supplied specimen. Scheduler timestamps/fingerprints cannot be substituted for producer-completion/apply timestamps or numeric pressure measurements. The live stderr ring rotated out, so a complete per-pass historian chronology is unrecoverable from this evidence set. Instrumented future capture is needed to distinguish floor refusals from in-flight/backoff/validation failures and to measure fold-by-fold pressure relief. Compartment count alone cannot establish that diagnosis.

## Verification

- `cargo test -p mc-module --lib`: 1,132 passed, 8 existing ignored, 0 failed (after mutation restoration).
- `cargo test -p mc-store`: 140 passed; doc-tests passed.
- `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings`: passed.
- `cargo fmt --all -- --check`: passed.
- `bun crates/mc-module/gen/gen-selection-golden.ts`: generated 17 cases / 23 arc decisions from the real TS selectors.
- Standalone `tsc --noEmit --skipLibCheck --target ESNext --module ESNext --moduleResolution bundler --typeRoots packages/plugin/node_modules/@types --types bun crates/mc-module/gen/gen-selection-golden.ts`: passed using the plugin-local compiler.
- `cd packages/plugin && bun run typecheck`: passed.
- `cd packages/plugin && bun run test`: 4,708 passed, 0 failed across 414 files.
- Frozen-lockfile installs were run in this worktree (root and plugin); no manifest or Bun lock changes. Cargo resolves sibling `subc-core` 0.17.33 instead of locked 0.17.21; Cargo.lock drift is restored and not delivered.
- AFT diagnostics were incomplete because the Rust LSP disconnected during initialization; cargo tests/clippy are the authoritative successful checks.
