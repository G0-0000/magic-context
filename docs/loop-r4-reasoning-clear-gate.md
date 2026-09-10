# Frozen cutoff versus frozen applied set — cache-core gate evidence

## Mechanism and scope

OpenCode Rust/native typed-reasoning clearing previously treated a frozen numeric cutoff as permission to clear any now-non-exempt assistant. When the newest assistant changed, an older assistant first lost its signed reasoning on a deferred pass, even though the cutoff did not move.

The fix stores `strip:reasoning_clear:<message-id>` units (`kind=strip_reasoning_clear`, empty sentinel payload, lineage durability). It reuses the existing strip-unit persistence, lookup, identity, and replay machinery. There is no schema migration, renderer epoch bump, or migration HARD.

`new_reasoning_clear_units` receives the existing `is_bust_pass` permission from `apply_once`. That permission is derived from `is_provider_prefix_mutation_pass` after final classification, including the lineage-failure veto, and retains the existing primary-session scope of reasoning-age cleanup. It does not reconstruct permission from scheduler pressure or historian state. The cutoff still batches candidates; the newest assistant and lineage anchor cannot receive a new clear decision.

CK rendering and both full and incremental native encoding consume the committed units. Native cache identity uses unit membership rather than the moving newest-assistant/age predicate. An existing clear is replayed without recalculating age or exemption. Native keep units cannot restore reasoning for a message with an authorized clear unit.

### Deployment adoption, without a bust

The parent ruled out an epoch bump or migration HARD. A legacy session can adopt a unit on a deferred pass only if **every** current reasoning block's last-served fingerprint exactly matches its cleared representation. A prior native-keep unit prevents adoption. The helper uses the existing `served_output_fingerprint` state, not a new ledger.

An assistant last served with signed reasoning remains held even if its age is below the persisted cutoff and its exemption has moved. Missing fingerprints also hold the candidate until a later authorized bust. This conservative behavior is intentional; no prior application is inferred merely from a cutoff. The legacy regression verifies all previously served native messages, not only the held assistant.

## Regression evidence

All new tests are lib tests included from `crates/mc-module/src/transform/reasoning_clear_tests.rs`.

### Red on the unchanged implementation

`cargo test -p mc-module --lib reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart`

Exit **101**, before production edits:

