import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { getAllActiveMemoriesForMigration } from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import { isDatabasePersisted, openCurrentDatabase } from "../../features/magic-context/storage-db";
import { getMaxMemoryMutationId } from "../../features/magic-context/storage-memory-mutation-log";
import { renderMemoryBlockV2 } from "../../hooks/magic-context/inject-compartments";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import PROMPTS from "./strata-prompts.json";
import {
    enqueue,
    isRestoreSuccess,
    isStrataConfigResolutionFailure,
    nonEmpty,
    postWithDeadline,
    safeBearer,
    strataAskConnectionForProject,
    type StrataAskConnection,
} from "./strata-ask";

export interface CacheWatermark {
    count: number;
    maxMemoryId: number;
    maxMutationId: number;
    rebuiltAt: string;
}

export type CacheAction = "created" | "rebuilt" | "appended" | "skipped" | "disabled" | "error";

export interface CacheActionResult {
    action: CacheAction;
    detail: string;
    watermark?: CacheWatermark;
}

export type MemoryChangeEvent =
    | { op: "add"; memoryId: number }
    | { op: "update"; memoryId: number }
    | { op: "remove"; memoryId: number; kind: "archive" | "delete" | "superseded" };

type StoredChange =
    | { op: "add" | "update"; id: number; ts: string }
    | { op: "remove"; id: number; kind: "archive" | "delete" | "superseded"; ts: string };

type Message = { role: "system" | "user" | "assistant"; content: string };

interface CacheContext {
    projectRoot: string;
    connection: StrataAskConnection;
    project: string;
    apiKey: string;
    budget: number;
}

interface MemorySnapshot {
    memories: Memory[];
    maxMutationId: number;
}

// Prompt copy lives in strata-prompts.json (edit there, then rebuild dists).
// Machine contracts tied to parsing regexes (watermark/change-log line shapes,
// COUNT_QUESTION) stay here in code.
const SYSTEM_MESSAGE = PROMPTS.system;
const INTRO = PROMPTS.intro;
const ACK_REQUEST = PROMPTS.ackRequest;
const CHANGE_LOG = "【变更流水】";
const DOCS_HEADER = "【项目参考文档】";
const DOCS_NOTICE = "本节为本项目参考文档，属记忆库之组成部分；非记忆条目，不计入记忆库条数。";
const DOCS_FOOTER = "【参考文档终】";
const DOCS_EMPTY_BUDGET_NOTE = "（未载：预算已用尽）";
const COUNT_QUESTION = "记忆库正文条目及变更流水中现行有效之条目（含新增、不含已作废者）共多少条？参考文档一节不计入。只回复阿拉伯数字，不要其他文字。";
const DEBOUNCE_MS = 60_000;
const FALLBACK_MS = 5 * 60_000;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const scheduledProjects = new Set<string>();
let fallbackTimer: ReturnType<typeof setInterval> | undefined;

function resolveContext(projectRoot: string): CacheContext | null {
    if (!projectRoot) return null;
    try {
        const loaded = loadPluginConfigDetailed(projectRoot, false);
        if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
        const project = resolveProjectIdentityForSession(projectRoot, loaded.config.allow_home_project);
        if (!project) return null;
        const connection = strataAskConnectionForProject(loaded.config, project);
        if (!connection) return null;
        const apiKey = safeBearer(connection.apiKey) ?? safeBearer(nonEmpty(process.env[connection.apiKeyEnv ?? ""]));
        if (!apiKey) return null;
        return { projectRoot, connection, project, apiKey, budget: loaded.config.memory.injection_budget_tokens };
    } catch {
        log("strata-cache disabled: resolution_failure");
        return null;
    }
}

export interface RenderedDocs {
    section: string;
    files: string[];
    truncated: boolean[];
}

