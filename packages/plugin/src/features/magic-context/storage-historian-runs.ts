import type { Database } from "../../shared/sqlite";

/**
 * Per historian-invocation telemetry.
 *
 * One row per attempted historian run (incremental publish or recomp pass),
 * recording the INPUT (chunk range) and OUTPUT shape
 * (compartments / facts / events / importance) plus success/failure. Tokens and
 * the model used live on the FK-linked `subagent_invocations` row
 * (`subagentInvocationId`) — join to get cost/model.
 *
 * Purpose: debugging (which range produced what), quality analysis (facts per
 * output token, importance distribution by model), and the productization /
 * training-data roadmap.
 */

export type HistorianRunStatus =
    /** Compartments were validated + published. */
    | "success"
    /** A real failure (validation / coverage / no-progress / exception). */
    | "failed"
    /** A successful no-op (nothing eligible to compact, empty chunk). */
    | "noop";

/** "upgrade" is only read, never written: rows from the removed session-upgrade
 *  command are still in existing databases. */
export type HistorianRunKind = "incremental" | "recomp" | "partial-recomp" | "upgrade";

export interface HistorianRunInput {
    sessionId: string;
    harness: string;
    /** FK to subagent_invocations.id (tokens/model/timing). NULL if no invocation. */
    subagentInvocationId?: number | null;
    runKind: HistorianRunKind;
    status: HistorianRunStatus;
    /** Failure reason for `failed` (and optionally a no-op explanation). */
    failureReason?: string | null;
    /** Raw-ordinal range of the input chunk. */
    chunkStartOrdinal?: number | null;
    chunkEndOrdinal?: number | null;
    /** Historian's reported next-start (its `<unprocessed_from>`). */
    unprocessedFrom?: number | null;
    /** Compartments actually persisted (post discard-last). */
    compartmentsProduced?: number;
    /** Durable id range of the persisted compartments. */
    compartmentIdMin?: number | null;
    compartmentIdMax?: number | null;
    /** Facts emitted in the `<facts>` block. */
    factsEmitted?: number;
    /** `{ [category]: count }` of emitted facts. */
    factsByCategory?: Record<string, number> | null;
    /** Valid emitted facts persisted as new memories or re-observations. */
    factsPromoted?: number;
    /** Events emitted (causal_incident / trajectory_correction). */
    eventsEmitted?: number;
    /** Events successfully inserted into compartment_events. */
    eventsPublished?: number;
    /** Importance distribution across persisted compartments. */
    importanceMin?: number | null;
    importanceMax?: number | null;
    importanceAvg?: number | null;
    /** Whether the lookahead-free last compartment was discarded (boundary healing). */
    discardedLast?: boolean;
    /** Whether the run produced/processed legacy (pre-v2) compartments. */
    legacy?: boolean;
}

const MAX_HISTORIAN_FAILURE_REASON_LENGTH = 96;

/**
 * Reduce failure details to a short diagnostic class before they reach durable
 * telemetry. Provider messages can contain request or response data, so only
 * stable classes and recognized status codes are retained.
 */
