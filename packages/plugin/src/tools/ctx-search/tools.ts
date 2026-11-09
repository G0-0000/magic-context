import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { withQueryEmbeddingDeadline } from "../../features/magic-context/memory/embedding-query-deadline";
import {
    describeUnresolvedProjectIdentity,
    directoryHasGitMetadata,
} from "../../features/magic-context/memory/project-identity";
import {
    createUnifiedSearchDiagnostics,
    formatSearchResults,
    parseIdShapedQuery,
    resolveMemoriesByIdsForSearch,
    unifiedSearch,
    type ReservedSearchCandidates,
} from "../../features/magic-context/search";
import { searchMessageHistoryOffThread } from "../../hooks/magic-context/auto-search-worker-client";
import { getVisibleMemoryIds } from "../../hooks/magic-context/inject-compartments";
import { log } from "../../shared/logger";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import {
    CTX_SEARCH_DESCRIPTION,
    CTX_SEARCH_TOOL_NAME,
    DEFAULT_CTX_SEARCH_LIMIT,
} from "./constants";
import { parseSearchDateRange, SearchDateRangeError } from "./date-range";
import {
    hasUnsafeStrataCache,
    mixedSourcesAnswer,
    readStrataStatusDocument,
    STRATA_ASK_FOOTER,
    STRATA_ASK_MISS,
    strataRouteFor,
    tryStrataAskDetailed,
    VALID_SOURCES,
} from "./strata-ask";
import {
    buildReservedHits,
    buildTransientMaterial,
    withReservedAppendix,
    type TransientMaterial,
} from "./transient-material";
import type { CtxSearchArgs, CtxSearchSource, CtxSearchToolDeps } from "./types";

