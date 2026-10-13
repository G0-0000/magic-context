# Issue 673: a delayed end invalidates an already dispatched OMP pass

## What was reproduced

Pinned **Oh My Pi 18.9.2** (`pi-coding-agent`, `pi-agent-core`, and `pi-ai` all 18.9.2), Bun 1.4.2, macOS arm64, full Magic Context 0.49.0 extension, loopback Anthropic mock provider. The baseline uses `pi-context-refusal.ts` from `e75dcf1a1daf47e49c01364db6f1866bf792e0d3`; the other plugin sources are identical in both builds.

A delayed end of run 1 can arrive **after run 2's first provider dispatch**, not just before it. If run 2's provider rebuilds the request, its second invocation of `before_provider_request` is refused. The baseline produces the reported text verbatim, including `origin=agent_end; context stage=LKG/served publication`. Run 2's context pass was published and its first request was already managed. The dispatch fence's old `operation.dispatched` exclusion prevented attributing the delayed end to run 1, even though run 2 was still running.

The probe holds run 1's real extension notification in a preceding handler. Run 2's first HTTP response rejects strict tools with `400 invalid_request_error: structured_outputs not supported`. That releases the held end and makes OMP's real Anthropic adapter rebuild its request without strict tools. The retry hook waits for the held notification to finish. No fake lifecycle event, hand-built provider request, database lock, subagent, side turn, timeout, or user abort is involved. This deterministic hold represents a slow notification handler; an ordinary two-prompt run without the hold also succeeded.

**Limit of the finding:** the reporter supplied no payload/event trace or exact 18.9.x patch version. This demonstrates a concrete sufficient cause for the exact refusal, not proof that their two Linux incidents used strict-tool fallback. Other provider rebuilds can exercise the same exclusion. We did not reproduce their exact 6,958/21,556 ms durations or run the real host on Linux. `elapsed` measures the age of the pass, including time after preparation and provider/network waits; it is not proof of a 25 s preparation timeout. The reproduced pass completed well before the deadline, and this fix does not extend that deadline.

## Event order and content identity

Canonical receipts: [`issue-673/host-receipts.json`](issue-673/host-receipts.json). Times below are milliseconds relative to entry into run 2's context hook, from the baseline receipt:

| Offset | Event |
|---|---|
| before 0 | run 1's real `agent_end` arrives at the preceding handler and is held; run 2's `agent_start` reaches the guard |
| 0 | run 2 context pass starts with first prompt, first reply, second prompt |
| 11 | run 2's durable `lkg_slots` row has `captured_at` set |
| 14 | probe reads that row and observes the context handler return managed messages |
| 18 | first `before_provider_request`; admitted; managed HTTP request follows |
| 21 | run 1's held `agent_end` reaches the guard, carrying only first prompt and first reply |
| 23 | earlier notification finishes |
| 28 | same run's strict-tool fallback calls `before_provider_request` again |
| 28 | baseline refuses at `elapsed=29ms`, calls session abort; second attempt never reaches HTTP |

The fixed build sends **3 HTTP requests** (run 1, run 2's rejected request, run 2's successful retry), versus **2** in the baseline. All HTTP requests carry Magic Context ordinal tags. Both hook attempts for run 2 have the same message SHA-256, same full native-branch SHA-256, and same last native message entry ID, in **both** builds. Only strict-tool settings change. These are comparisons of two independently captured attempts, not a file hashed against itself. The fixed request pair also has byte-identical HTTP `messages` arrays. The first cold context pass has no durable LKG slot yet; the second/retried pass does, and the probe checks that publication before dispatch.

Raw `audit.jsonl`, `hooks.jsonl`, output, and `lsof-{start,end}.txt` remain at the receipt's throwaway roots. The committed receipt preserves the meaningful event records, LKG rows, native anchors, independent fingerprints, refusal text, and store descriptors, so evidence does not depend on retaining a build directory.

## OMP 18.9.2 source citations

These are paths and line numbers in the **published npm packages at 18.9.2**, not citations to another OMP version. Install with the instructions below to inspect them.

