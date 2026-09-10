# Auto-embed notice storm: one completion, fourteen delivery attempts

## Mechanism and evidence

The repetition was **the notification rollback queue replaying one completion**, not fourteen embedding drains. The affected session was `ses_22d43cb21ffeP7gd0iEX9qT7TM`, bound to OpenCode project `git:4b0ea68d7af9a6031a7ffda7ad66e0cb83315750`.

The task owner supplied read-only host evidence in `.cortexkit/alfonso/evidence/`: `session_projects.txt`, `registrations.txt`, `chunk_rows_session.txt`, `chunk_rows_window.txt`, and `mc_log_window.txt`. These private evidence files are not part of this commit. The investigation stayed inside the isolated worktree; it did not open or mutate the live database.

### A: why the same count repeated

At base `11abb86f`, `hook.ts:732–800` claims the process-local auto-embed latch before yielding, releases it only before a terminal drain, and sets `drainReachedTerminal = true` **before** sending the completion. The other deletion is `embed-session-state.ts:43`, reached by the hook's `onSessionDeleted` cleanup (base `hook.ts:1276`). No-identity, provider-off, zero-remaining, and pre-terminal exception paths release the temporary claim; successful/busy/stalled drains retain it. Multiple hook closures in one module instance share the exported Set.

The completion wording had two senders: the automatic hook and the explicit `/ctx-embed` terminal. Transform calls the automatic hook in both its Rust and TypeScript paths (`transform.ts:887,2652` at base). `executeEmbedHistory` with `silent: true` updates progress without command chat output. The project-wide passive drain and message indexing handlers do not independently send that completion string.

The supplied database rows settle the coverage hypothesis:

| Compartments | Primary rows | Primary creation time (UTC) | Shadow rows |
| --- | --- | --- | --- |
| 162963–162964 | 267439–267440 | 08:25:26 | 267441–267442, 08:25:26 |
| 162965–162966 | 267443–267444 | 08:25:27 | 267445–267446, 08:25:27 |
| 162967–162968 | 267447–267448 | 08:25:28 | 267449–267450, 08:25:28 |
| 162969 | 267451 | 08:25:29 | 267452, 08:25:30 |

All seven use `window_index=0`, primary dimensions 4096 and primary chunk model `embedding-provider:567a42801637f21615239a4aa26ec0b6:chunk:6c945d2b85b3c3c0`. Primary hash prefixes, in compartment order, are `eebac0cb20b9`, `b4f8a5594a62`, `161c129db108`, `f1e22a011f11`, `f3003753335c`, `e4d6c56fd78c`, `b33926a124bc`; each has a matching shadow hash in this batch. A separate compartment, 162970, was written at 08:25:22/23. Thus the snapshot contains 16 rows in the 08:25 batch (eight compartments across two models), **zero writes during the 08:27–08:32 storm**, then 12 rows for six new compartments at 08:40:17–22. The session snapshot reports 824 rows overall after that later batch. It is not a series of fourteen re-embeddings of seven keys.

Primary coverage and the writer agree at source: `getEmbeddingCoverageStatus` (`project-embedding-registry.ts:3086–3133`) and the session selector (`:2910–2917,2971–2979`) use `getProjectEmbeddingMaxInputTokens`; `embedCandidateChunkBatch` (`:2635–2670`) uses the same ceiling and canonical FTS/summary fallback. `classifyChunkCoverageDefect` (`compartment-chunk-embedding.ts:991–1023`) checks exact current window indices and hashes. No speculative coverage change is warranted. The real seven-compartment regression reaches 7/7 with this primary path. The supplied registration is an embedding-provider registration, not a plugin-process census; multiple processes need not be invented to explain the observed queue loop.

Representative log excerpt (session prefix and long URLs shortened):

```text
2026-09-10T08:25:30.246Z ignored notification held before target checks (session active); queued
2026-09-10T08:27:33.504Z notice rollback DELETE failed status=409 …/message/msg_08a6de50b…
                         failed to roll back a notice that landed while a run was active
2026-09-10T08:27:52.314Z notice rollback DELETE failed status=409 …/message/msg_08a6e2de3…
                         failed to roll back a notice that landed while a run was active
2026-09-10T08:28:12.395Z notice rollback DELETE failed status=409 …/message/msg_08a6e7d63…
```

The same pair occurs fourteen times: 08:27:33, 08:27:52, 08:28:12, 08:28:36, 08:28:52, 08:29:13, 08:29:28, 08:29:46, 08:30:18, 08:30:27, 08:30:43, 08:30:59, 08:31:44, 08:32:42. The brief called this twelve times but enumerated fourteen timestamps.

