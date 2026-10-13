# Pi completion-notice prefix flip

## Finding and fix

Magic Context caused an old user message to alternate between a tag plus a time-gap comment and that same text followed by a full completion reminder. It was **not a merge of two user messages**: `§29106§` names the completion notice itself, Pi entry `1537194d`, text-part identity `1537194d:p0`. AFT delivered the notice once; subsequent requests restored its original text and inconsistently replayed Magic Context's already-frozen removal of that text.

The defect was passing `newTargets` to `replayPiReminderStrips`. That map wraps message-editing functions with a guard against newly changing text before signed thinking: those signatures bind to the preceding prompt bytes. On a tool continuation with live Opus 5.5 signed thinking, the guard rejects the reminder replay's text replacement as well. A fresh user turn has no live current-turn thinking and does not apply that rejection. Therefore the persisted reminder-strip decision produced bare bytes on user turns, but failed to reproduce those bytes on signed tool turns.

The fix passes the original `targets` map to reminder replay. New heuristic cleanup still uses its protected targets; only reproducing the previously served text with the reminder omitted bypasses the restriction on new edits. No Pi or AFT code, live store, schema, or package manifest was changed.

Source references (this branch):

- `packages/plugin/src/hooks/magic-context/latest-assistant-turn.ts:73-122`: explicitly says never to use `protectNewTagMutations` for frozen replay; its `setContent` wrapper returns false for a prefix edit.
- `packages/pi-plugin/src/context-handler.ts:8650-8705`: builds the current-turn thinking protection and `newTargets` view.
- `packages/pi-plugin/src/context-handler.ts:9613-9625`: reminder replay now uses the original targets, after caveman replay/discovery.
- `packages/pi-plugin/src/reminder-strip-pi.ts:66-105`: recognizes the persisted `reminder-strip` decision and calls the target setter to reproduce the stripped projection.
- `packages/pi-plugin/src/heuristic-cleanup-pi.ts:558-617`: new partial reminder cleanup freezes its decision before changing the served body.

## Read-only evidence and offline reproduction

Session: `019e8905-3b53-7442-b79f-4ee106474820`, AGAUTH, Pi 1.1.0, Magic Context 0.49.0. The live JSONL was opened only for reading; the relevant entries and request bodies were copied into `$TMPDIR/magic-context/pi-notice-flip/`. Host probes tested the context handler offline using throwaway HOME, XDG directories, PI_CODING_AGENT_DIR, and MAGIC_CONTEXT_STORAGE_DIR so they could not write to live Pi or Magic Context state. Store snapshots were supplied separately in the ignored `.cortexkit/private/agauth-evidence/`; they are not committed.

JSONL entry sequence:

| Line | Entry | Meaning |
| --- | --- | --- |
| 46679 | `aa12c812` | Tool result starts `bash-735a32d6db23783c`. |
| 46709 | `5d06b072` | Earlier, separate wake-digest user notice. |
| 46710 | `7ebdc065` | Assistant before the completion notice. |
| 46711 | `1537194d` | User message containing the full completion reminder, 2026-10-12 16:01:37Z. |
| 46712 | `df83515a` | Assistant after that notice. |

The tag snapshot is active, `caveman_depth=0`; source_contents retains the original full reminder. The session's replay ledger contains `pi-content-replay-v1:["reminder-strip","1537194d:p0"]`, which records that the reminder must be omitted from this exact text part on future requests. The decision is therefore present, and a compression depth of zero means this tag is not compressed; neither a missing decision nor compression explains the alternation.

A throwaway probe runs the real registered Pi context handler on the copied messages from entries `7ebdc065`, `1537194d`, and `df83515a`, then adds a fresh user turn, signed tool continuation, another user turn, and another signed continuation. Passing the guarded `newTargets` map to reminder replay reproduces notice-text lengths **21 → 785 → 21 → 785**. Passing the original `targets` map instead yields **21 → 21 → 21 → 21**, with the entire selected message compared byte-for-byte. The committed regression uses a smaller completion-notice body with the same IDs/timestamps and array-shaped user text; it also verifies that signed thinking survives tool continuations and repeats replay after session-cache clearing.

