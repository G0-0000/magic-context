import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getTagsBySession,
	normalizeTagSnapshotRow,
	TAG_SELECT_COLUMNS,
} from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	createPiTagSnapshotCandidate,
	getPiTagSnapshotView,
	loadPiTagSnapshotCandidate,
	PI_FALLBACK_ROW_COLUMNS,
	PI_FALLBACK_ROW_PREDICATE,
	type PiFallbackTagRow,
	type PiTagSnapshotToken,
	readPiTagSnapshotRevision,
	samePiTagSnapshotToken,
} from "./tag-snapshot-pi";

function fixture() {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-tag-hydration-"));
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	const foreign = new Database(path);
	initializeDatabase(foreign);
	return {
		db,
		foreign,
		path,
		close() {
			foreign.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function seed(db: Database) {
	const insert = db.prepare(`INSERT INTO tags
		(session_id, tag_number, message_id, type, status, byte_size, tool_owner_message_id, entry_fingerprint)
		VALUES ('s', ?, ?, ?, ?, ?, ?, ?)`);
	insert.run(8, "pi-msg-8:p0", "message", "active", 80, null, "fingerprint-8");
	insert.run(2, "call-2", "tool", "dropped", 20, "PI-MSG-2", "fingerprint-2");
	insert.run(5, "entry-5", "file", "compacted", 50, null, null);
	insert.run(11, "entry-11", "legacy", "legacy", 0, null, null);
	db.exec(`UPDATE tags SET drop_mode = 'legacy', caveman_depth = NULL,
		input_byte_size = NULL, reasoning_byte_size = NULL, token_count = NULL WHERE tag_number = 11`);
}

function assemble(db: Database, cached = getPiTagSnapshotView(db, "s")) {
	return loadPiTagSnapshotCandidate(async (candidate) => {
		const rows = db
			.prepare(
				`SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = 's' ORDER BY tag_number, id`,
			)
			.all();
		for (const raw of rows) {
			const tag = normalizeTagSnapshotRow(raw);
			if (tag) candidate.appendTag(tag);
		}
		candidate.end("tags");
		for (const row of db
			.prepare(
				`SELECT ${PI_FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = 's' AND ${PI_FALLBACK_ROW_PREDICATE}`,
			)
			.all()) {
			candidate.appendFallback(row as PiFallbackTagRow);
		}
		candidate.end("fallback");
	}, cached);
}

it("candidate exposes neither stream until both end markers arrive", () => {
	const candidate = createPiTagSnapshotCandidate();
	expect(() => candidate.finish()).toThrow("incomplete candidate");
	candidate.end("tags");
	expect(() => candidate.finish()).toThrow("incomplete candidate");
	candidate.end("fallback");
	expect(candidate.finish()).toMatchObject({
		tags: [],
		active: [],
		fallback: [],
	});
	expect(() => candidate.end("fallback")).toThrow("duplicate fallback end");
	expect(() => candidate.finish()).toThrow("incomplete candidate");
});

it("hydration publishes an empty complete session", async () => {
	const { db, close } = fixture();
	try {
		const result = await assemble(db, []);
		expect(result.tags).toEqual([]);
		expect(result.active).toEqual([]);
		expect(result.fallback).toEqual([]);
	} finally {
		close();
	}
});

it("candidate matches the independent synchronous process oracle including fallback order and legacy normalization", async () => {
	const { db, path, close } = fixture();
	try {
		seed(db);
		// The oracle imports no candidate code and opens its own connection. Its
		// fallback SQL intentionally has no ORDER BY, just like the baseline.
		const core = new URL("../../plugin/src/", import.meta.url).pathname;
		const script = `
			import { Database } from ${JSON.stringify(`${core}shared/sqlite.ts`)};
			import { getTagsBySession } from ${JSON.stringify(`${core}features/magic-context/storage-tags.ts`)};
			const db = new Database(process.argv[1], { readonly: true });
			const tags = getTagsBySession(db, 's');
			const fallback = db.prepare("SELECT id, tag_number, type, message_id, tool_owner_message_id, entry_fingerprint FROM tags WHERE session_id = 's' AND ((type = 'message' AND message_id LIKE 'pi-msg-%') OR (type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%'))").all();
			console.log(JSON.stringify({ tags, active: tags.filter(t => t.status === 'active'), fallback }));
			db.close();`;
		const oracle = Bun.spawn([process.execPath, "--eval", script, path], {
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [output, error, exit] = await Promise.all([
			new Response(oracle.stdout).text(),
			new Response(oracle.stderr).text(),
			oracle.exited,
		]);
		expect({ exit, error }).toEqual({ exit: 0, error: "" });
		const { estimatedBytes, ...candidate } = await assemble(db, []);
		expect(JSON.stringify(candidate)).toBe(output.trim());
		expect(candidate.tags.map((row) => row.tagNumber)).toEqual([2, 5, 8, 11]);
		expect(candidate.tags.at(-1)).toMatchObject({
			type: "message",
			status: "active",
			cavemanDepth: 0,
			dropMode: "full",
		});
		expect(estimatedBytes).toBeGreaterThan(0);
	} finally {
		close();
	}
});

it("hydration reuses every unchanged frozen row", async () => {
	const { db, foreign, close } = fixture();
	try {
		seed(db);
		const old = getPiTagSnapshotView(db, "s");
		foreign.exec("UPDATE tags SET byte_size = 81 WHERE tag_number = 8");
		const candidate = await assemble(db, old);
		expect(candidate.tags).toEqual(getTagsBySession(db, "s"));
		for (let index = 0; index < old.length; index++) {
			if (old[index]?.tagNumber === 8)
				expect(candidate.tags[index]).not.toBe(old[index]);
			else expect(candidate.tags[index]).toBe(old[index]);
			expect(Object.isFrozen(candidate.tags[index])).toBe(true);
		}
		expect(candidate.active[0]).toBe(candidate.tags[2]);
	} finally {
		close();
	}
});

it("candidate rejects noncanonical input and memory overflow without exposing a prefix", async () => {
	const { db, close } = fixture();
	try {
		seed(db);
		const rows = getTagsBySession(db, "s");
		const first = rows[0];
		if (!first) throw new Error("missing seeded row");
		const outOfOrder = createPiTagSnapshotCandidate();
		outOfOrder.appendTag(first);
		expect(() => outOfOrder.appendTag(first)).toThrow("noncanonical");
		expect(() => outOfOrder.finish()).toThrow("incomplete");
		const overLimit = createPiTagSnapshotCandidate([], 193);
		expect(() => overLimit.appendTag(first)).toThrow("memory limit");
		expect(() => overLimit.finish()).toThrow("incomplete");
		expect(normalizeTagSnapshotRow({ id: 3 })).toBeNull();
		expect(normalizeTagSnapshotRow(null)).toBeNull();
	} finally {
		close();
	}
});

it("candidate authority includes rollback-safe revisions, incarnation and destination lifetime", () => {
	const { db, foreign, close } = fixture();
	try {
		seed(db);
		const revision = readPiTagSnapshotRevision(db, "s");
		if (!revision) throw new Error("missing revision outside transaction");
		const token: PiTagSnapshotToken = {
			connectionEpoch: 1,
			sessionEpoch: 1,
			jobId: 1,
			sessionId: "s",
			localRevision: revision[0],
			foreignRevision: revision[1],
			durableVersion: 4,
			ownVersion: 0,
			dataVersion: 1,
		};
		db.exec("BEGIN; UPDATE tags SET byte_size = 99; ROLLBACK");
		expect(readPiTagSnapshotRevision(db, "s")).toEqual(revision);
		foreign.exec(
			"DELETE FROM schema_migrations_meta WHERE key = 'tag_revision:s'; UPDATE tags SET byte_size = 99 WHERE tag_number = 8",
		);
		const after = readPiTagSnapshotRevision(db, "s");
		if (!after) throw new Error("missing revision after incarnation change");
		expect(after[1]).not.toBe(revision[1]);
		expect(samePiTagSnapshotToken(token, { ...token })).toBe(true);
		for (const [field, value] of Object.entries(token)) {
			const changed = typeof value === "number" ? value + 1 : `${value}:new`;
			expect(
				samePiTagSnapshotToken(token, { ...token, [field]: changed }),
			).toBe(false);
		}
		expect(
			samePiTagSnapshotToken(token, { ...token, foreignRevision: after[1] }),
		).toBe(false);
	} finally {
		close();
	}
});
