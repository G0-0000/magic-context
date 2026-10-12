import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

const root = mkdtempSync(join(tmpdir(), "observer-cost-"));
const percentile = (values: number[], fraction: number) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)]!;
const samples: Record<string, number[]> = {};
try {
	for (const kind of ["message", "tool"]) {
		for (const bulk of [false, true]) {
			for (let repeat = 0; repeat < 9; repeat++) {
				// Alternate order to reduce cache warm-up and machine-drift bias.
				for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
					const db = new Database(
						join(root, `${kind}-${bulk}-${repeat}-${enabled}.db`),
					);
					initializeDatabase(db);
					runMigrations(db);
					if (!enabled) db.exec("DROP TRIGGER temp.mc_tag_revision_bi");
					const insert = db.prepare(
						"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness,tool_owner_message_id) VALUES ('bench',?,?,'active',?,9,'pi',?)",
					);
					let serial = 0;
					const append = () => {
						const n = ++serial;
						insert.run(
							`call-${n}`,
							kind,
							n,
							kind === "tool" ? `owner-${n}` : null,
						);
					};
					db.transaction(() => {
						for (let n = 0; n < 10000; n++) append();
					}).immediate();
					const count = bulk ? 10000 : 1000;
					const start = performance.now();
					if (bulk)
						db.transaction(() => {
							for (let n = 0; n < count; n++) append();
						}).immediate();
					else for (let n = 0; n < count; n++) append();
					const key = `${kind}-${bulk ? "bulk" : "autocommit"}-${enabled ? "observer" : "no-observer"}`;
					const values = samples[key] ?? [];
					samples[key] = values;
					values.push(((performance.now() - start) / count) * 1000);
					const actual = db.prepare("SELECT COUNT(*) AS n FROM tags").get() as {
						n: number;
					};
					if (actual.n !== 10000 + count)
						throw new Error("benchmark did not insert rows");
					db.close();
				}
			}
		}
	}
	console.log(
		`observer cost Bun ${Bun.version}: 72 databases, 396000 measured inserts, nine samples per cell; us/row`,
	);
	for (const [key, values] of Object.entries(samples))
		console.log(
			JSON.stringify({
				key,
				median: percentile(values, 0.5),
				p90: percentile(values, 0.9),
				samples: values,
			}),
		);
} finally {
	rmSync(root, { recursive: true, force: true });
}
