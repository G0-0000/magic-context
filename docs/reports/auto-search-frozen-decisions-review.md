# Auto-search frozen-decision cache-safety review

## Scope and verdict

Reviewed `87c241cbb8bd87a4d658a2e0148675f7f3bba925..6c162642ac59a2688dbbc43a20b0b8f9c024811c`, including the change in `d4f5412c61` that saves a no-hint decision when search throws, and the hooks in `6c162642` that delete decisions only after summarized raw history is removed. This is a report-only change. No production code, existing tests, architecture document, or structure document is changed.

The requested contract is: a user message that has been served never gains or changes a `<ctx-search-hint>` later, and the persisted decision blob stays bounded. Terminology used below:

- A **decision** saves either the exact hint text or a **no-hint omission** for one stable user-message ID.
- **m[0]/m[1]** are the injected history/memory prefix messages, separate from the hint appended to the user's text.
- An **applied cut** removes raw prefix messages because an injected summary covers them. **Retirement** deletes those messages' saved decisions; hiding a branch does not prove its messages are permanently gone.
- A **defer** pass replays the cached prefix without a newly priced prefix rewrite. The **live tail** is the last message in the current request array; fresh hints are restricted to a user at that position.
- **CAS** means compare-and-swap: update only if the stored blob still equals the value just read. Exhaustion means the bounded retry loop never changed a row. **LKG** means a validated last-known-good request snapshot.
- A test **reddens** when an intentional mutation makes its assertion fail; **green** means it passes.

**Do not treat the unconditional contract as proved.** Healthy durable writes preserve the tested user bytes, and applied-cut retirement passes the reconstructed ten controls. There is a reproducible exception-plus-failed-publication hole on all three adapters. The blob is bounded by the retained decision set, not by a fixed session limit; hidden/restorable branches and cuts whose old IDs are never presented can retain arbitrary amounts of state. Retirement also introduces synchronous writes on defer replay, although the tested m[0]/m[1] bytes do not change.

Evidence is adapter/pipeline-level, with real throwaway SQLite databases and stubbed search results. OpenCode 1 and 2 use their respective harness identities through the shared TypeScript runner; Pi uses its own runner/injector. No authenticated provider request or interactive host session was run. The randomized operations below exercise runner and prefix APIs, not the complete native host lifecycle; in particular, `execute` is a pass label, not a complete scheduler execution. Full package suites supply broader integration coverage. These limitations matter when interpreting revert and timing claims.

## Findings by severity

### High — Failed publication of the error omission permits a later hint

**Locations:** `packages/plugin/src/hooks/magic-context/auto-search-runner.ts:278-300,360-369`; `packages/pi-plugin/src/auto-search-pi.ts:361-387,459-471`; `packages/plugin/src/hooks/magic-context/pass-outcome.ts:46-54`; `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:3777-3802`; `packages/pi-plugin/src/context-handler.ts:5427-5466`.

The new catch freezes `no-hint/error` only when persistence succeeds. On CAS exhaustion, OpenCode's writer returns `cas-exhaustion` without retaining a process-local omission; Pi's writer returns without persisting or caching one. A thrown persistence error is also caught as optional auto-search degradation by the callers. These outcomes do not necessarily refuse the pass: OpenCode classifies them as `served`, and Pi logs the auto-search failure and continues. Thus the user can be served without a decision, then searched again when the same ID is the live tail on a retry/revert. A successful later search appends `<ctx-search-hint>`.

**Failing independent tests, on commit `6c162642` without production-source mutations:**

- `review exception CAS failure still freezes served omission opencode`
- `review exception CAS failure still freezes served omission opencode2`
- `review exception CAS failure still freezes served omission pi`

The probe installed a throwaway-database `BEFORE UPDATE OF auto_search_hint_decisions` trigger with `RAISE(IGNORE)`, making every conditional update report zero changed rows until the real CAS retry loop exhausts. Search threw once. The first invocation returned plain user bytes and an empty decision array. After dropping the trigger, search succeeded; the same user's bytes gained the hint. OpenCode returned `cas-exhaustion` on the first invocation; Pi returned its unchanged array. The probe run was **1 pass / 3 fail / 14 assertions** (the passing test measured parse cost). No production source was mutated for these failures. This is fault injection into the real storage operation, not a test whose expected bytes are recomputed from the renderer.

