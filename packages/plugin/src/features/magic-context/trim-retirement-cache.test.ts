import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { deleteSessionScopedRows } from "./storage-session-tables";
import {
    adoptFallbackTagMessageId,
    adoptNullOwnerToolTag,
    adoptPiFallbackMessageTag,
    adoptPiFallbackToolOwnerTag,
    insertTag,
    markTagsCompactedByMessageIds,
    updateTagMessageId,
    updateTagStatus,
} from "./storage-tags";
import { clearTrimRetirement, retireTrimmedSources } from "./trim-retirement-cache";

function fixture(path = ":memory:") {
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}
const rows = (db: Database) =>
    db
        .prepare(
            "SELECT session_id, tag_number, message_id, tool_owner_message_id, status FROM tags ORDER BY session_id, tag_number",
        )
        .all();
const retire = (db: Database, ids: string[], session = "s") =>
    retireTrimmedSources(db, session, ids, (pending) =>
        markTagsCompactedByMessageIds(db, session, pending),
    );

test("committed trim IDs survive 243 ordinary drops but late identities and resurrection invalidate", () => {
    const db = fixture();
    try {
        insertTag(db, "s", "old:p0", "message", 1, 1);
        for (let i = 2; i < 245; i++) insertTag(db, "s", `tail-${i}`, "message", 1, i);
        expect(retire(db, ["old", "owner"])).toBe(1);
        for (let i = 2; i < 245; i++) updateTagStatus(db, "s", i, "dropped");
        insertTag(db, "s", "new-tail", "message", 1, 245);
        let called = false;
        retireTrimmedSources(db, "s", ["old", "owner"], () => {
            called = true;
            return 0;
        });
        expect(called).toBe(false);
        updateTagStatus(db, "s", 1, "active");
        expect(retire(db, ["old", "owner"])).toBe(1);
        insertTag(db, "s", "OLD:Panything", "message", 1, 246);
        expect(retire(db, ["old", "owner"])).toBe(1);
        updateTagMessageId(db, "s", 245, "old:file0");
        expect(retire(db, ["old", "owner"])).toBe(1);
        expect(adoptFallbackTagMessageId(db, "s", 244, "tail-244", "old:p1")).toBe(true);
        expect(retire(db, ["old", "owner"])).toBe(1);
        insertTag(db, "s", "call", "tool", 1, 247);
        const tool = db
            .prepare("SELECT id FROM tags WHERE session_id='s' AND tag_number=247")
            .get() as { id: number };
        expect(adoptNullOwnerToolTag(db, tool.id, "owner")).toBe(true);
        expect(retire(db, ["old", "owner"])).toBe(1);
        retire(db, ["pi-owner", "pi-message"]);
        insertTag(db, "s", "pi-call", "tool", 1, 248, 0, null, 0, "fallback-owner");
        expect(
            adoptPiFallbackToolOwnerTag(db, "s", 248, "pi-call", "fallback-owner", "pi-owner")
                .action,
        ).toBe("rekeyed");
        expect(retire(db, ["pi-owner", "pi-message"])).toBe(1);
        insertTag(db, "s", "fallback-message", "message", 1, 249);
        expect(
            adoptPiFallbackMessageTag(db, "s", 249, "fallback-message", "pi-message").action,
        ).toBe("rekeyed");
        expect(retire(db, ["pi-owner", "pi-message"])).toBe(1);
    } finally {
        db.close();
    }
});

test("failed retirement is never remembered before commit", () => {
    const db = fixture();
    try {
        insertTag(db, "s", "old:p0", "message", 1, 1);
        // Failure after the UPDATE but before COMMIT rolls the complete batch back.
        const exec = db.exec.bind(db);
        const fault = spyOn(db, "exec").mockImplementation((sql: string) => {
            if (sql === "COMMIT") throw new Error("injected commit failure");
            return exec(sql);
        });
        try {
            expect(() => retire(db, ["old"])).toThrow("injected commit failure");
        } finally {
            fault.mockRestore();
        }
        expect(db.prepare("SELECT status FROM tags").get()).toEqual({ status: "active" });
        expect(retire(db, ["old"])).toBe(1);
        expect(db.prepare("SELECT status FROM tags").get()).toEqual({ status: "compacted" });
    } finally {
        db.close();
    }
});

