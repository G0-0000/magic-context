# Product ctx_search prose reranking

## Shipped policy

**Arm A** means today's retrieval ranking; **arm C** means reciprocal-rank fusion (RRF) followed by cross-encoder scoring. The reference measurement is [the reranking spike](ctx-search-rerank-spike.md).

Explicit `ctx_search` alone uses conservative prose detection, nine independent retrieval lanes, equal-weight RRF (`k=60`, 25 per lane, top 20), and one Synapse `rerank.score` request. The request discovers and pins the sole certified fingerprint from `models.list`, passes `allow_equivalent:false` and `accept_declared:false` instead of accepting substitute model identities, permits 100 ms queueing, and has a **1,500 ms transport and client-side deadline**. Descending raw logits determine order; ties retain pool order. Any discovery, service, deadline, fingerprint, epoch, score-shape, or candidate-preparation failure retains **arm A**, never RRF order. Fallback messages are emitted once per reason per process. No user configuration schema was changed.

Discovery happens before lane capture. Without Synapse, the existing retrieval and formatting path runs without extra candidate generation. A configured user `subc.connection_file` is forwarded by OpenCode 1, OpenCode 2, Pi, and Pi's subagent entry; otherwise the CortexKit default connection file is used. Automatic search and embedding-shadow measurements do not rerank.

Candidate generation reuses `unifiedSearch`'s existing memory FTS/vector scores, primer FTS/vector scores, commit FTS/vector scores and metadata, notes, message/probe query rows, and compartment chunk scan. Message queries fetch the larger candidate horizon once, then independently rank the original horizon and the RRF horizon, preserving arm A's scores on fallback. Visibility, ordinal cutoff, source gates, date bounds, status and workspace eligibility precede fusion. Message containment and duplicate votes follow the spike. Only the fused 20 need full candidate text. Message bodies use the ordinal-to-FTS-rowid map rather than repeatedly scanning unindexed FTS identity columns; canonical compartment text uses the existing mapped reader. UTF-8 truncation and source/title/body framing match the harness.

## Classifier confusion matrix

The manual fixture is an evaluation cohort, not a lookup table used by the classifier.

| Manual label | Classified prose | Classified literal |
|---|---:|---:|
| Prose | **39** | **1** |
| Identifier / exact / supplemental path | **0** | **12** |

The conservative miss is `conv-15`, `F2 F3 performance optimization`: only two ordinary words, so the short symbol-heavy phrase keeps arm A. All 9 identifiers, the exact error string, and both supplemental paths keep today's ranking. Additional tests cover quoted strings, stack/error signatures, hashes, paths, and short symbol lists. Question-shaped prose containing identifiers is accepted.

## Offline end-to-end proof

The parent supplied the **identical online backup** used by the spike: context.db **7,559,360,512 bytes**, opencode.db **16 KB**. Both lived in gitignored `local-ignore/ctx-search-rerank/`, opened read-only with **`mode=ro&immutable=1`**. Registration and migrations used only an in-memory scratch database. No live store was opened, read, written, or migrated. The backup directory, temporary base-revision module, and debugging data were deleted after measurement.

Command (Mac, serial, `nice -n 10`; native immutable SQLite access and the local Synapse daemon):

```sh
nice -n 10 bun scripts/ctx-search-rerank-product.ts \
  --context-db local-ignore/ctx-search-rerank/context.db \
  --opencode-db local-ignore/ctx-search-rerank/opencode.db \
  --baseline-module local-ignore/ctx-search-rerank/arm-a-before.ts \
  --out docs/reports/ctx-search-rerank-product/results.json
```

The optional fenced baseline module was generated from **base commit `2f74eee7a796d330bc722f9bcdc246131a1de9d8`'s actual search.ts**, changing only import locations to resolve this worktree's unchanged dependencies. The base-commit module provides an independent comparison, rather than toggling reranking on and off in the new search implementation. Without it the reproducible runner compares the product opt-out instead.

