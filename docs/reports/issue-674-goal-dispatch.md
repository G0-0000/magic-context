# Issues 673 and 674: OMP goal continuations and dispatch identity

This extends [the first issue 673 investigation](issue-673-dispatched-late-end.md). The branch now addresses both reports together. The first commit's ordinary-prompt reproduction remains useful, but its requirement for a fully persisted, non-custom native transcript was insufficient for goal mode.

Both reports concern the dispatch fence asking the user to send a message again. A **context pass** is one Magic Context preparation hook; its **managed result** is the returned history after memory injection, tagging, and pruning. A **receipt** records that preparation completed. **Dispatch** is admission at `before_provider_request`. **Native history** is the host's stored input before Magic Context rewrites it. **LKG** means last-known-good, the saved managed context slot. The delayed **end** discussed here is an `agent_end` notification for an earlier agent-core run, while the longer-lived goal workflow continues.

## Answers to the three host questions

### 1. Context is prepared per model pass, not per transport attempt

On **real Oh My Pi 18.10.3**, the first goal agent run executes a mock-requested native `bash` tool (`printf 'progress674\n'`) and then makes a second model call. Those two model calls have **two context-hook invocations but only one agent_start**. Both receive fresh managed results.

The actual RPC goal controller then schedules another goal agent run. Its model call has a third context pass. An Anthropic strict-tool rejection rebuilds that same provider call: **the fourth before_provider_request has neither a fourth context pass nor another agent_start**. That is an internal provider attempt, not a fresh model pass. The conversation of that attempt is byte-identical to the already prepared/sent conversation.

The baseline's fresh third pass was not borrowed from an older operation. Instead, the previous goal run's delayed end invalidated it **after its first dispatch**. The provider rebuild then found that current operation ended. Thus the report's dispatch exclusion is a sufficient cause, but its premise that every provider hook should have a fresh context hook is false.

### 2. The reproduced mid-run end is the previous primary goal run's notification

The probe uses the real `RpcGoalController`, not invented lifecycle events. The goal workflow persists across agent-core runs in the **same session**, using the same `ctx.agent` identity: `{kind:"main", id:"Main", name:"main", depth:0}`. The preceding run ends while the goal remains active; the controller starts its next run. A preceding notification handler holds that first run's extension end until the next run's first HTTP request. Its eventual delivery therefore occurs while the next primary run is streaming.

This is a goal workflow's inner agent-run boundary, **not an independent child Agent object whose end was routed onto the parent**. Task subagents use another SessionManager/SDK session and publish child UI frames on a task event channel. Advisor recording subscribes to message_end, not a forwarded parent agent_end. The source and this reproduction do not support diagnosing a subagent from the nested diagnostic string.

### 3. The no-new-pass retry is managed; an actual raw replacement is refused

The goal retry has the same independently captured provider-conversation SHA-256 and identical HTTP messages as its first attempt. A native persisted goal-preface entry outside the old end's transcript remains the same, and the fully persisted current native input matches the pristine pre-handler fields.

The probe also generates an **actual unmanaged provider body**: the host's pure `convertToLlm` converts the pristine native history, and the real `pi-ai.streamSimple` adapter builds its body with a capture-only onPayload callback. That reference call is aborted before HTTP and runs no Magic Context context hook. The probe substitutes its messages into the pending retry. With the combined fix, this raw attempt never reaches HTTP and produces one content-mismatch refusal. Removing the conversation-identity guard makes that same raw body reach the mock provider. This is evidence from the adapter itself, not a hand-invented payload or an expected value derived from the fence.

## Exact additional gap exposed by goal mode

Goal inputs contain native `custom_message` entries (`goal-mode-context` and `goal-continuation`). The first issue 673 implementation rejected all custom entries when collecting branch evidence.

There is also a persistence race even on the fast mock host: when the continuation's first provider hook runs, its goal preface is already persisted, but its final goal-continuation entry is not yet in the SessionManager branch. By the delayed earlier end and retry, the final entry has arrived. Requiring an already-persisted final entry at the first hook therefore loses valid identity evidence.

The combined proof captures an exact **persisted prefix** of the original raw input, including reconstructed custom entries. Its stable native entry ID and original-input position are recorded. Preservation requires:

* the captured entry's position is **outside** the ended transcript;
* that same native ID still occupies that position;
* **all** original input fields are now present and identical in the current native transcript;
* the end is an exact shorter prefix of the original input;
* all the previous started/completed/ready/unrefused/non-idle/lifecycle requirements still hold.