/** Read only at rebuild time; the token budget covers the complete rendered section. */
export function renderDocsSection(projectRoot: string, docs: readonly string[], budget: number): RenderedDocs | null {
    const entries: Array<{ path: string; name: string; text: string }> = [];
    for (const path of docs) {
        const resolved = path.startsWith("~/")
            ? join(homedir(), path.slice(2))
            : isAbsolute(path) ? path : join(projectRoot, path);
        try {
            if (!statSync(resolved).isFile()) throw new Error("not a regular file");
            entries.push({ path, name: basename(resolved), text: readFileSync(resolved, "utf8") });
        } catch (error) {
            log(`strata-cache docs: skip ${resolved}`, error);
        }
    }
    if (entries.length === 0) return null;

    const limit = Number.isFinite(budget) ? Math.floor(budget) : 0;
    const sectionOf = (blocks: string[]) => [
        `${DOCS_HEADER}\n${DOCS_NOTICE}`,
        ...blocks,
        DOCS_FOOTER,
    ].join("\n\n");
    const fits = (blocks: string[]) => estimateTokens(sectionOf(blocks)) <= limit;
    const fullBlock = (entry: (typeof entries)[number]) => `〔${entry.name}〕\n${entry.text}`;
    const omitted = (remaining: typeof entries) => remaining.map((entry) => `〔${entry.name}${DOCS_EMPTY_BUDGET_NOTE}〕`);
    const allBlocks = entries.map(fullBlock);
    if (fits(allBlocks)) {
        return { section: sectionOf(allBlocks), files: entries.map((entry) => entry.path), truncated: entries.map(() => false) };
    }
    if (!fits([DOCS_EMPTY_BUDGET_NOTE])) {
        log("context-docs budget too small, skipped");
        return null;
    }

    const blocks: string[] = [];
    const files: string[] = [];
    const truncated: boolean[] = [];
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        const remaining = entries.slice(index + 1);
        const namedNotes = omitted(remaining);
        const full = fullBlock(entry);
        // Reserve at least one omission note until all remaining files are loaded.
        const reserve = remaining.length ? [DOCS_EMPTY_BUDGET_NOTE] : [];
        if (fits([...blocks, full, ...reserve])) {
            blocks.push(full);
            files.push(entry.path);
            truncated.push(false);
            continue;
        }

        const truncatedBlock = (length: number) =>
            `〔${entry.name}（已截断：原文 ${entry.text.length} 字符，载入 ${length} 字符）〕\n${entry.text.slice(0, length)}`;
        let notes = namedNotes;
        if (remaining.length && !fits([...blocks, truncatedBlock(0), ...notes])) notes = reserve;
        if (!fits([...blocks, truncatedBlock(0), ...notes])) {
            // The label itself does not fit: one note covers this file and all remaining files.
            const allNotes = omitted(entries.slice(index));
            blocks.push(...(fits([...blocks, ...allNotes]) ? allNotes : [DOCS_EMPTY_BUDGET_NOTE]));
            break;
        }

        const boundaries = [0];
        for (let at = entry.text.indexOf("\n"); at >= 0; at = entry.text.indexOf("\n", at + 1)) {
            if (at + 1 < entry.text.length) boundaries.push(at + 1);
        }
        let low = 0;
        let high = boundaries.length - 1;
        let length = 0;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = boundaries[middle]!;
            if (fits([...blocks, truncatedBlock(candidate), ...notes])) {
                length = candidate;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        blocks.push(truncatedBlock(length), ...notes);
        files.push(entry.path);
        truncated.push(true);
        break;
    }
    if (!fits(blocks)) {
        log("context-docs budget too small, skipped");
        return null;
    }
    return { section: sectionOf(blocks), files, truncated };
}

export function docsSectionOf(userContent: string): string | null {
    const recognizedStart = userContent.indexOf(`${DOCS_HEADER}\n${DOCS_NOTICE}`);
    const start = recognizedStart >= 0 ? recognizedStart : userContent.indexOf(DOCS_HEADER);
    if (start < 0) return null;
    // A reference file may itself mention the footer. Prefer the footer attached
    // to the real acknowledgement; a standalone section has no acknowledgement.
    const anchoredFooter = userContent.indexOf(`\n\n${DOCS_FOOTER}\n\n${ACK_REQUEST}`);
    const end = anchoredFooter >= start
        ? anchoredFooter + 2
        : userContent.lastIndexOf(DOCS_FOOTER);
    if (end < start + DOCS_HEADER.length) return null;
    return userContent.slice(start, end + DOCS_FOOTER.length);
}

