# Second review: Rust signed-prefix hold (issue 665)

## Scope and verdict

Reviewed the Rust fix series `00bfed9032..3a8cf571ed`: implementation
`3c57193092`, additional defenses `af40dac237`, and comment cleanup `3a8cf571ed`.
The review checkout started at `7098f3b0cedb7d479c1b03d9e04fd9271f24d199`,
whose product tree is identical to `3a8cf571ed` (an empty preservation commit).
Product line references below are at that tip. This delivery changes **only this report and
`crates/mc-module/src/tests/signed_prefix_hold_review_r2.rs`**. All eight new tests
are ignored by default. Test registration and host probes were temporary and
were restored before committing.

Terminology: **head** means synthetic m0/m1; **tail** means the served live
messages after that head. SOFT adds/replaces frozen units, HARD rebuilds the
head, and SOFT+ is a Defer response. A **bust** is a request-prefix change that
loses the provider's cached prefix. Tail-only permission here permits new edits
only after the last kept signed reasoning block. **LKG** is a saved
last-known-good serve used after a failed module call. A mutation goes **red**
when the named test fails after the deliberate change.

The contracts checked are unchanged bytes before kept signatures at any
pressure, all held work landing in one rewrite on the first next-user pass,
and a request that cannot be safely shortened either fitting or being refused.
A genuinely changed head must remove the signatures bound to its old prefix.

**The six findings in the first review are fixed at the native module layer.**
The previous five executable witnesses now pass, as do the new author's
render-identity, reconcile and subagent-surface tests. The extended driver made
1,531 passes, including 1,200 held passes, without an in-turn head rewrite.
The broader rules in the brief are not all satisfied:

| ID | Severity | Finding | Introduced by these fixes? |
| --- | --- | --- | --- |
| H1 | High | A genuinely unreplayable head is rebuilt while active signed thinking remains; the healthy Rust host also keeps it | Native behavior predates the fixes; host behavior is current at the prepared tip |
| M1 | Medium | A long signed loop with no safe reclaim returns an over-window request instead of fitting or refusing | No: the same witness fails at `00bfed9032` |
| M2 | Medium | Held **drops alone** do not land on the first next-user-turn pass | No: the same witness fails at `00bfed9032` |

**Extra host question:** the inferred older-thinking strip on idle/force passes
from the TS/Pi re-review does **not** reproduce on this tip. Six real-engine
fixture replays through the Rust host preserve older thinking, active thinking
and the complete prefix through the last kept reasoning block. A mutation of
the host's active-turn veto produces exactly the inferred break. The remaining
H1 is the other half of the ruling: a genuinely changed head must not retain
signed thinking bound to its previous bytes.

Tests used throwaway SQLite stores and engine/serializer fixtures; no live
store, provider or actual provider-send operation was used.

## H1 — a truly rewritten head retains active signed thinking

`head_replay_impossible` correctly permits a native rebuild for missing m1,
lineage/section corruption, first render, bootstrap seed and legacy baseline
(`transform.rs:5196-5209`). This exception to the head freeze is necessary, but
it does not authorize keeping a signature after bytes before it change.

`review_r2_witness_rewriting_head_cannot_keep_signed_thinking` starts with a
cached pair and a historian publication held in an open signed turn. It removes
cached m1, then makes the forced pass. The new head really differs from the last
serve; the witness checks that difference rather than inferring it from HARD:

```text
r2 unavoidable: action=HARD reason=Some("hard_trigger")
head_changed=true active_signature_kept=true
a truly rewritten head kept signed thinking bound to the old prefix
```

The native witness also fails with the pre-fix `00bfed9032` transform. This is
not a new m0/m1-freeze regression.

I additionally ran the real native serializer and fed its arrays and actual
`prefix_bust_permitted` values through `createRustModeTransform`, using the
existing in-memory `frozenSession` harness. For a missing-m1 HARD that folds a
pending compartment, both healthy and reactive-recovery host cases fail:

```text
review r2 real engine host strips all thinking on rewrite (healthy) ... FAIL
review r2 real engine host strips all thinking on rewrite (reactive) ... FAIL
r2 host rewrite healthy: signed reasoning still served by a4,a5,a6
r2 host rewrite reactive: signed reasoning still served by a4,a5,a6
review r2 real engine host strips all thinking on rewrite (frozen) ... pass
```

The host does not repair the ordinary case. It computes `activeThinkingTurn`
from the input and passes it into postprocess
(`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:4382-4436`).
`applyRustModeThinkingStrips` gates `moduleBustStrips` with
`!args.activeThinkingTurn`, even when the module permits a real prefix bust
(`transform-postprocess-phase.ts:1050-1065`). Its separate frozen-LKG-release
path explains why the frozen case strips all three blocks and passes. Reactive
recovery also has a latest-turn restoration callback, not a global guarantee
that a changed head invalidates every subsequent signature
(`rust-mode-transform.ts:2607-2617,4390-4394`).

**Required property:** distinguish tail-only permission from a real head
rewrite. If the head genuinely changes, remove every signed block affected by
that changed prefix, including the active turn's, and persist that decision.
Alternatively refuse if the required safe representation cannot be produced.
Holding or replaying invalid signatures is not an unavoidable-rebuild exemption.

## M1 — no safe pressure relief, but an over-window output is returned

`review_r2_witness_signed_loop_over_window_must_fit_or_refuse` constructs a long
signed tool loop. Twenty results contribute 94,640 tokens, near 95% of a
100,000-token wall. Another result crosses the wall, and the following signed
step binds all 21 large results. Only that final step's tiny result is after the
last kept signature. The witness verifies the 21 large target IDs are actually
in `active_thinking_prefix_edit_ids`; merely queuing drops is not its proof.

At the pressure pass it supplies 95,000 usage tokens and trusted final-wire
input evidence. It sums **served tool-result text only**, omitting the head,
assistant text, reasoning and provider envelope, so the measured mass is a
lower bound, not a JSON-size proxy:

```text
r2 pressure returned action=SOFT scheduler=Some("execute")
near_wall=94640 before=104122 after=104107 head_same=true pending=21
returned SOFT with at least 104107 tool-result tokens against a
100000-token wall instead of fitting or refusing
```

The tiny reclaim removes 15 tokens, but the request still cannot fit. The head
freeze and per-target thinking protection are correct here: lifting either to
reclaim the large results would break strict binding. What is missing is the
no-fit outcome when all useful work is protected.

This is **not caused by the new freeze**. Swapping in `00bfed9032` returns HARD
instead, but the head happens to recompose identically and the same 104,107
tokens remain. Allowing the old refold does not solve this example.

The native refusal at `transform.rs:7597-7627` checks only the selector's
`protected_tool_block_ids` mass, when the request marks its current final-wire
input evidence trusted. This fixture
clears `protected_tools`; its large results are thinking-prefix protected, not
count-override protected. The Rust host's final-wire check is narrower too:
`rust-mode-transform.ts:4485-4509` calls `outgoingContextRefusal`, which requires
both refusal-grade over-limit evidence **and protected-tools mass alone over
the wall** (`emergency-fail-closed.ts:55-77`). A healthy over-limit total is not
by itself a refusal. Generic TS's emergency abort additionally requires armed
provider-overflow recovery (`transform-postprocess-phase.ts:1762-1817`).

The executable proof is a native-module return, **not an observed provider
send**. Host admission above is code evidence; host protected-tools counts are
computed independently. Returning a request that cannot fit instead of safely
shortening or refusing it violates the fit-or-refuse rule; this Rust hold and
the cited healthy host guard do not provide that guarantee.

## M2 — queued drops alone survive the next user turn

`review_r2_witness_drop_only_release_applies_all_held_work` queues `r5#0` (the
first content block of tool-result message `r5`), before
later kept signed thinking. At 66% it is correctly held. It then appends a real
user message and makes the first release pass at the same execute pressure:

```text
r2 drop-only release action=SOFT+ reason=None pending={"r5#0"}
the first next-turn pass left held work queued: {"r5#0"} (action SOFT+)
```