The actual successful-publication behavior is a clear improvement over the base. The residual hole also existed for other omission-publication failures; it is an incomplete guarantee, not evidence that ordinary error freezing regressed.

**Recommendation:** Before allowing a fresh unhinted user to be served, either durably retain its omission, retain a guarded fallback with explicitly defined restart semantics, or refuse/replay a safe request if publication cannot be established. A process-local fallback alone cannot prove stability across a reopen after a failed durable write. Add tests to both runner and host outcome suites requiring either stable replay of the omission or refusal when saving that omission fails.

### Medium — Boundedness depends on all retired IDs reaching a cut

**Locations:** `packages/plugin/src/features/magic-context/storage-meta-persisted.ts:1642-1649,1652-1697,1850-1875`; `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:3816-3828`; `packages/pi-plugin/src/context-handler.ts:10103-10120`; the trim sites listed below.

Removing visible-array-whitelist pruning is necessary for branch byte stability. It does not establish an absolute bound. Retirement knows only the IDs supplied by the actually applied prefix cut. There is no count/byte cap or global proof-of-retirement index in the JSON decision store. A branch-hidden decision remains even while the visible branch repeatedly compacts. If the host has already omitted the old prefix, an absent boundary/empty retirement set cannot recover those old IDs for pruning. CAS exhaustion during pruning returns zero and has no later guaranteed sweep either.

The independent retained-branch probe seeded 20,000 valid hidden `no-hint/error` records plus one visible boundary record, materialized a summary, and actually trimmed the visible boundary with `trimPiMessagesToCachedBoundary`. The visible decision retired; **20,000 hidden decisions / 1,328,891 bytes** remained. Reading the resulting blob 200 times took 539.841 ms in that run. Seeding the blob tests the accepted storage shape and cut operation, not a measured 20,000-turn native branch lifecycle. The same filtering algorithm accepts arbitrarily larger retained sets in all hosts.

The existing three 20,000-user tests prove a useful **steady-compaction workload**: every covered ID is presented, 100 users remain live, peak 200 decisions and **46,769 bytes**, and the cut returns to exactly 100 decisions. They do not cover arbitrary hidden branches, native host omission before the hook, failure to prune, or unconstrained uncompacted sessions. Nor does 46,769 bytes constitute a general byte cap: those tests use a chosen 512-character hint payload.

**Recommendation:** State the bound as proportional to all still-restorable decisions unless a stronger host-backed retirement proof is added. Do not fix this by evicting arbitrary hidden IDs: that would reintroduce the cache defect. A hard bound needs a rebuild/retirement policy for hidden branches and explicit handling of cuts whose covered IDs are unavailable.

### Medium — Defer replay is no longer read-only at the prefix trim

**Locations:** `packages/plugin/src/hooks/magic-context/inject-compartments.ts:3811-3935,3976-3990`; `packages/pi-plugin/src/inject-compartments-pi.ts:176-304,855-890,2661-2691,2748-2775,3058-3077`; `packages/plugin/src/features/magic-context/storage-meta-persisted.ts:1652-1697`.

Yes, these hooks can write on defer. They are gated by successful summary-prefix removal, not by `isCacheBustingPass` / `recomputeM1ThisPass`. An independent SQLite trigger counted **one decision-column UPDATE** during cached-prefix injection with `isCacheBustingPass=false` in OpenCode 1/2 and `recomputeM1ThisPass=false` in Pi. Each test also compared the actual returned/injected m[0]/m[1] text against the previously cached pair: bytes stayed identical. The dedicated Pi prepared-prefix replay witness likewise preserved its prefix while retiring only the covered ID.

The hooks do **not** run inside `materializeM0` / `materializeM0Pi`'s rendering transaction: OpenCode calls them during the subsequent trim/injection, and Pi calls them in cached/early/final trimming. Materializing a summary or preparing a replay with an empty message array does not by itself retire the user's decision. But they are on the foreground prefix-delivery path, so they can change timing and failure behavior. A nonempty retirement set causes a row-existence read, full blob read/parse/filter, serialization when changed, and an autocommit CAS UPDATE, potentially repeated on a conflict.