export function composeSlotUser(
    intro: string,
    blocks: string,
    docsSection: string | null,
    ackRequest: string,
    watermark: string,
): string {
    return [intro, blocks, docsSection, ackRequest, watermark].filter(Boolean).join("\n\n");
}

function failure(error: unknown): CacheActionResult {
    const detail = error instanceof Error ? error.message : String(error);
    log(`strata-cache error: ${detail}`);
    return { action: "error", detail };
}

function pendingPath(connection: StrataAskConnection): string {
    return join(dirname(connection.prefixPath), "pending-changes.jsonl");
}

function readPending(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
}

function atomicWrite(path: string, content: string): void {
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
    } finally {
        try {
            unlinkSync(temporary);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}

// No await in this loop: local registrations cannot interleave. The optimistic
// re-read incorporates other processes' appends except in the final stat/rename
// window; there is deliberately no cross-process lock.
function consumePending(path: string, consumed: string): void {
    if (!consumed) return;
    for (let attempt = 0; attempt < 10; attempt++) {
        const current = readPending(path);
        if (!current.startsWith(consumed)) {
            throw new Error("pending-changes file changed during consumption");
        }
        const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            writeFileSync(temporary, current.slice(consumed.length), {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            });
            const before = statSync(path);
            const latest = readPending(path);
            const after = statSync(path);
            if (
                latest !== current ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs
            ) continue;
            renameSync(temporary, path);
            return;
        } finally {
            try {
                unlinkSync(temporary);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
    }
    throw new Error("pending-changes file remained busy during consumption");
}

function parseChanges(raw: string): StoredChange[] {
    if (!raw.endsWith("\n")) throw new Error("pending-changes contains an incomplete line");
    return raw.slice(0, -1).split("\n").map((line) => {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error("pending-changes contains invalid JSON");
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("pending-changes contains an invalid event");
        }
        const event = value as Record<string, unknown>;
        if (
            !Number.isSafeInteger(event.id) ||
            (event.id as number) < 1 ||
            typeof event.ts !== "string" ||
            !Number.isFinite(Date.parse(event.ts))
        ) {
            throw new Error("pending-changes contains an invalid event");
        }
        const id = event.id as number;
        const ts = new Date(event.ts).toISOString();
        if (event.op === "add" || event.op === "update") return { op: event.op, id, ts };
        if (
            event.op === "remove" &&
            (event.kind === "archive" || event.kind === "delete" || event.kind === "superseded")
        ) {
            return { op: "remove", id, kind: event.kind, ts };
        }
        throw new Error("pending-changes contains an invalid event");
    });
}

function readPrefix(connection: StrataAskConnection): Message[] | null {
    let raw: string;
    try {
        raw = readFileSync(connection.prefixPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error("invalid prefix JSON");
    }
    if (!Array.isArray(value) || value.length !== 3) throw new Error("invalid prefix messages");
    const roles = ["system", "user", "assistant"] as const;
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || item.role !== roles[index] || typeof item.content !== "string") {
            throw new Error("invalid prefix messages");
        }
        return { role: roles[index]!, content: item.content as string };
    });
}

function watermarkLine(watermark: CacheWatermark): string {
    return `本库共 ${watermark.count} 条，截至 #${watermark.maxMemoryId}，重建于 ${watermark.rebuiltAt}，变更水位 #${watermark.maxMutationId}`;
}

function parseWatermark(content: string): CacheWatermark | null {
    const line = content.slice(content.lastIndexOf("\n") + 1);
    const match = /^本库共 (\d+) 条，截至 #(\d+)，重建于 (\S+)，变更水位 #(\d+)$/.exec(line);
    if (!match) return null;
    const count = Number(match[1]);
    const maxMemoryId = Number(match[2]);
    const rebuiltAt = match[3]!;
    const maxMutationId = Number(match[4]);
    if (
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(maxMemoryId) ||
        !Number.isSafeInteger(maxMutationId) ||
        !Number.isFinite(Date.parse(rebuiltAt))
    ) return null;
    return { count, maxMemoryId, maxMutationId, rebuiltAt };
}

