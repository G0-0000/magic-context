---
title: Overview
description: A short map of Magic Context's session history, context reduction, memory, and background maintenance.
---

Magic Context gives your coding agent structured session history, deliberate context reduction, and durable cross-session memory. Start with [How Magic Context works](/concepts/how-it-works/) for the canonical top-to-bottom explanation and worked context-percentage examples.

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

The historian and reduction are complementary, not interchangeable:

1. **The historian preserves meaning.** It replaces older raw conversation with budgeted compartments. Those summaries remain in the prompt.
2. **Reduction reclaims working material.** It removes spent tagged content, especially bulky tool output, while protecting recent work.

The execute threshold tells Magic Context when to batch due work. It is not a target percentage. Read [How Magic Context works](/concepts/how-it-works/#treat-the-execute-threshold-as-a-trigger) before tuning it.

## Know what persists

The raw transcript remains in the local database even when the active prompt contains compartments or dropped placeholders. Project memory persists across sessions and harnesses. The active prompt is therefore a budgeted view of stored knowledge, not the only copy.

Magic Context also preserves provider prompt caching by keeping the early prompt byte-identical between rebuilds. Read [Cache architecture](/concepts/cache-architecture/) for the internal layout and cache terminology.

## Choose a session mode

Magic Context has [three effective modes](/concepts/session-modes/):

- **Primary sessions** use historian compartments, reduction, memory, and the full prompt surface.
- **Subagents** receive a lighter context-management pass suited to shorter tasks.
- **Compaction-off mode** keeps the knowledge layer while your harness, or no compactor, owns the context window.

## Continue by goal

- Explain a surprising context percentage: [How Magic Context works](/concepts/how-it-works/)
- Improve compartment summaries: [Historian](/concepts/historian/)
- Understand tagged drops and emergency behavior: [Context reduction](/concepts/context-reduction/)
- Keep facts across sessions: [Memory](/concepts/memory/)
- Render overflow memory as an image: [Memory mural](/concepts/mural/)
- Maintain stored knowledge on a schedule: [Dreamer](/concepts/dreamer/)
