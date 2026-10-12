# Third review: Rust signed-thinking reset (issue 665)

## Scope and verdict

Reviewed `6702c79853..43cbebb4fd`: implementation `d2814a4209` and comment
cleanup `43cbebb4fd`. The earlier rounds reviewed holding the request prefix
unchanged during signed tool loops, and identified the rewritten-head and
unreclaimable-over-window cases that this implementation now resets. They are
recorded in
[`issue-665-rust-hold-review.md`](issue-665-rust-hold-review.md) and
[`issue-665-rust-hold-review-r2.md`](issue-665-rust-hold-review-r2.md).
Product references below are at `43cbebb4fd`. This delivery changes only this
report and `crates/mc-module/src/tests/signed_prefix_hold_review_r3.rs`.
The eight new probes are ignored, and their temporary `include!` is not shipped.
No product fix, architecture edit, live store, provider call, or Mac daemon test
is part of this review.

Terminology: **head** means the synthetic m0/m1 messages prepended to the live
conversation (plus the m0 mural extension). A **held** pass keeps bytes before the
last retained signed reasoning block unchanged; a **reset** removes all reasoning
blocks so those prefix bytes may safely change. **LKG** means a stored
last-known-good served representation used when the native module cannot answer.
The new tests are **ignored** by default, meaning ordinary test commands do not
execute their report-only contract failures.

**The original primary-session H1 and tool-result M1 witnesses are fixed.**
Genuine head changes strip active thinking; the r2 large-result loop now fits or
refuses. The existing host tests pass in healthy, reactive and frozen states.
Primary reset decisions are committed before the native result returns, and
ordinary same-turn, next-turn, reopen and LKG replay preserve the stripped state.
The wider exactness/fit contract is not fully met:

| ID | Severity | Finding | Relationship to the new commits |
| --- | --- | --- | --- |
| R3-H1 | Medium | Losing cached m1 resets all thinking even when the rebuilt **served head is byte-identical** to the preceding serve | New false positive in the stored-head comparison |
| R3-M1 | Medium | A signed subagent loop at the wall still returns over-window with every useful target protected | Existing r2 gap remains outside the new primary-only guard |
| R3-M2 | Medium | The new primary fit/refusal check omits tool-call inputs; even an H1 **reset pass** can return over-window | Existing non-fit class not covered by the new check |

The first finding costs thinking unnecessarily; it does not demonstrate an
invalid retained signature. The two wall findings demonstrate native output
exceeding the module's own token-estimation window, not an observed provider send.
There is also an **unproved host crash-ordering risk**, distinguished below from
these executable findings. No end-to-end crash-safety verdict is claimed.

## Persistence, replay and dispatch ordering

### Native reset is durable and replayable

The wrapper keeps `reset_signed_thinking` across internal retries, including
CAS reloads (`transform.rs:2992-3049`). A reset creates one
`strip:reasoning_age:<mid>` unit for each non-synthetic assistant carrying
reasoning and not already stripped, then plans against a core with those units
present (`transform.rs:5235-5269`). The reasoning predicate includes both
`Reasoning` and `RedactedReasoning` (`transform.rs:16983-16988`). Thus this is a
whole-message removal, not a text-only replacement that leaves a signature or
redacted block behind.

The new persistence witness includes thinking from an older user turn, three
active-turn assistants, and an extra redacted block beside ordinary reasoning.
It checks **four persisted strip IDs for five blocks**, not just the response
flag. It passes original, still-signed ingress to every later transform:

```text
review_r3_reset_replays_original_ingress_after_restart_and_next_turn ... ok
r3 persistence: all 4 strips durable at return (5 reasoning/redacted blocks);
same-turn/reopen/next-turn replay exact; fresh thinking kept
```

The reset removes all five blocks. Same-turn resends and a close/reopen of the
throwaway SQLite store reproduce the complete CK served array byte for byte.
After a real user message, the old blocks remain absent, and a subsequent reopen
replays that next-turn serve exactly. New thinking added afterward is retained
and replays after another reopen: the reset is not a permanent ban on reasoning.

