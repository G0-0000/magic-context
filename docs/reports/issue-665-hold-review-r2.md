# Second review: the issue 665/664 hold revision (OpenCode 1, OpenCode 2, Pi)

Revision under review: `71fa3bbd` and `a6fef1a3`, on top of the first review
`62fa1e27` (`docs/reports/issue-665-hold-review.md`). This is a cache-safety
review only. It adds two randomized multi-pass drivers, focused ruling tests, a
differential script and this report. It changes no product code.

Strict-binding semantics used throughout: on Claude Fable 5.1 and Opus 5.5, a
signed thinking block stays valid only while every byte before it is unchanged
(`docs/reports/anthropic-thinking-binding.md`). Removing or editing anything in
front of a kept signed block, including an older block's thinking, invalidates
it, which costs an HTTP 400 on newer accounts and a silently dropped block on
older ones.

## Verdict

The revision fixes what the first review asked for, and held passes are now
byte-identical on all three hosts. The cost is that its new "riders on passes
that rewrite the prefix anyway" rule breaks strict binding on those passes, and
Pi's carried identity repair still re-renders m[0]/m[1] while signed thinking is
kept.

| # | Severity | Finding | Hosts | New in the revision? |
|---|---|---|---|---|
| H1 | High | On a held first-render or idle-expired pass, riders edit bytes in front of the kept signed thinking: the older-thinking strip on all hosts, and on Pi also queued drops and cleanup | OC1, OC2, Pi | Yes. OC: 0 breaks at `62fa1e27`, 72 at HEAD. Pi: 35 → 63. |
| H2 | High | Pi: a carried identity repair that is still pending when the hold lifts (idle expiry, force band, 95%) clears and re-renders m[0]/m[1] under kept signed thinking. This breaks the m[0]/m[1] ruling. | Pi | Idle: yes. Force band: the clear path already existed. |
| M1 | Medium | Pi: with no last-known-good prefix, or one whose fit cannot be priced, the carried repair takes the declared rebuild. That rebuild clears m[0]/m[1] and keeps the active signed thinking. | Pi | Changed (previously acknowledged without the clear) |
| M2 | Medium | Pi, unheld sessions: idle-expired passes now drain queued drops and run heuristics and the strip. Undocumented, and not the contended-preflight change. | Pi | Yes |
| L1 | Low | Issue 650 attack: if the declared rebuild's m[0]/m[1] clear keeps failing, the session refuses every pass across turns | Pi | Yes (`62fa1e27`: 0 refusals) |
| L2 | Low | OpenCode force-band ruling tests are not proven non-vacuous: two mutations that lift the freeze at ≥85% left them green | OC | test gap |
| I1 | Info | Rust parity: the same four unavoidable terms and the same held m[0]/m[1] inputs, but three differences (see Parity) | all | — |

The m[0]/m[1] ruling for all three hosts, checked explicitly: inside a signed
turn whose thinking is still served, an idle-expired pass replays m[0]/m[1]
byte for byte, and the force band (85%) and the 95% emergency may drain under
per-target protection but keep m[0]/m[1] frozen.

- **OpenCode 1 and 2: holds.** A held idle-expired pass replays the cached
  m[0]/m[1] pair. A held 86% or 96% pass also replays it. Evidence:
  - `freezeM0M1` (`transform-postprocess-phase.ts:2058`, `transform.ts:1203,1565`)
    has no idle or force exception.
  - Injection gets the frozen prepared pair with
    `isCacheBustingPass && !freezeM0M1` (`:3205-3224`).
  - The fold is gated on `!freezeM0M1` (`:2060`).
  - The ruling tests pass, and the drivers saw 0 m[0]/m[1] re-renders.
  - The idle test is proven non-vacuous. The force-band tests are not (L2).
