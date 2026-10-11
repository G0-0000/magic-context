import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import type { Database } from "@magic-context/core/shared/sqlite";

function parseNumbers(value: unknown): number[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		!value.every((number) => Number.isSafeInteger(number) && number > 0)
	) {
		throw new Error(
			"Invalid committed Pi served identities; refusing adoption",
		);
	}
	return value;
}

/** Committed served numbers remain authoritative after replay invalidation or history removal. */
export function readPiCommittedServedNumbers(
	db: Database,
	sessionId: string,
): readonly number[] {
	return parseNumbers(readReplayEnvelope(db, sessionId).piServedTagNumbers);
}

/** Runs inside the last-good request transaction; failure rolls back the request and served numbers. */
export function publishPiServedNumbers(
	db: Database,
	sessionId: string,
	numbers: Iterable<number>,
): void {
	const delta = [...numbers];
	parseNumbers(delta);
	const updated = updateReplayDocument(db, sessionId, (doc) => {
		const previous = parseNumbers(doc.piServedTagNumbers);
		const union = new Set(previous);
		for (const number of delta) union.add(number);
		if (union.size === previous.length) return false;
		doc.version = 2;
		doc.piServedTagNumbers = [...union];
		return true;
	});
	if (!updated) throw new Error("Pi served-identity publication failed");
}
