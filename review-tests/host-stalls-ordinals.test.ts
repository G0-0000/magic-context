import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
    stopRawSessionOrdinalWarmups,
} from "../packages/plugin/src/hooks/magic-context/raw-ordinal-warmup";
import {
    captureRawOrdinalScanProof,
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    RawOrdinalsNotReady,
    readRawSessionMessageIdOrdinalsForRangeFromDb as readRange,
    readRawSessionMessageIdOrdinalsFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    scanRawSessionSummaryRows,
} from "../packages/plugin/src/hooks/magic-context/read-session-raw";
import { Database } from "../packages/plugin/src/shared/sqlite";
import {
    fixture,
    hostStore,
    messageId,
    offsetOracle,
    random,
    SESSION,
} from "./host-stalls-fixture";

afterEach(() => resetRawSessionOrdinalWarmupsForTest());

function exactOrRefused(db: Database, from: number, to: number) {
    let actual: Map<string, number>;
    try {
        actual = readRange(db, SESSION, from, to);
    } catch (error) {
        expect(error).toBeInstanceOf(RawOrdinalsNotReady);
        return;
    }
    expect([...actual]).toEqual([...offsetOracle(db, from, to)]);
}

it("seeded ranges match frozen OFFSET with numeric summaries and malformed holes", async () => {
    const f = fixture();
    try {
        for (const seed of [7, 41, 2026, 0xc0ffee]) {
            const db = hostStore(join(f.dir, `${seed}.db`), 1100, seed);
            try {
                expect(
                    await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                        acceptMs: 60_000,
                        resultMs: 120_000,
                    }),
                ).toBe("warm");
                const rng = random(seed);
                for (let i = 0; i < 80; i++) {
                    const from = 1 + Math.floor(rng() * 1150);
                    const to = from + Math.floor(rng() * 120);
                    expect([...readRange(db, SESSION, from, to)]).toEqual([
                        ...offsetOracle(db, from, to),
                    ]);
                }
                for (const from of [1, 255, 256, 257, 511, 512, 513, 1024])
                    for (const width of [0, 1, 256, 1100])
                        expect([...readRange(db, SESSION, from, from + width)]).toEqual([
                            ...offsetOracle(db, from, from + width),
                        ]);
            } finally {
                db.close();
            }
        }
        const small = hostStore(join(f.dir, "exhaustive.db"), 31, 91);
        try {
            expect(
                await prewarmRawSessionOrdinalsForDb(small, SESSION, {
                    acceptMs: 60_000,
                    resultMs: 120_000,
                }),
            ).toBe("warm");
            for (let from = 1; from <= 34; from++)
                for (let to = from; to <= 34; to++)
                    expect([...readRange(small, SESSION, from, to)]).toEqual([
                        ...offsetOracle(small, from, to),
                    ]);
        } finally {
            small.close();
        }
    } finally {
        f.cleanup();
    }
});

it("tail reverts and concurrent forward appends keep exact range ranks", async () => {
    const f = fixture();
    const path = join(f.dir, "host.db");
    const db = hostStore(path, 1100, 72);
    const other = new Database(path);
    try {
        expect(
            await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                acceptMs: 60_000,
                resultMs: 120_000,
            }),
        ).toBe("warm");
        for (const cutoff of [1000, 800, 500]) {
            other.prepare("DELETE FROM message WHERE time_created>=?").run(Math.floor(cutoff / 3));
            for (const from of [1, 257, 600, 900]) exactOrRefused(db, from, from + 150);
            other
                .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
                .run(`append-${cutoff}`, SESSION, 10000 + cutoff, 10000, '{"role":"user"}');
            for (const from of [1, 257, 600, 900]) exactOrRefused(db, from, from + 150);
        }
    } finally {
        other.close();
        db.close();
        f.cleanup();
    }
});

it("a prefix removal must not reuse a surviving checkpoint's old range rank", async () => {
    const f = fixture();
    const path = join(f.dir, "host.db");
    const db = hostStore(path, 1100);
    const other = new Database(path);
    try {
        expect(
            await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                acceptMs: 60_000,
                resultMs: 120_000,
            }),
        ).toBe("warm");
        other.prepare("DELETE FROM message WHERE id=?").run(messageId(10));
        exactOrRefused(db, 900, 905);
    } finally {
        other.close();
        db.close();
        f.cleanup();
    }
});

