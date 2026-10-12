# ctx_search reranking measurement spike

**Date:** 2026-10-12. **Scope:** benchmark only; no product ranking or configuration changed.

## Recommendation

**Choose C (RRF followed by Synapse cross-encoder reranking) for prose queries only**, not D, not all queries, and not RRF alone. This is a recommendation for a subsequent, separately reviewed product change, not a feature shipped by this spike.

On the **45 surviving original queries**, C raises MRR@10 from **0.3960 to 0.5654** (paired difference **+0.1694**, 95% bootstrap CI **[+0.0389, +0.3013]**). For the **39 prose queries**, MRR@10 rises from **0.4154 to 0.6140**: **+0.1985 [ +0.0564, +0.3398 ]**. Prose recall@1 increases **25.64 percentage points [7.69, 43.59]**. This corpus shows a larger gain than AFT's separate search experiment, where paired-bootstrap reranking gains were within noise and identifier-shaped queries were harmed.

Do **not** treat this as a recall@10 improvement: prose recall@10 drops one answer, **28/39 → 27/39** (difference −2.56 points, CI [−7.69, 0]). All C/D gains come from promoting already retrieved answers, not finding new known answers. In the conversation cohort, recall@10 stays **15/20**, while MRR improves **0.5625 → 0.7000**, difference **+0.1375 [0.0083, 0.2750]**. RRF alone reduces conversation MRR to **0.3639** and overall recall@10 from **32/45 to 26/45**; it is not the cheap substitute we wanted.

The **six surviving original literal queries** have C MRR **0.2500 versus A 0.2698**, difference **−0.0198 [−0.3750, +0.3095]**, and recall@10 **4/6 → 3/6**. The function-name query `getVisibleMemoryIds` falls **1 → 4**. Two supplemental path queries disagree strongly: one falls **7 → 20**, the other improves **5 → 1**. Missing commit golds and tiny literal cohorts prevent an all-query recommendation. Keep today's ranking for identifiers, paths and exact strings; a future prose gate must be conservative, not just copy this fixture's manual labels.

D's bounded boosts change **no first-gold rank in any of the 47 measured queries**, although the full candidate ordering differs from C on **46/47** queries (so the boost arm was not inactive). Its measured metrics and confidence intervals equal C's, with no demonstrated benefit to justify extra ranking policy. The quiet-lane cross-encoder call costs **p50 273.8 ms / p95 377.0 ms**, before any shared query embedding/retrieval time. A product implementation needs a deadline and explicit fused-order fallback; this quality experiment saw **zero fallbacks**.

## Corpus, isolation and attrition

- The snapshot provider created an **online backup**, integrity checked, at approximately **19:51Z**, then copied it into the worker's gitignored `local-ignore/ctx-search-rerank/`. `context.db` was **7,559,360,512 bytes**. `opencode.db` was **16 KB**, with only the `message` table and the seven gold message rows. Neither file was staged, committed or sent to Linux. The benchmark never opened the live store paths.
- On this Mac, plain read-only access to the backup failed on the first prepare with `SQLITE_CANTOPEN: unable to open database file`: the standalone backup had no WAL sidecars. The measurement used **`mode=ro&immutable=1` plus the readonly constructor flag**. Registration/migration scratch state was an **in-memory database**. No source-store backfill, retrieval counter writes or shadow measurement writes were enabled.
- The fixture preserves all **50 original study queries**, with explicit manual shape labels: 40 prose, 9 identifiers and 1 exact error string. Natural-language questions containing identifiers remain prose; short natural-language keyword descriptions also remain prose. This is cohort annotation, **not an implemented production classifier**.
- **Five original queries were excluded only because no gold survived**: `identifier-01` (`fec3f113…`), `identifier-02` (`bfb943ee…`), `identifier-03` (`6150c0ef…`), `identifier-04` (`666493de…`), and `hard-10` (`fec3f113…`). The full errors and IDs appear in the every-query table and JSON. `hard-04` also lost its `666493de…` commit gold but **retains and is scored against its verified compartment gold**. No missing answer was silently counted as a reranker success or dropped from the declaration.
- Original metrics use **45 queries: 39 prose, 5 identifiers, 1 exact string**. Identifier attrition is substantial; this is not the original study's full 50-query population. Snapshot/index age and today's message-probe ranking also differ from August: today's conversation baseline is **75% recall@10**, not the historical 50%. The spike does not claim to reproduce the historical absolute scores.
- Added **two separately scored path supplements**: `path-01` is the exact path `packages/plugin/src/features/magic-context/memory/embedding-local.ts`, verified in the `conv-03` gold transcript; `path-02` is `packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts`, verified in the `conv-19` gold transcript. The fixture's original `queries` array remains exactly 50 entries so the existing Synapse-lanes harness's 50-query contract is unchanged. Only this spike opts into the added `rerankSupplementQueries` array. They reuse historical gold targets, are explicitly supplemental, and **do not enter original overall/prose/literal aggregates or their bootstrap intervals**. They are diagnostic cases, not a representative path benchmark.
- Validated golds remain valid even when today's visibility/boundary filters suppress them. Such queries are **scored misses**, not exclusions (`hard-09` is the deliberate post-boundary control). Gold judgments are known-answer identity/range matches, not exhaustive relevance labels: a non-gold answer can be genuinely relevant.
- The throwaway snapshot directory and its candidate-text pool cache were deleted after both passes. Committed evidence contains scores, ranks, hit IDs/titles and timings, **not the snapshot or candidate bodies**.

