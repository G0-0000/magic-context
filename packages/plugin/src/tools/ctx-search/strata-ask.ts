/**
 * Bare ctx_search → Strata session-file cache.
 *
 * The two HTTP calls (slot restore, then chat) are serialized by an in-process
 * promise queue so one ctx_search cannot restore over another's in-flight
 * completion. That mutex does not span processes: another client, or another
 * Magic Context process, can still clobber slot 0 between restore and chat.
 * This prototype accepts that race. A restore success is not a cache-hit proof.
 *
 * `memory.strata_ask.*` is intentionally absent from LIVE_RELOAD_CONFIG_PATHS.
 * That list is for historian and dreamer sampling. ctx_search does not use it:
 * OpenCode calls `resolveOpenCodeStrataAsk` and Pi calls `resolvePiStrataAsk`
 * on every search, for the call directory, with runtime globals left untouched.
 * A resolution failure (including `{env:}` / `{file:}` substitution failure), an
 * incomplete connection, or a project identity that is missing or not equal to
 * a configured project target is disabled: this module returns null and the
 * caller continues on the classic path. Identity is resolved before any network
 * call. `timeout_ms` bounds the prefix read and each HTTP call separately.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import PROMPTS from "./strata-prompts.json";
import { loadPluginConfigDetailed } from "../../config";
import { parseIdShapedQuery } from "../../features/magic-context/search";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { log } from "../../shared/logger";

/** Query template; copy lives in strata-prompts.json (edit there, rebuild dists). */
export const STRATA_ASK_T4 = PROMPTS.t4;

export const STRATA_ASK_MISS = "记忆库中无";
export const DEFAULT_TRANSIENT_BUDGET_TOKENS = 2000;
export const DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS = 4000;

export type StrataAskOutcome =
    | { status: "answered"; text: string }
    | { status: "miss" }
    | { status: "failed"; reason: string };

export const STRATA_ASK_FOOTER =
    "——本答案由项目记忆缓存合成，可能融合期外材料摘要；记忆原文可按 #id 用 ctx_memory get，其余确切原文请用 ctx_expand 或显式 sources 参数";

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
            targets?: Array<{ project: string; slot_file: string; prefix_path: string; context_docs?: string[] }>;
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

/** Known business params only. Host metadata keys do not affect the verdict. */
export function strataRouteFor(normalizedArgs: object): "fusion" | "memory-only" | null {
    const args = normalizedArgs as Record<string, unknown>;
    if ("limit" in args || "from" in args || "to" in args) return null;
    if (typeof args.query !== "string") return null;
    const query = args.query.trim();
    if (!query || parseIdShapedQuery(query) !== null) return null;
    if (!("sources" in args)) return "fusion";
    if (Array.isArray(args.sources)) {
        const sources = new Set(args.sources);
        if (sources.size === 1 && sources.has("memory")) return "memory-only";
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
    if (!raw || raw.enabled !== true) return null;
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
        transientBudgetTokens: typeof raw.transient_budget_tokens === "number" &&
            Number.isFinite(raw.transient_budget_tokens) && raw.transient_budget_tokens >= 1 &&
            raw.transient_budget_tokens <= 8192
            ? raw.transient_budget_tokens : DEFAULT_TRANSIENT_BUDGET_TOKENS,
        contextDocs: Array.isArray(raw.context_docs)
            ? raw.context_docs.filter((path) => typeof path === "string" && path.length > 0)
            : [],
        contextDocsBudgetTokens: typeof contextDocsBudgetTokens === "number" &&
            Number.isInteger(contextDocsBudgetTokens) && contextDocsBudgetTokens >= 1 && contextDocsBudgetTokens <= 32768
            ? contextDocsBudgetTokens : DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS,
    };
}

/** Select the first matching user-level target; shared connection settings remain unchanged. */
export function strataAskConnectionForProject(
    config: StrataAskConfigSource,
    projectIdentity: string | null | undefined,
): StrataAskConnection | null {
    const raw = config.memory?.strata_ask;
    if (!raw || raw.enabled !== true || !projectIdentity) return null;
    if (nonEmpty(raw.project) === projectIdentity) return strataAskConnectionFromConfig(config);
    const target = raw.targets?.find((entry) => nonEmpty(entry.project) === projectIdentity);
    if (!target) return null;
    return strataAskConnectionFromConfig({
        memory: { strata_ask: {
            ...raw,
            project: target.project,
            slot_file: target.slot_file,
            prefix_path: target.prefix_path,
            context_docs: target.context_docs ?? [],
        } },
    });
}

/** Trust-filtered effective config for the call directory. Failure ⇒ disabled. */
export function resolveOpenCodeStrataAsk(directory: string): StrataAskConnection | null {
    if (!directory) return null;
    try {
        const loaded = loadPluginConfigDetailed(directory, false);
        if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
        const project = resolveProjectIdentityForSession(directory, loaded.config.allow_home_project);
        return strataAskConnectionForProject(loaded.config, project);
    } catch {
        log("strata-ask disabled: resolution_failure");
        return null;
    }
}

function renderT4(query: string): string {
    const token = "{q}";
    const at = STRATA_ASK_T4.indexOf(token);
    return STRATA_ASK_T4.slice(0, at) + query + STRATA_ASK_T4.slice(at + token.length);
}

