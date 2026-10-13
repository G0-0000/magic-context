# Independent review: OMP dispatch fence after delayed agent ends

Reviewed range: `e75dcf1a..1dce69accf70377515aaa55966f8d44fed597e58`.
This is a report-only review. Product source and the existing host fixture are unchanged. New tests deliberately record both good behavior and defects; a green witness asserting admission is **not** a claim that admission is safe. They belong to a review-only commit, not an unchanged regression contract for a later fix.

**Terminology:** the dispatch fence is the synchronous `before_provider_request` hook that may abort a send. A context pass is one Magic Context preparation hook. Managed history is its returned memory-injected/tagged/pruned conversation; raw history is the pristine host transcript before preparation. A receipt is the fence's in-memory record that a pass finished. Dispatch admits a provider attempt, including a retry that does not rerun preparation. A native anchor is a persisted session entry ID captured with the original input. A delayed earlier end is an `agent_end` notification from an older run delivered while a newer run is active. Strict-tool fallback rebuilds a provider request with strict tool-schema enforcement disabled after an unsupported-feature error. The UUID nonce marker prevents a throwing, superseded pass's raw fallback from borrowing another pass's receipt.

Severity labels: **P0** critical, **P1** high, **P2** medium, **P3** low. Run IDs below identify throwaway host executions and their archived receipts; test names identify executable witnesses in `packages/pi-plugin/src/issue-673-review.test.ts`.

## Summary

The ordinary strict-tool retry and real goal continuation reproduce successfully on OMP **18.10.3**. The issue 668 marked raw fallback is still refused before the new identity comparison, and owning ends, changed native input, changed response chains, missing receipts, and tool-loop followups retain their tested behavior.

I did **not** find an unmanaged HTTP request in the stock real-host goal run. I did find a real-host legitimate retry that the new identity path refuses, and an omitted Responses prompt field that can carry provider-bound input. Therefore the identity check is neither complete for every supported request option nor sufficiently permissive for every legitimate provider retry. The stronger universal claim that *any* current receipt authorizes only its own managed bytes also remains false in the inherited overlapping-pass case.

No P0/P1 finding is established. Findings below distinguish real-host evidence, fence-level witnesses, and inherited behavior. I recommend addressing the cache-only retry and prompt-field coverage before claiming general retry compatibility and complete conversation identity. The core strict-tool/late-end fix itself works in the reproduced default scenario.

## Findings, ranked

### P2 — Legitimate Anthropic cache-control fallback is refused after the earlier end

**Location:** `packages/pi-plugin/src/pi-context-refusal.ts:145-151,549-562`; typed comparison in `packages/plugin/src/hooks/magic-context/lkg-slot.ts:258-295,489-519`.

The comparison includes every nested `cache_control` field in messages and system blocks. Real OMP 18.10.3 retries a rejected cache feature by rebuilding the same request with cache breakpoints removed. Removal can also turn a cache-decorated singleton text-block array back into string message content. Neither change introduces raw history, but both change these field tokens.

**Real witness:** run `run.wE8LAb`, recorded in [host-receipts.json](issue-673-review/host-receipts.json). The existing goal probe's mocked third-request 400 was changed from `structured_outputs not supported` to `cache_control is not supported`; no adapter or product source was changed. OMP's actual fallback then rebuilt the fourth provider hook without a new context pass. The prior detached end had already been delivered, just as in the ordinary strict fallback.

* Three context passes, four provider hooks, only **three HTTP requests**.
* First five named host checks pass: managed HTTP, durable publication, stable persisted prefix, fresh goal context but no new pass for fallback, and shared main/session identity.
* The fourth hook has no cache breakpoints. The third had `messages[7].content[0].cache_control`, `messages[8].content[0].cache_control`, `system[2].cache_control`, and `tools[18].cache_control`, all `{type:"ephemeral"}`.
* The conversations are equal after removing cache-control fields and canonicalizing singleton text-block content to strings. Full before/after conversation fields are archived for independent inspection.
* One `before_provider_request` abort prevented the legitimate fourth HTTP send and produced the refusal: `provider request does not match this pass's managed dispatch`.
* The old strict-fallback assertion fails because there is no fourth HTTP request; its later no-refusal assertion is not reached. The refusal entry and abort, not merely that assertion failure, establish the defect.