The head, strips, metadata, consumed drops and overlays go through
`commit_transform` together (`transform.rs:7788-7829`), before the response is
returned. The store writes frozen sections and the small row inside its fenced
transaction (`mc-store/src/lib.rs:10766-10800,10870-10906`). A reset that still
cannot fit refuses before that commit (`transform.rs:7733-7748`); the author's
user-prompt refusal test also checks unchanged row version and queued drops.

The interruption witness throws at the existing **precommit attempt hook**.
The first interrupted attempt changes neither row version nor core. After
reopening, the same ingress triggers a complete reset, and the next reopen
replays it exactly. This covers a real execution boundary but is **not** a
SIGKILL/power-loss test during SQLite I/O. Native transaction atomicity supplies
that latter argument; the witness alone does not.

### Healthy host, reactive recovery and LKG after a completed reset

The adapter forwards the exact reset flag to postprocess
(`rust-mode-transform.ts:4435-4438`). `applyRustModeThinkingStrips` treats it as
all-thinking strip permission on a cache-busting pass, disables active-turn
protection, and skips restoring the originals
(`transform-postprocess-phase.ts:1005-1009,1058-1097`). Reactive recovery is then
ended for the turn (`rust-mode-transform.ts:4464-4469`;
`latest-thinking-recovery.ts:185-199`). The refusal code is mapped before ordinary
LKG fallback (`emergency-fail-closed.ts:22-53`;
`rust-mode-transform.ts:4919-4925`).

All 35 existing frozen-adapter tests pass. In particular:

- idle/force tail-only changes retain the entire ordered prefix through the last
  kept reasoning block, in healthy, reactive and frozen modes;
- a genuine head rewrite serves no reasoning, now or on the next pass, in all
  three modes;
- the flag strips all reasoning even when a scripted module output still
  contains it, in healthy and reactive modes. T1 below proves this check reaches
  the host flag handling rather than merely trusting already-stripped fixtures.

A temporary additional host test used the same committed fixtures containing
native message arrays and decisions exported by the Rust engine and serializer.
For each of healthy/reactive/frozen it served the reset, forced a module failure
and LKG replay, then emptied the in-memory slots and restarted the adapter on its
in-memory database. Both the replay and the restarted serve had no reasoning and
were JSON-byte-identical to the reset serve: **1 test, 15 assertions passed**.
It was removed after verification; a reproduction body is supplied below.

### Crash between native commit and host replacement: limit of the proof

The native reset and the host LKG are **not one transaction**. Recovery is cleared
at `rust-mode-transform.ts:4464-4469`, before output installation at `4543-4545`,
before old-slot invalidation at `4564-4570`, and before the synchronous replacement
capture at `4602-4614`. A process interruption in this interval can leave a
new native core and an old durable LKG physically present together.

Normally host binding-mismatch strips protect LKG replay. But the strip helper
records only assistants that **still carry reasoning in its input array**
(`transform-postprocess-phase.ts:566-585`). A real already-stripped native reset
can therefore have no new host strip IDs to record. The explicit reset fallback
also strips even if host strip persistence fails (`1080-1092`), relying on native
durability. LKG replay does not directly read native `reasoning_age` units.

This establishes a storage-ordering window, **not** a demonstrated invalid send
or resurrection after a crash. The old head plus old thinking might still form a
valid complete replay. Restart admission checks whether a saved replay can fit,
and freeze detection checks whether it represents the provider's last-served
prefix; these checks also affect which array may be served. The
post-success restart test does not reach this window. Synchronous capture failures
after slot invalidation throw and do not certify a successful replacement
(`rust-mode-transform.ts:4586-4614`); that is a different, defended boundary.

Smallest hardening to investigate: publish a durable reset generation/strip-ID
fence usable by LKG admission before clearing reactive recovery or accepting any
fallback. Clear recovery only after the replacement is admitted and durably
captured. Add a pause/crash seam after native reset return but before host slot
invalidation, with real already-stripped native output, and inspect replay after
restart and module failure. Do not claim this ordering is atomic merely because
the native core commit is atomic.

## R3-H1 — exact stored units are not exact last-served bytes

The trigger compares sorted key/payload pairs for m0/m1/mural in the candidate
core with the **loaded** core (`transform.rs:6923-6928,15355-15365`). This is much
better than treating every HARD as a head rewrite. The author's bootstrap-seed
case preserves thinking when those units recompose identically.

