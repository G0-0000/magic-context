import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import * as persistence from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	dropSlot,
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createPiLkgCoordinator } from "./pi-lkg";
import {
	publishPiServedNumbers,
	readPiCommittedServedNumbers,
} from "./pi-served-identities";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
	getPiServedArrayLedgerPath,
	getPiServedTagNumbers,
	getPiServedTagNumbersPath,
} from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

async function fixture(
	run: (
		db: ReturnType<typeof createTestDb>,
		sessionId: string,
		root: string,
	) => void | Promise<void>,
) {
	const { dir: root, cleanup } = createTestTempDir("pi-pair-publication-");
	const dataHome = process.env.XDG_DATA_HOME;
	const configHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = root;
	const db = createTestDb(join(root, "context.db"));
	const sessionId = "pi-pair-publication";
	try {
		await run(db, sessionId, root);
	} finally {
		flushPiServedArrayLedger();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
		if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = dataHome;
		if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = configHome;
		cleanup();
	}
}

function capture(db: ReturnType<typeof createTestDb>, sessionId: string) {
	const coordinator = createPiLkgCoordinator(db, () => {
		throw new Error("managed publication must not defer");
	});
	const raw = [userMessage("input", 1)];
	return (
		text: string,
		numbers: number[],
		publish = () => publishPiServedNumbers(db, sessionId, numbers),
	) =>
		coordinator.captureAppliedPass({
			snapshot: coordinator.beginPass({
				sessionId,
				messages: raw,
				entryIds: ["entry-1"],
				modelKey: null,
				providerKey: null,
			}),
			outputMessages: [userMessage(text, 1)],
			outputEntryIds: ["entry-1"],
			cacheBusting: false,
			publishServedNumbers: publish,
		});
}

test("LKG and served identities roll back together when metadata publication fails", async () => {
	await fixture((db, sessionId) => {
		const publish = capture(db, sessionId);
		publish("§1§ accepted", [1]);
		const before = persistence.loadPersistedLkgSlot(db, sessionId)?.jsonPrefix;
		expect(() =>
			publish("§2§ rejected", [2], () => {
				publishPiServedNumbers(db, sessionId, [2]);
				throw new Error("storage failure after identity update");
			}),
		).toThrow("Pi LKG/served publication failed");
		expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1]);
		expect(persistence.loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toBe(
			before,
		);
		expect(getInMemorySlot(sessionId)?.jsonPrefix).toBe(before);
	});
});

test("managed LKG serialization failure publishes no identities", async () => {
	await fixture((db, sessionId) => {
		const coordinator = createPiLkgCoordinator(db);
		const raw = [userMessage("input", 1)];
		expect(() =>
			coordinator.captureAppliedPass({
				snapshot: coordinator.beginPass({
					sessionId,
					messages: raw,
					entryIds: ["entry-1"],
					modelKey: null,
					providerKey: null,
				}),
				outputMessages: [
					{
						toJSON() {
							throw new Error("cannot serialize request");
						},
					},
				],
				cacheBusting: false,
				publishServedNumbers: () => publishPiServedNumbers(db, sessionId, [1]),
			}),
		).toThrow("cannot serialize request");
		expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([]);
		expect(persistence.loadPersistedLkgSlot(db, sessionId)).toBeUndefined();
		expect(getInMemorySlot(sessionId)).toBeUndefined();
	});
});

test("committed identities union legacy JSONL and survive LKG invalidation without erasing replay namespaces", async () => {
	await fixture((db, sessionId) => {
		capturePiServedArray(sessionId, [userMessage("legacy", 1)], {
			servedTagNumbers: [9],
		});
		expect(
			updateReplayDocument(db, sessionId, (doc) => {
				doc.version = 2;
				doc.piNative = { sentinel: "native state" };
				doc.trailingBlank = { assistant: "strip" };
				return true;
			}),
		).toBe(true);
		capture(db, sessionId)("§1§ current", [1]);
		expect([...getPiServedTagNumbers(sessionId, undefined, db)]).toEqual([
			9, 1,
		]);
		dropSlot(sessionId, "test history removal");
		clearContextHandlerSession(sessionId);
		expect([...getPiServedTagNumbers(sessionId, undefined, db)]).toEqual([
			9, 1,
		]);
		expect(readReplayEnvelope(db, sessionId).piNative).toEqual({
			sentinel: "native state",
		});
		expect(readReplayEnvelope(db, sessionId).trailingBlank).toEqual({
			assistant: "strip",
		});
	});
});

for (const failure of ["db-save", "late-commit"] as const) {
	test(`real managed handler refuses ${failure} without late served evidence`, async () => {
		await fixture(async (db, sessionId, root) => {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler missing");
			const raw = [userMessage("pair before dispatch", 1)];
			const ctx = fakeContext(sessionId, root, ["entry-1"], raw);
			let now = 0;
			const clock = spyOn(performance, "now").mockImplementation(() => now);
			const save = persistence.saveLkgSlotToDb;
			const saver = spyOn(persistence, "saveLkgSlotToDb").mockImplementation(
				(...args) => {
					const committed = save(...args);
					if (failure === "late-commit") now = 26_000;
					return committed;
				},
			);
			if (failure === "db-save")
				db.exec(
					"CREATE TRIGGER reject_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END",
				);
			try {
				const pending = handler({ messages: raw } as never, ctx as never);
				if (failure === "late-commit")
					await expect(pending).rejects.toThrow(
						"stage=LKG/served publication elapsed=26000ms",
					);
				else await expect(pending).rejects.toThrow();
				expect(saver).toHaveBeenCalledTimes(1);
				flushPiServedArrayLedger();
				expect(getInMemorySlot(sessionId)).toBeUndefined();
				expect(existsSync(getPiServedTagNumbersPath(sessionId))).toBe(false);
				expect(existsSync(getPiServedArrayLedgerPath(sessionId))).toBe(false);
				if (failure === "late-commit") {
					const durable = persistence.loadPersistedLkgSlot(db, sessionId);
					expect(durable?.jsonPrefix).toContain("§1§ pair before dispatch");
					expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1]);
				} else {
					expect(
						persistence.loadPersistedLkgSlot(db, sessionId),
					).toBeUndefined();
					expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([]);
				}
			} finally {
				saver.mockRestore();
				clock.mockRestore();
			}
		});
	});
}
