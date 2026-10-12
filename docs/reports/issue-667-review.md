# Issue 667 fix: independent review

Scope: `master...159a563ffb` (merge base `dda49e3850`). The product change is `packages/pi-plugin/src/pi-context-refusal.ts` (the OMP dispatch fence added for issue 641) and one line in `packages/pi-plugin/src/context-handler.ts`. This review is report-only. It adds tests and probes and changes no product code.

Terms follow `docs/reports/issue-667-superseded-fence.md`. A **pass** is one `context` hook invocation (`PiContextBudget`). An **operation** is the fence's per-session record of the latest pass and its receipt state. A **receipt** means that pass returned managed messages in time. The **fence** is the synchronous `before_provider_request` hook.

## Verdict

* **The reported bug is fixed.** On both OMP 18.7.0 and 18.8.6, the late-`agent_end` and retry orderings that refuse with `Pi context pass superseded before writer admission` on the baseline guard and on the released npm 0.48.0 build are admitted with the fix. Every request carries the managed result.
* **No ordering found admits an unmanaged request on a real host.** All 24 host runs (12 reruns of the worker's probes, 12 new adversarial runs) captured only requests carrying `§N§` tags or the guard's `MANAGED667` marker.
* **One Medium finding (F1).** The rule "attribute an end by the pass's input" does nothing in production. The real handler rewrites the context event's message array in place, and the fence reads that array only later. So the run's **own** `agent_end` no longer invalidates a completed receipt whose request was never sent. The next run's `agent_start` then adopts that receipt. The "opposite failure" property in the brief is therefore not met. This was witnessed on both real hosts and as a unit test. No OMP 18.7/18.8 request path was found that exploits it.
* **Claims 2–5 hold** as stated, with the caveats in the claim table.
* **Mutation controls.** The 7 worker controls reproduce, with one miscount (M1 also reddens test 3). They leave three load-bearing lines undefended: R1, R2 and R3 below. The new tests defend all three.

## Findings by severity

### Medium — F1: an ended run's undispatched receipt survives its own `agent_end`

**Mechanism.**

1. `registerPiGuardedContext`'s `context` hook stores the event object itself: `active.input = event` (`pi-context-refusal.ts:335`).
2. `endBelongsToEarlierRun` reads `operation.input.messages` only when an `agent_end` arrives (`pi-context-refusal.ts:79-100`, read at `:85`). It returns true when any input message's `role:timestamp` is missing from the ended run's messages (`:96-99`).
3. The real handler changes that same array in place before the end arrives:
   * `runPipeline({ messages: event.messages, ... })` at `context-handler.ts:5203`, which the comment at `context-handler.ts:10215-10218` documents as structural mutation;
   * `stripMcOwnedPiCompactionSummary(event.messages, ...)` at `:4409` and `trimPiMessagesToCachedBoundary(..., event.messages, ...)` at `:4424`;
   * `prependM0M1Messages` builds two synthetic `role: "user"` messages stamped `baseTimestamp - 2` and `- 1` (`inject-compartments-pi.ts:2648-2655`), and `messages.splice(insertionIndex, 0, ...head)` inserts them (`:2699-2701`);
   * the todo and system-entry steps insert synthetic messages too (`pi-todo-inject.ts:196,229`, `system-entry-pi.ts:78,266`).
4. OMP's extension `agent_end` carries a copy of the agent's state messages (`agent-session.ts:4052` and `:4934` on 18.7.0, `:4089` and `:4963` on 18.8.6). That copy never contains Magic Context's synthetic messages.

**Measured.** I ran the real `registerPiContextHandler` once with production-shaped options (`injection` is always passed by `index.ts:1512`) on a fresh five-message session with no compartments. It returned the same array object and had prepended `user:998` and `user:999` to it:

* before: `["user:1000","assistant:1001","user:1002","assistant:1003","user:1004"]`
* after: `["user:998","user:999","user:1000",...]`

So in production the input test is always true, and `endBelongsToEarlierRun` reduces to "a pass exists and the fence has not admitted its request yet".

**Consequence.** Take a run whose latest pass completed with managed messages, but whose request never reached the fence: the user aborts after the context result, or OMP fails between the hook and payload construction.

* That run's own `agent_end` is logged as `agent_end attributed to an earlier run; keeping the latest context pass`.
* The operation keeps `ready`, is not marked ended, and gets `started = false`, because the per-session start and end counts are equal (`pi-context-refusal.ts:229-230`).
* The next `agent_start` adopts it (`:208-211`). Until the next run's own context pass replaces it, any request through the payload hook is admitted on the aborted run's receipt.
* Before this change the same end set `ended = true` and such a request was refused.

**Witnesses.**

* **Unit**, `packages/pi-plugin/src/issue-667-review.test.ts`: `issue 667 review: a run that ends before its request goes out invalidates its receipt even when the pass rewrote its input in place`. It is marked `test.failing` so the suite stays green while documenting the gap. Run as a plain `test`, it fails at `expect(h.refusals.at(-1)).toContain("the run that owned the latest context pass has ended")` with `refusals` empty: the dispatch was admitted. With a handler that does not mutate its input (the worker's test 4, second half), the same order is refused.
* **Real host**, `docs/reports/probes/issue-667-review/host.ts abort-before-dispatch`. The probe calls the host's `ctx.abort()` right after run 1's context result returns. OMP sends no request for run 1.

  | Build | 18.7.0 | 18.8.6 |
  |---|---|---|
  | guard bundle (handler maps to a new array) | run 1's end ends the operation; no attribution log line | same |
  | full plugin (real handler) | `[magic-context][pi] agent_end attributed to an earlier run; keeping the latest context pass … stage=LKG/served publication` for run 1's **own** end, with only one run started | same |

  In both builds the follow-up run sends one request, which carries managed markers (`§N§` ×2 for the plugin).

**Exposure.** No request on 18.7.0 or 18.8.6 that reaches the payload hook without a context pass was found to fall into this window:

* Auto-learn capture skips turns that ended in an abort (`autolearn/controller.ts:101-111`). It is also refused by body recognition for Anthropic Messages and OpenAI Responses (issue 663).
* Title and summary requests use neither hook (issue 663 report).

Severity is therefore Medium, not High. The defect breaks the fence's stated contract, and the worker's report states that the input rule protects legitimate ends. That claim was observed only with the guard probe, whose handler does not mutate in place: the probe's audit summarized the input *before* the handler ran.

**Suggested fix (not applied).**

* Snapshot the input's message keys inside the hook's `try`, before calling the handler: for example `const inputKeys = keysOf(event.messages)`. The comment at `pi-context-refusal.ts:30-35` gives the reason for not reading at entry, and reading inside the `try` still turns a throwing getter into a visible refusal.
* Then compare against the snapshot instead of the live array.
* Keep the review test above as the regression, and drop `.failing`.

### Low — F2: three load-bearing lines were undefended by the worker's 6 tests

Measured with the mutation table below:

| Control | Worker's 6 tests | New test that reddens |
|---|---|---|
| R1 drop `\|\| operation.dispatched` in `endBelongsToEarlierRun` | all pass | `a dispatched pass's own run end invalidates its receipt even when the pass rewrote its input in place` |
| R3 drop `active.dispatched = true` in the fence | all pass | the same test |
| R2 `if (lifecycleSeen.starts <= lifecycleSeen.ends)` → `if (true)` | all pass | `a kept continuation pass is not adopted by a later run's agent_start`, `a kept pass whose own start was delivered is not adopted by the next run's start` |

Because of F1, the `dispatched` flag is the only thing that attributes a dispatched run's end to that run in production. R1 and R3 would have let every run's own end be ignored with no test going red.

The worker's report also miscounts M1: it lists tests 1 and 2 as red, but test 3 (`a slow pass refused at dispatch does not refuse the newer pass that replaces it`) is red too. The control is still valid.

### Low — F3: lifecycle counts are never reset (code reading, no witness)

* `lifecycle` (`pi-context-refusal.ts:145-156`) counts `agent_start` and `agent_end` per session for the life of the process. `clearPiContextReceipt` does not clear it.
* If the guard ever sees an end without the matching start, for example when the extension loads during a run, `ends` stays ahead of `starts` permanently. Every later kept end then sets `started = false`.
* The property R2 protects (a new run's start must not adopt an earlier kept receipt) is then lost for that session.

This was not reproduced on a host.

### Info

* **Deliberate post-refusal write.** After a pass is refused, `onRefusal` (`context-handler.ts:6238-6259`) queues one `session_meta.last_transform_error` write on the next macrotask, gated on `isCurrent()`. This is the refused-turn diagnostic, not late handler work. The new late-write test records the store after it.
* **Residual 663 ordering confirmed on real hosts (not a regression).** In `start-before-end` (run 2's start delivered after its context pass and before run 1's late end), the request is refused with `no context pass ran for this operation` on both hosts and both builds. Only managed requests went out.
* **Full plugin: a replaced pass's queued served capture is discarded.** In the `start-before-end` full-plugin runs it is logged as `DISCARDED CONTEXT RESULT: queued served capture Pi context pass superseded before writer admission`. No served numbers are published for a result that was refused. This is consistent with issue 650's pairing.

## The five claims

| # | Claim | Verdict |
|---|---|---|
| 1 | A late `agent_end` from the previous run no longer ends the current run's pass, attributed by `willContinue` or by input | **Holds for the previous run's end** (worker probes and `late-start-end` on both hosts). **Attribution by input does nothing in production** (F1): the rule in force is "not yet dispatched". `willContinue` is redundant whenever the pass is undispatched, and an end after dispatch still ends the operation |
| 2 | The fence judges operation state only and no longer calls `assertOwner()` | **Holds.** Dropping the owner guard loses nothing at the fence. A non-side pass sets `active.pass` synchronously before its handler. A replaced pass cannot set `ready`: `waitMandatory`'s `finally` assert throws `superseded` (`pi-context-budget.ts:98-101`) before `budget.completed = true` (`pi-context-refusal.ts:368-371`). The generation check matters only once a handler has started, and the entry check (claim 5) covers a late start. Side passes never claim the generation (`context-handler.ts:4048`) |
| 3 | A newer pass clears an earlier pass's refusal | **Holds.** The refused pass stays `abandoned`, so the fence still refuses it if it is somehow still the latest. A newer pass must complete in time to be admitted. M7 reddens the worker's test 3 |
| 4 | The 25 s deadline covers the pre-handler reservation | **Holds** (worker test 5, new late-write test, `slow` probe: refused at `elapsed=25003ms`, before OMP's 30 s). See the race analysis below |
| 5 | A handler started after its pass was refused, replaced or ended stops at entry | **Holds** (`context-handler.ts:4043`). Its unique effect is the in-memory generation claim (worker test 6, M5). On the store, the abandoned flag and the elapsed check already stop a late handler at its first guard, so M5 alone leaves the late-write test green |

## The fence's core guarantee: orderings tried

The fence never inspects the request bytes. It admits only when the latest pass is `completed`, `ready`, not refused, not abandoned and not ended (`pi-context-refusal.ts:272-299`). Unmanaged bytes can only be admitted by a payload-hook request that has no context pass of its own and arrives while such a receipt exists.

| Candidate | Result |
|---|---|
| Role/timestamp collision (OMP clones messages) | A collision can only make an input message look like part of the ended run, so the end ends the operation: conservative. The real failure runs the other way: synthetic keys never collide (F1) |
| `willContinue` end, then a run that never continues | It only keeps an *undispatched* latest pass, the same exposure as F1. The kept pass can be adopted by the next start when the counts are equal. Bounded by the next context pass |
| Late `agent_start` | `late-start-end` (start after the late end): adopted, 2 managed requests, 0 refusals, both hosts and builds. `start-before-end`: refused, `no context pass ran`, 1 managed request |
| Side turns under the issue 641 latch | The fence returns before any check (`:256`), so `dispatched` is never set for latched sessions. Unchanged behaviour: the latch already admits everything |
| Two passes for the same run | The replaced pass's `finally` assert throws `superseded`, so it cannot set `ready`. The fence reads only the latest pass |
| A pass returns managed output, then its run ends before dispatch | **F1**: the receipt survives the end (unit witness, `abort-before-dispatch --full-plugin` log) |

## The deadline race (claim 4)

* **Wrapper.** `budget.waitMandatory(Promise.resolve(withSqliteTransformPass(...)))` (`pi-context-refusal.ts:363-367`) sets its timer to the pass's remaining outcome time, measured on the same clock as every guard.
* **On expiry while the pass is current**, `refuse(..., isOwned)` sets `abandoned = true` and aborts. If the pass was replaced or ended, the error is logged as discarded and the owner guard stops further work. A late rejection of the handler is absorbed by `Promise.race`, so no rejection goes unhandled.
* **Late handler.** It stops at entry (`assertOutcome`). Any earlier-started handler stops at its next `assert`, `assertOutcome` or `assertOwner`, or at the `assertTransformWrite` guard attached to the still-active transform lease (`context-handler.ts:4071`, `sqlite.ts:912-920`).
* **New test** `a pass refused while waiting for its SQLite reservation writes nothing once its handler finally starts`:
  1. Hold the pass behind a real index chunk.
  2. Let the wrapper's race refuse it.
  3. Record every table's row count plus the `session_meta` rows, after the deliberate diagnostic.
  4. Move the clock *back* to 1 s, so neither cutoff stops the late handler and only the refusal can.
  5. Release the chunk and wait 200 ms.
  6. Assert nothing changed.

  It reddens when the abandoned flag is removed from `refuse()` (R4). Without the clock step, the 21 s work cutoff alone stopped the handler and the test could not observe the flags. That earlier version was found vacuous under R4+M5 and rewritten.
* **Issue 640 writer wait.** `writerAllowance()` (`pi-context-budget.ts:51-59`) uses the same clock, so time spent in the reservation reduces writer admission, down to 0 past 19 s.
* **Issue 650 pairing.**
  * Served-capture publication goes through `assertDecisionPublication` (`pi-context-budget.ts:73-77`). For an incomplete pass it checks the owner, and it refuses abandoned or expired passes.
  * A refused pass never sets `completed`, so nothing is paired for it.
  * Real-host logs show a replaced pass's queued served capture discarded (Info above).
  * The issue 640/641/650 suites pass in the full run.
* **Not covered.** No test pins the store when the race fires while a handler is mid-pipeline at an *unguarded* await. Inner guarded awaits share the same deadline, and the outer timer is registered first.

## Real hosts

* Pinned under ignored `.cache/issue-667/`: `@oh-my-pi/pi-coding-agent` 18.7.0 and 18.8.6.
* Bun 1.4.2, macOS arm64.
* Baseline guard bundle built from `dda49e3850`'s `pi-context-refusal.ts`; npm `@cortexkit/pi-magic-context@0.48.0` `dist/` unpacked under ignored `packages/pi-plugin/.cache/`; full-plugin runs use this branch's `packages/pi-plugin/dist/index.js`.
* Receipts for all 24 runs: [`issue-667-review-host-receipts.json`](issue-667-review-host-receipts.json).

**Worker probes, rerun** (`docs/reports/probes/issue-667/host.ts`):

| Run | Host | Requests (all managed) | Visible refusals |
|---|---|---|---|
| `late-end` fixed / baseline | 18.7.0 | 2 / 1 | 0 / 1 `elapsed=4ms … (Pi context pass superseded before writer admission)` |
| `late-end` fixed / baseline | 18.8.6 | 2 / 1 | 0 / 1, same text (`elapsed=5ms`) |
| `retry` (`MC667_FAILS=11`) fixed / baseline | 18.7.0 | 12 / 11 | 0 / 1, same text |
| `retry` fixed | 18.8.6 | 12 | 0 |
| `late-end --full-plugin` fixed / **npm 0.48.0** | 18.7.0 | 2 (`§N§` 1, 3) / 1 | 0 / 1 `elapsed=36ms … superseded …` |
| `late-end --full-plugin` fixed | 18.8.6 | 2 (`§N§` 1, 3) | 0 |
| `slow` fixed / baseline | 18.7.0 | 1 / 0 | 1 (`stage=entry elapsed=25003ms`) / 2 (`elapsed=30033ms`, then `superseded` on the resend) |

**New adversarial orderings** (`docs/reports/probes/issue-667-review/host.ts`). Holds are numbered per handler registration, because the full plugin registers several lifecycle handlers.

| Mode | Build | 18.7.0 | 18.8.6 |
|---|---|---|---|
| `late-start-end`: ctx 2 → late end 1 → late start 2 → dispatch | guard | 2 req (MANAGED667), 0 refusals | same |
| | full plugin | 2 req (`§N§` 1, 3), 0 refusals | same |
| `start-before-end`: ctx 2 → late start 2 → late end 1 → dispatch | guard | 1 req (managed), 1 refusal `no context pass ran for this operation` | same |
| | full plugin | 1 req (`§N§` 1), same refusal | same |
| `abort-before-dispatch` | guard | 1 req (managed); own end ends the operation | same |
| | full plugin | 1 req (`§N§` 2); **own end "attributed to an earlier run"** (F1) | same |

**Isolation.**

* Every run sets `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/issue-667{,-review}/`.
* The probe extension runs `lsof -p <host pid>` at every `agent_start`, and the driver runs it again before shutdown. Either check fails the run unless every `.db` descriptor is under the run's root.
* All 24 runs passed: 22–25 `.db` descriptors each, all under the throwaway root, and no path under `~/.local/share/{opencode,cortexkit}` or `~/.config/{opencode,cortexkit}`. Paths are in the receipts file.

## Tests and mutation controls

New file `packages/pi-plugin/src/issue-667-review.test.ts` (5 tests, one `test.failing` witness).

Each control was applied to a copy of the committed file, with a non-empty `git diff --stat` during the run. It was restored from a backup copy, and `git diff --stat` for the mutated file was empty afterwards. The runs were on Linux. Red tests are named below; every other test in both files stayed green.

| Control | Red |
|---|---|
| M1 `endBelongsToEarlierRun` always false | worker 1, 2, 3; review witness (it now passes, so `.failing` reports red), review 3, 4 |
| M2 ignore `willContinue` | worker 2; review 3 |
| M3 no late-start adoption | worker 1 |
| M4 no outcome race | worker 5, 6; review 5 (times out before its write assertion) |
| M5 no handler entry check | worker 6 |
| M6 the fence calls `assertOwner()` | worker 4; review 2 |
| M7 a newer pass inherits the refusal | worker 3 |
| R1 drop the `dispatched` check | review 2 only |
| R2 always mark kept passes unstarted | review 3, 4 only |
| R3 never record dispatch | review 2 only |
| R4 `refuse()` does not set `abandoned` | review 5 only |
| R4+M5 | worker 6; review 5 |

## Gates (Linux, `runon linux`)

| Gate | Result |
|---|---|
| Full Pi suite: `bun run test` in `packages/pi-plugin` (Bun 1.4.2; throwaway `HOME`/XDG/storage, `OPENCODE_DB` unset, command-local `safe.directory` override as in the worker's run) | **2,038 pass / 28 skip / 0 fail**, 2,066 tests in 209 files, 156,108 assertions (the worker's 2,033 plus these 5) |
| Pi typecheck: `bun run typecheck` (TypeScript 5.9.3) | exit 0 |
| Probe typechecks: `tsc --noEmit` on both probe `tsconfig.json` files | exit 0 |
| Pi lint: `bun run lint` (Biome 2.5.1) | 309 files, 0 errors, 49 existing warnings. The first run flagged one format error in the new test file, since fixed. The probe directories under `docs/` are outside the lint scope; the new probe was formatted with Biome and has warnings only |

## Reproduce

```sh
for v in 18.7.0 18.8.6; do
  mkdir -p .cache/issue-667/host-$v
  printf '%s\n' "{\"private\":true,\"dependencies\":{\"@oh-my-pi/pi-coding-agent\":\"$v\"}}" > .cache/issue-667/host-$v/package.json
  bun install --cwd .cache/issue-667/host-$v
done
bun build docs/reports/probes/issue-667/guard.ts --outfile .cache/issue-667/guard.mjs --target node
bun run --cwd packages/pi-plugin build
MC667_HOST=18.7.0 bun docs/reports/probes/issue-667-review/host.ts abort-before-dispatch --full-plugin
MC667_HOST=18.7.0 bun docs/reports/probes/issue-667-review/host.ts late-start-end [--full-plugin]
MC667_HOST=18.7.0 bun docs/reports/probes/issue-667-review/host.ts start-before-end [--full-plugin]
# Worker probes: see docs/reports/issue-667-superseded-fence.md, section 5.
cd packages/pi-plugin && bun test src/issue-667-review.test.ts src/issue-667-superseded-fence.test.ts
```
