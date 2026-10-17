import {
	_resetCompartmentChunkSearchCacheForTests,
	loadCompartmentChunkEmbeddingsForSearch,
	type StoredCompartmentChunkEmbedding,
} from "../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { cosineSimilarity } from "../packages/plugin/src/features/magic-context/memory/embedding";
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
fixture.db
	.transaction(() => {
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
				.prepare(
					"INSERT INTO compartments VALUES (?, 'session', 'append', ?, ?)",
				)
				.run(id, id * 2, id * 2 + 1);
		}
	})
	.immediate();

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
	fixture.db
		.transaction(() => {
			for (let id = 15001; id <= 15050; id++)
				insert.run(id, id * 2, id * 2 + 1);
		})
		.immediate();
const payload = (pools: StoredCompartmentChunkEmbedding[][]) =>
	pools.reduce(
		(sum, rows) =>
			sum + rows.reduce((bytes, row) => bytes + row.vector.byteLength, 0),
		0,
	);
const estimatedPoolBytes = (
	pools: StoredCompartmentChunkEmbedding[][],
	overhead: number,
) =>
	pools.reduce(
		(sum, rows) =>
			sum +
			rows.reduce(
				(bytes, row) =>
					bytes +
					row.vector.byteLength +
					overhead +
					2 *
						(row.sessionId.length +
							row.title.length +
							row.chunkHash.length +
							row.modelId.length),
				0,
			),
		0,
	);
const query = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.1));

async function scorePool(
	rows: StoredCompartmentChunkEmbedding[],
	cooperative: boolean,
) {
	const winners = new Map<
		number,
		{ id: number; ordinal: number; score: number }
	>();
	let started = performance.now();
	for (const row of rows) {
		if (cooperative && performance.now() - started >= 4) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			started = performance.now();
		}
		const score = Math.min(1, Math.max(0, cosineSimilarity(query, row.vector)));
		const prior = winners.get(row.compartmentId);
		if (score > 0 && (!prior || score > prior.score)) {
			winners.set(row.compartmentId, {
				id: row.compartmentId,
				ordinal: row.startOrdinal,
				score,
			});
		}
	}
	return [...winners.values()]
		.sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
		.slice(0, 25)
		.map(({ id, score }) => ({ id, score: score * 0.8 }));
}

const answers: string[] = [];
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
		const search = async () => {
			const rows = await loader(...scopes[0]);
			return { rows, hits: await scorePool(rows, implementation === "tip") };
		};
		const cold = await measureSearchBlock(search);
		const pools = [cold.value.rows];
		for (const [session, project] of scopes.slice(1))
			pools.push(await loader(session, project));
		const warm = await measureSearchBlock(search);
		const before = payload(pools);
		const estimatedBefore = estimatedPoolBytes(
			pools,
			implementation === "base" ? 256 : 384,
		);
		append();
		const added = await measureSearchBlock(search);
		pools[0] = added.value.rows;
		answers.push(
			JSON.stringify([cold.value.hits, warm.value.hits, added.value.hits]),
		);
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
				estimatedPoolBytesBefore: estimatedBefore,
				estimatedPoolBytesAfter: estimatedPoolBytes(
					pools,
					implementation === "base" ? 256 : 384,
				),
			}),
		);
	}
	if (answers[0] !== answers[1])
		throw new Error("Base and tip ranking differs");
} finally {
	fixture.close();
	_resetCompartmentChunkSearchCacheForTests();
}
