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
 * `memory.strata_ask.project` is disabled: this module returns null and the
 * caller continues on the classic path. Identity is resolved before any network
 * call. `timeout_ms` bounds the prefix read and each HTTP call separately.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { parseIdShapedQuery } from "../../features/magic-context/search";
import { log } from "../../shared/logger";

/** Verbatim T4 template from the strata session-file cache jig (`mc_slot_test.py`). */
export const STRATA_ASK_T4 =
    "问题：{q}\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 记忆库无相关信息，则只答「记忆库中无」。";

export const STRATA_ASK_MISS = "记忆库中无";

export const STRATA_ASK_FOOTER =
    "——本答案由项目记忆缓存合成；若 ctx_memory 可用，按 #id 可以 ctx_memory get 取原文；欲检索历史/提交/便签请用 sources 参数";

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
            max_tokens?: number;
            timeout_ms?: number;
        };
    };
}

export function isStrataConfigResolutionFailure(outcome: string): boolean {
    return RESOLUTION_FAILURES.has(outcome);
}

/** Known business params only. Host metadata keys do not affect the verdict. */
export function isStrataAskEligible(normalizedArgs: object): boolean {
    const args = normalizedArgs as Record<string, unknown>;
    if ("limit" in args || "sources" in args || "from" in args || "to" in args) return false;
    if (typeof args.query !== "string") return false;
    const query = args.query.trim();
    if (!query) return false;
    return parseIdShapedQuery(query) === null;
}

function nonEmpty(value: string | null | undefined): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function safeBearer(value: string | null): string | null {
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
    };
}

/** Trust-filtered effective config for the call directory. Failure ⇒ disabled. */
export function resolveOpenCodeStrataAsk(directory: string): StrataAskConnection | null {
    if (!directory) return null;
    try {
        const loaded = loadPluginConfigDetailed(directory, false);
        if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
        return strataAskConnectionFromConfig(loaded.config);
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

function fallback(reason: string): null {
    const safe = /^(?:file_error|invalid_prefix|invalid_endpoint|missing_key|timeout|aborted|invalid_reply|network_error|http_\d{3})$/.test(
        reason,
    )
        ? reason
        : "network_error";
    log(`strata-ask fallback: ${safe}`);
    return null;
}

const ABORTED = Symbol("strata-ask-aborted");

let queue: Promise<void> = Promise.resolve();

/**
 * Serialize restore/chat. The caller's wait is abortable: an abort while queued
 * resolves immediately, and the slot, once reached, skips the network. The slot
 * is still held until the previous turn finishes, so a later caller cannot
 * restore over an in-flight completion.
 */
function enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
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

function isRestoreSuccess(json: unknown): boolean {
    if (!json || typeof json !== "object" || Array.isArray(json)) return false;
    const restored = (json as { n_restored?: unknown }).n_restored;
    return typeof restored === "number" && Number.isFinite(restored);
}

/** One `timeout_ms` budget per HTTP call, not one budget shared across both. */
async function postWithDeadline(args: {
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
}): Promise<string | null> {
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
            messages: [...prefix, { role: "user", content: renderT4(args.query) }],
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
    if (isExactMiss(content)) return null;
    return `${content.trimEnd()}\n${STRATA_ASK_FOOTER}`;
}

export async function tryStrataAsk(args: {
    query: string;
    config: StrataAskConnection;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    readFileImpl?: (path: string) => Promise<string> | string;
}): Promise<string | null> {
    const query = args.query.trim();
    if (!query) return null;
    if (args.signal?.aborted) return fallback("aborted");
    try {
        const result = await enqueue(
            () =>
                askOnce({
                    query,
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
