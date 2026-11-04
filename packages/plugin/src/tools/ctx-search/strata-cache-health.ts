/**
 * Strata cache health bridge.
 *
 * Stable source-level seam imported by the workbench (Bun, direct path import
 * from the local fork — no package export or root index.ts named export is
 * added for it). Two entry points:
 *
 * - `getStrataCacheHealth` is strictly read-only: it never restores a slot,
 *   queries a model, or writes anything. With no arguments it enumerates the
 *   real configured targets itself: it scans the home directory for project
 *   roots, validates each through the same config/identity/slot resolution the
 *   write paths use, and also surfaces user-config targets whose identity no
 *   local directory could bind. Pending counts are raw valid ledger rows
 *   (never deduped, never a memory count); an unreadable ledger is an explicit
 *   error state, never a silent zero.
 *
 * - `rebuildStrataCache` reuses the existing unified `rebuildCache` (composite
 *   save + self-check + mirror publication + ledger consumption) and takes the
 *   project memory lease with a heartbeat exactly like the dreamer's cache
 *   tasks, so a manual rebuild serializes with every memory-mutating dreamer
 *   task. Success resolves `{ cacheKey }`. Failure THROWS: a
 *   `StrataCacheRebuildError` with code `UNKNOWN_CACHE` (not a configured
 *   target) or `BUSY` (already running here, cache lock held elsewhere, or the
 *   project memory lease taken), or a plain Error whose message describes the
 *   failure. Arbitrary filenames/paths are rejected: the cacheKey must resolve
 *   through the plugin's own config/identity resolution.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
    cortexKitProjectConfigBasePath,
    cortexKitUserConfigBasePath,
} from "../../config/migrate-config-location";
import {
    acquireLeaseWithAcquisition,
    leaseOwnershipMatches,
    releaseLease,
    startLeaseHeartbeat,
} from "../../features/magic-context/dreamer/lease";
import { leaseKeyFor } from "../../features/magic-context/dreamer/task-registry";
import { openCurrentDatabase } from "../../features/magic-context/storage-db";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { log } from "../../shared/logger";
import { detectConfigFile, readJsoncFile } from "../../shared/jsonc-parser";
import type { Database } from "../../shared/sqlite";
import {
    type CacheContext,
    cacheLockIsBusy,
    hasPendingWrite,
    isValidPrefixMirror,
    parseChanges,
    pendingChangesPathFor,
    readCacheWatermark,
    readSuccessfulRebuildAt,
    rebuildCache,
    resolveContext,
} from "./strata-cache";
import type { StrataAskConfigSource } from "./strata-ask";

export type StrataCacheStatus = "ready" | "missing" | "error" | "unconfigured";

export interface CacheHealth {
    /** Opaque handle accepted by rebuildStrataCache; the validated project root. */
    cacheKey: string;
    projectRoot: string;
    /** Configured slot file (basename), never a caller-supplied path. */
    filename: string;
    /** ISO timestamp of the last successful FULL rebuild completion; null = none recorded. */
    lastSuccessfulRebuildAt: string | null;
    /**
     * Unconsumed valid change actions: every usable ledger row, not deduped by
     * id and not a memory count. Null only when the ledger is unreadable.
     */
    pendingActionCount: number | null;
    /** Unusable ledger rows (corrupt JSON, bad op/id/ts); kept, never consumed. */
    malformedActionCount: number;
    /** True when the per-slot ledger file does not exist (count is then explicitly zero). */
    ledgerMissing: boolean;
    /** True only while a LIVE operation holds this cache's lock. A leftover pending-write marker is NOT rebuilding: it is an interrupted write awaiting a confirmed rebuild. */
    rebuilding: boolean;
    status: StrataCacheStatus;
    error?: string;
}

export interface StrataCacheHealthSnapshot {
    caches: CacheHealth[];
    /** Set only when the whole diagnostic failed; caches may be partial/empty. */
    error?: string;
}

export type StrataCacheRebuildErrorCode = "UNKNOWN_CACHE" | "BUSY";

/** Failure carrier for rebuildStrataCache: thrown, never returned. */
export class StrataCacheRebuildError extends Error {
    readonly code: StrataCacheRebuildErrorCode;

    constructor(code: StrataCacheRebuildErrorCode, message: string) {
        super(message);
        this.name = "StrataCacheRebuildError";
        this.code = code;
    }
}

