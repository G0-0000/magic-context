/**
 * Worker entry for the canonical-ordinal warm-up: scans one OpenCode session's
 * messages for compaction-summary rows on its own read-only connection, so the
 * serving thread never reads a whole session's message JSON. See
 * `raw-ordinal-warmup.ts` for the caller.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { RawOrdinalWarmupInput, RawOrdinalWarmupReply } from "./raw-ordinal-warmup";

const port = parentPort;
if (!port) throw new Error("raw ordinal warm-up worker requires a parent port");
const input = workerData as RawOrdinalWarmupInput;
// Report that the thread runs before importing the SQLite and scan modules, so
// the caller's first deadline only has to cover thread start.
port.postMessage({ kind: "accepted" } satisfies RawOrdinalWarmupReply);
const [{ Database }, { scanRawSessionSummaryRows }] = await Promise.all([
    import("../../shared/sqlite"),
    import("./read-session-raw"),
]);
let db: InstanceType<typeof Database> | undefined;
let reply: RawOrdinalWarmupReply;
try {
    db = input.indexMessage
        ? new Database(input.path)
        : new Database(input.path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250");
    if (input.indexMessage) {
        const { setHarness } = await import("../../shared/harness");
        setHarness(input.harness ?? "opencode");
        const [
            { indexSingleMessage },
            { configureContextDatabasePragmas },
            { withSqliteBackgroundWriter, registerSqliteDiagnosticSink },
        ] = await Promise.all([
            import("../../features/magic-context/message-index"),
            import("../../shared/sqlite-context-pragmas"),
            import("../../shared/sqlite"),
        ]);
        const { log } = await import("../../shared/logger");
        registerSqliteDiagnosticSink(log);
        configureContextDatabasePragmas(db);
        const writer = db;
        const message = input.indexMessage;
        const cancellation = input.indexCancellation
            ? new Int32Array(input.indexCancellation)
            : undefined;
        const inserted = withSqliteBackgroundWriter(() =>
            indexSingleMessage(
                writer,
                input.sessionId,
                message,
                () => !cancellation || Atomics.load(cancellation, 0) === 0,
            ),
        );
        reply = { kind: "indexed", inserted };
    } else if (input.tagRatio !== undefined) {
        const { scanTagOwnerSummary, scanTagOwnerDelta } = await import(
            "../../features/magic-context/storage-tags"
        );
        const delta = input.tagState
            ? scanTagOwnerDelta(db, input.sessionId, input.tagState)
            : null;
        if (delta) reply = { kind: "tag-delta", delta };
        else
            reply = {
                kind: "tag-summary",
                summary: scanTagOwnerSummary(db, input.sessionId, input.tagRatio, input.tagRatios),
            };
    } else {
        const scan = scanRawSessionSummaryRows(db, input.sessionId, input.previous);
        reply = { kind: "scan", scan };
    }
} catch (error) {
    reply = {
        kind: "error",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
} finally {
    db?.close();
}
// Release SQLite before publishing: the host may stop the worker on receipt.
port.postMessage(reply);
port.close();
