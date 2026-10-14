# Issue 673: structural first-send identity after review

This follow-up completes the four review findings on top of preserved commit `41eccf02dadae143cac1df8f9c096a3fc1c6ad04`. The [original 18.9.2 reproduction](issue-673-dispatched-late-end.md) and [18.10.3 goal-run investigation](issue-674-goal-dispatch.md) retain the baseline failing host evidence and lifecycle/source citations. The [earlier review-fix report](issue-673-review-fixes.md) records the cache, prompt and key-order changes; its generic managed-prefix witness alone was insufficient for stale **managed** first sends.

## Decision and implementation

No nonce, per-pass marker or other provider-visible bytes were added. A changing marker would invalidate cached history prefixes and could be copied into future model output. The parent specifically selected structural identity, with any remaining indistinguishable cases documented rather than silently claimed safe.

Every non-exempt provider callback now:

1. Requires the existing current, completed, ready, unrefused, unabandoned, unended pass. The issue 667/668 lifecycle and superseded-fallback checks remain in their original order.
2. Requires the existing bounded managed-head witness. This separates an ordinary raw overlap from a managed body; it is **not** a unique current-pass identifier.
3. Flattens **all selected conversation fields** into canonical typed tokens, without whole-request serialization. Missing, cyclic or over-budget comparison data refuses even on first admission.
4. Compares the returned managed array's **message count, ordered roles, every tool-call ID and every tool-result ID**, including the final user/tool turn, with the provider representation. Anthropic's packed result runs expand back to individual results; Responses assistant text/call items group back into a turn. A transported timestamp, if present, must match the prepared message's timestamp. Snapshots contain primitives, not mutable message references.
5. On first admission, captures the complete provider-conversation tokens. On **every** later callback, not only one after a retained end, compares those complete tokens with the captured tokens. A fresh context pass resets both structural and content receipts.

The first-send comparison is structural plus the managed-head witness, **not a byte-for-byte comparison of pre-transform text with post-transform text**. Secret obfuscation makes that byte comparison invalid. Full content is nevertheless traversed on first sends, rejected when unreadable, captured exactly, and compared on all subsequent callbacks.

The cache-only comparison admits the real Anthropic cache fallback, including singleton text block/string conversion only at direct system/content positions. Nested metadata and reasoning stay significant. The complete OpenAI Responses `prompt` field, instructions, conversation and previous-response reference remain bound. Object keys are sorted; message, block, reasoning and tool-call arrays are not sorted. No advisor or side-session exemption was expanded.

## Which identity survives OMP 18.10.3

These are exact npm-package source paths under the read-only throwaway installation `$TMPDIR/magic-context/issue-673/host-18.10.3/install/node_modules/`, not a floating checkout:

* `@oh-my-pi/pi-coding-agent/src/sdk.ts:4169–4179,4217–4242,4363–4371`: extension context precedes steering wrapping, LLM conversion, secret obfuscation/provider transforms and the payload hook.
* `@oh-my-pi/pi-coding-agent/src/session/messages.ts:704–724,732–755`: steering rewrites text in the message envelope, preserving role/timestamp; it does not add an agent turn.
* `@oh-my-pi/pi-agent-core/src/compaction/messages.ts:214–279`: custom/hook messages become developer messages; ordinary users, assistants and tool results preserve their core envelopes. The structural projection maps custom/developer roles to their user transport slot, rather than expecting a wire `custom` role.
* `@oh-my-pi/pi-coding-agent/src/secrets/message-transform.ts:671–741`: secret obfuscation changes text and tool arguments, not the tool-call/result identifiers or message-role sequence.
* `@oh-my-pi/pi-coding-agent/src/session/snapcompact-inline.ts:187–255,616–736` and `src/session/date-cwd-reminder.ts:44–128`: system/tool PNG swaps and reminders change content in the existing context messages, not the turn count or tool IDs. The real rasterizer and date/cwd path execute in the host proof below.
* `@oh-my-pi/pi-ai/src/providers/anthropic.ts:5727–5779,5873–5884,5921–5964`: user/assistant wire constructors omit timestamps and native entry IDs; `toolCall.id` becomes `tool_use.id`; `toolCallId` becomes `tool_result.tool_use_id`. Consecutive tool-result messages are packed into one user message, so comparing raw wire-array length directly would be wrong.
* `@oh-my-pi/pi-ai/src/utils.ts:36–38`: Anthropic tool IDs are normalized to ASCII and truncated to 64 characters. The comparison applies the same mapping to prepared IDs.
* `@oh-my-pi/pi-ai/src/providers/openai-shared.ts:2189–2197,2503–2529,2561–2597,2692–2753`: Responses users omit native timestamps/entry IDs, assistant text emits separate message items, and calls/results preserve a normalized `call_id`. Assistant replay message IDs may be dropped, regenerated or hashed; they are not universally stable identities that can be required from a prepared array. Complete retry tokens still bind any emitted IDs.
* `@oh-my-pi/pi-ai/src/utils.ts:44–55` and `src/providers/openai-shared.ts:1484–1501`: Responses separates the call ID from its replay item ID; the structural projection compares the call ID, not the generated item ID. IDs requiring an unprovable long/foreign provider hash refuse rather than guess.