It does not answer the stricter question: did the bytes **last served** change?
Deleting m1 removes one side of that comparison, even if re-rendering regenerates
exactly what the last serve contained. The new witness makes no new historian
publication, performs three signed tool steps, saves the complete served head,
removes only cached m1, and re-runs:

```text
review_r3_identical_served_head_after_missing_m1_must_not_reset ... FAILED
r3 H1 identical rebuild: head_same=true reset=true
reasoning_before=3 reasoning_after=0
loss of cached m1 reset thinking even though served head bytes are identical
```

The first assertion is equality of the actual synthetic served messages, not
cached payloads or an action label. It passes; the no-reset assertion fails.
Hence the comparison really loses all three blocks for no served-head change.
Discarded frozen-cache sections and a first synthetic-head render similarly
provide no intact cached baseline;
those are plausible variants, not additional executed false-positive proofs.

**Smallest fix:** compare the rebuilt served-head identity against a durable
last-served head fingerprint independent of the replaceable cached sections.
Do not use a digest of the already-damaged cache as that identity. If the former
serve is genuinely unknown, fail closed or explicitly classify the reset as a
conservative unknown-prefix repair; do not describe it as proven byte divergence.
A missing-m1 case with a pending publication must still reset, as the existing
r2 witness and R1 control establish.

## R3-M1 — signed subagent loops are still over-window

The reset unit construction and signed-turn wall guard both explicitly exclude
subagents (`transform.rs:5235-5257,7733-7739`). Their reductions-only branch carries
no strip units and does not build m0/m1. Not building m0/m1 prevents primary head
rewrites; it does **not** exempt a worker's signed tool loop from context limits.

The new witness builds 22 large tool results, then another signed assistant that
binds all 22. It verifies each result ID is in
`active_thinking_prefix_edit_ids`, queues all of them, removes protected-tools
count settings, and supplies 95% usage plus trusted over-limit final-wire evidence.
The last result is tiny and cannot recover the excess:

```text
review_r3_subagent_signed_tool_loop_at_wall_must_fit_or_refuse ... FAILED
r3 subagent: action=SOFT reset=false tool_tokens=104122
pending=22 reasoning=23
subagent returned at least 104122 tool-result tokens against 100000
instead of fitting or refusing
```

The separate protected-tool-results refusal does not help: these are
thinking-prefix-protected targets, not count-protected tools
(`transform.rs:7692-7723`). The healthy host's outgoing check likewise requires
protected-tools mass itself over the wall (`emergency-fail-closed.ts:56-89`).
No provider dispatch was performed.

**Rank: Medium, same as r2 M1, and relevant to the principal strict-binding tool
loop workload.** It is not a new signature-invalidating rewrite. It leaves the
fit-or-refuse guarantee incomplete for subagents. The smallest fix is to remove
the subagent exclusion from the **refusal** policy, returning `SignedTurnOverLimit`
when a trusted signed subagent serve is still over-window. Do not simply route
subagents through primary reset planning: that branch does not persist strip
units. Extending subagent strip persistence can be a later feature; refusal
requires no primary m0/m1 or strip machinery.

## R3-M2 — text-only refusal is not whole-request admission

`served_text_token_lower_bound` counts plain text, reasoning text and text tool
results, but deliberately omits tool-call inputs, media, system prompt and tool
schemas (`transform.rs:15367-15387`). Above-limit text can be a useful non-fit
signal. Below-limit text is **not proof that the request fits**.

The new tool-call witness uses a large `content` argument, then another signed
assistant that binds that call. Against a 100,000-token wall, it supplies trusted
120,000-token final-wire evidence and 95% usage. It runs both an ordinary held
pass and a missing-m1 pass that forces H1's reset. It measures only served
serialized tool-call arguments, not the JSON size of the whole conversation:

```text
review_r3_signed_tool_call_input_over_window_must_fit_or_refuse ... FAILED
r3 tool-input force_reset=false: action=SOFT+ reset=false
input_tokens=135947 reasoning=2
r3 tool-input force_reset=true: action=HARD reset=true
input_tokens=135947 reasoning=0
returned tool-call input tokens alone over 100000 instead of fitting or refusing:
[(false, 135947), (true, 135947)]
```

