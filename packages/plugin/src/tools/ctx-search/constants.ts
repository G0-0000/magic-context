export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Search the archive — everything that ever happened in this project, not just what is on your desk.

Retrieval fuses meaning and exact words. Phrase \`query\` as a natural-language question with expected terms (paths, symbols, config keys, errors); keyword stacks find less. Chinese has no word segmenter: use 2-4 character terms ("备份 安装位"), never a whole-sentence Chinese question — it matches nothing in the lexical lane.
- "where is the opencode source code path?"
- "why did we choose SQLite over postgres?"
- "how does the dreamer lease work?"
- Not: "upload client retry backoff config"

Classic retrieval filters memories in <project-memory> and the live tail. Memory ids alone (\`#7234\`, \`12, 34\`) resolve directly.

Sources (omit for all):
- memory — rules, constraints, conventions; "what's our convention for X"
- message — the raw conversation behind compacted history; "did we discuss this"; hits carry ordinals for ctx_expand(start=N-10, end=N+5)
- git_commit — commit history; "when did this change" (pair with message for regression hunts)
- primer — reusable project Q&A the dreamer distils from recurring questions; "have we answered this before"
- note — parked follow-ups with their recorded text; "did we leave a follow-up"
Use from/to to restrict every source to an inclusive UTC date range.

When enabled on OpenCode/Pi, queries without sources and sources containing memory plus other sources may synthesize a memory-cache answer fused with the selected non-memory retrieval summaries (not subject to the already-visible memory filter; ctx_memory get reads #id originals). Mixed sources use classic retrieval with memory removed before synthesis. sources:["memory"] queries the memory bank directly; an absent answer is terminal. Sources without memory (including []), from/to, and id queries use classic retrieval. A \`limit\` still routes to the cache; it bounds only the classic materials and the classic fallback, not the synthesized answer. The Rust module's own ctx_search always uses classic retrieval.`;
export const DEFAULT_CTX_SEARCH_LIMIT = 10;