- **Pi: holds unless a carried identity repair is pending.** With no repair
  pending, idle and force-band passes replay m[0]/m[1] (tests pass; the idle test
  is proven non-vacuous). With one pending, all three cases re-render m[0]/m[1]
  (H2), as do the no-LKG and unpriceable-LKG passes (M1).

## Gates (Linux runner, `linux,8c`, one job, build first)

| Gate | Result |
|---|---|
| `bun run build` (Bun 1.4.2) | exit 0 |
| `bun run typecheck` (tsc 5.9.3: plugin, pi-plugin, cli, retina-local-fs) | exit 0 |
| `bun run --cwd packages/plugin lint` (Biome) | exit 0, 1379 files checked, warnings only |
| `bun run --cwd packages/pi-plugin lint` (Biome) | exit 0, 304 files checked, warnings only |
| Plugin suite (`bun run --cwd packages/plugin test`) | 7752 pass, 27 skip, 1 fail of 7780 |
| Pi suite (`bun run --cwd packages/pi-plugin test`) | 2009 pass, 28 skip, 0 fail of 2037 |

The plugin failure is the unrelated, already-known `Node WASM Transformers
fixture > builds with real fs and persists a model for offline reuse`. Its
temporary bundle cannot resolve `onnxruntime-web/webgpu`. Both reviews and the
revision report the same failure.

Not run:

- The real OpenCode 2.0.26 host differential, and the revision's 17 mutation
  controls one by one. No host process was started. The package suites set their
  own temporary `XDG_DATA_HOME` and did not export `OPENCODE_DB`, so no live store
  was opened.
- Rust tests. No Rust code is in this branch; the parity check below reads
  `00bfed90` (`crates/mc-module/src/transform.rs`).

## Drivers and differential

- `packages/pi-plugin/src/issue-665-hold-review-r2.test.ts` drives the real Pi
  context handler.
- `packages/plugin/src/hooks/magic-context/issue-665-hold-review-r2.test.ts`
  drives the real `createTransform`, once with OpenCode 1 deps and once with the
  OpenCode 2 adapter's deps (`storeGeneration: "v2"`, a session-directory cache,
  no v1 compaction markers). The OpenCode 2 lane does not run the OpenCode 2
  message conversion.

A seeded generator mixes these events:

- tool steps on a prefix-bound model (`claude-opus-5-5`), each with signed thinking;
- user turns, some served alone as unheld release passes;
- queued `drop`s and execute crossings (20-84%), plus 86% and 96% passes;
- explicit flushes and history refreshes;
- session-directory fallbacks (OpenCode);
- idle expiry (13 h TTL, last response 14 h ago);
- a discarded cached pair, which gives a first render;
- restarts (new handler or transform, LKG slots cleared);
- on Pi: carried identity repairs (`queuePiIdentityRebuild`), some with the LKG
  dropped, and new historian compartments with their refresh signal, so that any
  m[0]/m[1] rebuild changes bytes.

After every pass the drivers check four things:

- **held-prefix-changed**: a held pass changed a message the previous pass served;
- **strict-binding**: a signed block served on both passes has different
  provider-visible bytes before it;
- **m0m1-rerendered**: the cached m[0]/m[1] bytes changed while signed thinking
  was kept;
- **refusal**: the pass threw.

Provider-visible bytes:

- Pi: role, content, tool-call id and name, error flag, and the assistant's
  provider and model. Envelope timestamps and usage are left out.
- OpenCode: id, role, error, providerID, modelID, and the parts through
  `providerVisiblePart`. Empty text and reasoning parts are left out, because the
  Anthropic adapter drops them.

`docs/reports/issue-665-hold-review-r2/differential.sh` runs the drivers at the
checkout and then with the four revised product files replaced by their
`62fa1e27` versions. `compare.py` diffs the two runs pass by pass (served hash,
pending count, tag statuses, refusal, cached pair). Final run: 8 seeds
(665, 664, 650, 1, 2, 3, 7, 8), 150 held passes and 320 passes per unheld
scenario. That is 15,360 unheld passes and 3,600 held passes across the three hosts.

