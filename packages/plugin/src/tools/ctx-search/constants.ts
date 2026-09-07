export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Your long-term recall for this project — search everything that ever happened here, not just what's currently visible.

Retrieval is HYBRID when embeddings are enabled: ~0.7 semantic (embedding cosine) + ~0.3 keyword (FTS5 BM25), fused with per-source boosts; with embeddings disabled it silently falls back to keyword-only matching — tell by results carrying no \`match=semantic\` labels, and then prefer literal-heavy queries. Phrase \`query\` as a natural-language QUESTION that still embeds the key literal terms (paths, symbols, commands, config keys) — pure keyword stacks starve the semantic leg (0.7 weight), while pure prose without literal terms may miss exact FTS matches. Good: "Where is the dream log file and which error counters indicate failures?" Bad: "dream log error counter".

Reach for it when something feels familiar but isn't in view: "did we solve this before?", "what did we decide about X?", "when did this break?", "where does Y live?". Results only contain things you CANNOT currently see — memories already shown in <project-memory> and the live conversation tail are filtered out. A query that is just one or more memory ids (e.g. \`#7234\` or \`12, 34\`) bypasses text search and resolves those ids directly.

Sources (omit for a broad search across all):
- memory: curated cross-session project knowledge — rules, constraints, conventions.
- message: the raw conversation behind your compacted history. Hits include message ordinals — expand the surrounding exchange with ctx_expand(start=N-10, end=N+5).
- git_commit: this repository's commit history.
- note: parked decisions, follow-ups, and dismissed notes with their recorded text.

Picking sources:
- "when did this change / was this working before" → ["git_commit", "message"]
- "did we discuss this earlier" → ["message"]
- "did we decide something about this / leave a follow-up" → ["note"]
- "what's our convention / rule for X" → ["memory"]`;
export const DEFAULT_CTX_SEARCH_LIMIT = 10;