- **47/47 scored queries' product C first-gold ranks match archived harness C**, including ranks 18 and 20; the same 5 original missing-gold exclusions remain.
- **47/47** product candidate-text pools match the harness recipe byte-for-byte on the newly retrieved candidates.
- **47/47** searches with Synapse absent are JSON-byte-identical to the base-revision search results. Unit tests also compare formatted tool output and error fallbacks.
- Each C score vector came from one real product-contract Synapse call; no synthetic logits supplied measurement scores. For classifier-negative queries, only the comparison runner explicitly invokes the product scorer to measure arm C; the actual tool remains arm A. For positive queries, the runner compares the actual `unifiedSearch` output to the full 20-item ordering from that same call.
- The sole certified fingerprint was **`2fa5f24c0208f30c6db4bf18eb66bc0b2c46f765882cb744fcc58cd080b2b92d`**, epoch **2**. No product scoring fallbacks occurred.
- Across the **39 surviving manually labeled prose queries**, fresh arm A MRR@10 is **0.4176**, product C **0.6140**, and the conservative gated product also **0.6140** (`conv-15`'s arm A and C gold ranks are both 1). Recall@10 remains **28/39 → 27/39**. The original spike's bootstrap CI is not recomputed or presented as a new uncertainty estimate.
- **17/47 archived B pool orders differ** on this fresh real-query-embedding pass. For these cases the runner additionally checks the current harness extraction against product fusion. All C gold ranks still match the archive; this is not a claim that fresh vectors or every non-gold ordering are bit-for-bit equal to October's captured embeddings.

Evidence is [`results.json`](ctx-search-rerank-product/results.json): gold ranks, safe identifiers, matched-pool/text flags and timings, not database contents or candidate bodies. The final source also preserves workspace source labels in captured memory results and uses the raw memory cosine convention; these metadata/score-scale corrections do not change candidate text or measured gold ranks.

## Cost

Common query embedding is captured once before timing, exactly as in the spike. Timings include synchronous retrieval, candidate text, discovery, routing, and ordering, with no full transcript reconstruction outside the existing indexed canonical reader. The baseline runs first, followed by the absent-Synapse differential and then product; OS/vector caches are consequently warmer for product. These are serial fixture observations, not an unbiased sustained-load or cold-start benchmark.

| Timed work | n | p50 ms | p95 ms |
|---|---:|---:|---:|
| Base-revision arm A (all scored queries) | 47 | **188.2** | **1061.3** |
| Product retrieval/text/discovery (classified prose; service duration subtracted per query) | 38 | **149.8** | **620.9** |
| Product end-to-end after common embedding | 38 | **331.4** | **816.9** |
| `rerank.score` only | 38 | **170.4** | **202.6** |

Product p50 **331.4 ms** is below today's approximate **270 ms + 170.4 ms** service cost. The tool captures candidates during the existing retrieval passes instead of using the harness's repeated source retrieval and full-text preparation, which took roughly 10 seconds. The 38-call latency cohort excludes the classifier's conservative miss and the missing-gold prose exclusion; the quality cohort still includes the conservative miss.

## Host and Rust routing

OpenCode 1's tool registry calls `createCtxSearchTools`, OpenCode 2 registers that same tool definition in its tool editor, and Pi calls the shared `unifiedSearch` through its tool wrapper. **Rust transform mode does not route any of these explicit searches through ck-mc.** Module tool backends cover mutation/reduction operations, not search. Pi has no Rust transform caller at all.

ck-mc does contain a separate facade `ctx_search` handler, but it is **not on the three product tool routes** above; its lexical memory/compartment/note corpus does not own raw messages, primer or git indexes. No Rust search or automatic-hint behavior was changed, and no Rust files were touched. This implementation covers actual explicit search in Rust transform mode by its existing TypeScript route, not by claiming that the unused module facade implements the TypeScript full-text/vector lanes.

## Verification

Linux gates use **four vCPUs**, Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**. Product tests cover the classifier, both gates, stable RRF/logit ties, UTF-8 framing, missing/invalid catalog discovery, service and transport failures, transient refusal codes, client deadlines, fingerprint/epoch/count/non-finite/type/envelope validation, once-per-reason logging, standalone/failed-call byte differentials, visibility, and message-probe/cutoff preservation.

The first broad plugin run had **7807 pass / 27 skip / 11 fail**: 9 bundle tests required remote build artifacts, one SQLite writer timing assertion was affected by parallel load, and an untouched Node WASM fixture could not resolve `onnxruntime-web/webgpu` from its temporary output. After `bun run build`, isolated product/bundle/writer tests passed **40 / 2 skip / 0 fail**. The full Pi suite had **2063 pass / 32 skip / 1 fail**, a 3.9 s versus 3.15 s automatic-search wall-clock assertion under parallel load; that file passed all **3** tests in isolation. CLI had **640 pass / 2 skip** in its main subprocess and **9 pass / 1 fail** in doctor repair tests; the untouched real `.recover` corruption-salvage test failed on the runner's SQLite environment. These failures are not rewritten or hidden as green suites.

One Linux request was refused with `queue_wait_exceeded` (all 64 remote permits held). It was requeued after non-build work, not run locally. Package scripts' frozen installs changed no manifests or lockfiles. AFT diagnostics were authoritative for the touched scope with no errors or warnings, but graph-based categories were unavailable; project typechecks are the authoritative gate.

Final static gates: `bun run typecheck` passed all four package projects; `bun run typecheck:ctx-search-benchmark` also typechecks the new measurement runner and product tests. `bun run lint` checked **1842 files** successfully (existing warnings remain), `bun run lint:ctx-search-benchmark` checked **5**, and the product runner's separately scoped Biome check checked **1**. `bun run test:ctx-search-benchmark` passed **23 tests / 51 assertions**. The final product and existing search tests passed **69 tests / 211 assertions**, including all **26** new reranking tests after restoration of both controls. The Linux build completed all three package builds and checked 9 unchanged generated TUI files. Rust tests were not run because no Rust code changed.

### Mutation controls

Both controls used a staged implementation, an initially empty `git diff --stat`, a captured nonempty mutant diff, and `git checkout -- <path> && touch <path>` restoration to an empty diff. No mutant is committed.

| Control | Expected and actual sole red test | Other tests |
|---|---|---|
| Return the RRF pool on an external `queue_full` refusal | `queue_full retains arm A rather than fused order` | **25 green**, including `classifier gate and auto-search never contact Synapse`, `returnedError validation retains arm A`, and `standalone and every failure return byte-identical results and formatted output` |
| Remove the prose predicate from explicit-search service gating | `classifier gate and auto-search never contact Synapse` (expected 0 service calls, received 5) | **25 green**, including `queue_full retains arm A rather than fused order`, both classifier tests, and `standalone and every failure return byte-identical results and formatted output` |

Applied diff pairs: `search-rerank.ts`: **1 file, 2 insertions → empty**; `search.ts`: **1 file, 2 insertions / 1 deletion → empty**. Restored final tests were green, so the gate and fallback assertions were exercised rather than merely passing on inactive paths. Comment review examined 15 source/prose files; the two remaining JSON files contain data/configuration rather than comments. Unclear new comments were rewritten.
