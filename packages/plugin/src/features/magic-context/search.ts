import { log } from "../../shared/logger";
import { matchedSearchSnippet } from "../../shared/search-text";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    type AutoSearchDiagnostics,
    autoSearchRelevance,
    recordAutoSearchLane,
    withMemoryHintContent,
} from "./auto-search-diagnostics";
import {
    loadCompartmentChunkEmbeddingsForSearch,
    peekCompartmentChunkSearchPool,
    type StoredCompartmentChunkEmbedding,
    warmCompartmentChunkSearchPool,
} from "./compartment-chunk-embedding";
import { type GitCommitSearchHit, searchGitCommitsSync } from "./git-commits";
import { containsProbeVerbatim, extractLiteralProbes } from "./literal-probes";
import {
    ensureMemoryEmbeddings,
    getMemoriesByProject,
    getMemoriesByProjects,
    getProjectEmbeddings,
    type Memory,
    ModuleMemoryAuthorityError,
    searchMemoriesFTS,
    searchMemoriesFTSUnion,
    updateMemoryRetrievalCount,
} from "./memory";
import { cosineSimilarity } from "./memory/cosine-similarity";
import { embedText, getProjectEmbeddingSnapshot, isEmbeddingEnabled } from "./memory/embedding";
import type { SynapseClientLike } from "./memory/embedding-synapse";
import { normalizeStoredProjectPath } from "./memory/project-identity";
import { relaxedFtsQuery, sanitizeFtsQuery } from "./memory/storage-memory-fts";
import {
    MESSAGE_FTS_SESSION_FILTER_SQL,
    withMessageFtsSessionFilter,
    withMessageFtsSessionSetFilter,
} from "./message-fts-session-filter";
import { getIndexedMessageCorpusSize } from "./message-index";
import { getMessageIndexEpoch, isMessageIndexSearchable } from "./message-index-async";
import { recordShadowMeasurement } from "./search-measurement";
import {
    candidateTexts,
    emptySearchLanes,
    fuseSearchLanes,
    isProseQuery,
    logRerankFallback,
    prepareReranker,
    remoteRerankSkipped,
    rerankSearchResults,
    type SearchLanes,
} from "./search-rerank";
import { getNotes, type Note } from "./storage-notes";
import { getActivePrimers, type Primer } from "./storage-primers";
import {
    searchWikiCorpus,
    type WikiCorpusHit,
    type WikiDiagnosticReason,
    wikiDiagnosticReason,
} from "./wiki-search";
import {
    resolveWikiSectionHits,
    type WikiSectionRecovery,
    type WikiSectionRequest,
} from "./wiki-section";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    sourceNameForMemory,
    type WorkspaceIdentitySet,
} from "./workspaces";

const DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
/**
 * Upper bound on the results one search returns. The limit comes from the
 * model, and each tier fetches three times it, so without a bound a call like
 * `limit: 1e6` could dump the whole archive into one tool result. Matches the
 * Rust module's ctx_search clamp.
 */
export const MAX_UNIFIED_SEARCH_LIMIT = 25;
const FTS_SEMANTIC_CANDIDATE_LIMIT = 50;
const SEMANTIC_WEIGHT = 0.7;
const FTS_WEIGHT = 0.3;
const SINGLE_SOURCE_PENALTY = 0.8;
const RESULT_PREVIEW_LIMIT = 220;
/** Source boost multipliers for unified ranking.
 *
 * Memories are curated, hand-written summaries — strongest signal.
 * Git commits are terse human-written descriptions — high signal.
 * Messages are raw history that survived compression — boosted above baseline
 * because by definition these are the specific details the historian didn't
 * preserve as memories or compartments. The 1.275 calibration improved
 * conversation recall while preserving fact/rule recall. */
const MEMORY_SOURCE_BOOST = 1.3;
const MESSAGE_SOURCE_BOOST = 1.275;
const GIT_COMMIT_SOURCE_BOOST = 1.2;
const PRIMER_SOURCE_BOOST = 1.25;

interface MessageSearchRow {
    messageOrdinal?: number | string;
    messageId?: string;
    role?: string;
    content?: string;
    sessionId?: string;
    messageTimeMs?: number | null;
    suppressedCount?: number;
    summaryOnly?: number;
    ftsRank?: number;
}

interface BatchedMessageSearchRow extends MessageSearchRow {
    queryIndex?: number;
    ftsRank?: number;
}

interface BatchedFtsCountRow {
    queryIndex?: number;
    count?: number;
}

const messageSearchStatements = new WeakMap<Database, PreparedStatement>();
const sessionFirstMessageSearchStatements = new WeakMap<Database, PreparedStatement>();
const messageSearchStatementsWithCutoff = new WeakMap<Database, PreparedStatement>();
const sessionFirstMessageSearchStatementsWithCutoff = new WeakMap<Database, PreparedStatement>();
const messageSearchStatementsWithDateRange = new WeakMap<
    Database,
    Map<"all" | "cutoff", PreparedStatement>
>();
const messageSearchDiagnosticStatements = new WeakMap<Database, PreparedStatement>();
const sessionFirstMessageSearchDiagnosticStatements = new WeakMap<Database, PreparedStatement>();
const messageSearchDiagnosticStatementsWithDateRange = new WeakMap<Database, PreparedStatement>();
const batchedMessageSearchStatements = new WeakMap<Database, Map<string, PreparedStatement>>();
const batchedFtsCountStatements = new WeakMap<Database, Map<string, PreparedStatement>>();
const projectWideBatchedMessageSearchStatements = new WeakMap<
    Database,
    Map<string, PreparedStatement>
>();
const projectWideBatchedFtsCountStatements = new WeakMap<
    Database,
    Map<string, PreparedStatement>
>();
const wholeTableMessageCountStatements = new WeakMap<Database, PreparedStatement>();
const strictEvidenceStatements = new WeakMap<Database, Map<string, PreparedStatement>>();

export type SearchSource = "memory" | "message" | "git_commit" | "primer" | "note" | "wiki";

export interface CapturedQueryEmbedding {
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
}

export interface UnifiedSearchDiagnostics {
    suppressedVisibleMemoryIds: number[];
    suppressedLiveMessageMatches: number;
    gitCommitUnavailable: "no_git_repository" | null;
    /** Fixed token when the enabled global wiki source could not answer this search. */
    wikiUnavailable: WikiDiagnosticReason | null;
    /** Native cursor indicates that additional wiki results may remain beyond the bounded page. */
    wikiPartial: boolean;
}

export function createUnifiedSearchDiagnostics(): UnifiedSearchDiagnostics {
    return {
        suppressedVisibleMemoryIds: [],
        suppressedLiveMessageMatches: 0,
        gitCommitUnavailable: null,
        wikiUnavailable: null,
        wikiPartial: false,
    };
}

export interface UnifiedSearchOptions {
    /** Privacy-safe automatic-hint aggregates, also published between search stages. */
    autoSearchDiagnostics?: AutoSearchDiagnostics;
    onAutoSearchDiagnostics?: () => void;
    limit?: number;
    /** For automatic hints, score the share of query terms present instead of their relative FTS rank. */
    autoHint?: boolean;
    excludeMessageId?: string;
    /** Explicit searches alone may rerank; automatic hints never enter this path. */
    rerank?: boolean;
    rerankConnectionFile?: string;
    /** Optional service for offline comparisons and protocol tests. Null explicitly represents an unavailable Synapse service. */
    rerankClient?: SynapseClientLike | null;
    rerankConfig?: import("../../config/schema/magic-context").RerankConfig;
    onRerankSkipped?: (line: string) => void;
    /** Optional offline measurement sink, populated without repeating the original retrieval passes. */
    captureRerankLanes?: (lanes: SearchLanes) => void;
    /** Earliest persisted source timestamp in epoch milliseconds (inclusive). */
    from?: number;
    /** Latest persisted source timestamp in epoch milliseconds (inclusive). */
    to?: number;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    /**
     * User-level global wiki corpus for the `wiki` source. The root is one
     * process-global directory shared by every project; a project identity
     * never reaches it. Omitted or disabled means the source is never loaded.
     */
    wiki?: import("../../config/schema/magic-context").WikiConfig;
    /** Raw tool query reserved for wiki's literal CR/LF validation; all other lanes use the trimmed query. */
    wikiQuery?: string;
    /** Search wiki only after every selected internal lane misses, including visibility-suppressed hits. */
    wikiFallback?: boolean;
    /** Default fusion pre-run only: memory closes the wiki gate but cannot consume result/material slots. */
    memoryGateOnly?: boolean;
    /** Deprecated: message search no longer reads raw messages on the hot path. */
    readMessages?: (sessionId: string) => unknown[];
    embedQuery?: (
        text: string,
        signal?: AbortSignal,
    ) => Promise<CapturedQueryEmbedding | Float32Array | null>;
    isEmbeddingRuntimeEnabled?: () => boolean;
    /** Only return message-history hits with ordinal ≤ this value (e.g. last compartment end). -1 or omit to search all. */
    maxMessageOrdinal?: number;
    /** Stable ids of the real user prompt and executing assistant call; wiki-gate exclusion only. */
    currentQueryMessageIds?: readonly string[];
    /** Include indexed git commits in the result set. Default false — the
     *  feature is gated behind experimental.git_commit_indexing config. */
    gitCommitsEnabled?: boolean;
    /** Restrict results to these sources. Omit or pass undefined to search all
     *  enabled sources. Empty array is treated as "no sources enabled" → [].
     *  Facts are NOT a source — they're already always rendered in the
     *  <session-history> block injected into message[0]. */
    sources?: SearchSource[];
    /** Hard-filter memories already rendered in <session-history>. The agent
     *  can see them in message[0] — surfacing them via ctx_search wastes
     *  tokens and crowds out high-signal raw-history hits. Pass null or omit
     *  to disable filtering (for callers outside the transform context that
     *  can't resolve the visible set). */
    visibleMemoryIds?: Set<number> | null;
    /** Optional mutable diagnostic sink for explicit tool calls. Search fills it
     *  from the same candidate sets used by visibility filters; background
     *  callers can omit it and retain the lean result-only path. */
    diagnostics?: UnifiedSearchDiagnostics;
    /** Whether the calling directory has git metadata. False lets the formatter
     *  distinguish an unavailable commit corpus from a genuine empty search. */
    gitRepositoryAvailable?: boolean;
    /** Abort signal — if provided, cancels in-flight embedding requests
     *  (and any downstream HTTP calls) when the caller gives up. Used by
     *  transform-hot-path callers like auto-search whose own 3s timeout
     *  needs to cancel the 30s embedding fetch. */
    signal?: AbortSignal;
    /** When true (default), increment retrieval_count on memory hits. Explicit
     *  `ctx_search` tool calls from the agent SHOULD count — the agent asked
     *  for the memory, saw it, and used it. Plugin-internal automatic surfacing
     *  (e.g. auto-search hints appended to every user prompt) should NOT count
     *  because the agent may never actually consume the hint, and even if they
     *  do, automatic surfacing doesn't indicate usefulness. Mis-counting drives
     *  spurious retrieval-count-based memory promotion decisions. */
    countRetrievals?: boolean;
    /** Automatic hints rank only stored vectors. Their backfill is a separate job. */
    backfillMemoryEmbeddings?: boolean;
    /** When true, run multi-probe message search: extract literal symbol/command/
     *  path probes from the query and query each one separately (RRF-fused) so a
     *  message containing the exact literal but not the query's other tokens is
     *  still recalled. Default false — only explicit `ctx_search` tool calls opt
     *  in; the auto-search hot path stays single-probe to protect its latency
     *  budget. NL queries with no extractable probes are unaffected either way. */
    explicitSearch?: boolean;
    /**
     * Optional reserved-candidate channel for explicit fusion callers only. When
     * set (and `explicitSearch` is true), unifiedSearch reports up to 5 raw
     * message-lane hits, up to 5 git-commit hits and up to 5 current-session
     * message hits — fetched before the global limit slice and rerank, so they
     * survive truncation. Never called for auto-search or plain explicit
     * search. The primary return value is unchanged.
     */
    collectReservedCandidates?: (candidates: ReservedSearchCandidates) => void;
    /** Disables production search metrics while running an offline shadow quality comparison. */
    measurementDisabled?: boolean;
    embeddingModelIdOverride?: string;
    chunkModelIdOverride?: string;
    /**
     * Run the message-history lane somewhere other than the calling thread,
     * typically a worker with its own read-only connection. It must answer with
     * {@link searchMessageHistory} on the same store, so results and ranking are
     * those of the in-process lane. Resolving null (no file-backed store, or the
     * worker failed) runs the lane in process instead.
     */
    searchMessageHistory?: (
        request: MessageHistorySearchRequest,
    ) => Promise<MessageHistorySearchOutcome | null>;
    /**
     * Search the history-chunk vectors only when this thread's decoded pool for
     * the session is already warm (see `peekCompartmentChunkSearchPool`). A cold
     * pool leaves those vectors out of this search and starts a background warm
     * on this thread. Automatic hints set it, so a turn never waits for a pool
     * build.
     */
    chunkPoolWarmOnly?: boolean;
    /** Optional sink for how long each lane took. Durations and states only. */
    stepTimings?: UnifiedSearchStepTimings;
}

/** Durations, in milliseconds, of the parts of one {@link unifiedSearch}. */
export interface UnifiedSearchStepTimings {
    /** The message-history full-text lane. */
    messageMs?: number;
    /** Waiting for the query embedding after the message lane finished. */
    vectorWaitMs?: number;
    /** The history-chunk vector lane, including any pool load. */
    chunkMs?: number;
    /**
     * warm: searched an already decoded pool; cold: the pool was not warm, so
     * the lane was skipped; loaded: the pool was loaded (and refreshed) for this
     * search; no-vector: there was no query vector; off: the lane did not run.
     */
    chunkPool?: "warm" | "cold" | "loaded" | "no-vector" | "off";
    /** Memory, git-commit, primer and note lanes, which run together. */
    otherLanesMs?: number;
}

/** Everything the message-history lane needs, in a form a worker can receive. */
export interface MessageHistorySearchRequest {
    sessionId: string;
    query: string;
    limit: number;
    captureLimit?: number;
    maxOrdinal?: number;
    probes: string[];
    relaxedRecall?: boolean;
    /** The caller wants diagnostics; this also selects the diagnostic statements. */
    collectDiagnostics: boolean;
    dateRange: { from: number; to: number } | null;
    /**
     * Project-wide explicit search: every session eligible for the search,
     * including `sessionId`. Present only for explicit `ctx_search`; auto-search
     * and other callers omit it and get the single-session lane. `maxOrdinal`
     * applies to `sessionId` only — every other session is searched without a
     * cutoff. Plain data (session-id strings) so a worker message can carry it.
     */
    projectSessionIds?: string[];
}

export interface MessageHistorySearchOutcome {
    results: MessageSearchResult[];
    laneResults?: MessageSearchResult[];
    suppressedLiveMessageMatches: number;
}

/** The message-history lane of {@link unifiedSearch}, callable from a worker. */
export function searchMessageHistory(
    db: Database,
    request: MessageHistorySearchRequest,
): MessageHistorySearchOutcome {
    // Project-wide lane: each candidate session is checked individually, so one
    // session rebuilding never takes down the other projects' history lanes. The
    // calling thread re-checks its own epochs after the await and drops whatever
    // invalidated itself.
    const projectSessionIds = request.projectSessionIds;
    const eligibleProjectSessions = projectSessionIds?.filter((sessionId) =>
        isMessageIndexSearchable(sessionId),
    );
    if (projectSessionIds && (eligibleProjectSessions?.length ?? 0) === 0)
        return { results: [], suppressedLiveMessageMatches: 0 };
    if (!projectSessionIds && !isMessageIndexSearchable(request.sessionId))
        return { results: [], suppressedLiveMessageMatches: 0 };
    const diagnostics = request.collectDiagnostics ? createUnifiedSearchDiagnostics() : undefined;
    const capture = request.captureLimit
        ? { limit: request.captureLimit, results: [] as MessageSearchResult[] }
        : undefined;
    const results = searchMessages({
        db,
        sessionId: request.sessionId,
        query: request.query,
        limit: request.limit,
        maxOrdinal: request.maxOrdinal,
        probes: request.probes,
        relaxedRecall: request.relaxedRecall,
        diagnostics,
        dateRange: request.dateRange,
        capture,
        projectSessionIds: eligibleProjectSessions ?? undefined,
    });
    return {
        results,
        laneResults: capture?.results,
        suppressedLiveMessageMatches: diagnostics?.suppressedLiveMessageMatches ?? 0,
    };
}

export interface MemorySearchResult {
    source: "memory";
    content: string;
    score: number;
    memoryId: number;
    category: string;
    matchType: "semantic" | "fts" | "hybrid";
    sourceName?: string;
}

export interface MessageSearchResult {
    source: "message";
    content: string;
    score: number;
    messageOrdinal: number;
    messageId: string;
    role: string;
    /** Session that owns the hit. Always the searched session on the
     *  single-session lane; the owning session on a project-wide search. */
    sessionId: string;
    /**
     * Persisted message time (epoch ms) read from the rowid sidecar. Null when
     * the sidecar has no time for the row — never fabricated.
     */
    messageTimeMs: number | null;
}

/**
 * Optional explicit-fusion-only return channel of {@link unifiedSearch} (see
 * `UnifiedSearchOptions.collectReservedCandidates`). Populated after the
 * per-source candidates are fetched but before the global limit slice and
 * reranking, so fusion callers keep hits the truncated primary result may have
 * dropped. Only collected for explicit searches; auto-search never enables it.
 */
export interface ReservedSearchCandidates {
    /** Up to 5 raw message-lane hits (pre-compartment-merge, epoch-checked). */
    messages: MessageSearchResult[];
    /** Up to 5 git-commit hits from the same search. */
    gitCommits: GitCommitSearchResult[];
    /** Up to 5 raw message-lane hits of the current session, as searched. */
    currentSessionMessages: MessageSearchResult[];
}

/** How many hits each reserved lane contributes at most. */
const RESERVED_CANDIDATE_LIMIT = 5;

export interface CompartmentSearchResult {
    source: "compartment";
    content: string;
    score: number;
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    matchType: "semantic" | "hybrid";
    snippet?: string;
}

