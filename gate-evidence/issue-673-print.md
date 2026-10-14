# Issue 673: headless chat-completions follow-up

## Scope and environment

The task branch was fast-forwarded to the requested batch tip `cc897edc68803b2570a8a54198f2134293f20037` before editing. Its issue-667/668/673/674 lifecycle protections remain unchanged.

The Linux runner had no Docker executable, daemon, socket, Podman or nerdctl. The parent approved reproducing the Docker scenario directly in the isolated Linux job. **The Docker job itself was not run; GitHub CI remains the container gate.**

Reproduction command: `bash scripts/omp-issue-673-print.sh`, on `linux,8c,net`. Versions: Bun 1.4.2, Node v24.21.0, npm 11.19.0, OMP **18.10.4** (pinned, matching the reported CI release). The script builds the Pi dist, OMP argv renderer and CLI, installs copied production packages, runs `omp plugin install`, and executes `tests/docker/test-omp-e2e.sh` against the unchanged `aimock-pi.cjs` fixture. It relocates `/test/` and `/tmp/`, adds observational event/lsof tracing, and uses a private global npm prefix.

Before any host starts, HOME, all XDG config/data/cache/state/runtime dirs, TMPDIR and MAGIC_CONTEXT_STORAGE_DIR are private under `$TMPDIR/magic-context/issue-673/`. No live stores were accessed. Initial attempts exposed two reproduction-wrapper mistakes (recursive path replacement and a CLI wrapper confusing subagent executable resolution); both were corrected.

## Baseline failure and event order

With cc897edc fence behavior unchanged (only refusal logging added), the mock server was ready and the main turn reproduced the CI failure:

```text
OMP version: 18.10.4
PASS [aimock is ready]
OMP exit: 1
FAIL [OMP turn exits successfully]
[2026-10-14T12:23:36.631Z] transform completed in 53.1ms (3 messages, 1 targets, watermark: 0)
[2026-10-14T12:23:36.656Z] Pi publication numbers_only reason=lkg_entry_ids_unavailable; serving managed context
[2026-10-14T12:23:36.680Z] [magic-context][pi] CONTEXT REFUSED "Magic Context could not safely prepare this turn; send your message again. stage=provider dispatch elapsed=102ms recovery=no managed result; refused (provider request does not match this pass's managed dispatch (prepared turn structure))"
message_end: assistant aborted Interrupted by user []
```

Recorded main-run order (epoch milliseconds):

| Event | Time | Observation |
| --- | ---: | --- |
| agent_start | 1791980616547 | Main run starts |
| context | 1791980616577 | Native user prompt: `Say hello once and then stop.` |
| transform finish | 1791980616631 | Three managed messages |
| publication | 1791980616656 | Number-only managed publication, no native IDs in this headless session |
| before_provider_request | 1791980616675 | Chat body roles `[system, user, user, user]` |
| dispatch refusal | 1791980616680 | Prepared structure rejects the extra instruction row |
| agent_end | 1791980616690 | Native user plus empty aborted assistant |

The three wire user messages are managed m[0], m[1], and the tagged newest prompt (`§1§ Say hello once and then stop.`). The extra system message is added by the provider renderer. **Here, agent_end follows the refusal; it does not cause it.** There is no prior provider capture or retained-end receipt. This 102ms first-send failure does not implicate the 25s pass budget.

The new first-send unit test also failed before normalization: expected abort count 0, received 1; 0 pass, 1 fail, 17 filtered.

## OMP 18.10.4 source

Version-specific source citations:

