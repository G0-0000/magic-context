import { Database as NativeDatabase } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { clearSession } from "../../../packages/plugin/src/features/magic-context/storage-meta-session";
import type { Database } from "../../../packages/plugin/src/shared/sqlite";

const [path, mode] = process.argv.slice(2);
if (!path || !mode) throw new Error("database and mode required");
const db = new NativeDatabase(path);
initializeDatabase(db as unknown as Database);
db.exec("PRAGMA busy_timeout=10000");
const fds = execFileSync("lsof", ["-p", String(process.pid), "-Fn"], {
	encoding: "utf8",
});
const stores = fds
	.split("\n")
	.filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line));
if (
	!stores.length ||
	stores.some((line) => !line.startsWith(`n${process.env.TMPDIR}/`))
)
	throw new Error(`unsafe descriptors: ${stores.join(";")}`);
console.log(`child lsof PID=${process.pid}: ${stores.join(";")}`);

if (mode === "clear") {
	db.exec("BEGIN IMMEDIATE");
	clearSession(db as unknown as Database, "race");
	writeSync(1, "READY cleared within uncommitted transaction\n");
	await Bun.stdin.stream().getReader().read();
	db.exec("COMMIT");
} else if (mode === "append") {
	writeSync(1, "READY appending on separate initialized process\n");
	db.prepare(
		"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness) VALUES ('race','after','message','dropped',7,9,'pi')",
	).run();
} else throw new Error(`unknown mode ${mode}`);
db.close();
