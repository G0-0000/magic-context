/**
 * Bare ctx_search → Strata session-file cache.
 *
 * A query is ONE `POST /v1/chat/completions` carrying just the new user turn
 * plus `strata_session: { restore, splice: true }`. The server restores the
 * saved slot, splices the base into the prompt and runs the completion inside
 * one fifo turn, so no other client — and no other Magic Context process — can
 * clobber slot 0 in between. The base tokens come from the server-side token
 * sidecar, not from a locally replayed prefix.
 *
 * That one turn carries three things together: the status document (the memory
 * changes the archived copy does not carry yet, read from the ledger beside
 * `prefix_path`), the transient materials of the fusion route, and the question
 * itself. The status document is rendered by flow-render.ts and stays inside
 * the budget below; an absent or empty ledger renders the turn byte-identically
 * to a query without it. A ledger that cannot be read completely — an IO error
 * other than a missing file, a skipped line, a failed memory lookup, a live
 * memory with a pending remove, or rows over the token cap — fails the query
 * to classic retrieval instead: an incomplete status must never stand in for
 * the archived copy.
 *
 * This module never saves. The write side (strata-cache.ts) owns every save,
 * which is what keeps the sidecar in step with the prompt the cache answers
 * from. When the composite request reports that the sidecar cannot serve this
 * splice (`splice_stale`, `splice_base_seam`, `splice_render_mismatch`), a
 * marker is left beside `prefix_path` (sidecar-stale.ts) so the next
 * maintenance write rebuilds the sidecar, and the query falls back to classic
 * retrieval exactly like every other failure. The splice request is the only
 * request this module sends: there is no replay wire to fall back to.
 *
 * `memory.strata_ask.*` is intentionally absent from LIVE_RELOAD_CONFIG_PATHS.
 * That list is for historian and dreamer sampling. ctx_search does not use it:
 * OpenCode calls `resolveOpenCodeStrataAsk` and Pi calls `resolvePiStrataAsk`
 * on every search, for the call directory, with runtime globals left untouched.
 * A resolution failure (including `{env:}` / `{file:}` substitution failure), an
 * incomplete connection, or a project identity that is missing or not equal to
 * a configured project target is disabled: this module returns null and the
 * caller continues on the classic path. Identity is resolved before any network
 * call. `timeout_ms` bounds the one composite request.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { getMemoriesByIds } from "../../features/magic-context/memory/storage-memory";
import { parseIdShapedQuery } from "../../features/magic-context/search";
import { openCurrentDatabase } from "../../features/magic-context/storage-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    parseStatusChanges,
    renderStatusRow,
    type StatusChange,
    type StatusMemoryView,
    statusChangesPathFor,
} from "./flow-render";
import { reduceLedgerRows } from "./ledger-reduce";
import { markSidecarStale, readSidecarStale } from "./sidecar-stale";
import PROMPTS from "./strata-prompts.json";
import type { CtxSearchSource } from "./types";

export const VALID_SOURCES: ReadonlySet<CtxSearchSource> = new Set([
    "memory", "message", "git_commit", "primer", "note",
]);

/** Query template; copy lives in strata-prompts.json (edit there, rebuild dists). */
export const STRATA_ASK_T4 = PROMPTS.t4;

export const STRATA_ASK_MISS = "记忆库中无";
export const DEFAULT_TRANSIENT_BUDGET_TOKENS = 2000;
export const DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS = 4000;
/**
 * Cap for the status document inside one query turn. It is priced apart from
 * `DEFAULT_TRANSIENT_BUDGET_TOKENS`: this one bounds what the ledger may add to
 * the spliced turn, that one bounds the fusion route's classic materials.
 */
export const DEFAULT_STATUS_BUDGET_TOKENS = 2000;

export type StrataAskOutcome =
    | { status: "answered"; text: string }
    | { status: "miss" }
    | { status: "failed"; reason: string };

/** `strata_session` request object: every key is optional; the server rejects others. */
export interface StrataSessionRequest {
    restore?: string;
    save?: string;
    splice?: boolean;
}

/** The `session` block a composite reply carries; absent on a plain chat reply. */
export interface StrataSessionReply {
    restored?: { tokens?: unknown };
    splice?: {
        base_tokens?: unknown;
        delta_tokens?: unknown;
        resume?: unknown;
        resume_ok?: unknown;
    };
    saved?: { tokens?: unknown; bytes?: unknown; ms?: unknown };
    save_error?: unknown;
    sidecar?: unknown;
}