export function readCacheWatermark(cfg: StrataAskConnection): CacheWatermark | null {
    try {
        const prefix = readPrefix(cfg);
        return prefix ? parseWatermark(prefix[1]!.content) : null;
    } catch (error) {
        failure(error);
        return null;
    }
}

function openMemoryDatabase(): Database {
    const db = openCurrentDatabase();
    if (!db || !isDatabasePersisted(db)) throw new Error("persistent memory database unavailable");
    return db;
}

function readMemorySnapshot(project: string): MemorySnapshot {
    const db = openMemoryDatabase();
    return db.transaction(() => ({
        memories: getAllActiveMemoriesForMigration(db, project).sort((a, b) => a.id - b.id),
        maxMutationId: getMaxMemoryMutationId(db, project) ?? 0,
    }))();
}

function renderMemory(memory: Memory): string {
    return `#${memory.id} [${memory.category}] 〔${new Date(memory.updatedAt).toISOString()}〕：\n${memory.content}`;
}

function watermarkFor(snapshot: MemorySnapshot, rebuiltAt: string): CacheWatermark {
    return {
        count: snapshot.memories.length,
        maxMemoryId: snapshot.memories.at(-1)?.id ?? 0,
        maxMutationId: snapshot.maxMutationId,
        rebuiltAt,
    };
}

function renderChanges(
    changes: StoredChange[],
    snapshot: MemorySnapshot,
    previousContent: string,
    previousWatermark: CacheWatermark,
): { lines: string[]; watermark: CacheWatermark } {
    const memories = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
    const visibleIds = new Set<number>();
    const entries = /^#(\d+) \[[^\]\n]+\] 〔[^\n]+〕：$|^〔[^\n]+〕讣：#(\d+) 已删除\/已归档，上文同号条目作废$/gm;
    const section = docsSectionOf(previousContent);
    const docs = section?.startsWith(`${DOCS_HEADER}\n${DOCS_NOTICE}`) ? section : null;
    const docsStart = docs ? previousContent.indexOf(docs) : -1;
    // Keep later change-log entries in the ledger while excluding document text.
    const ledger = docs && docsStart >= 0
        ? previousContent.slice(0, docsStart) + previousContent.slice(docsStart + docs.length)
        : previousContent;
    for (const match of ledger.matchAll(entries)) {
        if (match[1]) visibleIds.add(Number(match[1]));
        else visibleIds.delete(Number(match[2]));
    }
    const watermark = { ...previousWatermark };
    const lines: string[] = [];
    for (const change of changes) {
        const memory = memories.get(change.id);
        if (change.op === "add") {
            if (memory) {
                lines.push(`〔${change.ts}〕增：\n${renderMemory(memory)}`);
                watermark.maxMemoryId = Math.max(watermark.maxMemoryId, memory.id);
                if (!visibleIds.has(memory.id)) {
                    visibleIds.add(memory.id);
                    watermark.count++;
                }
            }
        } else if (change.op === "update" && memory) {
            lines.push(`〔${change.ts}〕正：#${change.id} 已修改为：「${memory.content}」，上文旧文作废`);
        } else {
            lines.push(`〔${change.ts}〕讣：#${change.id} 已删除/已归档，上文同号条目作废`);
            if (visibleIds.delete(change.id)) watermark.count--;
        }
    }
    return { lines, watermark };
}

async function post(context: CacheContext, path: string, body: unknown): Promise<unknown> {
    const response = await postWithDeadline({
        url: `${context.connection.baseUrl}${path}`,
        body,
        apiKey: context.apiKey,
        caller: undefined,
        timeoutMs: context.connection.timeoutMs,
        fetchImpl: fetch,
    });
    if (!response.ok) throw new Error(response.reason);
    return response.json;
}

async function restore(context: CacheContext): Promise<void> {
    const result = await post(context, "/slots/0?action=restore", { filename: context.connection.slotFile });
    if (!isRestoreSuccess(result)) throw new Error("invalid restore reply");
}

