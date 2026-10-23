import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, withoutSqliteTransformPass, withSqliteTurnDeadline } from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

async function fixture(run: (db: Database, path: string) => Promise<void>) {
    const root = createTestTempDirFromPath(join(tmpdir(), "sqlite-turn-deadline-"));
    const path = join(root, "context.db");
    const db = new Database(path);
    db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=900; CREATE TABLE t(value); INSERT INTO t VALUES(1)",
    );
    try {
        await run(db, path);
    } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
}

async function hold(path: string, reader = false) {
    const child = Bun.spawn(
        [
            process.execPath,
            "-e",
            `
        const { Database } = require('bun:sqlite');
        const db = new Database(process.argv[1]);
        db.exec(${JSON.stringify(reader ? "BEGIN; SELECT * FROM t" : "BEGIN EXCLUSIVE")});
        console.log('HELD');
        setInterval(() => {}, 1000);
    `,
            path,
        ],
        { stdout: "pipe", stderr: "pipe" },
    );
    const output = child.stdout.getReader();
    const first = await output.read();
    output.releaseLock();
    if (!new TextDecoder().decode(first.value).includes("HELD")) {
        child.kill();
        throw new Error(`holder failed: ${await new Response(child.stderr).text()}`);
    }
    return async () => {
        child.kill();
        await child.exited;
    };
}

function bounded(operation: () => unknown) {
    const start = performance.now();
    expect(() =>
        withSqliteTurnDeadline(() => Math.max(0, 80 - (performance.now() - start)), operation),
    ).toThrow(/locked|busy/i);
    // The connection allows 900 ms; a late turn has only 80 ms left for this wait.
    expect(performance.now() - start).toBeLessThan(400);
}

for (const method of ["get", "all", "run", "values", "iterate"] as const) {
    test(`turn deadline bounds cached SELECT ${method}`, async () => {
        await fixture(async (db, path) => {
            const statement = db.prepare("SELECT * FROM t") as any;
            const release = await hold(path);
            try {
                bounded(() =>
                    method === "iterate" ? statement.iterate().next() : statement[method](),
                );
                expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 900 });
            } finally {
                await release();
            }
        });
    });
}

test("turn deadline bounds native exec reads", async () => {
    await fixture(async (db, path) => {
        const release = await hold(path);
        try {
            bounded(() => db.exec("SELECT * FROM t"));
        } finally {
            await release();
        }
    });
});

test("turn deadline bounds native schema preparation", async () => {
    await fixture(async (_db, path) => {
        const release = await hold(path);
        const fresh = new Database(path);
        fresh.exec("PRAGMA busy_timeout=900");
        try {
            bounded(() => fresh.prepare("SELECT * FROM t"));
        } finally {
            fresh.close();
            await release();
        }
    });
});

test("turn deadline bounds COMMIT waiting for a reader", async () => {
    await fixture(async (db, path) => {
        db.exec("BEGIN IMMEDIATE; UPDATE t SET value=2");
        const release = await hold(path, true);
        try {
            bounded(() => db.exec("COMMIT"));
            expect(db.inTransaction).toBe(true);
            db.exec("ROLLBACK");
        } finally {
            await release();
        }
    });
});

test("turn deadline bounds execution inside a deferred transaction", async () => {
    await fixture(async (db, path) => {
        const read = db.prepare("SELECT * FROM t");
        db.exec("BEGIN DEFERRED");
        const release = await hold(path);
        try {
            bounded(() => read.get());
        } finally {
            db.exec("ROLLBACK");
            await release();
        }
    });
});

test("turn deadline preserves zero-timeout probes and detached work", async () => {
    await fixture(async (db, path) => {
        const read = db.prepare("SELECT * FROM t");
        const release = await hold(path);
        try {
            withSqliteTurnDeadline(
                () => 80,
                () => {
                    db.exec("PRAGMA busy_timeout=0");
                    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
                    expect(() => read.get()).toThrow(/locked|busy/i);
                    db.exec("PRAGMA busy_timeout=900");
                },
            );
            const start = performance.now();
            expect(() =>
                withSqliteTurnDeadline(
                    () => 0,
                    () => withoutSqliteTransformPass(() => read.get()),
                ),
            ).toThrow(/locked|busy/i);
            expect(performance.now() - start).toBeGreaterThan(700);
        } finally {
            await release();
        }
    });
});
