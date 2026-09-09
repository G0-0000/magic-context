/**
 * Compare the old full-target reader with dropped-only status replay on a
 * migration-built, private in-memory database. No live session data is read.
 * Run from the repository root:
 *   bun packages/plugin/scripts/benchmark-transform-replay-queries.ts
 *
 * Timings include real row hydration and applyFlushedStatuses, not the entire
 * transform. Caveman replay independently reuses the transform's active tags.
 */
import assert from "node:assert/strict";
import { runMigrations } from "../src/features/magic-context/migrations";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import {
    getDroppedTagsByNumbers,
    getTagsByNumbers,
    insertTag,
    TAG_SELECT_COLUMNS,
    updateTagStatus,
} from "../src/features/magic-context/storage-tags";
import { applyFlushedStatuses } from "../src/hooks/magic-context/transform-operations";
import { Database } from "../src/shared/sqlite";

const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const samples = 100;
const warmups = 15;
function measure(fn: () => number) {
    for (let i = 0; i < warmups; i++) fn();
    const times: number[] = [];
    let rows = 0;
    for (let i = 0; i < samples; i++) {
        const start = performance.now();
        rows = fn();
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { rows, p50_ms: times[50], p95_ms: times[95] };
}
for (const n of [2000, 5000, 10000]) {
    const session = `perf-${n}`;
    const messages = Array.from({ length: n }, (_, i) => ({
        info: { id: `message-${i + 1}`, role: "assistant" },
        parts: [
            {
                type: "text",
                text: `Result ${i + 1}: verified the requested implementation and its tests.`,
            },
        ],
    }));
    db.transaction(() => {
        messages.forEach((message, i) => {
            insertTag(db, session, message.info.id, "message", message.parts[0].text.length, i + 1);
            if ((i + 1) % 50 === 0) updateTagStatus(db, session, i + 1, "dropped");
        });
    })();
    const numbers = messages.map((_, i) => i + 1);
    let seen: number[] = [];
    const targets = new Map(
        numbers.map((number) => [
            number,
            {
                setContent: (_content: string) => {
                    seen.push(number);
                    return true;
                },
            },
        ]),
    );
    const run = (read: typeof getTagsByNumbers) => {
        const rows = read(db, session, numbers);
        applyFlushedStatuses(session, db, targets, rows);
        return rows.length;
    };
    seen = [];
    run(getTagsByNumbers);
    const fullMutations = seen;
    seen = [];
    run(getDroppedTagsByNumbers);
    assert.deepEqual(seen, fullMutations);
    assert.deepEqual(
        seen,
        numbers.filter((number) => number % 50 === 0),
    );
    const before = measure(() => {
        seen = [];
        return run(getTagsByNumbers);
    });
    const after = measure(() => {
        seen = [];
        return run(getDroppedTagsByNumbers);
    });
    console.log(
        JSON.stringify({
            messages: n,
            tags: n,
            dropped: n / 50,
            fixture_bytes: Buffer.byteLength(JSON.stringify(messages)),
            before,
            after,
            saved_p50_ms: before.p50_ms - after.p50_ms,
            mutationParity: true,
        }),
    );
    if (n === 5000) {
        const placeholders = numbers
            .slice(0, 900)
            .map(() => "?")
            .join(",");
        console.log(
            "current_plan",
            db
                .prepare(
                    `EXPLAIN QUERY PLAN SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number IN (${placeholders}) ORDER BY tag_number ASC, id ASC`,
                )
                .all(session, ...numbers.slice(0, 900)),
        );
        console.log(
            "dropped_plan",
            db
                .prepare(
                    `EXPLAIN QUERY PLAN SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'dropped' AND tag_number IN (${placeholders}) ORDER BY tag_number ASC, id ASC`,
                )
                .all(session, ...numbers.slice(0, 900)),
        );
    }
}
db.close();