Before first dispatch, later persistence can upgrade the prefix anchor only if the old anchor stayed unchanged. A changed anchor cannot be silently replaced. No timer, elapsed threshold, inferred child role, or `willContinue` alone grants this exception.

After ignoring an end of an already-dispatched pass, the fence now additionally requires the retry's provider conversation to equal its first managed dispatch. Typed LKG field tokens cover messages/system or input/instructions, plus Responses server-side conversation references. Retry controls and tools can change; the conversation and its chain identity cannot. These snapshots do not serialize/hash the payload or access SQLite. Unknown provider representations, changed system content, raw history, missing/currently incomplete history, and stale response chains fail closed. A fresh context pass resets those records and earns a fresh receipt.

An already-refused pass still aborts every later callback, but emits only one resend notice. This also prevents repeatedly wrapping its already-mutated `budget.stage`. The original nested diagnostic could be produced solely by two callbacks for the same pass; it is not evidence of an inner agent or recursive hook call.

## Real-host results

Committed evidence: [host-receipts.json](issue-674/host-receipts.json). All hosts are Bun 1.4.2 on macOS, with exact npm pins and the full Magic Context extension.

| Scenario | Fence | HTTP requests | Checks/result |
|---|---|---:|---|
| actual RPC goal, tool step, next goal run, delayed end, strict retry; OMP 18.10.3 | first issue 673 commit `4d7ecc0f618b667ea25f09c73ff386f8f081bdd6` | 3 | first 5 checks pass; managed retry check fails; origin=agent_end refusal |
| same actual goal scenario | combined fix | 4 | all 7 checks pass; no refusal |
| same goal scenario, retry replaced by actual raw native-adapter conversation | combined fix | 3 | all 8 checks pass; raw retry refused once; reference construction itself aborted before HTTP |
| same raw scenario, conversation guard neutralized | mutant | 4 | `raw provider retry never reaches HTTP` goes red; raw fourth request captured |
| ordinary issue 673 strict retry, OMP 18.9.2 | combined fix | 3 | all 5 checks pass |
| ordinary issue 673 strict retry, OMP 18.10.3 | combined fix | 3 | all 5 checks pass |

The baseline and fixed goal scenarios observe three context passes and four provider hooks. Only two actual agent starts occur. Duplicate entries in the hook log are different registered notification handlers, not extra agent starts/ends; the public-event stream is recorded separately.

Every canonical process was isolated before startup under `$TMPDIR/magic-context/issue-673/`. The shell wrapper sets HOME, CFFIXED_USER_HOME, all XDG directories, TMPDIR, PI_CODING_AGENT_DIR, MAGIC_CONTEXT_STORAGE_DIR, OPENCODE_DB and the log path. The SDK cwd is that root and extension discovery is disabled. Startup/end `lsof -p <host pid>` lists **25/29 relevant descriptors**, all under the respective throwaway root, for every archived run. No protected live store/config was opened. Host library/OS descriptors are not data stores and necessarily remain outside that root.

## Pinned OMP 18.10.3 source citations

Paths below refer to source shipped in the exact npm packages, not a floating Git branch.