| | Pi HEAD | Pi base | OC (1+2) HEAD | OC (1+2) base |
|---|---|---|---|---|
| held-prefix-changed | 0 | 0 | 0 | 0 |
| refusal | 0 | 0 | 0 | 0 |
| strict-binding | 63 | 35 | 72 | 0 |
| m0m1-rerendered | 14 | 0 | 0 | 0 |

Harness note: in the OpenCode driver, compartment events are off by default
(`R2_OC_COMPARTMENTS`). Resolving a compartment boundary reads the OpenCode
message store, which a unit harness does not have. With compartments on, both
`62fa1e27` and HEAD refused with `MC-H04` and showed raw-tail trims on held
passes. Those trims match between base and HEAD, and this report does not count
them as findings.

## Claims checked

1. **Directory fallback narrowed to m[0]/m[1]: holds.**
   - Every unheld OpenCode divergence from `62fa1e27` starts on a
     directory-fallback pass. That is 47 roots per host: 30 with a flush, 14 with
     idle expiry, 3 alone. That is the intended change: drains run again.
   - m[0]/m[1] stays frozen: 0 re-renders.
   - An explicit flush still stays pending while the lookup fails
     (`transform-postprocess-phase.ts:2961-2967`, `:3097`).
2. **Riders on unavoidable rewrites: they ride, but they break strict binding (H1).**
   - Held passes stay byte-identical (0 held-prefix-changed).
   - The rewriting pass itself edits bytes in front of the kept thinking.
3. **Pi carried repair: the LKG replay holds, the fallback does not (H2, M1, L1).**
   - With realistic host metadata (system prompt plus tool list), the held pass
     replays the last-known-good prefix with the new raw tail.
   - The repair stays pending and is not acknowledged.
   - Held passes are byte-identical across all seeds.
4. **Unheld contended preflight unchanged, with a pinned test: holds by reading.**
   - The revision did not touch that path, and its pinned test passes.
   - The differential does not simulate contention.
   - The other unheld differences are M2 (Pi idle expiry) and claim 1
     (OpenCode directory fallback).
5. **Hold-log pruning on session deletion: holds by reading.**
   - OpenCode 1: `hook.ts:878-882` `onSessionDeleted` → `clearRustSession` →
     `clearSessionLogState` (`transform.ts:3425-3426`).
   - OpenCode 2: `v2/hooks/context.ts:1262`.
   - The revision's `transform.test.ts` assertion covers both seams.

## Findings

### H1 — riders on first-render and idle-expired held passes edit bytes in front of kept signed thinking

The revision lets these passes run the drains, the heuristics and the proactive
strip:

- OpenCode: `publishedWorkDrainAllowed`, `transform-postprocess-phase.ts:2295-2301`;
  `prefixEditBesidesReasoningTrim`, `:4229-4231`.
- Pi: `prefixMutationAllowed`, `context-handler.ts:8094-8098`; `hardFold`,
  `:8074-8077`.

Per-target protection (`protectNewTagMutations`) vetoes tag edits in front of the
last kept block. The proactive strip (`freezeReasoningOnBustingPass`) does not:
it spares only the active turn's own messages (`protectedThinkingMessages`) and
strips every older assistant's thinking. All of those older blocks sit in front
of the kept active thinking, so on a pass that otherwise replays the same prefix
(idle expiry, or a first render that reproduces the same pair) the strip alone
invalidates the kept blocks. `62fa1e27` held the strip on these passes.

Witnesses:

- The revision's own tests assert the break:
  - `transform-postprocess-phase.test.ts:12420`
    `held idle expiry admits safe riders without a second bust`.
    `:12507` expects `old-thought` stripped while `active-thought` keeps its
    signed thinking.
  - `:12591` (cold held pass) expects `old-tool` stripped in front of the kept
    `active-thought`.
  - `latest-turn-thinking.test.ts:769`
    `Pi already-cold held pass strips older thinking…` drops `sig-2` and keeps
    `sig-4`, which comes after it.