The second case specifically contradicts “if the reset still doesn't fit, it
refuses.” The reset itself is complete; there is no signature left to invalidate.
The surviving arguments are the non-fit content, and the new guard never counts
them. These are counts from the same vendored Claude estimator used by the
implementation, **not measured provider billing tokens**.

**Rank: Medium.** The former over-window behavior predates the reset work; the new
refusal still does not implement the broader guarantee. Smallest fix: include
served tool-call arguments in the post-transform non-fit estimate and add this
case to reset-or-refuse coverage. For the stated unconditional “never sent over
the window” rule, an authoritative full final-wire fit/admission check is also
necessary: extending a lower-bound counter still cannot prove fit for omitted
schemas, system prompt or media. Keep this separate from the signed-prefix freeze;
lifting that freeze is not safe pressure relief.

## M1 evidence quality and false-positive limits

The native M1 check is armed only for a primary, prefix-bound open signed turn,
force band or `Emergency95`, positive hard limit, and `final_wire_trusted`
(`transform.rs:7733-7748`). The new gate witness supplies enormous irreducible
text in two configurations:

```text
review_r3_untrusted_or_below_force_evidence_cannot_reset ... ok
r3 M1 gate used=95000 trusted=false: no reset, signed prefix exact
r3 M1 gate used=66000 trusted=true: no reset, signed prefix exact
```

It compares the entire ordered prefix through the last retained reasoning block.
It intentionally does not require an unchanged suffix: valid tail-only relief is
allowed. Removing the trust gate makes this witness refuse immediately (own
control B). Ordinary pressure alone therefore does not cause this reset.

The host supplies `final_wire_trusted` from **`refusalGrade`**, not an arbitrary
numeric estimate used for admission (`rust-mode-transform.ts:3746-3752`, also
`4073`). The estimator distinguishes an estimate trusted to admit a fitting request from
one strong enough to justify refusing an over-limit request. For example,
the byte-bound path requires an envelope before marking an over-limit bound
refusal-grade (`final-wire-token-estimate.ts:375-417`). This is not a trusted
provider fitting-count API.

One additional ignored probe deliberately sends **inconsistent wire evidence**:
`final_wire_trusted=true`, `final_wire_input_tokens=80000`, 86% usage, and local
text above 100,000. It fails with `SignedTurnOverLimit`. This proves the native
check reads the boolean and local text estimate, not the trusted numeric value.
It does **not** reproduce a normal Rust-host request: that host does not mark a
fitting count refusal-grade. The red probe is retained as an API-hardening record,
not counted as a fourth demonstrated product defect.

Residual estimator risk: the vendored Claude BPE is deterministic and faithful
to the TS estimator, not a verified lower bound for every current provider/model
(`mc-tokenizer/src/lib.rs:1-19`). Omitting envelopes does not make every text BPE
count a mathematical provider lower bound. A refusal-grade ingress can be made
smaller by a transform, and the remaining local text count can still overestimate
its provider token count. I did not contact a provider or produce a calibrated
post-reduction example proving that false positive. The appropriate remaining
check is an independent provider/count oracle for the **served** representation,
not the synthetic fitting-count probe. Unknown or ordinary pressure by itself
was defended by the executed trust/force gates.

## Drivers and unheld parity

The full native library gate includes the six ordinary `review_r2_*` regressions:
tail prefix/release, floor release, render identity, native serializer/host
fixtures, genuine rewritten head and the large-result wall case. All pass.
The rejected drop-only rule remains ignored: plain drops ride a later bust and
do not originate one; this review does not revive that rejected r2 expectation.

