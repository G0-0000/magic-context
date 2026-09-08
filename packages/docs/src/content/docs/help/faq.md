---
title: FAQ
description: Answers to common questions about Magic Context, privacy, data storage, and configuration.
---

## Does Magic Context send my code anywhere?

No. All durable state — messages, compartments, memories — is stored in a local SQLite database at `~/.local/share/cortexkit/magic-context/context.db`. Nothing is sent to any Magic Context server.

The background historian and dreamer agents run as subagents using **your configured model providers**. When they run, your session content is sent to those providers (the same way your primary coding session already sends to them). Magic Context does not introduce any new data recipients beyond the model providers you have already chosen.

Semantic embeddings use the `embedding.provider` setting. The default is `"local"` — the embedding model runs in-process using `Xenova/all-MiniLM-L6-v2`, which never sends data anywhere. If you configure an `openai-compatible` endpoint, embedding queries go to that endpoint only.

## What does it cost to run?

Magic Context is prompt-cache-aware. Ordinary turns replay the stable prefix byte for byte, while folds batch the history and reduction work that must rewrite it. This avoids paying for frequent small rewrites of overlapping prompt bytes.

The historian and dreamer agents make their own model calls using whichever models you configure. They have no per-token cost when idle — the historian only runs on a compression event, not every turn. For background work that bills per request rather than per token (e.g. a GitHub Copilot subscription), pointing these agents at such a model keeps their cost flat.

The historian processes a batch of messages once per compartment event, not on every turn. Your cost depends on the historian model, explicit fallbacks, and provider pricing. See [Cache architecture](/concepts/cache-architecture/) and [Historian](/concepts/historian/).

## Can I turn things off?

Yes. Memory, auto-search hints, temporal markers, dreamer schedules, embeddings, and context-window management have explicit controls. Use the [generated configuration reference](/reference/configuration/) for current keys and defaults.

To hide agent-driven reduction for a specific agent, deny or omit `ctx_reduce` in that agent's tool allow-list. The historian and deterministic cleanup can still run.

## Where is my data stored?

All Magic Context state lives in one place:

```text
~/.local/share/cortexkit/magic-context/context.db
```

On Windows, this resolves to the XDG-equivalent path. The database is shared by OpenCode, Pi, and OMP — memories and compartments are scoped by harness and project, not by which terminal you use.

The local embedding model cache (if using `embedding.provider: "local"`) is stored at:

```text
~/.local/share/cortexkit/magic-context/models/
```

This is about 90 MB and is downloaded on first use. It can be safely deleted — it will be re-downloaded the next time an embedding is needed.

## Can I edit or delete memories?

Yes.

