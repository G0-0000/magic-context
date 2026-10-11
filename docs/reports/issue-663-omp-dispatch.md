# Issue 663: OMP dispatch attribution

## Reproduction and classification

Tested **Oh My Pi 18.8.6**, installed in this worktree's ignored `.cache/issue-663/host`, with a loopback mock provider. This is not a fixture that invokes lifecycle handlers by hand. The CLI runs its real RPC agent loop, extension runner, provider adapters, native task executor, advisor, and auto-learn capture agent. A **receipt** is the in-memory record that Magic Context completed tagging/pruning and returned managed messages for a particular conversation operation. The guarded-context fixture records that preparation and subsequent dispatch independently of the larger transform pipeline; additional runs load the **built full Magic Context extension**, including native delegated children.

[`issue-663-host-receipts.json`](issue-663-host-receipts.json) contains 30 selected runs: host version/PID, database descriptor paths, chronological hook/HTTP events, refusals, and provider request markers. Full request bodies, JSONL events, stderr and `lsof` output remain at `local-ignore/issue-663/host/` in the task worktree, outside regenerable build directories. The collector verifies request counts and that each recorded temporary session root has been removed.

| Path | Host observation | Classification / disposition |
| --- | --- | --- |
| Ordinary main prompt | `agent_start → context → before_provider_request → HTTP → agent_end`; managed markers reach the provider | Ordinary managed conversation; unchanged |
| HTTP overload retry | One context/payload-hook invocation, two identical prepared HTTP attempts; this provider retries below the hook | Keep the completed receipt and its original clock; no new preparation budget |
| Native `task` / delegated child | Parent tool continuation, separate child session with its own start/context/payload events, then parent result-resume turn; four managed requests | Separate conversation operations; neither child nor resumed parent borrows another run's receipt |
| Ephemeral side turn concurrent with main | Two context/payload passes for one session; side HTTP response completes after main HTTP starts | Existing attributed-context side latch, unchanged; no attempt to infer side attribution from wire text |
| Steer during a pending HTTP request | Initial request, then another context pass containing the steer and a second request | Normal conversation preparation, not an exemption |
| Delayed lifecycle start | Another extension holds `agent_start`. Magic Context completes its context pass. Releasing the lifecycle handler **before dispatch** erases the receipt on the base code: zero HTTP requests, `elapsed=0ms`, missing-receipt refusal | **(b)** Tracking bug. The first start adopts an already-created, unended operation. Fixed guard/full-plugin runs send the managed request |
| Advisor review | After main turn end: payload hook, **no context hook**, separate advisor system prompt, `advise` tool, user messages headed `### Session update`; body is a formatted review of newly added messages | **(a)** Separate agent's review history, not the primary conversation's raw message array. Base refuses it; fixed sends it without creating or consuming a main receipt |
| Automatic learning capture | After main turn end: payload hook, **no Magic Context context hook**; copies the main agent's raw message array/system and appends its capture nudge, restricting tools to `manage_skill`/`learn` | **(c)** Unmanaged conversation copy. Remains refused. Even a still-ready main receipt cannot authorize this separate capture request |
| Injected skipped context handler | Real conversation adapter and payload dispatch, but the probe deliberately withholds our context handler | **(c)** Zero HTTP requests; explicit `no context pass ran for this operation` diagnostic |
| Handler ran but returned no result | Context hook executes without returning messages | Zero HTTP requests; distinct `context pass ran without a managed context receipt` diagnostic |
| Title generation | Separate single-user `<chat>` envelope; HTTP after main turn end, **neither** context nor payload extension hook | Not a dispatch-fence path; no new exemption required |
| Soft compaction / summaries | Three one-shot summary requests with `<conversation>` envelopes after two conversation turns; **neither** extension hook | Not a dispatch-fence path. Summaries intentionally receive serialized conversation text; they are not ordinary conversation dispatches |

Both the advisor and capture paths were reproduced through **Anthropic Messages and OpenAI Responses** adapters, including full-plugin runs. Other provider envelopes are deliberately not guessed: they retain the existing receipt check instead of gaining a body-based exemption. User text resembling an advisor prompt, incomplete envelopes, and mixed `messages`/`input` bodies cannot obtain the advisor exception.

The plugin-owned hidden child entry (`subagent-entry.ts`) does not register guarded context or `before_provider_request`; the full plugin also exits early for `MAGIC_CONTEXT_PI_SUBAGENT=1`. That plugin-owned child entrypoint is distinct from the **native OMP task children**, which this probe actually records with the full extension's context and payload handlers. No hidden-child behavior was changed.

## Why the lifecycle race is real

OMP 18.8.6's installed source shows that lifecycle forwarding does not gate provider preparation:

- `pi-agent-core/src/agent-loop.ts:629-643` pushes `agent_start` and proceeds into the loop; `agent.ts:2157-2166` does not await asynchronous listener returns.
- `pi-coding-agent/src/session/agent-session.ts:3223-3243,5031-5038` forwards lifecycle notifications to extensions asynchronously.
- `extensibility/extensions/runner.ts:1577-1612` awaits lifecycle handlers in order, independently of `emitContext` (`1969-2035`) and `emitBeforeProviderRequest` (`2038-2072`).
- `sdk.ts:4147-4149,4208-4210` wires context and payload preparation separately.