- Driver, OpenCode 1 seed 665 pass 27 (first render): message 8
  (`assistant-call-5`) lost its reasoning, and 9 kept blocks (t18-t26) sit
  behind it. OpenCode totals at HEAD: 72 breaks, 38 on first-render passes and
  36 on idle-expiry passes, with 2 passes being both (`62fa1e27`: 0).
- Driver, Pi: 21 idle-expiry breaks at HEAD (`62fa1e27`: 0). Some are queued
  drops in front of kept thinking.
  - Seed 3, pass 61, idle expiry: pending drops went from 8 to 0, and
    `call-29`'s result became `[dropped §34§]` in front of the kept `sig-58`.
    Reproduce with:
    `R2_SEEDS=3 R2_PASSES=62 R2_DEBUG=1 R2_VERBOSE=1 bun test src/issue-665-hold-review-r2.test.ts -t 'held driver'`.
  - A small focused fixture (one older tool turn, one active step) did not
    reproduce the drop, so the Pi drop path is not root-caused.
- Pinned as expected failures:
  - `held drivers: no kept signed thinking is served behind changed bytes` (OpenCode);
  - `Pi held drivers: no kept signed thinking is served behind changed bytes`.

Fix direction: on a held pass, let riders ride only behind the last kept signed
block, and keep the older-thinking strip held while active signed thinking is
kept. Alternatively, follow the owner's busting-pass rule (`anthropic-thinking-binding.md`,
"proactive strip on busting passes") and strip every signed block, the active
turn included, on passes that truly rewrite the prefix. Doing
both strip older and keep newer is the one combination strict binding rejects.

### H2 — Pi: a pending carried repair re-renders m[0]/m[1] when the hold lifts

A held pass with a fitting last-known-good (LKG) prefix replays it and leaves
the pending tag-identity repair in place. That part
is correct. The next pass whose `prefixMutationAllowed` is true goes through
`identityRebuild` → `clearM0M1PiCache` and `preparedPrefix = undefined`
(`context-handler.ts:8229-8231`). Those passes are idle expiry
(`piHardSignals.cacheExpired`), 85%+ (`emergencyDropEligible`), or the no-LKG
case. The pair is then re-rendered (`first_render`) while the active turn's
signed thinking is still served.

Witnesses:

- Tests (pinned as expected failures, run plainly with `R2_SHOW_FAILING=1`):
  `Pi ruling with a carried identity repair: a held {idle expiry | force band 86% | emergency 96%} pass keeps m[0]/m[1] frozen while signed thinking is kept`.
  - Each fails at the cached-pair check, after checking that the repair is still
    pending and that a kept active block exists.
  - Log: `cleared cached m[0] (tag_identity_repair)` → `pi m[0] HARD fold firing: reason=first_render`.
- Drivers:
  - seed 665 pass 104 (idle expiry with a pending repair): 13 kept blocks;
  - seed 7 pass 100 (idle) and pass 40 (96%);
  - seed 3 pass 73 (idle).
  - 14 re-renders at HEAD, 0 at `62fa1e27`.

At `62fa1e27` the same ruling tests fail earlier: the repair is no longer pending,
because the base acknowledged it on the held pass (first review, Low).
`62fa1e27` also reaches `clearM0M1PiCache` in the force band (line 8158,
`prefixMutationAllowed = !protectedSignedPrefix || emergencyDropEligible`). So
the force-band path is old, but the revision makes it reachable by carrying the
repair forward. Fix direction: keep replaying while signed thinking is kept,
whatever the cache or pressure state. Apply the repair on the first pass that
has no kept signed thinking.

### M1 — Pi: no fitting LKG means a declared rebuild that keeps the active thinking

