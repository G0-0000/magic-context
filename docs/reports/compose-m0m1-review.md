# Review: compose_m0m1 large-session speed-ups (cache safety)

Scope: `master..8845bb45af`. The product change is `468a873aad`; `58b5f70d41` and
`78ac924514` add the fixture and the golden, and `8845bb45af` the report. Master's
Rust is identical to the merge base `dda49e3850`: master has since changed only
TypeScript and the `crates/mc-module/gen/*.ts` scripts. This review changes no
product code. It adds tests, a golden, and this report.

## Verdict

No finding changes m0 or m1 bytes. I found no byte-identity defect in any of the six
changes, and no failing witness exists for one. A randomized cross-commit
differential over 336 passes is byte-identical between the module before the change
and after it. The single-connection store does make folds wait, and the wait grows
with other sessions' commit size. At this fixture's scale it is tens to a few
hundred milliseconds per pass, not seconds. The worker's claim that it is the
likeliest cause of the 2–3 s production folds is therefore only partly supported.

| Severity | Finding |
|---|---|
| Medium (performance, not cache safety) | The store.db mutex is held for each other session's whole commit (130–210 ms at 150k live messages). A fold that overlaps one waits that long. Measured blocked time per pass: up to 207 ms with 2 full-array background sessions, up to 218 ms with 6 heavy ones, ≤ 30 ms with 6 marker-trimmed ones. The measurement did not reproduce a 2–3 s fold. |
| Low (performance) | The render cache's 32 MiB budget counts `2 × len + 128` per entry. Each tier stores two keys: its text, and its text plus `\n\n#` for the continued count. So the cache holds about 8 MiB of counted tier text in total. If a fold measures every tier of the 5.26 MB fixture, one session alone needs about 21 MiB; two such sessions in one process evict each other back to cold counting. Counts stay exact. |
| Info | Change 4 is strictly more consistent than master. Master could fail a fold with a spurious `CoverageGap` when a publication landed between the guard's read and compose's read. Witness: `a_publication_between_reads_cannot_split_the_fold_snapshot`. |
| Info | `compose_m0_with_compartments` trusts its caller to pass this pass's rows for `inputs.session_id`; nothing checks it. All four call sites do. |
| Info | On the incremental path, the history-slice retry check now ignores the injected estimator and always uses `mc_tokenizer`. Production always injects `mc_tokenizer::estimate_tokens` with `incremental = true`, and only tests pass `incremental = false`, so nothing observable changes. The tier counts were already hard-wired before this change. |
| Info (pre-existing, outside the change) | `load_compartment_boundaries` overlays only the first cached boundary per sequence (`or_insert`), while `apply_compartment_dates` takes the first *matching* one. These agree whenever each sequence has a single cached boundary, which state sync guarantees (see change 5). |

## Change 4: one compartment read per fold

In master's HARD arm (and in the reconcile re-cut, the pressure refold and the
planner's pre-compose), one read R1 fed `coverage_bounds_from_compartments`, the
covered system messages and the live coverage guard. `compose_m0_from_store_timed`
then read again (R2) and rendered from R2. The guard compared R1's ranges against R2's
coverage end.

**Can R1 and R2 differ?** Yes. Historian publication runs out of band, through the
TypeScript plugin or the module historian. It appends rows through
`append_compartments` / `replace_compartments`, and I found no per-session lock
that serializes it with a transform pass. A rescore (`replace_compartments` with new importance)
can land between the reads in the same way. A memory mutation is unaffected by the
change: memories are read inside compose from the store, before and after it.

**Which rows are correct to render?** The guard's rows (R1), which is what the change
renders. In master, a publication between the reads made the guard check R1's ranges
against R2's larger coverage end. Live blocks in the new range then looked uncovered,
and the fold failed with `CoverageGap`. The covered system messages also came from
R1 while the history came from R2. After the change, the bounds, the covered system
messages, the rendered history, `coverage_ordinal` / `boundary_id` and the guard all
come from one snapshot. A row published after R1 is picked up by the next fold,
exactly as if it had landed after the pass.

`a_publication_between_reads_cannot_split_the_fold_snapshot` reproduces both
behaviours with real store reads. The two-read sequence reports stray ordinal 91 under
coverage end 99. The one-read sequence reports no stray, and m0 covers through 90
without the new row.

**Paths that skip the guard.** `first_uncovered_live_block` returns early when
coverage is `None`, so the rows are reused with nothing to check. The SOFT arm still
reads twice: once inside `compose_m1_from_store` for the coverage it advances, then
again for its guard. The change did not touch that path, and it fails safe: the
guard's newer read can only cover more ordinals than the older coverage end. The
planner's pre-compose (`compose_hard_fold_m0`) only decides whether a HARD may bust
the served prefix, and the HARD arm reads again. That was also true on master.

