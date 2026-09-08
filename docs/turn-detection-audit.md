# Turn-state audit: OpenCode, Pi, Claude Code, and dashboard

## Definitions and detection sites

### OpenCode TypeScript

| Site | Definition |
| --- | --- |
| `packages/plugin/src/hooks/magic-context/read-session-db.ts` | A newer user row is **real** when it has no parts or at least one part that is not `synthetic`, `ignored`, or a marker part. The all-parts predicate deliberately permits a real prompt that also carries a synthetic `@mention` part. |
| `packages/plugin/src/hooks/magic-context/read-session-db.ts` | `assistantAwaitingTools` reports whether the latest assistant has `finish="tool-calls"` or a non-provider-executed tool part, unless a newer real user row exists. Channel 2 uses this only to avoid starting a terminal subagent turn. The stronger notice predicate also holds while generation is unfinished or a real prompt is unanswered. |
| `packages/plugin/src/hooks/magic-context/transform.ts` | Scheduler decisions are applied directly. TypeScript no longer delays execute passes until a tool-using turn ends. |
| `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` | The OpenCode adapter omits `mid_turn`; the current Rust request contract defaults an absent field to false. Request-ingress time and persisted `lastResponseTime` remain timing evidence, not turn-end proof. |
| `packages/plugin/src/hooks/magic-context/event-handler.ts` | `lastResponseTime` advances on every terminal assistant **step** update with usage and a finish/completion field. Both `tool-calls` and `stop` are delivery boundaries. It is step EOF, not turn EOF. |
| `packages/plugin/src/hooks/magic-context/tail-hygiene-walk.ts` | A **real user turn** excludes summary, todo-head, Channel-2, ALF/marker, and m0/m1 rows so synthetic traffic does not advance Channel-1 cadence. |

### Pi TypeScript

| Site | Definition |
| --- | --- |
| `packages/pi-plugin/src/context-handler.ts` | Pi applies the scheduler decision directly, including during long tool-using turns. Deferred publications still ride the first genuine bust opportunity rather than authorizing their own bust. |
| `packages/pi-plugin/src/tail-hygiene-walk-pi.ts` | A real turn is a rendered `role="user"` entry retained by the Pi synthetic classifier. `syntheticLeadingCount` excludes m0/m1; hidden custom Channel-2 entries are excluded. |
| `packages/pi-plugin/src/ctx-reduce-nudge-pi.ts` | Channel 2 uses a hidden custom message with `deliverAs:"nextTurn"`; it joins the next real user turn and must neither steer the active turn nor create an autonomous turn. |
| `packages/pi-plugin/src/index.ts` | Channel 2 is queued only at a clean final `stop` agent-end boundary, not error, abort, or retry events. |

### Rust module

The Rust implementation is tracked separately from the TypeScript and Pi adapters. Its current wire request still accepts the historical `mid_turn` field with a false default, and its scheduler still contains a tool-arc boundary hold. OpenCode no longer sends that field. Claude Code behavior depends on its external transport until the Rust follow-up removes the remaining machinery.

### Tauri dashboard

| Site | Definition |
| --- | --- |
| `packages/dashboard/src-tauri/src/db.rs` | OpenCode assistant requests use native `parentID` as the turn key. JSONL fallback recognizes OpenCode `tool-calls`, Pi `toolUse`, and Claude `tool_use` as continuation finishes. |
| `packages/dashboard/src-tauri/src/pi_sessions.rs` | Pi JSONL yields one cache event per assistant message with usage and preserves `stopReason`. Without a native parent key, `toolUse` means the next request is a continuation. |
| `packages/dashboard/src-tauri/src/external_cache_sessions.rs` | Claude Code rows are deduplicated by `message.id`, retaining the final content block and usage. This is request deduplication, not mutation scheduling. |
| `packages/dashboard/src/components/CacheDiagnostics/CacheDiagnostics.tsx` | The UI groups request bars by backend `turn_id`; it does not make scheduler decisions. |

## Shape matrix

| Shape | OpenCode / Pi mutation scheduling | Real-user cadence | Dashboard grouping |
| --- | --- | --- | --- |
| Plain user turn after a completed assistant | A scheduler execute pass may apply queued work. | +1 | One native turn. |
| Multi-step tool loop | Every scheduler execute pass is eligible; deferred publication state may ride that bust. | +0 during tool steps | One turn with multiple request bars. |
| Interrupted tool call followed by a real queued user | The next scheduler decision is applied without a turn-boundary delay. | +1 | OpenCode starts a new parent-owned turn. |
| Synthetic Channel-2 or notice row | Does not count as a real user turn. Notice delivery remains idle-gated; Channel-2 subagent delivery checks live activity. | +0 | Host-specific synthetic request grouping may still appear. |
| Claude Code continuation after pseudo-compaction | Controlled by the Rust module and external transport until the Rust follow-up. | Transport-dependent | Heuristic fallback groups after `tool_use`. |

## Why dashboard turns differ from mutation scheduling

The dashboard visualizes provider requests grouped into user turns. Mutation scheduling answers a different question: whether a pass already has a genuine cache-busting opportunity. A tool-using turn can therefore contain an eligible execute pass without becoming a new dashboard turn. The dashboard must not infer or veto transform mutation policy from `turn_id`.

OpenCode `parentID` remains authoritative for display grouping. JSONL harnesses retain normalized finish fallbacks because their scanners do not yet expose an equivalent native turn root.

## Intentional predicates retained after scheduler-hold removal

- **Channel-2 subagent delivery:** `assistantAwaitingTools` prevents a terminal subagent prompt from starting a new turn. This predicate does not alter the scheduler.
- **Ignored-notice holding:** notices remain queued while a session is not idle, generation is unfinished, or a real user prompt is unanswered. This is the #415 safety gate and is stronger than the Channel-2 predicate.
- **Real-user cadence:** OpenCode and Pi continue excluding synthetic traffic from Channel-1 turn counts.
- **Dashboard turns:** request grouping remains display-only.

## Keeper tests

| Contract | Keeper |
| --- | --- |
| OpenCode assistant tool-wait and real-vs-synthetic user classification | `packages/plugin/src/hooks/magic-context/read-session-db.test.ts` |
| Pi marathon-turn reclaim lands on its first scheduler bust while a publication rides that pass | `packages/pi-plugin/src/context-handler.test.ts` |
| OpenCode/Pi five-real-user-turn floor and zero-turn guard | `hook-handlers.test.ts`, `ctx-reduce-nudge.test.ts`, and `ctx-reduce-nudge-pi.test.ts` |
| Dashboard native OpenCode parent grouping, timestamp collision, and JSONL finish normalization | `packages/dashboard/src-tauri/src/db.rs::cache_turn_tests` |
| Claude Code message-id request dedup | `packages/dashboard/src-tauri/src/external_cache_sessions.rs::tests::parses_claude_code_usage_and_skips_sidechains` |
