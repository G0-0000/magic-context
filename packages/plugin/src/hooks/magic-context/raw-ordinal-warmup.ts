/**
 * Off-thread warm-up for canonical ordinal counts.
 *
 * Counting a session's canonical ordinals needs the ids of its compaction
 * summary rows (see `countCanonicalOrdinalsIndexed` in read-session-raw.ts).
 * Finding them the first time means reading every message's JSON once, which
 * takes seconds on a large, cold OpenCode store. This module does that scan on
 * a worker thread with its own read-only connection and installs the result on
 * the serving connection. Synchronous lookups use rank checkpoints and a bounded
 * suffix. After a commit the worker updates the candidates and rebuilds ranks;
 * the serving thread never recounts the whole prefix.
 *
 * Callers on the transform path await {@link prewarmRawSessionOrdinalsForDb}
 * before their synchronous counts. Background callers (message indexing)
 * reschedule when it reports "failed". A failed worker is not retried for the
 * same session until FAILURE_BACKOFF_MS has passed.
 */
import { Worker } from "node:worker_threads";
import type {
    TagOwnerDelta,
    TagOwnerSummary,
    TagOwnerWarmupState,
} from "../../features/magic-context/storage-tags";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import type { HarnessId } from "../../shared/harness";
import { log } from "../../shared/logger";
import { type Database, getSqliteDatabasePath } from "../../shared/sqlite";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    isRawSessionSummaryWarm,
    type RawMessage,
    type RawSessionSummaryScan,
    rawOrdinalStoreStamp,
    rawOrdinalSummarySeed,
} from "./read-session-raw";

export interface RawOrdinalWarmupInput {
    path: string;
    sessionId: string;
    tagRatio?: number;
    tagRatios?: number[];
    tagState?: TagOwnerWarmupState;
    indexMessage?: RawMessage;
    previous?: RawSessionSummaryScan;
    harness?: HarnessId;
    indexCancellation?: SharedArrayBuffer;
}

export type RawOrdinalWarmupReply =
    | { kind: "accepted" }
    | { kind: "scan"; scan: RawSessionSummaryScan }
    | { kind: "tag-summary"; summary: TagOwnerSummary }
    | { kind: "tag-delta"; delta: TagOwnerDelta }
    | { kind: "indexed"; inserted: boolean }
    | { kind: "error"; error: string };

/**
 * "warm": this connection has valid rank checkpoints. "failed": the
 * off-thread scan could not be completed or installed.
 */
export type RawOrdinalWarmupOutcome = "warm" | "failed";

export type RawOrdinalWarmupFailureReason =
    | "start-failed"
    | "not-accepted"
    | "no-result"
    | "worker-error"
    | "exited"
    | "stopped"
    | "superseded";

export interface RawOrdinalWarmupOptions {
    entry?: URL;
    /** @deprecated File stores always scan off-thread; retained for old callers. */
    inThreadMaxRows?: number;
    acceptMs?: number;
    resultMs?: number;
}

/** Thread start only: the worker reports before loading any module. */
const ACCEPT_TIMEOUT_MS = 2_000;
/** A cold scan of a session of hundreds of thousands of messages on a large store. */
const RESULT_TIMEOUT_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

const inFlight = new Map<string, SharedScan>();
const connectionIds = new WeakMap<Database, number>();
let nextConnectionId = 0;
const failedAt = new Map<string, number>();
const activeWorkers = new Map<Worker, (reason: RawOrdinalWarmupFailureReason) => void>();
const failures = new Map<RawOrdinalWarmupFailureReason, number>();
let exitHookRegistered = false;

/** How often each reason left a session without an off-thread scan, in this process. */
export function getRawOrdinalWarmupFailures(): ReadonlyMap<RawOrdinalWarmupFailureReason, number> {
    return failures;
}

/** Stop every running warm-up worker; their callers see "failed". */
export function stopRawSessionOrdinalWarmups(): void {
    for (const stop of [...activeWorkers.values()]) stop("stopped");
}

/** @internal */
export function resetRawSessionOrdinalWarmupsForTest(): void {
    stopRawSessionOrdinalWarmups();
    inFlight.clear();
    failedAt.clear();
    failures.clear();
}

function defaultEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./raw-ordinal-warmup-worker.ts"
            : "./raw-ordinal-warmup-worker.js",
        import.meta.url,
    );
}

function ensureExitHook(): void {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", stopRawSessionOrdinalWarmups, { once: true });
    registerExitAbort(controller);
}

export function runSessionWarmupWorker(
    input: RawOrdinalWarmupInput,
    options: RawOrdinalWarmupOptions,
): Promise<WorkerResult> {
    ensureExitHook();
    return new Promise((resolve) => {
        let worker: Worker | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (
            result:
                | { scan: RawSessionSummaryScan }
                | { summary: TagOwnerSummary }
                | { delta: TagOwnerDelta }
                | { inserted: boolean }
                | { failure: RawOrdinalWarmupFailureReason; detail: string },
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (worker) {
                activeWorkers.delete(worker);
                void worker.terminate();
                worker.unref();
            }
            resolve(result);
        };
        const arm = (failure: RawOrdinalWarmupFailureReason, ms: number) => {
            clearTimeout(deadline);
            deadline = setTimeout(
                () => finish({ failure, detail: `no reply within ${ms} ms` }),
                ms,
            );
            deadline.unref?.();
        };
        try {
            worker = new Worker(options.entry ?? defaultEntry(), { workerData: input });
        } catch (error) {
            finish({ failure: "start-failed", detail: String(error) });
            return;
        }
        // Never keep the host process alive for a warm-up.
        worker.unref();
        activeWorkers.set(worker, (failure) => finish({ failure, detail: "stopped" }));
        arm("not-accepted", options.acceptMs ?? ACCEPT_TIMEOUT_MS);
        worker.on("message", (reply: RawOrdinalWarmupReply) => {
            if (reply.kind === "accepted") arm("no-result", options.resultMs ?? RESULT_TIMEOUT_MS);
            else if (reply.kind === "scan") finish({ scan: reply.scan });
            else if (reply.kind === "tag-summary") finish({ summary: reply.summary });
            else if (reply.kind === "tag-delta") finish({ delta: reply.delta });
            else if (reply.kind === "indexed") finish({ inserted: reply.inserted });
            else finish({ failure: "worker-error", detail: reply.error });
        });
        worker.on("error", (error) => finish({ failure: "worker-error", detail: String(error) }));
        worker.on("exit", (code) => finish({ failure: "exited", detail: `exit code ${code}` }));
    });
}