export interface GitCommitSearchResult {
    source: "git_commit";
    content: string;
    score: number;
    sha: string;
    shortSha: string;
    author: string | null;
    committedAtMs: number;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface PrimerSearchResult {
    source: "primer";
    content: string;
    score: number;
    primerId: number;
    question: string;
    support: number;
    lastObservedAt: number | null;
    matchType: "semantic" | "fts" | "hybrid";
}

export interface NoteSearchResult {
    source: "note";
    content: string;
    score: number;
    noteId: number;
    status: Note["status"];
    createdAt: number;
    anchorOrdinal: number | null;
    sourceSessionId: string | null;
}

/**
 * A literal content match in the user's global wiki corpus. Paths are relative
 * to the configured user-level root; no session, ordinal or expand handle exists
 * for this source.
 */
export interface WikiSearchResult {
    source: "wiki";
    /** Short single-line preview for ordinary ctx_search output. */
    content: string;
    /** Native snippet on direct reads; section text on the internal-miss fallback path. */
    snippet: string;
    score: number;
    /** Path relative to the global wiki root. */
    path: string;
    /** 1-based line number of the match. */
    line: number;
    /** File mtime in epoch milliseconds, from the native match time. */
    modifiedAtMs: number;
    /** Enclosing Markdown heading, present only on the internal-miss fallback path. */
    heading?: string | null;
    /** 1-based inclusive section bounds, omitted when section reading falls back to the native snippet. */
    sectionStartLine?: number;
    sectionEndLine?: number;
    /** Exact native matched text, including its original casing. */
    matchText?: string;
}

export type UnifiedSearchResult = (
    | MemorySearchResult
    | MessageSearchResult
    | CompartmentSearchResult
    | GitCommitSearchResult
    | PrimerSearchResult
    | NoteSearchResult
    | WikiSearchResult
) & { relevanceScore?: number };

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_UNIFIED_SEARCH_LIMIT;
    }
    return Math.min(MAX_UNIFIED_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

interface InclusiveDateRange {
    from: number;
    to: number;
}

function normalizeDateRange(from?: number, to?: number): InclusiveDateRange | null {
    if (from === undefined && to === undefined) return null;
    return {
        from:
            typeof from === "number" && Number.isSafeInteger(from) ? from : Number.MIN_SAFE_INTEGER,
        to: typeof to === "number" && Number.isSafeInteger(to) ? to : Number.MAX_SAFE_INTEGER,
    };
}

function timestampIsInRange(timestamp: number, range: InclusiveDateRange | null): boolean {
    return range === null || (timestamp >= range.from && timestamp <= range.to);
}

// ID-shaped short-circuit: when the whole trimmed query is one memory id (with
// or without a leading `#`) or a comma/space-separated list of up to
// `ID_SHAPED_QUERY_MAX_TOKENS` such tokens, we treat it as a direct id lookup.
// Anything else — `"fix bug 1234"`, a quoted sentence containing a number — is
// left alone so the normal lexical+semantic lanes still run. Reused by
// ctx_search and any future consumer that needs to decide whether a query
// should bypass the normal search pipeline.
export const ID_SHAPED_QUERY_MAX_TOKENS = 5;
// Matches one ID token: an optional leading `#` followed by one or more digits.
// The `+` requires at least one digit, so a bare `#` does not match.
const ID_SHAPED_TOKEN = /^#?\d+$/;

export function parseIdShapedQuery(query: string): number[] | null {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return null;
    }
    const tokens = trimmed.split(/[\s,]+/).filter((token) => token.length > 0);
    if (tokens.length === 0 || tokens.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        return null;
    }
    const ids: number[] = [];
    for (const token of tokens) {
        if (!ID_SHAPED_TOKEN.test(token)) {
            return null;
        }
        const parsed = Number.parseInt(token.replace(/^#/, ""), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return null;
        }
        ids.push(parsed);
    }
    return ids;
}

function normalizeCosineScore(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }

    return Math.min(1, Math.max(0, score));
}

function previewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= RESULT_PREVIEW_LIMIT) {
        return normalized;
    }
    return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

interface SearchWorkspaceContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

function resolveSearchWorkspaceContext(
    db: Database,
    projectPath: string,
    identitySet?: WorkspaceIdentitySet,
): SearchWorkspaceContext {
    const resolved = identitySet ?? resolveWorkspaceIdentitySet(db, projectPath);
    const isWorkspaced = resolved.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(db, resolved.identities);
    const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : resolved.identities;
    const canonicalIdentityByStoredPath = isWorkspaced
        ? expanded.canonicalIdentityByStoredPath
        : new Map(resolved.identities.map((identity) => [identity, identity]));
    const ownIdentities = expandedIdentities.filter(
        (identity) => canonicalIdentityByStoredPath.get(identity) === projectPath,
    );
    return {
        identities: resolved.identities,
        expandedIdentities,
        ownIdentities,
        shareCategories: isWorkspaced ? resolveWorkspaceShareCategories(db, projectPath) : null,
        namesByIdentity: resolved.namesByIdentity,
        canonicalIdentityByStoredPath,
        isWorkspaced,
    };
}

function memoryWorkspaceIdentity(memory: Memory, workspace: SearchWorkspaceContext): string | null {
    return resolveStoredPathWorkspaceIdentity(
        memory.projectPath,
        workspace.identities,
        workspace.canonicalIdentityByStoredPath,
    );
}

function sourceNamesForSearchMemories(args: {
    memories: readonly Memory[];
    projectPath: string;
    workspace: SearchWorkspaceContext;
}): Map<number, string> | undefined {
    if (!args.workspace.isWorkspaced) return undefined;
    const sourceNames = new Map<number, string>();
    for (const memory of args.memories) {
        const source = sourceNameForMemory(
            memory.projectPath,
            args.projectPath,
            args.workspace.identities,
            args.workspace.namesByIdentity,
            args.workspace.canonicalIdentityByStoredPath,
        );
        if (source) sourceNames.set(memory.id, source);
    }
    return sourceNames.size > 0 ? sourceNames : undefined;
}