- [packages/ai/src/providers/openai-completions.ts:2358-2379](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/ai/src/providers/openai-completions.ts#L2358-L2379): renders `context.systemPrompt` before `context.messages`, as system or developer messages; multiple instruction messages are supported.
- [openai-completions.ts:2317-2324](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/ai/src/providers/openai-completions.ts#L2317-L2324) and [2377-2403](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/ai/src/providers/openai-completions.ts#L2377-L2403): conversation transformation and ordered user/developer mapping.
- [openai-completions.ts:2131-2134](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/ai/src/providers/openai-completions.ts#L2131-L2134): request builder assigns converted messages to `params.messages`.
- [openai-completions.ts:881-912](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/ai/src/providers/openai-completions.ts#L881-L912): payload callback runs on built provider parameters before sending.
- [packages/coding-agent/src/modes/print-mode.ts:154-160](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/coding-agent/src/modes/print-mode.ts#L154-L160) and [232-242](https://github.com/can1357/oh-my-pi/blob/v18.10.4/packages/coding-agent/src/modes/print-mode.ts#L232-L242): print-mode JSON serialization. Exact ordering above comes from the host trace, not inference from this serializer.

## Fix and boundaries

Only the prepared-turn structural comparison skips a **leading chat system/developer instruction prefix**. These provider-rendered instructions are not context-pass turns. Every prepared turn, its role and ordered tool call/result IDs must still match. Embedded instructions and Responses prefixes gain no exception.

The payload is not modified. `piConversationFields` still captures the complete messages array, including instruction rows, for equality against the first admitted body on retries. Changed instruction text cannot borrow a retained receipt. Run-end attribution, completion, managed signature, native anchor, superseded nonce, capture classification, deadline and retry-equality guards are unchanged. Refusals now also log their diagnostic, making headless failures explainable.

## Real-host green run and isolation

Final isolated root: `/motor-home/tmp/magic-context/issue-673/print.P6I16A`.

```text
OMP version: 18.10.4
OMP exit: 0
PASS [OMP turn exits successfully]
OMP subagent exit: 0
PASS [OMP accepts the translated subagent argv]
PASS [OMP turn persisted under the omp harness]
PASS: 14
FAIL: 0
```

Both main and child assistant messages contained `hello`, stopReason `stop`, no error. Final main trace: start 1791982346539; context 1791982346800; transform completed 12:52:26.865Z; publication 12:52:26.899Z; provider hook 1791982347346; end 1791982347520. Wire roles remain `[system, user, user, user]`.

Actual host PIDs were 747 and 832. `lsof -p <host PID>` snapshots at startup and provider dispatch listed only throwaway paths for OMP databases/cache/logs and MC context.db/WAL/SHM. The script prints and verifies all matching state paths, and requires both host snapshots. A preceding green run also captured this exact main-host row:

```text
omp     775 motor-job  26ur     REG                9,5   1048576 3087066189 /motor-home/tmp/magic-context/issue-673/print.aEQdzE/home/.local/share/cortexkit/magic-context/context.db
```

## Verification and limitations

- Full Pi suite, Linux/4c, Bun 1.4.2: **2220 pass, 41 skip, 0 fail**, 163003 assertions; 2261 tests across 228 files, 319.50s. Frozen install checked 1013 installs/1254 packages, no changes.
- After all mutants were restored: **97 pass, 1 skip, 0 fail**, 381 assertions; 98 tests across 8 files covering structural and 663/667/668/673/674 guards.
- `bun run --cwd packages/pi-plugin typecheck`: TypeScript 5.9.3, exit 0 (retina build tsconfig and Pi noEmit).
- Pi lint: Biome 2.5.1, 331 files, exit 0; 67 existing warnings. Changed-file check: 4 files, no diagnostics. A new test-formatting error was corrected before passing runs.
- `bash -n scripts/omp-issue-673-print.sh`: GNU Bash 5.3.9, exit 0; final script also ran successfully.
- Inspection reported no authoritative diagnostics; call-graph categories were unavailable. Package typecheck is the authoritative gate.
- Comment review completed and two comments clarified.

No Docker image assembly/entrypoint gate was run. The follow-up targets the retry addendum's first-request regression; it does not re-investigate the original OMP 18.9.x 21.5s report. The batch's lifecycle fix remains covered by passing tests and the mutations below. No package manifest or lockfile changed.

## Mutation results

Each mutation was applied independently after staging the implementation and confirming empty unstaged `git diff --stat`. Each produced a non-empty stat; the named test alone failed and a separate control passed (2 tests per run, Bun 1.4.2, Linux/4c). Restoration used `git checkout -- <path> && touch <path>` and an empty unstaged stat. No mutant remains.

| Neutralized control | Sole red test | Passing control | Applied stat |
| --- | --- | --- | --- |
| Leading instruction normalization | `issue 673 print: first chat-completions dispatch admits the renderer instruction prefix without prior capture` | `issue 673 print: a chat instruction prefix cannot hide a missing prepared turn` | pi-dispatch-structure.ts: 2 +-, 1 insertion/1 deletion |
| Instruction prefix position | `dispatch structure: chat instruction messages are only an ordered leading prefix` | `dispatch structure: count and role order include the newest user turn` | pi-dispatch-structure.ts: 2 +-, 1 insertion/1 deletion |
| Prepared-turn count equality | `issue 673 print: a chat instruction prefix cannot hide a missing prepared turn` | First chat-completions dispatch test above | pi-dispatch-structure.ts: 2 +-, 1 insertion/1 deletion |
| Admitted-conversation retry equality | `issue 673 print: retained chat dispatch still binds the instruction prefix content` | First chat-completions dispatch test above | pi-context-refusal.ts: 2 +-, 1 insertion/1 deletion |
| Genuine owning-end invalidation (ended and ready states) | `issue 667: a run's own end still invalidates its receipt` | First chat-completions dispatch test above | pi-context-refusal.ts: 4 ++--, 2 insertions/2 deletions |
| Dispatched-pass earlier-end attribution | `issue 673: a dispatched current pass survives an earlier end before provider fallback` | First chat-completions dispatch test above | pi-context-refusal.ts: 2 +-, 1 insertion/1 deletion |
| Persisted goal-preface anchor boundary | `issue 674: a persisted goal preface anchors a later-persisted continuation` | First chat-completions dispatch test above | pi-context-refusal.ts: 2 +-, 1 insertion/1 deletion |
| Superseded fallback nonce classification | `issue 668: real conflict fallback and retries refuse without revoking the newer receipt` | First chat-completions dispatch test above | pi-context-refusal.ts: 2 +-, 1 insertion/1 deletion |
| First-send prepared-structure fence | `review regression: first-send tool IDs bind the newest tool result` | First chat-completions dispatch test above | pi-context-refusal.ts: 2 +-, 1 insertion/1 deletion |
| Unmanaged auto-learn capture classification | `issue 663: raw auto-learn capture cannot borrow a completed conversation receipt` | First chat-completions dispatch test above | pi-context-refusal.ts: 2 +-, 1 insertion/1 deletion |

The last capture mutation still refused via the prepared-structure guard; its red assertion specifically detected losing the dedicated raw-capture classification. Likewise the nonce mutation still refused the old body via signature validation; the test detected the wrong refusal attribution and stopped at that assertion before its later replacement-receipt checks. These are defense-in-depth witnesses, not claims that removing one classification would immediately send raw history.
