/**
 * Pi-side wrapper for the `ctx_search` tool.
 *
 * The core search logic in `unifiedSearch()` is harness-agnostic — it operates
 * over the shared SQLite store. The pi-plugin only needs to:
 *
 *   1. Translate the LLM-provided arguments into the search options shape.
 *   2. Resolve session ID and project identity from the Pi extension context.
 *   3. Format results for the LLM the same way the OpenCode plugin does.
 *
 * `ctx_expand` is now registered alongside (see `./ctx-expand.ts`) — Pi
 * sessions are JSONL files, but the shared `readSessionChunk` reads
 * via the `RawMessageProvider` registry, so Pi just registers its own
 * provider for the duration of an expand call.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import {
	directoryHasGitMetadata,
	resolveProjectIdentityForSession,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	createUnifiedSearchDiagnostics,
	formatSearchResults,
	parseIdShapedQuery,
	resolveMemoriesByIdsForSearch,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { log } from "@magic-context/core/shared/logger";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import {
	parseSearchDateRange,
	SearchDateRangeError,
} from "@magic-context/core/tools/ctx-search/date-range";
import {
	STRATA_ASK_FOOTER,
	STRATA_ASK_MISS,
	hasUnsafeStrataCache,
	isStrataConfigResolutionFailure,
	mixedSourcesAnswer,
	readStrataStatusDocument,
	strataAskConnectionForProject,
	strataRouteFor,
	tryStrataAskDetailed,
	type StrataAskConnection,
} from "@magic-context/core/tools/ctx-search/strata-ask";
import { buildTransientMaterial } from "@magic-context/core/tools/ctx-search/transient-material";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";
import { loadPiConfigDetailed } from "../config";

/**
 * Call-cwd strata connection. Substitution failure, parse/schema failure, and
 * incomplete connection material or an unmatched project disable the cache path.
 */
export function resolvePiStrataAsk(cwd: string): StrataAskConnection | null {
	try {
		const loaded = loadPiConfigDetailed({ cwd }, false);
		if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
		const project = resolveProjectIdentityForSession(cwd, loaded.config.allow_home_project);
		return strataAskConnectionForProject(loaded.config, project);
	} catch {
		return null;
	}
}

const DEFAULT_LIMIT = 10;

const ParamsSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				description:
					"A natural-language question carrying the exact terms you expect in the answer.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum results (default 10).",
			}),
		),
		from: Type.Optional(
			Type.String({
				description: "Earliest date, YYYY-MM-DD (inclusive).",
			}),
		),
		to: Type.Optional(
			Type.String({
				description: "Latest date, YYYY-MM-DD (inclusive; default open).",
			}),
		),
		sources: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("memory"),
					Type.Literal("message"),
					Type.Literal("git_commit"),
					Type.Literal("primer"),
					Type.Literal("note"),
				]),
				{
					description:
						"Restrict to these sources; omitting it or passing [] searches every source.",
				},
			),
		),
	},
	{ additionalProperties: true },
);

type CtxSearchParams = Static<typeof ParamsSchema>;

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0)
		return DEFAULT_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function normalizeSources(
	sources?: CtxSearchParams["sources"],
): CtxSearchParams["sources"] | undefined {
	if (sources === undefined || sources.length === 0) return undefined;
	return sources;
}

export interface CtxSearchToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	rerankConnectionFile?: string;
	rerankConfig?: import("@magic-context/core/config/schema/magic-context").RerankConfig;
	/** Resolve a directory's project identity, allowing home only when user-level configuration enables it. */
	resolveProjectIdentity?: (directory: string) => string | undefined;
	/** Trust-filtered strata connection for the call cwd, or null when disabled. */
	resolveStrataAsk?: (
		directory: string,
	) => import("@magic-context/core/tools/ctx-search/strata-ask").StrataAskConnection | null;
}