This also fails at `00bfed9032`. It is not a stuck `signed_head_frozen` flag:
with a flush/publication/marker/identity trigger the release works. Rather,
queued drops never originate the bust needed to apply themselves.
`independent_rebuild` and `supersession_ride_available` omit an ordinary
next-user release with only queued agent drops (`transform.rs:5349-5379`).
Selection therefore leaves them pending before classification.

The first review's driver explicitly allows this case to defer
(`signed_prefix_hold_review.rs:493-499`). Its successful “releases with work”
count is conditional on a flush, publication or model switch. Thus neither the
first driver nor my larger run proves the unqualified one-bust-next-turn rule
in this brief. The new witness closes that hole without changing that driver.

If drops alone are intentionally not a bust origin, narrow the claimed release
contract. Under the stated contract, held work needs a release opportunity on
that first new-user pass.

## Native freeze, release and floor checks

### Extended first-review driver

The new ignored test reuses `review_held_driver` unchanged. It exercises tool
appends, user turns, drops, flushes, historian publications, usage crossings and
store reopens, with six **new** seeds and 240 steps each (first review: six seeds, 70 steps each):

```text
3141592653589793 2718281828459045 6a09e667f3bcc909
bb67ae8584caa73b 3c6ef372fe94f82b a54ff53a5f1d36f1
passes: 1531                 held: 1200
releases: 91                 releases_with_work: 65
pressure: 68                 idle: 15
in_turn_head_rewrites: []
```

That exceeds 3x both the original 449 total passes and 349 held passes. All 65
releases with a flush, publication or model switch landed their held work and replayed byte for
byte on resend. The 26 other releases are not all-work-lands proofs (M2).

### Ordered prefix and tail-only SOFT

`review_r2_tail_soft_preserves_ordered_prefix_and_releases_once` covers 86%,
95%, armed recovery at 30%, and idle expiry at 66%. It queues an early protected
drop and a late allowed drop, a flush and a project-memory marker with a
publication waiting. All four cases:

- take tail-only SOFT, apply the late drop and leave the early one queued;
- preserve the **complete ordered prefix**, not just surviving messages keyed
  by ID, through the last kept reasoning block;
- leave the m1 flush and marker pending;
- land the remaining work in a next-user HARD, then exactly replay it.

The helper stops at the reasoning block, not the end of its assistant message:
text/tool content **after** that block can legitimately change. An initial
whole-message comparison caught such a permitted suffix edit; it was corrected
before treating any failure as a finding. The early-target mutation below
proves the final ordered-prefix check detects removal, which the old driver's
surviving-ID comparison alone could miss.

`review_r2_render_identity_change_survives_tail_soft_until_release` separately
proves that a changed render identity remains unseen during force-band SOFT,
becomes an epoch-change HARD at the next user message, and replays on resend.
No head remained frozen past a user turn in these flush/marker/identity releases.

### `pre_snapshot_inputs_changed` (M15)

The new floor test removes the durable floor snapshot, observes the original
16,000 floor outside a signed turn, then holds changes to 24,000, 32,000 and
28,000. Each held pass replays the same bytes, leaves the durable snapshot
absent, and leaves the pre-snapshot observation at 16,000. The first new-user
pass is HARD with `protected_tokens_inputs_changed`, persists **28,000**, and
the resend replays exactly with that latest value still persisted.

This tests more than the old witness's materialize reason. The configured floor
is neither consumed early nor reduced to the first held change. Resolution uses
that floor for the effective protection window and persisted scalar
(`transform.rs:5457-5476`; `protection_window.rs:222-254`). The M15 mutation
consumes inputs while frozen and the old witness goes red on release, as before.

### Unheld byte comparison

The original 372-pass six-configuration digest test and the author's 224-pass
unheld test pass in the final lib gate; their expected digests are the committed
`dda49e38` goldens, not regenerated values. This supports byte parity for those
ordinary sessions. It is not universal equivalence over corrupted stores:
repairing M2 of the **first** review deliberately changes the unheld
scheduler-Defer discarded-sections HARD to carry its queued drop, too.

## Rust-host strip question and TypeScript parity