## Arms and controlled choices

All arms use the **same query text, captured real query embedding, eligible source corpus, session/project identities, visible-memory suppression (memories already rendered in session history are excluded) and compartment ordinal cutoff (raw messages beyond the last completed compartment are excluded)**. The configured embedding space was checked against every snapshot registration. Embeddings were captured once per query before timing the arm-specific work; no embedding vectors or cross-encoder scores were invented.

- **A:** today's `unifiedSearch`, limit 10, explicit search, all source families; existing hybrid scores and per-source multipliers untouched.
- **B:** equal-weight RRF with **k=60**, one-based ranks, **25 candidates per lane**, and a fused **top-20 pool**. Nine lists: memory FTS, memory vector, primer FTS, primer vector, message FTS/probes, compartment chunk vector, git FTS, git vector, notes. FTS-only source calls preserve the production eligibility/fallback/probe logic but cannot blend semantic scores; vector lists are independently ranked by the existing source's cosine convention. No cross-source linear blend or source multiplier is used. Production message literal-probe handling and keyword-note ranking remain within those lanes. Best chunk per compartment is retained. A message inside a retrieved compartment votes for that compartment rather than occupying a duplicate slot; duplicate document votes within a lane are suppressed. Equal RRF ties use stable lane/insertion order, recorded by the harness, not tuned on golds.
- **C:** one real Synapse `rerank.score` call on exactly B's top 20, then descending **raw logit** order, stable on ties; no score threshold. There were 20 candidates in every measured call.
- **D:** same real scores as C (no second service call), then bounded evidence adjustments. Recency factor is **0.95 + 0.10·exp(−ageDays/90)**, neutral for missing timestamps and capped at age zero for future timestamps. Memory trust is **1 + min(0.05, 0.025·verified + 0.025·min(1, log(1+seen)/log(11)))**, neutral on other sources. Each factor is at most ±5% / +5%; combined maximum is 1.1025. Factors are added as **log(factor)** to raw logits: multiplying negative logits would incorrectly penalize positive boosts. Timestamp reference is the quality pass start, not the fixture's August date. These constants were fixed before seeing results, not tuned afterward.

Candidate text follows the AFT recipe: a source/location line, a meaningful title/name line capped at **120 UTF-8 bytes**, then body, **1 KiB total** without splitting UTF-8 characters. Memories/notes use the first content line as title; primers use their question; compartments use the recorded title and canonical transcript; messages use role/first line; commits use SHA/subject. Bodies are prefix-truncated; long compartments can hide an answer outside the prefix. That representation and pool truncation are part of this measurement, not proven optimal choices.

Synapse was reached through the repo's **`@cortexkit/subc-client` 0.11.1**, the subc daemon's **management surface** (its JSON method-call route to Synapse), with a worker bind identity. `models.list` supplied the sole certified fingerprint for `gte-reranker-modernbert-base-f32`: **`2fa5f24c0208f30c6db4bf18eb66bc0b2c46f765882cb744fcc58cd080b2b92d`**, table epoch **2**, module generation **160**. The request pins that discovered full fingerprint (`allow_equivalent:false`, `accept_declared:false`), sets `max_queue_ms=min(100, deadline_ms)`, and uses **deadline_ms=3000**. Every response fingerprint/epoch/score count/finite score was validated. The hexadecimal prefix is a model identity, not a commit in this repository.

