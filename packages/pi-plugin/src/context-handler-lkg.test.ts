import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { EmergencyFailClosedError } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import { setPiTransformTimingObserver } from "./context-perf-hooks";
import { reconcilePiLkgEntryIds } from "./pi-lkg";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

type PiHandler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] } | undefined>;

function handlerFor(db: ReturnType<typeof createTestDb>): PiHandler {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	return fake.handlers.get("context") as PiHandler;
}

async function runPass(
	handler: PiHandler,
	sessionId: string,
	messages: unknown[],
	entryIds: string[],
): Promise<{ messages: never[] } | undefined> {
	return handler(
		{ messages: messages as never[] },
		fakeContext(sessionId, process.cwd(), entryIds, messages as never) as never,
	);
}

function nextImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("Pi LKG JSONL entry-id projection", () => {
	it("fills only unambiguous spans between stable JSONL anchors", () => {
		expect(
			reconcilePiLkgEntryIds(
				["entry-1", undefined, "entry-3", undefined, "entry-5"],
				["entry-1", "entry-2", "entry-3", "entry-4", "entry-5", "extra"],
			),
		).toEqual(["entry-1", "entry-2", "entry-3", "entry-4", "entry-5"]);
	});
});

describe("Pi context handler LKG replay", () => {
	const tempDirs: string[] = [];
	const sessions = new Set<string>();

	afterEach(() => {
		for (const sessionId of sessions) clearContextHandlerSession(sessionId);
		sessions.clear();
		resetLkgSlotsForTest();
		resetEmergencyRecoveryRegistryForTest();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("serves the previous transformed bytes plus the raw tail when a tagging write hits SQLITE_BUSY", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lkg-busy-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-busy";
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("original prompt", 1)];
			const first = await runPass(handler, sessionId, firstRaw, ["entry-u1"]);
			expect(first).toBeDefined();
			await nextImmediate();

			const secondRaw = [
				userMessage("original prompt", 1),
				assistantMessage("raw appended tail", 2),
			];
			const rawTail = structuredClone(secondRaw.slice(1));
			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				const replay = await runPass(handler, sessionId, secondRaw, [
					"entry-u1",
					"entry-a1",
				]);
				expect(JSON.stringify(replay?.messages)).toBe(
					JSON.stringify([...(first?.messages ?? []), ...rawTail]),
				);
				expect(logLines).toContain(
					"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG replay served 2 messages instead of raw 2",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			restoreLog();
			closeQuietly(db);
		}
	});

	it("fails closed instead of serving LKG or raw when emergency recovery meets SQLITE_BUSY", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lkg-emergency-busy-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-emergency-busy";
		sessions.add(sessionId);
		const locker = new Database(dbPath);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			recordOverflowDetected(db, sessionId, 100_000, "anthropic/fable-5-1");
			const handler = handlerFor(db);
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");

			await expect(
				runPass(
					handler,
					sessionId,
					[userMessage("overflow retry", 1)],
					["entry-u1"],
				),
			).rejects.toBeInstanceOf(EmergencyFailClosedError);
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			closeQuietly(locker);
			closeQuietly(db);
		}
	});

	it("refuses LKG when the JSONL entry-id sequence diverges and logs the raw serve", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lkg-diverged-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-diverged";
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("original prompt", 1)];
			expect(
				await runPass(handler, sessionId, firstRaw, ["entry-u1"]),
			).toBeDefined();
			await nextImmediate();

			const editedRaw = [userMessage("edited prompt", 1)];
			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				const replay = await runPass(handler, sessionId, editedRaw, [
					"entry-u1-edited",
				]);
				expect(replay).toBeUndefined();
				expect(logLines).toContain(
					"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG unavailable (lkg_invalidated_reshape); serving raw 1-message input",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			restoreLog();
			closeQuietly(db);
		}
	});

	it("logs the exact reason and raw count when a transient lock has no LKG", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lkg-miss-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-miss";
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		const locker = new Database(dbPath);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");
			const replay = await runPass(
				handler,
				sessionId,
				[
					userMessage("first locked pass", 1),
					assistantMessage("unserved locked tail", 2),
				],
				["entry-u1", "entry-a1"],
			);
			expect(replay).toBeUndefined();
			expect(logLines).toContain(
				"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG unavailable (lkg_miss); serving raw 2-message input",
			);
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			closeQuietly(locker);
			restoreLog();
			closeQuietly(db);
		}
	});

	it("hydrates the durable LKG slot in a fresh handler after a simulated process restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lkg-restart-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-restart";
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const firstHandler = handlerFor(db);
			const firstRaw = [userMessage("persist this prefix", 1)];
			const first = await runPass(firstHandler, sessionId, firstRaw, [
				"entry-u1",
			]);
			expect(first).toBeDefined();
			await nextImmediate();
			expect(
				db
					.prepare("SELECT session_id FROM lkg_slots WHERE session_id = ?")
					.get(sessionId),
			).toBeDefined();

			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			const restartedHandler = handlerFor(db);
			const secondRaw = [
				userMessage("persist this prefix", 1),
				assistantMessage("tail after restart", 2),
			];
			const rawTail = structuredClone(secondRaw.slice(1));
			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				const replay = await runPass(restartedHandler, sessionId, secondRaw, [
					"entry-u1",
					"entry-a1",
				]);
				expect(JSON.stringify(replay?.messages)).toBe(
					JSON.stringify([...(first?.messages ?? []), ...rawTail]),
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("reports deferred LKG capture as the lkgCapture timing stage", async () => {
		const db = createTestDb();
		const sessionId = "pi-lkg-capture-timing";
		const samples: Array<{ stage: string; elapsedMs: number; extra?: string }> =
			[];
		const restoreTiming = setPiTransformTimingObserver((sample) =>
			samples.push(sample),
		);
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			expect(
				await runPass(
					handler,
					sessionId,
					[userMessage("timed prompt", 1)],
					["entry-u1"],
				),
			).toBeDefined();
			await nextImmediate();

			const capture = samples.find((sample) => sample.stage === "lkgCapture");
			expect(capture?.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(capture?.extra).toBe("reusedPrefix=0");
		} finally {
			restoreTiming();
			closeQuietly(db);
		}
	});

	it("refreshes LKG on every successful SOFT+ applied pass", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lkg-refresh-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-refresh";
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("prompt", 1)];
			expect(
				await runPass(handler, sessionId, firstRaw, ["entry-u1"]),
			).toBeDefined();
			await nextImmediate();

			const secondRaw = [
				userMessage("prompt", 1),
				assistantMessage("first tail", 2),
			];
			const second = await runPass(handler, sessionId, secondRaw, [
				"entry-u1",
				"entry-a1",
			]);
			expect(second).toBeDefined();
			await nextImmediate();

			const thirdRaw = [
				userMessage("prompt", 1),
				assistantMessage("first tail", 2),
				userMessage("raw newest tail", 3),
			];
			const rawTail = structuredClone(thirdRaw.slice(2));
			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				const replay = await runPass(handler, sessionId, thirdRaw, [
					"entry-u1",
					"entry-a1",
					"entry-u2",
				]);
				expect(JSON.stringify(replay?.messages)).toBe(
					JSON.stringify([...(second?.messages ?? []), ...rawTail]),
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			closeQuietly(db);
		}
	});
});
