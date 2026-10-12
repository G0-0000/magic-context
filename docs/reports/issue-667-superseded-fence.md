# Issue 667: a superseded-pass error refuses the current OMP turn

## Summary

The refusal the reporter saw is a mislabel, not a supersession. On a real Oh My Pi (OMP) host, `@cortexkit/pi-magic-context` 0.48.0 refuses a turn with `(Pi context pass superseded before writer admission)` whenever the previous run's `agent_end` notification reaches Magic Context after the next run's context pass, and before that pass's request is dispatched. Nothing superseded the pass. The dispatch fence asked the current pass's ownership guard whether it still owned the operation. The guard said no only because the late `agent_end` had marked the operation ended. Meanwhile the fence's own currency check compared map identity only, so it saw the operation as current and took the notify-and-abort branch.

A second path produces the same text. A pass that waited in the foreground SQLite reservation past its deadline could start its handler late and claim the session's pass generation, which made the newer pass "superseded".

Both paths are fixed, together with two budget gaps. The pass budget now covers the reservation wait. A newer pass no longer inherits an earlier pass's dispatch refusal.

Terms: a **pass** is one invocation of Magic Context's `context` hook (`PiContextBudget`). An **operation** is the fence's per-session record holding the latest pass and its receipt state. A **receipt** means the latest pass returned managed messages in time. The **fence** is the synchronous `before_provider_request` hook that aborts any request without a receipt. It was added for issue 641; see `docs/reports/issue-641-transform-deadline.md`.

## 1. Which release the report describes

* npm `@cortexkit/pi-magic-context@0.48.0` has `gitHead` `fdb4253afff153d16d45c65e74f48896412895c1`, which is tag `v0.48.0`.
* **0.48.0 does not carry the per-pass checkout-claim check.** The removal commit `c3f1e9f43f` is an ancestor of `v0.48.0`, and the 0.48.0 tarball's `dist/index.js` contains no `checkout claim` string.
* 0.48.0 matches the reporter's `stage = "provider dispatch"` at line 31926 and `assertOwner`'s throw at 31960.
* **The quoted stack trace comes from 0.47.0, not 0.48.0.** In the 0.47.0 tarball every frame resolves exactly:

  | Frame | 0.47.0 `dist/index.js` code |
  |---|---|
  | 31279 | the guard's `if (!isCurrent()) throw new PiContextSupersededError(...)` |
  | 35932 | the context handler's wrapper calling `assertOperation()` |
  | 31038 | `assertOutcome` |
  | 31043 | `assert` |
  | 31068 | `waitUntil`'s `finally { assert() }` |
  | 35949 | `await guardAwait(processOptions.checkoutClaim.refusal(...))` |

  At 0.48.0's line numbers the same frames land in unrelated code. The reporter's log therefore mixes events from 0.47.0 and 0.48.0.
* The 0.47.0 checkout-claim gate (`gatePiEventsByCheckoutClaim`) wrapped every `pi.on` handler except `context`, `session_start`, `session_shutdown` and `session_before_switch` in an awaited claim check (`CHECKOUT_CLAIM_CHECK_TIMEOUT_MS = 1500`). The wrapped handlers included `agent_start`, `agent_end` and the dispatch fence itself.
  * A stalled claim check therefore delayed the fence's lifecycle bookkeeping, each check independently. That is exactly the reordering that triggers the bug.
  * This explains why a `checkout claim: WARNING check incomplete` line preceded 2 of the 3 logged events.
  * The stall is not required: 0.48.0 reproduces without it (section 3).

## 2. Mechanism

**Which pass threw.** The user-visible refusal is assembled in the fence's `catch`, around `refuse(ctx, budget, error, isCurrent)` in `pi-context-refusal.ts`.

* `budget` is `active.pass`, the operation's latest pass, and `budget.assertOwner()` throws a *new* `PiContextSupersededError`.
* No older pass's stored error is rethrown.
* With a single registration, the fence never reads an older pass: every non-side pass sets `active.pass` synchronously before its handler runs.

**Why the fence's `isCurrent()` was true.**

* The fence defines `isCurrent = operations.get(key) === active`. The pass's guard defines `isCurrent = isOwned() && !active.ended`, plus the context handler's generation and signal checks.
* At the fence, `isOwned()` is trivially true.
* So the guard fails while the fence passes exactly when `active.ended` is set, or when another pass has claimed the session generation.

**Who sets `ended`.** The fence's `agent_end` handler ended whichever operation was current, unconditionally. OMP 18.7.0, and 18.8.6 likewise, delivers that notification late:

