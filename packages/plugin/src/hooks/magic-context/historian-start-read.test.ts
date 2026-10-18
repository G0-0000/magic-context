import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { contextStore, fixture, hostStore, messageId, SESSION } from "../../features/magic-context/__tests__/host-stalls.fixture";
import { getHistorianFailureState, getOrCreateSessionMeta, loadProtectedTailMeta } from "../../features/magic-context/storage";
import { Database } from "../../shared/sqlite";
import { runCompartmentAgent } from "./compartment-runner-incremental";
import type { HiddenCompartmentRunnerDeps } from "./compartment-runner-types";
import { HISTORIAN_START_DEFER_PASS_CAP, noteHistorianStartPass, readHistorianStart, type HistorianReadTask } from "./historian-start-read";
import { readBoundarySnapshotRawState } from "./protected-tail-boundary";
import { resetRawSessionOrdinalWarmupsForTest } from "./raw-ordinal-warmup";
import { readSessionChunk, withRawMessageProvider, type RawMessageProvider } from "./read-session-chunk";
import { countRawSessionMessageOrdinalsFromDb, getRawSessionSummaryEpoch, installRawSessionSummaryScan, RawOrdinalsNotReady, readRawSessionMessageIdOrdinalsForRangeFromDb, readRawSessionMessagePageFromDb, scanRawSessionSummaryRows } from "./read-session-raw";

afterEach(() => resetRawSessionOrdinalWarmupsForTest());

function provider(db: Database, path: string): RawMessageProvider {
    installRawSessionSummaryScan(db, SESSION, scanRawSessionSummaryRows(db, SESSION), getRawSessionSummaryEpoch(SESSION), true);
    return {
        historianReadSource: () => ({ path, generation: "v1" }),
        readMessages: () => { throw new Error("bounded reads only"); },
        getMessageCount: () => countRawSessionMessageOrdinalsFromDb(db, SESSION),
        readMessagePage: (after, limit, end, anchor) => readRawSessionMessagePageFromDb(db, SESSION, after, limit, end, anchor),
        readMessageIdOrdinalsForRange: (from, to) => readRawSessionMessageIdOrdinalsForRangeFromDb(db, SESSION, from, to),
    };
}

function task(offset: number, count: number): Extract<HistorianReadTask, { kind: "start" }> {
    return {
        kind: "start", offset,
        snapshot: {
            sessionId: SESSION, mode: "incremental-runner", offset,
            offsetMessageId: messageId(offset - 1),
            protectedTailStart: count - 3, protectedTailStartMessageId: messageId(count - 4),
            eligibleEndOrdinal: count - 3, eligibleEndMessageId: messageId(count - 5),
            rawMessageCountAtTrigger: count, rawLastMessageIdAtTrigger: messageId(count - 1),
            N: 0, usagePercentage: 0, usageInputTokens: 0, usageSource: "provisional-zero",
            contextLimit: 128000, executeThresholdPercentage: 65, triggerBudget: 1000,
            priorBoundaryOrdinal: count - 3, migrationFloorActive: false,
            providerShapeVersion: "opencode-v1", cacheNamespace: `test:${SESSION}`,
            createdAt: Date.now(), rawRangeFingerprint: "", trueRawEligibleTokens: 1000,
            oversizeAtomicUnit: false, boundaryReason: "test-legacy",
        },
        fit: { window: { maxOutputTokens: 4096 }, systemPrompt: "Summarize", requestedChunkTokens: 2000, sessionId: SESSION, chunkStart: offset, lastOrdinal: count - 4, sessionCompartments: [], memories: [], memoryEnabled: false },
    };
}

it("concurrent exact historian requests share only outstanding work and interior edits stay fresh", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const db = hostStore(path, 80);
    try {
        await withRawMessageProvider(SESSION, provider(db, path), async () => {
            const input = task(60, 80);
            const first = readHistorianStart(SESSION, input);
            const second = readHistorianStart(SESSION, input);
            expect(await first).toBe(await second);
            db.prepare("UPDATE message SET time_created=1 WHERE id=?").run(messageId(70));
            const next = await readHistorianStart(SESSION, input);
            expect(next.kind).toBe("start");
            if (next.kind !== "start") throw new Error("wrong worker result");
            expect(next.rawState.ids).toEqual(readBoundarySnapshotRawState(input.snapshot).ids);
            expect(next.rawState.ids.get(60)).not.toBe((await first).kind === "start" ? ((await first) as typeof next).rawState.ids.get(60) : null);
            expect(next.chunk).toEqual(readSessionChunk(SESSION, 2000, 60, 77));
        });
    } finally { db.close(); f.cleanup(); }
});

