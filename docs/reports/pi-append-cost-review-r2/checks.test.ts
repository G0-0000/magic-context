import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiTagSnapshotReader } from "../../../packages/pi-plugin/src/tag-snapshot-pi";
import { sweepOrphanedOpenCodeMessageIndexes } from "../../../packages/plugin/src/features/magic-context/message-index";
import { runMigrations } from "../../../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { clearSession } from "../../../packages/plugin/src/features/magic-context/storage-meta-session";
import { tagIdentityRevisionKey } from "../../../packages/plugin/src/features/magic-context/storage-tag-identity-revision";
import { getTagsBySession } from "../../../packages/plugin/src/features/magic-context/storage-tags";
import { createTagger } from "../../../packages/plugin/src/features/magic-context/tagger";
import {
	_resetHarnessForTesting,
	setHarness,
} from "../../../packages/plugin/src/shared/harness";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "r2-"));
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	return {
		db,
		path,
		close() {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function insert(
	db: Database,
	session: string,
	number: number,
	message: string,
	harness = "pi",
) {
	db.prepare(
		"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?,?,'message','active',?,9,?)",
	).run(session, message, number, harness);
}
function epoch(db: Database, session: string) {
	return db
		.prepare("SELECT value FROM schema_migrations_meta WHERE key=?")
		.get(tagIdentityRevisionKey(session));
}
function child(path: string, mode: string) {
	const args =
		mode === "crash"
			? ["node", process.env.REVIEW_CRASH_RUNNER!, path]
			: [
					process.execPath,
					"--tsconfig-override",
					"packages/pi-plugin/tsconfig.json",
					join(import.meta.dir, "process-writer.ts"),
					path,
					mode,
				];
	return Bun.spawn(args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
		env: process.env,
	});
}
async function ready(proc: ReturnType<typeof child>) {
	const reader = proc.stdout.getReader();
	let text = "";
	while (!text.includes("READY")) {
		const result = await reader.read();
		if (result.done) throw new Error(`child ended before ready: ${text}`);
		text += new TextDecoder().decode(result.value);
	}
	console.log(text.trim());
	reader.releaseLock();
	return text;
}

it("r2 repeated clear and recreate stays canonical over 40 missed empty intervals", () => {
	const h = fixture();
	const writer = new Database(h.path);
	initializeDatabase(writer);
	const read = createPiTagSnapshotReader(h.db);
	try {
		insert(writer, "cycle", 1, "initial");
		read("cycle");
		for (let n = 1; n <= 40; n++) {
			clearSession(writer, "cycle");
			insert(writer, "cycle", n + 1, `cycle-${n}`);
			writer
				.prepare(
					"UPDATE tags SET status='dropped',drop_mode='skeleton_real' WHERE session_id='cycle'",
				)
				.run();
			expect(JSON.stringify(read("cycle"))).toBe(
				JSON.stringify(getTagsBySession(h.db, "cycle")),
			);
		}
	} finally {
		writer.close();
		h.close();
	}
});

it("r2 REPLACE moving one explicit ID across three sessions invalidates every former owner", () => {
	const h = fixture();
	const writer = new Database(h.path);
	initializeDatabase(writer);
	const read = createPiTagSnapshotReader(h.db);
	try {
		insert(h.db, "a", 1, "original");
		const id = read("a")[0]!.id;
		for (const s of ["b", "c", "a", "c", "b"]) {
			for (const name of ["a", "b", "c"]) read(name);
			writer
				.prepare(
					"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, ?, ?, 'message','dropped',7,9,'pi')",
				)
				.run(id, s, `moved-${s}`);
			for (const name of ["a", "b", "c"])
				expect(read(name)).toEqual(getTagsBySession(h.db, name));
		}
	} finally {
		writer.close();
		h.close();
	}
});

it("r2 production clear racing a separate-process append preserves the committed suffix", async () => {
	const h = fixture();
	insert(h.db, "race", 1, "before");
	const read = createPiTagSnapshotReader(h.db);
	read("race");
	const clearer = child(h.path, "clear");
	let appender: ReturnType<typeof child> | undefined;
	try {
		await ready(clearer);
		appender = child(h.path, "append");
		await ready(appender);
		expect(read("race")[0]?.messageId).toBe("before");
		clearer.stdin.write("commit\n");
		clearer.stdin.end();
		expect(await clearer.exited).toBe(0);
		expect(await appender.exited).toBe(0);
		expect(read("race")).toEqual(getTagsBySession(h.db, "race"));
		expect(
			read("race").map((r) => [r.messageId, r.tagNumber, r.status]),
		).toEqual([["after", 7, "dropped"]]);
	} finally {
		clearer.kill();
		appender?.kill();
		await clearer.exited;
		if (appender) await appender.exited;
		h.close();
	}
}, 30000);

it("r2 SIGKILL after the conflict observer rolls back rows and both invalidation signals", async () => {
	const h = fixture();
	insert(h.db, "victim", 1, "original");
	const read = createPiTagSnapshotReader(h.db);
	read("victim");
	const before = h.db
		.prepare("SELECT key,value FROM schema_migrations_meta ORDER BY key")
		.all();
	const versions = h.db
		.prepare(
			"SELECT session_id,tags_version FROM session_meta ORDER BY session_id",
		)
		.all();
	const proc = child(h.path, "crash");
	try {
		expect(await ready(proc)).toContain("observer=1 old=original");
		expect(epoch(h.db, "victim")).toBeNull();
		proc.kill("SIGKILL");
		await proc.exited;
		expect(proc.signalCode).toBe("SIGKILL");
		expect(
			h.db
				.prepare("SELECT key,value FROM schema_migrations_meta ORDER BY key")
				.all(),
		).toEqual(before);
		expect(
			h.db
				.prepare(
					"SELECT session_id,tags_version FROM session_meta ORDER BY session_id",
				)
				.all(),
		).toEqual(versions);
		expect(read("victim")[0]?.messageId).toBe("original");
		expect(read("destination")).toEqual([]);
		insert(h.db, "destination", 7, "after-crash");
		expect(read("destination")).toEqual(getTagsBySession(h.db, "destination"));
	} finally {
		proc.kill();
		await proc.exited;
		h.close();
	}
}, 30000);

for (const harness of ["opencode", "opencode2", "pi"] as const) {
	it(`r2 ${harness} unchanged tagger has no epoch bump or assignment rebuild on ordinary passes`, () => {
		_resetHarnessForTesting();
		setHarness(harness);
		const h = fixture();
		const tagger = createTagger();
		try {
			const number = tagger.assignTag("idle", "u:p0", "message", 9, h.db);
			tagger.initFromDb("idle", h.db);
			const saved = epoch(h.db, "idle");
			const original = h.db.prepare.bind(h.db);
			let assignmentReads = 0;
			const spy = spyOn(h.db, "prepare").mockImplementation(((sql: string) => {
				const statement = original(sql);
				if (
					!sql.includes(
						"SELECT message_id, tag_number, type, tool_owner_message_id",
					)
				)
					return statement;
				return new Proxy(statement, {
					get(target, property) {
						if (property === "all")
							return (...params: unknown[]) => {
								assignmentReads++;
								return target.all(...params);
							};
						const value = Reflect.get(target, property);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			}) as typeof h.db.prepare);
			try {
				clearSession(h.db, "unrelated");
				for (let i = 0; i < 30; i++) {
					insert(h.db, `other-${i}`, number, `new-${i}`, harness);
					tagger.initFromDb("idle", h.db);
					expect(tagger.getTag("idle", "u:p0", "message")).toBe(number);
					expect(epoch(h.db, "idle")).toEqual(saved);
				}
				expect(assignmentReads).toBe(0);
			} finally {
				spy.mockRestore();
			}
		} finally {
			tagger.cleanup("idle");
			h.close();
			_resetHarnessForTesting();
		}
	});
}

it("r2 quoted session tombstone is discovered and swept without touching Pi epochs", async () => {
	_resetHarnessForTesting();
	setHarness("opencode");
	const h = fixture();
	const id = 'orphan:"quoted;id\\tail';
	const hostPath = join(process.env.TMPDIR!, "r2-host.db");
	const host = new Database(hostPath);
	host.exec("CREATE TABLE session(id TEXT PRIMARY KEY)");
	host.close();
	try {
		insert(h.db, id, 1, "orphan", "opencode");
		clearSession(h.db, id);
		insert(h.db, "pi-only", 1, "pi-owned", "pi");
		clearSession(h.db, "pi-only");
		const piEpoch = epoch(h.db, "pi-only");
		expect(
			h.db.prepare("SELECT * FROM tags WHERE session_id=?").all(id),
		).toEqual([]);
		const result = await sweepOrphanedOpenCodeMessageIndexes(
			h.db,
			() => new Database(hostPath),
			{ now: Date.now(), safetyAgeMs: 0, cooldownMs: 0 },
		);
		expect(result.deleted).toBe(1);
		expect(epoch(h.db, id)).toBeNull();
		expect(epoch(h.db, "pi-only")).toEqual(piEpoch);
	} finally {
		h.close();
		rmSync(hostPath, { force: true });
		_resetHarnessForTesting();
	}
});

it("r2 terminal deletion then ID reuse starts with a clean counter and no inherited drop", () => {
	const h = fixture();
	const tagger = createTagger();
	try {
		tagger.assignTag("reuse", "old:p0", "message", 9, h.db);
		h.db
			.prepare(
				"UPDATE tags SET status='dropped', drop_mode='skeleton_real' WHERE session_id='reuse'",
			)
			.run();
		clearSession(h.db, "reuse");
		clearSession(h.db, "reuse", false, true);
		tagger.cleanup("reuse");
		expect(epoch(h.db, "reuse")).toBeNull();
		expect(tagger.assignTag("reuse", "new:p0", "message", 9, h.db)).toBe(1);
		const rows = createPiTagSnapshotReader(h.db)("reuse");
		expect(
			rows.map((r) => [r.messageId, r.tagNumber, r.status, r.dropMode]),
		).toEqual([["new:p0", 1, "active", "full"]]);
	} finally {
		tagger.cleanup("reuse");
		h.close();
	}
});
