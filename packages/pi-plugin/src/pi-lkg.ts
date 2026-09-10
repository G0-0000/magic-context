import {
	createDbLkgPersistence,
	saveLkgSlotToDb,
} from "@magic-context/core/hooks/magic-context/lkg-persist";
import { replayLkg } from "@magic-context/core/hooks/magic-context/lkg-replay";
import {
	captureSlot,
	dropSlot,
	exactReusablePrefix,
	getSlot,
	incrementalLkgContentDigests,
	type LkgContentField,
	type LkgEntryNote,
	lkgContentDigestFromFields,
	lkgContentFields,
	registerLkgPersistence,
	signatureForFields,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/transform-operations";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

interface PiLkgInputSnapshot {
	id: string;
	messageIndex: number;
	fields: readonly LkgContentField[];
}

export interface PiLkgPassSnapshot {
	sessionId: string;
	inputs: PiLkgInputSnapshot[];
	preparationFailure: string | null;
	replayFailure: string | null;
	replayAnchorInputIndex: number | null;
	pristineTail: MessageLike[] | null;
	modelKey: string | null;
	providerKey: string | null;
}

export type PiLkgReplayResult =
	| { ok: true; messages: MessageLike[] }
	| { ok: false; reason: string };

export interface PiLkgCaptureTiming {
	sessionId: string;
	elapsedMs: number;
	reusedPrefix: number;
}

interface PiLkgSessionState {
	captureSequence: number;
	syncCaptureRequired: boolean;
	acceptedInputs: readonly PiLkgInputSnapshot[] | null;
}

interface PiLkgCapturePlan {
	sessionId: string;
	inputs: PiLkgInputSnapshot[];
	jsonPrefix: string;
	modelKey: string | null;
	providerKey: string | null;
	capturedAt: number;
	captureSequence: number;
}

const piLkgSessionStates = new Map<string, PiLkgSessionState>();

export function clearPiLkgSessionState(sessionId: string): void {
	const state = piLkgSessionStates.get(sessionId);
	if (state) state.captureSequence += 1;
	piLkgSessionStates.delete(sessionId);
}

export interface PiLkgCoordinator {
	beginPass(args: {
		sessionId: string;
		messages: readonly unknown[];
		entryIds: readonly (string | undefined)[] | null;
		modelKey: string | null;
		providerKey: string | null;
	}): PiLkgPassSnapshot;
	replay(snapshot: PiLkgPassSnapshot): PiLkgReplayResult;
	captureAppliedPass(args: {
		snapshot: PiLkgPassSnapshot;
		outputMessages: readonly unknown[];
		cacheBusting: boolean;
	}): void;
}

export function isTransientPiStorageError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; message?: unknown };
	if (
		candidate.code === "SQLITE_BUSY" ||
		candidate.code === "SQLITE_LOCKED" ||
		candidate.code === "SQLITE_BUSY_SNAPSHOT"
	) {
		return true;
	}
	return (
		typeof candidate.message === "string" &&
		/database is locked|database table is locked|sqlite_(busy|locked)/i.test(
			candidate.message,
		)
	);
}