When `tryReplayHeldIdentityRebuild` finds no LKG (`lkg_miss`), or the fit check
throws, the pass clears m[0]/m[1], renumbers, and lets riders ride. Its active
signed thinking stays on the wire. The fit check can throw because the window is
too small, or because the envelope cannot be priced: `assertPiRawFallbackFits`
raises `PiStorageBusyError` when the system prompt or tool list is missing
(`pi-raw-fallback.ts:332-344`).

That pass is unavoidable as a rebuild, but under strict binding the kept blocks
behind the cleared pair and the renumbered results are invalid.

Witnesses:

- Driver passes `carried-repair-no-lkg`: 14 strict breaks, 9 re-renders.
- An early driver run without host tool metadata. Every carried repair took the
  declared rebuild ("prior prefix cannot fit (PiStorageBusyError…)"), and held
  passes changed bytes: seed 664 passes 6, 10 and 91.

Fix direction: strip the active turn's signed blocks on that one pass, as the
busting-pass rule does.

### M2 — Pi, unheld: idle-expired passes now carry riders

`hardFold` (`context-handler.ts:8074-8077`), `shouldRunHeuristics` (`:8125`) and
`prefixRebuildAlreadyPriced` (`:9874-9875`) now include `cacheExpired` for every
session, not only held ones.

- Differential: 279 unheld Pi idle-expiry passes were compared. 203 differ from
  `62fa1e27`, and 106 of those drain more queued drops.
- Unheld Pi root divergences: 157 of 161 start on an idle-expiry pass. The other
  4 follow a first-render or compartment pass that left different pending
  operations.

This is cache-safe (the cache is already cold), and it brings Pi in line with
OpenCode. On OpenCode, unheld idle expiry already drained at `62fa1e27`: no
OpenCode unheld divergence starts on idle expiry alone. But it is a change to
unheld sessions that neither the commit messages nor the README state, and the
brief allowed only the contended-preflight change.

### L1 — issue 650 attack: a failing declared rebuild refuses across turns

Setup: a pending carried repair, no LKG, and a trigger that makes the
m[0]/m[1] clear fail. The pass then throws `PiStorageBusyError` on every attempt:
in the held turn and in each of the two later user turns (3 refused turns). At
`62fa1e27` the same test refuses none, because the repair is acknowledged
without a clear.

The trigger is a persistent storage fault, not a tag-identity conflict, so this
is Low. But the revision turns a carried repair into a clear that is retried on
every pass until it succeeds, and with no LKG each failed pass refuses. Pinned:
`Pi carried identity repair: a failing declared rebuild refuses at most one turn`
(expected failure).

Without injected faults, the drivers saw 0 refusals in 3,600 held and 15,360
unheld passes, including every carried-repair pass with no LKG. The issue 650
rule holds there.

### L2 — the OpenCode force-band ruling tests are not proven non-vacuous

- Mutation: `freezeM0M1` lifted at ≥85% in postprocess and in `transform.ts`.
  The `force band 86%` and `emergency 96%` ruling tests stayed green, because
  the fixture has no m[0]/m[1] rebuild reason that fires at ≥85%.
- The idle-expiry twin, by contrast, reddened under its mutation.
- The OpenCode force-band verdict therefore rests on code reading
  (`freezeM0M1` has no force exception) and on 0 driver re-renders.

## Parity with the Rust fix (`00bfed90`, `crates/mc-module/src/transform.rs`)

