import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

const path = process.argv[2];
if (!path) throw new Error("database required");
const db = new Database(path);
initializeDatabase(db);
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
const original = db
	.prepare("SELECT sql FROM sqlite_temp_master WHERE name='mc_tag_revision_bi'")
	.get() as { sql: string };
const native = db as unknown as {
	function(name: string, callback: () => number): void;
};
native.function("review_pause", () => {
	const revision = db
		.prepare(
			"SELECT value FROM schema_migrations_meta WHERE key='tag_identity_revision:victim'",
		)
		.get() as { value: string };
	const old = db.prepare("SELECT message_id FROM tags WHERE id=1").get() as {
		message_id: string;
	};
	writeSync(1, `READY observer=${revision.value} old=${old.message_id}\n`);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	return 0;
});
db.exec("DROP TRIGGER temp.mc_tag_revision_bi");
// Node's native SQLite callback pauses after the real observer body but before insertion.
db.exec(
	original.sql
		.replace(/^CREATE TRIGGER/i, "CREATE TEMP TRIGGER")
		.replace(/END\s*$/, "SELECT review_pause(); END"),
);
db.prepare(
	"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (1,'destination','replacement','message','dropped',7,9,'pi')",
).run();
throw new Error("crash probe must be killed before the insert completes");