## Change 6: history render count cache

- **Counts equal `estimate_tokens`.** The cache key is the exact piece text, so a hash
  collision cannot return another text's count. The `\n\n## ` split is ASCII, so
  slicing never splits a code point. A Claude pre-token cannot cross `\n\n` | `#`: the
  regex's optional leading space is only a literal space, and whitespace runs stop
  before `#`. A continued piece is counted with a `#` sentinel minus one, the same as
  the shared cache. Tested:
  `history_render_counts_equal_the_encoder_on_randomized_split_texts` (3,000 texts,
  cold and cached) covers `\n\n\n## `, `\r\n\r\n## `, near-miss separators, empty and
  whitespace-only text, NBSP, U+2028, U+3000, combining marks, ZWJ emoji, `<EOT>` and
  digits. It also checks `history_render_paragraph_counts ==
  history_paragraph_counts`.
- **Model switches and calibration.** `mc-tokenizer` has exactly one tokenizer: the
  vendored Claude vocabulary, built once into a `OnceLock`. Models differ only in the
  calibration seed's `prose_ratio`, which `history_local_budget` applies to the
  *budget* after counting. A count can therefore never be served "for another
  tokenizer": no second tokenizer exists in the process. The differential switches
  among four models (no key, two seeded prefixes with different ratios, and an
  unseeded key) between passes, in all four worlds.
- **Tokenizer and render-format epochs.** Both are compile-time constants
  (`COMPARTMENT_RENDER_FORMAT_EPOCH`, `MEMORY_RENDER_FORMAT_EPOCH`, the vendored
  vocabulary). The cache lives only in process memory and is never persisted. A
  format change produces different text, and so a different key.
- **Eviction and concurrency.** The lock is held only for `lookup` and
  `insert_counted`. Tokenizing happens outside it, so two threads can count the same
  piece. Both counts are equal, because the encoder is deterministic, and the second
  insert only fills the slot. Tested:
  `render_cache_eviction_stays_exact_under_concurrent_lookups_and_inserts` (unit test,
  8 threads, 6 KiB budget, so it evicts constantly) and
  `history_render_counts_are_exact_under_concurrent_threads` (8 threads through the
  public API, mixed with `estimate_tokens`). A poisoned lock is recovered with
  `into_inner`. The only panic inside the lock is the `expect` in the eviction loop,
  which cannot fire while the byte accounting holds; the unit test asserts it holds.
  The budget is fixed and does not respond to system memory pressure (see the Low
  finding).

## Changes 2, 3 and 5: edge cases

- **`CoveredOrdinals` (2).**
  `covered_ordinals_agree_with_the_scan_on_every_small_span_list` checks every
  ordered list of up to three spans with endpoints in −1..=5 (120,100 lists, ordinals
  0..=7), covering inverted, zero-length, adjacent, nested, duplicate and negative
  spans. `covered_ordinals_handle_the_integer_limits` covers `i64::MIN`,
  `i64::MAX` and `u64::MAX`. Clamping negatives to 0 matches the reference: a span
  (−3, −1) covers ordinal 0 in both. Merging adjacent spans uses `saturating_add` on
  values ≤ `i64::MAX`, so it cannot overflow.
- **Strip survival (3).** A formatted id `<mid>#<index>` has a decimal index with no
  `#`, so its last `#` is always the separator: `rsplit_once` is exact even when the
  mid contains `#`. `strip_survival_matches_the_reference_on_hostile_ids` checks
  12 mids × 18 suffixes against 64 live-id subsets × 3 block counts, with
  duplicated mids of different block counts. The mids are `""`, `#`, `##`, `a#`,
  `#0`, `m#1`, `m#01`, `m#1#2`, Arabic-Indic digits and an id with a space. The
  suffixes include `#00`, `#+1`, `#-0`, `# 1`, `#٣`, `#0#0` and indices at and past
  `usize::MAX`. The shared live-ordinal map is only ever looked up, never iterated,
  and both the old `BTreeMap` and `HashMap` keep the last value for a repeated id.
- **Cached coordinates (5).** `ResolvedContextBoundary::matches` requires
  `sequence == row.sequence`. Restricting the search to a sequence's bucket, which
  keeps cache order, therefore finds the same first match as the full scan, with or
  without duplicate sequences. Duplicate sequences also cannot reach the cache from
  state sync. `apply_authority_state_sync` applies each boundary to its seed row as
  it goes (`lib.rs` around line 11190). A second boundary for the same sequence must
  then match the row the first one rewrote, and is rejected as
  `InvalidSeedBoundary`.