* `@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:4182–4190`: end maintenance retains the live `agent.state.messages` array separately from the public run's `event.messages`.
* Same file `:5040–5071`: settle publishes the public end, then starts `#emitAgentEndNotification([...activeMessages], options)` with `void`. The extension notification is detached. `:5137–5143` explicitly excludes it from the ordinary extension-event forwarding path.
* `@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:1620–1625`: notification handlers run in extension/handler order. A preceding slow handler can delay the guard's end independently of the next run.
* `@oh-my-pi/pi-agent-core/src/agent-loop.ts:620–648,682–709`: fresh runs and continuations emit `agent_start` before their loop. `:1914–1949` prepares transformed context before the provider call; `:2085–2100` passes `onPayload` to the provider.
* `@oh-my-pi/pi-coding-agent/src/sdk.ts:4157,4196–4219`: extension context preparation precedes provider transformations; the payload callback invokes the extension runner's `emitBeforeProviderRequest`.
* `@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:1989–2025`: context messages are cloned before extension preparation (with a shallow fallback for uncloneable objects). `:2058–2092` invokes provider-payload handlers in order.
* `@oh-my-pi/pi-ai/src/providers/anthropic.ts:2631–2691`: `prepareParams` builds from the same `preparedContext` and calls `onPayload` at line 2658. `:2843–2845` rebuilds by calling `prepareParams` again. `:3551–3570` recognizes the strict-tool rejection, disables strict tools, rebuilds, resets the response state, and continues the provider loop. **There is no intervening context pass or agent run.**
* `@oh-my-pi/pi-ai/src/error/flags.ts:296–318` recognizes the probe's `structured_outputs not supported` error as a strict-tool rejection.
* `@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:6127–6129,8125`: extension idle status accounts for both agent streaming and a prompt still in flight. It is used only to reject ambiguous preservation, never to establish identity.

The public agent-core end holds that run's `newMessages` (`agent-loop.ts:629–635,1112–1120`); the extension end carries the conversation array copied at settle. Confusing those two arrays would give the wrong attribution evidence. The probe records both streams.

## Fix and fail-closed cases

The undispatched issue 667 attribution rule is retained. For an **already dispatched** pass, the new exception requires all of:

1. Another start remains outstanding after accounting for this end, and this pass has a delivered start.
2. The latest pass completed with a ready, unrefused, unabandoned receipt.
3. Before handler rewrites, capture exact raw message field tokens using the same LKG content-identity machinery (`lkgContentFields` / `exactReusablePrefix`), not timestamp keys alone or a hash-only comparison.
4. Bind those fields to the host's last native message entry ID, only when the host's in-memory history exactly matches them. OMP persists the new prompt concurrently, so binding can occur at publication or the first admitted dispatch. There is no SQLite access, await, payload serialization, or hashing at that dispatch.
5. At end attribution, the same native ID and **all** original fields still match the current host history, and the session is not idle.
6. Every ended message is an exact, ordered prefix of that original input, with strictly fewer messages. This positively identifies an earlier transcript; absence of an arbitrary timestamp is insufficient.

Only then is the earlier end ignored. The fence still requires the current operation's latest managed receipt; it does **not** replay an LKG slot at dispatch or authorize an ended run's payload. A new start without a pass still refuses once. Running preparation from the synchronous payload fence would be the wrong layer: the provider already built its body, and safely re-preparing requires the host's original context/anchor, not a lossy provider representation.

An owning end retaining all input is not a shorter prefix. Pruning/compacting the owning run changes the native entry or input; an idle abort is rejected even if history remains intact. Missing/unreadable history, custom model messages requiring conversion, changed native IDs, equal timestamps with different content, and unprovable continuations fail closed. In particular, `willContinue` alone cannot preserve a dispatched pass. Existing nonce checks still reject superseded raw fallback arrays and retries; diagnostics still mint no receipt. The pre-existing side-session/advisor policies are unchanged.

## Tests, mutations, and gates