export interface StrataCacheHealthOptions {
    /**
     * Explicit candidate project directories. Each must pass the plugin's
     * config/identity/slot resolution to appear as a configured target; roots
     * that fail resolution are returned as "unconfigured" and can never be
     * rebuilt. When omitted, the bridge enumerates configured targets itself
     * (home-directory scan plus declared user-config targets).
     */
    projectRoots?: readonly string[];
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCodeOf(error: unknown): string | undefined {
    return error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
}

function unconfiguredEntry(root: string, reason: string): CacheHealth {
    return {
        cacheKey: root,
        projectRoot: root,
        filename: "",
        lastSuccessfulRebuildAt: null,
        pendingActionCount: null,
        malformedActionCount: 0,
        ledgerMissing: false,
        rebuilding: false,
        status: "unconfigured",
        error: reason,
    };
}

function healthOfConnection(
    prefixPath: string,
    slotFile: string,
    cacheKey: string,
    projectRoot: string,
): CacheHealth {
    const health: CacheHealth = {
        cacheKey,
        projectRoot,
        filename: slotFile,
        lastSuccessfulRebuildAt: null,
        pendingActionCount: null,
        malformedActionCount: 0,
        ledgerMissing: false,
        rebuilding: false,
        status: "ready",
    };
    const fail = (message: string) => {
        health.status = "error";
        health.error = health.error ? `${health.error}; ${message}` : message;
    };

    // Pending actions: valid rows only, never deduped. A missing ledger is an
    // explicit zero; any other read failure is an error state, never a zero.
    const ledgerPath = pendingChangesPathFor(prefixPath, slotFile);
    try {
        const parsed = parseChanges(readFileSync(ledgerPath, "utf8"));
        health.pendingActionCount = parsed.changes.length;
        health.malformedActionCount = parsed.skipped;
    } catch (error) {
        if (errorCodeOf(error) === "ENOENT") {
            health.ledgerMissing = true;
            health.pendingActionCount = 0;
        } else {
            fail(`status ledger unreadable: ${messageOf(error)}`);
        }
    }

    // Last successful full rebuild completion (never the mirror mtime or the
    // rebuild-start watermark). A corrupt record is an error, not "none".
    try {
        health.lastSuccessfulRebuildAt = readSuccessfulRebuildAt(prefixPath, slotFile);
    } catch (error) {
        fail(`rebuild record unreadable: ${messageOf(error)}`);
    }

    // A mirror watermark newer than the recorded completion means a rebuild
    // finished (or published) without its completion record: say the record
    // is stale instead of presenting the old time as this rebuild's result.
    // The remote rebuild may well have succeeded — keep that fact in the text.
    try {
        const context = tryResolve(cacheKey);
        const watermark = context ? readCacheWatermark(context.connection) : null;
        const recordedAt = health.lastSuccessfulRebuildAt;
        if (
            watermark &&
            recordedAt &&
            Date.parse(recordedAt) < Date.parse(watermark.rebuiltAt)
        ) {
            fail(
                "completion record stale or unwritten (the remote rebuild may have succeeded; the recorded time predates the current mirror)",
            );
        }
    } catch {
        // The mirror watermark is advisory; a missing mirror is reported below.
    }

    // Mirror: a missing mirror means the cache was never built (or its mirror
    // was lost); an unreadable or structurally invalid mirror is an error
    // state, never a silent "ready" (same validity rule the read path uses).
    // An error state already established wins over "missing".
    try {
        if (!isValidPrefixMirror(readFileSync(prefixPath, "utf8")))
            fail("prefix mirror invalid: not the expected system/user/assistant message array");
    } catch (error) {
        if (errorCodeOf(error) === "ENOENT") {
            if (health.status !== "error") health.status = "missing";
        } else {
            fail(`prefix mirror unreadable: ${messageOf(error)}`);
        }
    }

    try {
        health.rebuilding = cacheLockIsBusy(prefixPath);
    } catch (error) {
        fail(`cache lock state unreadable: ${messageOf(error)}`);
    }
    if (hasPendingWrite(prefixPath) && !health.rebuilding) {
        // Leftover marker with no live operation: an interrupted write. The
        // cache may hold a partial state and needs a confirmed rebuild to
        // recover; the rebuild button must stay usable.
        fail(
            "previous write interrupted (pending recovery): the cache may be partial; a confirmed rebuild is allowed once no rebuild is running",
        );
    }
    return health;
}

function healthOf(context: CacheContext): CacheHealth {
    return healthOfConnection(
        context.connection.prefixPath,
        context.connection.slotFile,
        context.projectRoot,
        context.projectRoot,
    );
}

interface DeclaredStrataTarget {
    project: string;
    slotFile?: string;
    prefixPath?: string;
}

/**
 * Targets declared in the user-level config, straight from the config file
 * (so even an incomplete declaration — missing prefix_path/slot_file — is
 * surfaced instead of vanishing). A MISSING config means no declared targets;
 * a present but unreadable or unparseable config THROWS, so the diagnostic
 * reports the failure instead of masquerading as "no targets configured".
 */
function declaredTargetsFromUserConfig(): DeclaredStrataTarget[] {
    const detected = detectConfigFile(cortexKitUserConfigBasePath());
    if (detected.format === "none") return [];
    const parsed = readJsoncFile<StrataAskConfigSource>(detected.path);
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`user config unreadable or invalid: ${detected.path}`);
    }
    const ask = parsed.memory?.strata_ask;
    if (!ask || ask.enabled === false) return [];
    const targets: DeclaredStrataTarget[] = [];
    if (ask.project) {
        targets.push({
            project: ask.project,
            slotFile: ask.slot_file,
            prefixPath: ask.prefix_path,
        });
    }
    for (const target of ask.targets ?? []) {
        if (target?.project) {
            targets.push({
                project: target.project,
                slotFile: target.slot_file,
                prefixPath: target.prefix_path,
            });
        }
    }
    return targets;
}