test("an enclosing rollback cannot publish trim IDs", () => {
    const db = fixture();
    try {
        insertTag(db, "s", "old:p0", "message", 1, 1);
        expect(() =>
            db.transaction(() => {
                retire(db, ["old"]);
                throw new Error("rollback");
            })(),
        ).toThrow("rollback");
        expect(retire(db, ["old"])).toBe(1);
    } finally {
        db.close();
    }
});

test("another connection adding a retired identity invalidates incremental retirement", () => {
    const root = join(tmpdir(), "magic-context", "busy-budget-accounting");
    mkdirSync(root, { recursive: true });
    const dir = createTestTempDirFromPath(join(root, "external-"));
    const path = join(dir, "context.db");
    const db = fixture(path);
    const other = new Database(path);
    try {
        insertTag(db, "s", "old:p0", "message", 1, 1);
        expect(retire(db, ["old"])).toBe(1);
        insertTag(other, "s", "old:p1", "message", 1, 2);
        expect(retire(db, ["old"])).toBe(1);
        expect((rows(db) as { status: string }[]).every((row) => row.status === "compacted")).toBe(
            true,
        );
        other.prepare("UPDATE tags SET status='active' WHERE tag_number=1").run();
        expect(retire(db, ["old"])).toBe(1);
    } finally {
        other.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("session deletion discards committed retirement", () => {
    const db = fixture();
    try {
        retire(db, ["old"]);
        deleteSessionScopedRows(db, ["s"]);
        let queried = false;
        retireTrimmedSources(db, "s", ["old"], () => {
            queried = true;
            return 0;
        });
        expect(queried).toBe(true);
    } finally {
        db.close();
    }
});

// Compare tag rows after inserts, restoring compacted tags to active, changing
// message IDs, rolling back interrupted transactions and clearing the memory cache.
test("incremental retirement matches the base algorithm over randomized trim histories", () => {
    const base = fixture();
    const cached = fixture();
    let seed = 91475;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    };
    let next = 1;
    try {
        for (let pass = 0; pass < 120; pass++) {
            const source = `m${random() % 24}`;
            const tag = next++;
            for (const db of [base, cached])
                insertTag(db, "s", `${source}:p${pass % 3}`, "message", 1, tag);
            if (pass % 4 === 0) {
                const target = 1 + (random() % (next - 1));
                for (const db of [base, cached]) updateTagStatus(db, "s", target, "active");
            }
            if (pass % 5 === 0) {
                const target = 1 + (random() % (next - 1));
                for (const db of [base, cached])
                    updateTagMessageId(db, "s", target, `${source}:file0`);
            }
            const ids = Array.from({ length: 1 + (random() % 24) }, () => `m${random() % 24}`);
            if (pass % 11 === 0) clearTrimRetirement(cached, "s");
            if (pass % 13 === 0) {
                for (const db of [base, cached]) {
                    expect(() =>
                        db.transaction(() => {
                            if (db === cached) retire(db, ids);
                            else markTagsCompactedByMessageIds(db, "s", ids);
                            throw new Error("interrupted pass");
                        })(),
                    ).toThrow("interrupted pass");
                }
            }
            expect(retire(cached, ids)).toBe(markTagsCompactedByMessageIds(base, "s", ids));
            expect(rows(cached)).toEqual(rows(base));
        }
    } finally {
        base.close();
        cached.close();
    }
});

test("reopening the database starts with a cold retirement cache", () => {
    const root = join(tmpdir(), "magic-context", "busy-budget-accounting");
    mkdirSync(root, { recursive: true });
    const dir = createTestTempDirFromPath(join(root, "restart-"));
    const path = join(dir, "context.db");
    let db = fixture(path);
    try {
        insertTag(db, "s", "old:p0", "message", 1, 1);
        expect(retire(db, ["old"])).toBe(1);
        const before = rows(db);
        db.close();
        db = new Database(path);
        let queries = 0;
        const replay = () =>
            retireTrimmedSources(db, "s", ["old"], (pending) => {
                queries++;
                return markTagsCompactedByMessageIds(db, "s", pending);
            });
        expect(replay()).toBe(0);
        expect(queries).toBe(1);
        expect(replay()).toBe(0);
        expect(queries).toBe(1);
        expect(rows(db)).toEqual(before);
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