async function chat(context: CacheContext, messages: Message[]): Promise<string> {
    const result = await post(context, "/v1/chat/completions", {
        model: context.connection.model,
        messages,
        max_tokens: context.connection.maxTokens,
        stream: false,
    });
    if (!result || typeof result !== "object") throw new Error("invalid chat reply");
    const choices = (result as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new Error("invalid chat reply");
    const content = choices[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("invalid chat reply");
    return content;
}

async function save(context: CacheContext): Promise<void> {
    await post(context, "/slots/0?action=save", { filename: context.connection.slotFile });
}

async function selfCheck(context: CacheContext, prefix: Message[], watermark: CacheWatermark): Promise<void> {
    await restore(context);
    const answer = await chat(context, [...prefix, { role: "user", content: COUNT_QUESTION }]);
    if (!/^\s*\d+\s*$/.test(answer) || Number(answer.trim()) !== watermark.count) {
        throw new Error("count self-check failed");
    }
}

async function generateAndSave(context: CacheContext, system: string, user: string): Promise<Message[]> {
    const input: Message[] = [
        { role: "system", content: system },
        { role: "user", content: user },
    ];
    const ack = await chat(context, input);
    const prefix: Message[] = [...input, { role: "assistant", content: ack }];
    await save(context);
    return prefix;
}

async function rebuildLocked(context: CacheContext, reason: string): Promise<CacheActionResult> {
    const path = pendingPath(context.connection);
    // Only events present before the DB snapshot may be consumed; events arriving
    // while the model is running stay in the file for the next drain.
    const pending = readPending(path);
    const snapshot = readMemorySnapshot(context.project);
    const watermark = watermarkFor(snapshot, new Date().toISOString());
    // Rebuild/create always stamp the current templates; an old-format cache's
    // system (no change-log rules) must be replaced, not inherited.
    const system = SYSTEM_MESSAGE;
    const blocks = snapshot.memories.map(renderMemory).join("\n\n");
    const docs = renderDocsSection(context.projectRoot, context.connection.contextDocs, context.connection.contextDocsBudgetTokens);
    const user = composeSlotUser(INTRO, blocks, docs?.section ?? null, ACK_REQUEST, watermarkLine(watermark));
    mkdirSync(dirname(context.connection.prefixPath), { recursive: true, mode: 0o700 });
    const prefix = await generateAndSave(context, system, user);
    try {
        await selfCheck(context, prefix, watermark);
    } catch (error) {
        if (!docs) throw error;
        log("strata-cache docs: count self-check failed; reference docs may interfere, retrying once", error);
        await selfCheck(context, prefix, watermark);
    }
    atomicWrite(context.connection.prefixPath, `${JSON.stringify(prefix, null, 2)}\n`);
    consumePending(path, pending);
    return { action: reason === "create" ? "created" : "rebuilt", detail: reason, watermark };
}

async function drainLocked(context: CacheContext): Promise<CacheActionResult> {
    const path = pendingPath(context.connection);
    const pending = readPending(path);
    if (!pending) return { action: "skipped", detail: "no-pending-changes" };
    const changes = parseChanges(pending);
    const prefix = readPrefix(context.connection);
    if (!prefix) return { action: "skipped", detail: "cache-missing" };
    const previousWatermark = parseWatermark(prefix[1]!.content);
    if (!previousWatermark) throw new Error("cache watermark missing; rebuild required");
    const snapshot = readMemorySnapshot(context.project);
    const { lines, watermark } = renderChanges(changes, snapshot, prefix[1]!.content, previousWatermark);
    if (lines.length === 0) {
        consumePending(path, pending);
        return { action: "skipped", detail: "no-applicable-changes", watermark: previousWatermark };
    }
    const user = prefix[1]!.content;
    const oldLine = watermarkLine(previousWatermark);
    const beforeWatermark = user.slice(0, -oldLine.length);
    const section = docsSectionOf(beforeWatermark);
    const docs = section?.startsWith(`${DOCS_HEADER}\n${DOCS_NOTICE}`) ? section : null;
    const docsEnd = docs ? beforeWatermark.indexOf(docs) + docs.length : 0;
    const ackStart = beforeWatermark.indexOf(ACK_REQUEST, docsEnd);
    const hasChangeLog = beforeWatermark.indexOf(`\n\n${CHANGE_LOG}\n`, ackStart < 0 ? 0 : ackStart + ACK_REQUEST.length) >= 0;
    const separator = hasChangeLog ? "" : `\n${CHANGE_LOG}\n`;
    const updatedUser = `${beforeWatermark}${separator}${lines.join("\n\n")}\n\n${watermarkLine(watermark)}`;
    await restore(context);
    const updatedPrefix = await generateAndSave(context, prefix[0]!.content, updatedUser);
    try {
        await selfCheck(context, updatedPrefix, watermark);
    } catch (error) {
        log("strata-cache append self-check failed; rebuilding", error);
        return rebuildLocked(context, "self-check");
    }
    atomicWrite(context.connection.prefixPath, `${JSON.stringify(updatedPrefix, null, 2)}\n`);
    consumePending(path, pending);
    return { action: "appended", detail: `applied ${lines.length} change(s)`, watermark };
}

async function queued(work: () => Promise<CacheActionResult>): Promise<CacheActionResult> {
    const result = await enqueue(work);
    if (typeof result === "symbol") throw new Error("cache queue aborted");
    return result;
}

export function recordMemoryChange(projectRoot: string, event: MemoryChangeEvent): void {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return;
        if (!Number.isSafeInteger(event.memoryId) || event.memoryId < 1) throw new Error("invalid memory id");
        const ts = new Date().toISOString();
        const stored: StoredChange = event.op === "remove"
            ? { op: event.op, id: event.memoryId, kind: event.kind, ts }
            : { op: event.op, id: event.memoryId, ts };
        const path = pendingPath(context.connection);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const line = Buffer.from(`${JSON.stringify(stored)}\n`, "utf8");
        const fd = openSync(path, "a", 0o600);
        try {
            if (writeSync(fd, line, 0, line.length, null) !== line.length) {
                throw new Error("short pending-changes write");
            }
        } finally {
            closeSync(fd);
        }
        scheduleDrain(projectRoot);
    } catch (error) {
        failure(error);
    }
}

export function scheduleDrain(projectRoot: string): void {
    try {
        if (!resolveContext(projectRoot)) return;
        scheduledProjects.add(projectRoot);
        const previous = debounceTimers.get(projectRoot);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => {
            debounceTimers.delete(projectRoot);
            void drainPendingChanges(projectRoot);
        }, DEBOUNCE_MS);
        timer.unref();
        debounceTimers.set(projectRoot, timer);
        if (!fallbackTimer) {
            fallbackTimer = setInterval(() => {
                for (const root of scheduledProjects) void drainPendingChanges(root);
            }, FALLBACK_MS);
            fallbackTimer.unref();
        }
    } catch (error) {
        failure(error);
    }
}