function hasLocalProjectConfig(directory: string): boolean {
    try {
        return detectConfigFile(cortexKitProjectConfigBasePath(directory)).format !== "none";
    } catch {
        return false;
    }
}

let discoveryRootsOverride: string[] | null = null;

/** @internal Test seam: isolate zero-arg discovery from the real home directory. */
export function __setStrataHealthDiscoveryRootsForTests(roots: string[] | null): void {
    discoveryRootsOverride = roots;
}

const SCAN_SKIP_DIRECTORIES = new Set(["node_modules"]);

interface ScanCandidates {
    candidates: string[];
    /** Read failures for scan roots (surfaced when nothing could be bound). */
    errors: string[];
}

/**
 * Candidate directories for zero-arg discovery: the configured override (tests),
 * else the home directory and its immediate subdirectories, plus directories
 * recorded in the identity sidecars (projects whose sessions already resolved
 * an identity on this machine — the shallow scan alone cannot find them).
 * Hidden directories and node_modules are skipped; spellings of the same
 * directory are deduped. Every candidate is still validated by resolveContext.
 */
function collectScanCandidates(): ScanCandidates {
    const roots = discoveryRootsOverride ?? [homedir()];
    const candidates: string[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    const push = (directory: string): void => {
        let resolved: string;
        try {
            resolved = resolvePath(directory);
        } catch {
            return;
        }
        if (seen.has(resolved)) return;
        seen.add(resolved);
        candidates.push(resolved);
    };
    for (const root of roots) {
        push(root);
        let entries: Dirent[];
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch (error) {
            errors.push(`${root}: ${messageOf(error)}`);
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".") || SCAN_SKIP_DIRECTORIES.has(entry.name)) continue;
            push(join(root, entry.name));
        }
    }
    for (const directory of recordedIdentityDirectories()) push(directory);
    return { candidates, errors };
}

/**
 * Directories recorded in the identity sidecars (`project-identities/*.json`,
 * `{directory, identity}`). Read-only: damaged or foreign records are skipped,
 * never written or pruned here.
 */
function recordedIdentityDirectories(): string[] {
    const directories: string[] = [];
    let entries: string[];
    try {
        entries = readdirSync(join(getMagicContextStorageDir(), "project-identities"));
    } catch {
        return directories;
    }
    for (const entry of entries) {
        if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
        try {
            const record = JSON.parse(
                readFileSync(
                    join(getMagicContextStorageDir(), "project-identities", entry),
                    "utf8",
                ),
            ) as { directory?: unknown; identity?: unknown };
            if (
                typeof record.directory === "string" &&
                isAbsolute(record.directory) &&
                typeof record.identity === "string" &&
                /^(git|dir):/.test(record.identity)
            ) {
                directories.push(record.directory);
            }
        } catch {
            // A damaged sidecar defers binding; it is not proof of anything.
        }
    }
    return directories;
}

function tryResolve(directory: string): CacheContext | null {
    try {
        // Read-only probe: the health GET must never write the identity sidecar.
        return resolveContext(directory, { cache: false });
    } catch {
        return null;
    }
}

/**
 * Enumerate health entries for every configured strata cache target.
 * Explicit roots keep their legacy behavior (resolvable → entry, otherwise an
 * explicit "unconfigured" entry). Zero-arg mode binds each declared target to
 * a directory ONLY after validating that resolveContext(directory) yields the
 * same project AND the same configured slot file and prefix path — a shallow
 * scan guess or an identity match with a mismatched slot never produces a
 * resettable row. Targets that cannot be bound are shown explicitly as
 * "unconfigured" (not resettable), never with a fabricated directory.
 * Directories whose config declares strata but which no user-config target
 * claims (project-config-only setups) are listed as their own entries.
 */
