import { Database } from "../../shared/sqlite";
import { fitHistorianPrompt } from "./historian-prompt-fit";
import type { HistorianReadResult, HistorianReadTask } from "./historian-start-read";
import { prepareHistorianSource } from "./historian-start-read";
import { readBoundarySnapshotRawState, resolveOpenCodeProtectedTailBoundary } from "./protected-tail-boundary";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    readRawSessionMessageIdOrdinalsForRangeFromDb,
    readRawSessionMessagePageFromDb,
    readRawSessionMessagesFromDb,
    scanRawSessionSummaryRows,
} from "./read-session-raw";

/** Each request uses a fresh read transaction; no ranks or answers survive it. */
export async function readHistorianStartOnWorker(
    db: Database,
    sessionId: string,
    task: HistorianReadTask,
    generation: "v1" | "v2" = "v1",
): Promise<HistorianReadResult> {
    const run = (): HistorianReadResult => {
        if (task.kind === "refresh") {
            const context = new Database(task.contextPath, { readonly: true });
            try {
                return { kind: "refresh", snapshot: resolveOpenCodeProtectedTailBoundary({ ...task.args, db: context }) };
            } finally { context.close(); }
        }
        const rawState = readBoundarySnapshotRawState(task.snapshot);
        const promptFit = fitHistorianPrompt(task.fit);
        const chunk = promptFit.ok ? readSessionChunk(sessionId, promptFit.chunkTokens, task.offset, task.snapshot.eligibleEndOrdinal, { expandTools: task.expandTools }) : null;
        return { kind: "start", rawState, promptFit, chunk, source: chunk && promptFit.ok ? prepareHistorianSource(chunk, promptFit, task.fit.window) : null };
    };
    if (generation === "v2") {
        const { V2StoreReader } = await import("../../v2/store-reader");
        const { rawMessagePage } = await import("../../v2/hooks/store");
        const reader = new V2StoreReader(db.name);
        try {
            return reader.withReadSnapshot(() => withRawMessageProvider(sessionId, {
                readMessages: () => { throw new Error("historian worker requires bounded v2 reads"); },
                getMessageCount: () => reader.messageCount(sessionId),
                readMessagePage: (after, limit, watermark, anchor) => rawMessagePage(reader.messagePage(sessionId, after, limit, watermark, anchor), after),
                readMessageIdOrdinalsForRange: (from, to) => reader.messageIdOrdinals(sessionId, from, to),
            }, run));
        } finally { reader.close(); }
    }
    return db.transaction(() => {
        installRawSessionSummaryScan(db, sessionId, scanRawSessionSummaryRows(db, sessionId), getRawSessionSummaryEpoch(sessionId), true);
        return withRawMessageProvider(sessionId, {
            readMessages: () => readRawSessionMessagesFromDb(db, sessionId),
            getMessageCount: () => countRawSessionMessageOrdinalsFromDb(db, sessionId),
            readMessagePage: (after, limit, watermark, anchor) => readRawSessionMessagePageFromDb(db, sessionId, after, limit, watermark, anchor),
            readMessageIdOrdinalsForRange: (from, to) => readRawSessionMessageIdOrdinalsForRangeFromDb(db, sessionId, from, to),
        }, run);
    })();
}