it("local prefix writes invalidate cached ranks without a peer data_version change", async () => {
    const f = fixture();
    const db = hostStore(join(f.dir, "local-prefix.db"), 1100);
    try {
        expect(
            await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                acceptMs: 60000,
                resultMs: 120000,
            }),
        ).toBe("warm");
        const before = db.prepare("PRAGMA data_version").get();
        db.prepare("DELETE FROM message WHERE id=?").run(messageId(10));
        expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
        exactOrRefused(db, 900, 905);
    } finally {
        db.close();
        f.cleanup();
    }
});

it("a backdated concurrent append must not reuse a surviving checkpoint's old range rank", async () => {
    const f = fixture();
    const path = join(f.dir, "host.db");
    const db = hostStore(path, 1100);
    const other = new Database(path);
    try {
        expect(
            await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                acceptMs: 60_000,
                resultMs: 120_000,
            }),
        ).toBe("warm");
        other
            .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
            .run("clock-skew-append", SESSION, 0, 1200, '{"role":"user"}');
        exactOrRefused(db, 900, 905);
    } finally {
        other.close();
        db.close();
        f.cleanup();
    }
});

it("finishing an existing summary must invalidate its cached boolean range exclusion", async () => {
    const f = fixture();
    const path = join(f.dir, "host.db");
    const db = hostStore(path, 1100);
    const other = new Database(path);
    try {
        db.prepare("UPDATE message SET data=? WHERE id=?").run(
            '{"role":"assistant","summary":true,"finish":"length"}',
            messageId(10),
        );
        expect(
            await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                acceptMs: 60_000,
                resultMs: 120_000,
            }),
        ).toBe("warm");
        other
            .prepare("UPDATE message SET data=? WHERE id=?")
            .run('{"role":"assistant","summary":true,"finish":"stop"}', messageId(10));
        exactOrRefused(db, 900, 905);
    } finally {
        other.close();
        db.close();
        f.cleanup();
    }
});

it("a delayed worker snapshot cannot certify ranks after a prefix removal", () => {
    const f = fixture();
    const path = join(f.dir, "host.db");
    const db = hostStore(path, 1100);
    const scanner = new Database(path, { readonly: true });
    try {
        const epoch = getRawSessionSummaryEpoch(SESSION);
        const scan = scanRawSessionSummaryRows(scanner, SESSION);
        db.prepare("DELETE FROM message WHERE id=?").run(messageId(10));
        installRawSessionSummaryScan(db, SESSION, scan, epoch, true);
        exactOrRefused(db, 900, 905);
    } finally {
        scanner.close();
        db.close();
        f.cleanup();
    }
});

it("a serving transaction cannot hide a commit during worker installation", () => {
    const f = fixture();
    const path = join(f.dir, "pinned.db");
    const db = hostStore(path, 1100);
    const writer = new Database(path);
    const scanner = new Database(path, { readonly: true });
    try {
        const proof = captureRawOrdinalScanProof(db);
        db.exec("BEGIN");
        db.prepare("SELECT count(*) FROM message").get();
        writer.prepare("DELETE FROM message WHERE id=?").run(messageId(10));
        const scan = scanRawSessionSummaryRows(scanner, SESSION);
        expect(
            installRawSessionSummaryScan(
                db,
                SESSION,
                scan,
                getRawSessionSummaryEpoch(SESSION),
                true,
                proof,
            ),
        ).toBe(false);
        db.exec("ROLLBACK");
        exactOrRefused(db, 900, 905);
    } finally {
        if (db.inTransaction) db.exec("ROLLBACK");
        scanner.close();
        writer.close();
        db.close();
        f.cleanup();
    }
});

