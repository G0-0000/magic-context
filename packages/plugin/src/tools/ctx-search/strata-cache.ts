import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
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
    sessionBlockOf,
    strataAskConnectionForProject,
    strataNoThinking,
    type StrataAskConnection,
    type StrataPostFailure,
    type StrataSessionReply,
    type StrataSessionRequest,
} from "./strata-ask";
import { clearSidecarStale, markSidecarStale, readSidecarStale } from "./sidecar-stale";

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
// Maintenance starts at least this long after the previous maintenance finished.
const MAINTENANCE_COOLDOWN_MS = 60_000;
// One prefix directory (normally one slot server) is guarded by one lock directory.
const CACHE_LOCK_DIR = "cache.lock.d";
// A malformed or empty candidate older than this is an abandoned write, not a
// lock still being created. Live candidates are judged by pid identity instead.
const CACHE_LOCK_STALE_MS = 15 * 60_000;
// A live pid without a process-start token (legacy payload, or a platform with no
// /proc) can only be judged by file age. The bound sits far beyond the longest
// bounded composite write plus self-check chain (timeout_ms may exceed 15
// minutes), so a legitimate long operation is never preempted; the fallback is
// logged.
const CACHE_LOCK_LEGACY_STALE_MS = 24 * 60 * 60_000;
const CACHE_LOCK_RETRY_MS = 50;
// A candidate must be visible this long before it may own the slot, so every
// caller that registered in the same clock tick is seen before one is elected.
const CACHE_LOCK_SETTLE_MS = 50;
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

/**
 * A slot's basename is one path component (strata-ask rejects separators), but not
 * necessarily a filename. Sanitize it, and append a digest whenever sanitizing
 * changed it, so two slots can never collide on one pending file.
 */
function slotKeyOf(slotFile: string): string {
    const name = basename(slotFile);
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
    if (safe === name && safe.length > 0 && safe !== "." && safe !== "..") return safe;
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
    return `${safe.replace(/^\.+/, "") || "slot"}-${digest}`;
}

/**
 * Pending events of one slot, beside its prefix file; slots sharing a directory
 * never mix. A legacy shared `pending-changes.jsonl` is deliberately ignored,
 * not migrated: these events only accelerate an append, and the next maintenance
 * rebuild reconciles whatever a dropped event would have carried.
 */
export function pendingChangesPathFor(prefixPath: string, slotFile: string): string {
    return join(dirname(prefixPath), `pending-changes.${slotKeyOf(slotFile)}.jsonl`);
}

/** One maintenance completion stamp shared by every slot beside the cache lock. */
export function maintenanceStatePathFor(prefixPath: string): string {
    return join(dirname(prefixPath), "maintenance.json");
}

