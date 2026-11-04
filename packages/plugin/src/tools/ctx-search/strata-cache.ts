import { createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
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
import { reduceLedgerRows } from "./ledger-reduce";
import { clearSidecarStale, markSidecarStale, readSidecarStale } from "./sidecar-stale";
import {
    enqueue,
    isRestoreSuccess,
    isStrataConfigResolutionFailure,
    nonEmpty,
    postWithDeadline,
    type StrataAskConnection,
    type StrataPostFailure,
    type StrataSessionReply,
    type StrataSessionRequest,
    safeBearer,
    sessionBlockOf,
    strataAskConnectionForProject,
    strataNoThinking,
} from "./strata-ask";
import PROMPTS from "./strata-prompts.json";

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
    /**
     * True when the remote rebuild fully succeeded but persisting its
     * completion record failed: callers must not present the previously
     * recorded time as the completion of THIS rebuild.
     */
    completionRecordFailed?: boolean;
}

export type MemoryChangeEvent =
    | { op: "add"; memoryId: number }
    | { op: "update"; memoryId: number }
    | { op: "remove"; memoryId: number; kind: "archive" | "delete" | "superseded" };

type StoredChange =
    | { op: "add" | "update"; id: number; ts: string }
    | { op: "remove"; id: number; kind: "archive" | "delete" | "superseded"; ts: string };

type Message = { role: "system" | "user" | "assistant"; content: string };

/**
 * Fully resolved write context for one configured slot. Exported for the
 * health bridge (strata-cache-health.ts); not part of the host-facing tool API.
 * @internal
 */
