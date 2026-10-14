# Issue 673 / 686: Responses history fence evidence

Baseline: `70137976c9cbc385de66945a03363ad7084bd4ed` (`train/check-0.49.2`).
Host: exact npm `@oh-my-pi/pi-coding-agent@18.10.4`, Bun 1.4.2, macOS,
loopback mock only, no real provider credentials. This change is for the
unreleased 0.49.2 candidate, not a separate 0.49.3 release.

## Confirmed cause and predicate

The reproduced loss is in Magic Context's normalization, not an OMP rule that
drops commentary. Baseline `pi-dispatch-structure.ts:273-278` combines adjacent
Responses assistant items by appending their calls to the previous row, while
discarding later `wireContent`. The prepared side kept every assistant message.
Consequently a histogram or text diff taken **after** that normalization shows
missing assistant rows/texts even though the raw `body.input` retains the texts.

Named equivalence: **Responses text-item equivalence**. For Responses-family
models and a Responses `input` array, group only consecutive assistant rows on
both sides. Keep the complete ordered text-item identities (text plus phase)
and ordered tool IDs. A user or tool-result row ends a group of consecutive
assistant rows. Actual text
omission, changed text/phase, and grouping across a boundary still refuse.

A matching incremental native payload may render the original text without
MC's leading `§N§ ` ordinal. Accept that representation only for text-only
assistant content, matching API/model/provider, `dt === true`, matching v1
signature item ID and phase, and **exact** text after removing just the leading
ordinal prefix. Non-incremental snapshots and arbitrary changed native text do
not earn this exception. There is no timing-based admission, no general
assistant-drop allowance, and no change to the run-end or receipt guards.

## OMP source check (18.10.4 npm source)

Paths below are relative to `@oh-my-pi/pi-ai/src/`:

- `providers/openai-shared.ts:2125-2129`: native replay unconditionally
  `messages.push(...items)`. There is no response-ID or shared-payload dedup.
- `providers/openai-shared.ts:2204-2211`, `utils.ts:653-663`: native payload
  requires matching API/model and payload-provider eligibility.
- `providers/openai-shared.ts:2236-2260`: replay selection; `dt` appends on
  every eligible assistant, whereas a non-`dt` snapshot replaces accumulated
  input. Native replay skips fallback block conversion.
- `providers/openai-shared.ts:2503-2531`: fallback emits every text block with
  `toWellFormed()` and the parsed phase. It does not drop commentary.
- `providers/transform-messages.ts:1145-1151`: foreign-model text retains text
  but loses signature metadata; same-model text retains its signature.
- `providers/transform-messages.ts:450-452,1352-1354`: reporter's `m3n`
  predicate is confirmed: length/error/aborted AND no text/toolCall in the
  original message at the corresponding pre-normalization index.
- `providers/transform-messages.ts:345-359,386-427`: the reporter's `n$i`
  scrub is **malformed**, not generally aborted, tool calls (blank IDs or
  invalid names). An assistant with no surviving content is removed.
  Error/aborted calls are instead retained at `1359-1369`.
- `providers/transform-messages.ts:1378-1457`: duplicate results are skipped;
  orphan results inside a pending tool window are skipped; otherwise their
  visible text becomes an exact stale-tool-result user note. Mispositioned
  results whose call survives elsewhere are not emitted at that position.
- `utils.ts:355-375,377-423`: native replay drops whitespace-only assistant
  messages and dangling reasoning, not nonblank commentary.

These other omission rules do not explain stop/text-bearing assistant rows and
are not newly generalized by this change. Existing Chat history equivalences
and the 667/668 run-ownership protections remain in place.

## Red/green real-host reproduction

Seed and reopen a persisted session with consecutive signed commentary, a
cached incremental Responses message, a completions-lane answer, a tool call
followed by its result,
and another completions-lane answer. All texts are mock fixture strings.

Baseline run `provider.gOE6in`, PID 20096, reproduced refusal despite retaining
the prepared assistant texts in raw input:

```text
FAIL openai-responses: prepared responses-history turn admitted
attempts=1 wires=0 refusals=1
row=3 expectedRows=10 actualRows=7 expectedRole=assistant actualRole=assistant
expectedCalls=0 actualCalls=1 expectedResults=0 actualResults=0 comparison=count
```

Trace order: agent_start → context → prepared → before_provider_request →
refusal entry → abort → agent_end. Multiple registered handlers log the same
lifecycle event, so repeated trace rows are not separate physical starts/ends.
The signed text, cached text and completions-lane text were present in raw
`input`. Only the cached text lacked the `§N§ ` prefix that Magic Context adds
at runtime to label a historical message. Its remaining text was identical;
this is why the native-cache equivalence removes only that exact prefix.

Fixed run `provider.QLUMZw`, PID 3735: attempts=1, wires=1, refusals=0;
all four assistant text items retained. Dropped-commentary control
`provider.fzBiGz`, PID 4712: attempts=1, wires=0, refusals=1;
expectedRows=7 actualRows=7 comparison=content. The complete ordered tool arc
still matched and all other text items remained unchanged. Removing just one
signed commentary item changed admission into a content refusal, isolating
text omission rather than call pairing or the managed receipt.

Every host launch isolated HOME, CFFIXED_USER_HOME, TMPDIR, all five XDG dirs,
PI_CODING_AGENT_DIR and MAGIC_CONTEXT_STORAGE_DIR before importing OMP. Root:
`<worktree>/node_modules/.issue-673-tmp/magic-context/issue-673/omp18104/provider.*`.
`lsof -p` at start/end checked every store/config descriptor against that run's
root. Baseline PID 20096: 25/27 descriptors, zero outside; fixed PID 3735:
25/28, zero outside; dropped-text PID 4712: 25/27, zero outside. These summaries
are retained here because raw throwaway stores/logs are not delivery artifacts.
Final rerun: managed Responses PID 65290 (`provider.qzmSMu`), 25/28 descriptors;
dropped-text PID 65510 (`provider.MtHYzV`), 25/27; mixed Cline PID 64971
(`provider.Y7qxD5`), 25/28. Every descriptor check again found zero outside.

## Verification and mutations

- 24/24 real-host managed/raw controls with persisted materialized m0/m1,
  across 11 inference APIs plus the exact free Cline model.
- Resumed/compacted mixed Cline session: three parsed successful mock replies,
  then one raw final turn refused (4 attempts, 3 wires, 1 refusal).
- Responses mixed-lane history: managed admits; raw and truly dropped signed
  commentary refuse before transport.
- Final restored Pi suite on Linux4c: 2330 pass, 41 skip, 0 fail, 163427
  assertions, 2371 tests across 238 files (Bun 1.4.2, 269.71 seconds). Includes
  all 18 Responses history tests and existing 667/668 ended-run tests.
- Final rebuilt host rerun again passed all 24 materialized managed/raw controls,
  the Cline mixed session, and all three Responses history controls. Build:
  22 browser modules and 1038 plugin modules bundled with Bun 1.4.2.
- TypeScript 5.9.3: package typecheck and harness-specific typecheck pass.
- Biome 2.5.1: the three changed package source/test files pass.
- Selective guard controls: removing text identity reddens dropped signed
  commentary; neutralizing native eligibility/identity reddens each of API,
  model, provider, dt, signature, text, and native phase independently while
  valid admission stays green; removing native completeness reddens truncated
  text; widened grouping reddens user and tool-result boundary controls;
  removing the receipt check reddens raw admission. Every mutation was restored
  from the staged live implementation with an empty working diff afterwards.

## Still unconfirmed / reporter diagnostics

The reporter's claim that nonblank commentary is absent from **raw** input is
unconfirmed. Their normalized-row counts match the reproduced comparator bug.
No live session was opened or copied. If the session still refuses, ask for
raw assistant message-item count **before** payloadStructure, normalized count,
adjacent assistant-run lengths, text-block counts, selected API/model/provider
match booleans, native `dt` append/replacement selection, and per-position
`exact / ordinal-only / other` text equivalence plus phase. Do not log message
text, item IDs, credentials or session paths. Non-`dt` replay that erases managed
history must remain refused rather than be excused by the row-count fix.