export async function drainPendingChanges(projectRoot: string): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        return await queued(() => drainLocked(context));
    } catch (error) {
        return failure(error);
    }
}

export async function rebuildCache(projectRoot: string, reason: string): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        return await queued(() => rebuildLocked(context, reason));
    } catch (error) {
        return failure(error);
    }
}

export async function maintainCache(projectRoot: string): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        return await queued(async () => {
            let exists = existsSync(context.connection.prefixPath);
            if (exists) {
                try {
                    await restore(context);
                } catch (error) {
                    if (error instanceof Error && error.message === "http_404") exists = false;
                    else throw error;
                }
            }
            const pending = readPending(pendingPath(context.connection));
            const snapshot = readMemorySnapshot(context.project);
            if (!exists) {
                const estimate = estimateTokens(renderMemoryBlockV2(snapshot.memories));
                if (estimate <= context.budget && context.connection.contextDocs.length === 0) {
                    return { action: "skipped", detail: "below-threshold" };
                }
                return rebuildLocked(context, "create");
            }
            const watermark = readCacheWatermark(context.connection);
            const latest = watermarkFor(snapshot, new Date().toISOString());
            if (
                !watermark ||
                watermark.maxMemoryId < latest.maxMemoryId ||
                watermark.maxMutationId < latest.maxMutationId ||
                pending.length > 0
            ) return rebuildLocked(context, "daily-compaction");
            return { action: "skipped", detail: "unchanged", watermark };
        });
    } catch (error) {
        return failure(error);
    }
}
