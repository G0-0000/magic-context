/**
 * Ownership gate for cross-session ctx_expand.
 *
 * A bare sessionId is never trusted: the target session's project must be
 * provably the same as the caller's. The caller's identity comes from the
 * injected project-identity resolver (git:<root sha> / dir:<md5>); the
 * target's authority is its `session_projects` mapping. Stored paths may be
 * legacy raw filesystem paths, so each is normalized through the same
 * production helper the memory tools use before comparison.
 *
 * `updated_at` on the mapping is "when this session last changed project"
 * (the upsert bumps it only on an actual path change; first observation keeps
 * it untouched — see session-project-storage.ts). Rows indexed before that
 * moment belong to the session's previous project: the range-attribution
 * check refuses them so a moved session cannot leak its old project's
 * messages into this project's expand.
 *
 * Refusals are distinct and explicit: no mapping, an ambiguous mapping
 * (one session mapped to several identities across harnesses), a different
 * project, or messages indexed before the session changed project. Any
 * refusal means no content is returned.
 */

import {
    describeUnresolvedProjectIdentity,
    isUsableProjectIdentity,
    normalizeStoredProjectPath,
} from "../../features/magic-context/memory/project-identity";
import type { ContextDatabase } from "../../features/magic-context/storage";

export type CrossSessionOwnership =
    | { ok: true; /** Rows indexed before this moment belong to the target's previous project. */ notBeforeMs?: number }
    | { ok: false; error: string };

/**
 * Whether the caller may expand `targetSessionId`. `resolveProjectPath` is the
 * caller-side project-identity resolver injected by the host registration;
 * `directory` is the calling session's working directory.
 */
export function checkCrossSessionExpandOwnership(
    db: ContextDatabase,
    resolveProjectPath: (directory: string) => string | undefined,
    directory: string,
    targetSessionId: string,
): CrossSessionOwnership {
    const callerIdentity = resolveProjectPath(directory);
    if (!isUsableProjectIdentity(callerIdentity)) {
        return {
            ok: false,
            error: `Error: could not resolve this session's project identity, so ownership of session ${targetSessionId} cannot be verified: ${describeUnresolvedProjectIdentity(directory)} No content was returned.`,
        };
    }
    const rows = db
        .prepare("SELECT project_path, updated_at FROM session_projects WHERE session_id = ?")
        .all(targetSessionId) as Array<{ project_path: string; updated_at: number }>;
    if (rows.length === 0) {
        return {
            ok: false,
            error: `Error: session ${targetSessionId} has no recorded project mapping, so its ownership cannot be verified. Cross-session expand is refused; a bare sessionId is never trusted. No content was returned.`,
        };
    }
    const identities = [...new Set(rows.map((row) => normalizeStoredProjectPath(row.project_path)))];
    if (identities.length > 1) {
        return {
            ok: false,
            error: `Error: session ${targetSessionId} is mapped to multiple projects (${identities.join(", ")}), so its ownership is ambiguous. Cross-session expand is refused until the mapping is unambiguous. No content was returned.`,
        };
    }
    if (identities[0] !== callerIdentity) {
        return {
            ok: false,
            error: `Error: session ${targetSessionId} belongs to a different project (${identities[0]}) than this session (${callerIdentity}). Cross-session expand is limited to sessions of the same project. No content was returned.`,
        };
    }
    // A session can hold one mapping row per harness, each with its own change
    // time. The cutoff is the LATEST of them: a message indexed before ANY
    // recorded move predates that harness's re-binding and may belong to the
    // previous project. This is the same session-moved-projects contract the
    // project-wide search lane implements (search.ts
    // resolveProjectWideCandidateSessions takes MAX(updated_at)).
    const changeTimes = rows.map((row) => row.updated_at ?? 0).filter((time) => time > 0);
    if (changeTimes.length === 0) return { ok: true };
    return { ok: true, notBeforeMs: Math.max(...changeTimes) };
}

export type CrossSessionRangeAttribution = { kind: "refuse"; error: string } | { kind: "serve" };

/**
 * Whether the requested range may be served for a session that changed
 * project at `notBeforeMs`. Rows the sidecar knows were indexed before the
 * change belong to the previous project: a range of only such rows is
 * refused outright, and a range mixing them with newer rows is refused too —
 * narrow the range to messages at or after the change. The read path itself
 * can filter by the cutoff (renderSearchArchive's notBeforeMs); until the
 * off-thread worker can carry it, refusing up front is the leak-proof choice
 * and means the worker is never asked to serve a gated range.
 */
export function checkCrossSessionRangeAttribution(
    db: ContextDatabase,
    targetSessionId: string,
    start: number,
    end: number,
    notBeforeMs: number,
): CrossSessionRangeAttribution {
    const counts = db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN message_time_ms < ?1 THEN 1 ELSE 0 END), 0) AS stale,
                    COALESCE(SUM(CASE WHEN message_time_ms IS NULL OR message_time_ms >= ?1 THEN 1 ELSE 0 END), 0) AS serveable
             FROM message_fts_rowid_map
             WHERE session_id = ?2 AND message_ordinal BETWEEN ?3 AND ?4`,
        )
        .get(notBeforeMs, targetSessionId, start, end) as { stale: number; serveable: number };
    // shortcut: rows with NULL message_time_ms — and sessions the sidecar never
    // mapped at all — are served without attribution. Legacy stores predate the
    // sidecar, so refusing them would block every pre-sidecar session; this is
    // the same attribution shortcut the project-wide search lane takes.
    if (counts.stale === 0) return { kind: "serve" };
    const changedAt = new Date(notBeforeMs).toISOString();
    if (counts.serveable === 0) {
        return {
            kind: "refuse",
            error: `Error: session ${targetSessionId} changed project at ${changedAt}; the messages in range ${start}-${end} were indexed before the session changed project and belong to its previous project. Cross-session expand is refused for them.`,
        };
    }
    // shortcut: mixed pre/post-move ranges refuse instead of serving the
    // post-move subset; upgrade to partial serving when the worker transport
    // carries notBeforeMs (renderSearchArchive already filters by it).
    return {
        kind: "refuse",
        error: `Error: range ${start}-${end} of session ${targetSessionId} spans its project change at ${changedAt}: some messages in it were indexed before the session changed project and belong to its previous project. Narrow the range to messages at or after the change.`,
    };
}