/** The `session` block of a composite reply; null when the server sent none. */
export function sessionBlockOf(json: unknown): StrataSessionReply | null {
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const session = (json as { session?: unknown }).session;
    if (!session || typeof session !== "object" || Array.isArray(session)) return null;
    return session as StrataSessionReply;
}

export const STRATA_ASK_FOOTER =
    "——本答案由项目记忆缓存合成，可能融合期外材料摘要；记忆原文可按 #id 用 ctx_memory get，其余确切原文请用 ctx_expand 或显式 sources 参数";

export function mixedSourcesAnswer(text: string): string {
    return `${text}（取非记忆原文时，sources 须排除 memory，例如 sources:['note']）`;
}

/**
 * Every Strata chat call (ctx_search cache query, ACK, count self-check) asks
 * the server to answer without reasoning: the callers want a one-line answer,
 * and one fixed template kwarg keeps the rendered turn byte-stable across
 * requests. `chat_template_kwargs` is a top-level field the server handles
 * independently of `strata_session`, so restore/save-only requests carry it too
 * even though a slot filename never reaches the template.
 */
export function strataNoThinking(): { chat_template_kwargs: { enable_thinking: false } } {
    return { chat_template_kwargs: { enable_thinking: false } };
}

const RESOLUTION_FAILURES = new Set([
    "project-file-parse-error",
    "project-file-io-error",
    "schema-recovery",
    // A missing {env:} / {file:} token is replaced with "" and still reported.
    // The substituted value can remain a legal URL, so this is not "incomplete".
    "substitution-failure",
]);

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["「", "」"],
    ["『", "』"],
    ["[", "]"],
    ["(", ")"],
    ["（", "）"],
];

export interface StrataAskConnection {
    baseUrl: string;
    apiKey: string | null;
    apiKeyEnv: string | null;
    model: string;
    slotFile: string;
    prefixPath: string;
    /** Project identity this cache is allowed to answer. Exact match only. */
    project: string;
    maxTokens: number;
    timeoutMs: number;
    transientBudgetTokens: number;
    contextDocs: string[];
    contextDocsBudgetTokens: number;
}

export interface StrataAskConfigSource {
    memory?: {
        strata_ask?: {
            enabled?: boolean;
            base_url?: string;
            api_key?: string | null;
            api_key_env?: string | null;
            model?: string;
            slot_file?: string;
            prefix_path?: string;
            project?: string;
            targets?: Array<{
                project: string;
                slot_file: string;
                prefix_path: string;
                context_docs?: string[];
            }>;
            context_docs?: string[];
            context_docs_budget_tokens?: number;
            max_tokens?: number;
            timeout_ms?: number;
            transient_budget_tokens?: number;
        };
    };
}

export function isStrataConfigResolutionFailure(outcome: string): boolean {
    return RESOLUTION_FAILURES.has(outcome);
}

/**
 * Known business params only. Host metadata keys do not affect the verdict.
 * `limit` is not a disqualifier: it bounds classic results and the transient
 * materials, never the synthesized cache answer.
 */
export function strataRouteFor(normalizedArgs: object): "fusion" | "memory-only" | null {
    const args = normalizedArgs as Record<string, unknown>;
    if ("from" in args || "to" in args) return null;
    if (typeof args.query !== "string") return null;
    const query = args.query.trim();
    if (!query || parseIdShapedQuery(query) !== null) return null;
    if (!("sources" in args)) return "fusion";
    if (Array.isArray(args.sources)) {
        const sources = new Set(args.sources);
        if (![...sources].every((source) => VALID_SOURCES.has(source as CtxSearchSource))) return null;
        if (sources.has("memory")) return sources.size === 1 ? "memory-only" : "fusion";
    }
    return null;
}

export function isStrataAskEligible(normalizedArgs: object): boolean {
    return strataRouteFor(normalizedArgs) !== null;
}