function renderQueryMessage(query: string, transient?: string): string {
    if (!transient) return renderT4(query);
    return PROMPTS.t4Fused.replace(/\{materials\}|\{q\}/g, (token) =>
        token === "{materials}" ? transient : query,
    );
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
    const safe = /^(?:file_error|invalid_prefix|invalid_endpoint|missing_key|timeout|aborted|invalid_reply|network_error|http_\d{3})$/.test(
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
 * Serialize restore/chat. The caller's wait is abortable: an abort while queued
 * resolves immediately, and the slot, once reached, skips the network. The slot
 * is still held until the previous turn finishes, so a later caller cannot
 * restore over an in-flight completion.
 */
export function enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
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

async function readPrefix(
    path: string,
    readFileImpl: (path: string) => Promise<string> | string,
    signal: AbortSignal,
): Promise<Array<Record<string, unknown>> | null> {
    let raw: string;
    try {
        raw = await new Promise<string>((resolve, reject) => {
            const fail = (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            };
            const onAbort = () => fail(new Error("aborted"));
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            Promise.resolve()
                .then(() => readFileImpl(path))
                .then(
                    (value) => {
                        signal.removeEventListener("abort", onAbort);
                        resolve(value);
                    },
                    fail,
                );
        });
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const messages: Array<Record<string, unknown>> = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const row = item as Record<string, unknown>;
        if (typeof row.role !== "string" || typeof row.content !== "string") return null;
        messages.push(row);
    }
    return messages;
}

async function postJson(args: {
    url: string;
    body: unknown;
    apiKey: string;
    signal: AbortSignal;
    fetchImpl: typeof fetch;
}): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
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
        await response.body?.cancel().catch(() => undefined);
        const status = response.status;
        return {
            ok: false,
            reason: Number.isInteger(status) && status >= 100 && status <= 599 ? `http_${status}` : "network_error",
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

export function isRestoreSuccess(json: unknown): boolean {
    if (!json || typeof json !== "object" || Array.isArray(json)) return false;
    const restored = (json as { n_restored?: unknown }).n_restored;
    return typeof restored === "number" && Number.isFinite(restored);
}

/** One `timeout_ms` budget per HTTP call, not one budget shared across both. */
export async function postWithDeadline(args: {
    url: string;
    body: unknown;
    apiKey: string;
    caller: AbortSignal | undefined;
    timeoutMs: number;
    fetchImpl: typeof fetch;
}): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
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
        if (!result.ok) return { ok: false, reason: linked.timedOut() ? "timeout" : result.reason };
        return result;
    } finally {
        linked.cleanup();
    }
}

async function askOnce(args: {
    query: string;
    config: StrataAskConnection;
    signal?: AbortSignal;
    fetchImpl: typeof fetch;
    readFileImpl: (path: string) => Promise<string> | string;
    transient?: string;
}): Promise<StrataAskOutcome> {
    if (args.signal?.aborted) return fallback("aborted");
    const apiKey = safeBearer(args.config.apiKey) ?? safeBearer(nonEmpty(process.env[args.config.apiKeyEnv ?? ""]));
    if (!apiKey) return fallback("missing_key");
    if (!/^https?:\/\//.test(args.config.baseUrl)) return fallback("invalid_endpoint");

    const prefixLinked = linkedSignal(args.signal, args.config.timeoutMs);
    let prefix: Array<Record<string, unknown>> | null;
    try {
        if (prefixLinked.signal.aborted) {
            return fallback(prefixLinked.timedOut() ? "timeout" : "aborted");
        }
        prefix = await readPrefix(args.config.prefixPath, args.readFileImpl, prefixLinked.signal);
    } finally {
        prefixLinked.cleanup();
    }
    if (!prefix) {
        return fallback(
            prefixLinked.timedOut() ? "timeout" : args.signal?.aborted ? "aborted" : "file_error",
        );
    }

    const restored = await postWithDeadline({
        url: `${args.config.baseUrl}/slots/0?action=restore`,
        body: { filename: args.config.slotFile },
        apiKey,
        caller: args.signal,
        timeoutMs: args.config.timeoutMs,
        fetchImpl: args.fetchImpl,
    });
    if (!restored.ok) return fallback(restored.reason);
    if (!isRestoreSuccess(restored.json)) return fallback("invalid_reply");

    const chat = await postWithDeadline({
        url: `${args.config.baseUrl}/v1/chat/completions`,
        body: {
            model: args.config.model,
            messages: [...prefix, { role: "user", content: renderQueryMessage(args.query, args.transient) }],
            max_tokens: args.config.maxTokens,
            stream: false,
        },
        apiKey,
        caller: args.signal,
        timeoutMs: args.config.timeoutMs,
        fetchImpl: args.fetchImpl,
    });
    if (!chat.ok) return fallback(chat.reason);
    const body = chat.json;
    if (!body || typeof body !== "object") return fallback("invalid_reply");
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return fallback("invalid_reply");
    const message = (choices[0] as { message?: unknown } | null)?.message;
    if (!message || typeof message !== "object") return fallback("invalid_reply");
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string" || content.trim().length === 0) return fallback("invalid_reply");
    if (isExactMiss(content)) return { status: "miss" };
    return { status: "answered", text: `${content.trimEnd()}\n${STRATA_ASK_FOOTER}` };
}

export async function tryStrataAskDetailed(args: {
    query: string;
    config: StrataAskConnection;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    readFileImpl?: (path: string) => Promise<string> | string;
    transient?: string;
}): Promise<StrataAskOutcome> {
    const query = args.query.trim();
    if (!query) return fallback("invalid_reply");
    if (args.signal?.aborted) return fallback("aborted");
    try {
        const result = await enqueue(
            () =>
                askOnce({
                    query,
                    transient: args.transient,
                    config: args.config,
                    signal: args.signal,
                    fetchImpl: args.fetchImpl ?? fetch,
                    readFileImpl: args.readFileImpl ?? ((path) => readFile(path, "utf8")),
                }),
            args.signal,
        );
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
    readFileImpl?: (path: string) => Promise<string> | string;
}): Promise<string | null> {
    const outcome = await tryStrataAskDetailed(args);
    return outcome.status === "answered" ? outcome.text : null;
}