/**
 * Make the next canonical count of `sessionId` on `db` free of a full scan.
 *
 * Already warm: returns at once. File stores always use the worker, including
 * sessions opened long after process startup. In-memory stores keep the direct
 * path because a second connection cannot see them. The worker also builds rank
 * checkpoints, so no file-store prefix or total count runs on the host thread.
 * Checkpoints are installed only if this connection's store stamp and session
 * epoch still match those captured before worker start. Concurrent requests on
 * the same connection share one worker; separate connections use separate scans
 * because data_version is connection-local and cannot certify a shared snapshot.
 * A superseded scan is retryable immediately; other failures back off.
 */
export function prewarmRawSessionOrdinalsForDb(
    db: Database,
    sessionId: string,
    options: RawOrdinalWarmupOptions = {},
): Promise<RawOrdinalWarmupOutcome> {
    if (isRawSessionSummaryWarm(db, sessionId)) return Promise.resolve("warm");
    if (
        !db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE name = 'message' AND type IN ('table', 'view')",
            )
            .get()
    )
        return Promise.resolve("warm");
    const path = getSqliteDatabasePath(db);
    if (!path) {
        countRawSessionMessageOrdinalsFromDb(db, sessionId);
        return Promise.resolve("warm");
    }
    let connectionId = connectionIds.get(db);
    if (connectionId === undefined) {
        connectionId = ++nextConnectionId;
        connectionIds.set(db, connectionId);
    }
    const key = `${path}\0${sessionId}\0${connectionId}`;
    let shared = inFlight.get(key);
    if (!shared) {
        const failed = failedAt.get(key);
        if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS)
            return Promise.resolve("failed");
        const epoch = getRawSessionSummaryEpoch(sessionId);
        const stamp = rawOrdinalStoreStamp(db);
        const started = performance.now();
        // A worker failure is recorded once, however many connections await it.
        const result = runSessionWarmupWorker(
            { path, sessionId, previous: rawOrdinalSummarySeed(db, sessionId) },
            options,
        )
            .then((outcome) => {
                if ("failure" in outcome)
                    recordFailure(key, sessionId, outcome.failure, outcome.detail);
                return outcome;
            })
            .finally(() => {
                if (inFlight.get(key) === scan) inFlight.delete(key);
            });
        const scan: SharedScan = { epoch, started, result, stamp };
        inFlight.set(key, scan);
        shared = scan;
    }
    const awaited = shared;
    // The stamp was captured on this exact connection before worker start.
    return awaited.result.then((result): RawOrdinalWarmupOutcome => {
        if (!("scan" in result)) return "failed";
        try {
            if (
                installRawSessionSummaryScan(
                    db,
                    sessionId,
                    result.scan,
                    awaited.epoch,
                    awaited.stamp,
                )
            ) {
                failedAt.delete(key);
                log(
                    `[magic-context] canonical ordinals of ${sessionId} warmed off-thread (${result.scan.sessionRows} messages, ${Math.round(performance.now() - awaited.started)} ms)`,
                );
                return "warm";
            }
        } catch {
            // The connection was closed or replaced while the worker ran.
        }
        recordFailure(
            key,
            sessionId,
            "superseded",
            `store changed during scan: before=${JSON.stringify(awaited.stamp)} after=${JSON.stringify(rawOrdinalStoreStamp(db))}; epoch=${awaited.epoch}/${getRawSessionSummaryEpoch(sessionId)}`,
        );
        return "failed";
    });
}

type WorkerResult =
    | { scan: RawSessionSummaryScan }
    | { summary: TagOwnerSummary }
    | { delta: TagOwnerDelta }
    | { inserted: boolean }
    | { failure: RawOrdinalWarmupFailureReason; detail: string };

/** One worker scan of a store and session, shared by every connection that asks meanwhile. */
interface SharedScan {
    stamp: ReturnType<typeof rawOrdinalStoreStamp>;
    /** The session's summary epoch when the scan started; a later epoch makes it stale. */
    epoch: number;
    started: number;
    result: Promise<WorkerResult>;
}

function recordFailure(
    key: string,
    sessionId: string,
    failure: RawOrdinalWarmupFailureReason,
    detail: string,
): void {
    failures.set(failure, (failures.get(failure) ?? 0) + 1);
    // A superseded scan is not a broken worker: the next call may try again.
    if (failure !== "superseded") failedAt.set(key, Date.now());
    log(
        `[magic-context] WARN canonical ordinal warm-up failed for ${sessionId} (${failure}: ${detail}); counts remain bounded and callers must defer or retry`,
    );
}