There is no new broad `BEGIN IMMEDIATE` around the helper, so this is not evidence of a longer m[0] materialization transaction. It **adds a writer statement** and lengthens the foreground SQLite reservation covering the whole pass (`shared/sqlite.ts:876-904`; Pi wrapper `pi-context-refusal.ts:238-245`). If an enclosing caller already holds a transaction, the extra work would run inside that caller's scope. No contested-lock wall-clock benchmark was performed, so there is no numeric writer-hold regression claim. SQLite busy thrown by pruning can escape injection and take managed LKG/refusal handling; CAS exhaustion merely leaves decisions behind.

**Recommendation:** Document defer retirement as a deliberate storage mutation, and consider a separately guarded, retryable cleanup path if foreground delivery latency/read-only replay is a requirement. Preserve the proof of the applied cut if cleanup is delayed.

### Low — Timeout skip memory is not retired by these durable hooks

`auto-search-deadline.ts:21-72` keeps per-session/per-database skipped turns in a process-local map. The new prune helper removes only the durable JSON entries. Per-message retirement does not clear that map; session cleanup does. This is pre-existing process-local machinery, not a newly introduced blob format. It reinforces that the 20,000-user durable-blob witnesses are not a total-memory bound.

## 1. Served-byte verification

An independent disposable fixture ran **4,000 seeded transitions per host** (`xorshift32`, seed `0xc0ffee`), 1,240 distinct user IDs, with a search hint whose content changed on every actual search. Each replay began from newly constructed raw user objects; expected bytes were the saved first-serving serialization, not another rendering calculation. Each pass also asserted that the actual prefix pair was unchanged by auto-search. Disk reopen discarded process caches. HARD/model transitions called the real materialization API.

The operation counts per host were: append 382, defer 405, execute 367, HARD 397, model switch 411, revert 371, branch restore 371, reopen 439, exception 416, timeout 441. Revert/branch operations restored a randomly chosen prior ID as the raw tail. Timeout operations supplied the runner's `null` timeout sentinel; actual 3-second deadline/abort tests also passed in the restored runner suites. These random sequences deliberately did not retire their live decisions; the separate cut tests cover retirement. Search itself was mocked; SQL persistence and prefix rendering were real.

Result: three replay tests and the retained-branch probe passed, **20,282 assertions**, no byte drift. This does not subsume the publication-failure tests above.

Ordinary-pass differential comparison replaced only the five relevant production modules with their `87c241cb` versions in this same worktree, ran the same seeded workload with exceptions/timeouts converted to ordinary empty-result searches, then restored the target from the staged index. Both revisions emitted the same per-host user-byte SHA-256 stream:

| Host | Target and base SHA-256 |
| --- | --- |
| OpenCode 1 | `5381de6112f31922832c59abe2f5e8694cbc26a04de330263761bbfad291eda6` |
| OpenCode 2 | `5381de6112f31922832c59abe2f5e8694cbc26a04de330263761bbfad291eda6` |
| Pi | `e66f44a1971f3d2ec9a43e376b29966d2470999e4bca2b1efff5f00f7cadbfc9` |

Each differential run was **3 pass / 0 fail / 20,280 assertions**. These hashes cover user objects, not a complete provider request. Prefix pairs were compared before/after each pass, not hashed across revisions. There was no full native-host or scheduler byte differential.

## 2. Retirement safety

| Case | Observation and boundary of the claim |
| --- | --- |
| Complete applied OpenCode cut | Source-order path prunes after replacing the live array, using IDs through the validated boundary. Fallback uses IDs returned by the actual splice. |
| Partial OpenCode user boundary | The boundary survives and is excluded from the retirement set. The specific partial-boundary witness reddened when it was included. |
| Partial Pi user boundary | `preserveBoundary` returns before trimming or calling retirement; Pi conservatively retains the whole prefix to avoid losing split tool pairs. |
| Refused/missing cut | OpenCode refusal/absent-boundary and Pi missing-cutoff paths do not call retirement. The premature-prune mutation reddened the refusal witness. |
| Cached boundary | Uses the same proof/partial checks. Early cached Pi and prepared cached Pi both have red/green witnesses. Only IDs removed at/before the cutoff retire; tool-pair cleanup after it is excluded. |
| Marker queued, not applied | Queuing/publication alone does not invoke these hooks. A materialized/prepared summary can exist while the decision remains; retirement needs actual prefix removal. An independently valid older cached cut can still retire its own covered IDs on that pass. |
| Prune CAS failure | Trim can remain applied while no decision is removed; this conservatively retains bytes but weakens boundedness. |
| Prune throws / injection fails | Managed OpenCode treats m0/m1 injection failure as request-changing degradation and uses validated LKG or refusal, not arbitrary raw fallthrough. Pi has corresponding guarded refusal/LKG handling. Durable pruning is not an atomic commit with provider delivery. |
| Confirmed host deletion / session clear | Explicit per-ID removal and durable session deletion remain; the reconstructed deletion and clear mutations both failed their exact witnesses. |

