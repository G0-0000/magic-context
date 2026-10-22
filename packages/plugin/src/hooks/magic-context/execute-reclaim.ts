import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import { updateReplayDocument } from "../../features/magic-context/storage-replay-document";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import type { Database } from "../../shared/sqlite";
import { capturePendingDropEligibility } from "./pending-drop-eligibility";
import { postprocessReplaySnapshot } from "./postprocess-read-cache";
import type { TagTarget } from "./tag-messages";

interface ExecuteReclaimState {
    heldPasses: number;
    floorOrdinal: number | null;
    floorPromptId: string | null;
}

const NAMESPACE = "executeReclaim";

export function readExecuteReclaimState(db: Database, sessionId: string): ExecuteReclaimState {
    return parseState(postprocessReplaySnapshot(db, sessionId).executeReclaim);
}

function parseState(lane: unknown): ExecuteReclaimState {
    const value = lane as Partial<ExecuteReclaimState> | undefined;
    return {
        heldPasses: typeof value?.heldPasses === "number" ? Math.max(0, value.heldPasses) : 0,
        floorOrdinal: typeof value?.floorOrdinal === "number" ? value.floorOrdinal : null,
        floorPromptId: typeof value?.floorPromptId === "string" ? value.floorPromptId : null,
    };
}

export function writeExecuteReclaimState(
    db: Database,
    sessionId: string,
    patch: Partial<ExecuteReclaimState>,
): void {
    const current = readExecuteReclaimState(db, sessionId);
    if (JSON.stringify(current) === JSON.stringify({ ...current, ...patch })) return;
    if (
        !updateReplayDocument(db, sessionId, (doc) => {
            const previous = parseState(doc[NAMESPACE]);
            const state = { ...previous, ...patch };
            if (JSON.stringify(previous) === JSON.stringify(state)) return false;
            doc.version = 2;
            doc[NAMESPACE] = state;
            return true;
        })
    )
        throw new Error("Could not persist execute reclaim state");
}

export function clearExecuteReclaimState(db: Database, sessionId: string): void {
    writeExecuteReclaimState(db, sessionId, {
        heldPasses: 0,
        floorOrdinal: null,
        floorPromptId: null,
    });
}

export function maintainExecuteFloorMark(
    db: Database,
    sessionId: string,
    promptId: string | null,
    belowExecute: boolean,
): void {
    const state = readExecuteReclaimState(db, sessionId);
    if (
        state.floorOrdinal !== null &&
        (belowExecute || (promptId !== null && promptId !== state.floorPromptId))
    ) {
        writeExecuteReclaimState(db, sessionId, { floorOrdinal: null, floorPromptId: null });
    }
}

/** Estimate queued drops remaining after protected-tag, thinking and target-completeness checks. */
export function estimateExecuteReclaimTokens(args: {
    db: Database;
    sessionId: string;
    pendingOps: readonly PendingOp[];
    tags: readonly TagEntry[];
    targets: ReadonlyMap<number, TagTarget>;
    protectedTagIds: ReadonlySet<number>;
}): number {
    const eligible = capturePendingDropEligibility(args.targets, args.protectedTagIds);
    const queued = new Set(
        args.pendingOps.filter((op) => op.operation === "drop").map((op) => op.tagId),
    );
    const seed = sessionDecisionCalibration(args.db, args.sessionId);
    return args.tags.reduce((total, tag) => {
        if (tag.status !== "active" || !queued.has(tag.tagNumber) || !eligible.has(tag.tagNumber))
            return total;
        const ratio = tag.type === "tool" ? seed.toolsRatio : seed.proseRatio;
        return total + Math.max(0, (tag.tokenCount ?? Math.ceil(tag.byteSize / 4)) * ratio);
    }, 0);
}

/** Drops and cleanup may share an execute rebuild only when no historian run or unrendered summary is expected. */
export function originateExecuteReclaim(args: {
    db: Database;
    sessionId: string;
    primaryExecute: boolean;
    summaryCanCome: boolean;
    alreadyBusting: boolean;
    reclaimableTokens: number;
    usableWindow: number;
}): boolean {
    const state = readExecuteReclaimState(args.db, args.sessionId);
    const heldPasses =
        args.primaryExecute && args.reclaimableTokens > 0 && !args.alreadyBusting
            ? state.heldPasses + 1
            : 0;
    writeExecuteReclaimState(args.db, args.sessionId, { heldPasses });
    return (
        args.primaryExecute &&
        !args.alreadyBusting &&
        !args.summaryCanCome &&
        args.reclaimableTokens > 0 &&
        ((args.usableWindow > 0 && args.reclaimableTokens >= args.usableWindow * 0.02) ||
            heldPasses >= 3)
    );
}