it("slow and crashed warmup workers return exact late ranges or refuse them", async () => {
    const f = fixture();
    try {
        for (const [name, code] of [
            [
                "slow",
                `import {parentPort} from 'node:worker_threads'; parentPort.postMessage({kind:'accepted'}); setInterval(()=>{},1000);`,
            ],
            [
                "crash",
                `import {parentPort} from 'node:worker_threads'; parentPort.postMessage({kind:'accepted'}); throw Error('review deliberate crash');`,
            ],
        ]) {
            const entry = join(f.dir, `${name}.mjs`);
            writeFileSync(entry, code);
            const db = hostStore(join(f.dir, `${name}.db`), 1100, 99);
            try {
                const pending = prewarmRawSessionOrdinalsForDb(db, SESSION, {
                    entry: new URL(`file://${entry}`),
                    acceptMs: 5000,
                    resultMs: 100,
                });
                exactOrRefused(db, 900, 905);
                expect(await pending).toBe("failed");
                exactOrRefused(db, 900, 905);
                expect([...readRange(db, SESSION, 1, 100)]).toEqual([...offsetOracle(db, 1, 100)]);
            } finally {
                stopRawSessionOrdinalWarmups();
                db.close();
            }
        }
    } finally {
        f.cleanup();
    }
});

it("count and by-ID APIs also refuse stale current-DB prefix ranks", async () => {
    const f = fixture();
    try {
        for (const change of ["delete", "backdate", "finish", "install"] as const) {
            const db = hostStore(join(f.dir, `${change}.db`), 1100);
            const other = new Database(join(f.dir, `${change}.db`));
            try {
                if (change === "finish")
                    db.prepare("UPDATE message SET data=? WHERE id=?").run(
                        '{"summary":true,"finish":"length"}',
                        messageId(10),
                    );
                expect(
                    await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                        acceptMs: 60000,
                        resultMs: 120000,
                    }),
                ).toBe("warm");
                const scan = scanRawSessionSummaryRows(db, SESSION);
                if (change === "delete" || change === "install")
                    other.prepare("DELETE FROM message WHERE id=?").run(messageId(10));
                else if (change === "backdate")
                    other
                        .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
                        .run("backdated", SESSION, 0, 1200, '{"role":"user"}');
                else
                    other
                        .prepare("UPDATE message SET data=? WHERE id=?")
                        .run('{"summary":true,"finish":"stop"}', messageId(10));
                if (change === "install")
                    expect(
                        installRawSessionSummaryScan(
                            db,
                            SESSION,
                            scan,
                            getRawSessionSummaryEpoch(SESSION),
                            true,
                        ),
                    ).toBe(false);
                for (const read of [
                    () => countRawSessionMessageOrdinalsFromDb(db, SESSION),
                    () => readRawSessionMessageOrdinalByIdFromDb(db, SESSION, messageId(1099)),
                ]) {
                    let actual: number | null;
                    try {
                        actual = read();
                    } catch (error) {
                        expect(error).toBeInstanceOf(RawOrdinalsNotReady);
                        continue;
                    }
                    expect(actual).toBe(change === "backdate" ? 1101 : 1099);
                }
                expect(
                    await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                        acceptMs: 60000,
                        resultMs: 120000,
                    }),
                ).toBe("warm");
                expect(countRawSessionMessageOrdinalsFromDb(db, SESSION)).toBe(
                    change === "backdate" ? 1101 : 1099,
                );
                expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, messageId(1099))).toBe(
                    change === "backdate" ? 1101 : 1099,
                );
            } finally {
                other.close();
                db.close();
            }
        }
    } finally {
        f.cleanup();
    }
});

it("numeric summary 1 retains the historical count/by-ID versus raw/range predicate distinction", async () => {
    const f = fixture();
    const db = hostStore(join(f.dir, "numeric.db"), 3);
    try {
        db.prepare("UPDATE message SET data=? WHERE id=?").run(
            '{"summary":1,"finish":"stop"}',
            messageId(1),
        );
        expect(
            await prewarmRawSessionOrdinalsForDb(db, SESSION, {
                acceptMs: 60000,
                resultMs: 120000,
            }),
        ).toBe("warm");
        expect(countRawSessionMessageOrdinalsFromDb(db, SESSION)).toBe(2);
        expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, messageId(1))).toBeNull();
        expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, messageId(2))).toBe(2);
        expect([...readRange(db, SESSION, 1, 3)]).toEqual([
            [messageId(0), 1],
            [messageId(1), 2],
            [messageId(2), 3],
        ]);
        expect([...readRawSessionMessageIdOrdinalsFromDb(db, SESSION)]).toEqual([
            ...offsetOracle(db, 1, 3),
        ]);
    } finally {
        db.close();
        f.cleanup();
    }
});