**Revert past an applied summary boundary:** A *genuinely re-served* earlier raw message requires replacing the summarized request prefix. A new hint on that rebuilt request adds no additional loss of the old prefix cache; it is acceptable under a **prefix-generation-scoped** freeze contract, not under a literal eternal “this ID can never change bytes” contract. The latter and summary retirement are incompatible. The acceptable exception must be stated explicitly.

Do not infer that every native revert automatically rebuilds from the comments alone. OpenCode's `repairMissingHistoryBoundary` clears the persisted pair and in-memory caches when the host store proves a recorded boundary is gone (`history-boundary-repair.ts:111-159,182-216,233-251`). A boundary still present, or an unknown lookup, does not force this repair. OpenCode 2 schedules refresh/materialization for the proven repair (`v2/hooks/context.ts:1796-1812`). If the old complete boundary still applies, reinjection trims the earlier raw rows, so they are not actually re-served. If a host can bypass that cut and re-serve raw earlier rows without invalidating/rebuilding the prefix, a new hint would be a defect. That native-host invariant was not proved by the adapter fuzz run; the existing “revert” exception tests only re-present a still-live user, not a retired user across a real native cut.

## 3. Cost and boundedness measurements

The real `getAutoSearchHintDecisions` reader executes a SELECT, JSON parse and validation on each call, followed by caller scans for the target ID. It has no decoded-blob memoization in this path. CAS append/prune also processes the complete blob. With retained size D and serialized bytes B, per-call reading/filtering is O(D + B); repeated append without retirement does growing full-array work, potentially quadratic over the session.

The independent benchmark seeded valid records (one-third 512-character hints, two-thirds omissions), warmed ten reads, then executed 200 real storage reads. Linux Bun 1.4.2; timings are single-run observations, not a CI performance threshold:

| Decisions | Serialized bytes | 200 reads, ms | ms/read |
| ---: | ---: | ---: | ---: |
| 100 | 23,459 | 7.482 | 0.037 |
| 1,000 | 232,559 | 41.813 | 0.209 |
| 5,000 | 1,165,725 | 195.108 | 0.976 |
| 20,000 | 4,675,725 | 1,335.889 | 6.679 |
| 50,000 | 11,705,725 | 3,410.976 | 17.055 |

The steady-compaction 100/200-decision case is cheap. The retained-branch case is not constant-cost, and a pass may read/process the blob more than once. These measurements include SQLite retrieval and validation, not just `JSON.parse`, and do not measure peak heap or writer contention.

## 4. Mutation audit: ten reconstructed controls and two independent controls

The ten mutations were **reconstructed from the author's descriptions supplied to this review**. Those descriptions named each mutation, affected file and expected failing test; the original saved patches were unavailable. Every mutation used `NON-VACUITY BREAK`. Before mutating, the specific product files were staged and `git diff --stat` was empty. The applied diff was captured, each named test was run in isolation, then `git checkout -- <path> && touch <path>` restored the staged target and the working diff was again empty. The index retained the reviewed target throughout. No mutation remains.

All ten reconstructed controls reddened. Each isolated run was **0 pass / 1 fail** with no other executed failing test; other tests were filtered out, not counted as successful negative controls. The final restored suites ran those surrounding tests too. The table records the exact failing test name and substantive failure, rather than merely a red command exit.

