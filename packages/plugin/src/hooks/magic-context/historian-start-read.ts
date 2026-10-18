import type { ToolExpansionMap } from "../../shared/historian-tool-template";
import { isDeepStrictEqual } from "node:util";
import { sessionLog } from "../../shared/logger";
import { getSqliteDatabasePath } from "../../shared/sqlite";
import type { HistorianPromptFit, HistorianPromptFitArgs } from "./historian-prompt-fit";
import { fitHistorianPrompt } from "./historian-prompt-fit";
import type { BoundarySnapshotRawState, ProtectedTailBoundarySnapshot, resolveBoundaryContext } from "./protected-tail-boundary";
import { readBoundarySnapshotRawState, resolveOpenCodeProtectedTailBoundary } from "./protected-tail-boundary";
import { runSessionWarmupWorker } from "./raw-ordinal-warmup";
import { getHistorianReadSource, hasRawMessageProvider, readSessionChunk, type SessionChunk } from "./read-session-chunk";
import { openCodeDbExists, withReadOnlySessionDb } from "./read-session-db";
import { RawOrdinalsNotReady } from "./read-session-raw";
import { estimateTokens } from "./read-session-formatting";
import { fitAtomicHistorianSourceToProducerWindow } from "./producer-window-guard";

type SerializableFit = Omit<HistorianPromptFitArgs, "memories"> & {
    memories: Exclude<HistorianPromptFitArgs["memories"], () => unknown>;
};
export type HistorianReadTask = {
    kind: "start";
    snapshot: ProtectedTailBoundarySnapshot;
    fit: SerializableFit;
    offset: number;
    expandTools?: ToolExpansionMap;
} | {
    kind: "refresh";
    contextPath: string;
    args: Omit<Parameters<typeof resolveBoundaryContext>[0], "db">;
};
export type HistorianReadResult = {
    kind: "start";
    rawState: BoundarySnapshotRawState;
    promptFit: HistorianPromptFit;
    chunk: SessionChunk | null;
    source: ReturnType<typeof prepareHistorianSource> | null;
} | { kind: "refresh"; snapshot: ProtectedTailBoundarySnapshot };

export function prepareHistorianSource(chunk: SessionChunk, fit: Extract<HistorianPromptFit, { ok: true }>, window: HistorianPromptFitArgs["window"]) {
    const atomic = chunk.oversizeAtomicUnit ? fitAtomicHistorianSourceToProducerWindow({
        text: chunk.text, resultBoundaries: chunk.toolResultBoundaries,
        contextLimitTokens: window.contextLimitTokens, inputLimitTokens: window.inputLimitTokens,
        maxOutputTokens: window.maxOutputTokens, maxSourceTokens: fit.roomTokens,
    }) : null;
    let text = atomic?.text ?? chunk.text;
    if (!chunk.oversizeAtomicUnit && estimateTokens(text) > fit.chunkTokens) {
        let lo = 0;
        let hi = text.length;
        let best = 0;
        const marker = "\n[… tokens truncated by Magic Context to fit the historian window …]";
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (estimateTokens(text.slice(0, mid) + marker) <= fit.chunkTokens) { best = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        text = text.slice(0, best) + marker;
    }
    return { text, tokens: estimateTokens(text), atomic };
}

export const HISTORIAN_START_DEFER_PASS_CAP = 8;
type OutstandingRead = {
    sessionId: string;
    task: HistorianReadTask;
    passes: number;
    abandoned: boolean;
    cancel: () => void;
    result: Promise<HistorianReadResult>;
};
const capLogged = new Set<string>();
const inFlight = new Map<string, OutstandingRead>();

/** Called by the synchronous trigger, without awaiting or changing its decision snapshot. */
export function noteHistorianStartPass(sessionId: string): void {
    for (const read of inFlight.values()) {
        if (read.sessionId !== sessionId || read.abandoned || ++read.passes < HISTORIAN_START_DEFER_PASS_CAP) continue;
        if (!capLogged.has(sessionId)) {
            capLogged.add(sessionId);
            sessionLog(sessionId, `historian start deferred for ${HISTORIAN_START_DEFER_PASS_CAP} passes; abandoning this start while its exact read finishes`);
        }
        read.abandoned = true;
        read.cancel();
    }
}

/** Shares only outstanding requests. A completed answer is never used by another pass. */
export async function readHistorianStart(
    sessionId: string,
    task: HistorianReadTask,
): Promise<HistorianReadResult> {
    // Registered providers include Pi and in-memory test stores, which a separate
    // SQLite connection cannot read. Their existing synchronous semantics stay intact.
    const source = getHistorianReadSource(sessionId);
    if (!source && (hasRawMessageProvider(sessionId) || !openCodeDbExists())) {
        if (task.kind === "refresh") throw new RawOrdinalsNotReady();
        const rawState = readBoundarySnapshotRawState(task.snapshot);
        const promptFit = fitHistorianPrompt(task.fit);
        const chunk = promptFit.ok ? readSessionChunk(sessionId, promptFit.chunkTokens, task.offset, task.snapshot.eligibleEndOrdinal, { expandTools: task.expandTools }) : null;
        return { kind: "start", rawState, promptFit, chunk, source: chunk && promptFit.ok ? prepareHistorianSource(chunk, promptFit, task.fit.window) : null };
    }
    const path = source?.path ?? withReadOnlySessionDb(getSqliteDatabasePath);
    if (!path) throw new RawOrdinalsNotReady();
    const range = task.kind === "start" ? [task.snapshot.offset, task.snapshot.rawMessageCountAtTrigger] : ["refresh"];
    const key = JSON.stringify([path, source?.generation ?? "v1", sessionId, range]);
    const existing = inFlight.get(key);
    if (existing) {
        if (existing.abandoned || !isDeepStrictEqual(existing.task, task)) throw new RawOrdinalsNotReady();
        return existing.result;
    }
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new RawOrdinalsNotReady());
    });
    const worker = runSessionWarmupWorker({ path, sessionId, historian: task, historianGeneration: source?.generation }, { resultMs: 30_000 });
    const request: OutstandingRead = {
        sessionId, task, passes: 0, abandoned: false, cancel,
        result: Promise.race([
            worker.then((reply) => {
                if (!("historian" in reply)) throw new RawOrdinalsNotReady();
                return reply.historian;
            }),
            cancelled,
        ]),
    };
    inFlight.set(key, request);
    // Keep abandoned work registered until its thread exits. A later pass must
    // not spawn a duplicate scan or consume the abandoned pass's answer.
    void worker.finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key);
    });
    return request.result;
}

export async function refreshHistorianBoundary(
    args: Parameters<typeof resolveBoundaryContext>[0],
): Promise<ProtectedTailBoundarySnapshot> {
    if (hasRawMessageProvider(args.sessionId) && !getHistorianReadSource(args.sessionId)) return resolveOpenCodeProtectedTailBoundary(args);
    const contextPath = getSqliteDatabasePath(args.db);
    if (!contextPath) throw new RawOrdinalsNotReady();
    const { db: _, ...input } = args;
    const result = await readHistorianStart(args.sessionId, { kind: "refresh", contextPath, args: input });
    if (result.kind !== "refresh") throw new RawOrdinalsNotReady();
    return result.snapshot;
}