* `@oh-my-pi/pi-agent-core/src/agent-loop.ts:1360,1914–1949,1989`: prepareProviderCall applies transformContext for a model pass, then the prepared call is passed into streamAssistantResponse. Fresh runs/continuations emit agent_start at `:640,:703`.
* `@oh-my-pi/pi-coding-agent/src/sdk.ts:4178,4240–4242`: emitContext is in preparation; onPayload calls emitBeforeProviderRequest with the provider's signal.
* `@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:1989–2055,2058–2092`: context transformation and payload callbacks are separate pipelines. Context inputs are cloned; payload hooks operate on adapter-built requests.
* `@oh-my-pi/pi-ai/src/providers/anthropic.ts:2435–2461,2648–2651,3377`: prepareParams calls onPayload; rebuildParams calls prepareParams again; strict-tool fallback disables strict tools and rebuilds without returning through context preparation.
* `@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:4187–4196,5045–5075`: the primary run's end maintenance retains active messages and emits the extension notification detached after settling. End handlers can lag a later primary run.
* Same file `:7106–7117,7927–7929`: goal mode contributes a hidden custom goal-mode-context message before a submitted prompt.
* `@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-goal.ts:358–399,424–471`: the controller observes public ends, waits for idle, and submits the next hidden goal-continuation through promptCustomMessage. It stops repeated/no-progress continuations based on activity.
* `@oh-my-pi/pi-coding-agent/src/goals/state.ts:50–70`: progress is a digest of actual tool calls/results, not merely assistant text. The probe's first native bash step exercises this real continuation gate.
* `@oh-my-pi/pi-coding-agent/src/session/session-manager.ts:3702–3728`: getBranch reads the in-memory indexed path; resolved session context is separate. No SQLite call is used for this dispatch proof.
* `@oh-my-pi/pi-coding-agent/src/session/session-context.ts:398–420`, `@oh-my-pi/pi-tui/src/chat/transcript-entry.ts:39–50`, `@oh-my-pi/pi-agent-core/src/compaction/messages.ts:176–192`: native custom entries are restored as role/customType/content/display/details/attribution and a numeric timestamp. The fence compares the reconstructed provider-visible fields exactly; malformed/unprovable entries are rejected.
* `@oh-my-pi/pi-coding-agent/src/task/executor.ts:4302–4308,4485–4497,3763–3784`: task children get another SessionManager and createAgentSession call. `:1711–1714,2167–2169` publishes `{id,event}` task frames on an event bus, not flat parent extension agent_end events.
* `@oh-my-pi/pi-coding-agent/src/session/session-advisors.ts:1932–1940`: the advisor recorder feed forwards finalized messages only; it does not forward advisor ends to parent lifecycle hooks.

## Unit, mutation, and package gates

`issue-674-goal-dispatch.test.ts` adds **16 tests**: exact custom goal history; partially persisted continuation; anchor position and stability; complete current input; changed custom content/timestamp; owning goal end; fresh model pass without another start; raw/system/unknown-shape/response-chain refusals; allowed retry-control changes; and repeated stale callbacks remaining aborted with one notice.

[mutations.json](issue-674/mutations.json) records source controls and named red/green outcomes. Each canonical run has exactly one expected red, with nonempty mutation and empty restore diff evidence. The content guard is proven both by unit raw-history refusal and by the real native-adapter body reaching HTTP only when that guard is neutralized. Historical first-commit controls remain in [the issue 673 mutation record](issue-673/mutations.json).

Remote Linux with four allocated CPUs (`linux,4c`), Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1:

* Package and probe typechecks pass.
* Package lint: 319 files, zero errors, 67 existing warnings; changed files clean.
* Full suite before the final response-chain unit addition: **2,148 pass, 36 skip, 1 fail**, 2,185 tests across 218 files. The failing unchanged bounded-SQLite-holder admission test subsequently passed in isolation with three successful holder trials (699/517/464 ms, all below its 1,500 ms threshold and no refusal). The precise cause under the full concurrent workload was not established; no expectation was rewritten and the full suite was not repeated.
* Final targeted dispatch/lifecycle/diagnostic regressions for issues 663/667/668/673/674: **71 pass, 0 fail, 306 assertions**, six files. Final package and probe TypeScript checks pass.
* Final local package build and all four host controls above pass. Mutation binaries were rebuilt away before delivery.

## Reproduce and limits

Install `@oh-my-pi/pi-coding-agent@18.10.3` in a throwaway `install` directory following the isolation setup in the issue 673 report, then:

```sh
bun run --cwd packages/pi-plugin build
MC673_VERSION=18.10.3 MC673_ROOT="$ROOT" MC673_HOST="$ROOT/install" \
  bash scripts/omp-issue-673.sh goal-late-retry
MC673_VERSION=18.10.3 MC673_ROOT="$ROOT" MC673_HOST="$ROOT/install" \
  bash scripts/omp-issue-673.sh goal-raw-retry
```

The raw reference deliberately runs only the real provider adapter's body construction, captures its body, and aborts its own signal. It does not bypass the fence to send raw history.

Neither issue's original full Linux logs/payload traces were supplied. We therefore establish sufficient causes and a real goal-mode recurrence, **not that every one of the reporter's 40 refusals had this exact provider fallback**. The first text-only goal probe did not progress because the real controller suppresses no-tool continuations; its held notification timed out and the probe timed out. The canonical probe uses real tool progress and completes normally. Other provider representations or conversation rewrites (including unprovable compaction histories) retain the safe one-turn fallback. Large-history snapshot/comparison cost was not benchmarked. Existing side-session/advisor policies and context preparation deadlines are unchanged.
