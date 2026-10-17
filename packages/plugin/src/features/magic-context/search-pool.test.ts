import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    _resetCompartmentChunkSearchCacheForTests,
    loadCompartmentChunkEmbeddingsForSearch,
    type StoredCompartmentChunkEmbedding,
} from "./compartment-chunk-embedding";
import { cosineSimilarity } from "./memory/embedding";
import { baseSearchPool, measureSearchBlock, searchPoolFixture } from "./search-pool-fixture";

const load = (db: Database, date: { from: number; to: number } | null = null) =>
    loadCompartmentChunkEmbeddingsForSearch(db, "session", "/project", "model", date);

test("append rejects a changed prefix row even when count and max look append-only", async () => {
    const fixture = searchPoolFixture();
    try {
        await load(fixture.db);
        fixture.db
            .prepare("UPDATE compartment_chunk_embeddings SET vector = ? WHERE id = 1")
            .run(new Uint8Array(new Float32Array(8).fill(0.75).buffer));
        fixture.add(81);
        const rows = await load(fixture.db);
        expect([...rows[0].vector]).toEqual(Array(8).fill(0.75));
        expect(rows).toHaveLength(81);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("dated pool includes both overlap boundary rows and excludes missing or null endpoints", async () => {
    const fixture = searchPoolFixture(4);
    try {
        const warm = await load(fixture.db);
        fixture.db.prepare("DELETE FROM message_fts_rowid_map WHERE message_ordinal = 6").run();
        fixture.db
            .prepare(
                "UPDATE message_fts_rowid_map SET message_time_ms = NULL WHERE message_ordinal = 8",
            )
            .run();
        const dated = await load(fixture.db, { from: 200, to: 200 });
        expect(dated.map((row) => row.compartmentId)).toEqual([1, 2]);
        expect(dated).toEqual(
            baseSearchPool(fixture.db, "session", "/project", { from: 200, to: 200 }),
        );
        expect(warm).toHaveLength(4);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("pure append retains decoded prefix vectors and original compartment/window ordering", async () => {
    const fixture = searchPoolFixture();
    try {
        const first = await load(fixture.db);
        // Create compartment metadata before warming so the measured delta is only embedding inserts.
        fixture.db
            .prepare("INSERT INTO compartments VALUES (81, 'session', 'new', 162, 163)")
            .run();
        const warm = await load(fixture.db);
        fixture.db
            .prepare(`INSERT INTO compartment_chunk_embeddings
            SELECT NULL, 81, session_id, project_path, 0, 162, 163, chunk_hash, model_id, dims, vector
            FROM compartment_chunk_embeddings WHERE id = 1`)
            .run();
        const appended = await load(fixture.db);
        expect(appended).toHaveLength(81);
        expect(appended[0].vector).toBe(warm[0].vector);
        expect(appended).toEqual(baseSearchPool(fixture.db));
        expect(first).toHaveLength(80);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("other connections, low-id inserts, deletes and concurrent rebuilds never return a partial pool", async () => {
    const fixture = searchPoolFixture(80);
    const writer = new Database(fixture.path);
    try {
        await load(fixture.db);
        writer
            .prepare("UPDATE compartment_chunk_embeddings SET chunk_hash = 'external' WHERE id = 1")
            .run();
        expect((await load(fixture.db))[0].chunkHash).toBe("external");
        writer.prepare("DELETE FROM compartment_chunk_embeddings WHERE id = 2").run();
        await load(fixture.db);
        fixture.db
            .prepare(`INSERT INTO compartment_chunk_embeddings
            SELECT 2, 2, session_id, project_path, 0, 4, 5, chunk_hash, model_id, dims, vector
            FROM compartment_chunk_embeddings WHERE id = 1`)
            .run();
        const inFlight = load(fixture.db);
        await new Promise<void>((resolve) => setImmediate(resolve));
        fixture.db
            .prepare("UPDATE compartment_chunk_embeddings SET chunk_hash = 'raced' WHERE id = 3")
            .run();
        const rows = await Promise.all([inFlight, load(fixture.db), load(fixture.db)]);
        for (const pool of rows) expect(pool).toEqual(baseSearchPool(fixture.db));
    } finally {
        writer.close();
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("rolled-back transaction-local vectors never escape through a cached pool", async () => {
    const fixture = searchPoolFixture(3);
    try {
        const original = await load(fixture.db);
        fixture.db.exec("BEGIN");
        fixture.db
            .prepare(
                "UPDATE compartment_chunk_embeddings SET chunk_hash = 'temporary' WHERE id = 1",
            )
            .run();
        expect((await load(fixture.db))[0].chunkHash).toBe("temporary");
        fixture.db.exec("ROLLBACK");
        expect((await load(fixture.db))[0].chunkHash).toBe(original[0].chunkHash);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

function rank(rows: StoredCompartmentChunkEmbedding[], query: Float32Array, cutoff: number) {
    const winners = new Map<number, { id: number; ordinal: number; score: number }>();
    for (const row of rows) {
        if (row.endOrdinal > cutoff) continue;
        const score = Math.min(1, Math.max(0, cosineSimilarity(query, row.vector)));
        if (score <= 0) continue;
        const prior = winners.get(row.compartmentId);
        if (!prior || score > prior.score)
            winners.set(row.compartmentId, {
                id: row.compartmentId,
                ordinal: row.startOrdinal,
                score,
            });
    }
    return [...winners.values()]
        .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
        .slice(0, 25)
        .map(({ id, score }) => ({ id, score: score * 0.8 }));
}

test("250 seeded searches equal base SQL rows, ids, ordering and exact scores after mutations", async () => {
    const fixture = searchPoolFixture();
    let seed = 0x19c0ffee;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
    try {
        for (let i = 0; i < 250; i++) {
            const id = 1 + Math.floor(random() * 80);
            switch (i % 7) {
                case 0:
                    fixture.add(
                        81 + i,
                        i % 2 ? "other-session" : "session",
                        i % 3 ? "/other" : "/project",
                    );
                    break;
                case 1:
                    fixture.db
                        .prepare("DELETE FROM compartment_chunk_embeddings WHERE id = ?")
                        .run(id);
                    break;
                case 2:
                    fixture.db
                        .prepare(
                            "UPDATE compartment_chunk_embeddings SET vector = ?, chunk_hash = ? WHERE id = ?",
                        )
                        .run(
                            new Uint8Array(
                                Float32Array.from({ length: 8 }, () => random() - 0.5).buffer,
                            ),
                            `new-${i}`,
                            id,
                        );
                    break;
                case 3:
                    fixture.db
                        .prepare(
                            "UPDATE compartments SET title = ?, end_message = start_message WHERE id = ?",
                        )
                        .run(`changed-${i}`, id);
                    break;
                case 4:
                    fixture.db
                        .prepare(
                            "UPDATE message_fts_rowid_map SET message_time_ms = ? WHERE message_ordinal = ?",
                        )
                        .run(i % 2 ? null : i * 100, id * 2);
                    break;
                case 5:
                    fixture.db
                        .prepare(
                            "UPDATE compartment_chunk_embeddings SET window_index = window_index + 1 WHERE id = ?",
                        )
                        .run(id);
                    break;
            }
            const from = Math.floor(random() * 8000);
            const date = i % 3 ? { from, to: from + Math.floor(random() * 2000) } : null;
            const query = Float32Array.from({ length: 8 }, () => random() - 0.5);
            const cutoff = Math.floor(random() * 250);
            const base = baseSearchPool(fixture.db, "session", "/project", date);
            const tip = await load(fixture.db, date);
            expect(tip).toEqual(base);
            expect(rank(tip, query, cutoff)).toEqual(rank(base, query, cutoff));
        }
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("cold full rebuild keeps every main-thread slice below 50ms", async () => {
    const fixture = searchPoolFixture(15000, 4096);
    try {
        const result = await measureSearchBlock(() => load(fixture.db));
        expect(result.value).toHaveLength(15000);
        console.log(
            `search-pool cold: max=${result.maximum.toFixed(2)}ms total=${result.elapsed.toFixed(2)}ms`,
        );
        expect(result.maximum).toBeLessThan(50);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
}, 30000);