export { CTX_SEARCH_LIGHT_DESCRIPTION } from "../light-descriptions";

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0) {
        return DEFAULT_CTX_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

/** Validate and normalize the `sources` arg. Drops unknown strings (the enum
 *  constraint catches them at the schema layer, but we still want a safe
 *  runtime check for plugins/tests that call this directly). Required-all
 *  surfaces fill unused arrays with `[]`; treat that the same as omitting
 *  `sources` so the search covers every enabled source instead of silently
 *  returning nothing. */
function normalizeSources(sources?: string[]): CtxSearchSource[] | undefined {
    if (sources === undefined) return undefined;
    const result: CtxSearchSource[] = [];
    const seen = new Set<CtxSearchSource>();
    for (const source of sources) {
        if (VALID_SOURCES.has(source as CtxSearchSource)) {
            const typed = source as CtxSearchSource;
            if (!seen.has(typed)) {
                seen.add(typed);
                result.push(typed);
            }
        }
    }
    return sources.length === 0 ? undefined : result;
}

const ctxSearchArgsShape = {
    query: tool.schema
        .string()
        .optional()
        .describe("A natural-language question carrying the exact terms you expect in the answer."),
    limit: tool.schema.number().optional().describe("Maximum results (default 10)."),
    from: tool.schema.string().optional().describe("Earliest date, YYYY-MM-DD (inclusive)."),
    to: tool.schema
        .string()
        .optional()
        .describe("Latest date, YYYY-MM-DD (inclusive; default open)."),
    sources: tool.schema
        .array(tool.schema.enum(["memory", "message", "git_commit", "primer", "note"]))
        .optional()
        .describe("Restrict to these sources; omitting it or passing [] searches every source."),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxSearchArgsSchema = tool.schema.object(ctxSearchArgsShape).passthrough();

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: ctxSearchArgsShape,
        async execute(rawArgs: CtxSearchArgs, toolContext) {
            const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxSearchArgs;
            args = unwrapImitatedReducedArgs(args, ["query"], {
                query: "string",
                limit: "number",
                from: "string",
                to: "string",
                sources: {
                    type: "array",
                    items: "string",
                    maxItems: 5,
                    values: ["memory", "message", "git_commit", "primer", "note"],
                },
            });
            const query = args.query?.trim();
            if (!query) {
                return "Error: 'query' is required.";
            }
            let dateRange: ReturnType<typeof parseSearchDateRange>;
            try {
                dateRange = parseSearchDateRange(args.from, args.to);
            } catch (error) {
                if (error instanceof SearchDateRangeError) return `Error: ${error.message}`;
                throw error;
            }

            let projectResolved = false;
            let resolvedProjectPath: string | undefined;
            const resolveProject = () => {
                if (!projectResolved) {
                    resolvedProjectPath = deps.resolveProjectPath(toolContext.directory);
                    projectResolved = true;
                }
                return resolvedProjectPath;
            };

            const runClassic = async (
                overrides?: { sources?: CtxSearchSource[] },
                collectReserved?: (candidates: ReservedSearchCandidates) => void,
            ) => {
                // Only search message history up to the last compartment boundary —
                // anything after that (the live tail, including the current turn) is
                // still in context and already visible to the agent. When NO compartment
                // exists yet, the historian hasn't scrolled anything out of context, so
                // the boundary is 0: every indexed message (ordinals are 1-based) is in
                // the live tail and must be excluded. A negative sentinel here would mean
                // "search everything" and leak the current prompt back to the agent — the
                // exact opposite of the intent (issue #131).
                const lastCompartmentEnd = getLastCompartmentEndMessage(
                    deps.db,
                    toolContext.sessionID,
                );
                const messageOrdinalCutoff = lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

                // Hard-filter memories already rendered in <session-history>.
                // They're visible in message[0], so returning them wastes output
                // tokens and crowds out high-signal raw-history hits.
                const visibleMemoryIds = getVisibleMemoryIds(deps.db, toolContext.sessionID);
                const diagnostics = createUnifiedSearchDiagnostics();

                // Resolve the session's actual project from `toolContext.directory`
                // each call; it can differ from the OpenCode launch directory.
                const projectPath = resolveProject();
                if (!projectPath) {
                    return {
                        ok: false as const,
                        text: `Error: Could not resolve project identity for search: ${describeUnresolvedProjectIdentity(toolContext.directory)}`,
                        results: [],
                        diagnostics,
                    };
                }
                await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
                const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
                const memoryEnabled =
                    embeddingSnapshot?.features.memoryEnabled ?? deps.memoryEnabled;
                // Query embedding serves history, memory and commit lanes alike, so it
                // follows the provider alone; each lane applies its own feature gate.
                const embeddingEnabled = embeddingSnapshot
                    ? embeddingSnapshot.historyEnabled
                    : deps.embeddingEnabled;
                const gitCommitsEnabled =
                    embeddingSnapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

                // ID-shaped short-circuit: look up a whole query of memory IDs
                // directly. Unresolved IDs still fall through to normal text search.
                const idShape = parseIdShapedQuery(query);
                if (idShape && memoryEnabled) {
                    const idResults = resolveMemoriesByIdsForSearch({
                        db: deps.db,
                        projectPath,
                        ids: idShape,
                        limit: Math.max(normalizeLimit(args.limit), idShape.length),
                        visibleMemoryIds,
                        diagnostics,
                        ...dateRange,
                    });
                    if (idResults !== null || diagnostics.suppressedVisibleMemoryIds.length > 0) {
                        const results = idResults ?? [];
                        return {
                            ok: true as const,
                            text: formatSearchResults(
                                query,
                                results,
                                toolContext.sessionID,
                                diagnostics,
                            ),
                            results,
                            diagnostics,
                        };
                    }
                }

                let rerankSkipped = "";
                const results = await unifiedSearch(
                    deps.db,
                    toolContext.sessionID,
                    projectPath,
                    query,
                    {
                        limit: normalizeLimit(args.limit),
                        memoryEnabled,
                        embeddingEnabled,
                        embedQuery: (text, signal) =>
                            withQueryEmbeddingDeadline(
                                (embeddingSignal) =>
                                    embedTextForProject(projectPath, text, embeddingSignal, "query"),
                                signal,
                            ),
                        isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
                        readMessages: deps.readMessages,
                        maxMessageOrdinal: messageOrdinalCutoff,
                        gitCommitsEnabled,
                        sources: overrides?.sources ?? normalizeSources(args.sources),
                        visibleMemoryIds,
                        diagnostics,
                        gitRepositoryAvailable:
                            typeof toolContext.directory === "string"
                                ? directoryHasGitMetadata(toolContext.directory)
                                : undefined,
                        // Explicit agent search enables literal-probe multi-query recall.
                        explicitSearch: true,
                        // Reserved candidates feed the deterministic post-model
                        // appendix on the fusion route only; plain classic calls
                        // (and auto-search) never collect them.
                        ...(collectReserved ? { collectReservedCandidates: collectReserved } : {}),
                        rerankConnectionFile: deps.rerankConnectionFile,
                        rerankConfig: deps.rerankConfig,
                        onRerankSkipped: (line) => {
                            rerankSkipped = line;
                        },
                        // Probe counts walk session FTS rows; keep the serving thread free.
                        searchMessageHistory: (request) =>
                            searchMessageHistoryOffThread(deps.db, request),
                        // Cancellation also stops history-chunk pool building.
                        signal: toolContext.abort,
                        ...dateRange,
                    },
                );
                return {
                    ok: true as const,
                    text:
                        formatSearchResults(query, results, toolContext.sessionID, diagnostics) +
                        (rerankSkipped ? `\n${rerankSkipped}` : ""),
                    results,
                    diagnostics,
                };
            };

            // Identity is resolved before any Strata request. A disabled or
            // mismatched connection keeps the ordinary classic path unchanged.
            const route = strataRouteFor(args);
            const directory =
                typeof toolContext.directory === "string" ? toolContext.directory : "";
            if (route && deps.resolveStrataAsk && directory) {
                const projectPath = resolveProject();
                if (projectPath) {
                    let connection: ReturnType<typeof deps.resolveStrataAsk> = null;
                    try {
                        connection = deps.resolveStrataAsk(directory);
                    } catch {
                        connection = null;
                    }
                    if (connection && connection.project === projectPath) {
                        const activeConnection = connection;
                        // The status document rides every cache query, on both
                        // routes: the ledger holds the memory changes the archived
                        // copy does not carry yet. It is read from the caller's
                        // handle — the same store the tool already serves from —
                        // and the read runs INSIDE the shared queue, as close to
                        // the splice request as possible: a consolidation queued
                        // ahead of this query then writes the slot before the
                        // status freezes, never after. An unreadable or over-cap
                        // status fails the query to classic retrieval.
                        const readStatus = () =>
                            readStrataStatusDocument(activeConnection, deps.db);
                        if (route === "memory-only") {
                            const answer = await tryStrataAskDetailed({
                                query,
                                config: activeConnection,
                                db: deps.db,
                                signal: toolContext.abort,
                                statusDocument: readStatus,
                            });
                            if (answer.status === "answered") return answer.text;
                            if (answer.status === "miss") {
                                return `${STRATA_ASK_MISS}\n${STRATA_ASK_FOOTER}`;
                            }
                            return (await runClassic({ sources: ["memory"] })).text;
                        }
                        // Fusion searches non-memory sources once, for the
                        // transient materials; a miss, or a failure with the
                        // status document itself readable, returns that exact
                        // result rather than searching again. A status the
                        // cache cannot carry at all (unreadable ledger, failed
                        // memory lookup, rows over the cap) is different: the
                        // pre-run never searched memories, and without the
                        // ledger's changes it is not authoritative — the query
                        // falls back to the FULL classic search, memories
                        // included.
                        let reservedCandidates: ReservedSearchCandidates | undefined;
                        const classic = await runClassic(
                            {
                                sources: args.sources?.filter((source) => source !== "memory") ?? [
                                    "git_commit", "primer", "note", "message",
                                ],
                            },
                            (candidates) => {
                                reservedCandidates = candidates;
                            },
                        );
                        if (!classic.ok) return classic.text;
                        let material: TransientMaterial | null = null;
                        try {
                            material = buildTransientMaterial({
                                db: deps.db,
                                sessionId: toolContext.sessionID,
                                query,
                                results: classic.results,
                                budgetTokens: activeConnection.transientBudgetTokens,
                                reservedCandidates,
                            });
                        } catch (error) {
                            const reason = (
                                error instanceof Error ? error.message : String(error)
                            ).replace(/[\r\n]+/g, " ");
                            log(`[ctx_search] transient-material fallback: ${reason}`);
                            if (
                                hasUnsafeStrataCache(activeConnection.prefixPath) ||
                                !readStatus().ok
                            ) {
                                return (await runClassic()).text;
                            }
                            return classic.text;
                        }
                        const transient = material?.text;
                        // The appendix rides even a null material: reserved hits
                        // survive truncation, so the pre-run may have candidates
                        // while its final result list is empty.
                        const reserved = material
                            ? material.reserved
                            : buildReservedHits(deps.db, query, reservedCandidates);
                        const answer = await tryStrataAskDetailed({
                            query,
                            config: activeConnection,
                            db: deps.db,
                            signal: toolContext.abort,
                            transient,
                            allowExternalRefs: true,
                            statusDocument: readStatus,
                        });
                        if (answer.status === "answered") {
                            const base = args.sources
                                ? mixedSourcesAnswer(answer.text)
                                : answer.text;
                            return withReservedAppendix(base, reserved, query);
                        }
                        if (
                            answer.status === "failed" &&
                            ["status_unavailable", "http_409", "http_400"].includes(answer.reason)
                        ) {
                            return (await runClassic()).text;
                        }
                        if (answer.status === "miss") {
                            return withReservedAppendix(classic.text, reserved, query);
                        }
                        return classic.text;
                    }
                }
            }
            return (await runClassic()).text;
        },
    });
}

export function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps),
    };
}