export function reconcilePiLkgEntryIds(
	resolved: readonly (string | undefined)[] | null,
	alignedProjection: readonly (string | undefined)[] | null,
): readonly (string | undefined)[] | null {
	if (!resolved || !alignedProjection || resolved.length === 0) return resolved;
	const result = [...resolved];
	const anchors: Array<{ messageIndex: number; projectionIndex: number }> = [];
	let projectionCursor = 0;
	for (
		let messageIndex = 0;
		messageIndex < resolved.length;
		messageIndex += 1
	) {
		const id = resolved[messageIndex];
		if (typeof id !== "string") continue;
		let projectionIndex = -1;
		for (
			let index = projectionCursor;
			index < alignedProjection.length;
			index += 1
		) {
			if (alignedProjection[index] === id) {
				projectionIndex = index;
				break;
			}
		}
		if (projectionIndex < 0) return resolved;
		anchors.push({ messageIndex, projectionIndex });
		projectionCursor = projectionIndex + 1;
	}
	if (anchors.length === 0) return resolved;

	const fillEqualSpan = (
		messageStart: number,
		messageEnd: number,
		projectionStart: number,
		projectionEnd: number,
	): void => {
		if (messageEnd - messageStart !== projectionEnd - projectionStart) return;
		for (let offset = 0; offset < messageEnd - messageStart; offset += 1) {
			result[messageStart + offset] ??=
				alignedProjection[projectionStart + offset];
		}
	};
	let previousMessageIndex = -1;
	let previousProjectionIndex = -1;
	for (const anchor of anchors) {
		fillEqualSpan(
			previousMessageIndex + 1,
			anchor.messageIndex,
			previousProjectionIndex + 1,
			anchor.projectionIndex,
		);
		previousMessageIndex = anchor.messageIndex;
		previousProjectionIndex = anchor.projectionIndex;
	}
	fillEqualSpan(
		previousMessageIndex + 1,
		resolved.length,
		previousProjectionIndex + 1,
		alignedProjection.length,
	);
	return result;
}

export function piStorageErrorReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (
			code === "SQLITE_BUSY" ||
			code === "SQLITE_LOCKED" ||
			code === "SQLITE_BUSY_SNAPSHOT"
		) {
			return code;
		}
	}
	if (/database is locked|database table is locked/i.test(message)) {
		return "SQLITE_BUSY_OR_LOCKED";
	}
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) return code;
	}
	return message;
}

function snapshotInputs(
	messages: readonly unknown[],
	entryIds: readonly (string | undefined)[] | null,
): { inputs: PiLkgInputSnapshot[]; failure: string | null } {
	if (!entryIds || entryIds.length !== messages.length) {
		return { inputs: [], failure: "lkg_entry_ids_unavailable" };
	}
	const firstStableIndex = entryIds.findIndex(
		(id): id is string => typeof id === "string" && id.length > 0,
	);
	if (firstStableIndex < 0) {
		return { inputs: [], failure: "lkg_entry_ids_unavailable" };
	}
	const inputs: PiLkgInputSnapshot[] = [];
	const seen = new Set<string>();
	for (let index = firstStableIndex; index < entryIds.length; index += 1) {
		const id = entryIds[index];
		if (typeof id !== "string" || id.length === 0) {
			return { inputs: [], failure: "lkg_entry_id_gap" };
		}
		if (seen.has(id)) return { inputs: [], failure: "lkg_duplicate_entry_id" };
		const fields = lkgContentFields(messages[index]);
		if (!fields) return { inputs: [], failure: "lkg_content_snapshot_failed" };
		seen.add(id);
		inputs.push({ id, messageIndex: index, fields });
	}
	return { inputs, failure: null };
}

/**
 * Adapt Pi's JSONL entry ids and native AgentMessage shape to the shared LKG
 * slot/replay implementation. FNV/SHA digest work and durable writes run from
 * setImmediate; only detached field tokens and the exact served JSON bytes are
 * captured synchronously, so a later pass cannot hash objects the handler has
 * already mutated.
 */
