export const DREAMER_AGENT = "dreamer";
export const DREAMER_RETROSPECTIVE_AGENT = "dreamer-retrospective";
// Read-only code investigator for the refresh-primers task. Locked to
// navigation/read/search tools only — NO write/edit/bash/ctx_memory/ctx_note —
// because it runs an unsupervised, scheduled, weak-model agentic loop. A
// ctx_memory mutation here would bump the project memory epoch and bust m[0],
// violating the primers cache-neutral contract; write/bash could corrupt the
// user's source. Mirrors the dreamer-retrospective lockPermissions pattern.
export const DREAMER_PRIMER_INVESTIGATOR_AGENT = "dreamer-primer-investigator";

// Locked read-only code reader for the memory-maintenance tasks (map-memories,
// verify, verify-broad). Same source-safety + cache-neutrality lock as the
// primer investigator (NO write/edit/bash/ctx_memory), but deliberately WITHOUT
// ctx_search — these tasks check memories against the CURRENT local source, not
// cross-session recall. The host parses the agent's XML manifest and applies the
// DB writes itself, so the agent never needs a mutation tool.
export const DREAMER_MEMORY_MAPPER_AGENT = "dreamer-memory-mapper";

/** Read-only tool profile shared by the memory-maintenance reader agent.
 *  No ctx_search (local-source checks only), no write/bash/ctx_memory. */
export const DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "aft_outline",
    "aft_zoom",
    "aft_search",
] as const;

// Pure-transform classifier for the classify-memories task: prompt in → ONE XML
// manifest out, ZERO tools. classify scores metadata from the memory text alone
// (no code inspection), and the host applies the column writes — so the agent
// needs no tools at all. Locked so a user override can't grant any.
export const DREAMER_CLASSIFIER_AGENT = "dreamer-classifier";

// Docs proposal investigator: read-only source tools; the host validates its final text.
export const DREAMER_DOCS_AGENT = "dreamer-docs";

/** Read-only source investigation for docs proposals. */
export const DREAMER_DOCS_ALLOWED_TOOLS = [
    "read",
    "grep",
    "glob",
    "aft_outline",
    "aft_zoom",
    "aft_search",
] as const;

// Pure JSON reviewer for the review-user-memories task: reads the candidate
// observations the host renders and returns a JSON verdict the host applies. It
// calls NO tools (zero), so it gets the empty allow-list, locked.
export const DREAMER_REVIEWER_AGENT = "dreamer-reviewer";

/** Curate receives its category snapshot from the host and edits memories via
 *  ctx_memory. It does not read code; the verify task checks memory accuracy.
 *  Keep the `dreamer` id because memory-tool authorization matches that id. */
export const DREAMER_CURATE_ALLOWED_TOOLS = ["ctx_memory"] as const;

/**
 * True when a `ctx_memory` call runs inside a Dreamer (curate) child session.
 *
 * Memory writes made from this context are deliberately NOT recorded in the
 * strata status document: the Dreamer edits the memory pool in the background,
 * and the daily full rebuild re-renders the cache from the database, so a
 * ledger row would only register work the agent session never asked for. Every
 * other caller — user sessions and regular subagents (scout, coder, explorer)
 * — still records its write.
 *
 * The hosts surface the same fact through different signals, so a caller passes
 * the one it has: OpenCode carries the agent id on the tool context, while Pi's
 * lean Dreamer extension registers `ctx_memory` under a flag-derived
 * `allowDreamerActions`. Deliberately NOT keyed on `MAGIC_CONTEXT_PI_SUBAGENT`:
 * ordinary Pi subagents carry that marker too, and silencing their writes would
 * drop legitimate ledger rows.
 */
export function isDreamerCurateContext(signal: {
    /** OpenCode: the executing tool context's agent id. */
    agent?: string | null;
    /** Pi: `allowDreamerActions` from the lean Dreamer subagent extension. */
    dreamerActions?: boolean;
}): boolean {
    return signal.dreamerActions === true || signal.agent === DREAMER_AGENT;
}