There is therefore **no universally preserved user-turn timestamp, session entry ID or response ID in the serialized provider body**. Native fixture transports that retain timestamps are checked. On stock Anthropic wire, the final user turn is identified by its position in the complete count/role sequence; the final tool turn additionally has its ordered result ID. This limitation is explicit below.

## Real-host proof after restoration

All four final runs used Bun 1.4.2, pinned **OMP 18.10.3**, the rebuilt full Magic Context extension and a loopback Anthropic mock provider. [Receipts](issue-673-structural-dispatch/host-receipts.json) preserve event order, prepared/provider message envelopes, ordered tool IDs, managed text prefixes, named checks, native snapcompact plans, refusals and raw relevant `lsof` lines. Large text and PNG bytes are abbreviated; complete logs remain at the recorded throwaway roots.

| Run | Mode | HTTP | Checks | Refusals |
|---|---|---:|---:|---:|
| `run.L9r0WZ` | actual RPC goal, delayed earlier end, strict-tool fallback | 4 | 8 passed | 0 |
| `run.udBiFS` | same goal workflow, real cache-control fallback | 4 | 8 passed | 0 |
| `run.Xm2oC3` | native secret/steering/image/snapcompact/date/cwd transforms | 2 | 8 passed | 0 |
| `run.ZiZrgX` | same native transforms; earlier managed body substituted for replacement's first send | 1 | 8 passed | 1 intended structure refusal |

In both goal runs there are **3 context passes, 4 provider hooks and 2 main agent starts**. The continuation's LKG publication and first dispatch precede delivery of the held earlier run's end. The adapter's strict/cache fallback invokes the fourth provider hook with no fourth context pass or agent start. All four sends pass structural and complete retry identity.

The transform fixture uses OMP's SessionManager/Agent history, fake configured secret, real PNG image, steering message, long tool output and token-dense system prompt with the native `o200k` tokenizer. OMP's unmodified transforms obfuscate the secret, wrap steering, normalize images, generate system/tool PNG frames and insert the date/cwd reminder. Prepared roles grow from **9 to 11 messages** across the two prompts; both attempts preserve the `proof-large` and `proof-recent` call/result IDs. The positive run sends both managed requests. The negative run substitutes the **actual earlier captured managed provider body**, which has the same generic history prefix but only 9 prepared turns, for the replacement's first callback expecting 11. It is refused before HTTP; no retained-end comparison is involved.

Every host starts with HOME, CFFIXED_USER_HOME, every XDG directory, TMPDIR, PI_CODING_AGENT_DIR, MAGIC_CONTEXT_STORAGE_DIR and OPENCODE_DB beneath a fresh `$TMPDIR/magic-context/issue-673/structure-restored/run.*` root. The harness validates all variables before importing OMP, uses that root as cwd and disables extension discovery. Startup/end `lsof -p <host pid>` each record **25/29 relevant descriptors**, all under that run's root. No live database, Pi/OMP profile or protected live config was opened.

```sh
bun run --cwd packages/pi-plugin build # local: these binaries are used by the local host
mkdir -p "$TMPDIR/magic-context/issue-673/structure-restored"
for mode in goal-late-retry goal-cache-retry transform-proof transform-stale-first; do
  MC673_VERSION=18.10.3 \
  MC673_ROOT="$TMPDIR/magic-context/issue-673/structure-restored" \
  MC673_HOST="$TMPDIR/magic-context/issue-673/host-18.10.3/install" \
  bash scripts/omp-issue-673.sh "$mode" || exit $?
done
```

## Verification, cost and non-vacuity

* Linux/4 CPUs, Bun **1.4.2**, TypeScript **5.9.3**: `bun run --cwd packages/pi-plugin typecheck` and `bun run --cwd packages/pi-plugin tsc --noEmit -p ../../scripts/tsconfig.omp-issue-673.json` passed (both package tsc projects plus the probe project; exit 0 is the documented silent-success typecheck gate).
* `bun run --cwd packages/pi-plugin lint`: Biome **2.5.1**, **324 files**, zero errors and the same **67 existing warnings**.
* `bun run --cwd packages/pi-plugin test`: full Linux package run, **2,179 pass / 37 skip / 1 fail**, **162,776 assertions**, **2,217 tests / 221 files**. The only failure was the previously documented load-sensitive `Pi aborts slow embeddings at the deadline and replays byte-identical skip on retry`: elapsed **5,303.245 ms** exceeded its **3,150 ms** wall-clock bound. The isolated failed-test rerun passed at **3,011 ms**, **1 pass / 0 fail / 7 assertions**. No embedding/timing code or test was changed. Historical reports `pi-reclaim-double-bust.md:291` and `pi-append-cost-review-r2.md:137` name the same full-suite timing failure.
* The package test script's frozen-lockfile install checked **1,013 installs / 1,254 packages**, with no changes. No manifest or lockfile changed.
* Requested 641/667/668 plus related 640/663/673/674, identity and structural tests, with the opt-in cost test: **118 pass / 5 skip / 0 fail**, **446 assertions**, **123 tests / 16 files**. After all mutations were restored, the same selection without the already measured benchmark passed **117 / 6 skip / 0 fail**, **445 assertions**. Package/probe typechecks passed again; current four-file Biome check passed with no diagnostics. The owning-end/stale tests and superseded-nonce tests remain green.
* Local build for the real host: Bun **1.4.2**, **22 browser modules / 1,024 extension modules**, passed. Four restored exact-OMP runs then passed **32 named checks** in total.
* Initial scoped inspection reported zero production errors/warnings but did not cover the standalone script; checkout call-graph analysis was unavailable. After index restoration, another inspection retained stale diagnostics from the deliberate unreadable-identity mutant (`false && !fields`). Direct on-disk reading confirmed the live `if (!fields)` guard, and the subsequent package/probe tsc gates and four-file Biome check passed. Inspection is not counted as a clean final typecheck. The working-diff comment review examined all five new/changed code files and flagged no unclear comments.