The named TS/Pi report is absent from this checkout, but its intended path was
confirmed in Git at **`e48acbbc9e5656f11a02a405f1a58d3459278243`**:
`docs/reports/issue-665-hold-review-r2.md`, “Parity with the Rust fix”, lines
322-342. I did not create a substitute file. That section explicitly calls the
Rust-host older-thinking exposure inferred, and its Rust head comparison uses
the **pre-fix** implementation. Its idle/force m0/m1 divergence is no longer
current after `3c57193092`.

The extra Rust-host check was executable, not just a reading of that report:

1. An ignored native test builds a finished older signed assistant (`a2`), a
   real user (`u3`), three signed completed-tool steps (`a4`–`a6`), and an
   unsigned step (`a7`) after the last signature that can actually be reduced.
2. It runs the real Rust engine and the dispatcher's
   `crate::encode_full_native_messages`, exporting baseline and pressured native
   arrays. It asserts that the native output **really changes**, not merely that
   permission is granted. It also exports the missing-m1 HARD used for H1.
3. A temporary append to the existing `rust-mode-frozen-defects.test.ts`
   replays these arrays through the production **Rust host adapter**. Its
   scripted module envelope uses the engine's actual decision/permission; no
   engine decision is recomputed on the TS side. Session IDs are consistently
   remapped to the harness's isolated in-memory session.
4. For each idle/force case, healthy, reactive-recovery and previously frozen
   host states all pass: `older=true active=true prefix_same=true`.
5. Removing **only** the host's active-turn veto changes the force/reactive
   result to `older=false active=true prefix_same=false`, and that exact test
   fails. This is the inferred break, reached by the test, but absent in the
   unmutated tip.

These are host adapter tests with actual engine/serializer fixtures, not a live
daemon-to-provider integration. The frozen case enters LKG freeze by a scripted
module error. No provider-bound request was submitted. The complete ordered
prefix includes older assistants' thinking; a test that only compared m0/m1
would not establish this result.

Code-level comparison with the TypeScript lane visible here:

| Scenario | Rust at reviewed tip | TypeScript source evidence |
| --- | --- | --- |
| Cached head at idle/force/95% | Remains frozen; native and host checks pass | `freezeM0M1` gates fold/capture/refresh without a force exception (`transform-postprocess-phase.ts:2040-2103`); matches head policy |
| Idle-expired riders under a frozen head | Rust explicitly releases drains and prices primary idle work (`transform.rs:5214-5219,5358-5367`) | TS's `idleExpiryRebuild` requires `!freezeM0M1`; idle alone is absent from its ride under a freeze (`transform-postprocess-phase.ts:2272-2296`); **different idle-drain policy** |
| Force-band riders | Explicit force episode with per-target protection | TS force ride uses `emergencyDropEligible`, 95% or an empty emergency sample (`transform-postprocess-phase.ts:2277-2284`); same broad pressure opportunity, not proof of identical targets |
| Armed recovery at 30% | Explicit `Emergency95` exemption, defended by the recovery test | TS's shown emergency-drop eligibility is percentage-based (`transform-postprocess-phase.ts:1967-1980`); low-usage recovery parity is not established by those predicates |
| Forced head rebuild | Carries allowed queued work; native/healthy host still keeps invalid active signatures (H1) | TS's ride signals do not spell out Rust's lineage/discarded-sections set (`transform-postprocess-phase.ts:2277-2292`); the separately reviewed report's first-render/repair differences remain relevant |
| Over-window healthy total | Native witness returns too large; protected-tools-only refusal is insufficient (M1) | Shared host refusal helper has the same narrow criterion (`emergency-fail-closed.ts:55-77`), not a general total-fit guarantee |
| Release with flush/publication/identity | One native bust then replay, tested | TS also leaves frozen history refresh pending (`transform.ts:1772-1794`); this is source-level comparison, not a rerun of the separately reviewed pure-TS driver |

I do not claim full end-to-end equivalence with the separately reviewed TS
revision, or pure-TS/Pi executable coverage from the Rust-host tests.

## Mutation controls

I reran three established controls by their first-review IDs (M02, M08, M15),
then added two native controls and one host control. The supplied claim of 24
controls was not treated as evidence that every guard is defended. The
reproducible control identities used here are the documented first-review ones.