At base, `send-session-notification.ts:394–436` tries rollback after its post-append activity check. If deletion fails and the activity epoch has not advanced, it **still calls `queueIgnoredNotification`**, then `sendIgnoredMessageNow` returns `queued` (`:333`). `flushIgnoredMessages` (`:476–505`) retries the queue at the next idle boundary. `lastDeliveredText` is set only on the successful, non-rollback path (`:335`), so the repeated text never reaches the deduplication latch. The embedding latch is irrelevant once the notice is queued.

### B: why it parents another turn

The task owner supplied ALF's verified host-store observation: on **OpenCode 1.18.29**, each appended notice was the next assistant run's user-role `parentID`; every preceding assistant finished with `stop`, and the session was idle before the next append. Local `opencode --version` also prints `1.18.29`. This is not established as a 1.18.30 regression or merely an in-flight race.

The automatic call was centralized/guarded, not a raw SDK bypass. The sender sets `noReply: true` with an ignored text part, prefers `session.prompt`, and only falls back to `session.promptAsync` (`send-session-notification.ts:291–320` at base). Those flags do not remove the user row from host scheduling. Append → new run → post-append check sees active → DELETE refuses the active parent with 409 → requeue → next idle append explains both defects.

The installed upstream implementation was not supplied inside the permitted worktree, so the exact upstream scheduling function is not independently attributed. **OC-peer question:** “On OpenCode 1.18.29, ALF verified that an idle session receiving a `session.prompt` (or fallback `session.promptAsync`) request with `noReply: true` and only `ignored: true` text persists a user row that parents a fresh assistant run. Which idle scheduling path starts that run, and is there a supported notification API that never inserts a user-role message? We have removed automatic status posts regardless.”

## Fix and complete ignored-notice audit

Auto-embed completion is now silent on OpenCode and Pi. Embedding state and progress remain available through `/ctx-embed status`, sidebar/status RPC, and `/ctx-status`. The Pi callback parameter remains accepted for source compatibility but is never called by automatic embedding.

All nonterminal progress and passive warnings now use RPC toast notifications with **no fallback to chat**, even when no RPC client is connected. Existing bounded RPC backlog behavior applies; enqueue is not a claim that a Desktop user has already viewed the notification. Durable state/status remains authoritative. No passive site was judged to require a chat row.

Paths below are relative to `packages/plugin/src`; lines describe the updated source:

| Site | Treatment |
| --- | --- |
| `hooks/magic-context/hook.ts:778–779` auto-embed completion (base :790) | Deleted chat completion; silent state only. |
| `index.ts:193,227` config and missing-database startup banners | RPC only. |
| `plugin/conflict-warning-hook.ts:225,301,372,422` conflict, conflict-resolved, schema-fence, release announcement | RPC only; retain cleanup of legacy rows but remove the now-unnecessary delayed cleanup of new “enabled” posts. |
| `hooks/magic-context/hook.ts:490` and `transform.ts:183` dubious project identity | RPC only, including auto-embed's project registration warning. |
| `hooks/magic-context/transform.ts:850,1262,1593,2418` mode flip, no eligible head, historian restart, emergency abort instructions | RPC only. Mode transition still retries a failed RPC enqueue; abort instructions enqueue before self-abort. |
| `hooks/magic-context/transform-compartment-phase.ts:436` historian pressure “⏳” | RPC only, once per active historian run. |
| `hooks/magic-context/compartment-runner-incremental.ts:178` historian failure alerts | RPC only; retain transient/persistent framing and cooldown. |
| `hooks/magic-context/event-handler.ts:725` model-catalog warning | RPC only; stamp after enqueue. |
| `hooks/magic-context/child-session-spawn.ts:51–63` schema/title-safe child spawn fence failure | Remove duplicate ignored parent message; retain error toast, persisted sidebar error and refresh action. |
| `hooks/magic-context/upgrade-reminder.ts:226`, wired in `hook.ts:1562` | RPC/toast or existing TUI dialog; no chat. |
| `hooks/magic-context/compartment-runner-recomp.ts:212,398,429,453` and `compartment-runner-partial-recomp.ts:254,425,452,471` resume/pass/repair/budget progress | RPC only even though the original operation was user-invoked. |
| `hooks/magic-context/wrapup-orchestrator.ts:380` wrapup start/progress | RPC only; retain progress poll kick. |
| `hooks/magic-context/hook.ts:1411` explicit command response and `plugin/rpc-handlers.ts:1136,1167` user-requested recomp/upgrade terminal results | Retained: user-invoked terminal contract, including explicit `/ctx-embed`. No automatic producer uses this path. |
| `shared/safe-notification-target.ts` title-safety checks | Not a producer. Retained only for explicit chat replies still using the guarded sender. Passive status cannot suppress title generation because it appends no row. |

