import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import type { StoredCompartmentChunkEmbedding } from "./compartment-chunk-embedding";

/** Synthetic-only schema: no application store, config, or migrations are opened. */
export function searchPoolFixture(
    count = 80,
    dims = 8,
): {
    db: Database;
    path: string;
    add: (id: number, session?: string, project?: string, vector?: Float32Array) => void;
    close: () => void;
} {
    const root = join(tmpdir(), "magic-context/search-pool");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "fixture-"));
    const path = join(directory, "fixture.db");
    const db = new Database(path);
    db.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE compartments (id INTEGER PRIMARY KEY, session_id TEXT, title TEXT,
            start_message INTEGER, end_message INTEGER);
        CREATE TABLE message_fts_rowid_map (session_id TEXT, message_ordinal INTEGER,
            message_time_ms INTEGER, PRIMARY KEY(session_id, message_ordinal));
        CREATE TABLE compartment_chunk_embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT,
            compartment_id INTEGER, session_id TEXT, project_path TEXT, window_index INTEGER,
            start_ordinal INTEGER, end_ordinal INTEGER, chunk_hash TEXT, model_id TEXT,
            dims INTEGER, vector BLOB);
        CREATE INDEX idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);
    `);
    const compartment = db.prepare("INSERT INTO compartments VALUES (?, ?, ?, ?, ?)");
    const timestamp = db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?)");
    const insert = db.prepare(
        "INSERT INTO compartment_chunk_embeddings VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const add = (id: number, session = "session", project = "/project", vector?: Float32Array) => {
        compartment.run(id, session, `title-${id}`, id * 2, id * 2 + 1);
        timestamp.run(session, id * 2, id * 100);
        timestamp.run(session, id * 2 + 1, id * 100 + 100);
        const values = vector ?? Float32Array.from({ length: dims }, (_, d) => Math.sin(id + d));
        insert.run(
            id,
            session,
            project,
            0,
            id * 2,
            id * 2 + 1,
            `hash-${id}`,
            "model",
            dims,
            new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
        );
    };
    db.transaction(() => {
        for (let id = 1; id <= count; id++) add(id);
    })();
    return {
        db,
        path,
        add,
        close() {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

/**
 * Independent pre-cache oracle: session/project/model scope, inclusive endpoint
 * overlap, compartment/window order and copied float32 blobs. Keeping the SQL
 * independent catches cache invalidation and date-filter changes in comparisons.
 * Source baseline: 24bdcc9827fcc936c3f6f1fbfc8c4124c23c555a.
 */
export function baseSearchPool(
    db: Database,
    session = "session",
    project = "/project",
    date: { from: number; to: number } | null = null,
): StoredCompartmentChunkEmbedding[] {
    const rows = db
        .prepare(`SELECT e.compartment_id AS compartmentId, e.session_id AS sessionId,
        c.title, c.start_message AS startOrdinal, c.end_message AS endOrdinal,
        e.window_index AS windowIndex, e.start_ordinal AS windowStartOrdinal,
        e.end_ordinal AS windowEndOrdinal, e.chunk_hash AS chunkHash, e.model_id AS modelId,
        e.dims, e.vector
        FROM compartment_chunk_embeddings e JOIN compartments c ON c.id = e.compartment_id
        ${
            date
                ? `JOIN message_fts_rowid_map start_map ON start_map.session_id = c.session_id
            AND start_map.message_ordinal = c.start_message
            JOIN message_fts_rowid_map end_map ON end_map.session_id = c.session_id
            AND end_map.message_ordinal = c.end_message`
                : ""
        }
        WHERE e.session_id = ? AND e.project_path = ? AND e.model_id = ?
        ${date ? "AND start_map.message_time_ms <= ? AND end_map.message_time_ms >= ?" : ""}
        ORDER BY e.compartment_id ASC, e.window_index ASC`)
        .all(session, project, "model", ...(date ? [date.to, date.from] : [])) as (Omit<
        StoredCompartmentChunkEmbedding,
        "vector"
    > & { vector: Uint8Array })[];
    return rows.map((row) => ({
        ...row,
        vector: new Float32Array(
            row.vector.buffer.slice(
                row.vector.byteOffset,
                row.vector.byteOffset + row.vector.byteLength,
            ),
        ),
    }));
}

/** Heartbeat includes the first and last synchronous slice, not just timer ticks during awaits. */
export async function measureSearchBlock<T>(operation: () => Promise<T> | T) {
    let previous = performance.now();
    let maximum = 0;
    let running = true;
    const heartbeat = () => {
        const now = performance.now();
        maximum = Math.max(maximum, now - previous);
        previous = now;
        if (running) setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const started = performance.now();
    try {
        const value = await operation();
        const elapsed = performance.now() - started;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { value, maximum, elapsed };
    } finally {
        running = false;
    }
}
