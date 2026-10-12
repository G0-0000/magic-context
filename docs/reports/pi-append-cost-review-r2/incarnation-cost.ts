import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { TAG_REVISION_INCARNATION_KEY } from "../../../packages/plugin/src/features/magic-context/storage-tag-identity-revision";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

const root = mkdtempSync(join(tmpdir(), "incarnation-cost-"));
const samples = new Map<string, number[]>();
let measured = 0;
let clockChecks = 0;
try {
	for (const kind of ["message", "tool"]) {
		for (const bulk of [false, true]) {
			for (let repeat = 0; repeat < 9; repeat++) {
				for (const enabled of repeat % 2 ? [true, false] : [false, true]) {
					const db = new Database(
						join(root, `${kind}-${bulk}-${repeat}-${enabled}.db`),
					);
					try {
						initializeDatabase(db);
						runMigrations(db);
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
						const clock = db.prepare(
							"SELECT value FROM schema_migrations_meta WHERE key=?",
						);
						const before = JSON.stringify(
							clock.get(TAG_REVISION_INCARNATION_KEY),
						);
						// Drop mc_tag_revision_seed_ai only after tag_revision:bench and
						// tag_identity_revision:bench exist. Compare the trigger installed vs
						// removed; existing-counter update SQL and all tag observers are unchanged.
						if (!enabled) db.exec("DROP TRIGGER temp.mc_tag_revision_seed_ai");
						const count = bulk ? 10000 : 1000;
						const start = performance.now();
						if (bulk)
							db.transaction(() => {
								for (let n = 0; n < count; n++) append();
							}).immediate();
						else for (let n = 0; n < count; n++) append();
						const elapsed = ((performance.now() - start) / count) * 1000;
						if (
							JSON.stringify(clock.get(TAG_REVISION_INCARNATION_KEY)) !== before
						)
							throw new Error("warm inserts advanced the incarnation clock");
						clockChecks++;
						if (
							(
								db.prepare("SELECT COUNT(*) AS n FROM tags").get() as {
									n: number;
								}
							).n !==
							10000 + count
						)
							throw new Error("warm insertion benchmark did not execute");
						measured += count;
						const key = `${kind}-${bulk ? "bulk" : "autocommit"}-${enabled ? "seed-observer" : "no-seed-observer"}`;
						const values = samples.get(key) ?? [];
						values.push(elapsed);
						samples.set(key, values);
					} finally {
						db.close();
					}
				}
			}
		}
	}
	const percentile = (values: number[], fraction: number) => {
		const value = [...values].sort((a, b) => a - b)[
			Math.floor(values.length * fraction)
		];
		if (value === undefined) throw new Error("missing timing samples");
		return value;
	};
	console.log(
		`incarnation warm cost Bun ${Bun.version}: ${clockChecks} databases/unchanged-clock checks, ${measured} measured inserts, us/row`,
	);
	for (const [key, values] of samples)
		console.log(
			JSON.stringify({
				key,
				median: percentile(values, 0.5),
				p90: percentile(values, 0.9),
			}),
		);
} finally {
	rmSync(root, { recursive: true, force: true });
}
