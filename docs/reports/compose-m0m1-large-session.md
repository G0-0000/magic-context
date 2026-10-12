# compose_m0m1 on a large OpenCode Rust-mode session

## Question

ALF's Rust-mode OpenCode session has about 2,300 compartments (about 4.5 MB of
compartment text) and a raw ordinal span of about 150,000 messages. Its HARD folds
log `compose_m0m1` at 2.2–3.2 s, with `state_evolution` only about 60 ms above it.
Earlier the same day one fold took 8.8 s under load. One logged fold was a SOFT that
became a `pressure_refold` (in=2,246, out=292). The machine's load average was 35–75
at the time. The nearby input-coverage line was
`oc_input=2229 covered=150716 first_ordinal=150652`. So the module receives about
2,230 messages whose ordinals start near 150,650: OpenCode trims at the compaction
marker.

## Fixture and isolation

`crates/mc-module/src/tests/compose_large_session.rs` builds a synthetic session in a
fresh temporary store and drives real `transform` passes through it. It never uses a
copy of a real store. The session has:

- N compartments of 65 ordinals each (2,300 compartments → covered end 149,500).
  Each has four tiers, with P2/P3/P4 sized at about 45%, 20% and a few words of P1.
  Each also has importance 1–100, start and end dates, an episode type and
  heading-like body lines. About one row in twelve is a pre-v2 flat row, and a few
  rows have sparse tiers. At 2,300 compartments the tier text is 5.26 MB; at 500 it
  is 1.14 MB.
- 300 project memories across the five categories, with importance 1–100. Historian
  facts are promoted into these memories, and m0/m1 render nothing else from them.
- Optional host-resolved rows (`MC_COMPOSE_HOST_RESOLVED=1`). These rows are stored
  with bare message ids, the shape TypeScript-published compartments have. Each
  compartment read then applies the host coordinate overlay cached by state sync.
- A live array in one of two shapes. **Marker-trimmed** is the production shape: the
  last 64 covered messages plus 2,165 tail messages (2,229 live, first ordinal about
  149,437). **Full array** keeps every covered message (150,100 live). That shape
  matters for hosts that send the whole history.

Each profile cycle appends messages, publishes one compartment, then runs a defer
(`SOFT+`), a SOFT and a fold (HARD, forced by a new render-config identity). The
history budget is 98,000 tokens (a 1M-context model at 65% × 0.15).
`MC_COMPOSE_BACKGROUND=N` runs N other sessions on their own threads against the same
store while the measured passes run.

Every run happened in a temporary directory on the Linux build runner, `ck-motor`
(8 vCPUs, release build). No run happened on the host Mac, so no live store, config
or log was opened, and no `lsof` proof applies.

## Where the time went

The fine-grained timers were temporary and are not committed. Release build, 2,300
compartments:

| Cost | Marker-trimmed | Full array (150k live) |
|---|---:|---:|
| `protected_tail_floor_ordinal` (first fold after initialization only) tokenized every live block | 3 ms | **1,631 ms** |
| `first_uncovered_live_block`: for each live block, scan the compartments for one covering it (O(live × compartments)) | 0.2–6 ms | **111 ms** |
| HARD unit survival: `surviving_strip_units` formatted one id string per live block; red and channel1 each built their own live-ordinal map | 1–2 ms | **107 ms** |
| `load_compartments` read twice per fold (coverage guard, then compose) | 2 × 5–9 ms | same |
| Tier tokenization + history-slice check, warm process-wide cache | 1–4 ms | same |
| Same, while 6 other sessions ran passes on the same store | **40–56 ms tokenize, 64–84 ms decay render** | — |
| Decay tiering, sorting, memory selection, JSON | < 4 ms combined | same |
| `state_evolution` outside compose: tail hygiene (`evolution_hygiene`) | 5–7 ms | 420–700 ms on every pass, defers included |

