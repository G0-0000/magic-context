import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import { log } from "../../shared/logger";
import { type Database, getSqliteDatabasePath, type Statement } from "../../shared/sqlite";

interface MarkerStamp {
    dataVersion: number;
    totalChanges: number;
    schemaVersion: number;
}
export interface MarkerCandidateBasis {
    ids: string[];
    connection: Database;
    stamp: MarkerStamp;
}
export interface MarkerCandidatePreparationOptions {
    entry?: URL;
    acceptMs?: number;
    resultMs?: number;
}
export type MarkerCandidateReply =
    | { kind: "accepted" }
    | { kind: "candidates"; ids: string[] }
    | { kind: "error"; error: string };

const candidates = new WeakMap<Database, Map<string, MarkerCandidateBasis>>();
const pending = new WeakMap<Database, Map<string, Promise<boolean>>>();
const workers = new Set<Worker>();
const missingWorkerWarnings = new Set<string>();
let exitRegistered = false;

function markerStamp(db: Database): MarkerStamp | undefined {
    let statement: Statement | undefined;
    try {
        statement = db.prepare(`SELECT data_version AS dataVersion, total_changes() AS totalChanges,
            (SELECT schema_version FROM pragma_schema_version) AS schemaVersion FROM pragma_data_version`);
        return statement.get() as MarkerStamp | undefined;
    } catch {
        return undefined;
    } finally {
        (statement as unknown as { finalize?: () => void } | undefined)?.finalize?.();
    }
}
function sameStamp(before: MarkerStamp | undefined, after: MarkerStamp | undefined): boolean {
    return (
        !!before &&
        !!after &&
        before.dataVersion === after.dataVersion &&
        before.totalChanges === after.totalChanges &&
        before.schemaVersion === after.schemaVersion
    );
}
export function isMarkerCandidateBasisCurrent(db: Database, basis: MarkerCandidateBasis): boolean {
    return basis.connection === db && sameStamp(basis.stamp, markerStamp(db));
}
export function readMarkerCandidateBasis(
    db: Database,
    sessionId: string,
): MarkerCandidateBasis | undefined {
    const basis = candidates.get(db)?.get(sessionId);
    if (basis && isMarkerCandidateBasisCurrent(db, basis)) return basis;
    candidates.get(db)?.delete(sessionId);
    return undefined;
}

/** Capture peer commits, local writes and schema changes on the marker's SQLite
 * connection before scanning on a worker. Reuse the discovered summary IDs only
 * if those counters still match; they do not certify message-number assignments.
 * A mismatch leaves the existing marker intact. A later history rebuild retries
 * discovery when it requests a marker advance, rather than retrying every turn. */
export function prepareMarkerCandidateBasis(
    db: Database,
    sessionId: string,
    options: MarkerCandidatePreparationOptions = {},
): Promise<boolean> {
    if (readMarkerCandidateBasis(db, sessionId)) return Promise.resolve(true);
    const path = getSqliteDatabasePath(db);
    if (!path || db.inTransaction) return Promise.resolve(false);
    const active = pending.get(db) ?? new Map<string, Promise<boolean>>();
    const existing = active.get(sessionId);
    if (existing) return existing;
    const before = markerStamp(db);
    if (!before) return Promise.resolve(false);
    const entry = options.entry ?? markerWorkerEntry();
    if (entry.protocol === "file:" && !existsSync(fileURLToPath(entry))) {
        if (!missingWorkerWarnings.has(entry.href)) {
            missingWorkerWarnings.add(entry.href);
            log(
                `[magic-context] compaction-marker: missing candidate worker ${fileURLToPath(entry)}; marker unchanged, advancement deferred`,
            );
        }
        return Promise.resolve(false);
    }
    const preparation = runCandidateWorker(path, sessionId, options)
        .then((ids) => {
            if (!ids || !sameStamp(before, markerStamp(db))) {
                candidates.get(db)?.delete(sessionId);
                log(
                    `[magic-context] compaction-marker: deferred candidate preparation for ${sessionId}: ${ids ? "host store changed during discovery" : "candidate worker unavailable"}; marker unchanged`,
                );
                return false;
            }
            const sessions = candidates.get(db) ?? new Map<string, MarkerCandidateBasis>();
            sessions.set(sessionId, { ids, connection: db, stamp: before });
            candidates.set(db, sessions);
            return true;
        })
        .finally(() => {
            if (active.get(sessionId) === preparation) active.delete(sessionId);
        });
    active.set(sessionId, preparation);
    pending.set(db, active);
    return preparation;
}

function markerWorkerEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./compaction-marker-candidates-worker.ts"
            : "./compaction-marker-candidates-worker.js",
        import.meta.url,
    );
}

function runCandidateWorker(
    path: string,
    sessionId: string,
    options: MarkerCandidatePreparationOptions,
): Promise<string[] | undefined> {
    if (!exitRegistered) {
        exitRegistered = true;
        const controller = new AbortController();
        controller.signal.addEventListener(
            "abort",
            () => {
                for (const worker of workers) {
                    void worker.terminate();
                    worker.unref();
                }
            },
            { once: true },
        );
        registerExitAbort(controller);
    }
    return new Promise((resolve) => {
        let worker: Worker | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const finish = (ids?: string[]) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (!worker) {
                resolve(ids);
                return;
            }
            workers.delete(worker);
            const stopped = worker.terminate();
            worker.unref();
            void stopped.finally(() => resolve(ids));
        };
        const deadline = (ms: number) => {
            clearTimeout(timer);
            timer = setTimeout(() => finish(), ms);
            timer.unref?.();
        };
        try {
            const entry = options.entry ?? markerWorkerEntry();
            worker = new Worker(entry, { workerData: { path, sessionId } });
            workers.add(worker);
            worker.unref();
            deadline(options.acceptMs ?? 2000);
            worker.on("message", (reply: MarkerCandidateReply) => {
                if (reply.kind === "accepted") deadline(options.resultMs ?? 600000);
                else if (reply.kind === "candidates") finish(reply.ids);
                else finish();
            });
            worker.on("error", () => finish());
            worker.on("exit", () => finish());
        } catch {
            finish();
        }
    });
}

/** Find all messages with the summary flag on a worker. Marker cleanup then
 * checks each ID's parent, completion status and exact text before deleting it.
 * Do not filter by creation time: imported or rewritten legacy summaries can
 * precede their parent even though the original writer used later timestamps. */
export function scanMarkerSummaryCandidates(db: Database, sessionId: string): string[] {
    db.exec("BEGIN");
    try {
        return (
            db
                .prepare(`SELECT id FROM message WHERE session_id=? AND
            CASE WHEN json_valid(data) THEN COALESCE(json_extract(data,'$.summary'),0) ELSE 0 END=1`)
                .all(sessionId) as { id: string }[]
        ).map((row) => row.id);
    } finally {
        db.exec("ROLLBACK");
    }
}
