import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { createPiLkgCoordinator, type PiLkgCaptureTiming } from "./pi-lkg";

function message(content: string): Record<string, unknown> {
	return { role: "user", content, timestamp: 1 };
}

function createHarness(onTiming?: (sample: PiLkgCaptureTiming) => void) {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	let scheduledCapture: (() => void) | undefined;
	const coordinator = createPiLkgCoordinator(
		db,
		(capture) => {
			scheduledCapture = capture;
		},
		onTiming,
	);
	return {
		db,
		coordinator,
		flushCapture(): void {
			const capture = scheduledCapture;
			scheduledCapture = undefined;
			if (!capture) throw new Error("expected a scheduled LKG capture");
			capture();
		},
	};
}

const databases: Database[] = [];

afterEach(() => {
	resetLkgSlotsForTest();
	for (const db of databases) closeQuietly(db);
	databases.length = 0;
});

describe("Pi incremental LKG capture", () => {
	it("refuses replay when the same entry id returns to old same-length content", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const sessionId = "pi-lkg-same-id-content-change";
		const entryIds = ["entry-1"];

		const original = [message("alpha")];
		const first = harness.coordinator.beginPass({
			sessionId,
			messages: original,
			entryIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: first,
			outputMessages: original,
			cacheBusting: false,
		});
		harness.flushCapture();

		const changed = [message("bravo")];
		const second = harness.coordinator.beginPass({
			sessionId,
			messages: changed,
			entryIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: second,
			outputMessages: changed,
			cacheBusting: false,
		});
		harness.flushCapture();

		const row = harness.db
			.prepare(
				"SELECT input_content_signatures FROM lkg_slots WHERE session_id = ?",
			)
			.get(sessionId) as { input_content_signatures: string } | undefined;
		expect(JSON.parse(row?.input_content_signatures ?? "[]")).toHaveLength(1);

		const reverted = harness.coordinator.beginPass({
			sessionId,
			messages: original,
			entryIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		expect(harness.coordinator.replay(reverted)).toEqual({
			ok: false,
			reason: "lkg_content_mismatch",
		});
	});

	it("does not read live message objects from the deferred commit", () => {
		const harness = createHarness();
		databases.push(harness.db);
		const sessionId = "pi-lkg-detached-input";
		const liveMessage = message("alpha");
		const liveInput = [liveMessage];
		const snapshot = harness.coordinator.beginPass({
			sessionId,
			messages: liveInput,
			entryIds: ["entry-1"],
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot,
			outputMessages: liveInput,
			cacheBusting: false,
		});
		liveMessage.content = "bravo";
		harness.flushCapture();

		const replaySnapshot = harness.coordinator.beginPass({
			sessionId,
			messages: [message("alpha")],
			entryIds: ["entry-1"],
			modelKey: "test/model",
			providerKey: "test",
		});
		expect(harness.coordinator.replay(replaySnapshot)).toEqual({
			ok: true,
			messages: [message("alpha")],
		});
	});

	it("reuses every prior digest on an append-only pass", () => {
		const timings: PiLkgCaptureTiming[] = [];
		const harness = createHarness((sample) => timings.push(sample));
		databases.push(harness.db);
		const sessionId = "pi-lkg-append-only";
		const initial = [message("one"), message("two"), message("three")];
		const initialIds = ["entry-1", "entry-2", "entry-3"];
		const first = harness.coordinator.beginPass({
			sessionId,
			messages: initial,
			entryIds: initialIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: first,
			outputMessages: initial,
			cacheBusting: false,
		});
		harness.flushCapture();

		const appended = [...initial, message("four")];
		const appendedIds = [...initialIds, "entry-4"];
		const second = harness.coordinator.beginPass({
			sessionId,
			messages: appended,
			entryIds: appendedIds,
			modelKey: "test/model",
			providerKey: "test",
		});
		harness.coordinator.captureAppliedPass({
			snapshot: second,
			outputMessages: appended,
			cacheBusting: false,
		});
		harness.flushCapture();

		expect(timings.at(-1)?.reusedPrefix).toBe(appended.length - 1);
	});
});