export function createCtxSearchTool(
	deps: CtxSearchToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const resolveProject =
		deps.resolveProjectIdentity ?? resolveProjectIdentityForSession;
	return {
		name: "ctx_search",
		label: "Magic Context: Search",
		description: CTX_SEARCH_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxSearchParams,
			signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["query"], {
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
			const query = params.query?.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: 'query' is required." }],
					details: undefined,
					isError: true,
				};
			}
			let dateRange: ReturnType<typeof parseSearchDateRange>;
			try {
				dateRange = parseSearchDateRange(params.from, params.to);
			} catch (error) {
				if (!(error instanceof SearchDateRangeError)) throw error;
				return {
					content: [{ type: "text", text: `Error: ${error.message}` }],
					details: undefined,
					isError: true,
				};
			}

			let projectResolved = false;
			let resolvedProjectIdentity: string | undefined;
			const resolveProjectForCall = () => {
				if (!projectResolved) {
					resolvedProjectIdentity = resolveProject(ctx.cwd);
					projectResolved = true;
				}
				return resolvedProjectIdentity;
			};
			const sessionId = ctx.sessionManager.getSessionId();
			const runClassic = async (overrides?: {
				sources?: CtxSearchParams["sources"];
			}) => {
				const projectIdentity = resolveProjectForCall();
				if (!projectIdentity) {
					return {
						ok: false as const,
						text: "Error: Could not resolve project identity for search.",
						results: [],
						diagnostics: createUnifiedSearchDiagnostics(),
					};
				}
				await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
				const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
				const memoryEnabled =
					snapshot?.features.memoryEnabled ?? deps.memoryEnabled;
				// Query embedding follows the provider alone; each lane applies its
				// own feature gate, and history search ignores `memory.enabled`.
				const embeddingEnabled = snapshot
					? snapshot.historyEnabled
					: deps.embeddingEnabled;
				const gitCommitsEnabled =
					snapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

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
					sessionId,
				);
				const messageOrdinalCutoff =
					lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

				// Hard-filter memories already rendered in <session-history>.
				const visibleMemoryIds = getVisibleMemoryIds(deps.db, sessionId);
				const diagnostics = createUnifiedSearchDiagnostics();

				// ID-shaped short-circuit (parity with OpenCode ctx_search).
				// Unresolved IDs still fall through to normal text search.
				const idShape = parseIdShapedQuery(query);
				if (idShape && memoryEnabled) {
					const idResults = resolveMemoriesByIdsForSearch({
						db: deps.db,
						projectPath: projectIdentity,
						ids: idShape,
						limit: Math.max(normalizeLimit(params.limit), idShape.length),
						visibleMemoryIds,
						diagnostics,
						...dateRange,
					});
					if (
						idResults !== null ||
						diagnostics.suppressedVisibleMemoryIds.length > 0
					) {
						const results = idResults ?? [];
						return {
							ok: true as const,
							text: formatSearchResults(query, results, sessionId, diagnostics),
							results,
							diagnostics,
						};
					}
				}

				let rerankSkipped = "";
				const results = await unifiedSearch(
					deps.db,
					sessionId,
					projectIdentity,
					query,
					{
						limit: normalizeLimit(params.limit),
						memoryEnabled,
						embeddingEnabled,
						embedQuery: async (text, signal) => {
							const result = await embedTextForProject(
								projectIdentity,
								text,
								signal,
								"query",
							);
							return result?.vector ?? null;
						},
						isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
						maxMessageOrdinal: messageOrdinalCutoff,
						gitCommitsEnabled,
						sources: overrides?.sources ?? normalizeSources(params.sources),
						visibleMemoryIds,
						diagnostics,
						gitRepositoryAvailable: directoryHasGitMetadata(ctx.cwd),
						// Explicit agent search enables literal-probe multi-query recall.
						explicitSearch: true,
						rerankConnectionFile: deps.rerankConnectionFile,
						rerankConfig: deps.rerankConfig,
						// Cancellation also stops history-chunk pool building.
						signal,
						onRerankSkipped: (line) => {
							rerankSkipped = line;
						},
						...dateRange,
					},
				);
				return {
					ok: true as const,
					text:
						formatSearchResults(query, results, sessionId, diagnostics) +
						(rerankSkipped ? `\n${rerankSkipped}` : ""),
					results,
					diagnostics,
				};
			};

			const wrap = (text: string, isError = false) => ({
				content: [{ type: "text" as const, text }],
				details: undefined,
				...(isError ? { isError: true } : {}),
			});
			// Resolve identity before any Strata call, exactly as the classic path does.
			const route = strataRouteFor(params);
			if (route && deps.resolveStrataAsk && ctx.cwd) {
				const projectIdentity = resolveProjectForCall();
				if (projectIdentity) {
					let connection: ReturnType<
						NonNullable<typeof deps.resolveStrataAsk>
					> = null;
					try {
						connection = deps.resolveStrataAsk(ctx.cwd);
					} catch {
						connection = null;
					}
					if (connection && connection.project === projectIdentity) {
						if (route === "memory-only") {
							const answer = await tryStrataAskDetailed({
								query,
								config: connection,
								db: deps.db,
								signal,
							});
							if (answer.status === "answered") return wrap(answer.text);
							if (answer.status === "miss") {
								return wrap(`${STRATA_ASK_MISS}\n${STRATA_ASK_FOOTER}`);
							}
							const classic = await runClassic({ sources: ["memory"] });
							return wrap(classic.text, !classic.ok);
						}
						// Fusion runs classic once without memory, for the transient
						// materials; a miss, or a failure with the status document itself
						// readable, reuses that exact result. A status the cache cannot
						// carry at all fails the query to the FULL classic search instead —
						// memories included (see below).
						const classic = await runClassic({
							sources: params.sources?.filter((source) => source !== "memory") ?? ["git_commit", "primer", "note", "message"],
						});
						if (!classic.ok) return wrap(classic.text, true);
						let transient: string | undefined;
						try {
							transient = buildTransientMaterial({
								db: deps.db,
								sessionId,
								query,
								results: classic.results,
								budgetTokens: connection.transientBudgetTokens,
							})?.text;
						} catch (error) {
							const reason = (error instanceof Error ? error.message : String(error))
								.replace(/[\r\n]+/g, " ");
							log(`[ctx_search] transient-material fallback: ${reason}`);
							if (hasUnsafeStrataCache(connection.prefixPath) || !readStrataStatusDocument(connection).ok) {
								const full = await runClassic();
								return wrap(full.text, !full.ok);
							}
							return wrap(classic.text);
						}
						const answer = await tryStrataAskDetailed({
							query,
							config: connection,
							db: deps.db,
							signal,
							transient,
							allowExternalRefs: true,
						});
						if (answer.status === "answered") {
							return wrap(params.sources ? mixedSourcesAnswer(answer.text) : answer.text);
						}
						// The pre-run never searched memories and is not authoritative
						// without the ledger's changes, so an unavailable status means
						// full classic retrieval — memories included — answers this query.
						if (answer.status === "failed" && ["status_unavailable", "http_409", "http_400"].includes(answer.reason)) {
							const full = await runClassic();
							return wrap(full.text, !full.ok);
						}
						return wrap(classic.text);
					}
				}
			}
			const classic = await runClassic();
			return wrap(classic.text, !classic.ok);
		},
	};
}
