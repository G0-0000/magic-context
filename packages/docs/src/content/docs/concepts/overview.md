---
title: Overview
description: A short map of Magic Context's session history, context reduction, memory, and background maintenance.
---

Magic Context gives your coding agent structured session history, deliberate context reduction, and durable cross-session memory. This overview shows how those three systems fit together.

## See the pipeline at a glance

| Stage | What happens | Deep dive |
|---|---|---|
| **Tagging** | Trackable messages and tool outputs receive `§N§` identifiers. | [Context reduction](/concepts/context-reduction/) |
| **Reduction** | The agent queues spent content with `ctx_reduce`; eligible old tool output can also be reclaimed on passes already rebuilding the cache. | [Context reduction](/concepts/context-reduction/) |
| **Session history** | A separate historian model turns settled conversation into compartments that stay in the prompt and decay to shorter tiers over time. | [Historian](/concepts/historian/) |
| **Durable knowledge** | Durable facts become project memory that persists across sessions. | [Memory](/concepts/memory/) |
| **Recall** | Memory and compartment history inject automatically; `ctx_search` and `ctx_expand` retrieve deeper detail. | [Memory](/concepts/memory/) |
| **Off-hours maintenance** | A dreamer model consolidates and verifies stored knowledge on configured schedules. | [Dreamer](/concepts/dreamer/) |

## Keep the two jobs separate

The historian and context reduction both keep the active prompt manageable, but they act on different material and leave different results:

| Layer | What it takes in | What remains in the prompt |
|---|---|---|
| **Historian** | Settled user and agent conversation | Compartment summaries that remain in the prompt |
| **Reduction** | Spent tagged messages and tool outputs | Compact dropped or truncated placeholders |

The execute threshold tells Magic Context when to batch due work. It is not a target percentage. See [Where a pass lands](/concepts/context-reduction/#where-a-pass-lands) before tuning it.

## Know what persists

The raw transcript remains in the local database even when the active prompt contains compartments or dropped placeholders. Project memory persists across sessions and harnesses. The active prompt is therefore a budgeted view of stored knowledge, not the only copy.

Magic Context also preserves provider prompt caching by keeping the early prompt byte-identical between rebuilds. Read [Cache architecture](/concepts/cache-architecture/) for the internal layout and cache terminology.

## Choose a session mode

Magic Context has [three effective modes](/concepts/session-modes/):

- **Primary sessions** use historian compartments, reduction, memory, and the full prompt surface.
- **Subagents** receive a lighter context-management pass suited to shorter tasks.
- **Compaction-off mode** keeps the knowledge layer while your harness, or no compactor, owns the context window.

## Continue by goal

- Explain a surprising context percentage: [Context reduction](/concepts/context-reduction/#where-a-pass-lands)
- Improve compartment summaries: [Historian](/concepts/historian/)
- Understand tagged drops and emergency behavior: [Context reduction](/concepts/context-reduction/)
- Keep facts across sessions: [Memory](/concepts/memory/)
- Render overflow memory as an image: [Memory mural](/concepts/mural/)
- Maintain stored knowledge on a schedule: [Dreamer](/concepts/dreamer/)

:::note[DCP-style compactor versus Magic Context]
| | DCP-style compactor | Magic Context |
|---|---|---|
| **Mental model** | Compacts the active prompt toward a recurring working size | Preserves a cache-stable prefix, then batches structured history and reduction work |
| **Older conversation** | Replaced by a general compacted summary | Becomes typed compartments that remain in a budgeted history block and decay over time |
| **Tool output** | Often folded into the same compaction decision | Managed separately through `ctx_reduce`, age-based reclaim, and emergency recovery |
| **Graph shape** | Often hovers near a steady size | Grows between passes, then lands wherever retained history, memory, recent work, and tool output total |

Neither model is universally better; they optimize for different behavior. Inspect the composition shown by `/ctx-status` rather than focusing only on the total percentage: compartment history is retained knowledge, while unreduced tool output is reclaimable working material.
:::