Request bodies confirm the same boundary:

- `001 → 002` (16:35:05Z → 16:35:38Z): bare → full reminder.
- `007 → 008` (16:37:20Z → 16:37:37Z): full reminder → bare.
- `011 → 012`: bare → full reminder; `019 → 020`: full → bare; `021 → 022`: bare → full.

The first changed provider message is 401. Eight old notice messages change together at indices **401, 559, 629, 641, 695, 743, 767, 773**; the first one is not the only affected notice. Unchanged-turn pairs retain their existing message bytes after excluding moving `cache_control` markers. Ledger index 408 is an upstream-array coordinate, not provider index 401.

## Why `no_mc_pass_row` appears

Magic Context was running, not skipping these requests. The copied log shows full successful transforms at 16:35:37Z, 16:37:37Z, and 16:42:28Z, all `decision=defer`, pending operations and heuristics disabled. It explicitly detects `1537194d` content-hash changes (`pi-log-window.log:109,447,678`).

Decision publication is conditional on **Magic Context's own `result.bustedThisPass`**, not the provider cache meter or an arbitrary wire-byte difference (`packages/pi-plugin/src/context-handler.ts:5429-5468`). The flag records intentional cache-affecting work such as a history rebuild or cleanup permitted by the scheduler. This replay error occurs while the scheduler defers new cleanup and does not set that flag, so the existing decision-row fix does not record these passes. `no_mc_pass_row` means no matching attribution row, not no context-handler invocation.

The global context.db snapshot has exactly 2,000 decision rows, newest 2026-10-12 14:37:39Z. That count initially suggested a retention defect, but the writer already inserts before pruning and keeps the **newest** rows by `ts_ms DESC, rowid DESC` (`packages/plugin/src/features/magic-context/transform-decision-log.ts:509-556`). No retention-code change is justified. The added production-cap test seeds 2,000 Pi rows, invokes the real writer twice, and proves both new rows survive while the two oldest rows are evicted. Absence of other historical rows outside the investigated interval was not audited.

## The 16:42:30Z bust is separate

Provider request files `010-req.json` and `011-req.json` leave every existing message, including the completion notice tagged `§29106§`, unchanged after cache-marker normalization. However, the **system prompt changes**, beginning near its first line:

- Before: `You are Alfonso, the user's long-term engineering partner.`
- After: `You are AGAUTH, an Alfonso, the user's long-term engineering partner.`

Other system text changes too; the remaining top-level request fields are unchanged. Thus the approximately 463k-token rewrite is not explained by this notice flip, and calling it only a provider short read after a 4.5-minute gap would miss a real upstream system-prefix rewrite. The provider read of 34,394 tokens is consistent with retaining an earlier cache segment, but provider internals/TTL behavior were not inspected. The owners of Pi's system-prompt generation and its AFT integration should investigate why those two system bodies changed the agent identity and other instructions during this live session; AGAUTH is the agent's session name. This patch does not modify that owner's prompt generation.

## Verification and rollout

- Bun 1.4.2, TypeScript 5.9.3: Pi and plugin package typechecks pass.
- Linux, 4 vCPUs: Pi suite **2,127 pass, 36 skip, 0 fail** across 217 files; decision-log tests **14 pass**.
- Biome 2.5.1: targeted changed-source lint passes; Pi package build passes (1,026 modules in the main bundle).
- Mutation: replacing original replay targets with protected `newTargets` fails only `Pi fold content replay > replays a served completion notice before signed thinking across tool and user turns`; the other seven fold/replay tests pass. The copied-JSONL probe also fails: it alternates the notice's text length between 21 and 785 characters across user and signed tool turns. Both pass after restoration.
- The first full Linux suite run used an isolated HOME without Git's repository ownership exception and failed 146 tests. Supplying an in-job `safe.directory` environment entry fixes that environment problem; the full rerun is green. Frozen-lockfile install checks 1,013 installs without changes.

Build/reload the updated Pi extension to apply the fix; no live-session migration or manual DB edits are needed. If the latest request still contains the full reminder, restoring the persisted omission can incur a one-time change back to the tag-plus-gap text. Subsequent user/tool turns must no longer toggle between the two bodies.