Every mutation used this sequence locally in the isolated worktree: stage the
specific live files, confirm an empty working diff, apply a change marked
`NON-VACUITY BREAK`, capture the non-empty `git diff --stat`, run the Linux
check, then `git checkout -- <mutated-path> && touch <mutated-path>` and capture
an empty working diff. No mutant, temporary registration, or host test remains
in the commit.

| Control | Targeted test/result | During / after restore |
| --- | --- | --- |
| M02: remove `Emergency95` from `signed_drains_released` only | `signed_prefix_hold_yields_to_an_armed_overflow_recovery` **did not redden**; `signed_prefix_hold_yields_to_the_force_band` also passed (2 passed) | `transform.rs`: 3 lines, `2+ 1-` / empty |
| M08: remove frozen-head veto from `hard_fold_requested` | Isolated `signed_prefix_hold_keeps_a_marker_hard_pending` **red**: HARD instead of SOFT+ | `transform.rs`: 6 lines, `3+ 3-` / empty |
| M15: call `pre_snapshot_inputs_changed` while frozen | `review_held_pass_keeps_a_changed_protection_floor_for_the_release` **red**: release SOFT+, reason None instead of `protected_tokens_inputs_changed` | `transform.rs`: 4 lines, `2+ 2-` / empty |
| R2-A: omit `active_thinking_prefix_edit_ids` from selector protection | `review_r2_tail_soft_preserves_ordered_prefix_and_releases_once` **red**: ordered prefix shrinks from 9 messages to 8 at 86% | `transform.rs`: 3 lines, `2+ 1-` / empty |
| R2-B: consume `last_render_config` in the frozen-head SOFT arm | `review_r2_render_identity_change_survives_tail_soft_until_release` **red**: release SOFT instead of HARD | `transform.rs`: 2 lines, `2+` / empty |
| R2-C: remove host `!activeThinkingTurn` from `moduleBustStrips` | `review r2 real engine host keeps older thinking on force (reactive)` **red**: older removed, active retained, prefix differs | `transform-postprocess-phase.ts`: 2 lines, `1+ 1-` / empty |

M02's single clause is now redundant with the explicit emergency opportunity in
`supersession_ride_available` (`transform.rs:5373-5379`). This is an **undefended
single-clause mutation**, not proof that removing all emergency escape paths
would pass. The same native target has four reddened controls above. M08's
preliminary two-test run also reddened the force-band relief test, which queues
a marker; the isolated rerun records only the named marker test. M15 and R2-A/B/C
ran only their named test; no other test was selected in those red runs.

## Gates and limits

All Cargo tests/clippy and Bun host checks ran on Linux with `runon: linux,8c`.
Versions: cargo/rustc **1.99.0**, clippy **0.1.99**, rustfmt **1.10.0-stable**,
Bun **1.4.2**, TypeScript **5.9.3**.

| Command/check | Result |
| --- | --- |
| `cargo test -p mc-module` | lib 1,728 passed, 29 ignored at that point (7 new probes then); caveman bin and ordinary integrations 15 passed in aggregate; `real_daemon` 1 passed, 4 failed, 2 ignored |
| `cargo test -p mc-module --lib` (last full library gate) | **1,728 passed, 30 ignored** (all 8 new probes ignored) |
| `cargo test -p mc-module --lib -- --ignored review_r2_ --nocapture` | **5 passed, 3 failed**: exactly H1, M1, M2's named native witnesses; extended driver and all defending probes pass |
| Same three native witnesses with `00bfed9032`'s transform | **3 failed**, with the same contract failures; pressure action is HARD instead of SOFT |
| `cargo test -p mc-module --lib -- --ignored review_r2_native_engine --nocapture` after strengthening the native fixture | **1 passed**: real late-tail reduction changes native output; force/idle prefix stays stable; missing-m1 rewrite changes the head |
| `cargo clippy -p mc-module --all-targets -- -D warnings` | passed after the last code edits; mc-module all targets checked, including ignored witnesses |
| Temporary host bridge, `bun test packages/plugin/src/hooks/magic-context/rust-mode-frozen-defects.test.ts -t 'review r2 real engine'` | **7 passed, 2 failed**, 66 assertions across 9 cases: six idle/force cases pass; rewritten-head healthy/reactive fail, frozen passes |
| `(cd packages/plugin && bun run typecheck)` | passed, with TypeScript 5.9.3; temporary host probes were included |
| Formatting | passed: `cargo fmt -p mc-module --check` and direct `rustfmt --edition 2021 --check .../signed_prefix_hold_review_r2.rs` checked separately, because the review file is included rather than a `mod` |