The shared-store result has a simple cause. Every `estimate_tokens` call in the
process (tail blocks, tags, memories, other sessions' renders) shares one 8 MiB count
cache. That cache also tokenizes misses while holding its lock, and a caller that
finds the lock busy counts without the cache. Under load, a fold found none of its
tier counts cached. It re-tokenized every visible tier and then the whole history
slice again for the retry check, so every fold behaved like a cold one.

## Fixes (no epoch, no schema change)

1. **Publication floor.** Walk non-system blocks newest ordinal first and tokenize
   only until the floor is met. Each ordinal still sums all its blocks before the
   floor check. A test compares it with the old full walk over 400 scrambled inputs,
   with unsorted and duplicate ordinals and system rows. The test also asserts that
   the walk tokenizes no more blocks than the old one, and fewer in at least 50
   cases.
2. **Live coverage guard.** Merge the compartments' inclusive ranges once
   (`CoveredOrdinals`), then binary-search each block. The per-compartment predicate
   is kept as a test-only reference; 400 cases with inverted, overlapping, nested and
   negative spans agree.
3. **HARD unit survival.** Build one live-ordinal map for red and channel1 survival.
   Strip survival checks `<mid>#<index>` targets by splitting at the last `#` and
   requiring a canonical decimal index below the message's block count; it no longer
   formats every live block id. The old id-set version is a test reference (300
   cases, including ids with `#` in the message id and leading zeros).
4. **One compartment read per fold.** `compose_m0_with_compartments` composes from the
   rows the fold just read for its coverage guard. This applies in the HARD arm, the
   reconcile re-cut, the pressure refold and the planner's marker-HARD pre-compose.
5. **Cached host coordinates** (`mc-store` `apply_compartment_dates`). Index the cached
   boundaries by sequence, keeping cache order, so the first match is the same one a
   full scan finds. The previous scan was O(compartments × boundaries).
6. **History render count cache** (`mc-tokenizer`). This is a separate, process-wide,
   32 MiB LRU used only for compartment tier texts (`PreparedDecay`), the incremental
   renderer's history-slice retry check, and the SOFT arm's m0 pressure count. It
   uses the same piece split and returns the same counts as `estimate_tokens`. Its
   lock is held only for lookups and inserts, never while tokenizing, and each new
   entry takes its own clock tick. Other traffic can no longer evict a long session's
   tier counts, and a busy lock no longer forces uncached counting.

## Results (release, ck-motor, unloaded unless noted; medians of the 3 measured cycles)

`compose_m0m1` in ms:

| Shape | Compartments | Pass | Before | After |
|---|---:|---|---:|---:|
| Marker-trimmed | 2,300 | fold (HARD) | 31.2 | **15.4** |
| Marker-trimmed | 2,300 | SOFT | 26.6 | 19.1 |
| Marker-trimmed | 2,300 | cold first render | 70.6 | 53.4 |
| Marker-trimmed | 500 | fold (HARD) | 5.8 | 4.3 |
| Marker-trimmed | 500 | SOFT | 5.3 | 5.3 |
| Full array | 2,300 | fold (HARD) | 260.5 | **59.4** |
| Full array | 2,300 | SOFT | 203.3 | 49.8 |
| Full array | 2,300 | first fold, computes publication floor | 2,050.9 | **114.1** |
| Full array | 500 | fold (HARD) | 24.5 | 12.8 |
| Full array | 500 | SOFT | 17.7 | 9.2 |
| Full array | 500 | first fold, computes publication floor | 384.9 | 36.6 |
| Marker-trimmed, 6 sessions sharing the store | 2,300 | fold (HARD) | 111.7 ¹ | **30.4** |
| Marker-trimmed, 6 sessions sharing the store | 500 | fold (HARD) | — | 14.1 |

¹ This "before" includes fixes 1–5 and lacks only the render cache. Its fold
`decay_render_ms` was 64–84 ms (tier tokenize 40–56 ms); after the cache it was
4.1–6.0 ms (1.5–1.8 ms). The same build with no background sessions folded in
12.6–14.1 ms.

`state_evolution` for folds (ms): marker-trimmed 2,300: 37.9 → 21.2; 500: 10.3 → 8.3.
Full array 2,300: 719.5 → 457.9; 500: 111.5 → 81.8. Defers do not compose and are
unchanged at 0.0–1.2 ms compose. Raw lines are in
`docs/reports/evidence/compose-m0m1-large-session/`.

## Byte identity

- `large_session_compose_differential` (regular test) replays 4 seeded randomized
  runs, each with one materializing pass plus 60 randomized steps: 244 passes in all
  (92 HARD including 8 `pressure_refold`, 61 SOFT, 91 SOFT+). The runs use indexed
  and host-resolved rows and history budgets of 800, 3,000 and 12,000 tokens. Every
  pass's decision, reason, coverage and SHA-256 of m0 and m1 must equal
  `crates/mc-module/testdata/compose-large-session-golden.txt`. That file was recorded
  from the pre-change module and committed before any optimization.
- All 40 profile passes in the four before/after matrix runs (both shapes, 2,300 and
  500 compartments) produced identical decisions and m0/m1 digests before and after.

## Mutation controls

Each control was staged, applied, run, and restored to an empty diff.

- Render cache never records counts → only
  `history_render_cache_answers_a_repeat_without_tokenizing` failed.
- Render cache hits return count + 1 → the mc-module differential failed alone in
  its targeted run ("first differing pass at line 19"). In mc-tokenizer, all three
  render-cache tests failed, since each reads hit values.
- No fresh clock tick on insert → only
  `history_render_inserts_between_lookups_keep_the_byte_accounting_exact` failed.
- Range merge loses nested spans → only
  `merged_coverage_ranges_match_the_per_compartment_scan` failed. A first attempt
  that made range ends exclusive also broke the differential's real passes with a
  coverage-gap error.
- Floor walk also tokenizes the whole array → only
  `publication_floor_matches_the_full_walk_and_stops_at_the_floor` failed.
- Strip check accepts leading-zero indices → only
  `strip_survival_matches_the_formatted_block_id_set` failed.

## What this does not explain

At the production shape, unloaded, the fixture's fold compose is 15–31 ms, not
1–3 s. The fixes cut the costs this fixture can reproduce, and the shared-store
experiment reproduces an 8× inflation from count-cache misses, which fix 6 removes.
The rest of the production gap is not reproduced here. The likeliest remaining cause
is contention outside compose's CPU work:

- `McStore` serves every session through one `store.db` connection behind a mutex
  (`cortexkit-store` `with_conn`) and one `context.db` reader behind another.
  Compose's reads (compartments, cached coordinates, memories, m1 signal) wait behind
  other sessions' work, including large `store_commit`s. Those took 0.1–3.7 s per
  pass in the full-array fixture.
- CPU oversubscription at load averages of 35–75.

Fix 4 removes one full compartment read, and its lock acquisitions, per fold. A
pooled or WAL multi-reader store would address the wait itself. That is store
architecture and outside this change.

The plugin's "rust module stages (slow pass)" line drops non-numeric timing fields, so
`compose.decay_render_ms`, `tier_tokenize_ms` and `memory_render_ms` never reach it.
The module's own `mc-pass-timing` line carries them and would show directly whether a
slow production fold is tokenizing or waiting. At the full-array shape, the remaining
`state_evolution` cost is tail hygiene over the whole projection
(`evolution_hygiene`, 420–700 ms on every pass, defers included). That needs the
incremental-hygiene work and is not changed here.

## Reproduction

```sh
MC_COMPOSE_COMPARTMENTS=2300 MC_COMPOSE_HOST_RESOLVED=1 MC_COMPOSE_HISTORY_BUDGET=98000 \
MC_COMPOSE_LIVE_COVERED=64 MC_COMPOSE_TAIL=2165 MC_COMPOSE_CYCLES=3 \
  cargo test -p mc-module --release --lib large_session_compose_profile -- --ignored --nocapture
```

For the full-array shape, set `MC_COMPOSE_LIVE_COVERED=149500 MC_COMPOSE_TAIL=600`.
`MC_COMPOSE_BACKGROUND=6` adds the shared-store load. `MC_COMPOSE_SPANS=1` prints the
module's profiling spans per pass.