* `issue-673-late-dispatch.test.ts`: 15 tests, including the successful fallback, owning end with identical previously managed payload, idle abort, native ID/content changes, end-content mismatch, equal/empty end, pruning, unreadable/unmatched native history, new start without a pass, missing earlier start, concurrent prompt persistence, and an owning `willContinue` end.
* Final restored Linux run (`linux,4c`): issue 667 worker/review, issue 668, and issue 673 files together: **41 pass, 0 fail, 212 assertions**.
* [`issue-673/mutations.json`](issue-673/mutations.json) records canonical controls, exact red and green test names (via an explicit name map), and nonempty/empty diff pairs. Every canonical control made exactly its expected test red. Controls include original-vs-fixed real host, native anchor, initial/current/end content, strict prefix, idle, lifecycle, deferred anchor binding, owning-end invalidation, issue 667 attribution, issue 668 diagnostic isolation, and superseded nonces. All source mutants were restored from the staged live implementation and touched before delivery.
* TypeScript 5.9.3: Pi package typecheck passed; probe-specific `tsconfig.omp-issue-673.json` passed. Fresh scoped inspection reported 0 authoritative diagnostics for the production file; the checkout call-graph analysis was unavailable.
* Biome 2.5.1: package lint checked **318 files, 0 errors, 67 existing warnings**. Changed production/test files had no lint findings.
* Full Pi suite on Linux/4 CPUs: **2,129 pass, 36 skip, 5 fail**. Our isolated `HOME` had not been created: four temp-fixture tests failed with ENOENT; the smart-note compilation test also refused path resolution. All five failed identically with the original fence. After creating the isolated HOME, a focused rerun of those exact five tests passed (**5 pass, 13 assertions**). No baseline test was rewritten, and the whole 4.4-minute suite was not repeated after fixing that command setup.
* Local full-plugin build (needed for Mac real-host runs): Bun 1.4.2 bundled 22 browser modules and 1,022 plugin modules. Final real-host regression: **5 checks passed**, no refusals, unchanged managed retry messages.

## Isolation and reproduction

All host processes start with `HOME`, `CFFIXED_USER_HOME`, every XDG directory, `TMPDIR`, `PI_CODING_AGENT_DIR`, `MAGIC_CONTEXT_STORAGE_DIR`, and `OPENCODE_DB` under a fresh `$TMPDIR/magic-context/issue-673/` child. Extension discovery is disabled and the SDK cwd is that child. The host validates those variables before importing OMP. `lsof -p <host pid>` ran at startup and completion: the canonical baseline/fixed processes each had **25/29 relevant descriptors**, respectively, all under their own throwaway root. OS/runtime/library descriptors naturally remain outside it; no live database, Pi/OMP profile, or protected live config was opened.

```sh
# Install outside every checkout and isolate the installation process as well.
ROOT="$TMPDIR/magic-context/issue-673/host-18.9.2"
mkdir -p "$ROOT"/{home,config,data,cache,state,runtime,tmp,storage,install}
export HOME="$ROOT/home" CFFIXED_USER_HOME="$ROOT/home" TMPDIR="$ROOT/tmp"
export XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data"
export XDG_CACHE_HOME="$ROOT/cache" XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime"
export MAGIC_CONTEXT_STORAGE_DIR="$ROOT/storage" PI_CODING_AGENT_DIR="$ROOT/home/.omp/agent"
printf '%s\n' '{"private":true,"dependencies":{"@oh-my-pi/pi-coding-agent":"18.9.2"}}' > "$ROOT/install/package.json"
bun install --cwd "$ROOT/install"
# From this repository (the script starts a separately isolated host root):
bun run --cwd packages/pi-plugin build
MC673_ROOT="$ROOT" MC673_HOST="$ROOT/install" bash scripts/omp-issue-673.sh late-retry
# Optional ordinary two-prompt control:
MC673_ROOT="$ROOT" MC673_HOST="$ROOT/install" bash scripts/omp-issue-673.sh normal
```

To compare the original fence, stage the live source first, substitute the base revision's fence, build and run the same host regression, then restore **from the index** and touch the source before rebuilding. Never restore an unstaged implementation or leave the baseline source in a delivery commit.
