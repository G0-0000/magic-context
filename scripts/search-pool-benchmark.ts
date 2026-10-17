import {
	_resetCompartmentChunkSearchCacheForTests,
	loadCompartmentChunkEmbeddingsForSearch,
	type StoredCompartmentChunkEmbedding,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import {
	baseSearchPool,
	measureSearchBlock,
	searchPoolFixture,
} from "../packages/plugin/src/features/magic-context/search-pool-fixture";
import type { Database } from "../packages/plugin/src/shared/sqlite";

// This benchmark creates its own synthetic database; it accepts no store path.
const fixture = searchPoolFixture(15000, 4096);
const scopes = [
	["session", "/project"],
	["session-b", "/project"],
	["session-c", "/project-b"],
	["session-d", "/project-c"],
] as const;
fixture.db.transaction(() => {
	for (let scope = 1; scope < scopes.length; scope++) {
		const [session, project] = scopes[scope];
		const from = 14001 + (scope - 1) * 333;
		const to = scope === 3 ? 15000 : from + 332;
		fixture.db
			.prepare(
				"UPDATE compartment_chunk_embeddings SET session_id = ?, project_path = ? WHERE id BETWEEN ? AND ?",
			)
			.run(session, project, from, to);
		fixture.db
			.prepare(
				"UPDATE compartments SET session_id = ? WHERE id BETWEEN ? AND ?",
			)
			.run(session, from, to);
	}
	for (let id = 15001; id <= 15050; id++) {
		fixture.db
			.prepare("INSERT INTO compartments VALUES (?, 'session', 'append', ?, ?)")
			.run(id, id * 2, id * 2 + 1);
	}
})();

function baseLoader(db: Database) {
	const cache = new Map<
		string,
		{ count: number; max: number; rows: StoredCompartmentChunkEmbedding[] }
	>();
	return (session: string, project: string) => {
		const key = JSON.stringify([session, project, "model"]);
		const probe = db
			.prepare(`SELECT COUNT(*) AS count, MAX(id) AS max FROM compartment_chunk_embeddings
            WHERE session_id = ? AND project_path = ? AND model_id = 'model'`)
			.get(session, project) as { count: number; max: number };
		const cached = cache.get(key);
		if (cached && cached.count === probe.count && cached.max === probe.max) {
			const current = new Map(
				(
					db
						.prepare(`SELECT id, title, start_message AS startOrdinal, end_message AS endOrdinal
                FROM compartments WHERE id IN (SELECT compartment_id FROM compartment_chunk_embeddings
                WHERE session_id = ? AND project_path = ? AND model_id = 'model')`)
						.all(session, project) as {
						id: number;
						title: string;
						startOrdinal: number;
						endOrdinal: number;
					}[]
				).map((row) => [row.id, row]),
			);
			for (const row of cached.rows)
				Object.assign(row, current.get(row.compartmentId));
			return cached.rows;
		}
		const rows = baseSearchPool(db, session, project);
		cache.set(key, { ...probe, rows });
		return rows;
	};
}

const insert = fixture.db.prepare(`INSERT INTO compartment_chunk_embeddings
    SELECT NULL, ?, session_id, project_path, 0, ?, ?, chunk_hash, model_id, dims, vector
    FROM compartment_chunk_embeddings WHERE id = 1`);
const append = () =>
	fixture.db.transaction(() => {
		for (let id = 15001; id <= 15050; id++) insert.run(id, id * 2, id * 2 + 1);
	})();
const payload = (pools: StoredCompartmentChunkEmbedding[][]) =>
	pools.reduce(
		(sum, rows) =>
			sum + rows.reduce((bytes, row) => bytes + row.vector.byteLength, 0),
		0,
	);
try {
	for (const implementation of ["base", "tip"] as const) {
		fixture.db.exec(
			"DELETE FROM compartment_chunk_embeddings WHERE compartment_id > 15000",
		);
		_resetCompartmentChunkSearchCacheForTests();
		const base = baseLoader(fixture.db);
		const loader = (session: string, project: string) =>
			implementation === "base"
				? base(session, project)
				: loadCompartmentChunkEmbeddingsForSearch(
						fixture.db,
						session,
						project,
						"model",
					);
		const cold = await measureSearchBlock(() => loader(...scopes[0]));
		const pools = [cold.value];
		for (const [session, project] of scopes.slice(1)) pools.push(await loader(session, project));
		const warm = await measureSearchBlock(() => loader(...scopes[0]));
		const before = payload(pools);
		append();
		const added = await measureSearchBlock(() => loader(...scopes[0]));
		pools[0] = added.value;
		console.log(
			JSON.stringify({
				implementation,
				runtime: process.version,
				rows: 15000,
				dims: 4096,
				pools: scopes.length,
				cold: { blockMs: cold.maximum, elapsedMs: cold.elapsed },
				warm: { blockMs: warm.maximum, elapsedMs: warm.elapsed },
				append50: { blockMs: added.maximum, elapsedMs: added.elapsed },
				vectorBytesBefore: before,
				vectorBytesAfter: payload(pools),
			}),
		);
	}
} finally {
	fixture.close();
	_resetCompartmentChunkSearchCacheForTests();
}
