import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getEmergencyRecoveryArmedAt } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import {
	lkgContentDigestFromFields,
	lkgContentFields,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import type { PiLkgPassSnapshot } from "./pi-lkg";
import { piFitMessageBytes } from "./tokenize-pi-messages";

interface UpperReclaimCursor {
	sessionId: string;
	modelKey: string | null;
	messageCount: number;
	tail: string;
	recoveryArmedAt: number | null;
}
const cursors = new Map<string, UpperReclaimCursor | null>();
const pendingInput = new Set<string>();
const KEY = "piUpperEstimateReclaim";

/** Recheck capacity when recovery, missing usage, growing input or cache changes make it uncertain. */
export function piFitOverflowPossible(args: {
	hasUI: boolean;
	inputTokens: number;
	recoveryArmed: boolean;
	forceMaterialization: boolean;
	imported: boolean;
	coldInjection: boolean;
	cacheBusting: boolean;
	sessionId: string;
	appendedMessages?: readonly unknown[];
	contextLimit?: number;
	forcePercentage?: number;
}): boolean {
	if (
		(!args.hasUI && args.inputTokens <= 0) ||
		args.recoveryArmed ||
		args.forceMaterialization ||
		args.imported ||
		args.coldInjection ||
		args.cacheBusting ||
		pendingInput.has(args.sessionId)
	)
		return true;
	if (!args.contextLimit || !Number.isFinite(args.contextLimit)) return false;
	const headroom =
		args.contextLimit * ((args.forcePercentage ?? 85) / 100) - args.inputTokens;
	let appendedBytes = 0;
	try {
		// Last-known-good replay already detached messages added after its saved
		// input. Inspect that tail, not the entire previously served prefix.
		for (const message of args.appendedMessages ?? []) {
			appendedBytes += piFitMessageBytes(message);
			if (2 * appendedBytes >= headroom) return true;
		}
	} catch {
		return true;
	}
	return false;
}

export function clearPiUpperReclaimSession(sessionId: string): void {
	cursors.delete(sessionId);
	pendingInput.delete(sessionId);
}
export function requestPiFitReclaimInput(sessionId: string): void {
	pendingInput.add(sessionId);
}
export function clearPiFitReclaimInput(sessionId: string): void {
	pendingInput.delete(sessionId);
}

/** Hash only the last input message; total message count also detects appends with identical text. */
export function piUpperReclaimCursor(args: {
	sessionId: string;
	modelKey: string | null;
	messageCount: number;
	snapshot?: PiLkgPassSnapshot;
	input: readonly unknown[];
}): UpperReclaimCursor | undefined {
	const last = args.snapshot?.inputs.at(-1);
	const fields = last?.fields ?? lkgContentFields(args.input.at(-1));
	if (!fields) return;
	return {
		sessionId: args.sessionId,
		modelKey: args.modelKey,
		messageCount: args.messageCount,
		tail: `${last?.id ?? "unmapped"}:${lkgContentDigestFromFields(fields)}`,
		recoveryArmedAt: getEmergencyRecoveryArmedAt(args.sessionId),
	};
}

function load(
	db: ContextDatabase,
	sessionId: string,
): UpperReclaimCursor | null {
	if (cursors.has(sessionId)) return cursors.get(sessionId) ?? null;
	const value = readReplayEnvelope(db, sessionId)[KEY] as
		| Partial<UpperReclaimCursor>
		| undefined;
	const cursor =
		value?.sessionId === sessionId &&
		(typeof value.modelKey === "string" || value.modelKey === null) &&
		typeof value.messageCount === "number" &&
		typeof value.tail === "string" &&
		(typeof value.recoveryArmedAt === "number" ||
			value.recoveryArmedAt === null)
			? (value as UpperReclaimCursor)
			: null;
	cursors.set(sessionId, cursor);
	return cursor;
}

export function shouldReclaimPiUpperEstimate(
	db: ContextDatabase,
	cursor: UpperReclaimCursor | undefined,
): boolean {
	if (!cursor) return false;
	const previous = load(db, cursor.sessionId);
	return (
		!previous ||
		previous.modelKey !== cursor.modelKey ||
		previous.messageCount !== cursor.messageCount ||
		previous.tail !== cursor.tail ||
		(cursor.recoveryArmedAt !== null &&
			cursor.recoveryArmedAt !== previous.recoveryArmedAt)
	);
}

export function recordPiUpperEstimateReclaim(
	db: ContextDatabase,
	cursor: UpperReclaimCursor,
): void {
	// Forks copy extra fields from the replay JSON. A session id prevents the
	// parent's "already reclaimed" decision from suppressing its child's first
	// attempt, without adding a database column.
	if (
		!updateReplayDocument(db, cursor.sessionId, (doc) => {
			doc.version = 2;
			doc[KEY] = cursor;
			return true;
		})
	)
		throw new Error("Could not persist upper-estimate reclaim cursor");
	cursors.set(cursor.sessionId, cursor);
	pendingInput.delete(cursor.sessionId);
}

export function resetPiUpperEstimateReclaim(
	db: ContextDatabase,
	sessionId: string,
): void {
	if (!load(db, sessionId)) return;
	if (
		!updateReplayDocument(db, sessionId, (doc) => {
			delete doc[KEY];
			return true;
		})
	)
		throw new Error("Could not clear upper-estimate reclaim cursor");
	cursors.delete(sessionId);
}