* `agent-session.ts:4914-4936` (`#settleAgentEnd`) publishes the public `agent_end`, then sends the extension notification **detached**: `void this.#emitAgentEndNotification(...)`.
* That runs only after post-turn maintenance. For a retryable error, `turn-recovery.ts:2823` sleeps the backoff and `:2852` schedules the continuation (`delayMs: 1`) *before* `agent-session.ts:4226-4228` notifies extensions with `willContinue: true`.
* `runner.ts:1577` awaits every extension's handler in order, with a per-handler timeout. Any slow earlier `agent_end` handler (another extension, or 0.47.0's claim gate) pushes the fence's bookkeeping further back.

The resulting order is:

1. Run N ends, and its extension notification is still in flight.
2. Run N+1 (or the retry continuation) delivers `agent_start` and runs its context pass P, which returns managed messages.
3. The late `agent_end(N)` marks P's operation ended.
4. P's own request reaches the fence. `assertOwner()` throws "superseded", the fence's map check is still true, and the turn is refused and aborted.

The managed request is never sent.

**Second path: a late-started pass claims the generation.**

* `withSqliteTransformPass` reserves the foreground SQLite turn *before* calling the handler. While an index-maintenance chunk owns the coordination slot, `reserveForegroundSqliteTurn` polls every 1 ms with no cap and no budget check (`packages/plugin/src/shared/sqlite.ts:1325-1336`).
* The guarded wrapper only checked the 25 s outcome after the handler returned.
* A pass stuck there could start its handler after it had already been refused and after a newer pass had started. The handler's first statement then set `contextPassGeneration` for the session.
* The newer pass's guards then threw `superseded before writer admission`. Its own refusal path rethrew silently, OMP sent the original messages, and the fence's generation-aware `assertOwner()` refused with the same text.
* The unit regression for this path (section 5, mutation M5) reproduces exactly that message.

**Why 54 s.** `elapsed` is the time from the fence's pass entering the hook to the moment the refusal was built. It does not measure CPU or transform time. The reporter's log is not attached, so the specific 54,630 ms instance cannot be decomposed. These are the waits on that clock:

| Wait | 0.48.0 bound |
|---|---|
| Writer admission | `budget.writerAllowance()` (≤16.5 s, inside the 21 s work cutoff), `context-handler.ts:4245` at 0.48.0 |
| Emergency historian join | `budget.wait(historian)` (21 s work cutoff), `:5019` at 0.48.0 |
| Checkout claim | Not present in 0.48.0. In 0.47.0 the in-pass check was bounded by `guardAwait`, but the event-gate checks on `agent_start`, `agent_end` and the fence ran outside any pass budget |
| Foreground reservation before the handler | **Unbounded.** Charged to the clock but never enforced until the handler returned |
| Synchronous SQLite, native or host calls | Not preemptible by timers |

The reservation wait is the one await on the pass's own critical path that the 25 s budget did not cover. It is now covered (section 4).

## 3. Reproduction on real OMP hosts

`docs/reports/probes/issue-667/host.ts` drives the real OMP CLI in RPC mode against the repository's loopback Anthropic-protocol mock, which captures every request body. Pinned packages live under ignored `.cache/`: `@oh-my-pi/pi-coding-agent` **18.7.0** (the reporter's version) and **18.8.6** (the issue 641 / 663 probe host). Bun 1.4.2, macOS arm64.

**Hold.** A probe extension registered ahead of Magic Context holds the first run's `agent_end` until the next pass's context result has returned, then lets dispatch proceed once the late end has reached the fence. This is a deterministic stand-in for any slow earlier `agent_end` handler. Without the hold (`--no-hold`) on an idle host, three runs delivered the end first and nothing was refused. The race needs a delayed notification; it is not the common order.

**Builds compared.**

* "Baseline" for the guard probe is a bundle of the pre-fix `pi-context-refusal.ts` from `dda49e3850`.
* "Baseline" for `--full-plugin` is the **npm 0.48.0 `dist/index.js` itself**.
* "Fixed" is this branch.

