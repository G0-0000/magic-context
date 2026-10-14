# Issue 673 review follow-up: four findings addressed

This is the preserved pre-structural receipt. [The structural first-send follow-up](issue-673-structural-dispatch.md) strengthens its generic-prefix witness, reruns the exact hosts and mutations, and states the remaining same-structure/text-only limit. The cache, prompt and object-order changes below remain in effect.

The independent review commit `6096e6d6fc036f96d340f894e80dfde4546b79da` was cherry-picked as `b3288ff7b0d3ea599b42af15966f5466e3d4935a`. Its historical report/receipts remain intact; its four defect witnesses now assert the repaired behavior.

## Changes

1. **Anthropic cache fallback:** the comparison ignores `cache_control` only on direct Anthropic system/content blocks. A singleton text-block array is equivalent to a string only at those content/system positions, and only when it contains no other meaningful fields. Nested metadata, Responses cache fields, reasoning, extra block properties and array order remain significant. The actual OMP 18.10.3 goal cache-rejection run now sends four managed HTTP requests with no refusal.
2. **Responses prompt:** the complete `prompt` object participates in identity, including id, version and all variables. Response-chain identifiers and conversation/instructions remain bound.
3. **Completed overlap:** a signature is captured from the **returned managed context**, not the incoming provider body. Every non-exempt dispatch must carry that signature. First admission then records the provider-conversation fields; subsequent callbacks compare those fields even without a retained end. The earlier raw body in the review's overlap witness lacks the replacement receipt's managed memory prefix and is refused.
4. **Object order:** objects are emitted in canonical sorted key order. Arrays, message order, tool-call order and reasoning order are not sorted.

The typed comparison lives in `pi-dispatch-identity.ts`; it emits LKG-compatible primitive tokens without whole-body `JSON.stringify`. It limits traversal to 100,000 nodes, 128 levels and 32 Mi UTF-16 string/key units. Unknown/cyclic or over-budget comparison data cannot establish equality.

## Signature decision and limits

A full independent reproduction of OMP's post-context renderer would incorrectly reject secret obfuscation, PNG prompt compaction and other legitimate transforms. To avoid repeating those legitimate-send refusals, the first-send check uses a cheap prefix that survives those transforms. The selected prefix comes from the returned managed head: an injected history/memory delimiter or a tag number; simple handler fixtures use a bounded first-text prefix. Detection examines at most eight message entries and 32 text blocks each, with a 4,096-character prefix per block. It inspects message text fields, not arbitrary metadata, and never serializes the body.

This is a **managed-prefix witness**, not a cryptographic attestation of every byte on first admission. It closes the reported completed-pass raw-overlap witness. An adversarial body that deliberately copies the current managed signature, or an old managed body with an identical signature before first capture, remains a residual limitation of this cheap scheme. Later callbacks are bound to the first admitted complete conversation tokens. The review's hybrid-shape and post-attribution branch-drift observations are unchanged and are not silently presented as repaired.

The existing verified side-session latch and advisor envelope exemption stay in their original positions. Nonce checks still execute before these classifications and the signature. No exemption was added for the signature, images, secrets or snapcompact.

## Actual transform proof

`transform-proof` uses the real OMP 18.10.3 SDK and native post-context pipeline, not replacements for those transforms. It seeds history through the host's SessionManager and Agent APIs, supplies a steering user message, an older large tool result plus a later result, a real one-pixel PNG, a long token-dense system prompt, and a configured **fake** secret in the throwaway `secrets.yml`. The mock model is vision-capable and specifies the native `o200k` tokenizer so the real rasterizer's savings gate is meaningful.

The native snapcompact transform is observed by a delegate wrapper which logs its actual options and native savings estimate, then calls the original method unchanged. The successful run observes:

* fake secret present in the context input but absent on HTTP;
* the native `User interjection during work: priority` steering notice;
* date/cwd reminder on the wire;
* the system PNG stub and generated frames;
* the historical tool-result PNG note and the distinct original one-pixel source image;
* two admitted, managed HTTP sends and no refusal.

