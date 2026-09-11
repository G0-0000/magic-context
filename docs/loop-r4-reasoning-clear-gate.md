# Reasoning-clear cache-core gate — revised delivery

This record supersedes the first delivery's CK-only adoption argument. The original fix remains: **a frozen age cutoff is not a frozen applied set**. The revision adds genuine pre-deploy fixtures, native evidence, generation fences, lifecycle handling, and serialized incremental-wire tests.

## 1. Genuine pre-fix fixture

Generating commit: **`e2109bdc1d1f6fc0dd61c0b995083c12d700fe04`**.

The generator actually ran with that commit's `transform.rs`, `lib.rs`, `differential_goldens.rs`, and `mc-store/src/lib.rs`. Only an `include!` inside the existing test module was added to invoke the fixture generator. The working implementation was staged first, the old source installed using `git show`, and the implementation restored using `git checkout -- <paths> && touch <paths>` afterward. No stash or parent-checkout edits were used.

Committed fixture files:

- `crates/mc-module/gen/reasoning-clear-legacy/pre-fix.sqlite` — the actual closed SQLite store from the old binary, not a post-fix snapshot with units deleted.
- `pre-fix.json` — raw native ingress, request configuration, decoded CK output, native output, cutoff, row version, and generating commit.
- `pre-fix.ck.json` — exact serialized CK bytes written by the old implementation, without a JSON-value parse/reserialize changing property order.
- `pre-fix.native.json` — exact serialized native output bytes written by the old implementation.
- Generator source: `crates/mc-module/src/transform/reasoning_clear_legacy_generator.rs` (intentionally not included in normal builds).

The source blob hashes collected before inserting the generator hook were checked against `git rev-parse e2109bdc:<path>`. The expected/actual hashes and fixture SHA-256 hashes are in `docs/evidence/loop-r4-reasoning/manifest.json` and `generator-source-blob-hashes.txt`. The complete generation output is `pre-fix-fixture-generation.txt`.

The real fixture demonstrates why CK proof cannot stand in for native proof: assistant `already` has an **empty reasoning shell in CK**, but its real OpenCode sidecar encoder **omits that part entirely** from native output. Assistant `old` still has signed reasoning because it is exempt. The regression checks both representations against independently recorded pre-fix bytes.

### Reproduction of fixture generation

From a clean checkout of the delivery branch:

1. Stage the live state with `git add -A`.
2. Install the four source files listed above from `e2109bdc` using `git show <commit>:<path> > <path>`; record their `git hash-object` results.
3. Insert `include!("transform/reasoning_clear_legacy_generator.rs");` inside `transform::tests`, before `reasoning_cutoff_batches_on_one_fold_and_survives_restart`.
4. Run `cargo test -p mc-module --lib generate_pre_fix_reasoning_clear_fixture -- --nocapture`.
5. Restore those four files from the staged state and touch them. Restore the incidental `Cargo.lock` change.

The fixture is entirely synthetic; no live session or credentials were read.

## 2. Adoption, holding, and retirement

Durable decisions remain `strip:reasoning_clear:<message-id>` frozen units with an empty sentinel payload. New first applications consume the existing `is_bust_pass` permission, not a local pressure predicate.

### First post-deploy DEFER

A legacy cleared representation may be replayed only when:

- the last-served CK fingerprints prove the exact cleared representation of **every** reasoning block;
- the original source identity vector matches current ingress (not an identity re-adopted during this transform);
- no native-keep decision contradicts that proof;
- legacy replay has not retired.

That bounded replay uses a **request-local** `strip:reasoning_clear_legacy:` unit. It is removed from `core.frozen_units` before committing (`transform.rs`, `reasoning_clear_units` extraction and removal immediately before `state_changed`). It is not a durable clear decision. Holding means replaying the previously cleared bytes, **not resurrecting signed ingress**.

A previously signed/exempt assistant cannot enter this arm. The original red-first HARD → exemption movement → DEFER regression remains green.

### Native proof

After full/incremental native attachment has produced its actual output, `record_reasoning_native_evidence` records:

- the exact native representations of the legacy-replayed messages;
- their prospective representation under ordinary clear units;
- the exact CK fingerprint vector;
- a hash of raw native ingress, CK ingress, and render configuration;
- `(revert_epoch, shadow_generation, shadow_seq)`;
- the resulting metadata row version.

Storage is **`mc_cache_state.meta.reasoning_replay_evidence`**. No table, schema migration, fence movement, or epoch bump was introduced.