The probe uses a promise handshake, not a timing assumption: an earlier host lifecycle handler waits; after the managed context handler returns, the probe releases that lifecycle handler and waits for all start handlers before allowing dispatch. The base refusal and fixed admission therefore exercise the exact same real-host ordering.

For internal calls that do not use the primary session's Magic Context context hook:

- `session/session-advisors.ts:1302-1310,1416-1438` constructs a separate advisor agent with its own prompt and inherited payload callback, but no Magic Context context transform. `advisor/runtime.ts:956-1009,1357-1372` delivers formatted transcript updates to that agent.
- `sdk.ts:1578-1621,5138-5169` copies the primary transcript into auto-learn's private capture agent; its transform only wraps steering and does not emit extension context hooks.
- `utils/title-generator.ts:336-361` makes a one-shot completion without either extension hook. `session/session-maintenance.ts:3493-3504` uses the side stream for local summary completions.

The file-and-line citations above refer to the pinned npm installation, not the older globally installed `omp` command.

## Implementation boundaries

- `Operation.started` differentiates the **first delayed start** of an early-created operation from another start that must reset receipts. An ended operation cannot accept a new context pass: a fresh operation is created first. Repeated starts, turn end, and cache eviction still invalidate authorization.
- Advisor recognition requires **system identity + advisor workflow + advise tool + review-message envelope**, in observed provider formats. Recognition neither installs a receipt nor latches a session. Unknown bodies remain fail-closed without a receipt.
- Capture recognition is a refusal, not an exemption. It prevents a raw copy from borrowing a completed main receipt while lifecycle events are pending.
- The provider hook remains synchronous: no awaits, SQLite access, payload hashing, or last-good replay generation. No message/body rewriting was added.
- The cooperative ~25-second budget, original pass clock, late-writer owner guard, completed-retry semantics and attributed-side-context latch are unchanged. The pre-existing limitation remains: after a verified side context, the session-wide dispatch backstop stays latched off because OMP's abort cannot distinguish concurrent operations. This work does not claim to repair that limitation.

## Isolation and reproduction

All CLI launches are local and `nice -n 10`; every session redirects `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `PI_CODING_AGENT_DIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/issue-663/`. No live store/config was opened, copied, read, migrated or written. `lsof -p <actual host PID>` was captured during agent start and at the end; every `.db` descriptor is under that run's throwaway root. Cleanup runs in `finally` after host exit. Host installation affects only an ignored worktree-local manifest/lockfile, not repository package manifests or the global OMP installation.

```sh
# Install @oh-my-pi/pi-coding-agent 18.8.6 in .cache/issue-663/host first.
nice -n 10 bun build docs/reports/probes/issue-663/guard.ts \
  --outfile .cache/issue-663/guard.mjs --target node
nice -n 10 bun docs/reports/probes/issue-663/host.ts late-start
nice -n 10 bun docs/reports/probes/issue-663/host.ts advisor --responses
nice -n 10 bun docs/reports/probes/issue-663/host.ts capture --responses
# Build the plugin locally before using --full-plugin (remote artifacts are not local).
nice -n 10 bun run --cwd packages/pi-plugin build
nice -n 10 bun docs/reports/probes/issue-663/host.ts task --full-plugin
bun docs/reports/probes/issue-663/collect.ts
```

Additional modes: `main`, `retry`, `side`, `steer`, `title`, `compact`, `skip`, `no-result`. `--baseline` loads a separately built `.cache/issue-663/guard-baseline.mjs` made from the guard before editing, for comparison with the edited guard; that bundle is intentionally not committed. All mock API keys are synthetic.

## Verification and mutation controls

- Bun **1.4.2**; TypeScript **5.9.3**; Biome **2.5.1**.
- Required Pi suite on `linux,8c`: **1973 passed, 28 skipped, 1 failed**, 2002 tests / 204 files / 87321 assertions. The failure was the unrelated wall-clock assertion in `auto-search-bounded.test.ts`: slow embeddings took **3928.91 ms** against a **3150 ms** threshold under the parallel suite. Its isolated Linux rerun passed **all 3 tests / 14 assertions**, with the failing test taking **3008.99 ms**. No unrelated test or deadline was weakened.
- Package typecheck and the probe-project typecheck passed on Linux. Lint checked **303 files**, exited 0, with existing warnings (including non-null assertions in older tests).
- New unit coverage: **11 tests / 42 assertions**. Existing dispatch, budget, side-latch, supersession and publication tests also ran in the Pi suite.
- Five deliberate implementation-breaking mutation checks each produced **exactly one named failure and one passing control test**, showing that the tests detect their targeted regressions: erase the early pass on start; admit no-pass conversations; deny recognized advisor requests; let raw capture borrow the main receipt; remove advisor system identity. Each mutant was marked `NON-VACUITY BREAK`, applied only after staging the live state, proved with a non-empty diff stat, and restored from the index with an empty diff stat. Exact failure/control names and stats are in the worker delivery's `mutation_evidence`.
- Ordinary context returns the exact managed message array. The host wrapper also compares payload JSON before and after dispatch handlers, refusing its own probe if those handlers change provider bytes. This verifies that the new backstop does not rewrite ordinary payloads; it is not a claim that volatile session IDs, working directories or provider billing metadata match between distinct sessions.