export function classifyHistorianFailureReason(reason?: string | null): string {
    const short = (value: string): string => value.slice(0, MAX_HISTORIAN_FAILURE_REASON_LENGTH);
    const detail = typeof reason === "string" ? reason.trim() : "";
    if (detail.length === 0) return "provider_error";

    const normalized = detail.toLowerCase();
    if (
        /^(?:provider_error(?::(?:http_[1-5]\d{2}|(?:invalid_api_key|authentication_error|rate_limit_error|overloaded_error|insufficient_quota|invalid_request_error|permission_error)(?::http_[1-5]\d{2})?))?|model_not_found(?::http_[1-5]\d{2})?|timeout(?::http_[1-5]\d{2})?|aborted|empty_output|parse_failed|subprocess_exit:(?:-?\d+|unknown))$/.test(
            normalized,
        )
    ) {
        return normalized.slice(0, MAX_HISTORIAN_FAILURE_REASON_LENGTH);
    }
    const statusMatch =
        /(?:\bhttp(?:\s+status)?|\bstatus(?:\s+code)?|\bapi\s+error|\berror)\s*[(:= ]+([1-5]\d{2})\b/i.exec(
            detail,
        );
    const httpCode = statusMatch?.[1];

    if (/model[_ ]not[_ ]found|unknown model|model does not exist/.test(normalized)) {
        return short(`model_not_found${httpCode ? `:http_${httpCode}` : ""}`);
    }
    if (/\btimeout\b|timed out|deadline exceeded/.test(normalized)) {
        return short(`timeout${httpCode ? `:http_${httpCode}` : ""}`);
    }
    if (/\babort(?:ed)?\b|cancelled|canceled/.test(normalized)) return "aborted";

    if (/\b(?:non_zero_exit|subprocess_exit)\b|\bpi exited\b/.test(normalized)) {
        const exitCode = /\bcode\s*=\s*(-?\d+|null)\b/i.exec(detail)?.[1];
        return short(`subprocess_exit:${exitCode && exitCode !== "null" ? exitCode : "unknown"}`);
    }

    const providerClasses: Array<[RegExp, string]> = [
        [/\binvalid_api_key\b|invalid api key|no api key found/, "invalid_api_key"],
        [/\bauthentication_error\b|unauthori[sz]ed|\bforbidden\b/, "authentication_error"],
        [/\brate_limit_error\b|rate[ _-]?limit|too many requests/, "rate_limit_error"],
        [/\boverloaded_error\b|\boverloaded\b/, "overloaded_error"],
        [/\binsufficient_quota\b/, "insufficient_quota"],
        [/\binvalid_request_error\b|invalid request/, "invalid_request_error"],
        [/\bpermission_error\b/, "permission_error"],
    ];
    const providerClass = providerClasses.find(([pattern]) => pattern.test(normalized))?.[1];
    if (providerClass)
        return short(`provider_error:${providerClass}${httpCode ? `:http_${httpCode}` : ""}`);
    if (httpCode) return `provider_error:http_${httpCode}`;

    if (
        /parse_failed|parse error|validation|invalid (?:historian )?output|historian returned (?:no usable compartments|invalid compartment output)|terminal boundary splits|tiered paraphrase structure/.test(
            normalized,
        )
    ) {
        return "parse_failed";
    }
    if (/empty_output|no[_ ]assistant|no usable text|empty text|empty output/.test(normalized)) {
        return "empty_output";
    }

    return "provider_error";
}

/** Count recorded attempts for one session, regardless of their outcome. */
export function countHistorianRuns(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare<[string], { count: number }>(
                "SELECT COUNT(*) AS count FROM historian_runs WHERE session_id = ?",
            )
            .get(sessionId);
        return row?.count ?? 0;
    } catch {
        // Older stores may not have the telemetry table yet; status stays usable.
        return 0;
    }
}

export function recordHistorianRun(db: Database, input: HistorianRunInput): number | null {
    try {
        const failureReason =
            input.status === "failed"
                ? classifyHistorianFailureReason(input.failureReason)
                : (input.failureReason ?? null);
        const result = db
            .prepare(
                `INSERT INTO historian_runs (
                    session_id, harness, subagent_invocation_id, run_kind, status,
                    failure_reason, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from,
                    compartments_produced, compartment_id_min, compartment_id_max,
                    facts_emitted, facts_by_category_json, events_emitted,
                    importance_min, importance_max, importance_avg,
                    discarded_last, legacy, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                input.sessionId,
                input.harness,
                input.subagentInvocationId ?? null,
                input.runKind,
                input.status,
                failureReason,
                input.chunkStartOrdinal ?? null,
                input.chunkEndOrdinal ?? null,
                input.unprocessedFrom ?? null,
                input.compartmentsProduced ?? 0,
                input.compartmentIdMin ?? null,
                input.compartmentIdMax ?? null,
                input.factsEmitted ?? 0,
                JSON.stringify({
                    ...(input.factsByCategory ?? {}),
                    facts_promoted: input.factsPromoted ?? 0,
                    events_published: input.eventsPublished ?? 0,
                }),
                input.eventsEmitted ?? 0,
                input.importanceMin ?? null,
                input.importanceMax ?? null,
                input.importanceAvg ?? null,
                input.discardedLast ? 1 : 0,
                input.legacy ? 1 : 0,
                Date.now(),
            );
        return Number(result.lastInsertRowid);
    } catch {
        return null;
    }
}

/** Summarize a list of importance values into min/max/avg (null on empty). */
export function summarizeImportance(values: readonly number[]): {
    min: number | null;
    max: number | null;
    avg: number | null;
} {
    const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (nums.length === 0) return { min: null, max: null, avg: null };
    let min = nums[0];
    let max = nums[0];
    let sum = 0;
    for (const v of nums) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    return { min, max, avg: sum / nums.length };
}

/** Tally facts by their category for `factsByCategory`. */
export function tallyFactsByCategory(
    facts: ReadonlyArray<{ category?: string | null }>,
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of facts) {
        const cat = (f.category ?? "UNKNOWN").trim() || "UNKNOWN";
        out[cat] = (out[cat] ?? 0) + 1;
    }
    return out;
}