**Unit witness:** `review witness: dropping Anthropic cache breakpoints refuses unchanged text` changes only a system block's cache breakpoint and observes refusal.

Pinned host source: `@oh-my-pi/pi-ai@18.10.3/src/providers/anthropic.ts:3592-3630,3668-3684` implements the real cache-option/cache-field retry ladders. The inspected installed copy is the throwaway pinned host library, not a live profile. The equivalent published source is [UNPKG](https://unpkg.com/@oh-my-pi/pi-ai@18.10.3/src/providers/anthropic.ts).

**Suggested boundary:** compare provider-visible conversation content with narrowly schema-aware normalization of cache-only decorations and equivalent text representations. Do not ignore general metadata, reasoning, or arbitrary message fields to make this pass. This is an incomplete extension of the fix, not a claim that the pre-range fence admitted this scenario: that fence refused all such post-end retries.

### P2 — Responses `prompt` can change provider input without changing identity

**Location:** `pi-context-refusal.ts:153-160,549-562`.

The Responses branch binds `input`, `instructions`, `previous_response_id`, and `conversation`, but ignores `prompt`. A stored prompt template's ID/version and variable values affect provider-bound prompt content. A transcript can be supplied as a string variable; image and file input values are also supported. This disproves the proposition that every ignored field is incapable of carrying input/history.

**Witness:** `review witness: retained Responses receipt ignores a changed prompt template` dispatches a managed `input` first, retains the receipt across the prior end, and changes only `prompt.id` and `prompt.variables.transcript`, setting the transcript variable to `RAW_UNPREPARED`. The fence calls neither abort nor refusal for that prompt-only change. The witness then changes the compared `input` in the same harness and observes the expected mismatch refusal, proving the retained comparison was active. Its Responses input uses only wire role/text fields, not native timestamps or usage metadata. This is a fence-level request witness, **not** a cloud request with a real saved prompt ID, and not an observed default OMP raw fallback.

The official [OpenAI prompt parameter type](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_prompt_param.py) permits `id`, `version`, and variables of string/text/image/file input types. The [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create/) and official request types list `prompt` alongside `input` and `instructions` without a documented exclusion. These are unversioned official references; no live cloud provider was used. OMP 18.10.3's [Responses provider](https://unpkg.com/@oh-my-pi/pi-ai@18.10.3/src/providers/openai-responses.ts) documents `extraBody` at lines 162-172 and merges it at 1756-1772, so this is not a field the adapter necessarily discards. Default OMP body construction does not itself enable a saved prompt template.

**Suggested boundary:** include prompt-template identity/variables, or reject it and other unsupported content-bearing representations under a retained receipt. Use provider-specific known-control allowlists rather than assuming all nonselected top-level fields are controls. Ignoring tool-schema ordering for strict fallback remains necessary, but does not justify ignoring arbitrary new conversation channels.

### P2 — A completed overlapping pass can authorize an earlier raw request (inherited gap)

**Location:** `pi-context-refusal.ts:522-548,549-562,626-632`.

Outside `retainedAfterEnd`, dispatch tests completion/ownership state but not the body against the pass's managed output. Completing a fresh pass resets the retained-body comparison. A superseded *throwing* pass receives the issue 668 nonce; a previously completed pass does not.

**Witness:** `review witness: a completed overlapping pass authorizes the prior raw request`: run A completes and dispatches; run B starts and completes preparation with an extra message; a delayed body containing only A's pristine raw messages then uses B's ready receipt and is admitted. It lacks both B's new input and the injected managed memory prefix. No nonce is present because A's handler did not throw. The same named witness passes with the actual `e75dcf1a` source substituted, proving this is **not introduced by the reviewed range**.

This demonstrates the admission invariant's limits, not that the stock OMP adapter was observed generating a raw retry after a successfully completed A pass. A second real overlapping goal workflow was not reproduced. A delayed A *managed* payload would likewise not be tied to B's receipt. To establish the stronger rule at this boundary requires provider-operation identity or comparison for normal dispatch too; the late-end-only comparison is insufficient. Do not remove the existing nonce checks.

### P3 — Semantic object-key reordering alone causes refusal

**Location:** `lkg-slot.ts:277-285,497-499`, invoked by `pi-context-refusal.ts:554-557`.

Object keys are tokenized in insertion order, not canonical order. `review witness: equivalent message object key order is refused` reverses each message object's key order without changing values and gets a content-mismatch refusal after retention. JSON object order is not conversation identity. I found no stock 18.10.3 retry path that performs this reordering, so this is a compatibility hardening issue, not a reproduced production recurrence. Array/message/tool-call order must remain significant.

## Identity coverage

| Accepted representation | Fields captured and compared after retention | Ignored at the top level |
|---|---|---|
| Array `messages`, `input === undefined` | Entire `messages` tree and `system` | Every other key, including `instructions`, response-chain-like keys, `prompt`, `tools`, `tool_choice`, `model`, `metadata`, cache/reasoning/sampling/output controls, and additional unknown history representations |
| Array `input`, `messages === undefined` | Entire `input` tree, `instructions`, `previous_response_id`, `conversation` | Every other key, including `system`, `prompt`, `tools`, `model`, metadata/cache/reasoning policies, `include`, and additional unknown representations |

This is a structural shape selector, not a provider/API discriminator or exhaustive request validation. Nested fields inside the selected trees are visited, including cache controls, metadata, tool calls/results, reasoning items, and reference IDs. Missing/undefined/function/symbol object properties are omitted by the shared flattening helper, consistent with ordinary JSON properties; object insertion order is retained. Arrays remain order-sensitive. These tokens retain string values without deep-copying their bytes.

Ignored fields are **not all incapable of carrying provider-visible input**: prompt variables can, and tool descriptions/schema strings are also prompt-visible. Default adapter retry changes to tools are intentional and should remain allowed, but that does not prove arbitrary tool-description replacement could never embed a raw transcript. By contrast, sampling/output controls and provider metadata such as Anthropic `user_id` are not history arrays. Current default adapters do not generate a Messages body with Responses chain references or a mixed Gemini body; the fence itself nevertheless ignores such extra keys rather than rejecting the unknown combination.

## Additional safety boundaries exercised

* **Issue 668 marker case:** the unchanged suite's real conflict-fallback test rejects both Messages and Responses raw bodies, repeats refusal without revoking the winner, and retains the nonces across later successful passes. The nonce scan precedes advisor exemptions and the retained comparison. The 32-nonce cap and its existing serialization cost are unchanged.
* **Tool-loop continuation:** the new test uses actual assistant-tool-call/tool-result message shapes, updates native history, and prepares a fresh context with no new `agent_start`; dispatch succeeds. The real host likewise has two model/context passes in its first agent run. Internal provider retries are correctly distinguished from these fresh model passes.
* **Reasoning and nested metadata:** changing an `input` reasoning item's encrypted content or a nested message property is compared and refused. The Responses system and conversation reference controls are also directly tested. Top-level metadata, model, cache controls, and tool ordering are ignored and accepted by the explicit controls witness. Ignoring model alone does not establish a history leak if the same prepared conversation is reused.
* **Side turns:** the pre-existing verified ephemeral side-context latch disables the entire dispatch fence for that session, including later main payloads. Cleanup does not undo that latch. This is an intentional exception forced by session-wide abort and lost attribution, not evidence for an unconditional never-unmanaged claim. Issue 641's tests pin it; this review does not silently change that policy.
* **Advisors/auto-learn:** issue 663's advisor-envelope tests, user-spoof/incomplete-envelope tests, and raw auto-learn tests pass. Advisor requests do not mint a main receipt; the exact recognized envelope is an intentional exemption. A marker-bearing raw fallback is checked first.
* **Compaction/branch drift:** changed/pruned history *at end attribution* fails closed in the existing tests. A separate fence-level witness replaces the branch *after* successful attribution and then dispatches the old identical body; it is admitted because the branch is not rechecked on that retry. This does not demonstrate real native-compaction scheduling: ordinary fence-on mode cancels native compaction (`index.ts:358-383,2816-2823`), and compaction-off mode deliberately bypasses the fence. No branch/model-change guard is registered by this fence; successful session switches/shutdown do clear receipts. Treat the branch-drift witness as a future/concurrency limitation, not a proven compaction regression.
* **Unknown representations:** a pure Gemini-style body cannot establish retained identity, and a body with both `input` and `messages` fails to match either branch. However, adding `contents/systemInstruction` alongside `messages` is admitted by the new hybrid witness. No current adapter/endpoint acceptance of that hybrid was established; it is not counted as an unmanaged HTTP finding. It illustrates why recognizing just one field is not an exhaustive unknown-shape allowlist.

## Cost: 1,000 messages, 5,299,891 provider-body bytes

[Reproducible samples and method](issue-673-review/cost.json) come from the actual registered hooks in `issue-673-review.test.ts`, not a reimplementation of the comparison. Both Linux runs allocated four CPUs; the single hook executes synchronously. Each repeated condition has 10 warmups and 100 measurements. The first run executed only the new review test file; the final run included the 14-file regression selection. Fresh JSON-parsed copies were prepared **outside** timed dispatch, so equality cannot be satisfied only by reusing the same string references rather than comparing their content. The separate `stringify` baseline does serialize the whole body. No nonce scan, HTTP, or DB is included in these hook timings.

| Condition | First isolated run median / p95 | Final 14-file run median / p95 |
|---|---:|---:|
| Ordinary callback after first dispatch, no retained end | 0.0010 / 0.0060 ms | 0.0007 / 0.0014 ms |
| Retained retry, same objects/string references | 0.319 / 1.096 ms | 0.381 / 0.907 ms |
| Retained retry, independently parsed strings | 2.566 / 3.269 ms | 1.270 / 1.691 ms |
| Whole-body `JSON.stringify` baseline | 3.382 / 4.620 ms | 0.973 / 2.453 ms |

Single observations, listed as **isolated-file run / final 14-file run** (not median/p95): first dispatch **0.627 / 2.539 ms**; the earlier-end check that matches the full current native input to the prepared input **2.924 / 2.395 ms**; context preparation including fixture clone and handler **7.214 / 5.351 ms**. Maximum retained callback observed: **4.712 ms**. This is not a hard bound; nested tool JSON, images, larger histories, and other hardware were not benchmarked. RSS was not measured.

The fix does **not** compare the entire body on every ordinary send: it snapshots selected conversation fields once on the first dispatch, and re-flattens/compares them on retries only after a preserved end. The full current native history is read to determine whether an end belongs to an earlier run, and sometimes to bind the first-dispatch anchor to newly persisted input, not on every callback. It does restore an O(structure + unequal-reference string bytes) hot path on retained retries, with a measured absolute cost of roughly **1–3 ms per 5.3 MB rebuilt body**, comparable to serialization in these samples. This is not a release-blocking performance finding at the measured size; the previous nonce-free no-serialization regression still passes.

To bound larger inputs without weakening safety, cap inspected nodes/bytes and fail closed beyond the cap, or establish an immutable/versioned host conversation identity and capture fingerprints outside synchronous dispatch. Do not memoize by mutable object identity alone, skip tail/native-content checks, or reintroduce whole-body serialization on every ordinary request. Provider-aware canonicalization for the compatibility findings should preserve message/array order and content-bearing fields.

## Independent host runs and isolation

The full base build was already prepared in this review worktree. Both runs used that build and the exact read-only throwaway `@oh-my-pi/pi-coding-agent@18.10.3` installation described in [the issue 674 host report](issue-674-goal-dispatch.md), at `$TMPDIR/magic-context/issue-673/host-18.10.3/install`; no live profile/config/store was read. Hosts themselves start under:

```
$TMPDIR/magic-context/issue-673-review/magic-context/issue-673/{review,review-cache}/run.*
```

The existing `scripts/omp-issue-673.sh` validator requires the root to contain `/magic-context/issue-673/`. The nested component satisfies that check while remaining wholly inside the mandated `issue-673-review` isolation. An initial invocation with a shallower review root exited 2 at that validator **before any host started**. The successful invocation uses:

```sh
mkdir -p "$TMPDIR/magic-context/issue-673-review/magic-context/issue-673/review"
MC673_VERSION=18.10.3 \
  MC673_ROOT="$TMPDIR/magic-context/issue-673-review/magic-context/issue-673/review" \
  MC673_HOST="$TMPDIR/magic-context/issue-673/host-18.10.3/install" \
  bash scripts/omp-issue-673.sh goal-late-retry
```

The wrapper sets HOME, CFFIXED_USER_HOME, **all six XDG directories**, TMPDIR, PI_CODING_AGENT_DIR, MAGIC_CONTEXT_STORAGE_DIR, OPENCODE_DB, and the log path before starting Bun/OMP; the host validates the values before import, uses the isolated cwd, and disables extension discovery. Both startup and end `lsof` proofs are archived as the relevant raw descriptor lines in the JSON receipts: **25/29 descriptors for each run, all under that run's root**. Other descriptors are libraries/runtime/OS files, not stores. Read-only host package files are outside these run roots by design.

* `run.HiWq89`: **7 checks pass, 4 HTTP requests, 3 context passes, 4 provider hooks, no refusal**, every HTTP request managed. The real RPC goal controller, tool step, detached earlier end, and strict-tool fallback all execute.
* `run.wE8LAb`: cache-rejection witness described above; **5 checks pass, 1 named strict-fallback check fails, final no-refusal check not reached**, 3 managed HTTP requests, 1 actual mismatch refusal/abort. The fixture change was staged, marked, measured as `1 file changed, 2 insertions(+), 1 deletion(-)`, then restored from the index and touched; working diff empty after restore. No fixture/product mutant remains.

The raw first/retry conversation fields, managed-wire booleans, named checks, refusals, aborts, and lsof evidence are in [host-receipts.json](issue-673-review/host-receipts.json). The cache witness is not merely a hand-altered retry payload: the native provider rebuild removes its own breakpoints in response to a mocked unsupported-feature error.

## Mutation proofs and gates

[mutations.json](issue-673-review/mutations.json) records exact red/green names and indexed restore evidence. Three original controls were rerun: **N3** (anchor outside ended prefix), **N7** (complete current input), and **N8** (response-chain reference). The independent control omits Responses **instructions** from identity. Each has exactly the expected single red and no other failures; controls/siblings remain green. N3/N8 ran all 16 issue 674 tests; N7 ran its two-test red/green selector; the independent control ran the then-current review file. The normal instruction/conversation test remains green after restoration.

All authoritative package gates ran on Linux/4 CPUs:

```sh
bun --version # 1.4.2
bun scripts/check-bun.mjs
cd packages/pi-plugin
MC673_REVIEW_BENCH=1 BUN_JSC_useOMGJIT=0 bun test --parallel=4 --timeout 30000 \
  src/issue-641-*.test.ts src/issue-640-641-*.test.ts \
  src/issue-663-dispatch.test.ts src/issue-667-*.test.ts \
  src/issue-668-*.test.ts src/issue-673-*.test.ts src/issue-674-*.test.ts
```

**98 pass, 5 opt-in/independent timing tests skipped, 0 fail, 398 assertions, 103 tests across 14 files**. This includes all existing issue 641, 667, and 668 suites selected above, plus 663, 673, 674, and 11 independent review tests including the benchmark. Before adding the witnesses, the requested regression selection passed **73 tests, 5 skip, 305 assertions**. After the broad gate, the prompt witness was tightened to use wire role/text fields and to reject a changed `input` in the same harness; the impacted review file was rerun with **10 pass, 1 benchmark skip, 0 fail, 35 assertions**, and package typecheck/lint passed again. The measured benchmark path was unchanged.

* `bun run --cwd packages/pi-plugin typecheck`: passed, **TypeScript 5.9.3**, both configured tsc projects. Exit 0 is the documented silent-success typecheck gate. The final subsequent test edit was whitespace-only formatting.
* `bun run --cwd packages/pi-plugin biome check src/issue-673-review.test.ts`: passed, **Biome 2.5.1, 1 file**. Initial formatting/non-null-assertion diagnostics were fixed; no outstanding lint findings remain.
* Tool-based scoped inspection (`inspect`, new review test file): zero diagnostics; structural analysis was incomplete because the checkout call graph was unavailable, so dead-code/cycle/complexity results were not established. The package tsc check is the type-safety gate, not that partial tool result.
* No package manifest/lockfile changes and no installs. No product build was needed after the review-only edits; real hosts used the prepared base build. Full Pi/workspace suites and cloud endpoints were not rerun; the narrow requested/regression tests and real mock host were used instead.

The code-level overlap, prompt-template, hybrid-shape, key-order, and post-attribution branch-replacement witnesses expose admission/compatibility behavior, but only the strict retry and cache-only retry have new real-host scheduling evidence. Original reporter traces, cloud prompt-template execution, and a second truly overlapping real goal workflow remain unverified.
