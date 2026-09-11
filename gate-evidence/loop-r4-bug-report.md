# LOOP round 4 — one correctness bug

## TITLE
Frozen reasoning cutoff is not a frozen applied set: losing the newest-assistant exemption first-clears old reasoning on a DEFER pass.

## LOCATION
`crates/mc-module/src/transform.rs:11534–11544` (`apply_surface_strips`), with the same moving-exemption predicate at `13930–13950` (`clear_served_native_reasoning_from_iter`). The cutoff producer is `13766–13785`; the exemption selector is `13702–13713`.

## TRIGGER
OpenCode Rust mode, `opencode-aisdk`, canonical Anthropic, native serving enabled. Use a supported `clear_reasoning_age=10` (schema minimum: `packages/plugin/src/config/schema/magic-context.ts:1171–1175`). A signed assistant response A is followed by a user message with enough separately tagged text parts to put A below `maxTag - clear_reasoning_age`, but there is not yet a newer assistant. A HARD pass occurs (the reproducer changes render_config). Then a newer signed assistant B arrives and the next transform is an otherwise ordinary low-pressure DEFER.

The reproducer uses a user message with 13 text parts, 10% reported usage, no historian publication, no reductions, no force, and no TTL expiry. A has tag 2; the HARD freezes cutoff 5. Restart the store between HARD and DEFER. This is not dependent on the restart: restart simply proves the durable-state path. For the default age 50, the same condition requires more later tags; the defect is not specific to age 10.

## WRONG BEHAVIOR
The HARD serves A's original `thinking-old` with `signature-old`. The DEFER (`action=SOFT+`, `materialize_reason=None`) rewrites that *already served* reasoning block to an empty, unsigned reasoning sentinel. Native OpenCode encoding changes too. A new response thus causes a second prefix rewrite despite unchanged persisted cutoff and no bust permission. This creates an unpriced prompt-cache prefix invalidation, not just a changed diagnostic.

## MECHANISM (traced)
1. The HARD captures `maxTag-age` through `reasoning_clear_cutoff_with_tags` (`13766–13785`) and persists it in `meta.reasoning_cleared_through_tag` (`4561–4567`). It captures the whole numeric cutoff, including A, even though A is currently exempt.
2. Rendering recomputes the newest-assistant exemption from this request (`13702–13713`, passed into rendering at `13303–13304`). On the HARD, A is newest, so `!reasoning_policy.exempt` is false. A remains intact even though its tag is already at/below the persisted cutoff.
3. On the next request B becomes newest. The plan is DEFER, so `is_bust_pass` is false (`4502–4506`) and there is no new cutoff. Nevertheless `apply_surface_strips` runs (`13448–13460`), finds A aged (`11514–11515`) and now non-exempt, and first-clears its text/signature (`11534–11544`). That consumer does not test bust permission or durable per-message application evidence.
4. The native-serving finalizer independently repeats the same mistake: it derives the newest assistant from *current* ingress (`13895–13909`) and authorizes clearing solely by `age_number <= watermark` plus not-newest (`13930–13950`). Fixing only the CK rendering predicate would leave this second consumer able to first-clear later.
5. The existing cutoff regression passes because its exempt newest assistants are above the cutoff. Its fixture never exercises an exempt assistant already inside the captured cutoff. This differs from the previously fixed R0 reasoning-cutoff drift: here the cutoff demonstrably does **not move**; the exemption does.

## REPRODUCING EVIDENCE
Uncommitted reproducer: `.cortexkit/alfonso/loop-r4-reasoning-repro.rs`.
Captured output: `.cortexkit/alfonso/loop-r4-repro-output.txt`.

To rerun, copy the reproducer to `crates/mc-module/tests/loop_r4_reasoning_repro.rs`, run `cargo test -p mc-module --test loop_r4_reasoning_repro -- --nocapture`, and remove that temporary integration-test copy afterward. Cargo may refresh the workspace lock entry for the installed local subc-core dependency; that incidental lockfile change was restored after this investigation.

Actual run (exit 101; only `exempt_reasoning_first_clears_on_defer` failed):

```
bootstrap=HARD cutoff=5
hard=HARD cutoff=5 target=...signature-old...thinking-old...
next=SOFT+ reason=None cutoff=5
first_divergence: old#0 -> old#0, ContentChanged, approx_token_depth=62
target=...{"text":"","type":"reasoning"}...
assertion `left == right` failed: a defer must not first-clear previously exempt reasoning
```

The same test first checks that a restarted, unchanged request is SOFT+ and byte-identical for A; that control passes. It then appends only B and fails the target-byte equality assertion. Both native encodings are captured in the output. No production mutations or mocks were used.

Existing regression check: `cargo test -p mc-module --lib reasoning_cutoff_batches_on_one_fold_and_survives_restart` — passed, 1 test. An earlier `--exact` invocation selected zero tests and is not counted as verification.

## FIX SHAPE (not implemented)
Freeze first-application eligibility, not only a numeric age watermark. Persist the actually authorized message/block IDs, or durably exclude the HARD pass's exempt messages until another independently busting pass admits them. Both CK rendering and native finalization must consume that same durable decision. Preserve existing applied clears on every replay and preserve signed reasoning while it is exempt. Add the HARD → identical restart DEFER → new-assistant DEFER regression; require a later authorized bust to apply the newly eligible clear.

## BLAST RADIUS
Proven on canonical-Anthropic OpenCode Rust/native serving. Sessions where later user/text/tool-tag growth puts the latest signed assistant below the age cutoff are affected. A minimum-age configuration makes this easier; sufficiently large later tagged input also reaches it at defaults. No claim that all profiles or the TS/Pi engines share this defect. No code fix made.

## CONFIDENCE
99/100. Executed against the real store and public transform API; verified unchanged cutoff, DEFER classification, exact target-byte change, native encode change, restart behavior, and the existing regression's blind spot. The report does not claim a measured billing loss from a live provider request.

## SCOPE CHECK
Read the required 2026-09-05/2026-09-09 ledger sections and parity-hunt commit exclusions. Rotated off the R2/R3 caches. Traced Rust independent/supersession bust permission, selection, TS postprocess gates, and the #56 model-floor/clear paths before narrowing to this moving-exemption defect. Exactly one finding is reported. Tracked production files remain unchanged.