| # | Mutation / product file | Exact red witness | Observed failure | Applied diff; restored diff |
| --- | --- | --- | --- | --- |
| 1 | Disable OpenCode trim retirement; `inject-compartments.ts` | `opencode applied compaction bounds auto-search blob across 20000 user messages` | First cut still retains user-1 through user-100 | 1 file, +1/-1; empty |
| 2 | Same mutation, second host | `opencode2 applied compaction bounds auto-search blob across 20000 user messages` | Same 100 extra retired IDs | same applied +1/-1; empty after both isolated runs |
| 3 | Disable Pi trim retirement; `inject-compartments-pi.ts` | `pi applied compaction bounds auto-search blob across 20000 user messages` | Same 100 extra retired IDs | 1 file, +1/-1; empty |
| 4 | Disable early cached-cut callback; `inject-compartments-pi.ts` | `pi cached boundary prunes decisions only after a complete prefix trim` | `covered` remains after complete cut | 1 file, +1/-1; empty |
| 5 | Use retired IDs as a visible whitelist; `storage-meta-persisted.ts` | `magic-context storage > prunes only proven retired auto-search ids and preserves hidden live decisions` | Pruned count 2 instead of 1 | 1 file, +1/-1; empty |
| 6 | Include partial user boundary in retirement; `inject-compartments.ts` | `prepared prefix source-order trimming > applied prefix pruning preserves the decision on a partially covered user boundary` | Live `partial` decision missing | 1 file, +1/-1; empty |
| 7 | Prune before proof/application; `inject-compartments.ts` | `prepared prefix source-order trimming > refused prefix trim does not prune auto-search decisions` | `before` and `after` decisions disappear on refused cut | 1 file, +1/-0; empty |
| 8 | Ignore partial Pi boundary; `inject-compartments-pi.ts` | `pi cached boundary prunes decisions only after a complete prefix trim` | Partial trim removes 1 instead of 0 | 1 file, +1/-1; empty |
| 9 | Skip confirmed removal cleanup; `event-handler.ts` | `createEventHandler > prunes only sticky-injection anchors for the removed message` | Deleted `msg-note` hint remains | 1 file, +1/-5; empty |
| 10 | Skip durable session deletion; `storage-meta-session.ts` | `magic-context storage > session clear retires auto-search decisions without clearing another session` | Cleared session still has its hint | 1 file, +1/-3; empty |
| 11, independent | Remove error-omission persistence from both `auto-search-runner.ts` and `auto-search-pi.ts` | All twelve names below | Same served user acquires `Independent search-only hint` | 2 files, +2/-3; empty |
| 12, independent | Disable only prepared cached-prefix retirement; `inject-compartments-pi.ts` | `review Pi prepared cached replay retires only the applied prefix` | `covered` survives although raw cut and cached prefix bytes succeed | 1 file, +1/-1; empty |

Control 11 ran **twelve separate isolated commands**, each 0 pass / 1 fail. Exact witnesses:

- `opencode search exception preserves served user bytes after defer`
- `opencode search exception preserves served user bytes after revert`
- `opencode search exception preserves served user bytes after model fold`
- `opencode search exception preserves served user bytes after reopen`
- `opencode2 search exception preserves served user bytes after defer`
- `opencode2 search exception preserves served user bytes after revert`
- `opencode2 search exception preserves served user bytes after model fold`
- `opencode2 search exception preserves served user bytes after reopen`
- `pi search exception preserves served user bytes after defer`
- `pi search exception preserves served user bytes after revert`
- `pi search exception preserves served user bytes after model fold`
- `pi search exception preserves served user bytes after reopen`

Control 12 had **1 pass / 0 fail / 4 assertions** before mutation, **0 pass / 1 fail / 4 assertions** with mutation, and passed after restoration as part of the five-test defer/cost run. Its temporary test materialized a complete summary, prepared persisted cached replay, injected that exact prepared head against `[covered, live]`, asserted one raw removal and identical prefix text, then required retained decisions to be exactly `[live, hidden]`. It disables the callback in `injectM0M1Pi`'s prepared-prefix branch, whereas control 4 disables the callback in `trimPiMessagesToCachedBoundary`. Both should remove decisions only for the prefix actually removed. Temporary independent probe files were removed to keep delivery report-only.

**What these controls defend:** applied-cut boundedness for the chosen workload, explicit retired-ID polarity, partial/refused-cut guards, host deletion, session clear, healthy error freezing, and two cached Pi call sites. **What they do not defend:** error-omission publication failures, arbitrary hidden-state bounds, actual native revert/rebuild invariants, or contested writer timing. All controls reddening therefore does not negate the high-severity three-test counterexample.