Thus `wrapSteering`, `convertToLlm`, secret obfuscation, image conversion/normalization, system/tool snapcompact and the date/cwd reminder preserve the selected managed prefix in the exercised stock pipeline. No signature bypass for image/obfuscation markers was needed. Arbitrary operator secret regexes that specifically redact the managed delimiters were not tested and are not claimed equivalent to this fixture.

Fixture development initially used an invalid secret type (`literal`, corrected to the source-supported `plain`) and approximate byte counting on a model with no tokenizer. The real native savings trace showed margin rejection, not rasterization. The final fixture uses `tokenizer: o200k` and proves swaps; unsuccessful eligibility runs are not counted as transform proofs.

## Existing fixture corrections

The strengthened admission rule exposed state-only tests that dispatched empty arrays or an unrelated literal `managed` rather than the messages their handler returned. Their payload fixtures now use the actual returned current-pass messages; their ownership, deadline, late-end, abort and retry assertions are unchanged. The two fake 667 harnesses also prevent an older handler's late return from replacing their fixture's current payload.

Nonce membership tests now prepare the candidate from a fresh handler pass before exercising retained/retired/other-session UUID markers. This preserves their original nonce assertions without authorizing an unrelated raw body solely because its nonce expired or belongs to another session. Partial-marker negative checks use unchanged managed messages plus a metadata fragment. The positive marked fallback remains refused before identity checks. These are intentional fixture-contract changes required by the review's inherited admission finding, not a weakening of the 668 nonce fence.

## Verification and cost

Verification and benchmark environment: remote Linux, four allocated CPUs, Bun 1.4.2, TypeScript 5.9.3:

* Package and probe typechecks passed.
* Full Pi package suite: **2,168 pass, 37 skip, 0 fail**, 162,757 assertions, 2,205 tests across 220 files. Package lint checked 322 files with zero errors and 67 existing warnings (Biome 2.5.1). Frozen-lockfile install checked 1,013 installs/1,254 packages without changes.
* Requested 641/667/668 plus 640/663/673/674/review cases and identity tests: **106 pass, 5 opt-in skips, 0 fail**, 421 assertions, 111 tests across 15 files.
* The review's exact fixture has **1,000 messages and 5,299,891 body bytes**, with ten warmups and 100 measurements. Parsed-body copies are created outside timing.
* Signature-only median **0.000340 ms**, p95 **0.001783 ms**, maximum **0.210213 ms**.
* Ordinary callback with full identity comparison median **0.786974 ms**, p95 **5.407455 ms**.
* Retained same-reference callback median **0.444732 ms**, p95 **0.963333 ms**.
* Retained independently parsed strings median **2.139345 ms**, p95 **5.794459 ms**, maximum **12.469258 ms**.
* First dispatch **2.096215 ms**; native end attribution **3.730295 ms**. Whole-body stringify baseline median **1.258897 ms**, p95 **7.921072 ms**.

These are observed synchronous costs, not hard millisecond guarantees. Structure/string limits bound work and memory; JSC warmup/GC and parallel runner load affect tails. No nonce serialization, HTTP or DB was included in the benchmark. The pre-existing nonempty nonce scan's serialization remains unchanged.

Mutation proofs for cache normalization, prompt binding, current-receipt signature and canonical object ordering each produced exactly its named expected red and a named green control, with staged implementation/nonempty mutation/empty restore evidence. See `issue-673-review-fixes/mutations.json`.

Actual-host receipts are in `issue-673-review-fixes/host-receipts.json`. Every run starts with HOME, CFFIXED_USER_HOME, all XDG directories, TMPDIR, PI_CODING_AGENT_DIR, MAGIC_CONTEXT_STORAGE_DIR and OPENCODE_DB inside the throwaway issue root. Startup/completion `lsof` data proves only throwaway relevant store/config descriptors. No live store or protected profile/config was read.

