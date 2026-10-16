import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageBusyRefusalError } from "../hooks/magic-context/storage-busy-refusal";
import { createMessagesTransformHandler } from "../plugin/messages-transform";
import { log } from "./logger";
import {
    Database,
    guardSqliteTransformPass,
    registerSqliteDiagnosticSink,
    SqliteAcquisitionBusyError,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "./sqlite";
import { type SqliteWriteLocker, startSqliteWriteLocker } from "./sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "./test-temp-dir";

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-foreground-wait-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER);
        CREATE TABLE result(value TEXT);
    `);
    return {
        db,
        path,
        close() {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

for (const holdMs of [1000, 2500]) {
    test(holdMs === 1000
        ? "a transform commits and serves managed output after a 1s in-pass writer lock"
        : "a transform refuses a 2.5s in-pass writer lock without raw fallback and logs the real wait", async () => {
        const { db, path, close } = fixture();
        const sessionId = `foreground-wait-${holdMs}`;
        const output = {
            messages: [
                {
                    info: { id: "u", sessionID: sessionId, role: "user" },
                    parts: [{ type: "text", text: "raw input must not be served on failure" }],
                },
            ],
        };
        let locker: SqliteWriteLocker | undefined;
        let refusals = 0;
        let served = false;
        let waitedMs = 0;
        const diagnostics: string[] = [];
        registerSqliteDiagnosticSink((line) => diagnostics.push(line));
        const handler = createMessagesTransformHandler({
            onStorageBusyRefusal: async (id) => {
                expect(id).toBe(sessionId);
                refusals++;
            },
            magicContext: {
                "experimental.chat.messages.transform": async (_input, result) => {
                    // Start the competing writer only once the transform callback begins;
                    // otherwise the wrapper's yielding lock check would absorb the wait.
                    locker = await startSqliteWriteLocker(path, holdMs);
                    const started = performance.now();
                    try {
                        withPrivilegedWriter(db, () => {
                            db.prepare("INSERT INTO result VALUES ('managed')").run();
                        });
                    } finally {
                        waitedMs = performance.now() - started;
                    }
                    (result.messages[0].parts[0] as { text: string }).text = "managed output";
                },
            },
        });
        try {
            const pass = handler({}, output as Parameters<typeof handler>[1]).then((messages) => {
                served = true;
                return messages;
            });
            if (holdMs === 1000) {
                await pass;
                expect(served).toBe(true);
                expect(refusals).toBe(0);
                expect(output.messages[0].parts[0].text).toBe("managed output");
                expect(db.prepare("SELECT * FROM result").all()).toEqual([{ value: "managed" }]);
                expect(waitedMs).toBeGreaterThanOrEqual(900);
            } else {
                await expect(pass).rejects.toBeInstanceOf(StorageBusyRefusalError);
                expect(served).toBe(false);
                expect(refusals).toBe(1);
                expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
                expect(waitedMs).toBeGreaterThanOrEqual(1900);
                expect(waitedMs).toBeLessThan(2400);
                const busy = diagnostics.filter((line) => line.includes("outcome=busy"));
                expect(busy).toHaveLength(1);
                expect(busy[0]).toContain("lane=foreground");
                const reportedMs = Number(/acquire_ms=(\d+)/.exec(busy[0])?.[1]);
                expect(Math.abs(reportedMs - waitedMs)).toBeLessThan(100);
            }
            expect(db.inTransaction).toBe(false);
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        } finally {
            registerSqliteDiagnosticSink(log);
            if (locker) expect(await locker.exited).toBe(0);
            close();
        }
    }, 30_000);
}

for (const mode of ["BEGIN", "autocommit"]) {
    test(`foreground ${mode} wait is capped by the pass deadline`, () => {
        const { db, path, close } = fixture();
        const blocker = new Database(path);
        blocker.exec("BEGIN IMMEDIATE");
        try {
            const started = performance.now();
            withSqliteTransformPass(() => {
                guardSqliteTransformPass({ assert() {}, remainingMs: () => 100 });
                expect(() => {
                    if (mode === "BEGIN") withPrivilegedWriter(db, () => undefined);
                    else db.prepare("INSERT INTO result VALUES ('late')").run();
                }).toThrow(SqliteAcquisitionBusyError);
            });
            expect(performance.now() - started).toBeGreaterThanOrEqual(75);
            expect(performance.now() - started).toBeLessThan(700);
            expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        } finally {
            blocker.exec("ROLLBACK");
            blocker.close();
            close();
        }
    });
}
