import { performance } from "node:perf_hooks";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { resetLkgSlotsForTest } from "../../plugin/src/hooks/magic-context/lkg-slot";
import { Database } from "../../plugin/src/shared/sqlite";
import { closeQuietly } from "../../plugin/src/shared/sqlite-helpers";
import { createPiLkgCoordinator } from "../src/pi-lkg";

type Sample = { role: "user"; content: string; timestamp: number };

const MESSAGE_COUNTS = [2_000, 5_000, 10_000] as const;
const WARMUP_PASSES = 10;
const MEASURED_PASSES = 50;

function percentile(samples: readonly number[], value: number): number {
	const sorted = [...samples].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ??
		0
	);
}

const results = [];
for (const messageCount of MESSAGE_COUNTS) {
	const messages: Sample[] = Array.from(
		{ length: messageCount },
		(_, index) => ({
			role: "user",
			content: `message-${index}-${"x".repeat(256)}`,
			timestamp: index + 1,
		}),
	);
	const entryIds = messages.map((_, index) => `entry-${index}`);
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	let scheduledCapture: (() => void) | undefined;
	let lastReusedPrefix: number | undefined;
	const coordinator = createPiLkgCoordinator(
		db,
		(capture) => {
			scheduledCapture = capture;
		},
		(sample) => {
			lastReusedPrefix = sample.reusedPrefix;
		},
	);
	const synchronousSamples: number[] = [];
	const deferredSamples: number[] = [];
	const reusedPrefixes: number[] = [];

	try {
		for (
			let iteration = 0;
			iteration < WARMUP_PASSES + MEASURED_PASSES;
			iteration += 1
		) {
			const startedAt = performance.now();
			const snapshot = coordinator.beginPass({
				sessionId: `pi-lkg-benchmark-${messageCount}`,
				messages,
				entryIds,
				modelKey: "test/benchmark",
				providerKey: "test",
			});
			coordinator.captureAppliedPass({
				snapshot,
				outputMessages: messages,
				cacheBusting: false,
			});
			const synchronousElapsed = performance.now() - startedAt;
			const deferredStartedAt = performance.now();
			scheduledCapture?.();
			const deferredElapsed = performance.now() - deferredStartedAt;
			scheduledCapture = undefined;
			if (iteration >= WARMUP_PASSES) {
				synchronousSamples.push(synchronousElapsed);
				deferredSamples.push(deferredElapsed);
				if (lastReusedPrefix !== undefined)
					reusedPrefixes.push(lastReusedPrefix);
			}
		}
		results.push({
			messages: messages.length,
			serializedBytes: Buffer.byteLength(JSON.stringify(messages)),
			passes: synchronousSamples.length,
			synchronousP50Ms: Number(percentile(synchronousSamples, 0.5).toFixed(3)),
			synchronousP95Ms: Number(percentile(synchronousSamples, 0.95).toFixed(3)),
			deferredDigestPersistP50Ms: Number(
				percentile(deferredSamples, 0.5).toFixed(3),
			),
			deferredDigestPersistP95Ms: Number(
				percentile(deferredSamples, 0.95).toFixed(3),
			),
			reusedPrefixP50:
				reusedPrefixes.length > 0 ? percentile(reusedPrefixes, 0.5) : null,
		});
	} finally {
		resetLkgSlotsForTest();
		closeQuietly(db);
	}
}

console.log(
	JSON.stringify({
		benchmark: "pi_lkg_snapshot",
		warmupPasses: WARMUP_PASSES,
		results,
	}),
);