function getMessageSearchStatement(db: Database, sessionFirst: boolean): PreparedStatement {
    const statements = sessionFirst ? sessionFirstMessageSearchStatements : messageSearchStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_history_fts.message_ordinal AS messageOrdinal, message_history_fts.message_id AS messageId, message_history_fts.role AS role, message_history_fts.content AS content, map.message_time_ms AS messageTimeMs FROM message_history_fts LEFT JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id AND map.fts_rowid = message_history_fts.rowid WHERE ${sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_history_fts.message_ordinal AS INTEGER) ASC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

/**
 * Cutoff-aware variant: filters `message_ordinal <= cutoff` IN SQL, BEFORE the
 * LIMIT. The JS-side post-filter in runMessageFtsQuery applies the cutoff AFTER
 * fetching `LIMIT` rows, so when the top-ranked rows are all live-tail (above the
 * cutoff) they're fetched-then-discarded and older eligible hits below the limit
 * are never seen — explicit ctx_search could then return nothing. Pushing the
 * predicate into SQL makes LIMIT count only already-eligible rows.
 */
function getMessageSearchStatementWithCutoff(
    db: Database,
    sessionFirst: boolean,
): PreparedStatement {
    const statements = sessionFirst
        ? sessionFirstMessageSearchStatementsWithCutoff
        : messageSearchStatementsWithCutoff;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_history_fts.message_ordinal AS messageOrdinal, message_history_fts.message_id AS messageId, message_history_fts.role AS role, message_history_fts.content AS content, map.message_time_ms AS messageTimeMs FROM message_history_fts LEFT JOIN message_fts_rowid_map AS map ON map.session_id = message_history_fts.session_id AND map.fts_rowid = message_history_fts.rowid WHERE ${sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ? AND message_history_fts MATCH ? AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ? ORDER BY bm25(message_history_fts), CAST(message_history_fts.message_ordinal AS INTEGER) ASC LIMIT ?`,
        );
        statements.set(db, stmt);
    }
    return stmt;
}

/** Date predicates join through the rowid sidecar so NULL legacy times are excluded before LIMIT. */
function getMessageSearchStatementWithDateRange(
    db: Database,
    withCutoff: boolean,
): PreparedStatement {
    let statements = messageSearchStatementsWithDateRange.get(db);
    if (!statements) {
        statements = new Map();
        messageSearchStatementsWithDateRange.set(db, statements);
    }
    const key = withCutoff ? "cutoff" : "all";
    let statement = statements.get(key);
    if (!statement) {
        statement = db.prepare(
            `SELECT message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content,
                    map.message_time_ms AS messageTimeMs
               FROM message_history_fts
               JOIN message_fts_rowid_map AS map
                 ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid
              WHERE ${MESSAGE_FTS_SESSION_FILTER_SQL}message_history_fts.session_id = ?
                 AND message_history_fts MATCH ?
                 AND map.message_time_ms BETWEEN ? AND ?
                ${withCutoff ? "AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?" : ""}
              ORDER BY bm25(message_history_fts),
                       CAST(message_history_fts.message_ordinal AS INTEGER) ASC
              LIMIT ?`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Explicit tool searches need both eligible rows and the exact number of
 * matching live-tail rows. Materializing the FTS match set once keeps that
 * diagnostic from issuing a second search query, while the ordinary hot path
 * continues to use the narrower cutoff statement above. */
function getMessageSearchDiagnosticStatement(
    db: Database,
    sessionFirst: boolean,
): PreparedStatement {
    const statements = sessionFirst
        ? sessionFirstMessageSearchDiagnosticStatements
        : messageSearchDiagnosticStatements;
    let stmt = statements.get(db);
    if (!stmt) {
        stmt = db.prepare(`
            WITH matches AS MATERIALIZED (
                SELECT
                    message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content,
                    map.message_time_ms AS messageTimeMs,
                    CAST(message_history_fts.message_ordinal AS INTEGER) AS ordinalValue,
                    bm25(message_history_fts) AS ftsRank
                FROM message_history_fts
                LEFT JOIN message_fts_rowid_map AS map
                  ON map.session_id = message_history_fts.session_id
                 AND map.fts_rowid = message_history_fts.rowid
                WHERE ${sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ? AND message_history_fts MATCH ?
            ),
            eligible AS (
                SELECT * FROM matches
                WHERE ordinalValue <= ?
                ORDER BY ftsRank, ordinalValue ASC
                LIMIT ?
            ),
            summary AS (
                SELECT COUNT(*) AS suppressedCount
                FROM matches
                WHERE ordinalValue > ?
            )
            SELECT
                eligible.messageOrdinal,
                eligible.messageId,
                eligible.role,
                eligible.content,
                eligible.messageTimeMs,
                eligible.ftsRank,
                summary.suppressedCount,
                0 AS summaryOnly
            FROM eligible CROSS JOIN summary
            UNION ALL
            SELECT NULL, NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1
            FROM summary
            WHERE NOT EXISTS (SELECT 1 FROM eligible)
            ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC
        `);
        statements.set(db, stmt);
    }
    return stmt;
}

function getMessageSearchDiagnosticStatementWithDateRange(db: Database): PreparedStatement {
    let statement = messageSearchDiagnosticStatementsWithDateRange.get(db);
    if (!statement) {
        statement = db.prepare(`
            WITH matches AS MATERIALIZED (
                SELECT
                    message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content,
                    map.message_time_ms AS messageTimeMs,
                    CAST(message_history_fts.message_ordinal AS INTEGER) AS ordinalValue,
                    bm25(message_history_fts) AS ftsRank
                FROM message_history_fts
                JOIN message_fts_rowid_map AS map
                  ON map.session_id = message_history_fts.session_id
                 AND map.fts_rowid = message_history_fts.rowid
                WHERE ${MESSAGE_FTS_SESSION_FILTER_SQL}message_history_fts.session_id = ?
                   AND message_history_fts MATCH ?
                   AND map.message_time_ms BETWEEN ? AND ?
            ),
            eligible AS (
                SELECT * FROM matches
                WHERE ordinalValue <= ?
                ORDER BY ftsRank, ordinalValue ASC
                LIMIT ?
            ),
            summary AS (
                SELECT COUNT(*) AS suppressedCount
                FROM matches
                WHERE ordinalValue > ?
            )
            SELECT
                eligible.messageOrdinal,
                eligible.messageId,
                eligible.role,
                eligible.content,
                eligible.messageTimeMs,
                eligible.ftsRank,
                summary.suppressedCount,
                0 AS summaryOnly
            FROM eligible CROSS JOIN summary
            UNION ALL
            SELECT NULL, NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1
            FROM summary
            WHERE NOT EXISTS (SELECT 1 FROM eligible)
            ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC
        `);
        messageSearchDiagnosticStatementsWithDateRange.set(db, statement);
    }
    return statement;
}

function getBatchedFtsCountStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): PreparedStatement {
    let statements = batchedFtsCountStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedFtsCountStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${dateRange === null ? "all-dates" : "dated"}:${sessionFirst}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql =
            cutoff === null ? "" : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
        const joinSql =
            dateRange === null
                ? ""
                : ` JOIN message_fts_rowid_map AS map
                         ON map.session_id = message_history_fts.session_id
                        AND map.fts_rowid = message_history_fts.rowid`;
        const dateSql = dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
        statement = db.prepare(
            Array.from(
                { length: queryCount },
                (_, index) =>
                    `SELECT ${index} AS queryIndex, COUNT(*) AS count
                       FROM message_history_fts${joinSql}
                      WHERE ${sessionFirst || dateRange !== null ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ?
                         AND message_history_fts MATCH ?${dateSql}${cutoffSql}`,
            ).join("\nUNION ALL\n"),
        );
        statements.set(key, statement);
    }
    return statement;
}

/**
 * Restrict a sanitized message FTS query to the `content` column. The table
 * also indexes `role`, so a bare query for "user" or "assistant" (or any term
 * porter-stemming to them, such as "users") would otherwise match every message
 * of that role. Applied to the bound MATCH value so the SQL text is unchanged.
 */
function contentOnlyMessageQuery(ftsQuery: string): string {
    return ftsQuery.length === 0 ? "" : `content : (${ftsQuery})`;
}

/** Read all per-probe document frequencies in one SQLite statement. */
function countSessionFtsMatchesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): number[] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        if (sessionFirst || dateRange !== null) bindings.push(sessionId);
        bindings.push(sessionId, contentOnlyMessageQuery(query));
        if (dateRange !== null) bindings.push(dateRange.from, dateRange.to);
        if (cutoff !== null) bindings.push(cutoff);
    }
    try {
        const rows = getBatchedFtsCountStatement(
            db,
            ftsQueries.length,
            cutoff,
            dateRange,
            sessionFirst,
        ).all(...bindings) as BatchedFtsCountRow[];
        const counts = Array.from({ length: ftsQueries.length }, () => 0);
        for (const row of rows) {
            if (
                typeof row.queryIndex === "number" &&
                row.queryIndex >= 0 &&
                row.queryIndex < counts.length &&
                typeof row.count === "number"
            ) {
                counts[row.queryIndex] = row.count;
            }
        }
        return counts;
    } catch {
        // Malformed FTS syntax that survived sanitization is non-discriminative.
        return Array.from({ length: ftsQueries.length }, () => 0);
    }
}

function getMessageOrdinal(value: number | string | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

async function getSemanticScores(args: {
    db: Database;
    projectPath: string;
    memories: Memory[];
    /** Pre-computed query embedding. Pass `null` to skip semantic scoring
     *  (e.g. embedding disabled, query embed failed, runtime not ready).
     *  unifiedSearch is responsible for computing this once and passing the
     *  same vector to memory + git-commit searches so we never embed the
     *  same query twice in parallel. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
    backfillMemoryEmbeddings?: boolean;
}): Promise<Map<number, number>> {
    const semanticScores = new Map<number, number>();

    if (
        !args.queryEmbedding ||
        args.memories.length === 0 ||
        !args.queryModelId ||
        args.queryModelId === "off"
    ) {
        return semanticScores;
    }

    if (!args.workspace?.isWorkspaced) {
        const cachedEmbeddings = getProjectEmbeddings(args.db, args.projectPath, args.queryModelId);
        const embeddings =
            args.backfillMemoryEmbeddings === false
                ? cachedEmbeddings
                : await ensureMemoryEmbeddings({
                      db: args.db,
                      projectIdentity: args.projectPath,
                      memories: args.memories,
                      existingEmbeddings: cachedEmbeddings,
                  });

        for (const memory of args.memories) {
            const memoryEmbedding = embeddings.get(memory.id);
            if (!memoryEmbedding) {
                continue;
            }

            semanticScores.set(
                memory.id,
                normalizeCosineScore(
                    cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding),
                ),
            );
        }

        return semanticScores;
    }

    const workspace = args.workspace;
    const memoriesByIdentity = new Map<string, Memory[]>();
    for (const memory of args.memories) {
        const identity = memoryWorkspaceIdentity(memory, workspace);
        if (!identity) continue;
        const list = memoriesByIdentity.get(identity) ?? [];
        list.push(memory);
        memoriesByIdentity.set(identity, list);
    }

    const ownMemories = memoriesByIdentity.get(args.projectPath) ?? [];
    if (ownMemories.length > 0 && args.backfillMemoryEmbeddings !== false) {
        const ownEmbeddings = getProjectEmbeddings(args.db, args.projectPath, args.queryModelId);
        await ensureMemoryEmbeddings({
            db: args.db,
            projectIdentity: args.projectPath,
            memories: ownMemories,
            existingEmbeddings: ownEmbeddings,
        });
    }

    for (const identity of workspace.identities) {
        const memberMemories = memoriesByIdentity.get(identity) ?? [];
        if (memberMemories.length === 0) continue;
        const cachedEmbeddings = getProjectEmbeddings(args.db, identity, args.queryModelId);
        for (const memory of memberMemories) {
            const memoryEmbedding = cachedEmbeddings.get(memory.id);
            if (!memoryEmbedding || memoryEmbedding.modelId !== args.queryModelId) continue;
            semanticScores.set(
                memory.id,
                normalizeCosineScore(
                    cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding),
                ),
            );
        }
    }

    return semanticScores;
}

function getFtsMatches(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    workspace?: SearchWorkspaceContext;
    dateRange: InclusiveDateRange | null;
    allowRelaxedFallback?: boolean;
}): Memory[] {
    try {
        return args.workspace?.isWorkspaced
            ? searchMemoriesFTSUnion(
                  args.db,
                  args.workspace.expandedIdentities,
                  args.query,
                  args.limit,
                  args.workspace.ownIdentities,
                  args.workspace.shareCategories,
                  args.dateRange,
                  args.allowRelaxedFallback,
              )
            : searchMemoriesFTS(
                  args.db,
                  args.projectPath,
                  args.query,
                  args.limit,
                  args.dateRange,
                  args.allowRelaxedFallback,
              );
    } catch (error) {
        log(
            `[search] FTS query failed for "${args.query}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}

function getFtsScores(matches: Memory[]): Map<number, number> {
    return new Map(matches.map((memory, rank) => [memory.id, 1 / (rank + 1)]));
}

function selectSemanticCandidates(args: {
    db: Database;
    memories: Memory[];
    projectPath: string;
    ftsMatches: Memory[];
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
}): Memory[] {
    if (args.ftsMatches.length === 0) {
        return args.memories;
    }

    const candidateIds = new Set(args.ftsMatches.map((memory) => memory.id));
    if (args.queryModelId && args.queryModelId !== "off") {
        const embeddingProjects = args.workspace?.isWorkspaced
            ? args.workspace.identities
            : [args.projectPath];
        for (const projectPath of embeddingProjects) {
            // Load (not peek) the stored vectors: a cold or expired cache would
            // otherwise shrink the candidate set to the FTS hits alone and drop
            // every memory that only matches by meaning.
            const storedEmbeddings = getProjectEmbeddings(args.db, projectPath, args.queryModelId);
            for (const memoryId of storedEmbeddings.keys()) {
                candidateIds.add(memoryId);
            }
        }
    }

    return args.memories.filter((memory) => candidateIds.has(memory.id));
}

function mergeMemoryResults(args: {
    memories: Memory[];
    semanticScores: Map<number, number>;
    ftsScores: Map<number, number>;
    limit: number;
    visibleMemoryIds?: Set<number> | null;
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
    singleSourcePenalty?: number;
}): { results: MemorySearchResult[]; suppressedVisibleIds: number[] } {
    const memoryById = new Map(args.memories.map((memory) => [memory.id, memory]));
    const candidateIds = new Set<number>([...args.semanticScores.keys(), ...args.ftsScores.keys()]);
    const results: MemorySearchResult[] = [];
    const suppressedVisibleIds: number[] = [];

    for (const id of candidateIds) {
        const memory = memoryById.get(id);
        if (!memory) {
            continue;
        }

        const semanticScore = args.semanticScores.get(id);
        const ftsScore = args.ftsScores.get(id);
        let score = 0;
        let matchType: MemorySearchResult["matchType"] = "fts";

        if (semanticScore !== undefined && ftsScore !== undefined) {
            score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
            matchType = "hybrid";
        } else if (semanticScore !== undefined) {
            score = semanticScore * (args.singleSourcePenalty ?? SINGLE_SOURCE_PENALTY);
            matchType = "semantic";
        } else if (ftsScore !== undefined) {
            score = ftsScore * SINGLE_SOURCE_PENALTY;
            matchType = "fts";
        }

        if (score <= 0) {
            continue;
        }

        // Record candidates before dropping them so an empty result can explain
        // that search worked and the matching memories are already in context.
        if (args.visibleMemoryIds?.has(id)) {
            suppressedVisibleIds.push(id);
            continue;
        }

        results.push(
            withMemoryHintContent(
                {
                    source: "memory",
                    content: previewText(memory.content),
                    score,
                    memoryId: memory.id,
                    category: memory.category,
                    matchType,
                    sourceName: args.sourceNameByMemoryId?.get(memory.id),
                },
                memory.content,
            ),
        );
    }

    return {
        results: results
            .sort((left, right) => {
                if (right.score !== left.score) {
                    return right.score - left.score;
                }
                return left.memoryId - right.memoryId;
            })
            .slice(0, args.limit),
        suppressedVisibleIds: suppressedVisibleIds.sort((left, right) => left - right),
    };
}

async function searchMemories(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    memoryEnabled: boolean;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchGitCommitsAsync — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    workspace?: SearchWorkspaceContext;
    visibleMemoryIds?: Set<number> | null;
    dateRange: InclusiveDateRange | null;
    backfillMemoryEmbeddings?: boolean;
    lanes?: SearchLanes;
    captureLexicalEvidence?: boolean;
}): Promise<{
    results: MemorySearchResult[];
    suppressedVisibleIds: number[];
    hasLexicalEvidence: boolean;
}> {
    if (!args.memoryEnabled) {
        return { results: [], suppressedVisibleIds: [], hasLexicalEvidence: false };
    }

    const unfilteredMemories = args.workspace?.isWorkspaced
        ? getMemoriesByProjects(
              args.db,
              args.workspace.expandedIdentities,
              ["active", "permanent"],
              Date.now(),
              args.workspace.ownIdentities,
              args.workspace.shareCategories,
          )
        : getMemoriesByProject(args.db, args.projectPath);
    const memories = unfilteredMemories.filter((memory) =>
        timestampIsInRange(memory.createdAt, args.dateRange),
    );
    if (memories.length === 0) {
        return { results: [], suppressedVisibleIds: [], hasLexicalEvidence: false };
    }

    const ftsMatches = getFtsMatches({
        db: args.db,
        projectPath: args.projectPath,
        query: args.query,
        limit: FTS_SEMANTIC_CANDIDATE_LIMIT,
        workspace: args.workspace,
        dateRange: args.dateRange,
    });
    // The ordinary lane may use relaxed OR recall. Only a strict full-query
    // hit is evidence for the wiki gate, including hits already visible.
    const hasLexicalEvidence =
        args.captureLexicalEvidence === true &&
        getFtsMatches({
            db: args.db,
            projectPath: args.projectPath,
            query: args.query,
            limit: 1,
            workspace: args.workspace,
            dateRange: args.dateRange,
            allowRelaxedFallback: false,
        }).length > 0;
    const ftsScores = getFtsScores(ftsMatches);
    const semanticCandidates = selectSemanticCandidates({
        db: args.db,
        memories,
        projectPath: args.projectPath,
        ftsMatches,
        queryModelId: args.queryModelId,
        workspace: args.workspace,
    });
    const semanticScores = await getSemanticScores({
        db: args.db,
        projectPath: args.projectPath,
        memories: semanticCandidates,
        backfillMemoryEmbeddings: args.backfillMemoryEmbeddings,
        queryEmbedding: args.queryEmbedding,
        queryModelId: args.queryModelId,
        workspace: args.workspace,
    });

    const sourceNameByMemoryId = sourceNamesForSearchMemories({
        memories,
        projectPath: args.projectPath,
        workspace: args.workspace ?? {
            identities: [args.projectPath],
            expandedIdentities: [args.projectPath],
            namesByIdentity: new Map(),
            canonicalIdentityByStoredPath: new Map([[args.projectPath, args.projectPath]]),
            ownIdentities: [args.projectPath],
            shareCategories: null,
            isWorkspaced: false,
        },
    });
    if (args.lanes) {
        args.lanes.memory_fts = mergeMemoryResults({
            memories,
            semanticScores: new Map(),
            ftsScores,
            sourceNameByMemoryId,
            limit: 25,
            visibleMemoryIds: args.visibleMemoryIds,
        }).results;
        args.lanes.memory_vector = mergeMemoryResults({
            memories,
            semanticScores,
            ftsScores: new Map(),
            sourceNameByMemoryId,
            singleSourcePenalty: 1,
            limit: 25,
            visibleMemoryIds: args.visibleMemoryIds,
        }).results;
    }
    return {
        ...mergeMemoryResults({
            memories,
            semanticScores,
            ftsScores,
            limit: args.limit,
            visibleMemoryIds: args.visibleMemoryIds,
            sourceNameByMemoryId,
        }),
        hasLexicalEvidence,
    };
}

/** Linear decay message scoring.
 *
 * The old formula (1 / (rank+1)) collapsed quickly: rank-0 = 1.0, rank-1 = 0.5,
 * rank-2 = 0.33, rank-5 = 0.17. In practice only the #1 message hit could
 * compete with boosted memories, so all secondary message matches got buried.
 *
 * Linear decay (1 - rank/limit) keeps signal across the returned window:
 * rank-0 = 1.0, rank-1 = 0.9, rank-2 = 0.8, rank-9 = 0.1. Combined with the
 * bumped MESSAGE_SOURCE_BOOST this lets raw-history hits actually compete. */
function linearDecayScore(rank: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, 1 - rank / total);
}

interface NormalizedMessageRow {
    messageOrdinal: number;
    messageId: string;
    role: string;
    content: string;
    sessionId: string;
    messageTimeMs: number | null;
}

/** Convert one FTS row into the validated shape consumed by message ranking.
 *  The ordinal cutoff applies to the current session only — project-wide rows
 *  from other sessions are never cut by the caller's compartment boundary. */
function normalizeMessageSearchRow(
    row: MessageSearchRow,
    cutoff: number | null,
    currentSessionId: string,
): NormalizedMessageRow | null {
    const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
    if (
        messageOrdinal === null ||
        typeof row.messageId !== "string" ||
        typeof row.role !== "string" ||
        typeof row.content !== "string"
    ) {
        return null;
    }
    const sessionId = typeof row.sessionId === "string" ? row.sessionId : currentSessionId;
    const messageTimeMs =
        typeof row.messageTimeMs === "number" && Number.isFinite(row.messageTimeMs)
            ? row.messageTimeMs
            : null;
    // Defense-in-depth: every SQL path applies the cutoff before LIMIT.
    if (sessionId === currentSessionId && cutoff !== null && messageOrdinal > cutoff) return null;
    return {
        messageOrdinal,
        messageId: row.messageId,
        role: row.role,
        content: row.content,
        sessionId,
        messageTimeMs,
    };
}

/** Run one FTS query and return ordinal-cutoff-filtered, validated rows in
 * bm25 rank order. `ftsQuery` must already be sanitized. */
function runMessageFtsQuery(
    db: Database,
    sessionId: string,
    ftsQuery: string,
    fetchLimit: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): NormalizedMessageRow[] {
    if (ftsQuery.length === 0) return [];
    let rawRows: unknown[];
    const matchQuery = contentOnlyMessageQuery(ftsQuery);
    if (dateRange !== null) {
        const bindings: unknown[] = [
            sessionId,
            sessionId,
            matchQuery,
            dateRange.from,
            dateRange.to,
        ];
        if (cutoff !== null) bindings.push(cutoff);
        bindings.push(fetchLimit);
        rawRows = getMessageSearchStatementWithDateRange(db, cutoff !== null).all(...bindings);
    } else {
        const sessionBindings = sessionFirst ? [sessionId, sessionId] : [sessionId];
        rawRows =
            cutoff !== null
                ? getMessageSearchStatementWithCutoff(db, sessionFirst).all(
                      ...sessionBindings,
                      matchQuery,
                      cutoff,
                      fetchLimit,
                  )
                : getMessageSearchStatement(db, sessionFirst).all(
                      ...sessionBindings,
                      matchQuery,
                      fetchLimit,
                  );
    }
    const rows = rawRows.map((row) => row as MessageSearchRow);

    const result: NormalizedMessageRow[] = [];
    for (const row of rows) {
        const normalized = normalizeMessageSearchRow(row, cutoff, sessionId);
        if (normalized) result.push(normalized);
    }
    return result;
}

function runMessageFtsQueryWithDiagnostics(args: {
    db: Database;
    sessionId: string;
    ftsQuery: string;
    fetchLimit: number;
    cutoff: number;
    dateRange: InclusiveDateRange | null;
    sessionFirst: boolean;
}): { rows: NormalizedMessageRow[]; suppressedCount: number } {
    if (args.ftsQuery.length === 0) return { rows: [], suppressedCount: 0 };
    const matchQuery = contentOnlyMessageQuery(args.ftsQuery);
    const rawRows = (
        args.dateRange === null
            ? getMessageSearchDiagnosticStatement(args.db, args.sessionFirst).all(
                  ...(args.sessionFirst ? [args.sessionId, args.sessionId] : [args.sessionId]),
                  matchQuery,
                  args.cutoff,
                  args.fetchLimit,
                  args.cutoff,
              )
            : getMessageSearchDiagnosticStatementWithDateRange(args.db).all(
                  args.sessionId,
                  args.sessionId,
                  matchQuery,
                  args.dateRange.from,
                  args.dateRange.to,
                  args.cutoff,
                  args.fetchLimit,
                  args.cutoff,
              )
    ).map((row) => row as MessageSearchRow);
    const suppressedCount = rawRows[0]?.suppressedCount ?? 0;
    const rows: NormalizedMessageRow[] = [];
    for (const row of rawRows) {
        if (row.summaryOnly === 1) continue;
        const normalized = normalizeMessageSearchRow(row, args.cutoff, args.sessionId);
        if (normalized) rows.push(normalized);
    }
    return { rows, suppressedCount };
}

function getBatchedMessageSearchStatement(
    db: Database,
    queryCount: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): PreparedStatement {
    let statements = batchedMessageSearchStatements.get(db);
    if (!statements) {
        statements = new Map();
        batchedMessageSearchStatements.set(db, statements);
    }
    const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${dateRange === null ? "all-dates" : "dated"}:${sessionFirst}`;
    let statement = statements.get(key);
    if (!statement) {
        const cutoffSql =
            cutoff === null ? "" : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
        const dateSql = dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
        const branches = Array.from(
            { length: queryCount },
            (_, index) => `SELECT * FROM (
                SELECT ${index} AS queryIndex,
                       message_history_fts.message_ordinal AS messageOrdinal,
                       message_history_fts.message_id AS messageId,
                       message_history_fts.role AS role,
                       message_history_fts.content AS content,
                       map.message_time_ms AS messageTimeMs,
                       bm25(message_history_fts) AS ftsRank
                  FROM message_history_fts
                  LEFT JOIN message_fts_rowid_map AS map
                    ON map.session_id = message_history_fts.session_id
                   AND map.fts_rowid = message_history_fts.rowid
                 WHERE ${sessionFirst || dateRange !== null ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ?
                    AND message_history_fts MATCH ?${dateSql}${cutoffSql}
                 ORDER BY ftsRank
                 LIMIT ?
            )`,
        );
        statement = db.prepare(
            `${branches.join("\nUNION ALL\n")}\nORDER BY queryIndex ASC, ftsRank ASC`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Run all base/probe result queries as one compound SQLite statement. */
function runMessageFtsQueriesBatch(
    db: Database,
    sessionId: string,
    ftsQueries: readonly string[],
    fetchLimit: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionFirst: boolean,
): NormalizedMessageRow[][] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        if (sessionFirst || dateRange !== null) bindings.push(sessionId);
        bindings.push(sessionId, contentOnlyMessageQuery(query));
        if (dateRange !== null) bindings.push(dateRange.from, dateRange.to);
        if (cutoff !== null) bindings.push(cutoff);
        bindings.push(fetchLimit);
    }
    const rows = getBatchedMessageSearchStatement(
        db,
        ftsQueries.length,
        cutoff,
        dateRange,
        sessionFirst,
    ).all(...bindings) as BatchedMessageSearchRow[];
    const result = Array.from({ length: ftsQueries.length }, () => [] as NormalizedMessageRow[]);
    for (const row of rows) {
        if (
            typeof row.queryIndex !== "number" ||
            row.queryIndex < 0 ||
            row.queryIndex >= result.length
        ) {
            continue;
        }
        const normalized = normalizeMessageSearchRow(row, cutoff, sessionId);
        if (normalized) result[row.queryIndex].push(normalized);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Project-wide message FTS: ONE FTS MATCH over a SET of sessions (explicit
// ctx_search only). Extends the single-session sidecar pattern: the rowid
// prefilter screens the whole session set at once, the ordinary session
// predicate (`session_id IN (...)`) stays as the integrity guard, and any
// candidate with incomplete map coverage falls back to the global MATCH +
// session filter — all proven inside one read transaction by
// withMessageFtsSessionSetFilter, exactly like the single-session lane.

function sessionSetPlaceholders(sessionCount: number): string {
    return Array.from({ length: sessionCount }, () => "?").join(", ");
}

interface ProjectWideQueryShape {
    cutoff: number | null;
    dateRange: InclusiveDateRange | null;
    /** Every candidate fully mapped → screen rowids through the sidecar. */
    sessionSetFirst: boolean;
}

function projectWideWhereClause(sessionCount: number, shape: ProjectWideQueryShape): string {
    const predicates: string[] = [];
    if (shape.sessionSetFirst) {
        predicates.push(`+message_history_fts.rowid IN (
        SELECT fts_rowid FROM message_fts_rowid_map
         WHERE session_id IN (${sessionSetPlaceholders(sessionCount)})
    )`);
    }
    predicates.push(
        `message_history_fts.session_id IN (${sessionSetPlaceholders(sessionCount)})`,
        "message_history_fts MATCH ?",
    );
    if (shape.dateRange !== null) predicates.push("map.message_time_ms BETWEEN ? AND ?");
    if (shape.cutoff !== null) {
        // The compartment cutoff belongs to the current session only; every
        // other project session is searched without a cutoff.
        predicates.push(
            "(message_history_fts.session_id <> ? OR CAST(message_history_fts.message_ordinal AS INTEGER) <= ?)",
        );
    }
    return predicates.join("\n   AND ");
}

/** Bindings in exactly the order {@link projectWideWhereClause} consumes
 *  them — the session list appears twice when the rowid prefilter is on —
 *  followed by the caller's per-statement tail (e.g. LIMIT). */
function projectWideBindings(args: {
    sessionIds: readonly string[];
    currentSessionId: string;
    matchQuery: string;
    shape: ProjectWideQueryShape;
    tail: unknown[];
}): unknown[] {
    const { sessionIds, currentSessionId, matchQuery, shape } = args;
    const bindings: unknown[] = [];
    if (shape.sessionSetFirst) bindings.push(...sessionIds);
    bindings.push(...sessionIds, matchQuery);
    if (shape.dateRange !== null) bindings.push(shape.dateRange.from, shape.dateRange.to);
    if (shape.cutoff !== null) bindings.push(currentSessionId, shape.cutoff);
    bindings.push(...args.tail);
    return bindings;
}

const PROJECT_WIDE_MESSAGE_MAP_JOIN = `LEFT JOIN message_fts_rowid_map AS map
             ON map.session_id = message_history_fts.session_id
            AND map.fts_rowid = message_history_fts.rowid`;

function projectWideStatementKey(
    prefix: string,
    sessionCount: number,
    shape: ProjectWideQueryShape,
): string {
    return `${prefix}:${sessionCount}:${shape.cutoff === null ? "all" : "cutoff"}:${
        shape.dateRange === null ? "all-dates" : "dated"
    }:${shape.sessionSetFirst}`;
}

function getProjectWideBatchedMessageSearchStatement(
    db: Database,
    sessionCount: number,
    queryCount: number,
    shape: ProjectWideQueryShape,
): PreparedStatement {
    let statements = projectWideBatchedMessageSearchStatements.get(db);
    if (!statements) {
        statements = new Map();
        projectWideBatchedMessageSearchStatements.set(db, statements);
    }
    const key = projectWideStatementKey(`${queryCount}`, sessionCount, shape);
    let statement = statements.get(key);
    if (!statement) {
        const branches = Array.from(
            { length: queryCount },
            (_, index) => `SELECT * FROM (
                SELECT ${index} AS queryIndex,
                       message_history_fts.message_ordinal AS messageOrdinal,
                       message_history_fts.message_id AS messageId,
                       message_history_fts.role AS role,
                       message_history_fts.content AS content,
                       message_history_fts.session_id AS sessionId,
                       map.message_time_ms AS messageTimeMs,
                       bm25(message_history_fts) AS ftsRank
                  FROM message_history_fts
                  LEFT JOIN message_fts_rowid_map AS map
                    ON map.session_id = message_history_fts.session_id
                   AND map.fts_rowid = message_history_fts.rowid
                 WHERE ${projectWideWhereClause(sessionCount, shape)}
                 ORDER BY ftsRank
                 LIMIT ?
            )`,
        );
        statement = db.prepare(
            `${branches.join("\nUNION ALL\n")}\nORDER BY queryIndex ASC, ftsRank ASC`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Run all base/probe result queries of a project-wide search as one compound
 *  SQLite statement — the set analogue of {@link runMessageFtsQueriesBatch}. */
function runProjectWideMessageFtsQueriesBatch(
    db: Database,
    sessionIds: readonly string[],
    currentSessionId: string,
    ftsQueries: readonly string[],
    fetchLimit: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
    sessionSetFirst: boolean,
): NormalizedMessageRow[][] {
    if (ftsQueries.length === 0 || sessionIds.length === 0) return [];
    const shape: ProjectWideQueryShape = { cutoff, dateRange, sessionSetFirst };
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(
            ...projectWideBindings({
                sessionIds,
                currentSessionId,
                matchQuery: contentOnlyMessageQuery(query),
                shape,
                tail: [fetchLimit],
            }),
        );
    }
    const rows = getProjectWideBatchedMessageSearchStatement(
        db,
        sessionIds.length,
        ftsQueries.length,
        shape,
    ).all(...bindings) as BatchedMessageSearchRow[];
    const result = Array.from({ length: ftsQueries.length }, () => [] as NormalizedMessageRow[]);
    for (const row of rows) {
        if (
            typeof row.queryIndex !== "number" ||
            row.queryIndex < 0 ||
            row.queryIndex >= result.length
        ) {
            continue;
        }
        const normalized = normalizeMessageSearchRow(row, cutoff, currentSessionId);
        if (normalized) result[row.queryIndex].push(normalized);
    }
    return result;
}

function getProjectWideBatchedFtsCountStatement(
    db: Database,
    sessionCount: number,
    queryCount: number,
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
): PreparedStatement {
    let statements = projectWideBatchedFtsCountStatements.get(db);
    if (!statements) {
        statements = new Map();
        projectWideBatchedFtsCountStatements.set(db, statements);
    }
    const key = `${queryCount}:${sessionCount}:${cutoff === null ? "all" : "cutoff"}:${
        dateRange === null ? "all-dates" : "dated"
    }`;
    let statement = statements.get(key);
    if (!statement) {
        const shape: ProjectWideQueryShape = { cutoff, dateRange, sessionSetFirst: false };
        statement = db.prepare(
            Array.from(
                { length: queryCount },
                (_, index) => `SELECT ${index} AS queryIndex, COUNT(*) AS count
                   FROM message_history_fts
                   LEFT JOIN message_fts_rowid_map AS map
                     ON map.session_id = message_history_fts.session_id
                    AND map.fts_rowid = message_history_fts.rowid
                  WHERE ${projectWideWhereClause(sessionCount, shape)}`,
            ).join("\nUNION ALL\n"),
        );
        statements.set(key, statement);
    }
    return statement;
}

/** Set analogue of {@link countSessionFtsMatchesBatch}: per-probe document
 *  frequencies across the whole candidate set in one statement. */
function countProjectWideFtsMatchesBatch(
    db: Database,
    sessionIds: readonly string[],
    currentSessionId: string,
    ftsQueries: readonly string[],
    cutoff: number | null,
    dateRange: InclusiveDateRange | null,
): number[] {
    if (ftsQueries.length === 0) return [];
    const bindings: unknown[] = [];
    for (const query of ftsQueries) {
        bindings.push(
            ...projectWideBindings({
                sessionIds,
                currentSessionId,
                matchQuery: contentOnlyMessageQuery(query),
                shape: { cutoff, dateRange, sessionSetFirst: false },
                tail: [],
            }),
        );
    }
    try {
        const rows = getProjectWideBatchedFtsCountStatement(
            db,
            sessionIds.length,
            ftsQueries.length,
            cutoff,
            dateRange,
        ).all(...bindings) as BatchedFtsCountRow[];
        const counts = Array.from({ length: ftsQueries.length }, () => 0);
        for (const row of rows) {
            if (
                typeof row.queryIndex === "number" &&
                row.queryIndex >= 0 &&
                row.queryIndex < counts.length &&
                typeof row.count === "number"
            ) {
                counts[row.queryIndex] = row.count;
            }
        }
        return counts;
    } catch {
        // Malformed FTS syntax that survived sanitization is non-discriminative.
        return Array.from({ length: ftsQueries.length }, () => 0);
    }
}

/** Whole-table row count: the IDF-lite denominator for a project-wide probe.
 *  bm25 statistics are whole-table (they always were); mixing the current
 *  session's watermark here would skew cross-session probe weights, so the
 *  multi-session lane deliberately uses the full corpus. */
function getWholeTableMessageCorpusSize(db: Database): number {
    let statement = wholeTableMessageCountStatements.get(db);
    if (!statement) {
        statement = db.prepare("SELECT COUNT(*) AS count FROM message_history_fts");
        wholeTableMessageCountStatements.set(db, statement);
    }
    const row = statement.get() as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

/** Suppressed live-tail count for a project-wide diagnostic search: matching
 *  rows of the CURRENT session above its compartment cutoff. Other project
 *  sessions are never capped, so they never contribute to the suppression. */
function countProjectWideSuppressedLiveMessages(args: {
    db: Database;
    currentSessionId: string;
    ftsQuery: string;
    cutoff: number;
    dateRange: InclusiveDateRange | null;
}): number {
    if (args.ftsQuery.length === 0) return 0;
    const dateJoin = args.dateRange === null ? "" : PROJECT_WIDE_MESSAGE_MAP_JOIN;
    const datePredicate = args.dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
    const row = args.db
        .prepare(
            `SELECT COUNT(*) AS count
               FROM message_history_fts
               ${dateJoin}
              WHERE message_history_fts.session_id = ?
                AND message_history_fts MATCH ?
                AND CAST(message_history_fts.message_ordinal AS INTEGER) > ?${datePredicate}`,
        )
        .get(
            args.currentSessionId,
            contentOnlyMessageQuery(args.ftsQuery),
            args.cutoff,
            ...(args.dateRange === null ? [] : [args.dateRange.from, args.dateRange.to]),
        ) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

function countSessionSuppressedLiveMessages(args: {
    db: Database;
    sessionId: string;
    ftsQuery: string;
    cutoff: number;
    dateRange: InclusiveDateRange | null;
    sessionFirst: boolean;
}): number {
    if (args.ftsQuery.length === 0) return 0;
    const dateJoin =
        args.dateRange === null
            ? ""
            : `JOIN message_fts_rowid_map AS map
                 ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid`;
    const datePredicate = args.dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
    const row = args.db
        .prepare(
            `SELECT COUNT(*) AS count
               FROM message_history_fts
               ${dateJoin}
              WHERE ${args.sessionFirst ? MESSAGE_FTS_SESSION_FILTER_SQL : ""}message_history_fts.session_id = ?
                AND message_history_fts MATCH ?
                AND CAST(message_history_fts.message_ordinal AS INTEGER) > ?${datePredicate}`,
        )
        .get(
            ...(args.sessionFirst ? [args.sessionId, args.sessionId] : [args.sessionId]),
            contentOnlyMessageQuery(args.ftsQuery),
            args.cutoff,
            ...(args.dateRange === null ? [] : [args.dateRange.from, args.dateRange.to]),
        ) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

/**
 * Live-tail count for one already-sanitized query on the lane's shape — the
 * single session or the project-wide session set. Displayed diagnostics only.
 */
function countSuppressedLiveMatches(args: {
    db: Database;
    sessionId: string;
    projectSessionIds: readonly string[] | null;
    ftsQuery: string;
    cutoff: number;
    dateRange: InclusiveDateRange | null;
    /** Single-session shape only; the project-wide count ignores it. */
    sessionFirst?: boolean;
}): number {
    if (args.projectSessionIds !== null) {
        return countProjectWideSuppressedLiveMessages({
            db: args.db,
            currentSessionId: args.sessionId,
            ftsQuery: args.ftsQuery,
            cutoff: args.cutoff,
            dateRange: args.dateRange,
        });
    }
    return countSessionSuppressedLiveMessages({
        db: args.db,
        sessionId: args.sessionId,
        ftsQuery: args.ftsQuery,
        cutoff: args.cutoff,
        dateRange: args.dateRange,
        sessionFirst: args.sessionFirst === true,
    });
}

// ---------------------------------------------------------------------------
// Wiki fallback gate: does this project already answer one STRICT query with a
// raw lexical message? One bounded existence probe per query — never a count of
// returned results, because the ordinary lane's limit, its relaxed fill and the
// ownership filter on its rows must not decide the gate.

interface StrictEvidenceShape {
    sessionCount: number;
    sessionSetFirst: boolean;
    /** Candidate sessions whose binding moved; their pre-move rows never count. */
    migratedCount: number;
    currentQueryCount: number;
    dated: boolean;
}

function getStrictEvidenceStatement(db: Database, shape: StrictEvidenceShape): PreparedStatement {
    let statements = strictEvidenceStatements.get(db);
    if (!statements) {
        statements = new Map();
        strictEvidenceStatements.set(db, statements);
    }
    const key = `${shape.sessionCount}:${shape.sessionSetFirst}:${shape.migratedCount}:${
        shape.currentQueryCount
    }:${shape.dated}`;
    let statement = statements.get(key);
    if (!statement) {
        const placeholders = sessionSetPlaceholders(shape.sessionCount);
        const predicates: string[] = [];
        if (shape.sessionSetFirst) {
            predicates.push(`+message_history_fts.rowid IN (
        SELECT fts_rowid FROM message_fts_rowid_map
         WHERE session_id IN (${placeholders})
    )`);
        }
        predicates.push(
            `message_history_fts.session_id IN (${placeholders})`,
            "message_history_fts MATCH ?",
        );
        if (shape.currentQueryCount > 0) {
            // The current prompt is the one hit the caller already holds. Its ids
            // are excluded in every query shape, scoped to the current session:
            // the same id in another session is a different message.
            const ids = Array.from({ length: shape.currentQueryCount }, () => "?").join(", ");
            predicates.push(
                `(message_history_fts.session_id <> ? OR message_history_fts.message_id NOT IN (${ids}))`,
            );
        }
        // Session-moved-projects rule, matching the result-level ownership filter:
        // a row indexed before its session's binding change belongs to that
        // session's previous project. Rows without a known index time stay
        // attributed to the session's current project.
        if (shape.migratedCount > 0) {
            const arms = Array.from({ length: shape.migratedCount }, () => " WHEN ? THEN ?").join(
                "",
            );
            predicates.push(
                `(map.message_time_ms IS NULL OR map.message_time_ms >= CASE message_history_fts.session_id${arms} ELSE 0 END)`,
            );
        }
        if (shape.dated) predicates.push("map.message_time_ms BETWEEN ? AND ?");
        statement = db.prepare(
            `SELECT 1 AS hit FROM message_history_fts ${PROJECT_WIDE_MESSAGE_MAP_JOIN}
              WHERE ${predicates.join("\n   AND ")}
              LIMIT 1`,
        );
        statements.set(key, statement);
    }
    return statement;
}

/**
 * Strict message evidence for the wiki gate: one bounded `SELECT 1 … LIMIT 1`
 * per full sanitized query and per literal probe, returning at the first hit. A
 * raw lexical row is found directly — behind the lane's result limit, behind
 * pre-migration rows of another session, or above the compartment cutoff it
 * still counts, while the relaxed OR and semantic-only history never do.
 */
function hasStrictMessageEvidence(args: {
    db: Database;
    sessionIds: readonly string[];
    currentSessionId: string;
    mappingUpdatedAtMs: ReadonlyMap<string, number>;
    dateRange: InclusiveDateRange | null;
    currentQueryMessageIds: readonly string[];
    ftsQueries: readonly string[];
}): boolean {
    const ftsQueries = [...new Set(args.ftsQueries.filter((ftsQuery) => ftsQuery.length > 0))];
    if (ftsQueries.length === 0 || args.sessionIds.length === 0) return false;
    const migrated = [...args.sessionIds]
        .map((sessionId) => ({
            sessionId,
            movedAtMs: args.mappingUpdatedAtMs.get(sessionId) ?? 0,
        }))
        .filter((entry) => entry.movedAtMs > 0);
    return withMessageFtsSessionSetFilter(args.db, args.sessionIds, (sessionSetFirst) => {
        for (const ftsQuery of ftsQueries) {
            const shape: StrictEvidenceShape = {
                sessionCount: args.sessionIds.length,
                sessionSetFirst,
                migratedCount: migrated.length,
                currentQueryCount: args.currentQueryMessageIds.length,
                dated: args.dateRange !== null,
            };
            const bindings: unknown[] = [];
            if (sessionSetFirst) bindings.push(...args.sessionIds);
            bindings.push(...args.sessionIds, contentOnlyMessageQuery(ftsQuery));
            if (shape.currentQueryCount > 0) {
                bindings.push(args.currentSessionId, ...args.currentQueryMessageIds);
            }
            for (const entry of migrated) bindings.push(entry.sessionId, entry.movedAtMs);
            if (args.dateRange !== null) {
                bindings.push(args.dateRange.from, args.dateRange.to);
            }
            // An empty result is `null` on bun:sqlite and `undefined` on
            // node:sqlite — read the row's own column, never its absence.
            const row = getStrictEvidenceStatement(args.db, shape).get(...bindings) as
                | { hit?: number }
                | null
                | undefined;
            if (row?.hit === 1) return true;
        }
        return false;
    });
}

// Reciprocal-rank-fusion constant. 60 is the canonical RRF k; it dampens the
// reward gap between rank-0 and rank-1 so a candidate that appears in several
// probe lists outranks one that tops a single list.
const RRF_K = 60;
// Verbatim containment is worth one extra rank-0 list appearance — the same
// 1/RRF_K currency as the fused lists. The previous flat +0.5 bonus lived 30×
// above the RRF scale (max list contribution is 1/60 ≈ 0.017), so every
// verbatim hit saturated; after divide-by-max normalization all scores
// flattened into a ~0.95–1.0 band, and at the unified layer those ~1.0 scores
// × MESSAGE_SOURCE_BOOST crowded every memory hit out of the result set.
const VERBATIM_RANK_BONUS = 1 / RRF_K;
// Probe discrimination weighting: a probe matching a large share of the
// session's corpus (common acronyms, generic identifiers) carries near-zero
// signal — bm25 over a single common term is nearly flat, so its ranked list
// is noise. Weight each probe list (and its verbatim bonus) by a smooth
// document-frequency falloff: w = 1 / (1 + IDF_FALLOFF · df/N).
// df/N = 0.1% → 0.91, 1% → 0.50, 2% → 0.33, 10% → 0.09.
const IDF_FALLOFF = 100;

/** Smooth document-frequency weight for one probe within a session corpus. */
function probeDiscriminationWeight(df: number, corpusSize: number): number {
    if (corpusSize <= 0 || df <= 0) return 1;
    return 1 / (1 + (IDF_FALLOFF * df) / corpusSize);
}

/** Stable cross-session tie-break: persisted time first (unknown times last),
 *  then owning session, then ordinal. Ordinals are per-session sequence
 *  numbers, so they are never interpreted as a global timeline. */
function compareMessageIdentity(
    left: { messageTimeMs: number | null; sessionId: string; messageOrdinal: number },
    right: { messageTimeMs: number | null; sessionId: string; messageOrdinal: number },
): number {
    // Never subtract two absent times (Infinity - Infinity = NaN poisons the
    // comparator and leaves Array.sort order undefined).
    const leftTime = left.messageTimeMs ?? Number.POSITIVE_INFINITY;
    const rightTime = right.messageTimeMs ?? Number.POSITIVE_INFINITY;
    if (leftTime !== rightTime) return leftTime - rightTime;
    if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
    return left.messageOrdinal - right.messageOrdinal;
}

function searchMessages(args: {
    db: Database;
    sessionId: string;
    query: string;
    limit: number;
    /** Only return messages with ordinal ≤ this value. Omit or -1 to search all indexed messages. */
    maxOrdinal?: number;
    /** Literal probes to additionally query (multi-probe recall). Empty = the
     *  original single-query behavior (unchanged for NL queries / hot path). */
    probes?: string[];
    relaxedRecall?: boolean;
    diagnostics?: UnifiedSearchDiagnostics;
    dateRange: InclusiveDateRange | null;
    capture?: { limit: number; results: MessageSearchResult[] };
    /** Project-wide explicit search: the eligible session set (including
     *  `sessionId`). Omit for the single-session lane. Bounded to
     *  MAX_PROJECT_WIDE_SEARCH_SESSIONS so the bind-parameter count stays
     *  under SQLITE_MAX_VARIABLE_NUMBER no matter how many sessions a caller
     *  lists. */
    projectSessionIds?: string[];
}): MessageSearchResult[] {
    const cappedProjectSessionIds =
        args.projectSessionIds !== undefined && args.projectSessionIds.length > 0
            ? args.projectSessionIds.length > MAX_PROJECT_WIDE_SEARCH_SESSIONS
                ? args.projectSessionIds.slice(0, MAX_PROJECT_WIDE_SEARCH_SESSIONS)
                : args.projectSessionIds
            : undefined;
    if (cappedProjectSessionIds !== undefined) {
        return withMessageFtsSessionSetFilter(args.db, cappedProjectSessionIds, (sessionSetFirst) =>
            searchMessagesInSnapshot(
                { ...args, projectSessionIds: [...cappedProjectSessionIds] },
                sessionSetFirst,
            ),
        );
    }
    return withMessageFtsSessionFilter(args.db, args.sessionId, (sessionFirst) =>
        searchMessagesInSnapshot(args, sessionFirst),
    );
}

function searchMessagesInSnapshot(
    args: Parameters<typeof searchMessages>[0],
    sessionFirst: boolean,
): MessageSearchResult[] {
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    const baselineFetchLimit = cutoff !== null ? args.limit * 3 : args.limit;
    const captureFetchLimit = args.capture
        ? cutoff !== null
            ? args.capture.limit * 3
            : args.capture.limit
        : 0;
    const fetchLimit = Math.max(baselineFetchLimit, captureFetchLimit);

    const baseQuery = sanitizeFtsQuery(args.query.trim());
    const probes = args.probes ?? [];
    const projectSessionIds =
        args.projectSessionIds !== undefined && args.projectSessionIds.length > 0
            ? args.projectSessionIds
            : null;

    // One query runner pair for both lane shapes: the project-wide lane issues
    // exactly one MATCH per query over the whole session set (never one query
    // per session) through the same batched statement family the probe lane
    // uses; the single-session lane keeps its original statements.
    const runQuery = (ftsQuery: string, limit: number): NormalizedMessageRow[] =>
        ftsQuery.length === 0
            ? []
            : projectSessionIds !== null
              ? (runProjectWideMessageFtsQueriesBatch(
                    args.db,
                    projectSessionIds,
                    args.sessionId,
                    [ftsQuery],
                    limit,
                    cutoff,
                    args.dateRange,
                    sessionFirst,
                )[0] ?? [])
              : runMessageFtsQuery(
                    args.db,
                    args.sessionId,
                    ftsQuery,
                    limit,
                    cutoff,
                    args.dateRange,
                    sessionFirst,
                );
    const runQueryWithDiagnostics = (
        ftsQuery: string,
        limit: number,
        queryCutoff: number,
    ): { rows: NormalizedMessageRow[]; suppressedCount: number } => {
        if (projectSessionIds !== null) {
            if (ftsQuery.length === 0) return { rows: [], suppressedCount: 0 };
            const rows =
                runProjectWideMessageFtsQueriesBatch(
                    args.db,
                    projectSessionIds,
                    args.sessionId,
                    [ftsQuery],
                    limit,
                    queryCutoff,
                    args.dateRange,
                    sessionFirst,
                )[0] ?? [];
            return {
                rows,
                suppressedCount: countProjectWideSuppressedLiveMessages({
                    db: args.db,
                    currentSessionId: args.sessionId,
                    ftsQuery,
                    cutoff: queryCutoff,
                    dateRange: args.dateRange,
                }),
            };
        }
        return runMessageFtsQueryWithDiagnostics({
            db: args.db,
            sessionId: args.sessionId,
            ftsQuery,
            fetchLimit: limit,
            cutoff: queryCutoff,
            dateRange: args.dateRange,
            sessionFirst,
        });
    };

    // No probes → original single-query path, byte-identical scoring. This is
    // the hot path (auto-search) and every plain natural-language query.
    if (probes.length === 0) {
        const collectDiagnostics = args.diagnostics !== undefined && cutoff !== null;
        const outcome = collectDiagnostics
            ? runQueryWithDiagnostics(baseQuery, fetchLimit, cutoff)
            : { rows: runQuery(baseQuery, fetchLimit), suppressedCount: 0 };
        // Exact conjunctions remain the ranking authority; only empty searches
        // need a disjunction to recover a relevant term from a long question.
        const needsRelaxedRecall = outcome.rows.length === 0 && args.relaxedRecall === true;
        const relaxedQuery = needsRelaxedRecall ? relaxedFtsQuery(args.query) : "";
        const relaxedOutcome = needsRelaxedRecall
            ? collectDiagnostics
                ? runQueryWithDiagnostics(relaxedQuery, fetchLimit, cutoff)
                : { rows: runQuery(relaxedQuery, fetchLimit), suppressedCount: 0 }
            : null;
        if (args.diagnostics) {
            // The same live row can match both AND and OR; the gate needs presence,
            // not a double-counted total.
            args.diagnostics.suppressedLiveMessageMatches = Math.max(
                outcome.suppressedCount,
                relaxedOutcome?.suppressedCount ?? 0,
            );
        }
        const rows = relaxedOutcome?.rows ?? outcome.rows;
        const renderRows = (limit: number) => {
            const filtered = rows.slice(0, limit);
            return filtered.map(
                (row, rank): MessageSearchResult => ({
                    source: "message",
                    content:
                        matchedSearchSnippet(row.content, args.query) || previewText(row.content),
                    score: linearDecayScore(rank, filtered.length),
                    messageOrdinal: row.messageOrdinal,
                    messageId: row.messageId,
                    role: row.role,
                    sessionId: row.sessionId,
                    messageTimeMs: row.messageTimeMs,
                }),
            );
        };
        if (args.capture) args.capture.results = renderRows(args.capture.limit);
        return renderRows(args.limit);
    }

    // Multi-probe: run the full query plus every literal probe as separate FTS
    // rankings, but batch each phase into one compound SQLite statement. This
    // preserves independent bm25 ranks while avoiding statement amplification.
    const sanitizedProbes = probes
        .map((probe) => ({ probe, query: sanitizeFtsQuery(probe) }))
        .filter((entry) => entry.query.length > 0);
    // Probe discrimination weights must pair the df numerator with a matching
    // corpus: the single-session lane keeps its watermark approximation, while
    // the project-wide lane uses the whole-table N (bm25 always was
    // whole-table) so one session's size never skews another session's probes.
    const corpusSize =
        projectSessionIds !== null
            ? getWholeTableMessageCorpusSize(args.db)
            : getIndexedMessageCorpusSize(args.db, args.sessionId, cutoff);
    const probeCounts =
        projectSessionIds !== null
            ? countProjectWideFtsMatchesBatch(
                  args.db,
                  projectSessionIds,
                  args.sessionId,
                  sanitizedProbes.map((entry) => entry.query),
                  cutoff,
                  args.dateRange,
              )
            : countSessionFtsMatchesBatch(
                  args.db,
                  args.sessionId,
                  sanitizedProbes.map((entry) => entry.query),
                  cutoff,
                  args.dateRange,
                  sessionFirst,
              );
    const collectBaseDiagnostics = args.diagnostics !== undefined && cutoff !== null;
    const baseOutcome =
        collectBaseDiagnostics && baseQuery.length > 0
            ? runQueryWithDiagnostics(baseQuery, fetchLimit, cutoff)
            : null;
    // The probe lane never relaxes, so its live-tail count is the strict one: the
    // full AND query plus every literal probe. Probes overlap by design, so
    // presence is a max, never a duplicate sum.
    if (args.diagnostics && cutoff !== null) {
        let suppressedLiveMessageMatches = baseOutcome?.suppressedCount ?? 0;
        for (const entry of sanitizedProbes) {
            suppressedLiveMessageMatches = Math.max(
                suppressedLiveMessageMatches,
                countSuppressedLiveMatches({
                    db: args.db,
                    sessionId: args.sessionId,
                    projectSessionIds,
                    ftsQuery: entry.query,
                    cutoff,
                    dateRange: args.dateRange,
                    sessionFirst,
                }),
            );
        }
        args.diagnostics.suppressedLiveMessageMatches = suppressedLiveMessageMatches;
    }
    const searchQueries = [
        ...(!collectBaseDiagnostics && baseQuery.length > 0 ? [baseQuery] : []),
        ...sanitizedProbes.map((entry) => entry.query),
    ];
    const rowsByQuery =
        projectSessionIds !== null
            ? runProjectWideMessageFtsQueriesBatch(
                  args.db,
                  projectSessionIds,
                  args.sessionId,
                  searchQueries,
                  fetchLimit,
                  cutoff,
                  args.dateRange,
                  sessionFirst,
              )
            : runMessageFtsQueriesBatch(
                  args.db,
                  args.sessionId,
                  searchQueries,
                  fetchLimit,
                  cutoff,
                  args.dateRange,
                  sessionFirst,
              );

    const queryLists: Array<{ rows: NormalizedMessageRow[]; weight: number }> = [];
    let queryIndex = 0;
    if (baseQuery.length > 0) {
        queryLists.push({
            rows: baseOutcome?.rows ?? rowsByQuery[queryIndex] ?? [],
            // The full query is AND-joined and inherently discriminative.
            weight: 1,
        });
        if (!collectBaseDiagnostics) queryIndex += 1;
    }
    const probeWeights = new Map<string, number>();
    sanitizedProbes.forEach((entry, probeIndex) => {
        const weight = probeDiscriminationWeight(probeCounts[probeIndex] ?? 0, corpusSize);
        probeWeights.set(entry.probe, weight);
        queryLists.push({ rows: rowsByQuery[queryIndex] ?? [], weight });
        queryIndex += 1;
    });

    const rankProbeLists = (rowLimit: number, resultLimit: number) => {
        const fused = new Map<string, { row: NormalizedMessageRow; score: number }>();
        for (const list of queryLists) {
            list.rows.slice(0, rowLimit).forEach((row, rank) => {
                const rrf = list.weight / (RRF_K + rank);
                // Identity is owning session plus message id — neither is
                // unique across sessions.
                const key = `${row.sessionId} ${row.messageId}`;
                const existing = fused.get(key);
                if (existing) {
                    existing.score += rrf;
                } else {
                    fused.set(key, { row, score: rrf });
                }
            });
        }

        // Verbatim matches get one extra first-place contribution from their most
        // discriminative probe, rather than a large fixed bonus that would flatten
        // the differences between ranks.
        for (const entry of fused.values()) {
            let best = 0;
            for (const probe of probes) {
                const weight = probeWeights.get(probe) ?? 0;
                if (weight > best && containsProbeVerbatim(entry.row.content, [probe])) {
                    best = weight;
                }
            }
            if (best > 0) {
                entry.score += best * VERBATIM_RANK_BONUS;
            }
        }

        const ranked = [...fused.values()]
            .sort((a, b) =>
                b.score !== a.score ? b.score - a.score : compareMessageIdentity(a.row, b.row),
            )
            .slice(0, resultLimit);

        // Convert probe-fused message ranks to the same linear scores as ordinary
        // message FTS results, preserving comparability with the other sources.
        return ranked.map((entry, rank) => ({
            source: "message" as const,
            content:
                matchedSearchSnippet(entry.row.content, args.query) ||
                previewText(entry.row.content),
            score: linearDecayScore(rank, ranked.length),
            messageOrdinal: entry.row.messageOrdinal,
            messageId: entry.row.messageId,
            role: entry.row.role,
            sessionId: entry.row.sessionId,
            messageTimeMs: entry.row.messageTimeMs,
        }));
    };
    if (args.capture) args.capture.results = rankProbeLists(captureFetchLimit, args.capture.limit);
    return rankProbeLists(baselineFetchLimit, args.limit);
}

const NOTE_SEARCHABLE_STATUSES: Note["status"][] = ["active", "pending", "ready"];
const MAX_NOTE_KEYWORD_SCORE = 3.5;

function noteSearchText(note: Note): string {
    const reason = note.readyReason?.trim();
    return reason
        ? `${note.content}
Reason: ${reason}`
        : note.content;
}

function tokenizeKeywordNeedle(text: string): string[] {
    const matches = text.toLowerCase().match(/[a-z0-9/._:-]+/g) ?? [];
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const match of matches) {
        if (match.length <= 1 || !/[a-z0-9]/.test(match) || seen.has(match)) {
            continue;
        }
        seen.add(match);
        tokens.push(match);
    }
    return tokens;
}

interface RankedNoteMatch {
    note: Note;
    score: number;
    text: string;
}

function normalizeNoteKeywordScore(score: number): number {
    return normalizeCosineScore(score / MAX_NOTE_KEYWORD_SCORE) * SINGLE_SOURCE_PENALTY;
}

function rankNotesForNeedle(notes: readonly Note[], needle: string): RankedNoteMatch[] {
    const normalizedNeedle = needle.trim().toLowerCase();
    if (normalizedNeedle.length === 0) {
        return [];
    }
    const needleTokens = tokenizeKeywordNeedle(normalizedNeedle);
    const ranked: RankedNoteMatch[] = [];
    for (const note of notes) {
        const text = noteSearchText(note);
        const normalizedText = text.toLowerCase();
        const noteTokens = new Set(tokenizeKeywordNeedle(normalizedText));
        const exact = normalizedText.includes(normalizedNeedle);
        const matchedTokens = needleTokens.filter((token) => noteTokens.has(token)).length;
        if (!exact && matchedTokens === 0) {
            continue;
        }
        const matchedUniqueTokens = new Set(needleTokens.filter((token) => noteTokens.has(token)))
            .size;
        const coverage = needleTokens.length > 0 ? matchedTokens / needleTokens.length : 0;
        const density = noteTokens.size > 0 ? matchedUniqueTokens / noteTokens.size : 0;
        const exactPhrase =
            exact && (needleTokens.length > 1 || normalizedText.trim() === normalizedNeedle);
        const allTokens = needleTokens.length > 1 && matchedTokens === needleTokens.length;
        const score = (exactPhrase ? 2 : 0) + coverage * density + (allTokens ? 0.5 * density : 0);
        ranked.push({ note, score, text });
    }
    return ranked.sort((left, right) => {
        if (right.score !== left.score) {
            return right.score - left.score;
        }
        if (right.note.createdAt !== left.note.createdAt) {
            return right.note.createdAt - left.note.createdAt;
        }
        return left.note.id - right.note.id;
    });
}

function searchNotes(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    query: string;
    limit: number;
    probes?: string[];
    dateRange: InclusiveDateRange | null;
}): NoteSearchResult[] {
    if (args.limit <= 0) {
        return [];
    }

    const notes = [
        ...getNotes(args.db, {
            sessionId: args.sessionId,
            type: "session",
            status: NOTE_SEARCHABLE_STATUSES,
        }),
        ...getNotes(args.db, {
            projectPath: args.projectPath,
            type: "smart",
            status: NOTE_SEARCHABLE_STATUSES,
        }),
    ].filter((note) => timestampIsInRange(note.createdAt, args.dateRange));
    if (notes.length === 0) {
        return [];
    }

    const baseList = rankNotesForNeedle(notes, args.query);
    const probes = args.probes ?? [];

    if (probes.length === 0) {
        const ranked = baseList.slice(0, args.limit);
        return ranked.map((entry) => ({
            source: "note" as const,
            content: previewText(entry.text),
            score: normalizeNoteKeywordScore(entry.score),
            noteId: entry.note.id,
            status: entry.note.status,
            createdAt: entry.note.createdAt,
            anchorOrdinal: entry.note.anchorOrdinal,
            sourceSessionId: entry.note.sessionId,
        }));
    }

    const queryLists: Array<{ rows: RankedNoteMatch[]; weight: number }> = [];
    if (baseList.length > 0) {
        queryLists.push({ rows: baseList, weight: 1 });
    }
    for (const probe of probes) {
        const rows = rankNotesForNeedle(notes, probe);
        if (rows.length === 0) {
            continue;
        }
        const weight = probeDiscriminationWeight(rows.length, notes.length);
        queryLists.push({ rows, weight });
    }

    const fused = new Map<number, { entry: RankedNoteMatch; score: number }>();
    for (const list of queryLists) {
        for (const row of list.rows) {
            const relevance = row.score * list.weight;
            const existing = fused.get(row.note.id);
            if (existing) {
                if (relevance > existing.score) {
                    existing.entry = row;
                    existing.score = relevance;
                }
            } else {
                fused.set(row.note.id, { entry: row, score: relevance });
            }
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }
            if (right.entry.note.createdAt !== left.entry.note.createdAt) {
                return right.entry.note.createdAt - left.entry.note.createdAt;
            }
            return left.entry.note.id - right.entry.note.id;
        })
        .slice(0, args.limit);

    return ranked.map((entry) => ({
        source: "note" as const,
        content: previewText(entry.entry.text),
        score: normalizeNoteKeywordScore(entry.score),
        noteId: entry.entry.note.id,
        status: entry.entry.note.status,
        createdAt: entry.entry.note.createdAt,
        anchorOrdinal: entry.entry.note.anchorOrdinal,
        sourceSessionId: entry.entry.note.sessionId,
    }));
}

async function searchCompartmentChunks(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    queryEmbedding: Float32Array | null;
    limit: number;
    maxOrdinal?: number;
    modelId?: string | null;
    dateRange: InclusiveDateRange | null;
    warmOnly?: boolean;
    signal?: AbortSignal;
    timings?: UnifiedSearchStepTimings;
    diagnostics?: AutoSearchDiagnostics;
    reportDiagnostics?: () => void;
}): Promise<CompartmentSearchResult[]> {
    if (args.limit <= 0 || !args.modelId || args.modelId === "off") {
        if (args.timings) args.timings.chunkPool = "off";
        if (args.diagnostics) args.diagnostics.pool = "off";
        args.reportDiagnostics?.();
        return [];
    }
    if (!args.queryEmbedding) {
        if (args.timings) args.timings.chunkPool = "no-vector";
        if (args.diagnostics) args.diagnostics.pool = "no-vector";
        args.reportDiagnostics?.();
        // A late query vector is common for automatic hints. Warm the pool now
        // anyway, so a later turn whose vector does arrive finds it ready.
        if (args.warmOnly)
            void warmCompartmentChunkSearchPool(
                args.db,
                args.sessionId,
                args.projectPath,
                args.modelId,
            );
        return [];
    }
    const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
    let rows: StoredCompartmentChunkEmbedding[];
    if (args.warmOnly) {
        const warm = peekCompartmentChunkSearchPool(
            args.db,
            args.sessionId,
            args.projectPath,
            args.modelId,
            args.dateRange,
            args.diagnostics,
        );
        if (warm === null) {
            if (args.timings) args.timings.chunkPool = "cold";
            if (args.diagnostics) {
                args.diagnostics.pool = "cold";
                args.diagnostics.poolRows = 0;
            }
            args.reportDiagnostics?.();
            // Never throws. It runs between this thread's later work, which
            // already yields between pages and batches.
            void warmCompartmentChunkSearchPool(
                args.db,
                args.sessionId,
                args.projectPath,
                args.modelId,
            );
            return [];
        }
        if (args.timings) args.timings.chunkPool = "warm";
        if (args.diagnostics) {
            args.diagnostics.pool = "warm";
            args.diagnostics.poolRows = warm.length;
        }
        args.reportDiagnostics?.();
        rows = warm;
    } else {
        try {
            rows = await loadCompartmentChunkEmbeddingsForSearch(
                args.db,
                args.sessionId,
                args.projectPath,
                args.modelId,
                args.dateRange,
                args.signal,
            );
        } catch (error) {
            // The caller gave up; the caller's own abort check discards the search.
            if (args.signal?.aborted) return [];
            throw error;
        }
        if (args.timings) args.timings.chunkPool = "loaded";
    }
    if (rows.length === 0) return [];

    const byCompartment = new Map<
        number,
        { row: StoredCompartmentChunkEmbedding; score: number }
    >();
    let sliceStarted = performance.now();
    for (const row of rows) {
        if (performance.now() - sliceStarted >= 4) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            sliceStarted = performance.now();
        }
        if (cutoff !== null && row.endOrdinal > cutoff) {
            continue;
        }
        const score = normalizeCosineScore(cosineSimilarity(args.queryEmbedding, row.vector));
        if (score <= 0) continue;
        const existing = byCompartment.get(row.compartmentId);
        if (!existing || score > existing.score) {
            byCompartment.set(row.compartmentId, { row, score });
        }
    }

    return [...byCompartment.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.row.startOrdinal - right.row.startOrdinal,
        )
        .slice(0, args.limit)
        .map(({ row, score }) => ({
            source: "compartment" as const,
            content: previewText(row.title),
            score: score * SINGLE_SOURCE_PENALTY,
            compartmentId: row.compartmentId,
            sessionId: row.sessionId,
            title: row.title,
            startOrdinal: row.startOrdinal,
            endOrdinal: row.endOrdinal,
            matchType: "semantic" as const,
        }));
}

/** Fuse the message lane with the current session's compartment lane.
 *  A message may only merge into a compartment of ITS OWN session: ordinals
 *  are per-session sequence numbers, so an equal ordinal in another session
 *  must never donate its text to — or be swallowed by — this session's
 *  compartment. Compartment loading stays current-session-only. */
function mergeMessageAndCompartmentResults(args: {
    messages: MessageSearchResult[];
    compartments: CompartmentSearchResult[];
    limit: number;
}): Array<MessageSearchResult | CompartmentSearchResult> {
    if (args.compartments.length === 0) return args.messages;
    if (args.messages.length === 0) return args.compartments;

    const fused = new Map<
        string,
        {
            result: MessageSearchResult | CompartmentSearchResult;
            score: number;
            tieSession: string;
            tieOrdinal: number;
            snippetScore: number;
        }
    >();

    const add = (
        key: string,
        result: MessageSearchResult | CompartmentSearchResult,
        score: number,
        tieSession: string,
        tieOrdinal: number,
    ) => {
        const existing = fused.get(key);
        if (existing) {
            existing.score += score;
            return existing;
        }
        const entry = { result, score, tieSession, tieOrdinal, snippetScore: -1 };
        fused.set(key, entry);
        return entry;
    };

    args.compartments.forEach((compartment, rank) => {
        add(
            `compartment:${compartment.compartmentId}`,
            compartment,
            1 / (RRF_K + rank),
            compartment.sessionId,
            compartment.startOrdinal,
        );
    });

    for (const [rank, message] of args.messages.entries()) {
        const containing = args.compartments.find(
            (compartment) =>
                compartment.sessionId === message.sessionId &&
                message.messageOrdinal >= compartment.startOrdinal &&
                message.messageOrdinal <= compartment.endOrdinal,
        );
        const contribution = 1 / (RRF_K + rank);
        if (!containing) {
            add(
                `message:${message.sessionId}:${message.messageId}`,
                message,
                contribution,
                message.sessionId,
                message.messageOrdinal,
            );
            continue;
        }

        const entry = add(
            `compartment:${containing.compartmentId}`,
            containing,
            contribution,
            containing.sessionId,
            containing.startOrdinal,
        );
        if (message.score > entry.snippetScore && entry.result.source === "compartment") {
            entry.snippetScore = message.score;
            entry.result = {
                ...entry.result,
                matchType: "hybrid",
                snippet: message.content,
            };
        }
    }

    const ranked = [...fused.values()]
        .sort((left, right) =>
            right.score !== left.score
                ? right.score - left.score
                : left.tieSession !== right.tieSession
                  ? left.tieSession < right.tieSession
                      ? -1
                      : 1
                  : left.tieOrdinal - right.tieOrdinal,
        )
        .slice(0, args.limit);

    // Fusion decides ordering, not relevance. In particular, rank one must not
    // turn a weak cosine match into a perfect similarity score.
    return ranked.map((entry) => entry.result);
}

function getSourceBoost(result: UnifiedSearchResult): number {
    switch (result.source) {
        case "memory":
            return MEMORY_SOURCE_BOOST;
        case "message":
        case "compartment":
            return MESSAGE_SOURCE_BOOST;
        case "git_commit":
            return GIT_COMMIT_SOURCE_BOOST;
        case "primer":
            return PRIMER_SOURCE_BOOST;
        case "note":
            return 1;
        case "wiki":
            // Literal corpus matches carry no cross-source score; neutral.
            return 1;
    }
}

function compareUnifiedResults(left: UnifiedSearchResult, right: UnifiedSearchResult): number {
    const leftEffective = left.score * getSourceBoost(left);
    const rightEffective = right.score * getSourceBoost(right);

    if (rightEffective !== leftEffective) {
        return rightEffective - leftEffective;
    }

    if (left.source === "memory" && right.source === "memory") {
        return left.memoryId - right.memoryId;
    }

    if (left.source === "message" && right.source === "message") {
        return compareMessageIdentity(left, right);
    }

    if (left.source === "compartment" && right.source === "compartment") {
        return left.startOrdinal - right.startOrdinal;
    }

    if (left.source === "git_commit" && right.source === "git_commit") {
        // Newer commits win ties.
        return right.committedAtMs - left.committedAtMs;
    }

    if (left.source === "primer" && right.source === "primer") {
        return right.support - left.support || left.primerId - right.primerId;
    }

    if (left.source === "note" && right.source === "note") {
        return right.createdAt - left.createdAt || left.noteId - right.noteId;
    }

    return 0;
}

function toGitCommitResult(hit: GitCommitSearchHit): GitCommitSearchResult {
    return {
        source: "git_commit",
        content: previewText(hit.commit.message),
        score: hit.score,
        sha: hit.commit.sha,
        shortSha: hit.commit.shortSha,
        author: hit.commit.author,
        committedAtMs: hit.commit.committedAtMs,
        matchType: hit.matchType,
    };
}

function searchGitCommits(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    /** Pre-computed query embedding (or null if embedding is disabled / failed).
     *  unifiedSearch embeds once and passes the same vector here and to
     *  searchMemories — never embed twice for one query. */
    queryEmbedding: Float32Array | null;
    queryModelId?: string | null;
    dateRange: InclusiveDateRange | null;
    lanes?: SearchLanes;
    captureLexicalEvidence?: (hasLexicalEvidence: boolean) => void;
}): GitCommitSearchResult[] {
    if (args.limit <= 0) return [];

    const lanes = args.lanes;
    const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
        limit: args.limit,
        queryEmbedding: args.queryEmbedding,
        queryModelId: args.queryModelId,
        from: args.dateRange?.from,
        to: args.dateRange?.to,
        captureLexicalEvidence: args.captureLexicalEvidence,
        captureLanes: lanes
            ? (fts, vector) => {
                  lanes.git_fts = fts.map(toGitCommitResult);
                  lanes.git_vector = vector.map(toGitCommitResult);
              }
            : undefined,
    });
    return hits.map(toGitCommitResult);
}

function primerText(primer: Primer): string {
    const answer = primer.answer.trim();
    return answer ? `Q: ${primer.question}\nA: ${answer}` : `Q: ${primer.question}`;
}

function searchPrimers(args: {
    db: Database;
    projectPath: string;
    query: string;
    limit: number;
    queryEmbedding: Float32Array | null;
    queryModelId: string | null;
    dateRange: InclusiveDateRange | null;
    lanes?: SearchLanes;
    captureLexicalEvidence?: (hasEvidence: boolean) => void;
}): PrimerSearchResult[] {
    const primers = getActivePrimers(args.db, args.projectPath).filter((primer) =>
        timestampIsInRange(primer.createdAt, args.dateRange),
    );
    if (primers.length === 0 || args.limit <= 0) return [];
    const ftsQuery = sanitizeFtsQuery(args.query);
    const ftsRanks = new Map<number, number>();
    if (ftsQuery) {
        const rows = args.db
            .prepare(
                `SELECT p.id AS id, bm25(primers_fts) AS rank
                 FROM primers_fts
                 JOIN primers p ON p.id = primers_fts.rowid
                  WHERE primers_fts MATCH ? AND p.project_path = ? AND p.status = 'active'
                    ${args.dateRange === null ? "" : "AND p.created_at BETWEEN ? AND ?"}
                  ORDER BY rank ASC
                  LIMIT ?`,
            )
            .all(
                ftsQuery,
                args.projectPath,
                ...(args.dateRange === null ? [] : [args.dateRange.from, args.dateRange.to]),
                args.lanes ? Math.max(args.limit * 3, 225) : args.limit * 3,
            ) as Array<{ id: number; rank: number }>;
        const baselineRows = rows.slice(0, args.limit * 3);
        baselineRows.forEach((row, index) => {
            ftsRanks.set(row.id, linearDecayScore(index, baselineRows.length));
        });
        if (args.lanes) {
            const byId = new Map(primers.map((primer) => [primer.id, primer]));
            args.lanes.primer_fts = rows
                .flatMap((row, index) => {
                    const primer = byId.get(row.id);
                    return primer
                        ? [
                              {
                                  source: "primer" as const,
                                  primerId: primer.id,
                                  content: previewText(primerText(primer)),
                                  question: primer.question,
                                  support: primer.totalSupport,
                                  lastObservedAt: primer.lastObservedAt,
                                  matchType: "fts" as const,
                                  score: linearDecayScore(index, rows.length),
                              },
                          ]
                        : [];
                })
                .slice(0, 25);
        }
    }
    // FTS candidates are project/date eligible; capture them before semantic
    // sorting and the lane limit can hide them behind semantic-only hits.
    args.captureLexicalEvidence?.(ftsRanks.size > 0);
    const vectorResults: PrimerSearchResult[] = [];
    const scored = primers
        .map((primer) => {
            const semantic =
                args.queryEmbedding &&
                primer.questionEmbedding &&
                primer.questionEmbeddingModelId === args.queryModelId
                    ? normalizeCosineScore(
                          cosineSimilarity(args.queryEmbedding, primer.questionEmbedding),
                      )
                    : 0;
            if (args.lanes && semantic > 0)
                vectorResults.push({
                    source: "primer",
                    primerId: primer.id,
                    content: previewText(primerText(primer)),
                    question: primer.question,
                    support: primer.totalSupport,
                    lastObservedAt: primer.lastObservedAt,
                    matchType: "semantic",
                    score: semantic,
                });
            const fts = ftsRanks.get(primer.id) ?? 0;
            if (semantic <= 0 && fts <= 0) return null;
            const score =
                semantic > 0 && fts > 0
                    ? semantic * SEMANTIC_WEIGHT + fts * FTS_WEIGHT
                    : Math.max(semantic, fts);
            return {
                source: "primer" as const,
                content: previewText(primerText(primer)),
                score,
                primerId: primer.id,
                question: primer.question,
                support: primer.totalSupport,
                lastObservedAt: primer.lastObservedAt,
                matchType: semantic > 0 && fts > 0 ? "hybrid" : semantic > 0 ? "semantic" : "fts",
            } satisfies PrimerSearchResult;
        })
        .filter((result): result is PrimerSearchResult => result !== null)
        .sort((a, b) => b.score - a.score || b.support - a.support || a.primerId - b.primerId)
        .slice(0, args.limit);
    if (args.lanes)
        args.lanes.primer_vector = vectorResults
            .sort((a, b) => b.score - a.score || b.support - a.support || a.primerId - b.primerId)
            .slice(0, 25);
    return scored;
}

function resolveSources(
    sources: SearchSource[] | undefined,
    wikiEnabled: boolean,
): Set<SearchSource> {
    if (sources === undefined) {
        // Default: search all recall sources. Facts are deliberately NOT a
        // source — they're always rendered in <session-history> so searching
        // them returns content the agent already sees. The global wiki corpus
        // joins only when user-level config enables it.
        const defaults: SearchSource[] = ["memory", "message", "git_commit", "primer", "note"];
        if (wikiEnabled) defaults.push("wiki");
        return new Set(defaults);
    }
    const set = new Set<SearchSource>();
    for (const source of sources) {
        if (
            source === "memory" ||
            source === "message" ||
            source === "git_commit" ||
            source === "primer" ||
            source === "note" ||
            source === "wiki"
        ) {
            set.add(source);
        }
    }
    return set;
}

/** One native wiki hit as a section-read request; fallback hits carry their searched terms. */
function wikiSectionRequest(hit: WikiCorpusHit): WikiSectionRequest {
    return {
        path: hit.path,
        line: hit.line,
        matchByteColumn: hit.matchByteColumn,
        matchByteLength: hit.matchByteLength,
        matchText: hit.matchText,
        // Fallback hits carry the searched terms so a truncated native fragment
        // can be re-anchored on the full original line.
        matchTerms: hit.matchTerms,
    };
}

/**
 * Full-line recovery for the explicit lane. Only the limited hits that will
 * actually be returned and still need it are read (`matchTerms` present and no
 * verified `matchText`): their native preview otherwise starts at the
 * truncated fragment. Each such hit is one request, so `maxSections` covers
 * exactly them — the read is reused, no section is injected, and the explicit
 * result count/order stays the caller's limit.
 */
async function recoverTruncatedFallbackHits(args: {
    root: string;
    hits: readonly WikiCorpusHit[];
    signal?: AbortSignal;
}): Promise<Array<WikiSectionRecovery | undefined>> {
    const recoveries: Array<WikiSectionRecovery | undefined> = args.hits.map(() => undefined);
    const indexes = args.hits.flatMap((hit, index) =>
        hit.matchTerms !== undefined && hit.matchText === undefined ? [index] : [],
    );
    if (indexes.length === 0) return recoveries;
    const resolutions = await resolveWikiSectionHits({
        root: args.root,
        requests: indexes.map((index) => wikiSectionRequest(args.hits[index]!)),
        maxSections: indexes.length,
        signal: args.signal,
    });
    for (let position = 0; position < indexes.length; position++) {
        recoveries[indexes[position]!] = resolutions[position]?.recovery;
    }
    return recoveries;
}

async function searchWikiLane(args: {
    root: string;
    query: string;
    limit: number;
    dateRange: InclusiveDateRange | null;
    signal?: AbortSignal;
    diagnostics?: UnifiedSearchDiagnostics;
    /** Internal-miss fallback: dedupe and enrich at most three Markdown sections. */
    sections?: boolean;
}): Promise<WikiSearchResult[]> {
    const page = await searchWikiCorpus({
        root: args.root,
        query: args.query,
        signal: args.signal,
    });
    if (page.partial && args.diagnostics) args.diagnostics.wikiPartial = true;
    const inRange = page.hits.filter((hit) => timestampIsInRange(hit.modifiedAtMs, args.dateRange));
    // Explicit/wiki-only searches keep their original snippets for ordinary
    // hits and never read a file — except to re-anchor a fallback hit the SDK
    // truncated, where the native preview still starts at the fragment.
    if (!args.sections) {
        const limited = inRange.slice(0, args.limit);
        const recoveries = await recoverTruncatedFallbackHits({
            root: args.root,
            hits: limited,
            signal: args.signal,
        });
        // FFF exposes no comparable fuzzy score; reuse the message lane's linear
        // decay over the native result order instead of inventing one.
        return limited.map((hit, rank) => {
            const recovery = recoveries[rank];
            const matchText = recovery?.matchText ?? hit.matchText;
            return {
                source: "wiki" as const,
                content: recovery?.matchPreview ?? hit.preview,
                snippet: recovery?.matchSnippet ?? hit.snippet,
                score: linearDecayScore(rank, limited.length),
                path: hit.path,
                line: hit.line,
                modifiedAtMs: hit.modifiedAtMs,
                ...(matchText ? { matchText } : {}),
            };
        });
    }

    const resolutions = await resolveWikiSectionHits({
        root: args.root,
        requests: inRange.map(wikiSectionRequest),
        maxSections: 3,
        signal: args.signal,
    });
    const selected: Array<{
        hit: (typeof inRange)[number];
        resolution: (typeof resolutions)[number];
    }> = [];
    for (let index = 0; index < resolutions.length; index++) {
        const resolution = resolutions[index]!;
        if (resolution.status === "selected") {
            selected.push({ hit: inRange[index]!, resolution });
        }
    }
    return selected.map(({ hit, resolution }, rank) => {
        const section = resolution.section;
        const recovery = resolution.recovery;
        const matchText = recovery?.matchText ?? hit.matchText;
        return {
            source: "wiki" as const,
            // Classic content anchors on the recovered term when the bounded
            // full-line read could place it; transient material keeps the
            // section body as its snippet.
            content: recovery?.matchPreview ?? hit.preview,
            snippet: section?.excerpt ?? recovery?.matchSnippet ?? hit.snippet,
            score: linearDecayScore(rank, selected.length),
            path: hit.path,
            line: hit.line,
            modifiedAtMs: hit.modifiedAtMs,
            ...(matchText ? { matchText } : {}),
            ...(section
                ? {
                      heading: section.heading,
                      sectionStartLine: section.startLine,
                      sectionEndLine: section.endLine,
                  }
                : {}),
        };
    });
}

/** Turn memories already filtered through the visibility predicate into
 *  MemorySearchResult rows. Used by the ctx_search ID short-circuit so the
 *  direct-by-id path can return the same shape the normal search lanes emit
 *  (and reuse formatResult without a second code path). */
function memoriesToIdLookupResults(args: {
    memories: readonly Memory[];
    limit: number;
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}): MemorySearchResult[] {
    // Preserve the caller's order so a `parseIdShapedQuery` result like
    // `["#12", "34"]` renders hits in the same order the user typed them.
    const ordered = args.memories.slice(0, args.limit);
    return ordered.map((memory, rank) => ({
        source: "memory",
        content: previewText(memory.content),
        score: 1 - rank * 0.01,
        memoryId: memory.id,
        category: memory.category,
        matchType: "fts" as const,
        sourceName: args.sourceNameByMemoryId?.get(memory.id),
    }));
}

/** Resolve a parsed id list through the session's visibility scope. Returns
 *  MemorySearchResult rows in the caller's id order, or `null` when nothing
 *  resolved (signals the caller to fall through to the normal search lanes). */
export function resolveMemoriesByIdsForSearch(args: {
    db: Database;
    projectPath: string;
    ids: readonly number[];
    limit: number;
    /** Optional filter mirroring the m[0] hard-filter — already-rendered
     *  memories are skipped so the agent doesn't see the same content twice. */
    visibleMemoryIds?: Set<number> | null;
    diagnostics?: UnifiedSearchDiagnostics;
    from?: number;
    to?: number;
}): MemorySearchResult[] | null {
    if (args.diagnostics) {
        args.diagnostics.suppressedVisibleMemoryIds = [];
    }
    if (args.ids.length === 0) {
        return null;
    }
    const workspace = resolveSearchWorkspaceContext(args.db, args.projectPath);
    const fetched = workspace.isWorkspaced
        ? getMemoriesByProjects(
              args.db,
              workspace.expandedIdentities,
              ["active", "permanent", "archived"],
              Date.now(),
              workspace.ownIdentities,
              workspace.shareCategories,
          )
        : getMemoriesByProject(args.db, args.projectPath, ["active", "permanent", "archived"]);
    if (fetched.length === 0) {
        return null;
    }
    const dateRange = normalizeDateRange(args.from, args.to);
    const memoriesById = new Map(
        fetched
            .filter((memory) => timestampIsInRange(memory.createdAt, dateRange))
            .map((memory) => [memory.id, memory]),
    );
    const ordered: Memory[] = [];
    const suppressedVisibleIds = new Set<number>();
    for (const id of args.ids) {
        const memory = memoriesById.get(id);
        if (!memory) continue;
        if (args.visibleMemoryIds?.has(id)) {
            suppressedVisibleIds.add(id);
            continue;
        }
        ordered.push(memory);
        if (ordered.length >= args.limit) break;
    }
    if (args.diagnostics) {
        args.diagnostics.suppressedVisibleMemoryIds = [...suppressedVisibleIds].sort(
            (left, right) => left - right,
        );
    }
    if (ordered.length === 0) {
        return null;
    }
    return memoriesToIdLookupResults({
        memories: ordered,
        limit: args.limit,
        sourceNameByMemoryId: sourceNamesForSearchMemories({
            memories: ordered,
            projectPath: args.projectPath,
            workspace,
        }),
    });
}

/** SQLITE_MAX_VARIABLE_NUMBER is 999 by default. A session-set query binds the
 *  list twice (rowid prefilter + integrity guard) plus a few scalars per
 *  branch, so cap the candidate set far below half the budget. The list is
 *  deterministically ordered (current session first, then sorted ids):
 *  sessions beyond the cap are not searched this pass. */
const MAX_PROJECT_WIDE_SEARCH_SESSIONS = 200;

/** Candidate session set of a project-wide explicit search. The current
 *  session is always eligible (its caller is the project); every OTHER session
 *  qualifies only through an authoritative `session_projects` binding whose
 *  stored path normalizes to the caller's project identity — never raw path
 *  string equality. Sessions without a binding are excluded: an unmapped
 *  session cannot be proven to belong to this project. A session whose
 *  bindings normalize to more than one identity across harnesses is refused,
 *  never guessed. */
function resolveProjectWideCandidateSessions(
    db: Database,
    currentSessionId: string,
    projectPath: string,
): {
    sessionIds: string[];
    /** Per session, the moment its binding's project_path last changed (ms) —
     *  the session-moved-projects contract shared with the storage/expand
     *  side. A hit whose indexed message time predates it was indexed under
     *  the session's previous project and is excluded from this lane. */
    mappingUpdatedAtMs: Map<string, number>;
} {
    const callerIdentity = normalizeStoredProjectPath(projectPath);
    const rows = db
        .prepare(
            "SELECT session_id AS sessionId, project_path AS projectPath, updated_at AS updatedAt FROM session_projects",
        )
        .all() as Array<{ sessionId: string; projectPath: string; updatedAt: number }>;
    const bindingsBySession = new Map<string, Array<{ identity: string; updatedAt: number }>>();
    for (const row of rows) {
        let bindings = bindingsBySession.get(row.sessionId);
        if (!bindings) {
            bindings = [];
            bindingsBySession.set(row.sessionId, bindings);
        }
        bindings.push({
            identity: normalizeStoredProjectPath(row.projectPath),
            updatedAt: row.updatedAt,
        });
    }
    const admittedUpdatedAt = (sessionId: string): number | null => {
        const bindings = bindingsBySession.get(sessionId);
        if (!bindings) return null;
        const identities = new Set(bindings.map((binding) => binding.identity));
        if (identities.size !== 1 || !identities.has(callerIdentity)) return null;
        return Math.max(...bindings.map((binding) => binding.updatedAt));
    };
    const mappingUpdatedAtMs = new Map<string, number>();
    const others: string[] = [];
    for (const sessionId of bindingsBySession.keys()) {
        if (sessionId === currentSessionId) continue;
        const updatedAt = admittedUpdatedAt(sessionId);
        if (updatedAt === null) continue;
        mappingUpdatedAtMs.set(sessionId, updatedAt);
        others.push(sessionId);
    }
    others.sort();
    const currentUpdatedAt = admittedUpdatedAt(currentSessionId);
    if (currentUpdatedAt !== null) mappingUpdatedAtMs.set(currentSessionId, currentUpdatedAt);
    return {
        sessionIds: [currentSessionId, ...others.slice(0, MAX_PROJECT_WIDE_SEARCH_SESSIONS - 1)],
        mappingUpdatedAtMs,
    };
}

/**
 * The wiki fallback is a lane of last resort: the internal sources answered
 * nothing, so the best section it found must survive whatever ordering, rerank
 * pool, or token limit the final boundary applies. The lowest-ranked non-wiki
 * result gives up its slot only when the limit is already full; ordinary
 * (non-fallback) results and direct wiki ordering are never touched.
 *
 * Surviving wiki results then LEAD the returned array. The transient material
 * reserves one header per source and then spends the rest of its budget on
 * bodies in result order, so a relaxed or semantic row ahead of the section
 * would consume that budget and leave the section as a bare path. Order only
 * changes for the default fallback, where the remaining internal rows are
 * relaxed/semantic recall — strict lexical evidence would have closed the gate
 * and no wiki result would exist at all. Relative order inside each group is
 * preserved.
 *
 * Memory, primer, note and lexical git evidence all close the gate before the
 * fallback runs, so the evicted row can never be one whose citation the caller
 * relies on.
 */
export function ensureWikiFallbackRepresentation(
    results: UnifiedSearchResult[],
    args: { wikiResults: readonly WikiSearchResult[]; wikiFallback: boolean; limit: number },
): UnifiedSearchResult[] {
    if (args.wikiFallback !== true) return results;
    const best = args.wikiResults[0];
    if (best === undefined) return results;
    let kept = results;
    // Any surviving wiki hit already represents the lane; never insert twice.
    if (!kept.some((result) => result.source === "wiki")) {
        kept = kept.length >= args.limit ? kept.slice(0, Math.max(0, args.limit - 1)) : kept;
        kept = [...kept, best];
    }
    return [
        ...kept.filter((result) => result.source === "wiki"),
        ...kept.filter((result) => result.source !== "wiki"),
    ];
}

export async function unifiedSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    query: string,
    options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult[]> {
    // Per-candidate-session index snapshots: taken at issue time and re-checked
    // after every await, so one session rebuilding drops only its own hits —
    // never the whole message lane, and never another session's history.
    const messageLaneSnapshots = new Map<string, { searchable: boolean; epoch: number }>();
    const snapshotMessageLaneSession = (targetSessionId: string) => {
        const snapshot = {
            searchable: isMessageIndexSearchable(targetSessionId),
            epoch: getMessageIndexEpoch(targetSessionId),
        };
        messageLaneSnapshots.set(targetSessionId, snapshot);
        return snapshot;
    };
    const messageLaneSessionStillCurrent = (targetSessionId: string) => {
        const snapshot = messageLaneSnapshots.get(targetSessionId);
        // A session we never snapshotted carries no invalidation evidence — its
        // hits stay (older delegates and mocked lanes may not tag sessions).
        if (snapshot === undefined) return true;
        return (
            snapshot.searchable &&
            isMessageIndexSearchable(targetSessionId) &&
            getMessageIndexEpoch(targetSessionId) === snapshot.epoch
        );
    };
    snapshotMessageLaneSession(sessionId);
    const trimmedQuery = query.trim();
    const measurementStartedAt = Date.now();
    if (trimmedQuery.length === 0 || options.signal?.aborted) {
        return [];
    }

    const limit = normalizeLimit(options.limit);
    const reranker =
        options.explicitSearch && options.rerank !== false && isProseQuery(trimmedQuery)
            ? await prepareReranker(
                  projectPath,
                  sessionId,
                  options.rerankConnectionFile,
                  options.rerankClient,
                  options.rerankConfig,
              )
            : null;
    const lanes = reranker || options.captureRerankLanes ? emptySearchLanes() : undefined;
    const dateRange = normalizeDateRange(options.from, options.to);
    const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);
    if (options.diagnostics) {
        options.diagnostics.suppressedVisibleMemoryIds = [];
        options.diagnostics.suppressedLiveMessageMatches = 0;
        options.diagnostics.gitCommitUnavailable = null;
        options.diagnostics.wikiUnavailable = null;
        options.diagnostics.wikiPartial = false;
    }

    const embeddingEnabled = options.embeddingEnabled ?? true;
    const embedQuery = options.embedQuery ?? embedText;
    const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
    const gitCommitsEnabled = options.gitCommitsEnabled ?? false;
    const wikiConfig = options.wiki;
    const activeSources = resolveSources(options.sources, wikiConfig?.enabled === true);

    const memoryFeatureEnabled = options.memoryEnabled ?? true;
    const runMemory = activeSources.has("memory") && memoryFeatureEnabled;
    const runMessages = activeSources.has("message");
    const runGitCommits = activeSources.has("git_commit") && gitCommitsEnabled;
    if (
        options.diagnostics &&
        activeSources.has("git_commit") &&
        options.gitRepositoryAvailable === false
    ) {
        options.diagnostics.gitCommitUnavailable = "no_git_repository";
    }
    const runPrimers = activeSources.has("primer") && memoryFeatureEnabled;
    const runNotes = activeSources.has("note");
    const runWiki = activeSources.has("wiki") && wikiConfig?.enabled === true;
    // Semantic history search is not a memory feature: it runs whenever
    // embedding is on, whatever `memory.enabled` says.
    const runCompartmentChunks = runMessages && embeddingEnabled;

    // Embed the query ONCE at the top — both memory and git-commit searches
    // need the same vector. Previously each search called `embedQuery`
    // independently, producing two parallel HTTP requests for the same
    // input text (visible in LMStudio logs as duplicate `/v1/embeddings`
    // entries) which serialized at the model and doubled latency on
    // single-GPU embedding endpoints.
    //
    // We start the embed BEFORE running the synchronous `searchMessages`
    // path. JavaScript evaluates `Promise.all` arguments left-to-right, so
    // any synchronous call inside an arg expression blocks the event loop
    // and prevents in-flight `fetch()` work from being processed by the
    // runtime — even though the request was technically dispatched. On
    // long sessions `searchMessages` can do seconds of indexing work
    // (`ensureMessagesIndexed` walks raw OpenCode session history); doing
    // that BEFORE the embed call meant the embed fetch couldn't start
    // until indexing finished.
    const needsEmbedding =
        (runMemory || runGitCommits || runCompartmentChunks || runPrimers) &&
        embeddingEnabled &&
        isEmbeddingRuntimeEnabled();

    const queryEmbeddingPromise: Promise<CapturedQueryEmbedding | Float32Array | null> =
        needsEmbedding
            ? embedQuery(trimmedQuery, options.signal).catch((error) => {
                  log(
                      `[search] query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return null;
              })
            : Promise.resolve(null);

    // Yield to the event loop so the embed fetch's request gets a chance
    // to be dispatched at the runtime level before we run any synchronous
    // work. This is the crucial line that unblocks the auto-search 3-second
    // delay observed in production: without it, `searchMessages` runs
    // before the embed fetch is processed, and the embedding HTTP request
    // doesn't actually leave the process until we await later.
    await Promise.resolve();
    if (options.signal?.aborted) return [];

    // Run the synchronous message-FTS SELECT now that the embed fetch is
    // in flight. Message indexing is event-driven and never runs here;
    // unreconciled sessions simply return no message hits until the async
    // first-touch reconciliation finishes.
    // Multi-probe recall is opt-in for explicit searches only. NL queries
    // yield no probes, so this is a no-op for them regardless of the flag.
    const messageProbes = options.explicitSearch ? extractLiteralProbes(trimmedQuery) : [];
    const timings = options.stepTimings;
    let stepStartedAt = performance.now();
    let messageResults: MessageSearchResult[] = [];
    // Explicit ctx_search searches the whole project; auto-search and every
    // other caller keep the single-session lane. When no other session is
    // provably bound to this project, the lane is exactly the current session
    // and runs its original single-session path unchanged.
    const projectWideResolution =
        options.explicitSearch && runMessages
            ? resolveProjectWideCandidateSessions(db, sessionId, projectPath)
            : null;
    const projectWideSessionIds = projectWideResolution?.sessionIds ?? null;
    const mappingUpdatedAtMs =
        projectWideResolution?.mappingUpdatedAtMs ?? new Map<string, number>();
    const projectWide = projectWideSessionIds !== null && projectWideSessionIds.length > 1;
    const messageLaneSessions = projectWideSessionIds ?? [sessionId];
    // Issue-time check, per candidate: an unsearchable session is dropped from
    // the request, not from the whole lane — if the current session is
    // rebuilding, the other project sessions still return.
    const eligibleMessageLaneSessions = messageLaneSessions.filter(
        (candidateSessionId) => snapshotMessageLaneSession(candidateSessionId).searchable,
    );
    if (runMessages && eligibleMessageLaneSessions.length > 0) {
        const messageRequest: MessageHistorySearchRequest = {
            sessionId,
            query: trimmedQuery,
            limit: tierLimit,
            captureLimit: lanes ? 75 : undefined,
            maxOrdinal: options.maxMessageOrdinal,
            probes: messageProbes,
            relaxedRecall: options.explicitSearch,
            // The diagnostics path buys the live-tail count; ordinary searches skip it.
            collectDiagnostics: options.diagnostics !== undefined,
            dateRange,
            projectSessionIds: projectWide ? eligibleMessageLaneSessions : undefined,
        };
        // Explicit searches with literal probes count every probe's matches
        // across the session; a caller can move that work off its thread.
        const delegated = options.searchMessageHistory
            ? await options.searchMessageHistory(messageRequest).catch((error) => {
                  log(
                      `[search] off-thread message search failed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return null;
              })
            : null;
        if (delegated && options.signal?.aborted) return [];
        const outcome = delegated ?? searchMessageHistory(db, messageRequest);
        if (options.diagnostics) {
            options.diagnostics.suppressedLiveMessageMatches = outcome.suppressedLiveMessageMatches;
        }
        // The exclusion is scoped to the current session: the same message id
        // in another project session is a different message and must survive.
        // Session-moved-projects rule (shared contract with the storage/expand
        // side, which maintains `updated_at` as the moment a binding's path
        // actually changed): a hit indexed BEFORE its session's binding change
        // belongs to the session's previous project and stays out of this
        // lane. shortcut: legacy rows without index time are attributed to the
        // session's current project; upgrade when per-message provenance
        // exists.
        const attributedToThisProject = (result: MessageSearchResult): boolean =>
            result.messageTimeMs === null ||
            result.messageTimeMs >= (mappingUpdatedAtMs.get(result.sessionId) ?? 0);
        messageResults = outcome.results
            .filter(
                (result) =>
                    result.sessionId !== sessionId || result.messageId !== options.excludeMessageId,
            )
            .filter(attributedToThisProject);
        // A raw project-wide AND hit can belong to another session's pre-move
        // project. Once ownership filtering removes every such row, the relaxed
        // live tail is the only measured match left; the displayed diagnostic
        // reports that union. The gate itself never reads this count.
        if (
            options.wikiFallback === true &&
            options.diagnostics &&
            projectWide &&
            messageProbes.length === 0 &&
            options.maxMessageOrdinal != null &&
            options.maxMessageOrdinal >= 0 &&
            outcome.results.length > 0 &&
            messageResults.length === 0
        ) {
            const relaxedSuppressed = countProjectWideSuppressedLiveMessages({
                db,
                currentSessionId: sessionId,
                ftsQuery: relaxedFtsQuery(trimmedQuery),
                cutoff: options.maxMessageOrdinal,
                dateRange,
            });
            options.diagnostics.suppressedLiveMessageMatches = Math.max(
                options.diagnostics.suppressedLiveMessageMatches,
                relaxedSuppressed,
            );
        }
        if (lanes) lanes.message_fts = (outcome.laneResults ?? outcome.results).slice(0, 25);
        if (timings) timings.messageMs = performance.now() - stepStartedAt;
        recordAutoSearchLane(
            options.autoSearchDiagnostics,
            "messages",
            trimmedQuery,
            messageResults,
        );
        options.onAutoSearchDiagnostics?.();
    }

    // Wait for the single embed call (if any) and then run the two
    // embedding-dependent searches in parallel using the same vector.
    stepStartedAt = performance.now();
    const capturedQuery = await queryEmbeddingPromise;
    if (timings && needsEmbedding) timings.vectorWaitMs = performance.now() - stepStartedAt;
    // A provider may ignore cancellation and resolve after the hint deadline.
    // Do not turn that late vector into another synchronous database scan.
    if (options.signal?.aborted) return [];
    const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
    const queryContract =
        capturedQuery instanceof Float32Array || capturedQuery === null ? null : capturedQuery;
    const generationIsCurrent =
        queryContract === null ||
        (embeddingSnapshot !== null && embeddingSnapshot.generation === queryContract.generation);
    const queryEmbedding = generationIsCurrent
        ? (queryContract?.vector ?? (capturedQuery instanceof Float32Array ? capturedQuery : null))
        : null;
    const workspace = resolveSearchWorkspaceContext(db, projectPath);
    const embeddingModelId =
        queryContract?.modelId ?? options.embeddingModelIdOverride ?? embeddingSnapshot?.modelId;
    const chunkModelId =
        queryContract?.chunkModelId ??
        options.chunkModelIdOverride ??
        embeddingSnapshot?.chunkModelId;
    stepStartedAt = performance.now();
    if (timings) timings.chunkPool = "off";
    if (options.autoSearchDiagnostics && !runCompartmentChunks)
        options.autoSearchDiagnostics.pool = "off";
    const compartmentResults = runCompartmentChunks
        ? await searchCompartmentChunks({
              db,
              sessionId,
              projectPath,
              queryEmbedding,
              limit: lanes ? Math.max(tierLimit, 25) : tierLimit,
              maxOrdinal: options.maxMessageOrdinal,
              modelId: chunkModelId && chunkModelId !== "off" ? chunkModelId : null,
              dateRange,
              warmOnly: options.chunkPoolWarmOnly,
              signal: options.signal,
              timings,
              diagnostics: options.autoSearchDiagnostics,
              reportDiagnostics: options.onAutoSearchDiagnostics,
          })
        : [];
    if (runCompartmentChunks)
        recordAutoSearchLane(
            options.autoSearchDiagnostics,
            "summaries",
            trimmedQuery,
            compartmentResults,
        );
    options.onAutoSearchDiagnostics?.();
    if (timings && runCompartmentChunks) timings.chunkMs = performance.now() - stepStartedAt;
    stepStartedAt = performance.now();
    if (lanes) lanes.chunk_vector = compartmentResults.slice(0, 25);
    const messageLikeResults = mergeMessageAndCompartmentResults({
        messages: messageResults,
        compartments: compartmentResults.slice(0, tierLimit),
        limit: tierLimit,
    });

    let gitHasLexicalEvidence = false;
    let primerHasLexicalEvidence = false;
    const [memoryOutcome, gitCommitResults, primerResults, noteResults] = await Promise.all([
        runMemory
            ? searchMemories({
                  db,
                  projectPath,
                  query: trimmedQuery,
                  limit: tierLimit,
                  memoryEnabled: true,
                  queryEmbedding,
                  queryModelId:
                      embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                  workspace,
                  visibleMemoryIds: options.visibleMemoryIds,
                  backfillMemoryEmbeddings: options.backfillMemoryEmbeddings,
                  captureLexicalEvidence: options.wikiFallback === true,
                  lanes: options.memoryGateOnly ? undefined : lanes,
                  dateRange,
              })
            : Promise.resolve({
                  results: [] as MemorySearchResult[],
                  suppressedVisibleIds: [] as number[],
                  hasLexicalEvidence: false,
              }),
        runGitCommits
            ? Promise.resolve(
                  searchGitCommits({
                      db,
                      projectPath,
                      query: trimmedQuery,
                      limit: tierLimit,
                      queryEmbedding,
                      queryModelId:
                          embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                      dateRange,
                      lanes,
                      captureLexicalEvidence: options.wikiFallback
                          ? (hasEvidence) => {
                                gitHasLexicalEvidence = hasEvidence;
                            }
                          : undefined,
                  }),
              )
            : Promise.resolve([] as GitCommitSearchResult[]),
        runPrimers
            ? Promise.resolve(
                  searchPrimers({
                      db,
                      projectPath,
                      query: trimmedQuery,
                      limit: tierLimit,
                      queryEmbedding,
                      queryModelId:
                          embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
                      dateRange,
                      lanes,
                      captureLexicalEvidence: options.wikiFallback
                          ? (hasEvidence) => {
                                primerHasLexicalEvidence = hasEvidence;
                            }
                          : undefined,
                  }),
              )
            : Promise.resolve([] as PrimerSearchResult[]),
        runNotes
            ? Promise.resolve(
                  searchNotes({
                      db,
                      sessionId,
                      projectPath,
                      query: trimmedQuery,
                      limit: lanes ? Math.max(tierLimit, 25) : tierLimit,
                      probes: messageProbes,
                      dateRange,
                  }),
              )
            : Promise.resolve([] as NoteSearchResult[]),
    ]);

    if (timings) timings.otherLanesMs = performance.now() - stepStartedAt;
    if (runMemory)
        recordAutoSearchLane(
            options.autoSearchDiagnostics,
            "memory",
            trimmedQuery,
            memoryOutcome.results,
        );
    if (runGitCommits)
        recordAutoSearchLane(options.autoSearchDiagnostics, "git", trimmedQuery, gitCommitResults);
    options.onAutoSearchDiagnostics?.();
    if (options.diagnostics) {
        options.diagnostics.suppressedVisibleMemoryIds = memoryOutcome.suppressedVisibleIds;
    }

    // Wiki is a fallback, not a competing recall lane: lexical internal evidence,
    // including a memory suppressed because it is already visible, closes the gate.
    // Message evidence is a raw lexical row and nothing else: the strict queries
    // (full sanitized query plus literal probes) are checked for EXISTENCE in one
    // bounded `SELECT 1 … LIMIT 1` each, so a hit behind the lane's result limit,
    // behind pre-migration rows of another session, or above the compartment
    // cutoff still counts — while a relaxed-OR row or a semantic-only history
    // compartment never does. It runs only when the wiki lane could actually use
    // the answer (the source is enabled and selected) and no other source
    // answered: otherwise a wiki-disabled default search pays no extra probe.
    const otherInternalEvidence =
        memoryOutcome.hasLexicalEvidence ||
        primerHasLexicalEvidence ||
        noteResults.length > 0 ||
        // Use pre-limit lexical evidence: a newer semantic tie can slice an
        // older FTS/hybrid hit out of the returned results without erasing it.
        gitHasLexicalEvidence;
    const strictMessageEvidence =
        !otherInternalEvidence &&
        options.wikiFallback === true &&
        runWiki &&
        wikiConfig !== undefined &&
        runMessages &&
        eligibleMessageLaneSessions.length > 0 &&
        parseIdShapedQuery(trimmedQuery) === null &&
        hasStrictMessageEvidence({
            db,
            sessionIds: eligibleMessageLaneSessions,
            currentSessionId: sessionId,
            mappingUpdatedAtMs,
            dateRange,
            currentQueryMessageIds: options.currentQueryMessageIds ?? [],
            ftsQueries: [
                sanitizeFtsQuery(trimmedQuery),
                ...messageProbes.map((probe) => sanitizeFtsQuery(probe)),
            ],
        });
    const internalUsable = otherInternalEvidence || strictMessageEvidence;
    let wikiResults: WikiSearchResult[] = [];
    if (
        runWiki &&
        wikiConfig &&
        (!options.wikiFallback || (!internalUsable && parseIdShapedQuery(trimmedQuery) === null))
    ) {
        if (options.signal?.aborted) return [];
        try {
            wikiResults = await searchWikiLane({
                root: wikiConfig.source_root,
                query: options.wikiQuery ?? trimmedQuery,
                limit: tierLimit,
                dateRange,
                signal: options.signal,
                diagnostics: options.diagnostics,
                sections: options.wikiFallback === true,
            });
        } catch (error) {
            if (options.signal?.aborted) return [];
            const reason = wikiDiagnosticReason(error);
            if (reason !== null) {
                if (options.diagnostics) options.diagnostics.wikiUnavailable = reason;
                log(`[search] wiki source unavailable (${reason})`);
            }
        }
    }

    // Explicit-fusion-only reserved channel: report raw pre-merge,
    // epoch-checked candidates BEFORE the global limit slice and rerank can
    // drop them. Never collected for auto-search or plain explicit search.
    let reservedCandidates: ReservedSearchCandidates | null = null;
    if (options.explicitSearch && options.collectReservedCandidates) {
        const stillCurrent = (result: MessageSearchResult) =>
            messageLaneSessionStillCurrent(result.sessionId);
        reservedCandidates = {
            messages: messageResults.filter(stillCurrent).slice(0, RESERVED_CANDIDATE_LIMIT),
            gitCommits: gitCommitResults.slice(0, RESERVED_CANDIDATE_LIMIT),
            currentSessionMessages: messageResults
                .filter((result) => result.sessionId === sessionId)
                .filter(stillCurrent)
                .slice(0, RESERVED_CANDIDATE_LIMIT),
        };
        options.collectReservedCandidates(reservedCandidates);
    }
    // Re-validate message hits BEFORE ranking/truncation: a session invalidated
    // mid-search must not consume a result slot that a valid other-session hit
    // could have filled — filtering after the limit slice cannot backfill.
    let results = [
        ...(options.memoryGateOnly ? [] : memoryOutcome.results),
        ...primerResults,
        ...messageLikeResults,
        ...gitCommitResults,
        ...noteResults,
        ...wikiResults,
    ]
        .filter(
            (result) =>
                result.source !== "message" || messageLaneSessionStillCurrent(result.sessionId),
        )
        .sort(compareUnifiedResults)
        .slice(0, limit);

    const originalResults = results;
    const originalLatencyMs = Date.now() - measurementStartedAt;
    if (lanes) {
        lanes.notes = noteResults.slice(0, 25);
        // Fallback sections reach rerank before the final result limit;
        // direct wiki keeps its old lane cap.
        lanes.wiki = options.wikiFallback ? wikiResults : wikiResults.slice(0, limit);
        options.captureRerankLanes?.(lanes);
    }
    if (reranker && lanes) {
        const pool = fuseSearchLanes(lanes).slice(
            0,
            "remote" in reranker ? reranker.remote.top_n : 20,
        );
        try {
            results = await rerankSearchResults(
                reranker,
                trimmedQuery,
                results,
                pool,
                candidateTexts(db, sessionId, projectPath, pool, trimmedQuery),
                limit,
                options.signal,
                options.onRerankSkipped,
            );
        } catch {
            if ("remote" in reranker)
                remoteRerankSkipped("candidate_validation", options.onRerankSkipped);
            else logRerankFallback("candidate_validation");
        }
    }

    // The rerank await can outlive a session's validity, and a reranked pool
    // can surface lane message hits the pre-truncation pass never ranked: drop
    // exactly the invalidated sessions' hits before anything ships. Same
    // per-session fail-open rule as the pre-truncation pass and the reserved
    // channel.
    results = results.filter(
        (result) => result.source !== "message" || messageLaneSessionStillCurrent(result.sessionId),
    );
    // Final boundary: the rerank path replaces the whole array and a full limit
    // evicts the weakest row, either of which can drop the wiki fallback it just
    // paid for.
    results = ensureWikiFallbackRepresentation(results, {
        wikiResults,
        wikiFallback: options.wikiFallback === true,
        limit,
    });

    if (!options.measurementDisabled) {
        void recordShadowMeasurement({
            db,
            sessionId,
            projectPath,
            query: trimmedQuery,
            options: {
                ...options,
                rerank: false,
                captureRerankLanes: undefined,
                collectReservedCandidates: undefined,
            },
            primaryResults: originalResults,
            primaryQuery: queryContract,
            primaryLatencyMs: originalLatencyMs,
            search: unifiedSearch,
        });
    }

    // Only count retrievals for explicit agent-driven searches. Plugin-internal
    // automatic surfacing (auto-search hints) should not inflate retrieval_count
    // because the agent may never actually consume the hint.
    // retrieval_count is telemetry, not correctness: under MODULE authority the
    // TS write path is fenced, so skip the bump rather than failing the search.
    const countRetrievals = options.countRetrievals ?? true;
    if (countRetrievals) {
        const memoryIds = results
            .filter((result): result is MemorySearchResult => result.source === "memory")
            .map((result) => result.memoryId);

        if (memoryIds.length > 0) {
            db.transaction(() => {
                for (const memoryId of memoryIds) {
                    try {
                        updateMemoryRetrievalCount(db, memoryId);
                    } catch (error) {
                        // Telemetry only — module-managed rows must not fail the search.
                        if (error instanceof ModuleMemoryAuthorityError) continue;
                        throw error;
                    }
                }
            }).immediate();
        }
    }

    // Re-validate the reserved channel at return: the rerank/model awaits can
    // invalidate a session AFTER the pre-truncation snapshot handed hits to the
    // caller. The candidates object is shared by reference, so replacing its
    // arrays updates what the caller reads once this promise resolves. Same
    // per-session fail-open rule as the main lane: unsnapshotted sessions keep
    // their candidates.
    if (reservedCandidates) {
        const stillCurrent = (result: MessageSearchResult) =>
            messageLaneSessionStillCurrent(result.sessionId);
        reservedCandidates.messages = reservedCandidates.messages.filter(stillCurrent);
        reservedCandidates.currentSessionMessages =
            reservedCandidates.currentSessionMessages.filter(stillCurrent);
    }

    if (options.autoHint) {
        return results.map((result) => ({
            ...result,
            relevanceScore: autoSearchRelevance(trimmedQuery, result),
        }));
    }
    return results;
}

const SEARCH_NOTE_EXPAND_HINT =
    "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";

function formatSearchAge(timestampMs: number): string {
    const ageMs = Date.now() - timestampMs;
    if (ageMs < 0) return "future";
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return "1mo ago";
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? "1y ago" : `${years}y ago`;
}

function formatUnifiedSearchResult(
    result: UnifiedSearchResult,
    index: number,
    currentSessionId: string,
): string {
    if (result.source === "memory") {
        const source = result.sourceName ? ` source=${result.sourceName}` : "";
        return [
            `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category}${source} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "git_commit") {
        return [
            `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${result.shortSha} ${formatSearchAge(result.committedAtMs)} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "primer") {
        return [
            `[${index}] [primer] score=${result.score.toFixed(2)} id=${result.primerId} support=${result.support} match=${result.matchType}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "note") {
        const anchor =
            result.anchorOrdinal !== null && result.sourceSessionId === currentSessionId
                ? ` @msg ${result.anchorOrdinal}`
                : "";
        return [
            `[${index}] [note] score=${result.score.toFixed(2)} id=#${result.noteId} status=${result.status} ${formatSearchAge(result.createdAt)}${anchor}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "wiki") {
        const location =
            result.sectionStartLine !== undefined && result.sectionEndLine !== undefined
                ? `${result.sectionStartLine}-${result.sectionEndLine} heading=${result.heading ?? ""}`
                : `${result.line}`;
        return [
            `[${index}] [wiki] score=${result.score.toFixed(2)} path=${result.path}:${location}`,
            result.content,
        ].join("\n");
    }
    if (result.source === "compartment") {
        return [
            `[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${result.title}`,
            result.snippet ? `Snippet: ${result.snippet}` : result.content,
        ].join("\n");
    }
    const expandStart = Math.max(1, result.messageOrdinal - 3);
    const expandEnd = result.messageOrdinal + 3;
    // A hit from another project session carries its full identity; the
    // persisted time renders only when the index actually knows it (never
    // fabricated from the ordinal).
    const foreignSession =
        result.sessionId !== currentSessionId ? ` session=${result.sessionId}` : "";
    const age = result.messageTimeMs !== null ? ` ${formatSearchAge(result.messageTimeMs)}` : "";
    return [
        `[${index}] [message] score=${result.score.toFixed(2)}${foreignSession}${age} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
        result.content,
    ].join("\n");
}

export function formatWikiSearchDiagnostics(
    diagnostics: UnifiedSearchDiagnostics | undefined,
): string {
    if (!diagnostics) return "";
    const lines: string[] = [];
    if (diagnostics.wikiUnavailable !== null) {
        lines.push(`Wiki: source unavailable (${diagnostics.wikiUnavailable}).`);
    }
    if (diagnostics.wikiPartial) {
        lines.push(
            "Wiki: more matches may exist beyond the bounded first page; this result may be incomplete.",
        );
    }
    return lines.join("\n");
}

function formatSearchDiagnosticLines(
    results: UnifiedSearchResult[],
    diagnostics: UnifiedSearchDiagnostics | undefined,
): string[] {
    if (!diagnostics) return [];
    const lines: string[] = [];
    const visibleIds = [...diagnostics.suppressedVisibleMemoryIds].sort(
        (left, right) => left - right,
    );
    if (visibleIds.length > 0) {
        const count = visibleIds.length;
        const noun = count === 1 ? "match" : "matches";
        const ids = visibleIds.join(", ");
        if (results.some((result) => result.source === "memory")) {
            lines.push(
                `Memories: ${count} additional ${noun} suppressed because ${count === 1 ? "it is" : "they are"} already visible in your project-memory block (ids ${ids}).`,
            );
        } else {
            lines.push(
                `Memories: ${count} ${noun} found, all already visible in your project-memory block (ids ${ids}).`,
            );
        }
    }
    if (diagnostics.suppressedLiveMessageMatches > 0) {
        const count = diagnostics.suppressedLiveMessageMatches;
        lines.push(
            `Message history: ${count} raw-message ${count === 1 ? "match is" : "matches are"} newer than the last compartment boundary (already in your context).`,
        );
    }
    if (diagnostics.gitCommitUnavailable === "no_git_repository") {
        lines.push("Git commits: no git repository — commit search unavailable for this project.");
    }
    const wikiDiagnostics = formatWikiSearchDiagnostics(diagnostics);
    if (wikiDiagnostics) lines.push(...wikiDiagnostics.split("\n"));
    return lines;
}

/** Render output for explicit `ctx_search` callers in OpenCode and Pi. Include
 * diagnostics so intentional visibility suppression is explained while genuine
 * empty corpora retain their established wording. */
export function formatSearchResults(
    query: string,
    results: UnifiedSearchResult[],
    currentSessionId: string,
    diagnostics?: UnifiedSearchDiagnostics,
): string {
    const diagnosticLines = formatSearchDiagnosticLines(results, diagnostics);
    if (results.length === 0) {
        if (diagnosticLines.length > 0) {
            return `No hidden results found for "${query}".\n\n${diagnosticLines.join("\n")}`;
        }
        return `No results found for "${query}" across notes, memories, primers, git commits, or message history.`;
    }

    const bodyParts = results.map((result, index) =>
        formatUnifiedSearchResult(result, index + 1, currentSessionId),
    );
    if (diagnosticLines.length > 0) bodyParts.push(diagnosticLines.join("\n"));
    if (results.some((result) => result.source === "message" || result.source === "compartment")) {
        bodyParts.push(
            "Use ctx_expand(start, end) with the range from any message result above to read the conversation context. If the host no longer holds those messages, ctx_expand returns indexed text from the search archive only, with no surrounding messages or tool output.",
        );
    }
    // Hits owned by another session expand against THEIR session, not the
    // caller's: a bare `ctx_expand(start, end)` would read the current
    // session's ordinals. Point those at the owning session explicitly.
    const foreignSessions = [
        ...new Set(
            results.flatMap((result) =>
                (result.source === "message" || result.source === "compartment") &&
                result.sessionId !== currentSessionId
                    ? [result.sessionId]
                    : [],
            ),
        ),
    ].sort();
    if (foreignSessions.length > 0) {
        bodyParts.push(
            `Message results from another session expand against their OWN session: ${foreignSessions
                .map((id) => `ctx_expand(sessionId: "${id}", message: <ordinal>)`)
                .join("; ")}.`,
        );
    }
    if (
        results.some(
            (result) =>
                result.source === "note" &&
                result.anchorOrdinal !== null &&
                result.sourceSessionId === currentSessionId,
        )
    ) {
        bodyParts.push(SEARCH_NOTE_EXPAND_HINT);
    }
    return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n\n${bodyParts.join("\n\n")}`;
}