function pendingPath(connection: StrataAskConnection): string {
    return pendingChangesPathFor(connection.prefixPath, connection.slotFile);
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

interface CacheLockOwner {
    pid: number;
    nonce: string;
    /**
     * Field 22 of /proc/<pid>/stat at creation: the process start time. Pid plus
     * this token identifies one process instance; null for legacy payloads or a
     * platform without /proc.
     */
    procStart: string | null;
}

interface CacheLockCandidate {
    directory: string;
    name: string;
    path: string;
    payload: string;
    /** Process-monotonic registration time; the settle window is measured on it. */
    registeredAt: number;
}

interface CacheLockEntry {
    name: string;
    path: string;
    raw: string;
    owner: CacheLockOwner | null;
    /** Arrival order key: birth time when the filesystem records it, else mtime. */
    createdAt: number;
    /** Last write; the only evidence for malformed or tokenless candidates. */
    modifiedAt: number;
}

/** The lock directory shared by every slot beside the same prefix file. */
export function cacheLockDirectoryFor(prefixPath: string): string {
    return join(dirname(prefixPath), CACHE_LOCK_DIR);
}

function readLockFile(path: string): { raw: string; owner: CacheLockOwner | null } | null {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    try {
        const value = JSON.parse(raw) as {
            pid?: unknown;
            nonce?: unknown;
            procStart?: unknown;
        };
        if (
            Number.isSafeInteger(value.pid) &&
            (value.pid as number) > 0 &&
            typeof value.nonce === "string" &&
            value.nonce.length > 0
        ) {
            const procStart =
                typeof value.procStart === "string" && /^\d+$/.test(value.procStart)
                    ? value.procStart
                    : null;
            return { raw, owner: { pid: value.pid as number, nonce: value.nonce, procStart } };
        }
    } catch {
        // A fresh empty or truncated payload may still be writing; age decides below.
    }
    return { raw, owner: null };
}

/** Process-monotonic milliseconds; a wall-clock adjustment cannot move it. */
function monotonicNowMs(): number {
    return performance.now();
}

/**
 * Field 22 of /proc/<pid>/stat (start time in clock ticks since boot), as a
 * string token, or null when this platform cannot supply one. Everything after
 * the final ')' is parsed because comm may itself contain spaces or parentheses.
 */
function readProcStart(pid: number): string | null {
    let raw: string;
    try {
        raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
        return null;
    }
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    // After "pid (comm)": field 3 (state) is index 0, so field 22 is index 19.
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const token = fields[19];
    return token !== undefined && /^\d+$/.test(token) ? token : null;
}

/** True once the observed candidate can no longer own the slot. */
function lockIsStale(entry: CacheLockEntry): boolean {
    const owner = entry.owner;
    if (owner) {
        try {
            process.kill(owner.pid, 0);
        } catch (error) {
            // ESRCH proves the holder is gone. Any other failure (EPERM) only means
            // the pid cannot be probed here; instance identity decides below.
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        }
        if (owner.procStart !== null) {
            // A live pid may be a reused one. The start token is exact, so a
            // matching instance stays the holder for as long as it runs, and a
            // different or now unreadable instance is stale at once.
            return readProcStart(owner.pid) !== owner.procStart;
        }
        // No instance token (legacy payload or no /proc): file age is the only
        // evidence, and it is deliberately generous so a long valid rebuild is
        // not preempted. Logged because this path weakens reuse detection.
        if (Date.now() - entry.modifiedAt > CACHE_LOCK_LEGACY_STALE_MS) {
            log(`strata-cache lock reclaimed without process-start token: pid ${owner.pid} ${entry.name}`);
            return true;
        }
        return false;
    }
    // A malformed fresh candidate is a write in progress, not a stale lock; only
    // one that has been abandoned this long is reclaimed.
    return Date.now() - entry.modifiedAt > CACHE_LOCK_STALE_MS;
}

/**
 * Live candidates in arrival order. The ordering key is the directory entry's
 * birth time, not the timestamp the caller wrote into the name, so a caller
 * paused between reading its clock and creating its file cannot insert itself
 * ahead of an owner that is already running. Where the filesystem records no
 * birth time, the name's timestamp is the fallback and the settle window covers
 * same-tick registrations.
 */
function readCacheLockEntries(directory: string): CacheLockEntry[] {
    const entries: CacheLockEntry[] = [];
    for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const observed = readLockFile(path);
        if (!observed) continue;
        let stats: ReturnType<typeof statSync>;
        try {
            stats = statSync(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
        }
        // Birth time is the true arrival order. Without it, the name's timestamp
        // is stable across payload writes; mtime is the last resort.
        const namedAt = Number(name.slice(0, 13));
        let createdAt = stats.mtimeMs;
        if (stats.birthtimeMs > 0) createdAt = stats.birthtimeMs;
        else if (Number.isFinite(namedAt)) createdAt = namedAt;
        entries.push({
            name,
            path,
            raw: observed.raw,
            owner: observed.owner,
            createdAt,
            modifiedAt: stats.mtimeMs,
        });
    }
    return entries.sort((left, right) =>
        left.createdAt - right.createdAt ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    );
}

/** Remove only the exact unique candidate judged stale, if its payload is unchanged. */
function breakStaleLock(path: string, observed: string): boolean {
    const current = readLockFile(path);
    if (!current) return true;
    if (current.raw !== observed) return false;
    try {
        unlinkSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return true;
}

function createLockFile(path: string, payload: string): boolean {
    let fd: number;
    try {
        fd = openSync(path, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    }
    try {
        writeSync(fd, payload);
        return true;
    } catch (error) {
        // Never leave an empty candidate behind if the payload write fails.
        try {
            unlinkSync(path);
        } catch (cleanup) {
            if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") log("strata-cache lock cleanup failed", cleanup);
        }
        throw error;
    } finally {
        closeSync(fd);
    }
}

/** Register once; the same candidate retains its arrival place across every poll. */
function registerCacheLockCandidate(connection: Pick<StrataAskConnection, "prefixPath">): CacheLockCandidate {
    const directory = cacheLockDirectoryFor(connection.prefixPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The name keeps the wall-clock stamp as its ordering fallback; the settle
    // window uses the process-monotonic clock instead, so a clock rollback cannot
    // stall it.
    const namedAt = Date.now();
    const registeredAt = monotonicNowMs();
    const nonce = randomBytes(8).toString("hex");
    const name = `${String(namedAt).padStart(13, "0")}-${String(process.pid).padStart(10, "0")}-${nonce}`;
    const path = join(directory, name);
    const procStart = readProcStart(process.pid);
    if (procStart === null)
        log("strata-cache lock: no process-start token; liveness falls back to file age");
    const payload = `${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString(), procStart })}\n`;
    if (!createLockFile(path, payload)) throw new Error("cache lock candidate collision");
    return { directory, name, path, payload, registeredAt };
}

/**
 * Own the mutex only when every candidate that arrived earlier is gone or has
 * been reclaimed. False means an older live candidate remains; the caller keeps
 * its candidate and polls. Candidate liveness is probed in this pid namespace,
 * so the lock presumes writers on one host.
 */
function tryAcquireCacheLock(candidate: CacheLockCandidate): boolean {
    // Wait until every caller that registered in the same clock tick has created
    // its candidate; only then is "I am the oldest live candidate" stable.
    if (monotonicNowMs() - candidate.registeredAt < CACHE_LOCK_SETTLE_MS) return false;
    let own = false;
    for (const entry of readCacheLockEntries(candidate.directory)) {
        if (entry.name === candidate.name) {
            if (entry.raw !== candidate.payload) throw new Error("cache lock candidate changed");
            own = true;
            break;
        }
        if (!lockIsStale(entry)) return false;
        if (!breakStaleLock(entry.path, entry.raw)) return false;
    }
    if (!own) {
        // Registration completed before the directory scan; absence means an
        // external removal, and waiting without a candidate could never progress.
        throw new Error("cache lock candidate disappeared");
    }
    return true;
}

function releaseCacheLock(path: string): void {
    try {
        // This path is unique to the caller and is never reused by a new owner.
        unlinkSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("strata-cache lock release failed", error);
    }
}

function sleep(ms: number): Promise<void> {
    // Keep the timer referenced: an awaited caller must not lose its operation
    // merely because this wait is the process's only remaining work.
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Cross-process mutex. Every caller keeps a unique candidate while it waits and
 * removes only that candidate when it finishes. Exported so the regression tests
 * can drive two waiters against one lock directory directly.
 * @internal
 */
export async function withCacheLock<T>(
    connection: Pick<StrataAskConnection, "prefixPath">,
    work: () => Promise<T>,
): Promise<T> {
    const candidate = registerCacheLockCandidate(connection);
    try {
        while (true) {
            if (tryAcquireCacheLock(candidate)) return await work();
            await sleep(CACHE_LOCK_RETRY_MS);
        }
    } finally {
        releaseCacheLock(candidate.path);
    }
}

/** Last maintenance completion, or null when there is no readable stamp. */
function readMaintenanceCompletion(connection: StrataAskConnection): number | null {
    let raw: string;
    try {
        raw = readFileSync(maintenanceStatePathFor(connection.prefixPath), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("strata-cache maintenance state unreadable", error);
        return null;
    }
    try {
        const value = JSON.parse(raw) as { completedAt?: unknown };
        const at = typeof value.completedAt === "string" ? Date.parse(value.completedAt) : Number.NaN;
        return Number.isFinite(at) ? at : null;
    } catch {
        return null;
    }
}

function recordMaintenanceCompletion(connection: StrataAskConnection): void {
    try {
        const path = maintenanceStatePathFor(connection.prefixPath);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        atomicWrite(path, `${JSON.stringify({ completedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch (error) {
        log("strata-cache maintenance state write failed", error);
    }
}

interface MaintenanceCooldown {
    completion: number;
    remainingMs: number;
    /** The stamp sits more than one full cooldown in the future (clock skew). */
    cappedBySkew: boolean;
}

/**
 * How long the next maintenance start still owes the previous completion, across
 * processes and restarts. Read under the lock, so an attempt that just finished
 * always sees its own stamp.
 */
function maintenanceCooldown(connection: StrataAskConnection): MaintenanceCooldown | null {
    const completedAt = readMaintenanceCompletion(connection);
    if (completedAt === null) return null;
    const rawRemaining = completedAt + MAINTENANCE_COOLDOWN_MS - Date.now();
    // A stamp far in the future (clock skew) buys at most one full cooldown.
    return {
        completion: completedAt,
        remainingMs: Math.max(0, Math.min(rawRemaining, MAINTENANCE_COOLDOWN_MS)),
        cappedBySkew: rawRemaining > MAINTENANCE_COOLDOWN_MS,
    };
}

/** Internal only: release the locks, sleep, then retry the cooldown check. */
interface MaintenanceDeferral {
    retryAfterMs: number;
    completion: number;
    cappedBySkew: boolean;
}

type MaintenanceOutcome = CacheActionResult | MaintenanceDeferral;

function isMaintenanceDeferral(outcome: MaintenanceOutcome): outcome is MaintenanceDeferral {
    return "retryAfterMs" in outcome;
}

// No await in this loop: local registrations cannot interleave. Appends are not
// locked across processes, so the optimistic re-read incorporates their events
// except in the final stat/rename window; drains holding the cache lock cannot
// interleave with each other.
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

class StrataCacheRequestError extends Error {
    readonly status: number | null;
    readonly errorType: string | null;

    constructor(failure: StrataPostFailure) {
        super(failure.reason);
        this.name = "StrataCacheRequestError";
        this.status = failure.status ?? null;
        this.errorType = failure.errorType ?? null;
    }
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
    if (!response.ok) throw new StrataCacheRequestError(response);
    return response.json;
}

/** Restore probe for maintenance: is there a saved slot to maintain? */
async function restore(context: CacheContext): Promise<void> {
    const result = await post(context, "/slots/0?action=restore", { filename: context.connection.slotFile });
    if (!isRestoreSuccess(result)) throw new Error("invalid restore reply");
}

interface ChatReply {
    content: string;
    session: StrataSessionReply | null;
}

function chatContentOf(result: unknown): string {
    if (!result || typeof result !== "object") throw new Error("invalid chat reply");
    const choices = (result as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new Error("invalid chat reply");
    const content = (choices[0] as { message?: { content?: unknown } } | null)?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("invalid chat reply");
    return content;
}

async function chat(context: CacheContext, messages: Message[], session?: StrataSessionRequest): Promise<ChatReply> {
    const result = await post(context, "/v1/chat/completions", {
        model: context.connection.model,
        messages,
        max_tokens: context.connection.maxTokens,
        stream: false,
        ...(session ? { strata_session: session } : {}),
        ...strataNoThinking(),
    });
    return { content: chatContentOf(result), session: sessionBlockOf(result) };
}

async function selfCheck(context: CacheContext, prefix: Message[], watermark: CacheWatermark): Promise<void> {
    // One composite restore-only request: the restore and the count question run
    // in the same server turn, and nothing is saved.
    const reply = await chat(
        context,
        [...prefix, { role: "user", content: COUNT_QUESTION }],
        { restore: context.connection.slotFile },
    );
    if (!/^\s*\d+\s*$/.test(reply.content) || Number(reply.content.trim()) !== watermark.count) {
        throw new Error("count self-check failed");
    }
}

/**
 * Write the slot and its token sidecar in ONE composite request. `restore` folds
 * the saved slot into the same server turn, so restore → generate → save is
 * atomic and no other client can change slot 0 in between.
 *
 * Two failures are retried once each, and both are side-effect free:
 * - any 409: a concurrent same-name save (`splice_stale`) or explicit model
 *   control reporting the model busy (`model_busy`); the server writes nothing
 *   on that reply, so replaying the whole request is safe.
 * - 404 while restoring: there is no slot to reuse yet (first build). The retry
 *   drops the restore and creates it instead of failing the run.
 *
 * A `save_error` reply means the slot was not written: the run fails so pending
 * changes are kept for the next attempt. A `skipped_recovery` sidecar is flagged
 * for maintenance, because splice queries cannot resume until a save rewrites it.
 */
async function generateAndSave(
    context: CacheContext,
    system: string,
    user: string,
    restore: boolean,
): Promise<Message[]> {
    const input: Message[] = [
        { role: "system", content: system },
        { role: "user", content: user },
    ];
    const slotFile = context.connection.slotFile;
    let session: StrataSessionRequest = restore
        ? { restore: slotFile, save: slotFile }
        : { save: slotFile };
    let conflictRetried = false;
    let missingRetried = false;
    while (true) {
        try {
            const reply = await chat(context, input, session);
            if (reply.session?.save_error !== undefined) {
                log("strata-cache save: the server reported save_error; the sidecar is unchanged", reply.session.save_error);
                throw new Error("slot save failed");
            }
            if (reply.session?.sidecar === "skipped_recovery") {
                log("strata-cache save: sidecar skipped after a reasoning-loop recovery");
                markSidecarStale(context.connection.prefixPath, "skipped_recovery");
            } else if (reply.session) {
                // A written sidecar is fresh again, so any earlier marker is spent.
                clearSidecarStale(context.connection.prefixPath);
            } else {
                // Without a session block there is no evidence the sidecar was
                // rewritten, so an earlier marker stays until a reply proves it.
                log("strata-cache save: reply carried no session block; sidecar marker left as is");
            }
            return [...input, { role: "assistant", content: reply.content }];
        } catch (error) {
            const failure = error instanceof StrataCacheRequestError ? error : null;
            if (failure?.status === 409 && !conflictRetried) {
                conflictRetried = true;
                log("strata-cache save: the server replied 409; retrying the composite save once", failure.errorType);
                continue;
            }
            if (failure?.status === 404 && session.restore && !missingRetried) {
                missingRetried = true;
                session = { save: slotFile };
                log("strata-cache save: no saved slot to restore; creating without prefix reuse");
                continue;
            }
            throw error;
        }
    }
}

/**
 * Restore this project's saved slot so the next chat reuses it as the KV prefix.
 * A missing remote slot (http_404) is the only tolerated failure: there is
 * nothing to reuse yet. Any other failure aborts, since the slot state is then
 * unknown. Returns whether a saved slot was restored.
 */
async function restoreSavedSlot(context: CacheContext): Promise<boolean> {
    if (!existsSync(context.connection.prefixPath)) return false;
    try {
        await restore(context);
        return true;
    } catch (error) {
        if (error instanceof Error && error.message === "http_404") return false;
        throw error;
    }
}

/**
 * Full rebuild. `restoreFirst` folds the saved slot into the composite write, so
 * restore → generate → save is one atomic request; callers that restored or
 * probed the slot immediately before (maintenance, append self-check fallback)
 * clear it so one operation restores the slot exactly once.
 */
async function rebuildLocked(
    context: CacheContext,
    reason: string,
    restoreFirst = true,
): Promise<CacheActionResult> {
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
    // Reuse the saved prefix inside the same request: the system message is
    // unchanged, so the rebuilt chat only pays for the new user turn. Without a
    // published prefix there is nothing to restore, so the first build skips it.
    const prefix = await generateAndSave(
        context,
        system,
        user,
        restoreFirst && existsSync(context.connection.prefixPath),
    );
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
    // prefix.json exists here, so the saved slot is the prefix the append builds on;
    // the restore rides the same composite request as the save.
    const updatedPrefix = await generateAndSave(context, prefix[0]!.content, updatedUser, true);
    try {
        await selfCheck(context, updatedPrefix, watermark);
    } catch (error) {
        log("strata-cache append self-check failed; rebuilding", error);
        // The failed self-check just restored this prefix, so rebuild needs no restore.
        return rebuildLocked(context, "self-check", false);
    }
    atomicWrite(context.connection.prefixPath, `${JSON.stringify(updatedPrefix, null, 2)}\n`);
    consumePending(path, pending);
    return { action: "appended", detail: `applied ${lines.length} change(s)`, watermark };
}

async function queued<T>(work: () => Promise<T>): Promise<T> {
    const result = await enqueue(work);
    if (typeof result === "symbol") throw new Error("cache queue aborted");
    return result as T;
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
        return await queued(() => withCacheLock(context.connection, () => drainLocked(context)));
    } catch (error) {
        return failure(error);
    }
}

export async function rebuildCache(projectRoot: string, reason: string): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        return await queued(() => withCacheLock(context.connection, () => rebuildLocked(context, reason)));
    } catch (error) {
        return failure(error);
    }
}

async function maintainLocked(context: CacheContext): Promise<CacheActionResult> {
    const staleSidecar = readSidecarStale(context.connection.prefixPath);
    // Restore first: a saved slot is reused as the KV prefix, and only a 404 says
    // there is no cache to maintain yet.
    const exists = await restoreSavedSlot(context);
    const pending = readPending(pendingPath(context.connection));
    const snapshot = readMemorySnapshot(context.project);
    if (!exists) {
        const estimate = estimateTokens(renderMemoryBlockV2(snapshot.memories));
        if (!staleSidecar && estimate <= context.budget && context.connection.contextDocs.length === 0) {
            return { action: "skipped", detail: "below-threshold" };
        }
        return rebuildLocked(context, "create", false);
    }
    const watermark = readCacheWatermark(context.connection);
    const latest = watermarkFor(snapshot, new Date().toISOString());
    if (
        // A stale sidecar forces a rebuild even when every watermark is current:
        // splice queries keep failing until a save rewrites it. The save clears
        // the marker; a save that skips the sidecar leaves a fresh marker behind.
        staleSidecar ||
        !watermark ||
        watermark.maxMemoryId < latest.maxMemoryId ||
        watermark.maxMutationId < latest.maxMutationId ||
        pending.length > 0
    ) return rebuildLocked(context, staleSidecar ? "sidecar-stale" : "daily-compaction", false);
    return { action: "skipped", detail: "unchanged", watermark };
}

export async function maintainCache(projectRoot: string): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        // A stamp skewed into the future buys one full cooldown, then is treated as
        // elapsed; a newer stamp always starts a new wait.
        let waitedOutSkew: number | null = null;
        while (true) {
            const outcome = await queued(() =>
                withCacheLock(context.connection, async (): Promise<MaintenanceOutcome> => {
                    // The previous attempt records completion before releasing the
                    // lock, so a caller that acquires the lock reads the true gap.
                    const cooldown = maintenanceCooldown(context.connection);
                    const skewAlreadyWaited =
                        cooldown !== null && cooldown.cappedBySkew && cooldown.completion === waitedOutSkew;
                    if (cooldown && cooldown.remainingMs > 0 && !skewAlreadyWaited) {
                        return {
                            retryAfterMs: cooldown.remainingMs,
                            completion: cooldown.completion,
                            cappedBySkew: cooldown.cappedBySkew,
                        };
                    }
                    try {
                        return await maintainLocked(context);
                    } finally {
                        // Failed attempts cool down too, so an error cannot be hammered.
                        recordMaintenanceCompletion(context.connection);
                    }
                }),
            );
            if (!isMaintenanceDeferral(outcome)) return outcome;
            // The cache lock and the process-local queue are both released here:
            // an ordinary ask must never wait behind a maintenance caller that is
            // merely sleeping out its cooldown.
            waitedOutSkew = outcome.cappedBySkew ? outcome.completion : null;
            await sleep(outcome.retryAfterMs);
        }
    } catch (error) {
        return failure(error);
    }
}