A DEFER can adopt an ordinary unit only if the CK proof and source identity still hold, the generation and row version are current, the source hash matches, and actual/prospective native representations are exactly equal. Missing or unequal native proof keeps the bounded legacy representation until proof exists or a later bust prices the transition. A bust-permitted pass can mint the ordinary decision without legacy evidence.

The regression explicitly rejects a native proof whose prospective representation is changed to an empty-text sentinel. It also verifies that a stale generation can retain its known, unchanged legacy wire bytes **without being accepted as current adoption authority**.

### Self-retirement

`meta.reasoning_clear_initialized` retires legacy eligibility on the first priced native pass, or when all replayed cleared messages have ordinary units. Native proof is then discarded. `legacy_allowed` short-circuits on this flag, so stale stored fingerprints cannot reactivate legacy adoption later. The generation test includes a retired-state negative arm, and the retirement guard has an executed red mutation.

## 3. Fingerprint writer, read snapshot, and generation validity

Relevant source locations at delivery:

- `mc-store/src/lib.rs:7350–7403`: `load_transform_snapshot` selects row version, core state, and metadata in one SQLite read transaction. Non-tag overlays share that snapshot.
- `mc-module/src/transform.rs:3388–3399`: that snapshot is loaded before the separately validated tag baseline.
- `transform.rs:5544–5548`: adoption receives **`&loaded.meta` and `loaded.row_version`**, plus the current projection. It does not use the working metadata identity map already updated by `apply_ingress_meta`.
- `transform.rs:5786–5789`: the final CK output fingerprint and `served_output_generation` are written together. Both remain unchanged when a deferred frozen-prefix divergence prevents adopting a new fingerprint. The two early passthrough writers likewise stamp their output generation alongside their fingerprint.
- `transform.rs:5846–5851`: `commit_transform` persists core and metadata under the expected row-version fence.
- `reasoning_native_evidence.rs:25–27,60–77`: native evidence first checks the response row version against the current store row, then uses the store's CAS commit. A losing or late callback cannot stamp a different transform/hydration snapshot. Evidence row version is the committed successor, and the response is updated to that version.

The adoption predicate distinguishes **historical bytes retained for holding** from **current-generation evidence authorizing adoption**. Legacy rows lack the new generation stamp; they cannot provide current native proof merely by having a numeric cutoff. A real attachment records new proof only after serving and verifying the bounded representation.

Tests cover stale revert epoch, shadow generation, shadow sequence, metadata row version, changed source identity, native-representation mismatch, and a native attachment finishing after a newer hydration commit. A mutation that substitutes the old generation for the current generation goes red; so does removal of the native callback's row-version check.

## 4. Lifecycle and exemption precedence

### Same-lineage subsets/reverts

`surviving_strip_units` retains reasoning-clear units across temporary subsets. They remain tied to the original message identity enforced by the existing frozen-target identity checks. They are not silently reminted for a different block.

If an active clear's message becomes the newest assistant or a lineage anchor, `reasoning_exemption_repair` requests a **priced structural HARD**. Only after the common bust permission is established does `refresh_reasoning_clear_exemptions` mark the unit suspended (`reset_rule = newest-assistant-keep`). Its payload is unchanged. Native keep then wins and the signed representation is restored on that priced pass. The suspension remains in effect on subsequent DEFERs even when a newer assistant arrives. Another permitted bust can resume clearing.

A legacy cleared assistant becoming exempt before unit adoption uses the same priced restoration rule. This is not a migration HARD: unchanged legacy sessions remain DEFER-shaped and byte-identical.

The anchor test uses a real reasoning-bearing assistant that is **not** newest, proving the anchor condition independently. The re-exemption test reconstructs native deltas across three stable cleared DEFERs, a priced restoration, three stable kept DEFERs (including another newest-assistant change), and a priced resume. It also seeds a keep and clear on the same message to defend their precedence. No A→B→A wire flip is permitted on those deferred passes.

### Descent / composed inheritance

`mc-store/src/lib.rs:10854–10874` removes reasoning-clear and native-keep units from the copied target core, clears CK/native evidence, and resets adoption initialization. The new seam may reuse an old message ID without inheriting old reasoning authority. Other history/compartment state still follows the existing descent contract; the source lineage retains its own units.

`lineage_descent_tests::reasoning_clear_units_and_proofs_do_not_cross_direct_or_composed_descent` tests direct A→B and composed A→B→C with B selected as the inherited source. Both targets receive the new anchor but neither receives source reasoning units/evidence. Removing the clear-unit filter makes this test fail.

### Pi fork / branch