## Cross-commit differential

`compose_review_differential` (`crates/mc-module/src/tests/compose_review_differential.rs`)
runs four worlds. Each is one store shared by three sessions that run their passes
concurrently on threads. The test runs 336 passes: 12 materializing passes and 324
randomized ones (159 HARD including 19 `pressure_refold` and 14
`compartment_history_revision`, 59 SOFT, 118 SOFT+, no errors).

The sessions cover both shapes: marker-trimmed (the last 20 covered messages plus the
tail) and full-array. They mix indexed rows with host-resolved rows (bare ids plus
the cached host coordinates). Between rounds the driver inserts, edits or archives
shared project memories. Within a round each session may append messages, publish 1–3
compartments, rescore importance, switch model, change its history or memory budget,
or trim its live array at the marker, and then runs a defer, SOFT or fold. The
compartment text contains `\n\n## `, `#` runs, multi-byte letters and emoji, so the
render cache's split is exercised on real renders.

- I built the pre-change module from `git archive 58b5f70d41`: master's Rust with
  only the five `transform::tests` helpers made `pub(crate)`. I verified
  `m0_compose.rs` against `dda49e3850`, and it is identical. That build, the
  post-change build and a repeat post-change build each produced a trace with SHA-256
  `9bebe1d7d4055192c22bf7f3d4705ebe1f88ebcb5e3adbdb7a1c29ae42e711e7`, identical
  across all three.
- The committed golden `crates/mc-module/testdata/compose-review-differential-golden.txt`
  has SHA-256 `88415e55811b91cde915c7c360bc6f9f438b261aa9eb2387cf5e6f773c391475`. It
  holds one 12-hex digest per trace line, and both builds wrote byte-identical copies.
  The regular test compares against it, and its coverage assertions require at least
  60 HARD, 30 SOFT, 30 SOFT+, a pressure refold, 40 publications, 5 trims, 5 rescores,
  ≥ 10 passes per model, 60 distinct m0 and 12 distinct m1 renders, and no errors.
- Non-vacuity: with a render-cache hit returning `count + 1`,
  `compose_review_differential` failed at line 3 (`w0 s0 r3 … kind=fold … HARD`). So
  did the worker's `large_session_compose_differential`, which checks the same
  property, along with the two mc-tokenizer unit tests that read hit values. After
  restoring the file, `git diff --stat` was empty again.

Reproduce the cross-commit run on Linux:

```sh
B=target/review-baseline; rm -rf $B; mkdir -p $B
git archive 58b5f70d41 | tar -x -C $B
cp crates/mc-module/src/tests/compose_review_differential.rs $B/crates/mc-module/src/tests/
sed -i 's|^mod compose_large_session;$|mod compose_large_session;\n#[cfg(test)]\n#[path = "tests/compose_review_differential.rs"]\nmod compose_review_differential;|' \
  $B/crates/mc-module/src/transform.rs
(cd $B && MC_REVIEW_GOLDEN_WRITE=1 CARGO_TARGET_DIR=$PWD/../review-baseline-target \
  cargo test -p mc-module --lib compose_review_differential -- --nocapture | grep '^GOLDEN ')
```

## Store lock wait

`store_lock_wait_under_background_sessions` (ignored; release; Linux runner `ck-motor`,
8 vCPUs, load average 17–23 from other jobs) times one 2,300-compartment
marker-trimmed host-resolved session while N other sessions run passes on the same
`McStore`. The measured session uses a 98,000-token history budget. Each measured
pass's wall time is split into on-CPU, run-queue and blocked time using
`/proc/thread-self/schedstat`.

Three probe threads run alongside:

- `single_store_marker`, which takes only the store.db mutex.
- `load_compartment_boundaries` of an absent session, which takes the context.db
  reader and then the store.db mutex to overlay cached coordinates.
- A lock-free 1 ms sleep, as a control.

| Background | Measured passes: mean wall / mean CPU / mean blocked (ms) | Max blocked (ms) | store.db probe p99 / max (ms) | Lock-free probe max (ms) |
|---|---|---:|---:|---:|
| none | folds 65–73 wall ≈ CPU, blocked ≈ 0; one fold 193 / 72 / 121, during its own 128 ms commit | 121 | 3.7 / 124 | — |
| 6 marker-trimmed (600 compartments, 1,564 live) | fold 191 / 180 / 11 | 29 | 9.5 / 21 | — |
| 6 heavy (600 compartments, 21,500 live) | fold 209 / 133 / 62 | 123 (218 in an earlier run without the control probe) | 43 / 104 | 5.5 |
| 2 full-array (2,300 compartments, 150,100 live) | SOFT 139 / 96 / 43; fold 121 / 91 / 30 | 207 | 5.9 / 201 | 1.1 |

