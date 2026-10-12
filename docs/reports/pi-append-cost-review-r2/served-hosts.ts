import { expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { clearSession } from "../../../packages/plugin/src/features/magic-context/storage-meta-session";
import { getTagsBySession } from "../../../packages/plugin/src/features/magic-context/storage-tags";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

const baseline = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("archived baseline required");
const root = join(process.env.TMPDIR!, "host-bytes");
mkdirSync(root, { recursive: true });
const original = readFileSync(
	"packages/pi-plugin/src/issue-640-641-combined-differential.test.ts",
	"utf8",
);
const fixture = join(root, "ordinary.test.ts");
// Keep both versions' fixture clocks identical; runtime modules are independently versioned.
writeFileSync(
	fixture,
	`Date.now = () => 1800000000000;\n${original}`
		.replace(
			"const db = openDatabase();",
			'const db = openDatabase(join(evidenceRoot(), "oc1-context.db"));',
		)
		.replaceAll(
			"CREATE TABLE session_message",
			"CREATE TABLE IF NOT EXISTS session_message",
		)
		.replaceAll(
			"CREATE TABLE session_v2",
			"CREATE TABLE IF NOT EXISTS session_v2",
		)
		.replace(
			"times.push(performance.now() - start);\n\t\t\t\tconst wire",
			'times.push(performance.now() - start);\n\t\t\t\tif (i === 0) writeFileSync(join(evidenceRoot(), "pi-first.json"), JSON.stringify(result.messages));\n\t\t\t\tconst wire',
		)
		.replace(
			"if (i >= 2) wires.push(JSON.stringify(output.messages));",
			'if (i === 0) writeFileSync(join(evidenceRoot(), "oc1-first.json"), JSON.stringify(output.messages));\n\t\t\t\tif (i >= 2) wires.push(JSON.stringify(output.messages));',
		)
		.replace(
			"if (i >= 2) wires.push(JSON.stringify(draft));",
			'if (i === 0) writeFileSync(join(evidenceRoot(), "oc2-first.json"), JSON.stringify(draft));\n\t\t\t\tif (i >= 2) wires.push(JSON.stringify(draft));',
		),
);
try {
	for (const [name, pattern] of [
		["pi", "independent Pi defer"],
		["oc1", "independent OpenCode1 defer"],
		["oc2", "independent OpenCode2 defer"],
	]) {
		const output = join(root, name!);
		mkdirSync(output, { recursive: true });
		const env = {
			...process.env,
			REVIEW_OUTPUT: output,
			REVIEW_CWD: "/review/project",
			MAGIC_CONTEXT_STORAGE_DIR: join(output, "store"),
		};
		const run = async (source: string) => {
			const proc = Bun.spawn(
				[
					process.execPath,
					"test",
					"--tsconfig-override",
					join(source, "packages/pi-plugin/tsconfig.json"),
					fixture,
					"-t",
					pattern!,
					"--timeout",
					"120000",
				],
				{
					env: { ...env, REVIEW_SOURCE: source },
					stdout: "inherit",
					stderr: "inherit",
				},
			);
			if ((await proc.exited) !== 0)
				throw new Error(`${name} fixture failed for ${source}`);
		};
		await run(baseline);
		const old = readFileSync(join(output, `${name}.json`), "utf8");
		const path =
			name === "pi"
				? join(output, "pi-context.db")
				: name === "oc2"
					? join(output, "v2-store/context.db")
					: join(output, "oc1-context.db");
		const db = new Database(path);
		initializeDatabase(db);
		const session =
			name === "pi"
				? "review-pi"
				: name === "oc1"
					? "review-oc1"
					: "review-oc2";
		const stamp = () =>
			db
				.prepare(
					"SELECT key,value FROM schema_migrations_meta WHERE key IN (?,?) ORDER BY key",
				)
				.all(`tag_identity_revision:${session}`, `tag_revision:${session}`);
		const before = stamp();
		const tagsBefore = JSON.stringify(getTagsBySession(db, session));
		clearSession(db, "unrelated-tombstone");
		expect(stamp()).toEqual(before);
		try {
			await run(process.cwd());
			expect(stamp()).toEqual(before);
			expect(JSON.stringify(getTagsBySession(db, session))).toBe(tagsBefore);
		} finally {
			db.close();
		}
		const current = readFileSync(join(output, `${name}.json`), "utf8");
		const first = readFileSync(join(output, `${name}-first.json`), "utf8");
		expect(current).toBe(old);
		expect(first).toBe(old);
		console.log(
			`HOST_BYTE_PARITY ${name}: first upgraded pass + 30 ordinary passes, ${Buffer.byteLength(current)} bytes, sha256=${new Bun.CryptoHasher("sha256").update(current).digest("hex")}`,
		);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
