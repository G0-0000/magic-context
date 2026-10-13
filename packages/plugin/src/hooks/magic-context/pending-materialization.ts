export type PendingMaterializationOrigin =
    | "fit_retry"
    | "system_hash"
    | "user_flush"
    | "variant_change"
    | "recomp"
    | "boundary_repair"
    | "host_history_change"
    | "host_compaction"
    | "tag_identity_repair"
    | "thinking_hold"
    | "mutation_drift";

// Record whether a user command, system change, fit retry or another event
// requested the pending work, separately for each plugin's Set. Postprocess
// (or Pi's pipeline) drains it only after an allowed materialization succeeds.
const origins = new WeakMap<Set<string>, Map<string, PendingMaterializationOrigin>>();

export function requestPendingMaterialization(
    sessions: Set<string>,
    sessionId: string,
    origin: PendingMaterializationOrigin,
): void {
    let reasons = origins.get(sessions);
    if (!reasons) origins.set(sessions, (reasons = new Map()));
    if (!sessions.has(sessionId) || !reasons.has(sessionId) || origin === "fit_retry")
        reasons.set(sessionId, origin);
    sessions.add(sessionId);
}

export function pendingMaterializationOrigin(sessions: Set<string>, sessionId: string): string {
    return sessions.has(sessionId)
        ? (origins.get(sessions)?.get(sessionId) ?? "pending_materialization")
        : "pending_materialization";
}

export function clearPendingMaterialization(sessions: Set<string>, sessionId: string): void {
    sessions.delete(sessionId);
    origins.get(sessions)?.delete(sessionId);
}