```text
test transform::tests::reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart ... FAILED
assertion `left == right` failed: DEFER must not first-clear reasoning merely because its exemption moved
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

The fixture uses supported age 10, 10% usage, and a 13-part user message. HARD freezes a cutoff containing the newest signed assistant A but leaves A intact. After reopening the store, an unchanged DEFER remains identical. Appending B then exposes the original defect.

### Green contract

1. `reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart`: HARD with A exempt → restart → B arrives → DEFER retains A's exact CK/native bytes and reports no old-prefix divergence → a subsequent HARD clears A → two DEFERs replay exactly.
2. `reasoning_clear_legacy_adoption_preserves_cleared_and_held_bytes`: seed a legacy cutoff/fingerprint state without clear units; already-cleared reasoning is adopted on the first DEFER, held reasoning stays intact, the previous native prefix is identical, and the next HARD admits the held candidate.
3. `reasoning_clear_legacy_missing_fingerprint_holds_until_bust`: missing last-served evidence cannot authorize adoption; a later authorized pass can mint the unit.
4. Existing `reasoning_cutoff_batches_on_one_fold_and_survives_restart` remains green.

The legacy fixture removes only the new decision units from a real committed snapshot. Its already-cleared and exempt sets have the same bytes the pre-fix predicate served. It does not compute expected replay bytes through the adoption helper.

### Executed mutations

Both mutations were marked `NON-VACUITY BREAK`, executed after unconditional `git add -A`, and restored with `git checkout -- <path> && touch <path>`. Neither remains in the tree.

| Control neutralized | Exact red test (under `transform::tests::`) | Captured result | Diff against staged live state |
| --- | --- | --- | --- |
| First-application permission: force the mint condition true | `reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart` | Exit 101; DEFER byte-equality assertion failed; 0 passed, 1 failed, 1107 filtered | `reasoning_clear.rs`: 3 lines, +2/-1 while mutated; empty after restoration |
| Last-served fingerprint proof: force equality true | `reasoning_clear_legacy_missing_fingerprint_holds_until_bust` | Exit 101; no-mint-on-missing-fingerprint assertion failed; 0 passed, 1 failed, 1107 filtered | `reasoning_clear.rs`: 1 line, +1 while mutated; empty after restoration |

Each named test was the only selected test and the only failure in its mutation run. Other tests were filtered, not claimed as mutation controls.

## Differential-golden applicability

There is no equivalent **typed age-clear plus newest-assistant exemption** case on the TS leg at this revision:

- `packages/plugin/src/hooks/magic-context/tag-messages.ts:500–502` includes all reasoning-bearing messages in `reasoningByMessage`.
- `packages/plugin/src/hooks/magic-context/strip-content.ts:324–355` performs typed age clearing without a newest-assistant exemption.
- The frozen per-part decisions from `4c105b84` concern **merged-assistant reasoning stripping** (`planMergedAssistantReasoningStrip`, `strip-content.ts:518–580`), a different lane with a run-shape keep rule, not this typed age-clear predicate.

Therefore no new TS↔Rust agreement golden is claimed for this exact scenario. Existing DG tests remain green, including `dg_goldens_match_ts_wire_surface_and_gate_labels`, `dg_goldens_exercise_incremental_native_differential_mode`, and the DG perturbation guard. The two edits in `differential_goldens.rs` only replace the old zero-watermark argument with an empty frozen-decision slice.

## Gates

- `cargo test -p mc-module`: the parallel run passed 1101 lib tests but failed the unrelated wall-clock assertion `unaffected_transition_golden_is_byte_identical_and_detection_is_constant_time` at 62.434 µs/pass. Its isolated rerun passed at 27.149 µs/pass.
- `cargo test -p mc-module -- --test-threads=1`: **exit 0**; 1102 lib tests passed, six existing ignores, four integration tests passed (including the live-daemon test), binary/doc targets clean. An earlier serial attempt hit a 240-second process cap after all lib tests passed; the complete rerun used a sufficient timeout.
- Final native-prefix assertion strengthening: `cargo test -p mc-module --lib reasoning_clear_`: **exit 0**, all three focused tests passed.
- `cargo clippy --all-targets -- -D warnings`: **exit 0**, rerun after the native-prefix assertion strengthening. The `--` separator forwards the warnings-as-errors flags to Clippy/rustc.
- `cargo test -p mc-module --lib reasoning_clearing_is_not_applicable_to_claude_or_owned_broca`: **exit 0** after making its explicit decision target match the native message ID.
- `cargo fmt --check`: **exit 0**.
- `rustfmt --edition 2021 --check crates/mc-module/src/transform/reasoning_clear.rs crates/mc-module/src/transform/reasoning_clear_tests.rs`: **exit 0**; these files are included through `include!`.
- AFT inspection could not obtain authoritative Rust diagnostics because the language server failed initialization; compiled tests and Clippy are the authoritative checks.

Cargo refreshed the local `subc-core` lock entry from 0.17.21 to 0.17.22 during verification. That incidental `Cargo.lock` change was restored; it is not part of the delivery.

## Exact evidence file list

Committed:

- `crates/mc-module/src/transform/reasoning_clear_tests.rs` — new lib regression and deployment-adoption tests.
- `crates/mc-module/src/transform.rs` — existing cutoff regression and updated native replay fixtures; the production mint/replay integration.
- `crates/mc-module/src/transform/reasoning_clear.rs` — decision producer, adoption proof, and replay consumer.
- `crates/mc-module/src/lib.rs` — full/incremental native plumbing and existing encoder tests adapted to explicit decisions.
- `crates/mc-module/src/differential_goldens.rs` — existing DG caller adaptation.
- `docs/loop-r4-reasoning-clear-gate.md` — this gate record.

Local, uncommitted raw evidence under `.cortexkit/alfonso/`:

- `loop-r4-fix-red.txt`
- `loop-r4-permission-mutation.txt`
- `loop-r4-permission-mutation-stat.txt`
- `loop-r4-adoption-mutation.txt`
- `loop-r4-adoption-mutation-stat.txt`
- `loop-r4-cargo-test.txt`
- `loop-r4-cargo-test-serial.txt`
- `loop-r4-focused-final.txt`
- `loop-r4-clippy.txt`

## Existing test contract adjustment

The native encoder fixture formerly named `newest_reasoning_becomes_historical_after_watermark_tail_advance` is now `newest_reasoning_becomes_historical_after_committed_clear_decision`. Its clearing and native-cache assertions remain; it now explicitly supplies a committed clear unit. A watermark or tail advance alone is intentionally no longer authorization. The new end-to-end regression defends the previously missing no-first-clear-on-DEFER claim.
