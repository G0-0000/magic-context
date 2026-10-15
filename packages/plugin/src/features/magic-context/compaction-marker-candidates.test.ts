import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ordinalWarmup from "../../hooks/magic-context/raw-ordinal-warmup";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { fixture, hostStore, messageId, SESSION } from "./__tests__/host-stalls.fixture";
import {
    closeCompactionMarkerDb,
    getPreparedCompactionMarkerSummaryIds,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
    replaceCompactionMarker,
} from "./compaction-marker";

it("marker receipt mismatch defers the advance without deleting any current marker rows", async () => {
    const f = fixture();
    const oldHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = f.dir;
    mkdirSync(join(f.dir, "opencode"));
    const path = join(f.dir, "opencode/opencode.db");
    const db = hostStore(path, 20);
    const forbidden = spyOn(ordinalWarmup, "prewarmRawSessionOrdinalsForDb").mockImplementation(
        () => {
            throw new Error("marker preparation must not warm ordinals");
        },
    );
    const logs = spyOn(logger, "log");
    try {
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const args = {
            sessionId: SESSION,
            endMessageId: messageId(12),
            endOrdinal: 13,
            summaryText: "summary",
            directory: f.dir,
            resolvedBoundary: { id: messageId(12), timeCreated: 4 },
        };
        const current = injectCompactionMarker(args);
        expect(current).not.toBeNull();
        const before = db.prepare("SELECT id FROM message ORDER BY id").all();
        const beforeParts = db.prepare("SELECT id FROM part ORDER BY id").all();
        const entry = join(f.dir, "delayed-candidates.mjs");
        const sqlite = new URL("../../shared/sqlite.ts", import.meta.url).href;
        const scan = new URL("./compaction-marker-candidates.ts", import.meta.url).href;
        writeFileSync(
            entry,
            `import {parentPort,workerData} from 'node:worker_threads';
            import {existsSync,writeFileSync} from 'node:fs';
            parentPort.postMessage({kind:'accepted'});
            const {Database}=await import(${JSON.stringify(sqlite)});
            const {scanMarkerSummaryCandidates}=await import(${JSON.stringify(scan)});
            const db=new Database(workerData.path,{readonly:true});
            const ids=scanMarkerSummaryCandidates(db,workerData.sessionId);db.close();
            writeFileSync(workerData.path+'.ready','ready');
            while(!existsSync(workerData.path+'.release'))await new Promise(r=>setTimeout(r,5));
            parentPort.postMessage({kind:'candidates',ids});parentPort.close();`,
        );
        const pending = prepareCompactionMarkerCandidates(SESSION, {
            entry: new URL(`file://${entry}`),
            acceptMs: 60000,
            resultMs: 120000,
        });
        const deadline = Date.now() + 60000;
        while (!existsSync(`${path}.ready`)) {
            if (Date.now() > deadline) throw new Error("candidate barrier not reached");
            await Bun.sleep(5);
        }
        const peer = new Database(path);
        try {
            peer.prepare("UPDATE message SET time_updated=time_updated+1 WHERE id=?").run(
                messageId(1),
            );
        } finally {
            peer.close();
        }
        writeFileSync(`${path}.release`, "go");
        expect(await pending).toBe(false);
        expect(getPreparedCompactionMarkerSummaryIds(SESSION)).toBeUndefined();
        const next = replaceCompactionMarker(current, {
            ...args,
            endMessageId: messageId(15),
            endOrdinal: 16,
            resolvedBoundary: { id: messageId(15), timeCreated: 5 },
        });
        expect(next.kind).toBe("definitely-no-cut");
        expect(db.prepare("SELECT id FROM message ORDER BY id").all()).toEqual(before);
        expect(db.prepare("SELECT id FROM part ORDER BY id").all()).toEqual(beforeParts);
        expect(
            logs.mock.calls.filter(([line]) =>
                String(line).includes("host store changed during discovery"),
            ),
        ).toHaveLength(1);
        expect(forbidden).not.toHaveBeenCalled();
    } finally {
        logs.mockRestore();
        forbidden.mockRestore();
        closeCompactionMarkerDb();
        db.close();
        process.env.XDG_DATA_HOME = oldHome;
        f.cleanup();
    }
});