The source fence permits only **three command-result invocations in two production files**, with counts pinned per file; all other ignored-message call sites fail it. Direct `noReply: true` production writes remain centralized. Test-file wire assertions no longer occupy fragile line-number exceptions in the direct-write fence.

The remaining explicit sender now consumes any unsafe post-append attempt, regardless of successful deletion, 409/other deletion failure, or missing returned message ID. It never requeues an already attempted append. Holding before an append is still permitted. This intentionally changes the old “delete successfully then retry at idle” expectation: losing an explicit result is safer than repeatedly creating invisible user turns.

## Verification and test contract changes

- Seven-compartment idle fixture uses the real embedding provider adapter and SQLite coverage. The client stub persists actual user-role rows in an in-memory host table on either prompt API; the completed drain must leave the table empty and both prompt mocks untouched. Adding an eighth eligible compartment before a second transform proves the process latch prevents work, rather than passing just because coverage was already complete.
- The rollback regression drives a held notice through fourteen idle opportunities; every append starts a run, whose DELETE returns HTTP 409. Before the sender fix it appended fourteen user rows; after the fix it appends exactly one, attempts one DELETE, and leaves no queued retry.
- RPC migrations preserve warning content, cooldowns, mode-transition retry-on-enqueue-failure, abort ordering, and explicit command terminal tests. Tests now inspect RPC payloads and absence of prompt calls instead of expecting passive user rows.
- One recomp fixture previously counted its progress notification as a historian prompt. Removing that notification revealed that it actually failed before the first historian result, despite its “later pass” name. It is now parameterized for first-pass failure (old state preserved) and second-pass failure (existing partial-promotion behavior publishes validated structure with no legacy session facts). No recomp publication logic changed.
- Mutation controls restore the deleted OC/Pi auto notice, bypass the OC latch, introduce an unapproved ignored site, and restore rollback requeueing. Each named regression fails and the staged implementation is restored afterward; detailed evidence is included in the delivery result.

### Gate results

- `bun install --frozen-lockfile`: passed in this worktree; no dependency manifests or lockfiles intentionally changed. The first typecheck lacked installed Node types; installing dependencies resolved it.
- `bun run typecheck`: passed across plugin, Pi, CLI and retina-local-fs after final code edits.
- `cd packages/plugin && set -o pipefail; bun test --parallel --timeout 30000`: exit **1**, printed as `PLUGIN_TEST_EXIT=1`; **4618 passed, 1 failed** out of 4619 tests / 410 files. The sole failure was the untouched wall-clock benchmark `tail hygiene walk performance > stays below 30ms p95 on a 250k-token rendered tail` (66.952ms under parallel load versus a 30ms threshold). All changed behavior tests passed. Running `bun test src/hooks/magic-context/tail-hygiene-walk.test.ts` alone immediately afterward passed all **24** tests; the benchmark was not loosened.
- Plugin `bun run lint`: passed, 827 files, no diagnostics.
- Pi `bun run lint`: passed, 154 files; two pre-existing warnings in untouched `context-handler.ts:5912` and `subagent-runner.test.ts:2141`.
- Pi `bun test src/commands/ctx-embed.test.ts`: passed, 7 tests.
- AFT inspection completed but had unavailable/crashed language-server producers; the successful TypeScript compiler and package Biome gates are the authoritative checks.
- Comment-clarity review: no issues flagged. `git diff HEAD --check`: passed.

## Draft note for issue #415

We found and removed another source of the invisible-user-turn loop you reported: automatic history-embedding completion and other passive status notices could still be written as ignored user messages. On an idle OpenCode session, that row could parent a new run; our attempted rollback then received 409 because the row was the active run's parent, and retrying the notice repeated the cycle. Auto-embedding is now silent, passive progress/warnings use RPC/status surfaces rather than chat, and an attempted notice is never requeued after rollback fails. Explicit `/ctx-embed` results remain available when you request them. Regressions cover both zero automatic chat rows and the exact append → run → DELETE 409 cycle.
