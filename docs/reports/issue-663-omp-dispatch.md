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

## Second refusal mode: an old receipt is not necessarily an old request

The follow-up report includes `elapsed=64543ms` and `115468ms` with `Pi context pass superseded before writer admission`. The same fingerprint is reproduced on **OMP 18.8.6**: delay the main provider response by 65 or 115 seconds, then let OMP start its advisor review. The pre-`e720b700` fence reports **65084ms** (Anthropic) and **115070ms** (Responses), respectively, and aborts the review. There is **one main context pass**, followed by main HTTP, `agent_end`, and the advisor's `before_provider_request` with **no advisor context event**. There is no newer main generation in this sequence. The assertion checks that the pass still belongs to an unended operation. `agent_end` marks that operation ended and revokes its receipt, so this assertion fails even though no fresher main result exists.

Thus the elapsed clock identifies the **receipt the fence looked up**, not the request's preparation time or ownership. In this reproduction the late request is not the completed main pass's own request at all: it is a separately formatted advisor review. A supersession exception alone cannot authorize it, or any other provider payload.

[`issue-663-supersession-receipts.json`](issue-663-supersession-receipts.json) records **18 selected real-host runs**, including an exact `e720b700` fence comparison. Raw provider bodies, hook events, stderr, and `lsof` evidence remain in `local-ignore/issue-663/host/`. The collector checks expected HTTP counts, isolated descriptors, and removal of every selected throwaway session root.

For this follow-up, **(a)** means the dispatched history matches a still-valid managed pass; **(b)** means a newer pass must supply the history and the older request must not be sent; **(c)** means our tracking or attribution incorrectly reports supersession.

| Sequence | Observation and disposition |
| --- | --- |
| Main response delayed 65s, then advisor | The released fence fails with the reporter's supersession reason. **`e720b700` already fixes it**: the exact master fence sends both requests, without authorizing the advisor from the main receipt. Classification **(c)**: wrong attribution, not a newer conversation pass. |
| Main response delayed 115s, then Responses advisor | Same released failure. The built full plugin sends the managed main request and the independently recognized review. The existing structured advisor exception is sufficient; no supersession exemption was added. |
| Three later context listeners, each below OMP's 30s listener timeout | The managed result completes, then dispatch waits about 65s. Classification **(a)**: still-valid completed pass. The probe converts a separately recorded managed output with OMP's own Anthropic converter and date/cwd injector and compares the **entire serialized provider message array** against dispatch, not just a marker or elapsed time. |
| HTTP overload after a 65s delay | One context and one payload hook, two HTTP attempts with **identical complete request bodies**. The serialized message array also matches the recorded managed output. Classification **(a)**: completed provider retry; no new generation or preparation budget. |
| Native delegated task | Parent and child context passes use distinct session IDs; parent continuation prepares another managed result. Four requests; no stale-parent supersession at dispatch. |
| Ephemeral work concurrent with main | Real overlapping same-session passes, but the side event is attributed and uses the existing side-context latch. It does not bump the main generation. The existing session-wide abort limitation is unchanged. |
| Steer during pending HTTP | A new main context pass prepares the steer for the next request. The first HTTP request already dispatched before the steer; no old request reaches dispatch later. The second payload contains the managed steer, not raw replacement history. |
| Delayed first `agent_start` | Classification **(c)**, already fixed by `e720b700`: the full plugin adopts its early preparation. The released fence still produces zero HTTP requests. |
| Auto-learn capture after main end | Separate raw conversation copy, with no managed result for that capture. It remains refused in both adapters, even if a main pass completed. This is **not (a)** and is not the advisor exception. |
| Skipped handler / no result | Both remain zero-HTTP refusals with separate no-pass/no-result diagnostics. A supersession bypass must not admit either. |

The real host did **not** produce an unattributed stale main request that reaches dispatch after a newer main result has completed. The native tool/steer sequences serialize those preparations; the actual same-session overlap is attributed side work. The report therefore does not claim that all possible third-party extension combinations are covered. If such a **(b)** sequence is found, the newer pass cannot authorize the older request merely because it is ready: refusing or replacing that request requires its own payload attribution. This change does not add that speculative admission path. In particular, it does **not** implement the reporter's unconditional early return on supersession.

### Diagnostic change before issue 667

Ownership errors now name their source: `agent_end`, operation replacement/cache eviction, a newer guarded pass, or context-generation invalidation. At dispatch the diagnostic retains the preparation checkpoint, for example `stage=provider dispatch (origin=agent_end; context stage=final publication)`. When an already-prepared pass loses ownership or its operation ends, the diagnostic reports `recovery=superseded context result; refused`: the attempted dispatch was refused, rather than falsely claiming `no managed result`. Missing/no-result receipts retain their distinct messages. The dispatch hook stays synchronous and storage-independent; there is no hashing, replay, or payload replacement in production. Writer admission and decision-publication guards are unchanged.

### Reproduce the comparisons