function enumerateStrataCacheHealth(explicitRoots?: readonly string[]): StrataCacheHealthSnapshot {
    const declared = explicitRoots ? [] : declaredTargetsFromUserConfig();
    const healthByKey = new Map<string, CacheHealth>();

    if (explicitRoots) {
        const seen = new Set<string>();
        for (const root of explicitRoots) {
            if (typeof root !== "string" || root.length === 0) continue;
            const directory = resolvePath(root);
            const context = tryResolve(directory);
            if (!context) {
                if (!healthByKey.has(directory)) {
                    healthByKey.set(
                        directory,
                        unconfiguredEntry(directory, "not a configured strata cache target"),
                    );
                }
                continue;
            }
            // One directory may resolve to the same connection as another
            // (symlink spelling, worktree): list the configured target once.
            const identity = `${context.project}${connectionKey(context)}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            healthByKey.set(directory, healthOf(context));
        }
        return { caches: [...healthByKey.values()] };
    }

    const declaredProjects = new Set(declared.map((target) => target.project));
    const scan = collectScanCandidates();
    const contextsByProject = new Map<string, CacheContext[]>();
    for (const directory of scan.candidates) {
        const context = tryResolve(directory);
        if (!context?.connection) continue;
        const list = contextsByProject.get(context.project) ?? [];
        list.push(context);
        contextsByProject.set(context.project, list);
    }

    const claimed = new Set<CacheContext>();
    for (const target of declared) {
        const matches = (contextsByProject.get(target.project) ?? []).filter(
            (context) =>
                (!target.slotFile || context.connection.slotFile === target.slotFile) &&
                (!target.prefixPath || context.connection.prefixPath === target.prefixPath),
        );
        if (matches.length === 0) {
            const key = `identity:${target.project}`;
            if (healthByKey.has(key)) continue;
            if (!target.prefixPath || !target.slotFile) {
                healthByKey.set(key, {
                    ...unconfiguredEntry(
                        key,
                        `declared strata target lacks prefix_path/slot_file: ${target.project}`,
                    ),
                    projectRoot: "",
                    filename: target.slotFile ?? "",
                });
                continue;
            }
            healthByKey.set(key, {
                ...unconfiguredEntry(
                    key,
                    `declared strata target has no verifiable local directory (identity not bound on this machine): ${target.project}`,
                ),
                projectRoot: "",
                filename: target.slotFile,
            });
            continue;
        }
        // Duplicate identity (repo copies/worktrees): prefer the copy carrying
        // its own project config; otherwise keep the first directory found.
        const chosen =
            matches.find((context) => hasLocalProjectConfig(context.projectRoot)) ?? matches[0]!;
        claimed.add(chosen);
        healthByKey.set(chosen.projectRoot, healthOf(chosen));
    }

    const seenConnections = new Set<string>();
    for (const [project, contexts] of contextsByProject) {
        if (declaredProjects.has(project)) continue;
        for (const context of contexts) {
            if (claimed.has(context)) continue;
            const key = `${context.project}${connectionKey(context)}`;
            if (seenConnections.has(key)) continue;
            seenConnections.add(key);
            if (!healthByKey.has(context.projectRoot)) {
                healthByKey.set(context.projectRoot, healthOf(context));
            }
        }
    }

    const caches = [...healthByKey.values()];
    if (scan.errors.length > 0) {
        // Partial discovery: keep the bound entries AND surface what failed,
        // so one unreadable root never hides behind "some caches showed up".
        return {
            caches,
            error: `directory scan partially failed: ${scan.errors.join("; ")}`,
        };
    }
    return { caches };
}

function connectionKey(context: CacheContext): string {
    const { connection } = context;
    return `\0${connection.prefixPath}\0${connection.slotFile}`;
}

/**
 * Read-only health snapshot for every configured strata cache target. Never
 * throws; a global diagnostic failure returns `{ caches: [], error }` so the
 * caller can keep serving its other fields.
 */
export async function getStrataCacheHealth(
    options: StrataCacheHealthOptions = {},
): Promise<StrataCacheHealthSnapshot> {
    try {
        return enumerateStrataCacheHealth(options.projectRoots);
    } catch (error) {
        return { caches: [], error: messageOf(error) };
    }
}

/** Rebuilds currently running in this process, per cacheKey (duplicate prevention). */
const inFlightRebuilds = new Set<string>();

function leaseDatabase(): Database | null {
    try {
        return openCurrentDatabase();
    } catch {
        return null;
    }
}

/**
 * Full rebuild of one configured cache, through the existing unified write
 * path and under the project memory lease (heartbeat, like the dreamer's cache
 * tasks). Resolves `{ cacheKey }` on success — never an error-shaped object.
 * The cacheKey must be a key the zero-arg discovery BOUND to a directory
 * (unlisted directories of the same project are rejected even when they
 * resolve), and the rebuild runs under the bound project root, not the raw
 * key. Throws `StrataCacheRebuildError` with code `UNKNOWN_CACHE` when the
 * cacheKey is not a discovered rebuildable target, or `BUSY` when a rebuild
 * is already running here, the cache lock is held elsewhere, or the project
 * memory lease is taken; any other failure throws a plain Error describing it.
 */
export async function rebuildStrataCache(cacheKey: string): Promise<{ cacheKey: string }> {
    if (typeof cacheKey !== "string" || cacheKey.length === 0) {
        throw new StrataCacheRebuildError("UNKNOWN_CACHE", "cacheKey must be a non-empty string");
    }
    if (inFlightRebuilds.has(cacheKey)) {
        throw new StrataCacheRebuildError(
            "BUSY",
            "a rebuild for this cache is already running in this process",
        );
    }
    // Only keys the zero-arg discovery actually bound to a directory are
    // rebuildable: an unlisted directory of the same project (a subdirectory,
    // another clone) must not trigger a rebuild under its own spelling. The
    // rebuild uses the discovered entry's bound project root, never the raw key.
    let discoveredRoot: string | null = null;
    try {
        const snapshot = enumerateStrataCacheHealth(undefined);
        const entry = snapshot.caches.find((cache) => cache.cacheKey === cacheKey);
        if (entry && entry.projectRoot) discoveredRoot = entry.projectRoot;
    } catch {
        discoveredRoot = null;
    }
    if (!discoveredRoot) {
        throw new StrataCacheRebuildError(
            "UNKNOWN_CACHE",
            "cacheKey is not a discovered, rebuildable strata cache target",
        );
    }
    const context = tryResolve(discoveredRoot);
    if (!context) {
        throw new StrataCacheRebuildError(
            "UNKNOWN_CACHE",
            "the discovered target no longer resolves to a configured strata cache",
        );
    }
    if (cacheLockIsBusy(context.connection.prefixPath)) {
        throw new StrataCacheRebuildError(
            "BUSY",
            "another process holds this cache's lock (a rebuild or consolidation is running)",
        );
    }
    const db = leaseDatabase();
    if (!db) {
        throw new Error("memory database unavailable; cannot take the project memory lease");
    }
    const leaseKey = leaseKeyFor("strata-cache-maintain", context.project);
    const holderId = `strata-cache-health:${process.pid}:${randomBytes(4).toString("hex")}`;
    const acquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
    if (!acquisition) {
        throw new StrataCacheRebuildError("BUSY", "the project memory lease is held");
    }
    const heartbeat = startLeaseHeartbeat(
        db,
        holderId,
        leaseKey,
        (reason) => log(`strata-cache-health: ${reason}`),
        acquisition,
    );
    inFlightRebuilds.add(cacheKey);
    try {
        if (
            heartbeat.lost ||
            !leaseOwnershipMatches(db, holderId, acquisition.generation, leaseKey)
        ) {
            throw new StrataCacheRebuildError("BUSY", "the project memory lease was lost");
        }
        const result = await rebuildCache(context.projectRoot, "manual-rebuild");
        if (
            heartbeat.lost ||
            !leaseOwnershipMatches(db, holderId, acquisition.generation, leaseKey)
        ) {
            // Mirror the dreamer contract: a lost lease mid-run is a failure
            // even if the remote write landed; recovery is the next rebuild.
            throw new Error("the project memory lease was lost during the rebuild");
        }
        if (result.action === "created" || result.action === "rebuilt") {
            // Pure success shape: no error field, ever. A failed completion
            // record does not fail the rebuild (the remote write succeeded);
            // the health read flags the stale record on its next pass.
            return { cacheKey };
        }
        if (result.action === "disabled") {
            throw new StrataCacheRebuildError("UNKNOWN_CACHE", result.detail);
        }
        throw new Error(`${result.action}: ${result.detail}`);
    } finally {
        inFlightRebuilds.delete(cacheKey);
        heartbeat.stop();
        releaseLease(db, holderId, leaseKey);
    }
}