- **Via the agent:** Ask the agent to call `ctx_memory` with `action="write"` (add) or `action="archive"` (retire). This works in any session.
- **Via the dashboard:** The [desktop app](https://github.com/cortexkit/magic-context/releases) has a memory browser that lets you search, filter, edit, and bulk-delete memories.

Memories are scoped to a project (identified by git root commit hash). Deleting a memory removes it from all future sessions on that project.

## Why did my context drop to 45% instead of staying near the threshold?

The execute threshold is a trigger, not a target. A pass replaces eligible settled conversation with budgeted compartment history, applies queued `ctx_reduce` drops, and can reclaim eligible old tool output. The result is the sum of what remains: history, memory text, an optional memory mural, protected recent work, and unreclaimed tool output.

A conversation-heavy session can therefore cross the default 65% trigger and land at 45%. Another session can land at 62% or 78%. Magic Context does not pad or remove useful context to hold the graph near the threshold. See the [worked example](/concepts/context-reduction/#where-a-pass-lands).

## Why does the number not go down after the historian ran?

Historian output is not discarded context. It becomes a compartment that remains in the session-history block, and the history block has its own budget. The total may barely move when recent protected work or tool output dominates, or when the new compartment itself needs much of the eligible history budget.

Old tool output also follows a separate path. The agent can queue it with `ctx_reduce`, and automatic age-based reclaim can remove eligible output during a pass already rebuilding the cache. Check `/ctx-status` to identify which region is large before changing settings. [Overview](/concepts/overview/#keep-the-two-jobs-separate) and [Context reduction](/concepts/context-reduction/#where-a-pass-lands) explain the split.

## Can I set a target size?

No. There is no post-pass target percentage or token-count knob.

You can change **when** work triggers with a per-model execute threshold, encourage more working-material cleanup through `ctx_reduce`, select a stronger historian model for clearer compartments, and set `cache_ttl` to match how long your provider route keeps its prompt cache. These levers affect timing, quality, and cache batching; none promises a landing size. See the [generated configuration reference](/reference/configuration/#context-management).

## My compartments read badly. What should I change?

Choose a better historian model. The historian uses `historian.opencode.model` or `historian.pi.model` separately from your main coding model, with only the fallback models you configure. A small model can miss decisions or produce confusing summaries even when the main model is strong.

You can also enable `historian.two_pass` to add a cleanup call for low-signal lines and duplicates. Start with [Historian → Choose the historian model](/concepts/historian/#choose-the-historian-model), then use the generated configuration reference for exact fields.

## What happens when context reaches the emergency bands?

The first force band is the greater of **85%** or the execute threshold plus 2 percentage points. It therefore ranges from 85% to 92% and forces an immediate materialization and drain. Normal protection still applies there.

At **95%**, the session blocks new messages and runs absolute emergency recovery. Normal protected-token and tool-recency reserves yield so the session can drain. Check the current state with `/ctx-status`; `/ctx-flush` explicitly applies queued work but also invalidates the current cached prefix.

## How does it work with subagents?

When your primary agent spawns a subagent, Magic Context gives the subagent lighter treatment: memories are still injected, but the subagent does not have the full `ctx_reduce` guidance and does not trigger historian runs. This is intentional — subagents are short-lived and do not accumulate the kind of history that benefits from compartmenting.

The historian and dreamer themselves run as subagents. They are configured separately and do not see the `ctx_reduce` tooling — they have their own focused prompts.

## Can I use Magic Context across multiple machines?

Not currently. The database is local to one machine. Memories, compartments, and session history do not sync between machines.

If you work across machines, you can manually copy `~/.local/share/cortexkit/magic-context/context.db` between them — they share the same schema and project identity (git root hash), so memories written on one machine will appear on the other after a copy. There is no automatic sync.

## Can I move a session from OpenCode to Pi or OMP?

Yes. `doctor migrate` converts an existing OpenCode session into a Pi-compatible session file, carrying messages, compartments, and session facts with it. Project memories are already shared (same database, no migration needed).

```bash
npx @cortexkit/magic-context@latest doctor migrate \
  --from opencode --to pi --session <session-id>
```

Use `--to omp` for OMP. Add `--dry-run` to preview without writing, or `--max-messages N` to migrate only the most recent N messages. See [Migrating between harnesses](/getting-started/migrating-between-harnesses/) for the full walkthrough. Reverse migration is not yet supported.

## The dashboard shows no models / I'm on OpenCode Desktop only

The dashboard's model pickers merge cached provider model lists refreshed in the background. Discovery is never exhaustive — you can always type a model id directly even when a discovered list is present. On OpenCode Desktop-only installs (no CLI alongside), the model list may be empty until you run a session once; type the model id (e.g. `claude-sonnet-4-6`) directly into the picker.

## Do memories from OpenCode appear in Pi?

Yes. Project memories are stored in the shared database scoped by project identity (git root commit hash), not by harness. A memory written in an OpenCode session appears in the next Pi session for the same project, and vice versa.

Per-session state (compartments, tags, session facts) is scoped to the originating harness and session.

## What is the database format?

SQLite. The schema is managed by Magic Context's migration system and is upgraded automatically when you update the plugin. You can open and inspect it with any SQLite tool, but do not write to it directly — the schema may change between versions.

The [desktop dashboard](https://github.com/cortexkit/magic-context/releases) provides a UI for viewing and editing the data that is safe to use.
