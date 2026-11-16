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
import { withQueryEmbeddingDeadline } from "@magic-context/core/features/magic-context/memory/embedding-query-deadline";
import {
	directoryHasGitMetadata,
	resolveProjectIdentityForSession,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	createUnifiedSearchDiagnostics,
	formatSearchResults,
	formatWikiSearchDiagnostics,
	parseIdShapedQuery,
	type ReservedSearchCandidates,
	resolveMemoriesByIdsForSearch,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { log } from "@magic-context/core/shared/logger";
import { isRecord } from "@magic-context/core/shared/record-type-guard";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import {
	parseSearchDateRange,
	SearchDateRangeError,
} from "@magic-context/core/tools/ctx-search/date-range";
import {
	hasUnsafeStrataCache,
	isStrataConfigResolutionFailure,
	mixedSourcesAnswer,
	readStrataStatusDocument,
	STRATA_ASK_FOOTER,
	STRATA_ASK_MISS,
	type StrataAskConnection,
	strataAskConnectionForProject,
	strataRouteFor,
	tryStrataAskDetailed,
} from "@magic-context/core/tools/ctx-search/strata-ask";
import {
	buildReservedHits,
	buildTransientMaterial,
	type TransientMaterial,
	withReservedAppendix,
} from "@magic-context/core/tools/ctx-search/transient-material";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";
import { loadPiConfigDetailed } from "../config";
import {
	readPiSessionMessages,
	SYNTH_USER_ID_PREFIX,
} from "../read-session-pi";

/**
 * Call-cwd strata connection. Substitution failure, parse/schema failure, and
 * incomplete connection material or an unmatched project disable the cache path.
 */
export function resolvePiStrataAsk(cwd: string): StrataAskConnection | null {
	try {
		const loaded = loadPiConfigDetailed({ cwd }, false);
		if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
		const project = resolveProjectIdentityForSession(
			cwd,
			loaded.config.allow_home_project,
		);
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
					Type.Literal("wiki"),
				]),
				{
					description:
						"Restrict to these sources; omitting it or passing [] searches every enabled source.",
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
	/** User-level global wiki corpus. Every project shares one root; omitted keeps the source off. */
	wiki?: import("@magic-context/core/config/schema/magic-context").WikiConfig;
	/** Resolve a directory's project identity, allowing home only when user-level configuration enables it. */
	resolveProjectIdentity?: (directory: string) => string | undefined;
	/** Trust-filtered strata connection for the call cwd, or null when disabled. */
	resolveStrataAsk?: (
		directory: string,
	) =>
		| import("@magic-context/core/tools/ctx-search/strata-ask").StrataAskConnection
		| null;
	/** Raw host rows, including user prompts too large or image-only for FTS. */
	readMessages?: (sessionId: string) => Array<{
		ordinal: number;
		id: string;
		role: string;
		parts: unknown[];
		storeType?: string;
	}>;
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
		async execute(toolCallId, params: CtxSearchParams, signal, _onUpdate, ctx) {
			params = unwrapImitatedReducedArgs(params, ["query"], {
				query: "string",
				limit: "number",
				from: "string",
				to: "string",
				sources: {
					type: "array",
					items: "string",
					maxItems: 6,
					values: ["memory", "message", "git_commit", "primer", "note", "wiki"],
				},
			});
			const rawQuery = params.query ?? "";
			const query = rawQuery.trim();
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
			const runClassic = async (
				overrides?: {
					sources?: CtxSearchParams["sources"];
					wikiFallback?: boolean;
					/** Memory gates wiki but stays out of the non-memory fusion fallback text. */
					memoryGateOnly?: boolean;
				},
				collectReserved?: (candidates: ReservedSearchCandidates) => void,
			) => {
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
				const normalizedSources = normalizeSources(params.sources);
				const selectedSources = new Set(normalizedSources ?? []);
				const memorySourceSelected =
					normalizedSources === undefined || selectedSources.has("memory");
				if (idShape && memoryEnabled && memorySourceSelected) {
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

				const wikiFallback =
					overrides?.wikiFallback ?? normalizedSources === undefined;
				let currentQueryMessageIds: string[] | undefined;
				if (wikiFallback) {
					try {
						const rawMessages = deps.readMessages
							? deps.readMessages(sessionId)
							: readPiSessionMessages(ctx);
						let currentRealUserIndex = -1;
						for (let index = rawMessages.length - 1; index >= 0; index--) {
							const message = rawMessages[index]!;
							if (
								message.role === "user" &&
								!message.id.startsWith(SYNTH_USER_ID_PREFIX)
							) {
								currentRealUserIndex = index;
								break;
							}
						}
						if (currentRealUserIndex >= 0) {
							currentQueryMessageIds = [rawMessages[currentRealUserIndex]!.id];
							const currentAssistant = rawMessages
								.slice(currentRealUserIndex + 1)
								.find(
									(message) =>
										message.role === "assistant" &&
										message.parts.some(
											(part) =>
												isRecord(part) &&
												part.type === "tool" &&
												part.callID === toolCallId,
										),
								);
							if (currentAssistant !== undefined) {
								currentQueryMessageIds.push(currentAssistant.id);
							}
						}
					} catch {
						// No confirmed host ids: retain all internal evidence.
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
							const result = await withQueryEmbeddingDeadline(
								(embeddingSignal) =>
									embedTextForProject(
										projectIdentity,
										text,
										embeddingSignal,
										"query",
									),
								signal,
							);
							return result?.vector ?? null;
						},
						isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
						maxMessageOrdinal: messageOrdinalCutoff,
						currentQueryMessageIds,
						gitCommitsEnabled,
						// One process-global user-level corpus; project identity never enters it.
						wiki: deps.wiki,
						wikiQuery: rawQuery,
						sources: overrides?.sources ?? normalizedSources,
						wikiFallback,
						memoryGateOnly: overrides?.memoryGateOnly === true,
						visibleMemoryIds,
						diagnostics,
						gitRepositoryAvailable: directoryHasGitMetadata(ctx.cwd),
						// Explicit agent search enables literal-probe multi-query recall.
						explicitSearch: true,
						// Reserved candidates feed the deterministic post-model appendix
						// on the fusion route only; plain classic calls never collect them.
						...(collectReserved
							? { collectReservedCandidates: collectReserved }
							: {}),
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
				const textResults = overrides?.memoryGateOnly
					? results.filter((result) => result.source !== "memory")
					: results;
				const textDiagnostics = overrides?.memoryGateOnly
					? {
							...diagnostics,
							suppressedVisibleMemoryIds: [],
						}
					: diagnostics;
				return {
					ok: true as const,
					text:
						formatSearchResults(
							query,
							textResults,
							sessionId,
							textDiagnostics,
						) + (rerankSkipped ? `\n${rerankSkipped}` : ""),
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
						// Explicit fusion runs its selected non-memory sources once. A default
						// query includes memory in the internal wiki gate; it is removed before
						// result ranking/limit and material. A miss, or a failure with readable
						// status, reuses that exact result. A status the cache cannot
						// carry at all fails the query to the FULL classic search instead —
						// memories included (see below).
						let reservedCandidates: ReservedSearchCandidates | undefined;
						// Wiki joins only the default pre-run when user-level config enables
						// it. Explicit arrays keep their non-memory filtering and direct routing.
						const fusionSources: Array<
							"memory" | "git_commit" | "primer" | "note" | "message" | "wiki"
						> = ["memory", "git_commit", "primer", "note", "message"];
						if (deps.wiki?.enabled) fusionSources.push("wiki");
						const wikiFallback = params.sources === undefined;
						const classic = await runClassic(
							{
								sources:
									params.sources?.filter((source) => source !== "memory") ??
									fusionSources,
								wikiFallback,
								memoryGateOnly: params.sources === undefined,
							},
							(candidates) => {
								reservedCandidates = candidates;
							},
						);
						if (!classic.ok) return wrap(classic.text, true);
						let material: TransientMaterial | null = null;
						try {
							material = buildTransientMaterial({
								db: deps.db,
								sessionId,
								query,
								results: classic.results,
								budgetTokens: connection.transientBudgetTokens,
								prioritizeWikiFallback: wikiFallback,
								reservedCandidates,
							});
						} catch (error) {
							const reason = (
								error instanceof Error ? error.message : String(error)
							).replace(/[\r\n]+/g, " ");
							log(`[ctx_search] transient-material fallback: ${reason}`);
							if (
								hasUnsafeStrataCache(connection.prefixPath) ||
								!readStrataStatusDocument(connection).ok
							) {
								const full = await runClassic();
								return wrap(full.text, !full.ok);
							}
							return wrap(classic.text);
						}
						const transient = material?.text;
						// The appendix rides even a null material: reserved hits survive
						// truncation, so the pre-run may have candidates while its final
						// result list is empty.
						const reserved = material
							? material.reserved
							: buildReservedHits(deps.db, query, reservedCandidates);
						const answer = await tryStrataAskDetailed({
							query,
							config: connection,
							db: deps.db,
							signal,
							transient,
							allowExternalRefs: true,
						});
						if (answer.status === "answered") {
							const base = params.sources
								? mixedSourcesAnswer(answer.text)
								: answer.text;
							const wikiDiagnostics = formatWikiSearchDiagnostics(
								classic.diagnostics,
							);
							const answerWithDiagnostics = wikiDiagnostics
								? `${base}\n\n${wikiDiagnostics}`
								: base;
							return wrap(
								withReservedAppendix(
									answerWithDiagnostics,
									reserved,
									query,
									material?.wikiSections ?? [],
								),
							);
						}
						// The pre-run is not the full classic answer and is not authoritative
						// without the ledger's changes, so an unavailable status falls back
						// to full classic retrieval.
						if (
							answer.status === "failed" &&
							["status_unavailable", "http_409", "http_400"].includes(
								answer.reason,
							)
						) {
							const full = await runClassic();
							return wrap(full.text, !full.ok);
						}
						if (answer.status === "miss") {
							return wrap(
								withReservedAppendix(
									classic.text,
									reserved,
									query,
									material?.wikiSections ?? [],
								),
							);
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