## 5. Linux verification and failing suite tests

All build/test/typecheck/lint commands ran on the Linux runner with eight allocated CPUs (`runon: "linux,8c"`), waited for completion, and used offline-installed dependencies. Tool versions: **Bun 1.4.2 (744846f84), TypeScript 5.9.3, Biome 2.5.1**. Frozen installs reported **1,013 installs / 1,254 packages, no changes**. No package manifest or lockfile changed.

| Command/check | Result |
| --- | --- |
| `bun run build` | Passed, including plugin v1/v2, Pi and CLI builds; TUI generation checked 9 files and wrote 0 |
| `bun run typecheck` | Passed all four workspace script branches: plugin (including scripts), Pi, CLI and retina-local-fs; TypeScript 5.9.3, exit 0 |
| `bun run lint` | Passed, Biome 2.5.1; plugin 1,379 files, Pi 303, CLI 138, retina-local-fs 6; existing warnings/info, no errors |
| `bun run --cwd packages/plugin test` under approved fixture-selected DB isolation | 7,717 pass / 27 skip / 10 fail; 7,754 tests across 781 files |
| `bun run --cwd packages/pi-plugin test` under approved fixture-selected DB isolation | **1,982 pass / 28 skip / 0 fail**; 2,010 tests across 204 files, 108,380 assertions |
| Build and rerun the failed plugin bundle/WASM files **in the same remote job** | **9 pass / 2 skip / 1 fail**, 12 tests across 2 files, 50 assertions; all nine worker failures below resolved |
| Restored plugin targeted suite: `auto-search-runner`, `inject-compartments`, `transform-postprocess-phase`, `event-handler`, `storage` | **474 pass / 0 fail**, 5 files |
| Restored Pi targeted suite: `auto-search-pi`, `inject-compartments-pi`, `context-handler` | **259 pass / 0 fail**, 3 files, 22,108 assertions |
| Independent randomized replay and retained-branch probe | 4 pass / 0 fail; 20,282 assertions |
| Base and target ordinary differential probes | 3 pass / 0 fail each; 20,280 assertions each |
| Restored independent defer/prepared/cost probes | 5 pass / 0 fail; 23 assertions |
| Independent omission-publication-failure probes | **3 expected property failures** on the unmutated target; see high-severity finding |

The plugin full-suite ten failures, before the same-job built rerun, were:

1. `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`
2. `review bundle: opencode worker under bun loads, restarts, reads only and shuts down`
3. `review bundle: opencode worker under node loads, restarts, reads only and shuts down`
4. `review bundle: opencode2 worker under node loads, restarts, reads only and shuts down`
5. `review bundle: pi worker under node loads, restarts, reads only and shuts down`
6. `review bundle: omp worker under node loads, restarts, reads only and shuts down`
7. `review bundle: packed opencode worker under bun loads, restarts, reads only and shuts down`
8. `review bundle: packed opencode2 worker under node loads, restarts, reads only and shuts down`
9. `review bundle: packed pi worker under node loads, restarts, reads only and shuts down`
10. `review bundle: packed omp worker under node loads, restarts, reads only and shuts down`

Failures 2–10 were missing `dist/auto-search-worker.js`, the built worker entry point loaded by these packaging tests: remote build products do not survive into the next remote job. Building and rerunning those exact files in one job made **all nine pass**. Failure 1 remained: the temporary Node WASM bundle could not resolve `onnxruntime-web/webgpu` outside the package tree. This is the unrelated failure already reported in `6c162642`'s commit message, not a frozen-decision assertion. No product fix was attempted. The full plugin suite was not rerun a third time; the repaired nine failures were verified narrowly after building.

The initial strict-global-environment run also passed build/typecheck/lint but produced plugin **7,489 pass / 27 skip / 238 fail** and Pi **1,836 pass / 28 skip / 146 fail**. Those results are not used as product regressions: global `OPENCODE_DB` overrode fixtures' own XDG databases, and isolated HOME omitted Git trust for the remote checkout. The reviewer explicitly approved the unit-suite adaptation below, and the full suites were rerun. These initial false failures are disclosed rather than silently omitted.

## Live-store isolation and cleanup

The review brief's isolation requirement, verbatim: **never open/read/write/migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof`. Clean up.**

