# Review: signed-prefix hold as one shared permission (issues 665 and 664)

Commit under review: `7fe8bc66` ("hold active thinking passes behind one prefix
permission"), base `fdb4253a`. This is an independent cache-safety review. The
only change it adds is two OpenCode postprocess tests; it changes no product code.

## Verdict

The TypeScript change does what it claims for the case in issue 665. On OpenCode
and Pi, a pass held below the force band now changes nothing in the served
prefix. The queued work stays queued and is applied by the next unheld pass.
Below the force band the permission is the old one ANDed with the hold. At or
above the force band it reduces exactly to the `fdb4253a` expression, so
pressure relief is no weaker than before.

Five open items are below, most severe first:

- The Rust transform still lets a held pass rewrite the prefix: its signed-thinking
  hold disables only history materialization, while other inputs still authorize
  a bust (High, out of the commit's scope).
- The OpenCode force-band exception was undefended by every test (Medium).
- The unresolved-session-directory hold, which used to freeze only the
  m[0]/m[1] memory and history prefix, now also blocks drains and cleanup. That
  can stop routine reclaim for as long as directory lookup keeps failing
  (Medium).
- Some unheld Pi passes changed behaviour, in the cache-safe direction (Low).
- A carried-over Pi identity rebuild is acknowledged on a held pass without
  clearing the cached m[0]/m[1] prefix pair, which that rebuild declared it
  would do (Low).

## Gates run (Linux, `linux,8c`, build in the same job)

| Gate | Result |
| --- | --- |
| `bun run build` (Bun 1.4.2) | exit 0 |
| `bun run typecheck` (tsc 5.9.3; plugin, pi-plugin, cli, retina-local-fs) | exit 0 |
| `bun run --cwd packages/plugin lint` / `packages/pi-plugin lint` (Biome 2.5.1) | exit 0 (warnings only; 1378 files in plugin) |
| Plugin suite at `7fe8bc66` | 7714 pass, 27 skip, 1 fail of 7742 |
| Pi suite at `7fe8bc66` | 1982 pass, 28 skip, 0 fail of 2010 |
| `transform-postprocess-phase.test.ts` with the two review tests | 272 pass, 0 fail |

The one plugin failure is `Node WASM Transformers fixture > builds with real fs
and persists a model for offline reuse`. Its temporary bundle cannot resolve
`onnxruntime-web/webgpu`. The commit's own report describes the same failure,
and it is unrelated to the hold.

Not run:

- Real-host differentials on OpenCode 1, OpenCode 2 and Pi. The committed
  OpenCode 2 host test needs an OpenCode 2.0.26 CLI, and none is installed in
  this checkout. No host process was started, so no live store was touched and
  no throwaway root was needed.
- Rust tests. No Rust code changed.

## Findings by severity

### High: the Rust transform still busts inside a held signed turn (not fixed)

The TypeScript bug was that the hold and the bust permission were separate:
the hold froze m[0]/m[1] while other lanes still rewrote the prefix. The commit
report (`docs/reports/active-thinking-prefix-hold/README.md`) says Rust has the
same separation, and this review confirms it. In
`crates/mc-module/src/transform.rs`:

- `protected_signed_prefix` (lines 5208-5211) only clears
  `prefix_materialization_enabled`.
- Several rides bypass it:
  - `loaded.meta.soft_refresh_pending` is ORed into `independent_rebuild`
    outside that gate (line 5294).
  - `force_episode_available` and `Emergency95` feed
    `supersession_ride_available` (lines 5296-5301).
  - `reductions_pending_now` alone is a `bust_opportunity` (line 5521).
  - `hard_fold_requested` goes to `classify` unconditioned (line 5587).
- When any of these is set, `classify` can select `Soft` or `Hard`.
  `is_provider_prefix_mutation_pass` and `is_bust_pass` (lines 5800-5807) then
  follow the plan, and the strip, caveman, reasoning, todo, temporal and
  pending-reduction lanes all open.

A Rust-mode session with a queued `ctx_reduce` drop therefore still pays the
issue-665 double bust: once mid-loop, and again at the next user turn.

Smallest correct fix: veto the inputs to classification, not its output boolean.

1. Define the hold once:
   `let signed_prefix_hold = protected_signed_prefix && !force_band_active && scheduler_outcome.pass != scheduler::PassDecision::Emergency95;`
2. AND `!signed_prefix_hold` into each of these:
   - the `soft_refresh_pending` term of `independent_rebuild`;
   - `bust_opportunity` (the `reductions_pending_now` ride);
   - `non_tool_bust_opportunity`;
   - the `hard_fold_requested` and `m1_revision_changed` fields passed to
     `classify`.
3. Keep the render-correctness HARDs that have no frozen bytes to replay:
   uninitialized or bootstrap, missing cached m1, `cache_sections_discarded`,
   `lineage_state.force_hard`, and the legacy baseline.

`soft_refresh_pending` and the pending reductions are already persisted, so the
next unheld pass picks them up. Changing only `is_bust_pass` would serve Soft or
Hard bytes while reporting a defer. The commit report warns against that, and
that warning is correct.

A regression test should be a Rust transform test with a prefix-bound model, an
active thinking turn, a queued reduction and `soft_refresh_pending`, at 66%
context usage (above the 65% execute threshold, below the 85% force band). It
expects `PassPlan::Defer` with byte-identical output, then one `Soft`/`Hard` on
the next user turn.

### Medium: the OpenCode force-band exception was undefended

The exception is `|| emergencyDropEligible` in
`transform-postprocess-phase.ts:2294`. Replacing it with plain `!freezeM0M1`
reddened none of the 377 tests in `transform-postprocess-phase.test.ts`,
`transform.test.ts` and `transform-degraded-pass.test.ts`. All of the commit's
lane controls run at 66%. The added review test
`signed-prefix hold review > a held pass at the 95% wall still admits the shared drain`
is the only test that goes red (see Mutation evidence).

On Pi, the matching mutation
(`prefixMutationAllowed = !protectedSignedPrefix`) reddens only one test in the
whole Pi suite. That test is the trim-only force strip test, `Pi proactive strip
of invalidated thinking > "Remove thinking blocks from the start of the history"
is valid, ...`, and the commit itself rewrote its fixture. So the Pi exception
is defended, but only indirectly.

### Medium: the directory-fallback widening can stop reclaim indefinitely

In `transform.ts:1182-1200`, `unresolvedDirectoryHold` now sets `freezeM0M1`,
and `freezeM0M1` now denies the drain, heuristics, age sweep, synthetic todo and
proactive strip below the force band. `sessionDirectoryFellBack` is a per-pass
value: the fallback is deliberately not cached, so each pass retries the lookup.
Nothing else releases the hold. If the lookup keeps failing for a session that
has a cached pair and a recorded project identity:

- `/ctx-flush`, deferred execute-threshold materialization and queued
  `ctx_reduce` drops all stay pending, turn after turn, until usage reaches 85%.
  The m[0]/m[1] fold was already frozen in that state before this commit.
- The only signal is one log line per turn.

Is it safe? It is cache-safe: no held pass busts, and the force band still
relieves pressure, so growth is bounded. It is wider than the hazard the
directory hold exists for, though. That hazard is rendering memory and docs from
the wrong project into m[0]/m[1]. Tool drops and heuristics do not depend on the
directory.

For a transient lookup failure, the widening saves one bust. For a persistent
one, it stops routine reclaim and makes explicit flushes silent no-ops.

Options:

- Release the directory hold for drains on an explicit flush.
- Cap the hold at one user turn.
- Keep the widening, but surface it to the user rather than only in the log.

### Low: unheld Pi passes are not strictly byte-identical to `fdb4253a`

Three Pi lanes previously used `isCacheBusting || executedWorkThisPass` as their
permission, and now use `result.prefixBustPermitted`
(`context-handler.ts:5405`, `:5498`, `:5586-5591`):

- sticky-anchor GC;
- synthetic todo injection;
- the full-bust permission for the proactive strip.

In an unheld session the two values differ in one case. That case is a
history-refresh pass (`args.isCacheBusting`) whose m[0]/m[1] preflight was
contended, so `publishedHistory` is false, and no other reclaim ride (fold,
force, explicit flush) authorizes a rewrite:

- `fdb4253a` injected or moved the todo pair, ran GC, and gave the strip
  full-bust permission.
- `7fe8bc66` does none of these.

The new behaviour is the cache-safe one: the contended pass replays the cached
pair, so the old behaviour rewrote the prefix even though nothing else in that
pass invalidated the provider cache. But it is
an undocumented change for unheld sessions, and no test pins it.

The OpenCode unheld paths are byte-identical. Unheld, `freezeM0M1` is false, and
the permission and heuristics expressions reduce to the base expressions.

### Low: a carried-over Pi identity rebuild is acknowledged on a held pass

`adoptPiFallbackTags` returns persisted `tag-identity-repair-pending` records
whatever `deferUnprovenRebuild` says (`context-handler.ts:3355-3361`). On a held
pass carrying such a record, this happens:

1. `identityRebuild` is true.
2. `isCacheBustingPass` stays false, and `clearM0M1PiCache` is skipped
   (`:8153-8168`).
3. The result still reports `identityRebuilt: true`.
4. The outer handler sets `schedulerDecision = "execute"` (`:5240`) and
   acknowledges the rebuild after a committed serve (`:5992-5997`).
5. `bustedThisPass` and the calibration reason record a tag-identity bust
   (`:9690-9702`).

When the folding pass was served and only its acknowledgement failed, this is
better than the base: the base re-cleared m[0]/m[1] mid-loop. The bad case is
when the fold was committed but never served:

- the held pass serves the folded numbers, which is a prefix change on a held
  pass;
- it retires the declared rebuild without the m[0]/m[1] clear that rebuild
  declared.

Reaching this case needs a fold that was committed but not served, followed by a
held pass. That requires a force-band fold followed by a drop below the band, or
a write failure. The window is narrow, and no test covers it.

### Low: a held pass that busts anyway still holds its riders

Two kinds of held pass rewrite or lose the prefix regardless of the hold:

- `firstRenderBust` (no cached pair to replay);
- an idle-expired retry (provider-cold).

On those passes the drain, heuristics, todo and strip still wait, so the queued
work costs a second bust at the next user turn. The commit hit this in the Pi
trim-only force test and moved that fixture's first render outside the held
turn. On prefix-bound models most of those riders are also vetoed per target by
thinking protection (`protectNewTagMutations`). So the extra cost is mostly the
oldest-prefix thinking strip and post-thinking tool results. This is
intentional, but the README does not document it.

### Low: the force band inside a held turn can still repeat the issue-665 pattern

Between 85% and 95%, with a prior emergency sample, the hold lifts for any ride:
an explicit flush, or deferred materialization, which
`runPostTransformPhase` (`transform-postprocess-phase.ts:2259-2263`) re-arms on
execute passes with thinking-protected ops. m[0]/m[1] stays frozen (fold gated
by `!freezeM0M1`). On prefix-bound models, per-target protection vetoes every
drop before the active turn's last signed block. So such a pass can bust while
freeing little, and then bust again at the next user turn. This is identical to
`fdb4253a`, so it is not a regression. It falls short of issue 665's "only when
close to the hard limit" expectation only in this band.

On "never sent over the limit": the hold adds no new path to sending over the
limit. Above the force band its permission is the base permission. The commit
does not touch the overflow guard.

### Info

- **Issue 664 log.**
  - It names the real reason and fires once per user turn per session
    (`transform.ts:1562-1578`).
  - When both reasons hold, it names only active thinking.
  - The `prefixHoldLogTurnIds` map is never pruned on session deletion. That
    costs one entry per session.
  - With a null `currentTurnId`, it logs once until a turn id appears.
- **Issue 650 rule** (a tag-identity conflict never refuses more than one
  turn). The rule is kept.
  - A held pass serves an ambiguous identity unmerged: `plan()` returns null
    before any claim or recurrence write (`context-handler.ts:3401-3403`).
  - The repair is not spent, and nothing is refused. The first permitted pass
    then performs the one declared repair, as shown by the commit's test
    `held unproven tool repair waits for a permitted prefix rebuild`.
  - The deferral spans passes within one turn and never refuses, so "a
    tag-identity conflict never refuses more than one turn" still holds.
- **Auto-search.** The master change that freezes each user message's
  auto-search decision once served (`81f21d39`) is not in the history of the
  hold commit (`7fe8bc66`). `git merge-tree` merges the two cleanly. Behaviour
  at the hold commit and after the merge:
  - A pass is held only when signed thinking follows the latest real user
    message. So the latest user message is never the live array tail on a held
    pass.
  - `runAutoSearchHintForPi` computes new decisions only for the live tail
    (`auto-search-pi.ts:346`). Skipping it on a held pass therefore records no
    no-hint decision and adds no hint to a served message.
  - Persisted hints still replay on held passes through `applyNoteNudges`
    (`context-handler.ts:10013-10025`), which this gate does not cover.
  - After the merge, `retryUnpublishedAutoSearchNoHint` is not retried during a
    held loop. Its omission stays in memory, and no later pass can hint a
    message that is no longer the tail. That is a lost retry, not a byte risk.
- **Model switches and restarts.** The hold is recomputed every pass from the
  messages and the active turn's model, so it survives a restart. A model switch
  arrives with a new user message, which ends the turn. Only the once-per-turn
  log state is in memory.

## Tests

Do the commit's mutation controls defend the property that a held pass never
changes the served prefix?

- The six OpenCode lane controls each assert full served-byte equality plus one
  lane observation, all at 66%. They defend "nothing below the force band
  changes the prefix".
- Because every variant asserts whole-array equality, they do not isolate
  lanes: a breach in any lane reddens all six.
- None of them covers the force-band exception, randomized held sequences, or a
  multi-pass loop.

Added in this commit, both in
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.test.ts`:

1. `signed-prefix hold review > a held pass at the 95% wall still admits the shared drain`.
   A held prefix-bound turn at 96% with a queued flush must call
   `applyPendingOperations`.
2. `signed-prefix hold review > a randomized held tool loop serves one byte sequence, then one release applies the queue`.
   The test runs 24 seeded held passes at 20-83% with random execute
   crossings, flush requests, deferred-materialization requests and newly
   queued drops. Each pass must:
   - serve the baseline bytes;
   - strip no thinking;
   - leave every queued op pending.

   One unheld pass must then drain the whole queue and change the bytes.

## Mutation evidence

Each mutation below followed the same procedure:

- The index first held the live implementation, and `git diff --stat` was empty.
- With the mutant applied, `git diff --stat` was non-empty.
- After `git checkout -- <path> && touch <path>`, it was empty again.

| Mutation | Red | Green |
| --- | --- | --- |
| `transform-postprocess-phase.ts:2294`: drop `\|\| emergencyDropEligible` | review test 1 only (expected 1 call, received 0); across 379 tests in the three hold files, only that one fails | the 6 commit lane controls, review test 2 |
| `transform-postprocess-phase.ts:2294`: restore the base permission `!compactionOff && hasReclaimRide(rideSignals)` | review test 2 (byte mismatch at step 1) | review test 1 |
| `context-handler.ts:8040`: `prefixMutationAllowed = !protectedSignedPrefix` | the Pi trim-only force test only (1981 pass, 1 fail) | the rest of the Pi suite |