I explicitly reran the extended driver test from round 2: **1,531 passes**, 1,200 held,
91 releases, 65 releases with work, 68 pressure and 15 idle events, with **zero**
in-turn head rewrites. The new r3 test reruns the original 70-step and extended
240-step driver shapes with six **new seeds per shape** (the file records them,
XORed with the shape's step count):

| Shape | Passes | Held | Releases | Releases with work | Pressure | Idle | In-turn head rewrites |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Round-1 shape, 70 steps | 433 | 363 | 13 | 11 | 18 | 4 | 0 |
| Extended shape, 240 steps | 1,529 | 1,206 | 89 | 61 | 49 | 23 | 0 |

The unheld golden assertions remain the committed **`dda49e3850` goldens**, not
values regenerated from this implementation. The round-1 six-configuration test
compares 372 passes across unbound thinking and bound/non-signed primary and
subagent sessions. The author's four-configuration test compares 224 passes
plus a 28-pass deterministic repeat. Both pass. This is sampled byte parity for
those ordinary sessions, not universal equivalence over corrupted caches,
new reset cases, or every seed. The new seeds above extend the **held** drivers;
no new unheld golden values were invented.

## Mutation controls

Control identities came from the implementation author's `d2814a4209` delivery:
R1/R2/R3/R4/R5 for the engine, T1/T2/T3 for the host. I reran the requested
**R1, R2 and T1**, then added two review controls, **A and B**. Each run selected exactly one named
test, so there were no collateral failed tests. All five controls reddened.

Each deliberate code break was marked `NON-VACUITY BREAK` so it could not be
mistaken for implementation code. These controls show that the tests really fail
when the behavior they defend is disabled. I staged the specific live files
(including temporary witness registration), confirmed an empty `git diff --stat`,
applied the mutation, captured its non-empty stat, ran the check on Linux, then
used `git checkout -- <mutated-path> && touch <mutated-path>` and captured an
empty stat. No mutation or temporary registration remains in the delivered tree.

| Control | Mutation | Exact red test (module prefix omitted for Rust) | Applied / restored stat |
| --- | --- | --- | --- |
| Author R1 | Replace the head-unit inequality with `false` | `review_r2_witness_rewriting_head_cannot_keep_signed_thinking`: genuinely changed head retains active signature | `transform.rs`: 2 lines, `1+ 1-` / empty |
| Author R2 | Replace the served-text-over-wall predicate with `false` | `review_r2_witness_signed_loop_over_window_must_fit_or_refuse`: SOFT keeps at least 104,107 tool-result tokens | `transform.rs`: 3 lines, `1+ 2-` / empty |
| Author T1 | Remove reset permission from `moduleBustStrips` only | `Rust host thinking strips with real engine output > a reported reset strips thinking the module output still carries (healthy)`: a2/a4/a5/a6 remain | `transform-postprocess-phase.ts`: 2 lines, `1+ 1-` / empty |
| Review A | Delete reset `reasoning_age` units immediately before commit, after building the stripped output | `review_r3_reset_replays_original_ingress_after_restart_and_next_turn`: durable ID set empty instead of a4/a6/a8 | `transform.rs`: 4 lines, `4+` / empty |
| Review B | Replace the signed-turn fit guard's final-wire trust predicate with `true` | `review_r3_untrusted_or_below_force_evidence_cannot_reset`: untrusted pass returns `SignedTurnOverLimit` | `transform.rs`: 5 lines, `1+ 4-` / empty |

Review A ran before the persistence witness was strengthened with an older signed
assistant and a redacted block. The final version still checks the durable set,
now a2/a4/a6/a8, and passes. The mutation did not omit strips from planning (the
author's R5); it deliberately severed **serve versus persistence**, after output
construction. Review B makes the valid unknown-evidence gate fail, rather than
relying on the intentionally inconsistent fitting-count witness.

## Gates and environment

Cargo/tests/clippy and Bun checks ran on the remote Linux runner with eight
vCPUs per command (**`runon: linux,8c`**). Versions:
cargo/rustc **1.99.0**, clippy **0.1.99**, rustfmt **1.10.0-stable**, Bun **1.4.2**,
TypeScript **5.9.3**. The pre-existing worktree preparation also reported
`bun run build` successful; it is not substituted for this review's gates.

| Command/check | Result |
| --- | --- |
| `cargo test -p mc-module` with temporary r3 inclusion | library **1,736 passed, 32 ignored**; caveman/ordinary integration targets **15 passed** total; `real_daemon` **1 passed, 4 failed, 2 ignored** |
| `cargo test -p mc-module --lib -- --ignored review_r3_ --nocapture` | **4 passed, 4 failed**: H1 exactness, subagent wall, tool-call wall, and deliberately inconsistent fitting evidence; only the first three are product findings |
| Strengthened final persistence witness, isolated | **1 passed**: 4 strip units, 5 reasoning/redacted blocks; reopen/next-turn replay and new thinking covered |
| `cargo test -p mc-module --lib -- --ignored review_r2_randomized_new_seeds_three_times_the_passes --nocapture` | **1 passed**, 1,531 passes |
| `cargo clippy -p mc-module --all-targets -- -D warnings` | passed for mc-module all targets, including temporary registration of all eight final witnesses |
| `cargo fmt -p mc-module --check`; direct `rustfmt --edition 2021 --check .../signed_prefix_hold_review_r3.rs` | passed; included review files are checked directly |
| `bun test .../rust-mode-frozen-defects.test.ts` | **35 passed**, 184 assertions |
| Temporary `review r3 reset LKG` host probe | **1 passed**, 15 assertions, three modes |
| `bun test .../emergency-fail-closed.test.ts .../latest-thinking-recovery.test.ts` | **13 passed**, 52 assertions |
| `(cd packages/plugin && bun run typecheck)` | passed, including the temporary host replay/restart probe; tsc 5.9.3 |
| Scoped AFT diagnostics for the new Rust file | 0 errors/warnings; header partial for unavailable call-graph categories, not Rust diagnostics |

The four real-daemon failures are at `tests/real_daemon.rs:1098`, canonicalizing
an absent sibling `subconscious` checkout on the Linux runner. They match the
round-1/2 environment limitation. They are not reset failures or successful
real-daemon verification. No daemon test ran on this Mac. All executed stores
were throwaway SQLite stores or host harness in-memory databases.

## Reproducing the report-only probes

In a disposable checkout, temporarily append this after the already-registered
r2 review include in `transform.rs`'s test module:

```rust
include!("tests/signed_prefix_hold_review_r3.rs");
```

Run:

```sh
cargo test -p mc-module --lib -- --ignored review_r3_ --nocapture
cargo test -p mc-module --lib review_r2_ -- --nocapture
cargo test -p mc-module --lib -- --ignored review_r2_randomized_new_seeds_three_times_the_passes --nocapture
cargo clippy -p mc-module --all-targets -- -D warnings
rustfmt --edition 2021 --check crates/mc-module/src/tests/signed_prefix_hold_review_r3.rs
```

Expect four passing and four failing r3 tests at the reviewed tip, with the deliberately
inconsistent fitting-evidence probe distinguished from the three product findings.
Remove the temporary include afterward. The final restored product tree was
also checked separately: `cargo test -p mc-module --lib review_r2_ -- --nocapture`
passed **6 tests, 2 ignored**; isolated `review_unheld_sessions_match_the_code_before_the_hold`
and `signed_prefix_hold_leaves_unheld_sessions_byte_identical` each passed.
The r2 wall replay now reports **104,122 before, 45 after, zero pending drops**,
with the same head. The six unheld digests exactly match their committed goldens.

The temporary host LKG/restart check is reproducible by appending this to the
existing `rust-mode-frozen-defects.test.ts`, whose helpers and fixtures it uses:

```ts
it("review r3 reset LKG replays and restarts without resurrecting reasoning", async () => {
    for (const mode of ["healthy", "reactive", "frozen"] as const) {
        const { s, input, after } = await runSignedThinkingFixture(
            `r3-reset-restart-${mode}`,
            signedThinkingFixtures.rewrite,
            mode,
            "HARD",
        );
        expect(reasoningIds(after)).toEqual([]);
        const replay = (await s.run(input, "throw")) as MessageLike[];
        expect(reasoningIds(replay)).toEqual([]);
        expect(JSON.stringify(replay)).toBe(JSON.stringify(after));
        s.restart();
        const restarted = (await s.run(input, "SOFT+")) as MessageLike[];
        expect(reasoningIds(restarted)).toEqual([]);
        expect(JSON.stringify(restarted)).toBe(JSON.stringify(after));
    }
});
```

Run `bun test packages/plugin/src/hooks/magic-context/rust-mode-frozen-defects.test.ts -t 'review r3 reset LKG'`
and the plugin's `bun run typecheck`, then remove the temporary test. This proves
replay **after a completed reset**, not interruption in the native/host capture gap.