export function nonEmpty(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function safeBearer(value: string | null): string | null {
    if (!value || /[\r\n]/.test(value)) return null;
    return value;
}

function isSlotBasename(value: string): boolean {
    return value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

/**
 * Pure. Null means the cache path is disabled: flag off, or the user-level
 * connection is incomplete. Does not read the environment or the network.
 */
export function strataAskConnectionFromConfig(
    config: StrataAskConfigSource,
): StrataAskConnection | null {
    const raw = config.memory?.strata_ask;
    if (raw?.enabled !== true) return null;
    const baseUrl = nonEmpty(raw.base_url)?.replace(/\/+$/, "") ?? "";
    if (!/^https?:\/\//.test(baseUrl)) return null;
    const model = nonEmpty(raw.model);
    const slotFile = nonEmpty(raw.slot_file);
    const prefixPath = nonEmpty(raw.prefix_path);
    const project = nonEmpty(raw.project);
    const apiKey = safeBearer(nonEmpty(raw.api_key));
    const apiKeyEnv = nonEmpty(raw.api_key_env);
    if (
        !model ||
        !slotFile ||
        !isSlotBasename(slotFile) ||
        !prefixPath ||
        !isAbsolute(prefixPath) ||
        !project
    ) {
        return null;
    }
    if (!apiKey && !apiKeyEnv) return null;
    const maxTokens = raw.max_tokens;
    const timeoutMs = raw.timeout_ms;
    const contextDocsBudgetTokens = raw.context_docs_budget_tokens;
    if (
        typeof maxTokens !== "number" ||
        !Number.isFinite(maxTokens) ||
        maxTokens < 1 ||
        typeof timeoutMs !== "number" ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs < 1
    ) {
        return null;
    }
    return {
        baseUrl,
        apiKey,
        apiKeyEnv,
        model,
        slotFile,
        prefixPath,
        project,
        maxTokens: Math.floor(maxTokens),
        timeoutMs: Math.floor(timeoutMs),
        transientBudgetTokens:
            typeof raw.transient_budget_tokens === "number" &&
            Number.isFinite(raw.transient_budget_tokens) &&
            raw.transient_budget_tokens >= 1 &&
            raw.transient_budget_tokens <= 8192
                ? raw.transient_budget_tokens
                : DEFAULT_TRANSIENT_BUDGET_TOKENS,
        contextDocs: Array.isArray(raw.context_docs)
            ? raw.context_docs.filter((path) => typeof path === "string" && path.length > 0)
            : [],
        contextDocsBudgetTokens:
            typeof contextDocsBudgetTokens === "number" &&
            Number.isInteger(contextDocsBudgetTokens) &&
            contextDocsBudgetTokens >= 1 &&
            contextDocsBudgetTokens <= 32768
                ? contextDocsBudgetTokens
                : DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS,
    };
}

/** Select the first matching user-level target; shared connection settings remain unchanged. */
export function strataAskConnectionForProject(
    config: StrataAskConfigSource,
    projectIdentity: string | null | undefined,
): StrataAskConnection | null {
    const raw = config.memory?.strata_ask;
    if (raw?.enabled !== true || !projectIdentity) return null;
    if (nonEmpty(raw.project) === projectIdentity) return strataAskConnectionFromConfig(config);
    const target = raw.targets?.find((entry) => nonEmpty(entry.project) === projectIdentity);
    if (!target) return null;
    return strataAskConnectionFromConfig({
        memory: {
            strata_ask: {
                ...raw,
                project: target.project,
                slot_file: target.slot_file,
                prefix_path: target.prefix_path,
                context_docs: target.context_docs ?? [],
            },
        },
    });
}

/** Trust-filtered effective config for the call directory. Failure ⇒ disabled. */
export function resolveOpenCodeStrataAsk(directory: string): StrataAskConnection | null {
    if (!directory) return null;
    try {
        const loaded = loadPluginConfigDetailed(directory, false);
        if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
        const project = resolveProjectIdentityForSession(
            directory,
            loaded.config.allow_home_project,
        );
        return strataAskConnectionForProject(loaded.config, project);
    } catch {
        log("strata-ask disabled: resolution_failure");
        return null;
    }
}

/**
 * One query turn: `status` is the rendered status document, `transient` the
 * fusion route's classic materials. Both templates substitute an absent block
 * with an empty string, so the turn stays byte-identical to the pre-block query
 * whenever there is nothing to carry.
 */
export function renderQueryMessage(query: string, transient?: string, status?: string): string {
    const template = transient ? PROMPTS.t4Fused : STRATA_ASK_T4;
    return template.replace(/\{status\}|\{materials\}|\{q\}/g, (token) => {
        if (token === "{status}") return status ?? "";
        if (token === "{materials}") return transient ?? "";
        return query;
    });
}

export interface StrataStatusBlock {
    text: string;
    /** Rows carried in the block. */
    kept: number;
    /** Oldest rows the budget dropped. */
    omitted: number;
}

/**
 * Render the status document inside its token cap. The cap prices flow rows
 * only — the rendered rows joined by `"\n\n"`, exactly the write side's
 * measure (strata-cache.ts `estimateStatusTokens`) — so one ledger prices
 * identically on both sides; the block header and truncation note are
 * overhead neither side counts. Rows the current database voids (a vanished
 * `add`, a `remove` whose memory was restored) render as null and drop out
 * before measuring, on the same selection rule the write side applies. The
 * query reader rejects live removes before building a block, because the slot
 * may contain stale text. The newest rows are the point, so an over-budget
 * ledger keeps them and drops the oldest, saying how many it dropped. A
 * ledger with nothing renderable in it, or whose newest row alone does not
 * fit, yields null: the cap is hard, and a block with no row in it says
 * nothing worth sending.
 */
export function buildStrataStatusBlock(
    changes: readonly StatusChange[],
    memories: ReadonlyMap<number, StatusMemoryView>,
    budgetTokens: number = DEFAULT_STATUS_BUDGET_TOKENS,
): StrataStatusBlock | null {
    const rows = reduceLedgerRows(changes, (change) => change)
        .map((change) => renderStatusRow(change, memories.get(change.id) ?? null))
        .filter((row): row is string => row !== null);
    if (rows.length === 0) return null;
    const compose = (start: number): string => {
        const note =
            start > 0 ? PROMPTS.statusTruncated.replace("{omitted}", () => String(start)) : null;
        const body = [note, ...rows.slice(start)]
            .filter((line): line is string => Boolean(line))
            .join("\n");
        return PROMPTS.statusBlock.replace("{rows}", () => body);
    };
    let newestFit = -1;
    for (let start = rows.length - 1; start >= 0; start--) {
        if (estimateTokens(rows.slice(start).join("\n\n")) > budgetTokens) break;
        newestFit = start;
    }
    if (newestFit < 0) return null;
    return { text: compose(newestFit), kept: rows.length - newestFit, omitted: newestFit };
}

/**
 * The rows a status row may quote: this project's live memories, the same view
 * the write side renders from. Anything else reads as a 讣 — the row cannot stand
 * for current content. Returns null when the lookup could not run at all (no
 * database handle, or the query threw): a failed lookup must never render a 讣,
 * so the caller treats the whole status as unavailable. A lookup that ran and
 * simply did not return an id confirms the memory is gone — that id renders as
 * a 讣, which is the truth.
 */
function statusMemories(
    connection: StrataAskConnection,
    ids: readonly number[],
    db?: Database,
    excludeExpired = false,
): Map<number, StatusMemoryView> | null {
    const memories = new Map<number, StatusMemoryView>();
    if (ids.length === 0) return memories;
    let handle: Database | null;
    try {
        handle = db ?? openCurrentDatabase();
    } catch (error) {
        log("strata-ask: status memory lookup failed; classic retrieval answers this query", error);
        return null;
    }
    if (!handle) {
        log(
            "strata-ask: no database handle for the status memory lookup; classic retrieval answers this query",
        );
        return null;
    }
    try {
        const now = Date.now();
        for (const memory of getMemoriesByIds(handle, ids)) {
            if (memory.projectPath !== connection.project) continue;
            if (memory.status !== "active" && memory.status !== "permanent") continue;
            if (excludeExpired && memory.expiresAt !== null && memory.expiresAt <= now) continue;
            memories.set(memory.id, memory);
        }
    } catch (error) {
        log("strata-ask: status memory lookup failed; classic retrieval answers this query", error);
        return null;
    }
    return memories;
}

/**
 * The read result of one connection's status document. `ok: true` with a null
 * text means there is nothing to carry — no ledger, an empty one, or nothing
 * renderable in it — and the query proceeds without a block, byte-identically
 * to a query without one. `ok: false` means the status is incomplete or cannot
 * establish current content: an IO error other than a missing ledger, a skipped
 * line, a failed memory lookup, a live remove, or rows over the token cap. The
 * caller falls back to classic retrieval with memories.
 */
export type StrataStatusRead = { ok: true; text: string | null } | { ok: false };

/** A caller-supplied status read, invoked inside the shared queue. */
export type StrataStatusDocumentReader = () => StrataStatusRead;

function isNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
    );
}

/**
 * The status document of one connection, rendered. `db` is the caller's live
 * handle when it has one; without it the process's current database is read.
 */
export function readStrataStatusDocument(
    connection: StrataAskConnection,
    db?: Database,
): StrataStatusRead {
    let raw: string;
    try {
        raw = readFileSync(
            statusChangesPathFor(connection.prefixPath, connection.slotFile),
            "utf8",
        );
    } catch (error) {
        // The steady state: the ledger was consumed, or never written.
        if (isNotFoundError(error)) return { ok: true, text: null };
        log("strata-ask: status ledger unreadable; classic retrieval answers this query", error);
        return { ok: false };
    }
    try {
        const parsed = parseStatusChanges(raw);
        // Each non-empty line must yield exactly one row. The shared tolerant
        // parser may skip malformed or torn lines, which could hide a change.
        const nonEmptyLines = raw.split("\n").filter((line) => line.trim().length > 0).length;
        if (parsed.length !== nonEmptyLines) {
            log("strata-ask: status ledger has invalid rows; classic retrieval answers this query");
            return { ok: false };
        }
        const changes = reduceLedgerRows(parsed, (change) => change);
        if (changes.length === 0) return { ok: true, text: null };
        const ids = [...new Set(changes.map((change) => change.id))];
        const memories = statusMemories(connection, ids, db);
        if (!memories) return { ok: false };
        // A dashboard restore may also edit content without writing this ledger.
        // Neither its timestamp nor a live status proves the slot is current,
        // so every live remove fails closed without rendering a false 讣.
        if (changes.some((change) => change.op === "remove" && memories.has(change.id))) {
            log("strata-ask: status has a live remove; classic retrieval answers this query");
            return { ok: false };
        }
        // A ledger whose rows all void against the current database (vanished
        // adds) carries nothing. A cap breach instead fails the query.
        const renderable = changes.filter(
            (change) => renderStatusRow(change, memories.get(change.id) ?? null) !== null,
        );
        if (renderable.length === 0) return { ok: true, text: null };
        const block = buildStrataStatusBlock(renderable, memories);
        // An over-cap block is never sent truncated: the slot plus a partial
        // status is not authoritative, so the query falls back instead.
        if (!block || block.omitted > 0) {
            log(
                "strata-ask: status document over its token cap; classic retrieval answers this query",
            );
            return { ok: false };
        }
        return { ok: true, text: block.text };
    } catch (error) {
        log("strata-ask: status document unreadable; classic retrieval answers this query", error);
        return { ok: false };
    }
}

function isExactMiss(content: string): boolean {
    let text = content.trim();
    let changed = true;
    while (changed && text.length > 0) {
        changed = false;
        for (const [open, close] of WRAPPERS) {
            if (
                text.startsWith(open) &&
                text.endsWith(close) &&
                text.length > open.length + close.length
            ) {
                text = text.slice(open.length, text.length - close.length).trim();
                changed = true;
            }
        }
    }
    return text === STRATA_ASK_MISS;
}

function fallback(reason: string): StrataAskOutcome {
    const safe =
        /^(?:invalid_endpoint|missing_key|timeout|aborted|invalid_reply|network_error|http_\d{3}|splice_stale|splice_base_seam|splice_render_mismatch|status_unavailable)$/.test(
            reason,
        )
            ? reason
            : "network_error";
    log(`strata-ask fallback: ${safe}`);
    return { status: "failed", reason: safe };
}

const ABORTED = Symbol("strata-ask-aborted");

let queue: Promise<void> = Promise.resolve();

/**
 * Serialize this process's Strata work: queries and the write side share this
 * queue. The caller's wait is abortable: an abort while queued resolves
 * immediately, and the slot, once reached, skips the network. The slot is still
 * held until the previous turn finishes, so this process never overlaps two
 * calls; other processes are kept apart by the server's per-request turn.
 */
export function enqueue<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T | typeof ABORTED> {
    const previous = queue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    queue = gate;
    const execution = previous.then(async () => {
        try {
            if (signal?.aborted) return ABORTED;
            return await work();
        } finally {
            release();
        }
    });
    void execution.catch(() => undefined);
    if (!signal) return execution;
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (value: T | typeof ABORTED) => {
            if (done) return;
            done = true;
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        };
        const onAbort = () => finish(ABORTED);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        execution.then(
            (value) => finish(value),
            (error) => {
                if (done) return;
                done = true;
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

export interface StrataPostFailure {
    ok: false;
    reason: string;
    /** HTTP status of a non-2xx reply; absent for transport and reply-shape failures. */
    status?: number;
    /** `error.type` from the reply body, when the body parsed. */
    errorType?: string;
    /** `error.message` from the reply body, when the body parsed. */
    message?: string;
}

export type StrataPostResult = { ok: true; json: unknown } | StrataPostFailure;

/** Read `{"error": {"type", "message"}}` under the caller's deadline; never fail the call. */
async function readErrorBody(
    response: Response,
    signal: AbortSignal,
): Promise<{ errorType?: string; message?: string }> {
    try {
        const raw = await response.text();
        if (signal.aborted) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const error = (parsed as { error?: unknown }).error;
        if (!error || typeof error !== "object" || Array.isArray(error)) return {};
        const row = error as { type?: unknown; message?: unknown };
        return {
            errorType: typeof row.type === "string" ? row.type : undefined,
            message: typeof row.message === "string" ? row.message : undefined,
        };
    } catch {
        return {};
    }
}

async function postJson(args: {
    url: string;
    body: unknown;
    apiKey: string;
    signal: AbortSignal;
    fetchImpl: typeof fetch;
}): Promise<StrataPostResult> {
    let response: Response;
    try {
        response = await args.fetchImpl(args.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${args.apiKey}`,
            },
            body: JSON.stringify(args.body),
            signal: args.signal,
            redirect: "error",
        });
    } catch {
        if (args.signal.aborted) return { ok: false, reason: "aborted" };
        return { ok: false, reason: "network_error" };
    }
    if (!response.ok) {
        const status = response.status;
        const known = Number.isInteger(status) && status >= 100 && status <= 599;
        // The body is read under the same signal, so a 409/400 cannot outrun
        // timeout_ms. Without `error.type` a splice failure is indistinguishable
        // from any other rejection, which is why this body is not cancelled.
        const detail = await readErrorBody(response, args.signal);
        return {
            ok: false,
            reason: known ? `http_${status}` : "network_error",
            status: known ? status : undefined,
            errorType: detail.errorType,
            message: detail.message,
        };
    }
    try {
        return { ok: true, json: await response.json() };
    } catch {
        return { ok: false, reason: "invalid_reply" };
    }
}

function linkedSignal(
    caller: AbortSignal | undefined,
    timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (caller?.aborted) controller.abort();
    else caller?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup: () => {
            clearTimeout(timer);
            if (onAbort) caller?.removeEventListener("abort", onAbort);
        },
    };
}

/** The `n_restored` reply of a restore call; the query path never restores. */
export function isRestoreSuccess(json: unknown): boolean {
    if (!json || typeof json !== "object" || Array.isArray(json)) return false;
    const restored = (json as { n_restored?: unknown }).n_restored;
    return typeof restored === "number" && Number.isFinite(restored);
}

/** One `timeout_ms` budget per HTTP call, not one budget shared across calls. */
export async function postWithDeadline(args: {
    url: string;
    body: unknown;
    apiKey: string;
    caller: AbortSignal | undefined;
    timeoutMs: number;
    fetchImpl: typeof fetch;
}): Promise<StrataPostResult> {
    const linked = linkedSignal(args.caller, args.timeoutMs);
    try {
        if (linked.signal.aborted) {
            return { ok: false, reason: linked.timedOut() ? "timeout" : "aborted" };
        }
        const result = await postJson({
            url: args.url,
            body: args.body,
            apiKey: args.apiKey,
            signal: linked.signal,
            fetchImpl: args.fetchImpl,
        });
        // Keep the structured failure (status, error.type, message): the splice
        // dispatch depends on it. Only a deadline turns every failure into timeout.
        if (!result.ok) return linked.timedOut() ? { ok: false, reason: "timeout" } : result;
        return result;
    } finally {
        linked.cleanup();
    }
}

interface AskRequest {
    query: string;
    config: StrataAskConnection;
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
    transient?: string;
    allowExternalRefs?: boolean;
    /** Rendered status document; absent when the ledger carries nothing. */
    statusDocument?: string;
    db?: Database;
}

/** `choices[0].message.content` only; `reasoning_content` never reaches the answer. */
function outcomeOf(json: unknown, config: StrataAskConnection, allowExternalRefs: boolean, db?: Database): StrataAskOutcome {
    if (!json || typeof json !== "object") return fallback("invalid_reply");
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return fallback("invalid_reply");
    const message = (choices[0] as { message?: unknown } | null)?.message;
    if (!message || typeof message !== "object") return fallback("invalid_reply");
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string" || content.trim().length === 0)
        return fallback("invalid_reply");
    if (isExactMiss(content)) return { status: "miss" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return fallback("invalid_reply");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback("invalid_reply");
    const reply = parsed as Record<string, unknown>;
    if (
        Object.keys(reply).some((key) => !["answer", "memoryIds", "externalRefs"].includes(key)) ||
        typeof reply.answer !== "string" ||
        /[\r\n\u2028\u2029]/u.test(reply.answer) ||
        !reply.answer.trim() ||
        /(?:第[一二三四五六七八九十百零两0-9０-９]+条记忆|记忆摘要|记忆列表|记忆依据|依据记忆)\s*[:：]/u.test(reply.answer) ||
        /[#＃]\s*[0-9０-９]+/u.test(reply.answer) ||
        /<\s*\/?\s*(?:table|tr|th|td)(?=[\s/>])/iu.test(reply.answer) ||
        /(?:^|\n)\s*\|[^\n]*\|/u.test(reply.answer) ||
        /(?:^|\n)[^\n]*\|[^\n]*\n\s*\|?\s*:?-{3,}/u.test(reply.answer) ||
        !Array.isArray(reply.memoryIds) ||
        !reply.memoryIds.every((id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
        ("externalRefs" in reply && (!allowExternalRefs || !Array.isArray(reply.externalRefs) ||
            !reply.externalRefs.every((ref: unknown) => typeof ref === "string")))
    ) return fallback("invalid_reply");
    const ids = [...new Set(reply.memoryIds as number[])];
    if (reply.answer.trim() === STRATA_ASK_MISS && reply.answer !== STRATA_ASK_MISS) return fallback("invalid_reply");
    if (reply.answer === STRATA_ASK_MISS) {
        return ids.length === 0 && (!Array.isArray(reply.externalRefs) || reply.externalRefs.length === 0)
            ? { status: "miss" }
            : fallback("invalid_reply");
    }
    const memories = statusMemories(config, ids, db, true);
    if (!memories) return fallback("invalid_reply");
    const rows = ids.flatMap((id) => {
        const memory = memories.get(id);
        if (!memory) return [];
        const chars = Array.from(memory.content.replace(/\s+/gu, " ").trim());
        const excerpt = (chars.slice(0, 80).join("") + (chars.length > 80 ? "…" : ""))
            .replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
        return [`| #${id} | ${excerpt} |`];
    });
    const evidence = rows.length
        ? `| 记忆编号 | 记忆缩略 |\n| --- | --- |\n${rows.join("\n")}`
        : "无可核验的记忆依据";
    return { status: "answered", text: `答案：\n${reply.answer.trim()}\n\n依据记忆：\n${evidence}\n${STRATA_ASK_FOOTER}` };
}

/**
 * A failure that means the sidecar cannot serve this splice, and so needs a
 * rebuild marker. Dispatch is on `error.type` (and, for the 400, on the message
 * prefix the server documents): a 409 is not automatically a splice problem —
 * `model_busy` is a plain failure and marks nothing.
 */
function spliceFailureOf(result: StrataPostFailure): string | null {
    if (
        result.status === 409 &&
        (result.errorType === "splice_stale" || result.errorType === "splice_base_seam")
    ) {
        return result.errorType;
    }
    if (result.status === 400 && result.message?.startsWith("splice_render_mismatch")) {
        return "splice_render_mismatch";
    }
    return null;
}

/** `resume_ok: false` means the base was recomputed, not that the answer is wrong. */
function logSessionObservations(json: unknown): void {
    const splice = sessionBlockOf(json)?.splice;
    if (splice?.resume_ok === false) {
        log(
            "strata-ask: splice resume missed; the base was recomputed this turn (answer unaffected)",
        );
    }
}

async function askOnce(args: AskRequest): Promise<StrataAskOutcome> {
    if (args.signal?.aborted) return fallback("aborted");
    const apiKey =
        safeBearer(args.config.apiKey) ??
        safeBearer(nonEmpty(process.env[args.config.apiKeyEnv ?? ""]));
    if (!apiKey) return fallback("missing_key");
    if (!/^https?:\/\//.test(args.config.baseUrl)) return fallback("invalid_endpoint");

    const chat = await postWithDeadline({
        url: `${args.config.baseUrl}/v1/chat/completions`,
        body: {
            model: args.config.model,
            // Splice carries only the new turn: no system role, no replayed prefix.
            messages: [
                {
                    role: "user",
                    content: renderQueryMessage(args.query, args.transient, args.statusDocument),
                },
            ],
            max_tokens: args.config.maxTokens,
            stream: false,
            strata_session: { restore: args.config.slotFile, splice: true },
            ...strataNoThinking(),
        },
        apiKey,
        caller: args.signal,
        timeoutMs: args.config.timeoutMs,
        fetchImpl: args.fetchImpl,
    });
    if (!chat.ok) {
        // A splice the sidecar cannot serve leaves a marker for the write side to
        // rebuild — a query must never save — and then fails like any other
        // request, so classic retrieval answers this query.
        const splice = spliceFailureOf(chat);
        if (splice) markSidecarStale(args.config.prefixPath, splice);
        // The structured failure would otherwise be lost: record its type and
        // message (never the key and never the request or reply body).
        log("strata-ask: composite request failed; classic retrieval answers this query", {
            reason: chat.reason,
            errorType: chat.errorType ?? null,
            message: chat.message ?? null,
        });
        return fallback(chat.reason);
    }
    logSessionObservations(chat.json);
    return outcomeOf(chat.json, args.config, args.allowExternalRefs ?? Boolean(args.transient), args.db);
}

export function hasUnsafeStrataCache(prefixPath: string): boolean {
    // Invalid or unreadable stale markers also mean the cache is unsafe.
    if (readSidecarStale(prefixPath)) return true;
    try {
        statSync(`${prefixPath}.pending-write.json`);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
}

export async function tryStrataAskDetailed(args: {
    query: string;
    config: StrataAskConnection;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    transient?: string;
    allowExternalRefs?: boolean;
    db?: Database;
    /**
     * How to obtain the rendered status document. A string is sent as-is; null
     * sends the turn without one; a reader is invoked inside the shared queue,
     * as close to the splice request as possible, so a consolidation queued
     * ahead of this query writes the slot before the status freezes. Omitted
     * reads the ledger for this connection (the default for every caller), also
     * inside the queue. An unreadable or over-cap status fails the query to
     * classic retrieval, like any other cache failure.
     */
    statusDocument?: string | null | StrataStatusDocumentReader;
}): Promise<StrataAskOutcome> {
    const query = args.query.trim();
    if (!query) return fallback("invalid_reply");
    if (args.signal?.aborted) return fallback("aborted");
    try {
        const result = await enqueue(async () => {
            // An unfinished save or stale sidecar cannot stand in for memories.
            if (hasUnsafeStrataCache(args.config.prefixPath)) return fallback("status_unavailable");
            // The status document is read here, inside the queue, immediately
            // before the request: the read must observe every consolidation
            // queued ahead of this query, or the query would answer the slot
            // from a stale status and could overwrite the fresher content. An
            // incomplete status is never sent truncated — it fails the query
            // to classic retrieval instead.
            let statusDocument: string | undefined;
            if (typeof args.statusDocument === "function") {
                const read = args.statusDocument();
                if (!read.ok) return fallback("status_unavailable");
                statusDocument = read.text ?? undefined;
            } else if (args.statusDocument === undefined) {
                const read = readStrataStatusDocument(args.config);
                if (!read.ok) return fallback("status_unavailable");
                statusDocument = read.text ?? undefined;
            } else {
                statusDocument = args.statusDocument ?? undefined;
            }
            return askOnce({
                query,
                transient: args.transient,
                allowExternalRefs: args.allowExternalRefs,
                statusDocument,
                config: args.config,
                db: args.db,
                signal: args.signal,
                fetchImpl: args.fetchImpl ?? fetch,
            });
        }, args.signal);
        if (result === ABORTED) return fallback("aborted");
        return result;
    } catch {
        return fallback("network_error");
    }
}

export async function tryStrataAsk(args: {
    query: string;
    config: StrataAskConnection;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    statusDocument?: string | null | StrataStatusDocumentReader;
}): Promise<string | null> {
    const outcome = await tryStrataAskDetailed(args);
    return outcome.status === "answered" ? outcome.text : null;
}