`deadline_exceeded`, `shape_compiling`, `queue_full` and `model_loading` are recorded fused-order fallbacks (keep B's order instead of using cross-encoder scores), then retried for quality (up to six attempts; exhaustion aborts instead of measuring a fake rerank). Other transport/protocol failures abort with the original error. Every quality row's final C/D scores are real. Both passes had **C=0, D=0 fallbacks**, including all four transient codes; A/B make no rerank call. C and D share the same call/refusal count, not twice the service traffic. No retries were needed.

## Metric and uncertainty definitions

Recall@k means **at least one known gold hit** by rank k, consistent with the original harness (not fraction of multiple gold targets). Message/compartment ordinal containment preserves the existing matcher. **MRR is MRR@10 for every arm**, matching A's production ten-hit return horizon; ranks 11–20 are shown but contribute zero, and absent golds contribute zero. This avoids unfairly giving B/C/D reciprocal-rank credit below A's returned horizon.

For each arm difference from A and each shape cohort, resample **query pairs with replacement**, **10,000 replicates**, deterministic seed **0x435458**, and take the **2.5th/97.5th percentile** of mean per-query differences. The CI is a paired percentile bootstrap, not independent-arm resampling. Recall differences in the tables are fractions (multiply by 100 for percentage points). No multiple-comparison adjustment is applied. Queries/targets are hand-selected and correlated; these intervals describe this fixture, not deployment traffic. A one-item exact cohort's zero-width interval is **not evidence of general equivalence**. The two path supplements are similarly underpowered.

## Latency and run windows

All measurement commands ran **locally on the Mac under `nice -n 10`**, serially, without uploading snapshot data. The Synapse reranker run was announced before quality measurement; the Synapse operator reported its GPU-loading validation work finished, leaving only possible AFT live-search reranking traffic. "Quiet lane" below means that operator-reported condition, not independently observed GPU utilization. The earlier `20:40Z` notice was a clock-label error, explicitly corrected before measuring. The actual windows are below.

| Window / work measured | Calls | p50 ms | p95 ms |
|---|---:|---:|---:|
| Quality, 2026-10-12 **20:08:29.771Z–20:19:16.706Z**, A search | 47 | 272.9 | 3013.4 |
| Same quality window, B benchmark lane extraction + text preparation + RRF | 47 | 10638.6 | 25415.8 |
| Same quality window, C (B + real rerank + ordering) | 47 | 10846.5 | 25653.4 |
| Same quality window, D (B + same rerank + boosted ordering) | 47 | 10846.5 | 25653.4 |
| Same quality window, `rerank.score` call only | 47 | 186.1 | 237.6 |
| Separate **quiet lane per SYNAPSE's notice**, **20:19:31.371Z–20:19:45.204Z**, `rerank.score` only | 47 | **273.8** | **377.0** |

The quiet pass replayed the **identical candidate text pools** without reading/searching stores or recomputing embeddings. It recorded every attempt and obtained a successful real score vector for every pool. Successful-call and all-attempt percentiles are identical because there were no fallbacks. Its slower times than the quality calls show why latency was measured separately, not inferred from quality. These are client-observed elapsed times including the subc module-call daemon's routing and Synapse queue/execution time, not GPU-only times. One sample per query, warm lane; not a sustained load or cold-start test. All 47 independently replayed score vectors were bit-for-bit equal to the quality pass's vectors.

**Do not ship the benchmark extraction path.** B deliberately issues separate FTS (full-text search) source calls and reconstructs transcript prefixes on a large offline snapshot; it repeats retrieval/metadata work and is much slower than A. Its 10.6-second median is a harness cost, not an estimate of a single production candidate-capture pipeline. C's added service cost is the separately measured ~274 ms median; a future implementation must capture lanes once efficiently and measure true end-to-end latency. The C/D composite quality times use actual per-query B duration plus that query's successful service call and ordering duration, not sums of aggregate percentiles. Common query-embedding time is excluded from all arm timings.

## Reproduce and verify

Provide standalone, integrity-checked offline backups under `local-ignore/ctx-search-rerank/`. Both `--context-db` and `--opencode-db` are required; paths outside that root (including symlinks whose targets escape it) are rejected. Default product/store configuration is never an acceptable substitute for the spike's required flags.

```sh
nice -n 10 bun scripts/ctx-search-benchmark.ts --compare-rerank \
  --context-db local-ignore/ctx-search-rerank/context.db \
  --opencode-db local-ignore/ctx-search-rerank/opencode.db \
  --out docs/reports/ctx-search-rerank-spike/results.json
nice -n 10 bun scripts/ctx-search-benchmark.ts --compare-rerank --latency-only \
  --context-db local-ignore/ctx-search-rerank/context.db \
  --opencode-db local-ignore/ctx-search-rerank/opencode.db \
  --pool-cache local-ignore/ctx-search-rerank/pools.json \
  --out docs/reports/ctx-search-rerank-spike/latency-quiet.json
```

Evidence: [`results.json`](ctx-search-rerank-spike/results.json) includes every query's ranks, safe hits, real score vectors, timings, lane counts, gold attrition and bootstrap summaries. [`latency-quiet.json`](ctx-search-rerank-spike/latency-quiet.json) records the separate actual call window and per-query attempts. Candidate bodies lived only in the deleted throwaway pool cache. Safe-hit `score` fields retain the retrieval-lane scores; the actual cross-encoder logits are `rerankAttempts[*].scores`, in B's pool order. C/D orderings and ranks are stored separately.

Benchmark-specific gates use the committed installed project tools, not downloaded runners:

```sh
bun run test:ctx-search-benchmark
bun run typecheck:ctx-search-benchmark
bun run lint:ctx-search-benchmark
```

These gates run on Linux with four vCPUs **without the offline snapshot**. Unit-test service doubles exercise request/error contracts only; they never supply any measurement scores. The script-specific TypeScript project covers the previously unchecked root benchmark as well as the new harness/helpers/tests. The existing query-instruction helper widened an already narrowed provider object back to the full provider union, producing a TypeScript error when the root script was first included. Removing that cast preserves the `openai-compatible` provider narrowing and lets the new TypeScript gate check the benchmark without suppressing the error. Bun's Linux SQLite build does not enable URI filenames, so its unit tests exercise the native readonly path; the Mac measurement additionally uses immutable URI access.

## Verification results

- **Linux, four vCPUs:** Bun **1.4.2**, **23 tests / 51 assertions** passed; TypeScript **5.9.3**, `bun run typecheck:ctx-search-benchmark` passed; Biome **2.5.1**, `bun run lint:ctx-search-benchmark` checked **5 files** with no fixes or warnings. Formatting of untouched sections of the legacy benchmark is deliberately not enforced; its lint rules remain enabled.
- **Non-vacuity controls:** bypassing `assertOfflinePath` failed only `offline fence rejects sibling and symlink paths to live stores`; replacing direct scratch construction with `openDatabase(":memory:")` failed only `registration scratch has no filesystem side effects`; accepting served-fingerprint drift failed only `fingerprint drift is fatal, not a measured or silent fallback`. Each control left the other **22 tests green** (including the other two named controls). Each mutation was staged-state protected, its non-empty diff captured, then restored to an empty diff; the final 23-test suite passed again.
- During the first measurement, `openDatabase(":memory:")` did use SQLite's in-memory database but also created an empty placeholder file and tightened executable permissions in the checkout directory. The spike now directly constructs and initializes its in-memory database to avoid that opener policy. The placeholder and all unintended tracked mode changes were removed/restored; this changed no measured ranking input or score. The original legacy benchmark's separate storage-opening path is not redesigned by this task.
- AFT inspection was **partial** because root scripts have no root TypeScript dependency recognized by its language server. The explicit script-specific `tsc` project above is the authoritative typecheck; no clean LSP result is claimed.
- A separate artifact audit checked **47 quality calls + 47 quiet calls**, **20 finite scores per pool**, ≤1 KiB candidate text, identical score vectors across passes, **45 original + 2 supplemental** scored queries, and the **5 declared exclusions**. The fixture's primary-plus-supplement query order matches the committed measurement rows.

## Quality (first known-answer hit; MRR truncated at 10)

| Shape | n | Arm | R@1 | R@5 | R@10 | MRR@10 |
|---|---:|---|---:|---:|---:|---:|
| overall | 45 | A | 0.289 | 0.511 | 0.711 | 0.396 |
| overall | 45 | B | 0.289 | 0.511 | 0.578 | 0.396 |
| overall | 45 | C | 0.511 | 0.644 | 0.667 | 0.565 |
| overall | 45 | D | 0.511 | 0.644 | 0.667 | 0.565 |
| prose | 39 | A | 0.308 | 0.538 | 0.718 | 0.415 |
| prose | 39 | B | 0.308 | 0.538 | 0.615 | 0.423 |
| prose | 39 | C | 0.564 | 0.667 | 0.692 | 0.614 |
| prose | 39 | D | 0.564 | 0.667 | 0.692 | 0.614 |
| literal | 6 | A | 0.167 | 0.333 | 0.667 | 0.270 |
| literal | 6 | B | 0.167 | 0.333 | 0.333 | 0.222 |
| literal | 6 | C | 0.167 | 0.500 | 0.500 | 0.250 |
| literal | 6 | D | 0.167 | 0.500 | 0.500 | 0.250 |
| identifier | 5 | A | 0.200 | 0.400 | 0.800 | 0.324 |
| identifier | 5 | B | 0.200 | 0.400 | 0.400 | 0.267 |
| identifier | 5 | C | 0.200 | 0.600 | 0.600 | 0.300 |
| identifier | 5 | D | 0.200 | 0.600 | 0.600 | 0.300 |
| exact | 1 | A | 0.000 | 0.000 | 0.000 | 0.000 |
| exact | 1 | B | 0.000 | 0.000 | 0.000 | 0.000 |
| exact | 1 | C | 0.000 | 0.000 | 0.000 | 0.000 |
| exact | 1 | D | 0.000 | 0.000 | 0.000 | 0.000 |
| supplemental:path | 2 | A | 0.000 | 0.500 | 1.000 | 0.171 |
| supplemental:path | 2 | B | 0.000 | 0.000 | 0.000 | 0.000 |
| supplemental:path | 2 | C | 0.500 | 0.500 | 0.500 | 0.500 |
| supplemental:path | 2 | D | 0.500 | 0.500 | 0.500 | 0.500 |

## Paired differences from A (95% percentile bootstrap)

| Shape | Arm | ΔR@1 [CI] | ΔR@5 [CI] | ΔR@10 [CI] | ΔMRR@10 [CI] |
|---|---|---|---|---|---|
| overall | B | 0.000 [-0.178, 0.178] | 0.000 [-0.156, 0.156] | -0.133 [-0.244, -0.044] | -0.000 [-0.127, 0.131] |
| overall | C | 0.222 [0.044, 0.400] | 0.133 [0.000, 0.267] | -0.044 [-0.111, 0.000] | 0.169 [0.039, 0.301] |
| overall | D | 0.222 [0.044, 0.400] | 0.133 [0.000, 0.267] | -0.044 [-0.111, 0.000] | 0.169 [0.039, 0.301] |
| prose | B | 0.000 [-0.205, 0.205] | 0.000 [-0.179, 0.179] | -0.103 [-0.205, -0.026] | 0.007 [-0.139, 0.161] |
| prose | C | 0.256 [0.077, 0.436] | 0.128 [-0.026, 0.282] | -0.026 [-0.077, 0.000] | 0.199 [0.056, 0.340] |
| prose | D | 0.256 [0.077, 0.436] | 0.128 [-0.026, 0.282] | -0.026 [-0.077, 0.000] | 0.199 [0.056, 0.340] |
| literal | B | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | -0.333 [-0.667, 0.000] | -0.048 [-0.095, 0.000] |
| literal | C | 0.000 [-0.500, 0.500] | 0.167 [0.000, 0.500] | -0.167 [-0.500, 0.000] | -0.020 [-0.375, 0.310] |
| literal | D | 0.000 [-0.500, 0.500] | 0.167 [0.000, 0.500] | -0.167 [-0.500, 0.000] | -0.020 [-0.375, 0.310] |
| identifier | B | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | -0.400 [-0.800, 0.000] | -0.057 [-0.114, 0.000] |
| identifier | C | 0.000 [-0.600, 0.600] | 0.200 [0.000, 0.600] | -0.200 [-0.600, 0.000] | -0.024 [-0.450, 0.371] |
| identifier | D | 0.000 [-0.600, 0.600] | 0.200 [0.000, 0.600] | -0.200 [-0.600, 0.000] | -0.024 [-0.450, 0.371] |
| exact | B | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| exact | C | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| exact | D | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] | 0.000 [0.000, 0.000] |
| supplemental:path | B | 0.000 [0.000, 0.000] | -0.500 [-1.000, 0.000] | -1.000 [-1.000, -1.000] | -0.171 [-0.200, -0.143] |
| supplemental:path | C | 0.500 [0.000, 1.000] | 0.000 [0.000, 0.000] | -0.500 [-1.000, 0.000] | 0.329 [-0.143, 0.800] |
| supplemental:path | D | 0.500 [0.000, 1.000] | 0.000 [0.000, 0.000] | -0.500 [-1.000, 0.000] | 0.329 [-0.143, 0.800] |