it("historian start abandons after eight deferred passes without reusing its outstanding result", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const db = hostStore(path, 80);
    try {
        await withRawMessageProvider(SESSION, provider(db, path), async () => {
            const input = task(60, 80);
            const request = readHistorianStart(SESSION, input);
            for (let i = 0; i < HISTORIAN_START_DEFER_PASS_CAP; i++) noteHistorianStartPass(SESSION);
            await expect(request).rejects.toBeInstanceOf(RawOrdinalsNotReady);
            await expect(readHistorianStart(SESSION, input)).rejects.toBeInstanceOf(RawOrdinalsNotReady);
        });
    } finally { resetRawSessionOrdinalWarmupsForTest(); db.close(); f.cleanup(); }
});

it("historian not-ready is a no-op without failure, backoff or error notification", async () => {
    const f = fixture();
    const db = contextStore(join(f.dir, "context.db"));
    const raw = hostStore(join(f.dir, "opencode.db"), 10);
    try {
        const p = provider(raw, join(f.dir, "missing.db"));
        await withRawMessageProvider(SESSION, p, async () => {
            const snapshot = task(1, 10).snapshot;
            await runCompartmentAgent({ client: undefined, db, sessionId: SESSION, boundarySnapshot: snapshot, historianChunkTokens: 2000, directory: f.dir, memoryEnabled: false });
            expect(getHistorianFailureState(db, SESSION).failureCount).toBe(0);
            expect(getOrCreateSessionMeta(db, SESSION).compartmentInProgress).toBe(false);
            expect(loadProtectedTailMeta(db, SESSION).historianDrainFailureAt).toBeFalsy();
            expect(db.prepare("SELECT status, failure_reason FROM historian_runs WHERE session_id=?").all(SESSION)).toEqual([{ status: "noop", failure_reason: null }]);
        });
    } finally { raw.close(); db.close(); f.cleanup(); }
});

it("real-size historian start keeps every main-thread block below 50ms", async () => {
    const f = fixture();
    const path = join(f.dir, "opencode.db");
    const raw = hostStore(path, 174941);
    const db = contextStore(join(f.dir, "context.db"));
    const offset = 174800;
    try {
        raw.exec(`UPDATE message SET data=json_object('role','user','pad',replace(hex(zeroblob(600)),'0','x'))`);
        const insert = raw.prepare("INSERT INTO part VALUES (?,?,?,0,0,?)");
        raw.transaction(() => { for (let i = offset - 2; i < 174941; i++) insert.run(`p-${i}`, messageId(i), SESSION, JSON.stringify({ type: "text", text: `meaningful source ${i}` })); })();
        await withRawMessageProvider(SESSION, provider(raw, path), async () => {
            const input = task(offset, 174941);
            // The runner derives its offset from durable compartments, not the
            // supplied snapshot. Keep those two sources in agreement.
            db.prepare("INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,created_at) VALUES (?,0,1,?,?,?,'previous','summary',0)").run(SESSION, offset - 1, messageId(0), messageId(offset - 2));
            input.snapshot.offsetMessageId = messageId(offset - 1);
            input.snapshot.eligibleEndMessageId = messageId(174936);
            input.snapshot.protectedTailStartMessageId = messageId(174937);
            input.snapshot.rawRangeFingerprint = readBoundarySnapshotRawState(input.snapshot).fingerprint;
            let reachedPrompt = false;
            const client = { session: { get: () => { reachedPrompt = true; throw new Error("stop before creating a child"); } } } as unknown as HiddenCompartmentRunnerDeps["client"];
            let maxBlock = 0;
            let last = performance.now();
            const timer = setInterval(() => { const now = performance.now(); maxBlock = Math.max(maxBlock, now - last); last = now; }, 1);
            try {
                await runCompartmentAgent({ client, db, sessionId: SESSION, boundarySnapshot: input.snapshot, historianChunkTokens: 2000, directory: f.dir, memoryEnabled: false, forceDrainQuota: true });
                maxBlock = Math.max(maxBlock, performance.now() - last);
                expect(reachedPrompt).toBe(true);
                console.log(JSON.stringify({ historianStart: "174941 messages", maxBlockMs: maxBlock }));
                expect(maxBlock).toBeLessThan(50);
            } finally { clearInterval(timer); }
        });
    } finally { raw.close(); db.close(); f.cleanup(); }
});