export interface CacheContext {
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
const COUNT_QUESTION =
    "记忆库正文条目及变更流水中现行有效之条目（含新增、不含已作废者）共多少条？参考文档一节不计入。只回复阿拉伯数字，不要其他文字。";
// A status ledger above this size is committed to the slot by the next
// consolidation pass; a smaller one keeps accumulating. Deliberately a constant:
// it sizes an internal write, while the query-side material budget is a separate
// knob (memory.strata_ask.transient_budget_tokens).
// The measure is the token estimate of the RENDERED change-flow lines, not the
// raw JSONL ledger bytes.
const STATUS_CONSOLIDATION_TOKENS = 2000;
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

/**
 * Plugin-same resolution used by both the write paths and the health bridge:
 * effective config for the directory, its project identity, the matching
 * connection, and a usable bearer token. Null means "not a configured
 * strata cache target" — callers must not fall back to looser resolution.
 * Pass `{ cache: false }` for read-only diagnostics: the identity probe then
 * never writes the durable identity sidecar (the health GET must not write).
 * @internal
 */
export function resolveContext(
    projectRoot: string,
    options: { cache?: boolean } = {},
): CacheContext | null {
    if (!projectRoot) return null;
    try {
        const loaded = loadPluginConfigDetailed(projectRoot, false);
        if (isStrataConfigResolutionFailure(loaded.loadOutcome)) return null;
        const project = resolveProjectIdentityForSession(
            projectRoot,
            loaded.config.allow_home_project,
            options,
        );
        if (!project) return null;
        const connection = strataAskConnectionForProject(loaded.config, project);
        if (!connection) return null;
        const apiKey =
            safeBearer(connection.apiKey) ??
            safeBearer(nonEmpty(process.env[connection.apiKeyEnv ?? ""]));
        if (!apiKey) return null;
        return {
            projectRoot,
            connection,
            project,
            apiKey,
            budget: loaded.config.memory.injection_budget_tokens,
        };
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
export function renderDocsSection(
    projectRoot: string,
    docs: readonly string[],
    budget: number,
): RenderedDocs | null {
    const entries: Array<{ path: string; name: string; text: string }> = [];
    for (const path of docs) {
        const resolved = path.startsWith("~/")
            ? join(homedir(), path.slice(2))
            : isAbsolute(path)
              ? path
              : join(projectRoot, path);
        try {
            if (!statSync(resolved).isFile()) throw new Error("not a regular file");
            entries.push({ path, name: basename(resolved), text: readFileSync(resolved, "utf8") });
        } catch (error) {
            log(`strata-cache docs: skip ${resolved}`, error);
        }
    }
    if (entries.length === 0) return null;

    const limit = Number.isFinite(budget) ? Math.floor(budget) : 0;
    const sectionOf = (blocks: string[]) =>
        [`${DOCS_HEADER}\n${DOCS_NOTICE}`, ...blocks, DOCS_FOOTER].join("\n\n");
    const fits = (blocks: string[]) => estimateTokens(sectionOf(blocks)) <= limit;
    const fullBlock = (entry: (typeof entries)[number]) => `〔${entry.name}〕\n${entry.text}`;
    const omitted = (remaining: typeof entries) =>
        remaining.map((entry) => `〔${entry.name}${DOCS_EMPTY_BUDGET_NOTE}〕`);
    const allBlocks = entries.map(fullBlock);
    if (fits(allBlocks)) {
        return {
            section: sectionOf(allBlocks),
            files: entries.map((entry) => entry.path),
            truncated: entries.map(() => false),
        };
    }
    if (!fits([DOCS_EMPTY_BUDGET_NOTE])) {
        log("context-docs budget too small, skipped");
        return null;
    }

    const blocks: string[] = [];
    const files: string[] = [];
    const truncated: boolean[] = [];
    for (const [index, entry] of entries.entries()) {
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
            const candidate = boundaries[middle];
            if (candidate === undefined) break;
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
    const end = anchoredFooter >= start ? anchoredFooter + 2 : userContent.lastIndexOf(DOCS_FOOTER);
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
 * Status ledger of one slot, beside its prefix file; slots sharing a directory
 * never mix. A legacy shared `pending-changes.jsonl` is deliberately ignored,
 * not migrated: a dreamer consolidation pass commits these events into the slot,
 * and the next full rebuild reconciles whatever a dropped event would have
 * carried.
 */
export function pendingChangesPathFor(prefixPath: string, slotFile: string): string {
    return join(dirname(prefixPath), `pending-changes.${slotKeyOf(slotFile)}.jsonl`);
}

/** One maintenance completion stamp shared by every slot beside the cache lock. */
export function maintenanceStatePathFor(prefixPath: string): string {
    return join(dirname(prefixPath), "maintenance.json");
}

/**
 * Per-slot record of the last SUCCESSFUL full rebuild completion, one file per
 * slot beside its ledger. Written only at the unified rebuild success exit, so
 * the timestamp never predates the remote save/self-check/publication/
 * consumption chain and is never moved by an append, a failed attempt, or the
 * mirror's mtime.
 */
export function lastRebuildStatePathFor(prefixPath: string, slotFile: string): string {
    return join(dirname(prefixPath), `last-rebuild.${slotKeyOf(slotFile)}.json`);
}

/**
 * Test seam fired immediately before the completion record write, so a test
 * can inject a write/replace failure WITHOUT destroying the original file.
 * @internal
 */
let lastRebuildRecordHookForTests: (() => void) | undefined;
export function __setLastRebuildRecordHookForTests(hook: (() => void) | undefined): void {
    lastRebuildRecordHookForTests = hook;
}

/**
 * Persist the completion record; returns false (without throwing) when the
 * write itself fails so the caller can flag that the recorded time no longer
 * describes this rebuild. The remote rebuild has already succeeded at this
 * point — that fact must be preserved, not converted into a rebuild failure.
 */
function recordSuccessfulRebuild(connection: StrataAskConnection): boolean {
    lastRebuildRecordHookForTests?.();
    try {
        atomicWrite(
            lastRebuildStatePathFor(connection.prefixPath, connection.slotFile),
            `${JSON.stringify({ rebuiltAt: new Date().toISOString() }, null, 2)}\n`,
        );
        return true;
    } catch (error) {
        log("strata-cache last-rebuild state write failed", error);
        return false;
    }
}

/**
 * Last recorded successful full rebuild completion, or null when the slot was
 * never successfully rebuilt (or the record was never written). Throws on a
 * present-but-unreadable/corrupt record so the health view reports an error
 * instead of silently showing "暂无记录".
 * @internal
 */
export function readSuccessfulRebuildAt(prefixPath: string, slotFile: string): string | null {
    let raw: string;
    try {
        raw = readFileSync(lastRebuildStatePathFor(prefixPath, slotFile), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const value = JSON.parse(raw) as { rebuiltAt?: unknown };
    if (typeof value.rebuiltAt !== "string" || !Number.isFinite(Date.parse(value.rebuiltAt))) {
        throw new Error("last-rebuild record is corrupt");
    }
    return new Date(value.rebuiltAt).toISOString();
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
    // No throw inside finally (biome noUnsafeFinally): the primary failure is
    // captured, the temp cleanup error is recorded only when nothing else failed.
    let failure: unknown;
    try {
        writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
    } catch (error) {
        failure = error;
    }
    try {
        unlinkSync(temporary);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined)
            failure = error;
    }
    if (failure !== undefined) throw failure;
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
    const fields = raw
        .slice(close + 1)
        .trim()
        .split(/\s+/);
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
            log(
                `strata-cache lock reclaimed without process-start token: pid ${owner.pid} ${entry.name}`,
            );
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
    return entries.sort(
        (left, right) =>
            left.createdAt - right.createdAt ||
            (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
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
            if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
                log("strata-cache lock cleanup failed", cleanup);
        }
        throw error;
    } finally {
        closeSync(fd);
    }
}

/** Register once; the same candidate retains its arrival place across every poll. */
function registerCacheLockCandidate(directory: string): CacheLockCandidate {
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
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            log("strata-cache lock release failed", error);
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
    const candidate = registerCacheLockCandidate(cacheLockDirectoryFor(connection.prefixPath));
    try {
        while (true) {
            if (tryAcquireCacheLock(candidate)) return await work();
            await sleep(CACHE_LOCK_RETRY_MS);
        }
    } finally {
        releaseCacheLock(candidate.path);
    }
}

/**
 * Non-blocking probe used by the health bridge: true while any live candidate
 * holds this prefix directory's cache lock. A missing directory is idle.
 * @internal
 */
export function cacheLockIsBusy(prefixPath: string): boolean {
    let entries: CacheLockEntry[];
    try {
        entries = readCacheLockEntries(cacheLockDirectoryFor(prefixPath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
    return entries.some((entry) => !lockIsStale(entry));
}

/** Last maintenance completion, or null when there is no readable stamp. */
function readMaintenanceCompletion(connection: StrataAskConnection): number | null {
    let raw: string;
    try {
        raw = readFileSync(maintenanceStatePathFor(connection.prefixPath), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            log("strata-cache maintenance state unreadable", error);
        return null;
    }
    try {
        const value = JSON.parse(raw) as { completedAt?: unknown };
        const at =
            typeof value.completedAt === "string" ? Date.parse(value.completedAt) : Number.NaN;
        return Number.isFinite(at) ? at : null;
    } catch {
        return null;
    }
}

function recordMaintenanceCompletion(connection: StrataAskConnection): void {
    try {
        const path = maintenanceStatePathFor(connection.prefixPath);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        atomicWrite(
            path,
            `${JSON.stringify({ completedAt: new Date().toISOString() }, null, 2)}\n`,
        );
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

// No throw inside finally (biome noUnsafeFinally): a busy ledger returns false
// and the loop retries, the primary error is captured, and the temp cleanup
// error is recorded only when nothing else failed.
function consumePending(path: string, consumed: string): void {
    if (!consumed) return;
    for (let attempt = 0; attempt < 10; attempt++) {
        if (consumePendingAttempt(path, consumed)) return;
    }
    throw new Error("pending-changes file remained busy during consumption");
}

function consumePendingAttempt(path: string, consumed: string): boolean {
    const current = readPending(path);
    if (!current.startsWith(consumed)) {
        throw new Error("pending-changes file changed during consumption");
    }
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let failure: unknown;
    let renamed = false;
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
            latest === current &&
            before.dev === after.dev &&
            before.ino === after.ino &&
            before.size === after.size &&
            before.mtimeMs === after.mtimeMs
        ) {
            renameSync(temporary, path);
            renamed = true;
        }
    } catch (error) {
        failure = error;
    }
    try {
        unlinkSync(temporary);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined)
            failure = error;
    }
    if (failure !== undefined) throw failure;
    return renamed;
}

interface ParsedChanges {
    changes: StoredChange[];
    /** Lines dropped as unusable: a torn tail or a corrupt event. */
    skipped: number;
}

/**
 * Tolerant reader for the status ledger. A process killed mid-append leaves a
 * torn final line, and any single unusable row must never poison the rest of the
 * file, so bad lines are dropped and counted for the caller to report instead of
 * failing the read. Dropping is best-effort by design: a lost event reconciles at
 * the next full rebuild.
 */
export function parseChanges(raw: string): ParsedChanges {
    const changes: StoredChange[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
        // The empty tail after the final newline is not an event; every other
        // unusable line is counted below.
        if (line.trim() === "") continue;
        const change = parseChangeLine(line);
        if (!change) {
            skipped++;
            continue;
        }
        changes.push(change);
    }
    return { changes, skipped };
}

function parseChangeLine(line: string): StoredChange | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const event = value as Record<string, unknown>;
    if (
        !Number.isSafeInteger(event.id) ||
        (event.id as number) < 1 ||
        typeof event.ts !== "string" ||
        !Number.isFinite(Date.parse(event.ts))
    )
        return null;
    const id = event.id as number;
    const ts = new Date(event.ts).toISOString();
    if (event.op === "add" || event.op === "update") return { op: event.op, id, ts };
    if (
        event.op === "remove" &&
        (event.kind === "archive" || event.kind === "delete" || event.kind === "superseded")
    ) {
        return { op: "remove", id, kind: event.kind, ts };
    }
    return null;
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
    if (!isValidPrefixMessages(value)) throw new Error("invalid prefix messages");
    return value.map((item) => ({ role: item.role, content: item.content }));
}

function isValidPrefixMessages(value: unknown): value is Message[] {
    if (!Array.isArray(value) || value.length < 3 || value.length % 2 !== 1) return false;
    return value.every((item, index) => {
        const role = index === 0 ? "system" : index % 2 === 1 ? "user" : "assistant";
        return (
            !!item &&
            typeof item === "object" &&
            (item as Message).role === role &&
            typeof (item as Message).content === "string"
        );
    });
}

/**
 * Structural validity of an on-disk prefix mirror, shared by the health
 * diagnostics and the read path. Read-only.
 * @internal
 */
export function isValidPrefixMirror(raw: string): boolean {
    try {
        return isValidPrefixMessages(JSON.parse(raw));
    } catch {
        return false;
    }
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
    const rebuiltAt = match[3];
    const maxMutationId = Number(match[4]);
    if (
        rebuiltAt === undefined ||
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(maxMemoryId) ||
        !Number.isSafeInteger(maxMutationId) ||
        !Number.isFinite(Date.parse(rebuiltAt))
    )
        return null;
    return { count, maxMemoryId, maxMutationId, rebuiltAt };
}

export function readCacheWatermark(cfg: StrataAskConnection): CacheWatermark | null {
    try {
        const prefix = readPrefix(cfg);
        if (!prefix) return null;
        return parseWatermark(prefix[prefix.length - 2]!.content);
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
        // The consolidation snapshot must mirror the query side's effective set
        // (strata-ask accepts active + permanent): a merge can leave the new
        // memory permanent, and an active-only snapshot would undercount the
        // ledger, skip its append, and drop its text from rebuilds.
        memories: getAllActiveMemoriesForMigration(db, project, ["active", "permanent"]).sort(
            (a, b) => a.id - b.id,
        ),
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
    const entries =
        /^#(\d+) \[[^\]\n]+\] 〔[^\n]+〕：$|^〔[^\n]+〕讣：#(\d+) 已删除\/已归档，上文同号条目作废$/gm;
    const section = docsSectionOf(previousContent);
    const docs = section?.startsWith(`${DOCS_HEADER}\n${DOCS_NOTICE}`) ? section : null;
    const docsStart = docs ? previousContent.indexOf(docs) : -1;
    // Keep later change-log entries in the ledger while excluding document text.
    const ledger =
        docs && docsStart >= 0
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
            // A vanished `add` (recorded, then deleted before consolidation)
            // renders on neither side: the query renderer skips it too, so
            // both sides iterate the same filtered row set.
            if (!memory) continue;
            lines.push(`〔${change.ts}〕增：\n${renderMemory(memory)}`);
            watermark.maxMemoryId = Math.max(watermark.maxMemoryId, memory.id);
            if (!visibleIds.has(memory.id)) {
                visibleIds.add(memory.id);
                watermark.count++;
            }
        } else if (change.op === "update" && memory) {
            lines.push(
                `〔${change.ts}〕正：#${change.id} 已修改为：「${memory.content}」，上文旧文作废`,
            );
        } else if (change.op === "remove" && memory) {
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
    readonly serverMessage: string | null;

    constructor(failure: StrataPostFailure) {
        super(failure.reason);
        this.name = "StrataCacheRequestError";
        this.status = failure.status ?? null;
        this.errorType = failure.errorType ?? null;
        this.serverMessage = failure.message ?? null;
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
    const result = await post(context, "/slots/0?action=restore", {
        filename: context.connection.slotFile,
    });
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

async function chat(
    context: CacheContext,
    messages: Message[],
    session?: StrataSessionRequest,
): Promise<ChatReply> {
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

function hasSaveConfirmation(session: StrataSessionReply | null): boolean {
    if (
        session?.save_error !== undefined ||
        !session?.saved ||
        typeof session.saved !== "object" ||
        Array.isArray(session.saved)
    )
        return false;
    const saved = session.saved as { tokens?: unknown; bytes?: unknown };
    return (
        typeof saved.tokens === "number" &&
        Number.isSafeInteger(saved.tokens) &&
        saved.tokens >= 0 &&
        typeof saved.bytes === "number" &&
        Number.isSafeInteger(saved.bytes) &&
        saved.bytes >= 0
    );
}

async function selfCheck(context: CacheContext, watermark: CacheWatermark): Promise<void> {
    // One composite restore-only request: the restore and the count question run
    // in the same server turn, and nothing is saved.
    const reply = await chat(context, [{ role: "user", content: COUNT_QUESTION }], {
        restore: context.connection.slotFile,
        splice: true,
    });
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
            if (!hasSaveConfirmation(reply.session)) {
                log(
                    "strata-cache save: missing save confirmation or server reported save_error",
                    reply.session?.save_error,
                );
                throw new Error("slot save failed");
            }
            if (reply.session?.sidecar === "skipped_recovery") {
                log("strata-cache save: sidecar skipped after a reasoning-loop recovery");
                markSidecarStale(context.connection.prefixPath, "skipped_recovery");
                throw new Error("sidecar recovery skipped");
            } else {
                // A written sidecar is fresh again, so any earlier marker is spent.
                clearSidecarStale(context.connection.prefixPath);
            }
            return [...input, { role: "assistant", content: reply.content }];
        } catch (error) {
            const failure = error instanceof StrataCacheRequestError ? error : null;
            if (failure?.status === 409 && !conflictRetried) {
                conflictRetried = true;
                log(
                    "strata-cache save: the server replied 409; retrying the composite save once",
                    failure.errorType,
                );
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
 * Delete this slot's status ledger before a full rebuild renders from the
 * canonical DB. A missing file is fine; any other failure aborts the rebuild
 * BEFORE the snapshot, so the ledger (and its recorded changes) is never lost
 * silently.
 */
function unlinkLedgerForRebuild(path: string): void {
    try {
        unlinkSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
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
 *
 * Ledger order (user-approved for every full rebuild, including the
 * consolidation rewrite for delete/update batches): invalidate first — the
 * pending-write marker makes the on-disk mirror unsafe for queries and forces
 * the next pass back here — then DELETE this slot's ledger BEFORE rendering.
 * A full rebuild renders from the canonical DB snapshot, so recorded changes
 * are redundant from here on; events arriving during the rebuild recreate the
 * ledger file and MUST survive to the next pass, hence no consumption at
 * completion. On failure the marker stays, queries fall back to classic
 * retrieval, and the next rebuild re-renders everything (including the
 * deleted rows' changes) from the DB.
 */
async function rebuildLocked(
    context: CacheContext,
    reason: string,
    restoreFirst = true,
): Promise<CacheActionResult> {
    const path = pendingPath(context.connection);
    // The save can succeed remotely even if its response is lost or incomplete,
    // so the marker lands BEFORE the ledger is touched: from here until the
    // mirror publishes, the cache is unsafe and must not be served.
    atomicWrite(
        pendingWritePath(context.connection.prefixPath),
        `${JSON.stringify({ at: new Date().toISOString() })}\n`,
    );
    // Full rebuild reads the canonical DB: the recorded changes are about to
    // render from the snapshot, so delete this slot's ledger up front. Only
    // this slot's file is touched; other slots' ledgers are untouched.
    unlinkLedgerForRebuild(path);
    const snapshot = readMemorySnapshot(context.project);
    const watermark = watermarkFor(snapshot, new Date().toISOString());
    // Rebuild/create always stamp the current templates; an old-format cache's
    // system (no change-log rules) must be replaced, not inherited.
    const system = SYSTEM_MESSAGE;
    const blocks = snapshot.memories.map(renderMemory).join("\n\n");
    const docs = renderDocsSection(
        context.projectRoot,
        context.connection.contextDocs,
        context.connection.contextDocsBudgetTokens,
    );
    const user = composeSlotUser(
        INTRO,
        blocks,
        docs?.section ?? null,
        ACK_REQUEST,
        watermarkLine(watermark),
    );
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
        await selfCheck(context, watermark);
    } catch (error) {
        if (!docs) throw error;
        log(
            "strata-cache docs: count self-check failed; reference docs may interfere, retrying once",
            error,
        );
        await selfCheck(context, watermark);
    }
    atomicWrite(context.connection.prefixPath, `${JSON.stringify(prefix, null, 2)}\n`);
    // Success metadata must persist BEFORE the marker clears: a published mirror
    // with no completion record must never be presented as "ready / 暂无记录".
    const completionRecorded = recordSuccessfulRebuild(context.connection);
    if (!completionRecorded) {
        // Keep the pending-write marker: the cache stays "interrupted" and the
        // recovery pass re-renders and re-records instead of serving a mirror
        // whose currency nothing proves. The remote rebuild itself succeeded.
        return {
            action: reason === "create" ? "created" : "rebuilt",
            detail: reason,
            watermark,
            completionRecordFailed: true,
        };
    }
    unlinkPendingWrite(context.connection.prefixPath);
    // Only now is the rebuild a success: completion record persisted BEFORE the
    // marker cleared, stamped AFTER the remote save, self-check, and mirror
    // publication. The ledger is NOT consumed here — rows written during the
    // rebuild already survived in the recreated file and belong to the next pass.
    return {
        action: reason === "create" ? "created" : "rebuilt",
        detail: reason,
        watermark,
    };
}

/**
 * The append decision plus everything it renders from, resolved under the cache
 * lock so one consolidation pass sees one consistent ledger and prefix.
 */
interface StatusAppend {
    path: string;
    /** The exact ledger bytes this pass read; consumption is anchored on them. */
    raw: string;
    prefix: Message[];
    content: string;
    lines: string[];
    watermark: CacheWatermark;
}

/** What committing these events would add to the slot, in estimated tokens. */
function estimateStatusTokens(lines: readonly string[]): number {
    return estimateTokens(lines.join("\n\n"));
}

/** A pure-addition batch splices onto the tail; anything else rewrites the slot. */
function statusIsAddOnly(changes: readonly StoredChange[]): boolean {
    return changes.length > 0 && changes.every((change) => change.op === "add");
}

/**
 * Commit the status ledger only when it is worth a write. Order matters:
 * a stale sidecar outranks everything (every splice query fails until a save
 * rewrites it); otherwise the ledger must hold more than
 * STATUS_CONSOLIDATION_TOKENS of future slot text, and only a pure-addition batch
 * may splice onto the tail — a batch carrying an update or a removal rewrites the
 * slot from the database snapshot.
 */
function pendingWritePath(prefixPath: string): string {
    return `${prefixPath}.pending-write.json`;
}

/** @internal Exported for the health bridge's rebuilding probe. */
export function hasPendingWrite(prefixPath: string): boolean {
    try {
        statSync(pendingWritePath(prefixPath));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function unlinkPendingWrite(prefixPath: string): void {
    try {
        unlinkSync(pendingWritePath(prefixPath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

async function consolidateLocked(context: CacheContext): Promise<CacheActionResult> {
    const path = pendingPath(context.connection);
    if (hasPendingWrite(context.connection.prefixPath))
        return rebuildLocked(context, "pending-write");
    if (readSidecarStale(context.connection.prefixPath))
        return rebuildLocked(context, "sidecar-stale");
    const pending = readPending(path);
    if (!pending) return { action: "skipped", detail: "no-pending-changes" };
    const parsed = parseChanges(pending);
    parsed.changes = reduceLedgerRows(parsed.changes, (change) => change);
    if (parsed.changes.length === 0 && parsed.skipped === 0)
        return { action: "skipped", detail: "no-pending-changes" };
    // The ledger keeps the bad rows either way: below the commit threshold
    // they stay queued (this warning is the only signal), above it they veto
    // the splice and the batch rebuilds instead.
    if (parsed.skipped > 0)
        log(`strata-cache status: ${parsed.skipped} unusable ledger line(s) retained`);
    // Creating the cache is maintenance's call (it owns the creation threshold);
    // consolidation only commits into a prefix that is already published.
    const prefix = readPrefix(context.connection);
    if (!prefix) return { action: "skipped", detail: "cache-missing" };
    const content = prefix
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n\n");
    const previousWatermark = parseWatermark(prefix[prefix.length - 2]!.content);
    if (!previousWatermark) return rebuildLocked(context, "watermark-missing");
    const snapshot = readMemorySnapshot(context.project);
    const rendered = renderChanges(parsed.changes, snapshot, content, previousWatermark);
    if (rendered.lines.length === 0) {
        // Matching watermarks cannot prove the slot contains the snapshot's
        // actual entries. Rebuild before consuming even a clean dead ledger.
        return rebuildLocked(
            context,
            parsed.skipped > 0 ? "status-unparseable" : "snapshot-mismatch",
        );
    }
    if (estimateStatusTokens(rendered.lines) <= STATUS_CONSOLIDATION_TOKENS) {
        return { action: "skipped", detail: "below-threshold", watermark: previousWatermark };
    }
    // A corrupt row voids the batch shape: what parses as pure additions may
    // hide a removal or an update, so it may never splice onto the tail.
    if (parsed.skipped > 0) return rebuildLocked(context, "status-unparseable");
    if (!statusIsAddOnly(parsed.changes)) return rebuildLocked(context, "status-mixed-changes");
    return appendStatusLocked(context, {
        path,
        raw: pending,
        prefix,
        content,
        lines: rendered.lines,
        watermark: rendered.watermark,
    });
}

async function appendStatusLocked(
    context: CacheContext,
    append: StatusAppend,
): Promise<CacheActionResult> {
    const beforeWatermark = append.content;
    const section = docsSectionOf(beforeWatermark);
    const docs = section?.startsWith(`${DOCS_HEADER}\n${DOCS_NOTICE}`) ? section : null;
    const docsEnd = docs ? beforeWatermark.indexOf(docs) + docs.length : 0;
    const ackStart = beforeWatermark.indexOf(ACK_REQUEST, docsEnd);
    const hasChangeLog =
        beforeWatermark.indexOf(
            `\n\n${CHANGE_LOG}\n`,
            ackStart < 0 ? 0 : ackStart + ACK_REQUEST.length,
        ) >= 0;
    const separator = hasChangeLog ? "" : `${CHANGE_LOG}\n`;
    const updatedUser = `${separator}${append.lines.join("\n\n")}\n\n${watermarkLine(append.watermark)}`;
    const input: Message = { role: "user", content: updatedUser };
    const slotFile = context.connection.slotFile;
    let reply: ChatReply;
    atomicWrite(
        pendingWritePath(context.connection.prefixPath),
        `${JSON.stringify({ at: new Date().toISOString() })}\n`,
    );
    try {
        reply = await chat(context, [input], { restore: slotFile, splice: true, save: slotFile });
    } catch (error) {
        // Mirrors spliceFailureOf in strata-ask.ts; only documented splice failures
        // invalidate the sidecar, not unrelated 409s such as model_busy.
        const failure = error instanceof StrataCacheRequestError ? error : null;
        const stale =
            failure?.status === 409 &&
            (failure.errorType === "splice_stale" || failure.errorType === "splice_base_seam")
                ? failure.errorType
                : failure?.status === 400 &&
                    failure.serverMessage?.startsWith("splice_render_mismatch")
                  ? "splice_render_mismatch"
                  : null;
        if (!stale) throw error;
        markSidecarStale(context.connection.prefixPath, stale);
        return rebuildLocked(context, "sidecar-stale");
    }
    if (!hasSaveConfirmation(reply.session)) throw new Error("slot save failed");
    if (reply.session?.splice?.resume_ok === false)
        log("strata-cache append: splice resume_ok=false; base was recomputed");
    if (reply.session?.sidecar === "skipped_recovery") {
        markSidecarStale(context.connection.prefixPath, "skipped_recovery");
        throw new Error("sidecar recovery skipped");
    } else if (reply.session) {
        clearSidecarStale(context.connection.prefixPath);
    }
    const updatedPrefix: Message[] = [
        ...append.prefix,
        input,
        { role: "assistant", content: reply.content },
    ];
    try {
        await selfCheck(context, append.watermark);
    } catch (error) {
        log("strata-cache append self-check failed; rebuilding", error);
        // The failed self-check just restored this prefix, so rebuild needs no restore.
        return rebuildLocked(context, "self-check", false);
    }
    atomicWrite(context.connection.prefixPath, `${JSON.stringify(updatedPrefix, null, 2)}\n`);
    consumePending(append.path, append.raw);
    unlinkPendingWrite(context.connection.prefixPath);
    return {
        action: "appended",
        detail: `applied ${append.lines.length} change(s)`,
        watermark: append.watermark,
    };
}

async function queued<T>(work: () => Promise<T>): Promise<T> {
    const result = await enqueue(work);
    if (typeof result === "symbol") throw new Error("cache queue aborted");
    return result as T;
}

/**
 * Append one ledger row. A previous write may have been torn by a crash, leaving
 * a partial row with no terminator; closing that line first keeps the new event
 * from merging into the dead bytes and being discarded with them.
 */
function appendLedgerLine(path: string, line: Buffer): void {
    const fd = openSync(path, "a+", 0o600);
    try {
        const size = fstatSync(fd).size;
        const payload =
            size > 0 && !endsWithNewline(fd, size)
                ? Buffer.concat([Buffer.from("\n"), line])
                : line;
        if (writeSync(fd, payload, 0, payload.length, null) !== payload.length) {
            throw new Error("short pending-changes write");
        }
    } finally {
        closeSync(fd);
    }
}

function endsWithNewline(fd: number, size: number): boolean {
    const last = Buffer.alloc(1);
    return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
}

/**
 * Record one memory change in the slot's status ledger. This never writes the
 * slot: a change is committed by the dreamer's consolidation pass (or the daily
 * rebuild), so a tool call costs one appended line and no remote write.
 */
export function recordMemoryChange(projectRoot: string, event: MemoryChangeEvent): void {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return;
        if (!Number.isSafeInteger(event.memoryId) || event.memoryId < 1)
            throw new Error("invalid memory id");
        const ts = new Date().toISOString();
        const stored: StoredChange =
            event.op === "remove"
                ? { op: event.op, id: event.memoryId, kind: event.kind, ts }
                : { op: event.op, id: event.memoryId, ts };
        const path = pendingPath(context.connection);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendLedgerLine(path, Buffer.from(`${JSON.stringify(stored)}\n`, "utf8"));
    } catch (error) {
        failure(error);
    }
}

/**
 * Commit the status ledger if it is worth a write. The dreamer's hourly
 * consolidation task calls this; it is the only writer besides the daily
 * rebuild, so recording a memory change never causes an immediate remote write.
 */
export async function consolidateCache(projectRoot: string): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        return await queued(() =>
            withCacheLock(context.connection, () => consolidateLocked(context)),
        );
    } catch (error) {
        return failure(error);
    }
}

export async function rebuildCache(
    projectRoot: string,
    reason: string,
): Promise<CacheActionResult> {
    try {
        const context = resolveContext(projectRoot);
        if (!context) return { action: "disabled", detail: "strata-ask-disabled" };
        return await queued(() =>
            withCacheLock(context.connection, () => rebuildLocked(context, reason)),
        );
    } catch (error) {
        return failure(error);
    }
}

async function maintainLocked(context: CacheContext): Promise<CacheActionResult> {
    if (hasPendingWrite(context.connection.prefixPath))
        return rebuildLocked(context, "pending-write");
    const staleSidecar = readSidecarStale(context.connection.prefixPath);
    // Restore first: a saved slot is reused as the KV prefix, and only a 404 says
    // there is no cache to maintain yet.
    const exists = await restoreSavedSlot(context);
    const snapshot = readMemorySnapshot(context.project);
    if (!exists) {
        const estimate = estimateTokens(renderMemoryBlockV2(snapshot.memories));
        if (
            !staleSidecar &&
            estimate <= context.budget &&
            context.connection.contextDocs.length === 0
        ) {
            return { action: "skipped", detail: "below-threshold" };
        }
        return rebuildLocked(context, "create", false);
    }
    // The daily pass always rebuilds from the current database snapshot.
    // Watermark equality never proves content equality: a migrate-session
    // move and a dreamer addition can offset each other in count while every
    // max id still matches, and an append can advance the max-id watermark
    // past an unrecorded change. A stale sidecar likewise forces a rebuild
    // even when every watermark is current: splice queries keep failing until
    // a save rewrites it. Once a day the full rebuild is the exact, cheap
    // answer; a pending ledger (if any) is deleted by the rebuild at start.
    return rebuildLocked(context, staleSidecar ? "sidecar-stale" : "daily-compaction", false);
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
                        cooldown?.cappedBySkew === true && cooldown.completion === waitedOutSkew;
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
