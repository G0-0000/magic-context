import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiFallbackIndex } from "../../../packages/pi-plugin/src/pi-fallback-index";
import { piMessageEntryFingerprint } from "../../../packages/pi-plugin/src/pi-message-identity";
import { createPiTagSnapshotReader } from "../../../packages/pi-plugin/src/tag-snapshot-pi";
import { measurePiTailHygiene } from "../../../packages/pi-plugin/src/tail-hygiene-walk-pi";
import { runMigrations } from "../../../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../packages/plugin/src/features/magic-context/storage-db";
import { clearSession } from "../../../packages/plugin/src/features/magic-context/storage-meta-session";
import { getTagsBySession } from "../../../packages/plugin/src/features/magic-context/storage-tags";
import type { TagEntry } from "../../../packages/plugin/src/features/magic-context/types";
import { Database } from "../../../packages/plugin/src/shared/sqlite";

function harness() {
	const root = mkdtempSync(join(tmpdir(), "pi-append-review-"));
	const path = join(root, "context.db");
	const local = new Database(path);
	initializeDatabase(local);
	runMigrations(local);
	const foreign = Array.from({ length: 3 }, () => {
		const db = new Database(path);
		initializeDatabase(db);
		return db;
	});
	return {
		local,
		foreign,
		path,
		close() {
			for (const db of [local, ...foreign]) db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
function insert(
	db: Database,
	session: string,
	number: number,
	text: string,
	status = "active",
) {
	db.prepare(
		"INSERT INTO tags (session_id, message_id, type, status, tag_number, byte_size, harness) VALUES (?, ?, 'message', ?, ?, ?, 'pi')",
	).run(session, text, status, number, text.length);
}
function rng(seed: number) {
	return () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed >>> 0;
	};
}

it("review randomized snapshot equals full reload after 15000 mixed initialized-writer operations", () => {
	for (const seed of [0x650, 0xcafe, 0x5eed]) {
		const h = harness();
		const read = createPiTagSnapshotReader(h.local);
		const random = rng(seed);
		const sessions = ["session", "clone", "elsewhere"];
		let serial = 0;
		try {
			for (let step = 0; step < 5000; step++) {
				const db = [h.local, ...h.foreign][random() % 4]!;
				const session = sessions[random() % 3]!;
				const rows = getTagsBySession(h.local, session);
				const row = rows[random() % Math.max(1, rows.length)];
				const operation = random() % 12;
				const perform = () => {
					if (!row || operation === 0) {
						insert(db, session, ++serial, `m-${serial}`);
					} else if (operation === 1) {
						db.prepare(
							"UPDATE tags SET status = ?, drop_mode = ? WHERE id = ?",
						).run(
							random() % 2 ? "dropped" : "active",
							random() % 2 ? "skeleton_real" : "full",
							row.id,
						);
					} else if (operation === 2) {
						db.prepare(
							"UPDATE tags SET byte_size=?, input_byte_size=?, reasoning_byte_size=?, token_count=?, input_token_count=?, reasoning_token_count=? WHERE id=?",
						).run(
							random() % 10000,
							random() % 1000,
							random() % 1000,
							random() % 500,
							random() % 100,
							random() % 100,
							row.id,
						);
					} else if (operation === 3) {
						db.prepare("DELETE FROM tags WHERE id=?").run(row.id);
					} else if (operation === 4) {
						db.prepare(
							"UPDATE tags SET message_id=?, tag_number=? WHERE id=?",
						).run(`renamed-${++serial}`, serial, row.id);
					} else if (operation === 5) {
						db.prepare(
							"UPDATE tags SET session_id=?, tag_number=? WHERE id=?",
						).run(
							sessions[(sessions.indexOf(session) + 1) % 3],
							++serial,
							row.id,
						);
					} else if (operation === 6) {
						db.prepare(
							"UPDATE tags SET tool_owner_message_id=?, type='tool', tool_name='bash', entry_fingerprint=? WHERE id=?",
						).run(`owner-${++serial}`, `fp-${serial}`, row.id);
					} else if (operation === 7) {
						db.prepare(
							"UPDATE tags SET status='compacted' WHERE session_id=?",
						).run(session);
					} else if (operation === 8) {
						db.prepare(
							"INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness) SELECT ?, message_id || ?,type,status,?,byte_size,harness FROM tags WHERE id=?",
						).run(
							sessions[(sessions.indexOf(session) + 1) % 3],
							`-clone-${++serial}`,
							serial,
							row.id,
						);
					} else if (operation === 9) {
						db.prepare("UPDATE tags SET status='dropped' WHERE id=?").run(
							row.id,
						);
						db.prepare(
							"UPDATE tags SET status='active', byte_size=17 WHERE id=?",
						).run(row.id);
					} else if (operation === 10) {
						db.prepare(
							"INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES ('review-metadata',?)",
						).run(String(step));
					} else {
						db.prepare("DELETE FROM tags WHERE session_id=?").run(session);
					}
				};
				if (random() % 5 === 0) {
					db.exec("BEGIN");
					perform();
					if (db === h.local)
						for (const s of sessions)
							expect(JSON.stringify(read(s))).toBe(
								JSON.stringify(getTagsBySession(h.local, s)),
							);
					db.exec(random() % 2 ? "COMMIT" : "ROLLBACK");
				} else perform();
				for (const s of sessions) {
					expect(
						JSON.stringify(read(s)),
						`seed=${seed} step=${step} operation=${operation} session=${s}`,
					).toBe(JSON.stringify(getTagsBySession(h.local, s)));
				}
			}
		} finally {
			h.close();
		}
	}
}, 120000);

it("review initialized foreign clear and recreate must not alias a cached revision", () => {
	const h = harness();
	try {
		insert(h.foreign[0]!, "session", 1, "before", "active");
		const read = createPiTagSnapshotReader(h.local);
		expect(read("session")[0]?.messageId).toBe("before");
		clearSession(h.foreign[0]!, "session");
		insert(h.foreign[0]!, "session", 7, "after", "dropped");
		expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
	} finally {
		h.close();
	}
});

it("review raw foreign drop must reach snapshot even without a TEMP installer", () => {
	const h = harness();
	const raw = new Database(h.path);
	try {
		insert(h.local, "session", 1, "original");
		const read = createPiTagSnapshotReader(h.local);
		read("session");
		raw
			.prepare(
				"UPDATE tags SET status='dropped', drop_mode='skeleton_real' WHERE session_id='session'",
			)
			.run();
		expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
	} finally {
		raw.close();
		h.close();
	}
});

type Msg = { id: string; role: string; timestamp: number; content: unknown[] };
function fallback(
	index: ReturnType<typeof createPiFallbackIndex>,
	messages: Msg[],
) {
	return index.update({
		messages,
		resolveId: (m) => m.id,
		header: (m) => String(m.timestamp),
		fingerprint: piMessageEntryFingerprint,
		toolOwners: (m, id) =>
			new Map(
				m.content
					.filter((p: any) => p.type === "toolCall")
					.map((p: any) => [p.id, new Set([id])]),
			),
		reusable: new Set(messages.map((m) => m.id)),
	});
}
function msg(id: string, text = "alpha"): Msg {
	return {
		id,
		role: "assistant",
		timestamp: 123,
		content: [
			{
				type: "toolCall",
				id: "shared",
				name: "bash",
				arguments: { nested: { query: text } },
			},
		],
	};
}
it("review nested tool argument extension rewrite matches a cold fallback index", () => {
	const index = createPiFallbackIndex();
	fallback(index, [msg("one"), msg("two")]);
	const rewritten = [msg("one"), msg("two", "bravo")];
	const incremental = fallback(index, rewritten);
	const cold = fallback(createPiFallbackIndex(), rewritten);
	expect(incremental.changedFrom).toBe(1);
	expect(incremental.fingerprints(null)).toEqual(cold.fingerprints(null));
	expect(incremental.owners).toEqual(cold.owners);
	expect(incremental.positions).toEqual(cold.positions);
});
it("review removing a duplicate stable ID preserves surviving fallback owner and position", () => {
	const index = createPiFallbackIndex();
	fallback(index, [msg("same"), msg("same")]);
	const current = [msg("same")];
	const incremental = fallback(index, current);
	const cold = fallback(createPiFallbackIndex(), current);
	expect(incremental.fingerprints(null)).toEqual(cold.fingerprints(null));
	expect(incremental.owners).toEqual(cold.owners);
	expect(incremental.positions).toEqual(cold.positions);
});

function hygieneTag(number: number, status: TagEntry["status"]): TagEntry {
	return Object.freeze({
		tagNumber: number,
		messageId: "user:p0",
		type: "message",
		status,
		dropMode: "full",
		toolName: null,
		inputByteSize: 0,
		byteSize: 1,
		reasoningByteSize: 0,
		sessionId: "session",
		cavemanDepth: 0,
		toolOwnerMessageId: null,
	});
}
it("review hygiene transition to a lower-number duplicate key retains canonical last-row-wins", () => {
	const key = {};
	const high = hygieneTag(10, "active");
	const input = {
		messages: [{ role: "user", content: "unprefixed extension rewrite" }],
		protectedTagNumbers: new Set<number>(),
		stableId: () => "user",
	};
	measurePiTailHygiene({
		...input,
		tags: Object.freeze([high]),
		tagCacheKey: key,
	});
	const tags = Object.freeze([hygieneTag(1, "dropped"), high]);
	expect(measurePiTailHygiene({ ...input, tags, tagCacheKey: key })).toEqual(
		measurePiTailHygiene({ ...input, tags }),
	);
});

for (const writer of ["local", "foreign"] as const) {
	it(`review initialized ${writer} REPLACE renumber must remove the old snapshot row`, () => {
		const h = harness();
		try {
			insert(h.local, "session", 1, "original");
			const read = createPiTagSnapshotReader(h.local);
			const old = read("session")[0]!;
			const db = writer === "local" ? h.local : h.foreign[0]!;
			db.prepare(
				"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'session', 'replacement', 'message', 'dropped', 7, 11, 'pi')",
			).run(old.id);
			expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
		} finally {
			h.close();
		}
	});
}

it("review initialized foreign REPLACE session move invalidates the old session", () => {
	const h = harness();
	try {
		insert(h.local, "session", 1, "original");
		const read = createPiTagSnapshotReader(h.local);
		const old = read("session")[0]!;
		h.foreign[0]!.prepare(
			"INSERT OR REPLACE INTO tags(id,session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'clone', 'moved', 'message', 'dropped', 7, 5, 'pi')",
		).run(old.id);
		expect(read("session")).toEqual(getTagsBySession(h.local, "session"));
		expect(read("clone")).toEqual(getTagsBySession(h.local, "clone"));
	} finally {
		h.close();
	}
});