The four real-daemon failures are the existing `real_daemon.rs:1098`
`fs::canonicalize` of an absent sibling `subconscious` checkout on the Linux
runner. They are the same environment failures as the first review, not hold
failures. No daemon integration was represented as passing.

### Reproducing the ignored probes

To keep the delivery report-only, the new file is intentionally not permanently
registered in product source. In a disposable checkout, temporarily add:

```rust
include!("tests/signed_prefix_hold_review_r2.rs");
```

immediately after the existing `include!("tests/signed_prefix_hold_review.rs");`
in `transform.rs`'s test module. Run the ignored command above; expect 5 green
probes and 3 red contract witnesses. Restore that include afterwards.

For the host bridge, create `review-r2-scratch/` and export fixtures on the same
Linux checkout with:

```sh
MC_REVIEW_R2_EXPORT_DIR="$PWD/review-r2-scratch" \
  cargo test -p mc-module --lib -- --ignored review_r2_native_engine --nocapture
```

This produces `force.json`, `idle.json`, and `rewrite.json` with full real-engine
responses. The test also prints compact `R2_HOST_FIXTURE` JSON records for
transport between test machines. Use the same before/pressured native arrays,
not regenerated approximations. In the existing `rust-mode-frozen-defects.test.ts`
add a temporary import of `armLatestThinkingRecovery` from
`./latest-thinking-recovery` and append the following bridge; run it from the
repository root, then restore that file. Its existing `frozenSession` helper
supplies the isolated database and actual Rust adapter.

```ts
for (const kind of ["force", "idle", "rewrite"] as const) {
    for (const mode of ["healthy", "reactive", "frozen"] as const) {
        const behavior = kind === "rewrite"
            ? "strips all thinking on rewrite" : `keeps older thinking on ${kind}`;
        it(`review r2 real engine host ${behavior} (${mode})`, async () => {
            const fixture = await Bun.file(`review-r2-scratch/${kind}.json`).json();
            const s = frozenSession(`r2-host-${kind}-${mode}`);
            const remap = (messages: MessageLike[]) => structuredClone(messages).map(m => {
                m.info.sessionID = s.sessionId;
                return m;
            });
            const input = remap(fixture.input);
            s.setModuleOutput(() => remap(fixture.before.native_messages));
            const before = await s.run(input, "SOFT+") as MessageLike[];
            if (mode === "reactive") armLatestThinkingRecovery(s.db, s.sessionId);
            if (mode === "frozen") await s.run(input, "throw");
            s.setUsage(kind === "force" ? 86 : 66, kind === "force" ? 172_000 : 132_000);
            s.setModuleOutput(() => remap(fixture.pressured.native_messages));
            expect(fixture.pressured.prefix_bust_permitted).toBe(true);
            const after = await s.run(input, kind === "rewrite" ? "HARD" : "SOFT") as MessageLike[];
            if (kind === "rewrite") {
                const ids = after.filter(m => m.parts.some(p => p.type === "reasoning"))
                    .map(m => m.info.id);
                expect(ids).toEqual([]);
                return;
            }
            const prefix = (messages: MessageLike[]) => {
                const end = messages.findIndex(m => m.info.id === "a6");
                expect(end).toBeGreaterThanOrEqual(0);
                const copy = structuredClone(messages.slice(0, end + 1));
                const kept = copy.at(-1)!;
                const last = kept.parts.findLastIndex(p => p.type === "reasoning");
                expect(last).toBeGreaterThanOrEqual(0);
                kept.parts = kept.parts.slice(0, last + 1);
                return JSON.stringify(copy);
            };
            expect(prefix(after)).toBe(prefix(before));
        });
    }
}
```