| Run | Host | Requests | Visible refusals | Result |
|---|---|---|---|---|
| `late-end`, baseline guard | 18.7.0 | 1 | 1: `stage=provider dispatch elapsed=4ms … (Pi context pass superseded before writer admission)` | second prompt never sent |
| `late-end`, fixed guard | 18.7.0 | 2 | 0 | second request carries `MANAGED667 SECOND667` |
| `late-end`, baseline guard | 18.8.6 | 1 | 1, same text | — |
| `late-end`, fixed guard | 18.8.6 | 2 | 0 | — |
| `late-end --full-plugin`, **npm 0.48.0** | 18.7.0 | 1 | 1: `… elapsed=23ms … (Pi context pass superseded before writer admission)` | the reported refusal from the released build |
| `late-end --full-plugin`, fixed build | 18.7.0 | 2 | 0 | both requests carry `§N§` tags |
| `retry` (11 provider 500s → session retry, `willContinue=true`), baseline | 18.7.0 | 11 | 1, same text | continuation refused |
| `retry`, fixed | 18.7.0 | 12 | 0 | continuation sent managed |
| `slow` (first pass 32 s; user resends), baseline | 18.7.0 | **0** | 2: the fence at `elapsed=30015ms` after OMP's 30 s timeout, then `superseded` on the resend | resend refused too |
| `slow`, fixed | 18.7.0 | 1 | 1: outcome refusal at `elapsed=25011ms`, before OMP's timeout | resend sent managed; the slow pass's late return aborts nothing |

On the real host, the input of run N's context pass was a subset of run N's `agent_end` messages, and run N+1's input added the new prompt (OMP structured-clones messages; role and timestamp were preserved). That observation is the basis of the attribution rule below.

**Isolation.** Every run redirects `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, the OMP agent directory, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/issue-667/`. `lsof -p <host pid>` runs inside the host at every `agent_start` and again from the driver before shutdown. Either check fails the run unless every `.db` descriptor is under that run's root.

[`issue-667-host-receipts.json`](issue-667-host-receipts.json) records, for all 13 runs, PIDs, roots, request markers, refusals, event order and the full `.db` descriptor paths. They were 22–25 per run, all under the throwaway root, with no live-store path. Full bodies, audits, stderr and raw `lsof` output are in the worktree's ignored `local-ignore/issue-667/host/`.

## 4. Fix

`packages/pi-plugin/src/pi-context-refusal.ts`:

1. **Attribute a late `agent_end`.** `endBelongsToEarlierRun` keeps the operation when the latest pass has not been dispatched yet and either:
   * the end says `willContinue`, so a continuation follows; or
   * the pass's input holds a message (role + timestamp) that the ended run never had.

   Otherwise the end invalidates the receipt as before: a dispatched pass, or an undispatched pass whose input is all part of the ended run.

   Per-session `agent_start`/`agent_end` counts decide whether the kept operation is marked unstarted. When it is, the late start of its own run adopts it, using the existing issue 663 adoption rule.
2. **The fence judges operation state only.** It no longer calls the pass's `assertOwner()`, which turned an unattributed end, or a generation claimed by a stale pass, into a "superseded" refusal. A replaced pass is never read at the fence. The fence still refuses, visibly as before, when:
   * no pass ran;
   * the latest pass is unfinished, including past its outcome deadline;
   * the latest pass was refused or abandoned;
   * the pass ran without a receipt; or
   * the run that owned the pass has ended. This case now has its own message: `the run that owned the latest context pass has ended; no managed result for this request`.

   The fence records the first admitted dispatch.
3. **A newer pass earns its own receipt.** Assigning a new pass clears the operation's `refused` flag. The refused pass itself stays abandoned.
4. **The 25 s outcome deadline covers the whole pass.** `budget.waitMandatory(...)` now races `withSqliteTransformPass(handler)`, including its pre-handler reservation. At expiry the pass is refused, which aborts the turn, before OMP's 30 s timeout can send raw history. The still-running work is abandoned, so its guards stop further writes.

`packages/pi-plugin/src/context-handler.ts`: the handler's first statement is `budget.assertOutcome()`. A handler started after its pass was refused, replaced or ended stops before claiming the session's pass generation.

**How the brief's rules hold:**

* **A superseded pass never refuses the turn.** The fence reads only the latest pass, and supersession errors in a replaced pass stay inert as before.
* **The request is the current pass's managed result.** A request is admitted only when the latest pass completed in time with a receipt. Otherwise the visible refusal is unchanged. The fence stays synchronous, so it does no LKG replay.
* **Older passes' late writes stay fenced.** The owner, generation and abandonment guards are unchanged, and a late-started handler now stops at entry.
* **The 25 s budget covers the whole pass.** See point 4 above.

**Residual limits:**

* If OMP delivers run N+1's `agent_start` after its context pass and before run N's late `agent_end`, the start still replaces the pass's operation. The result is the pre-existing `no context pass ran for this operation` refusal described in issue 663. Lifecycle events carry no run identity, so this cannot be told apart from a borrowing start.
* An end that arrives after the pass's first dispatch still invalidates the receipt. OMP 18.7.0 retried provider errors below the hook (11 attempts, one fence call), so no re-dispatch was observed there.
* The session-wide side-context latch from issue 641 is unchanged.

## 5. Verification

**Unit regressions.** `packages/pi-plugin/src/issue-667-superseded-fence.test.ts` has 6 tests:

1. a late `agent_end` after the next run's pass;
2. a retry continuation's late `willContinue` end;
3. a slow pass refused at dispatch, then a resend;
4. a run's own end still invalidates its receipt (the contract control);
5. the outcome deadline covers a never-settling handler;
6. a pass held behind a real index chunk refuses by its deadline and does not supersede the next pass.

With the pre-fix `pi-context-refusal.ts` and `context-handler.ts` restored, tests 1, 2, 4, 5 and 6 fail. Test 4 fails with the exact reported text. Test 3 was added with the `refused` reset and is proven by mutation M7.

**Mutation controls.** Each control staged the live file, applied the change (non-empty `git diff --stat`), ran the file, restored it with `git checkout -- <path> && touch <path>`, and confirmed an empty diff afterwards:

| Control | Red | Green |
|---|---|---|
| M1 `endBelongsToEarlierRun` always false | tests 1, 2 | 3–6 |
| M2 ignore `willContinue` | test 2 | all others |
| M3 no late-start adoption | test 1 | all others |
| M4 no outcome race (post-handler check only, as before) | tests 5, 6 | 1–4 |
| M5 no handler entry check | test 6 (`Pi context pass superseded before writer admission`) | all others |
| M6 the fence calls `budget.assertOwner()` again | test 4 (the reported text) | all others |
| M7 a newer pass inherits the refusal | test 3 | all others |

**Existing suites.**

* The issue 640/641/663, budget, writer-wait, degraded-pass, emergency-historian and LKG-pairing tests ran on Linux: 81 pass, 0 fail.
* The issue 641 real-host probes on OMP 18.8.6 against the rebuilt extension all passed their built-in assertions:

  | Probe | Result |
  |---|---|
  | `fast --fixed` | 1 request; `§1§ MC641_ORIGINAL` in the body |
  | `slow --fixed` | 0 requests; visible refusal |
  | `outcome --fixed` | 0 requests; 4 ms fallback; handler 25,234 ms |
  | `ephemeral --fixed` | 2 overlapping requests; no abort |

* The issue 663 probes on OMP 18.8.6 returned the expected request counts:

  | Probe | Requests | Refusals |
  |---|---|---|
  | `main` | 1 | — |
  | `retry` | 2 | — |
  | `late-start` | 1 | — |
  | `skip` | 0 | refused |
  | `no-result` | 0 | refused |
  | `capture` | 1 | refused |
  | `advisor` | 2 | — |
  | `side` | 2 | — |
  | `steer` | 2 | — |
  | `task --full-plugin` | 4 | — |

**Gates on Linux** (`linux,8c`; Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1; throwaway `HOME`/XDG/storage roots; `OPENCODE_DB` unset):

* The Pi typecheck and the probe typecheck pass.
* `bun run lint` checks 308 files with existing warnings only.
* The full Pi suite gives 1,887 pass / 28 skip / 146 fail across 2,061 tests. The **identical** run with the pre-fix sources gives 1,881 pass / 28 skip / 146 fail across 2,055 tests, and the two failure-name sets are equal. Those 146 failures come from that runner's environment, for example `git rev-list --max-parents=0 HEAD` failing, and are not caused by this change. The final commit's numbers are in the delivery notes.

**Reproduce:**

```sh
mkdir -p .cache/issue-667/host-18.7.0
printf '%s\n' '{"private":true,"dependencies":{"@oh-my-pi/pi-coding-agent":"18.7.0"}}' > .cache/issue-667/host-18.7.0/package.json
bun install --cwd .cache/issue-667/host-18.7.0
bun build docs/reports/probes/issue-667/guard.ts --outfile .cache/issue-667/guard.mjs --target node
# guard-baseline.mjs: build the same entry with the pre-fix pi-context-refusal.ts in place.
bun docs/reports/probes/issue-667/host.ts late-end [--baseline] [--no-hold]
MC667_FAILS=11 bun docs/reports/probes/issue-667/host.ts retry [--baseline]
bun docs/reports/probes/issue-667/host.ts slow [--baseline]
bun run --cwd packages/pi-plugin build
bun docs/reports/probes/issue-667/host.ts late-end --full-plugin
# Released build: unpack the npm 0.48.0 tarball's dist/ under packages/pi-plugin/.cache/ so its
# externals resolve, then:
MC667_PLUGIN=$PWD/packages/pi-plugin/.cache/issue-667/npm-0.48.0/dist/index.js \
  bun docs/reports/probes/issue-667/host.ts late-end --full-plugin --baseline
# MC667_HOST=18.8.6 selects .cache/issue-667/host-18.8.6.
```