## Large per-query wins/losses

Compared with A (today's ranking), an arm's change is large when |Δ reciprocal rank at 10| ≥ 0.25 or recall@10 changes. Ranks beyond 10 count as misses for MRR; `—` is absent from the returned pool.

| Query | Shape | Arm | A rank | Arm rank | ΔRR@10 | Query text |
|---|---|---|---:|---:|---:|---|
| conv-01 | prose | C | 4 | 1 | 0.750 | Where did we diagnose why note reminders vanished after disabling context reduction? |
| conv-01 | prose | D | 4 | 1 | 0.750 | Where did we diagnose why note reminders vanished after disabling context reduction? |
| conv-02 | prose | B | 3 | 13 | -0.333 | back-to-back prompt cache busts during historian run |
| conv-02 | prose | C | 3 | 1 | 0.667 | back-to-back prompt cache busts during historian run |
| conv-02 | prose | D | 3 | 1 | 0.667 | back-to-back prompt cache busts during historian run |
| conv-05 | prose | B | 1 | 2 | -0.500 | m0 m1 cache materialization taxonomy |
| conv-05 | prose | C | 1 | 2 | -0.500 | m0 m1 cache materialization taxonomy |
| conv-05 | prose | D | 1 | 2 | -0.500 | m0 m1 cache materialization taxonomy |
| conv-08 | prose | B | 1 | 2 | -0.500 | shadow mode byte compare Rust transform |
| conv-10 | prose | B | 3 | 15 | -0.333 | Why was ctx-status computing the wrong usable context denominator? |
| conv-10 | prose | C | 3 | 1 | 0.667 | Why was ctx-status computing the wrong usable context denominator? |
| conv-10 | prose | D | 3 | 1 | 0.667 | Why was ctx-status computing the wrong usable context denominator? |
| conv-12 | prose | B | 2 | 11 | -0.500 | How did we plan one dashboard for both Pi and OpenCode histories? |
| conv-12 | prose | C | 2 | 1 | 0.500 | How did we plan one dashboard for both Pi and OpenCode histories? |
| conv-12 | prose | D | 2 | 1 | 0.500 | How did we plan one dashboard for both Pi and OpenCode histories? |
| conv-15 | prose | B | 1 | 2 | -0.500 | F2 F3 performance optimization |
| conv-18 | prose | B | 1 | 2 | -0.500 | When did we add per-repository configuration profiles while reviewing MobileMem? |
| conv-19 | prose | B | 1 | 2 | -0.500 | Where did the terminal finally ship 0.40.1 after the automated release attempts kept dying? |
| conv-20 | prose | C | 2 | 1 | 0.500 | Parity Hunt 3 memory-off suppression license PR 367 |
| conv-20 | prose | D | 2 | 1 | 0.500 | Parity Hunt 3 memory-off suppression license PR 367 |
| identifier-07 | identifier | C | 1 | 4 | -0.750 | getVisibleMemoryIds |
| identifier-07 | identifier | D | 1 | 4 | -0.750 | getVisibleMemoryIds |
| identifier-08 | identifier | B | 7 | 13 | -0.143 | ctx_reduce_enabled |
| identifier-09 | identifier | B | 7 | — | -0.143 | cache_ttl |
| identifier-09 | identifier | C | 7 | — | -0.143 | cache_ttl |
| identifier-09 | identifier | D | 7 | — | -0.143 | cache_ttl |
| identifier-10 | identifier | C | 3 | 1 | 0.667 | sqlite-vec |
| identifier-10 | identifier | D | 3 | 1 | 0.667 | sqlite-vec |
| fact-01 | prose | B | 7 | 1 | 0.857 | Why does ctx_search exclude memories already rendered in session history and raw messages after the compartment boundary? |
| fact-01 | prose | C | 7 | 1 | 0.857 | Why does ctx_search exclude memories already rendered in session history and raw messages after the compartment boundary? |
| fact-01 | prose | D | 7 | 1 | 0.857 | Why does ctx_search exclude memories already rendered in session history and raw messages after the compartment boundary? |
| fact-02 | prose | B | 7 | 1 | 0.857 | How does temporal awareness signal conversation gaps without breaking prompt cache stability? |
| fact-02 | prose | C | 7 | 1 | 0.857 | How does temporal awareness signal conversation gaps without breaking prompt cache stability? |
| fact-02 | prose | D | 7 | 1 | 0.857 | How does temporal awareness signal conversation gaps without breaking prompt cache stability? |
| fact-03 | prose | B | 7 | 1 | 0.857 | What ordering keeps active user memories byte stable? |
| fact-03 | prose | C | 7 | 1 | 0.857 | What ordering keeps active user memories byte stable? |
| fact-03 | prose | D | 7 | 1 | 0.857 | What ordering keeps active user memories byte stable? |
| fact-05 | prose | B | 8 | 1 | 0.875 | How should ctx_reduce describe queued discards to models? |
| fact-05 | prose | C | 8 | 1 | 0.875 | How should ctx_reduce describe queued discards to models? |
| fact-05 | prose | D | 8 | 1 | 0.875 | How should ctx_reduce describe queued discards to models? |
| fact-07 | prose | B | 7 | 1 | 0.857 | How are historian prompts tested against real raw message ranges? |
| fact-07 | prose | C | 7 | 1 | 0.857 | How are historian prompts tested against real raw message ranges? |
| fact-07 | prose | D | 7 | 1 | 0.857 | How are historian prompts tested against real raw message ranges? |
| fact-08 | prose | B | 9 | 1 | 0.889 | What Anthropic failure can empty text blocks trigger after message mutation? |
| fact-08 | prose | C | 9 | 1 | 0.889 | What Anthropic failure can empty text blocks trigger after message mutation? |
| fact-08 | prose | D | 9 | 1 | 0.889 | What Anthropic failure can empty text blocks trigger after message mutation? |
| fact-09 | prose | B | 9 | 1 | 0.889 | Why must Cargo commands run serially in AFT? |
| fact-09 | prose | C | 9 | 1 | 0.889 | Why must Cargo commands run serially in AFT? |
| fact-09 | prose | D | 9 | 1 | 0.889 | Why must Cargo commands run serially in AFT? |
| hard-01 | prose | B | 5 | 14 | -0.200 | What did we ship for issue 78 and how was the Electron crash fixed? |
| hard-01 | prose | C | 5 | 18 | -0.200 | What did we ship for issue 78 and how was the Electron crash fixed? |
| hard-01 | prose | D | 5 | 18 | -0.200 | What did we ship for issue 78 and how was the Electron crash fixed? |
| hard-02 | prose | C | 3 | 1 | 0.667 | Why did we reject sqlite-vec and what storage approach replaced it? |
| hard-02 | prose | D | 3 | 1 | 0.667 | Why did we reject sqlite-vec and what storage approach replaced it? |
| hard-03 | prose | B | 1 | 2 | -0.500 | What happened Wednesday August 26 around the 0.40.1 release? |
| hard-03 | prose | C | 1 | 3 | -0.667 | What happened Wednesday August 26 around the 0.40.1 release? |
| hard-03 | prose | D | 1 | 3 | -0.667 | What happened Wednesday August 26 around the 0.40.1 release? |
| hard-05 | prose | B | 2 | 1 | 0.500 | Why are memories already visible in session history filtered from ctx_search? |
| hard-07 | prose | B | 1 | 8 | -0.875 | What was decided about the shadow-mode ordinal source of truth? |
| hard-07 | prose | C | 1 | 9 | -0.889 | What was decided about the shadow-mode ordinal source of truth? |
| hard-07 | prose | D | 1 | 9 | -0.889 | What was decided about the shadow-mode ordinal source of truth? |
| hard-08 | prose | B | 1 | 4 | -0.750 | What did issue 305 change about context pressure math? |
| path-01 | path | B | 7 | 14 | -0.143 | packages/plugin/src/features/magic-context/memory/embedding-local.ts |
| path-01 | path | C | 7 | 20 | -0.143 | packages/plugin/src/features/magic-context/memory/embedding-local.ts |
| path-01 | path | D | 7 | 20 | -0.143 | packages/plugin/src/features/magic-context/memory/embedding-local.ts |
| path-02 | path | B | 5 | 13 | -0.200 | packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts |
| path-02 | path | C | 5 | 1 | 0.800 | packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts |
| path-02 | path | D | 5 | 1 | 0.800 | packages/plugin/src/hooks/magic-context/reference-seeds.generated.ts |

## Every query

| Query | Shape | A | B | C | D | Eligibility / invalid golds |
|---|---|---:|---:|---:|---:|---|
| conv-01 | prose | 4 | 9 | 1 | 1 | scored |
| conv-02 | prose | 3 | 13 | 1 | 1 | scored |
| conv-03 | prose | 1 | 1 | 1 | 1 | scored |
| conv-04 | prose | 1 | 1 | 1 | 1 | scored |
| conv-05 | prose | 1 | 2 | 2 | 2 | scored |
| conv-06 | prose | — | — | — | — | scored |
| conv-07 | prose | 3 | 6 | 2 | 2 | scored |
| conv-08 | prose | 1 | 2 | 1 | 1 | scored |
| conv-09 | prose | — | — | — | — | scored |
| conv-10 | prose | 3 | 15 | 1 | 1 | scored |
| conv-11 | prose | — | — | — | — | scored |
| conv-12 | prose | 2 | 11 | 1 | 1 | scored |
| conv-13 | prose | — | — | — | — | scored |
| conv-14 | prose | 1 | 1 | 1 | 1 | scored |
| conv-15 | prose | 1 | 2 | 1 | 1 | scored |
| conv-16 | prose | — | — | — | — | scored |
| conv-17 | prose | 1 | 1 | 1 | 1 | scored |
| conv-18 | prose | 1 | 2 | 1 | 1 | scored |
| conv-19 | prose | 1 | 2 | 1 | 1 | scored |
| conv-20 | prose | 2 | 2 | 1 | 1 | scored |
| identifier-01 | identifier | — | — | — | — | excluded: no surviving gold; Missing or wrong-project commit gold fec3f113e00736591aec75c5934b240f4e90dbf7 (identifier-01) |
| identifier-02 | identifier | — | — | — | — | excluded: no surviving gold; Missing or wrong-project commit gold bfb943eec7733c154e98163448508d9e98e43484 (identifier-02) |
| identifier-03 | identifier | — | — | — | — | excluded: no surviving gold; Missing or wrong-project commit gold 6150c0ef6ee12890cfc7e4b6cc682bbaf575adc7 (identifier-03) |
| identifier-04 | identifier | — | — | — | — | excluded: no surviving gold; Missing or wrong-project commit gold 666493defa62665f8f636d971db70928b9c71708 (identifier-04) |
| identifier-05 | identifier | — | — | — | — | scored |
| identifier-06 | exact | — | — | — | — | scored |
| identifier-07 | identifier | 1 | 1 | 4 | 4 | scored |
| identifier-08 | identifier | 7 | 13 | 4 | 4 | scored |
| identifier-09 | identifier | 7 | — | — | — | scored |
| identifier-10 | identifier | 3 | 3 | 1 | 1 | scored |
| fact-01 | prose | 7 | 1 | 1 | 1 | scored |
| fact-02 | prose | 7 | 1 | 1 | 1 | scored |
| fact-03 | prose | 7 | 1 | 1 | 1 | scored |
| fact-04 | prose | — | — | — | — | scored |
| fact-05 | prose | 8 | 1 | 1 | 1 | scored |
| fact-06 | prose | — | — | — | — | scored |
| fact-07 | prose | 7 | 1 | 1 | 1 | scored |
| fact-08 | prose | 9 | 1 | 1 | 1 | scored |
| fact-09 | prose | 9 | 1 | 1 | 1 | scored |
| fact-10 | prose | — | — | — | — | scored |
| hard-01 | prose | 5 | 14 | 18 | 18 | scored |
| hard-02 | prose | 3 | 3 | 1 | 1 | scored |
| hard-03 | prose | 1 | 2 | 3 | 3 | scored |
| hard-04 | prose | — | — | — | — | scored; Missing or wrong-project commit gold 666493defa62665f8f636d971db70928b9c71708 (hard-04) |
| hard-05 | prose | 2 | 1 | 2 | 2 | scored |
| hard-06 | prose | — | — | — | — | scored |
| hard-07 | prose | 1 | 8 | 9 | 9 | scored |
| hard-08 | prose | 1 | 4 | 1 | 1 | scored |
| hard-09 | prose | — | — | — | — | scored |
| hard-10 | prose | — | — | — | — | excluded: no surviving gold; Missing or wrong-project commit gold fec3f113e00736591aec75c5934b240f4e90dbf7 (hard-10) |
| path-01 | path | 7 | 14 | 20 | 20 | scored |
| path-02 | path | 5 | 13 | 1 | 1 | scored |