Pi invokes `copySessionStateForClone` through `clone-inheritance.ts:200–206`. The copy uses explicit TS tables and selected metadata (`storage-clone.ts:233` onward), not Rust `mc_cache_state`. The new Pi test exercises both a prefix fork and a divergent branch; valid retained tags are copied, removed tags are omitted, and an intentionally colocated Rust state row containing a clear and native evidence is not copied. Rust state normally resides in a separate store, making that colocation fixture an additional negative control.

Session deletion removes the state row through `McStore::delete_session`; no reasoning unit or proof can survive that row's removal.

## 5. Combined rendering and serialized wire assertions

`ReasoningNativeHarness` runs **`attach_native_messages_incremental` and `finalize_native_messages_response`** with real raw OpenCode sidecars. It rebuilds responses from `native_messages_delta` using `after` and `replace_from`, then compares **`serde_json::to_vec` bytes**. The migration test requires at least three actual deltas; a full-response-only fallback cannot pass that requirement.

The combined fixture places leading whitespace, signed reasoning, and text in an assistant adjacent to another assistant. A typed clear owns those blocks; the merged-reasoning lane must not mint a second stripping decision for the same message. Three deferred passes, including further assistant growth, must preserve the exact reconstructed native bytes and show no CK prefix divergence.

The old post-fix-generated migration fixture was replaced, not retained as migration proof. The original frozen-cutoff regression and existing DG suite remain green. As previously documented, TS typed age clearing has no equivalent newest-assistant exemption: `tag-messages.ts:500–502` collects all reasoning parts and `strip-content.ts:324–355` clears by age. The frozen per-part TS merged-assistant mechanism is a different lane. No unsupported TS↔Rust agreement claim is made for typed age clearing.

## 6. Gates and complete evidence

All complete stdout/stderr captures, not excerpts, are committed under **`docs/evidence/loop-r4-reasoning/`**. `manifest.json` lists every file's byte length and SHA-256, plus fixture/source provenance.

Passed gates:

- `cargo test -p mc-module -- --test-threads=1` — exit 0, 1109 lib tests passed, six existing ignores, four integration tests passed, binary/doc targets clean. Serial execution avoids the already-observed unrelated wall-clock test contention from the first delivery.
- `cargo test -p mc-store -- --test-threads=1` — exit 0, 140 store tests.
- `cargo clippy --all-targets -- -D warnings` — exit 0.
- `cargo fmt --check` and explicit rustfmt checks for `include!` files — exit 0.
- `bun test src/clone-inheritance.test.ts` in `packages/pi-plugin` — exit 0.
- `bun run typecheck` in `packages/pi-plugin` — exit 0.
- Restored module/store focused tests — exit 0 after deliberate mutations were removed.

Dependencies were installed in this worktree with `bun install --frozen-lockfile --ignore-scripts` because the initial Pi run lacked `jsonc-parser`. No package manifest or Bun lock changed. The incidental local `subc-core` Cargo.lock version refresh was restored. AFT's language servers were unavailable; the compiled gates above are authoritative.

### Executed mutation matrix

Each run stages the live state with unconditional `git add -A`, applies a marked deliberate break, captures a **nonempty diff against the index**, runs the exact named test, restores with `git checkout -- <path> && touch <path>`, and captures an **empty diff against the index**. Full mutation logs and paired stat files are committed. Each selected test was the sole failure; other tests were filtered, not claimed as controls.

| Control | Exact test name (module prefix omitted) | Result |
| --- | --- | --- |
| First-application permission | `reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart` | exit 101, byte-equality failure |
| Native proof required before adoption | `reasoning_clear_pre_fix_database_migrates_ck_and_incremental_wire_without_bust` | exit 101, CK-only adoption rejected |
| Current generation rather than old stamp | `reasoning_clear_rejects_previous_generation_and_hydration_evidence` | exit 101, stale evidence adopted |
| Descent filter | `reasoning_clear_units_and_proofs_do_not_cross_direct_or_composed_descent` | exit 101, inherited clear detected |
| Priced re-exemption repair | `reasoning_clear_reexemption_and_native_keep_collision_change_only_on_priced_passes` | exit 101, expected HARD became SOFT+ |
| Native callback row-version fence | `reasoning_clear_native_proof_cannot_overwrite_a_newer_hydration_snapshot` | exit 101, newer snapshot overwritten |
| Legacy retirement flag | `reasoning_clear_rejects_previous_generation_and_hydration_evidence` | exit 101, retired path reactivated |

The original red-first output is also included as `original-lib-red.txt`:

```text
assertion `left == right` failed: DEFER must not first-clear reasoning merely because its exemption moved
```

No deliberate break remains in implementation files. No schema fence, deployment artifact, parent checkout, or production service was changed.