| Rule | Rust | OpenCode TS | Pi |
|---|---|---|---|
| Unavoidable passes (hold lifts) | `prefix_rewrite_unavoidable` (5194-5199): idle TTL, `cache_sections_discarded`, uninitialized or missing m1, lineage `force_hard`; plus bootstrap seed and legacy baseline (5200-5207) | first render, idle expiry, force band (drains only) | first render, idle expiry, force band; plus a carried repair with no fitting LKG |
| `render_config_changed`, `hard_fold_prices_mutations`, `reconcile_hard_due`, m1 digest | held via `prefix_materialization_enabled = !protected_signed_prefix` (5262, used in `independent_rebuild` 5333-5348), also in the force band | fold held by `freezeM0M1` | fold held by `!protectedSignedPrefix` (7959-7967) |
| m[0]/m[1] on idle expiry in a signed turn | re-renders (Rust review H1) | replays | replays unless a carried repair is pending (H2) |
| m[0]/m[1] at ≥85% in a signed turn | `hard_fold_requested` returns once `signed_prefix_hold` is false (5250), so the fold runs (Rust review M1) | frozen | frozen unless a carried repair is pending (H2) |
| Older-thinking strip on unavoidable passes | TS host postprocess, protected set = the whole latest turn (`rust-mode-transform.ts:4246`), so the same H1 exposure (inferred, not run) | H1 | H1 |

Sources: Rust review `docs/reports/issue-665-rust-hold-review.md` (commit
`81638647`, not in this branch).

Differences:

1. TS and Pi have no lineage or discarded-sections term, and Pi adds the carried repair.
2. Rust re-renders m[0]/m[1] on idle expiry and at ≥85%; OpenCode TS never does,
   and Pi does only with a pending repair.
3. Rust's review states that strict-binding exposure comes only from the
   m[0]/m[1] head. In TS and Pi the older-thinking strip, and on Pi some drops,
   are a second source (H1).

## Mutation evidence

Procedure for each: the target files were staged so the index held the live
code, and `git diff --stat` was empty. The mutant (marked `NON-VACUITY BREAK`)
gave a non-empty stat. `git checkout -- <path> && touch <path>` restored it, and
the stat was empty again. Each run was the `-t ruling` subset of the r2 test
file on Linux.

| Mutation | Red | Green |
|---|---|---|
| `transform-postprocess-phase.ts:2058` `freezeM0M1 = (…) && !cacheExpired` | `opencode1 ruling: a held idle expiry pass…` and its `opencode2` twin, both at the cached-pair check | the four OpenCode force-band and 96% ruling tests |
| `transform-postprocess-phase.ts:2058` `… && percentage < 85`, plus `transform.ts` freeze cleared at ≥85% (1203, 1565) | none (L2) | all six OpenCode ruling tests |
| `context-handler.ts:7959,7967` replay skipped and fold allowed on `cacheExpired` | `Pi ruling: a held idle expiry pass…` only, at the cached-pair check | the other five Pi ruling tests |

The strict-binding and m[0]/m[1] checks in the drivers can go both ways. Against
the same seeds they report 0 OpenCode strict breaks and 0 Pi re-renders at
`62fa1e27`, and 72 and 14 at HEAD. The held-prefix check reddened in the
unpriceable-LKG run (M1).

## Reproduce

```sh
# Drivers and ruling tests at the checkout
(cd packages/pi-plugin && bun test src/issue-665-hold-review-r2.test.ts)
(cd packages/plugin && bun test src/hooks/magic-context/issue-665-hold-review-r2.test.ts)
# Pinned failures run as plain tests (they then fail)
R2_SHOW_FAILING=1 bun test …
# Differential against 62fa1e27 (runs in a scratch copy; restores the files)
R2_SEEDS=665,664,650,1,2,3,7,8 R2_PASSES=150 R2_UNHELD_PASSES=320 \
  docs/reports/issue-665-hold-review-r2/differential.sh 62fa1e27 "$TMPDIR/r2"
```

The four product files the differential swaps are
`packages/pi-plugin/src/context-handler.ts`,
`packages/plugin/src/hooks/magic-context/transform.ts`,
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts` and
`packages/plugin/src/v2/hooks/context.ts`. When the runner's checkout has no git
objects, extract their `62fa1e27` versions locally (`git show 62fa1e27:<path>`)
into a directory at the same relative paths and set `BASE_SRC` to it.