After installing `@oh-my-pi/pi-coding-agent@18.8.6` in `.cache/issue-663/host` (see [Isolation and reproduction](#isolation-and-reproduction)):

```sh
nice -n 10 bun docs/reports/probes/issue-663/bundle-comparison.ts
nice -n 10 bun build docs/reports/probes/issue-663/guard.ts --outfile .cache/issue-663/guard.mjs --target node
nice -n 10 bun docs/reports/probes/issue-663/host.ts advisor --baseline --delay-first-ms=65000
nice -n 10 bun docs/reports/probes/issue-663/host.ts advisor --master --delay-first-ms=65000
nice -n 10 bun docs/reports/probes/issue-663/host.ts advisor --baseline --responses --delay-first-ms=115000
nice -n 10 bun docs/reports/probes/issue-663/host.ts slow-context
nice -n 10 bun docs/reports/probes/issue-663/host.ts retry --delay-first-ms=65000
# Build the plugin locally before --full-plugin, as above.
nice -n 10 bun docs/reports/probes/issue-663/host.ts advisor --responses --full-plugin --delay-first-ms=115000
bun docs/reports/probes/issue-663/collect.ts --supersession
```

The collector also needs the quick `advisor --baseline`, `advisor --delay-first-ms=65000`, `retry`, `capture --full-plugin`, `capture --responses --full-plugin`, `task --full-plugin`, `side --full-plugin`, `steer --full-plugin`, `late-start --baseline`, `late-start --full-plugin`, `skip`, and `no-result` runs. Historical bundles preserve the exact fence source and only relocate imports for building inside the isolated worktree. The byte comparison is deliberately limited to the simple one-user-message Anthropic histories returned by the guarded-context fixture in `retry` and `slow-context`; it is not a general provider-payload matcher or a new authorization rule.

### Follow-up verification before issue 667

- Linux `linux,8c`, Bun **1.4.2**: final complete Pi suite **1977 passed, 28 skipped, 0 failed**, 2005 tests / 204 files / 87342 assertions. The first run found two legacy assertions expecting the old writer-admission wording and the previously documented unrelated embedding wall-clock failure (5048ms versus 3150ms). Only the diagnostic strings in those legacy supersession assertions were updated; their no-late-write, no-abort, and LKG-publication checks remain intact. The final full run passes without changing the embedding test or any timeout.
- TypeScript **5.9.3**: package typecheck (retina build config and Pi no-emit config) and the probe-project no-emit check pass on Linux. Biome **2.5.1**: Pi lint passes, **303 files**, with 49 existing warnings.
- Three new unit tests cover ended-pass ownership origin, fatal dispatch-generation invalidation, and byte-preserving completed retries at 115s. Existing issue 640/641 cancellation, writer, deadline, receipt-reset and side-latch tests run in the full suite.
- Three selective unit mutation controls each fail exactly one named test while another named control passes: admit supersession unconditionally; erase the dispatch ownership origin; expire completed retries on the preparation clock. A fourth, real-host mutation corrupts the separately recorded expected managed history: the payload comparison emits `dispatch history differs from recorded managed output` and the collector-side host check fails with `managed output comparison was not reached`, while HTTP-count and retry-byte checks still pass. All mutations use `NON-VACUITY BREAK`, staged-live-state restoration, and non-empty/empty diff-stat pairs. The positive `retry` probe was rerun after restoration before collecting the final receipts.
- All hosts run locally at nice level 10. Both per-session throwaway roots and the enclosing `issue-663` temporary root (including native extraction caches) were removed after host exit. Suite logs are retained outside build output in `local-ignore/issue-663/verification/`; host evidence remains in `local-ignore/issue-663/host/`.

## Dispatch outcome after issue 667

The reproduction and 18 receipts above were recorded before master switched dispatch from writer-ownership checks to the latest completed managed receipt (issue 667, merged at `6309150a`). They remain evidence of the older advisor-attribution failure, not a claim that current master still refuses a superseded pass. The branch has now been rebased onto that master revision.

The latest-receipt dispatch decision reads the current operation's completed managed receipt directly, without re-running its writer-ownership assertion. Supersession of an older pass does not refuse the current turn. The issue 663 test that previously required a dispatch-generation abort now requires admission of the completed managed result, no owner-guard call at dispatch, unchanged payload bytes, and zero aborts. Its old unconditional-supersession-bypass mutation proof is historical and no longer describes the current dispatch contract.

An ended run is different: its receipt cannot authorize a request after its own end. The latest-receipt check retains the explicit refusal text `recovery=no managed result; refused (the run that owned the latest context pass has ended; no managed result for this request)`. The diagnostic improvement that still applies is its source and last preparation stage: `stage=provider dispatch (origin=agent_end; context stage=final publication)`. The ended-run test now checks this label alongside that reason and recovery text; it does not classify that refusal as a superseded context result. The obsolete special supersession recovery branch was removed. No ownership assertion or supersession refusal was reintroduced at dispatch.

The historical host receipts were not regenerated or relabeled as runs of the latest-receipt dispatch check. New verification and selective mutation controls cover the rebased tests and retained ended-run diagnostic.

### Verification on the rebased branch

- Linux `linux,8c`, Bun **1.4.2**: complete Pi suite **2064 passed, 32 skipped, 0 failed**, 2096 tests / 213 files / 162236 assertions. The targeted issue 663/667 suites also pass: **28 tests / 104 assertions**.
- TypeScript **5.9.3**: package typecheck and probe-project no-emit checks pass on Linux. Biome **2.5.1**: Pi lint passes, **313 files**, with 49 existing warnings.
- Two new selective mutation controls each fail one named test with a passing control: erasing the ended-run origin/stage fails `issue 663: ended run refusal preserves its ownership origin and preparation stage`; reintroducing `budget.assertOwner()` at dispatch fails `issue 663: completed managed pass stays admitted when its writer owner guard reports supersession`. Both mutations were marked `NON-VACUITY BREAK`, applied after staging the live state, and restored from the index with empty diff stats. These replace the old fatal-supersession test's obsolete dispatch contract.
- No new host runs were needed for this compatibility change. The 18 historical receipts remain byte-for-byte unchanged. Rebased suite logs are retained in `local-ignore/issue-663/verification/` outside build directories.