- **The waits are lock waits, not process stalls.** The lock-free probe never stalled
  more than 5.5 ms, while both lock probes stalled together for 50–200 ms. The
  context probe also needs the store.db mutex, so every stall seen here is a store.db
  mutex hold.
- **Stalls line up with background commits.** Full-array background passes took
  1.3–1.6 s each, with `store_commit` 134–212 ms, and lock stalls of 87–203 ms
  clustered around their commits. Measured passes overlapping one had
  `compose_m0m1` inflated from about 17 ms to 98–235 ms. Compose's store.db reads (the
  date cache in `apply_compartment_dates`, and the boundary index and body in
  `cached_context_boundaries`) queue behind the commit.
- **What holds the mutex during a commit.** `commit_transform` encodes JSON before
  taking the lock. Inside `with_conn_fenced` it parses the section index, diffs and
  writes sections, compares the multi-MB state blobs inside SQLite, writes the pass
  trace, and mints tags. On a fingerprint miss it also re-syncs every block identity
  with per-message `serde_json`.
- **CPU inflation.** Under 6 background sessions, on-CPU time of the same fold rose
  from about 70 ms to 130–200 ms (cache and memory contention). That is a larger share
  of the inflation than the lock wait in the marker-trimmed case.

**Does it explain the 2–3 s production folds?** Not on its own at the measured scale.
A fold waits for at most the commits queued ahead of it. To reach 2–3 s, it would have
to queue behind about ten or more full-array commits, or holders would have to be
preempted while holding the mutex. At production load averages of 35–75, a holder
doing CPU work inside the lock is descheduled, and every waiter waits out that
preemption too. This runner was not oversubscribed (run-queue ≈ 0), so that
amplification was not measured. The plausible chain is store.db mutex hold ×
oversubscription × concurrent full-array sessions, but it is unproven. Production
evidence would settle it: `mc-pass-timing` with a lock-wait field, or the
`compose.*` fields the plugin's slow-pass line drops.

**Smallest fix if it holds.** Add a second, read-only `store.db` connection, opened
with `query_only` like the module already does for `context.db`. Give it its own
mutex and route compose's read-only store.db calls to it:
`boundary_index_entry` and `read_boundary_body_consistently` in
`cached_context_boundaries`, and the date-cache read in `apply_compartment_dates`.
Other read-only `with_conn` calls on the pass path can follow once each is checked. Because store.db is in
WAL mode, that reader proceeds during another session's commit and sees the last
committed snapshot. Each of these reads is already a separate short read outside any
transaction, so a snapshot read changes nothing observable. The commit path, and its
epoch fence in `cortexkit-store`, stays on the single writer connection. A pool of
context.db readers would not help: context.db already has its own reader, and every
stall measured here was the store.db mutex. A broader alternative is to move
`write_sections`' diff and the blob comparison out of the locked closure. That
shortens the hold for every caller, but it touches the CAS-fenced commit.

Reproduce:

```sh
MC_REVIEW_BACKGROUND=2 MC_REVIEW_BG_COMPARTMENTS=2300 MC_REVIEW_BG_LIVE_COVERED=149500 \
MC_REVIEW_BG_TAIL=600 MC_REVIEW_CYCLES=12 \
  cargo test -p mc-module --release --lib store_lock_wait_under_background_sessions -- --ignored --nocapture
```

`MC_REVIEW_BACKGROUND=6 MC_REVIEW_BG_LIVE_COVERED=20000` gives the heavy row, and
`MC_REVIEW_BACKGROUND=0` the baseline.

## Tests added

- `crates/mc-module/src/tests/compose_review_differential.rs`:
  `compose_review_differential`, plus its golden in `crates/mc-module/testdata/`.
- `crates/mc-module/src/tests/compose_review_head.rs`:
  `covered_ordinals_agree_with_the_scan_on_every_small_span_list`,
  `covered_ordinals_handle_the_integer_limits`,
  `strip_survival_matches_the_reference_on_hostile_ids`,
  `a_publication_between_reads_cannot_split_the_fold_snapshot`, and the ignored
  measurement `store_lock_wait_under_background_sessions`.
- `crates/mc-tokenizer/tests/history_render_cache_review.rs`: two randomized and
  concurrent exactness tests.
- `crates/mc-tokenizer/src/review_tests.rs`: the concurrent eviction test. It is
  declared with one `#[cfg(test)] mod` line in `lib.rs`.