export function createPiLkgCoordinator(
	db: Database,
	scheduleCapture: (capture: () => void) => void = (capture) =>
		setImmediate(capture),
	onCaptureTiming?: (sample: PiLkgCaptureTiming) => void,
): PiLkgCoordinator {
	registerLkgPersistence(createDbLkgPersistence(db));
	const stateFor = (sessionId: string): PiLkgSessionState => {
		let state = piLkgSessionStates.get(sessionId);
		if (!state) {
			state = {
				captureSequence: 0,
				syncCaptureRequired: false,
				acceptedInputs: null,
			};
			piLkgSessionStates.set(sessionId, state);
		}
		return state;
	};

	const beginPass: PiLkgCoordinator["beginPass"] = (args) => {
		const snapped = snapshotInputs(args.messages, args.entryIds);
		const slot = getSlot(args.sessionId);
		if (snapped.failure || !slot) {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: snapped.failure,
				replayFailure: snapped.failure ?? "lkg_miss",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
		const stableAnchorIndex = snapped.inputs.findIndex(
			(input) => input.id === slot.lastInputMessageId,
		);
		if (stableAnchorIndex < 0) {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: "lkg_invalidated_reshape",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
		const messageAnchorIndex = snapped.inputs[stableAnchorIndex]?.messageIndex;
		if (messageAnchorIndex === undefined) {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: "lkg_invalidated_reshape",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
		try {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: null,
				replayAnchorInputIndex: stableAnchorIndex,
				pristineTail: structuredClone(
					args.messages.slice(messageAnchorIndex + 1),
				) as MessageLike[],
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		} catch {
			return {
				sessionId: args.sessionId,
				inputs: snapped.inputs,
				preparationFailure: null,
				replayFailure: "lkg_tail_snapshot_failed",
				replayAnchorInputIndex: null,
				pristineTail: null,
				modelKey: args.modelKey,
				providerKey: args.providerKey,
			};
		}
	};

	const replay: PiLkgCoordinator["replay"] = (snapshot) => {
		if (snapshot.replayFailure) {
			if (snapshot.replayFailure === "lkg_invalidated_reshape") {
				dropSlot(snapshot.sessionId, snapshot.replayFailure);
				stateFor(snapshot.sessionId).acceptedInputs = null;
			}
			return { ok: false, reason: snapshot.replayFailure };
		}
		if (
			snapshot.replayAnchorInputIndex === null ||
			snapshot.pristineTail === null
		) {
			return { ok: false, reason: "lkg_miss" };
		}
		const entry: LkgEntryNote = {
			pristineTail: snapshot.pristineTail,
			entryInputIds: snapshot.inputs.map((input) => input.id),
			entryContentDigests: snapshot.inputs
				.slice(0, snapshot.replayAnchorInputIndex + 1)
				.map((input) => lkgContentDigestFromFields(input.fields)),
			anchorIndex: snapshot.replayAnchorInputIndex,
		};
		const result = replayLkg({
			sessionId: snapshot.sessionId,
			messages: [] as MessageLike[],
			modelKey: snapshot.modelKey,
			providerKey: snapshot.providerKey,
			entry,
			// The shared seam validator reads OpenCode part shapes. Pi's prefix is a
			// complete prior AgentMessage[] ending at a JSONL entry boundary, so its
			// stable-id/content fences are the applicable seam proof.
			skipSeamValidation: true,
		});
		if (!result.ok) stateFor(snapshot.sessionId).acceptedInputs = null;
		return result;
	};

	const captureAppliedPass: PiLkgCoordinator["captureAppliedPass"] = (args) => {
		const { snapshot } = args;
		if (snapshot.preparationFailure || snapshot.inputs.length === 0) return;
		let jsonPrefix: string;
		try {
			jsonPrefix = JSON.stringify(args.outputMessages);
			if (typeof jsonPrefix !== "string") return;
		} catch (error) {
			dropSlot(snapshot.sessionId, "lkg_snapshot_serialize_failed");
			const failedState = stateFor(snapshot.sessionId);
			failedState.syncCaptureRequired = true;
			failedState.acceptedInputs = null;
			sessionLog(
				snapshot.sessionId,
				"LKG SNAPSHOT PREPARATION FAILED; forcing synchronous capture on the next applied pass:",
				error,
			);
			return;
		}
		const state = stateFor(snapshot.sessionId);
		state.captureSequence += 1;
		const plan: PiLkgCapturePlan = {
			sessionId: snapshot.sessionId,
			inputs: snapshot.inputs,
			jsonPrefix,
			modelKey: snapshot.modelKey,
			providerKey: snapshot.providerKey,
			capturedAt: Date.now(),
			captureSequence: state.captureSequence,
		};
		if (args.cacheBusting) {
			dropSlot(snapshot.sessionId, "lkg_cache_bust_pending_capture");
			state.acceptedInputs = null;
		}
		// Keep all N stable inputs flattened before returning from this context handler.
		// Pi passes a structured clone through awaited extension handlers, so a later
		// extension in the same emitContext call may rewrite any returned entry before
		// this immediate runs. MC's own pipeline can also replace entries. The deferred
		// work therefore reads only detached primitive/symbol field tokens, never live
		// MessageLike objects. message_end appends/scrubs a newly completed entry and
		// streaming grows the in-flight assistant, neither of which belonged to this
		// pass's input set. A newer context pass supersedes this plan by captureSequence.
		// Fork/revert/switch are separate awaited host events; their next pass either
		// supersedes this callback or invalidates reuse at its first id/field mismatch,
		// while session cleanup increments and clears this session's capture state.
		const commit = (): void => {
			if (plan.captureSequence !== state.captureSequence) return;
			const startedAt = performance.now();
			let reusedPrefix = 0;
			try {
				const inputIdSeq = plan.inputs.map((input) => input.id);
				const prior = getSlot(plan.sessionId);
				const reusePrior =
					prior?.inputContentSignatures !== undefined &&
					prior.modelKey === plan.modelKey &&
					prior.providerKey === plan.providerKey
						? { slot: prior, signatures: prior.inputContentSignatures }
						: undefined;
				const reusablePrefix = reusePrior
					? exactReusablePrefix(plan.inputs, state.acceptedInputs)
					: 0;
				const inputContentSignatures = [
					...(reusePrior ? reusePrior.signatures.slice(0, reusablePrefix) : []),
					...plan.inputs
						.slice(reusablePrefix)
						.map((input) => signatureForFields(input.fields)),
				];
				const incremental = incrementalLkgContentDigests(
					plan.inputs.map((input, index) => ({
						id: input.id,
						signature: inputContentSignatures[index] ?? "",
						fields: input.fields,
					})),
					reusePrior
						? {
								ids: reusePrior.slot.inputIdSeq.slice(0, reusablePrefix),
								signatures: reusePrior.signatures.slice(0, reusablePrefix),
								digests: reusePrior.slot.inputContentDigests.slice(
									0,
									reusablePrefix,
								),
							}
						: undefined,
				);
				reusedPrefix = incremental.reusedPrefix;
				const slot = {
					jsonPrefix: plan.jsonPrefix,
					inputIdSeq,
					inputContentDigests: incremental.digests,
					inputContentSignatures,
					lastInputMessageId: plan.inputs.at(-1)?.id ?? "",
					modelKey: plan.modelKey,
					providerKey: plan.providerKey,
					capturedAt: plan.capturedAt,
					captureSequence: plan.captureSequence,
				};
				if (!captureSlot(plan.sessionId, slot)) {
					throw new Error("LKG slot rejected the Pi snapshot");
				}
				state.acceptedInputs = plan.inputs;
				const persisted = saveLkgSlotToDb(db, plan.sessionId, slot);
				state.syncCaptureRequired = !persisted;
			} catch (error) {
				if (plan.captureSequence !== state.captureSequence) return;
				dropSlot(plan.sessionId, "lkg_async_capture_failed");
				state.syncCaptureRequired = true;
				state.acceptedInputs = null;
				sessionLog(
					plan.sessionId,
					"LKG ASYNC CAPTURE FAILED; forcing synchronous capture on the next applied pass:",
					error,
				);
			} finally {
				try {
					onCaptureTiming?.({
						sessionId: plan.sessionId,
						elapsedMs: performance.now() - startedAt,
						reusedPrefix,
					});
				} catch {
					// Timing diagnostics cannot change LKG capture behavior.
				}
			}
		};
		if (state.syncCaptureRequired) {
			commit();
			return;
		}
		try {
			scheduleCapture(commit);
		} catch (error) {
			dropSlot(plan.sessionId, "lkg_capture_schedule_failed");
			state.syncCaptureRequired = true;
			state.acceptedInputs = null;
			sessionLog(
				plan.sessionId,
				"LKG CAPTURE SCHEDULE FAILED; forcing synchronous capture on the next applied pass:",
				error,
			);
		}
	};

	return { beginPass, replay, captureAppliedPass };
}