The [cost receipt](issue-673-structural-dispatch/cost.json) uses **1,000 messages / 5,299,891 bytes**, the actual registered hooks, preparation outside timing, ten warmups, twenty first-send samples and one hundred samples for each callback condition. First sends: **0.804 ms median / 1.589 ms p95**; ordinary complete comparisons: **0.812 / 2.961 ms**; independently parsed retained strings: **1.769 / 4.046 ms**. The single cold first dispatch was **1.897 ms**. Medians fit the requested 2–3 ms target; GC/load tails do not constitute a hard maximum. The unchanged nonempty superseded-nonce scan can serialize; the nonce-free no-serialization test remains green.

Run the selection with Linux/4 CPUs:

```sh
bun --version
bun scripts/check-bun.mjs
cd packages/pi-plugin
MC673_REVIEW_BENCH=1 BUN_JSC_useOMGJIT=0 bun test --parallel=4 --timeout 30000 \
  src/issue-641-*.test.ts src/issue-640-641-*.test.ts \
  src/issue-663-dispatch.test.ts src/issue-667-*.test.ts src/issue-668-*.test.ts \
  src/issue-673-*.test.ts src/issue-674-*.test.ts \
  src/pi-dispatch-identity.test.ts src/pi-dispatch-structure.test.ts
```

[Eleven restored mutation controls](issue-673-structural-dispatch/mutations.json) each produced exactly its named expected red and a named green control: cache normalization, Responses prompt, prepared-structure admission, canonical key order, newest-turn count, newest result ID, every-callback full-content comparison, unreadable first capture, role order, assistant call IDs and transported timestamps. Every break was staged-live-state/nonempty-mutant/empty-restoration, marked `NON-VACUITY BREAK`, restored from the index and touched. The original lifecycle/anchor/content/667/668 mutations remain archived in the prior reports; their code and negative tests were not weakened.

## Precise remaining limits

* **Same structure, different text before first capture:** if two completed passes return the same managed head, same role/count sequence and identical ordered tool IDs, stock wire carries no newest user timestamp/entry ID that distinguishes their text. An earlier managed body could still satisfy first-send structural identity if it arrives before the replacement's first capture. This could arise from editing/replacing a prompt or branch without changing its structure, from two passes changing only recalled memory/context text, or from normalized ID collisions. There is no claim that a generic prefix or structural equality cryptographically attests every first-send byte. After first capture, complete content equality rejects that text drift. Solving the remaining ambiguity without changing cached provider bytes needs a trustworthy host attempt identity or a provider-specific transform-aware projection.
* **Other legitimate structural rewrites are not guessed:** `@oh-my-pi/pi-coding-agent/src/session/messages.ts:1086–1123,1141–1165` can split image-bearing custom/file-mention turns or drop an empty interrupted assistant. `@oh-my-pi/pi-ai/src/providers/transform-messages.ts:1281–1299,1340–1354,1378–1429` can synthesize missing tool results, drop truncated thinking-only turns, or repair orphan results. Native server-side compaction replay, leading Responses system items, adjacent native assistant turns with no unambiguous Responses boundary, elevated mid-conversation Anthropic developer/system slots and provider-specific ID hashing are not fully projected by this helper. An unmatched/unknown shape refuses; it does not authorize raw history. The positive proof covers the named secret/image/snapcompact/steering/date transforms with paired tool history, not all provider repair/compatibility modes.
* An operator secret regex that removes the existing managed delimiter can still cause a legitimate refusal. No signature bypass was added for obfuscation or image markers.
* The existing verified side-session latch, advisor-envelope exemption, hybrid unknown-field witness and post-attribution native-branch-drift witness are unchanged and remain described in the independent review. These are not presented as fixed by structural identity.
* The original reporter's exact Linux timings, host patch version and provider retry type remain unavailable. The pinned 18.9.2 baseline proves a sufficient event order for the identical refusal, not that their 6,958/21,556 ms incidents necessarily used strict-tool fallback or hit the 25 s preparation deadline.