The disposable wrapper set HOME as well as all named directories beneath `$TMPDIR/magic-context/bg_7e0e222a86789aab/<run>/`; TMPDIR was also placed beneath that root so fixtures using `tmpdir()` stayed disposable. Strict probe runs included explicit `OPENCODE_DB=<root>/data/opencode/opencode.db`. The approved **package-unit-suite exception** omitted only `OPENCODE_DB`, allowing fixtures' own isolated XDG database paths to take precedence, and supplied Git `safe.directory` for this worktree through subprocess environment, not live configuration. The reviewer confirmed this as the standing rule for package unit suites. No interactive real-host run was performed.

A `lsof -nP -p <runner-and-descendant-pids> -Fn` monitor sampled only the launched process family, with a 150 ms wait between samples. It observed actual fixture DB/WAL/SHM files, not just the configured environment. Representative receipts:

```text
random replay:
/motor-home/tmp/magic-context/bg_7e0e222a86789aab/random-zkgks9ah/tmp/mc-test-owned-auto-search-replay-NrZAzB/context.db
/motor-home/tmp/magic-context/bg_7e0e222a86789aab/random-zkgks9ah/tmp/mc-test-owned-auto-search-replay-NrZAzB/context.db-wal
forbidden_live_paths=[]

approved full unit suites:
root=/motor-home/tmp/magic-context/bg_7e0e222a86789aab/unit-final-suites-_34gs5w7
observed_path_count=2786; forbidden_live_paths=[]
.../tmp/clone-session-fixture-WeJZoc/context.db
.../tmp/clone-session-fixture-WeJZoc/opencode.db
ISOLATION_ROOT_REMOVED /motor-home/tmp/magic-context/bg_7e0e222a86789aab/unit-final-suites-_34gs5w7

built targeted suites:
root=/motor-home/tmp/magic-context/bg_7e0e222a86789aab/unit-built-targeted-0hiojxhu
observed_path_count=189; forbidden_live_paths=[]
ISOLATION_ROOT_REMOVED /motor-home/tmp/magic-context/bg_7e0e222a86789aab/unit-built-targeted-0hiojxhu
```

Fast in-memory mutation tests sometimes yielded no DB filename sample; they use `:memory:` and still ran under the same scoped environment/monitor. Sampling is evidence of observed file opens, not a continuous syscall audit. No live-store contents or configuration were accessed. Later wrappers explicitly removed each isolation root after the child exited; earlier probe roots and temporary receipts were discarded with their per-job remote sandbox. Temporary probe/wrapper files were removed from the worktree. The relevant receipts and named failures are captured in this report rather than relying on regenerable `dist`/`target` artifacts or ephemeral remote log paths.

## Minimal reproduction of the high-severity finding

Use `createAutoSearchReplayFixture` from `packages/plugin/src/hooks/magic-context/auto-search-replay.fixture.ts` and `autoSearchTestSnapshot` from the adjacent `auto-search-snapshot.fixture.ts`, under the throwaway environment in the Live-store isolation section. For each host:

1. Stub `getProjectEmbeddingSnapshot` with a ready project snapshot. Stub `searchAutoHint` to throw once and then return `replayHint`.
2. On the fixture DB, install:

   ```sql
   CREATE TRIGGER review_fail_cas
   BEFORE UPDATE OF auto_search_hint_decisions ON session_meta
   BEGIN SELECT RAISE(IGNORE); END;
   ```

3. Invoke the host runner with a fresh raw user tail using stable ID `served`, prompt `Explain cache ownership`, auto-search enabled, minimum length 12, threshold 0.6. Save the returned user's actual JSON serialization. Require no `<ctx-search-hint>` and an empty persisted decision array. For OpenCode, the returned outcome is `cas-exhaustion`.
4. Drop `review_fail_cas`. Reconstruct the same raw user and stable ID and invoke the runner again. Require `secondBytes === firstBytes`.
5. Step 4 fails on all three adapters: the second serialization includes `Independent search-only hint` in `<ctx-search-hint>`. Close and remove the fixture.

The trigger forces the actual CAS helper's exhausted-return path rather than replacing the persistence function with a mock. Caller source tracing establishes that this optional failure can still be served; the probe itself does not send a provider request. The error-omission publication-failure scenario is the next regression test to add when implementing a product fix.
