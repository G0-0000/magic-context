import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

const root = mkdtempSync(join(tmpdir(), "review-lsof-"));
const db = new Database(join(root, "context.db"));
try {
	initializeDatabase(db);
	runMigrations(db);
	const output = execFileSync("lsof", ["-p", String(process.pid), "-Fn"], {
		encoding: "utf8",
	});
	const databases = output
		.split("\n")
		.filter((line) => /^n.*\.(db|db-wal|db-shm)$/.test(line));
	if (
		!databases.length ||
		databases.some((line) => !line.startsWith(`n${root}/`))
	)
		throw new Error(`unexpected open databases: ${databases.join("\n")}`);
	console.log(`lsof PID=${process.pid}: ${databases.join("; ")}`);
	console.log(
		`isolation: ${["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR"].map((key) => `${key}=${process.env[key]}`).join("; ")}`,
	);
} finally {
	db.close();
	rmSync(root, { recursive: true, force: true });
}
