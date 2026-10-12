/**
 * Calm user-facing line for fail-closed refusals caused by the engine being
 * temporarily unreachable. States what happened and what to do; deliberately
 * carries no token counts or internals — the numbers belong to the log lines
 * that accompany the throw, not the primary message a user reads.
 */
export const ENGINE_RECONNECTING_USER_MESSAGE =
    "Magic Context's engine is reconnecting. Send your message again in a few seconds.";

/**
 * Calm user-facing line for a refusal while the engine is connected but still
 * applying an earlier context update of this session (one whose reply the plugin
 * stopped waiting for). Saying "reconnecting" there would be wrong: the engine
 * answers, it is only busy.
 */
export const ENGINE_BUSY_USER_MESSAGE =
    "Magic Context is still applying the previous context update for this session. Send your message again in a moment.";

export const PROTECTED_TOOL_RESULTS_OVER_LIMIT =
    "The tool results kept by protected_tools are larger than this model's context window, so this turn was not sent. Lower the protected_tools counts.";
export const PROTECTED_TOOL_RESULTS_OVER_LIMIT_CODE = "protected_tool_results_over_limit";
/** The Rust module's refusal of an open signed thinking turn that cannot fit the context
 * window even after all of its thinking and reclaimable tool output were removed. Must
 * match `SIGNED_TURN_OVER_LIMIT_{CODE,MESSAGE}` in crates/mc-module/src/transform.rs. */
export const SIGNED_TURN_OVER_LIMIT =
    "This turn's context is larger than the model's context window even after all of its thinking and reclaimable tool output were removed, so it was not sent. Send a new message or start a new session to continue.";
export const SIGNED_TURN_OVER_LIMIT_CODE = "signed_turn_over_limit";

export function contextRefusalError(message: string): EmergencyFailClosedError {
    return new EmergencyFailClosedError(message, {
        code:
            message === PROTECTED_TOOL_RESULTS_OVER_LIMIT
                ? PROTECTED_TOOL_RESULTS_OVER_LIMIT_CODE
                : message === SIGNED_TURN_OVER_LIMIT
                  ? SIGNED_TURN_OVER_LIMIT_CODE
                  : undefined,
    });
}

/** A module refusal of a request that cannot fit the context window (protected tool
 * results, or a signed turn that cannot fit even after its thinking was stripped). */
export function protectedToolRefusal(error: unknown): EmergencyFailClosedError | undefined {
    const seen = new Set<unknown>();
    while (error && typeof error === "object" && !seen.has(error)) {
        seen.add(error);
        const current = error as { code?: unknown; cause?: unknown };
        if (current.code === PROTECTED_TOOL_RESULTS_OVER_LIMIT_CODE)
            return contextRefusalError(PROTECTED_TOOL_RESULTS_OVER_LIMIT);
        if (current.code === SIGNED_TURN_OVER_LIMIT_CODE)
            return contextRefusalError(SIGNED_TURN_OVER_LIMIT);
        error = current.cause;
    }
    return undefined;
}

export interface ContextRefusalEstimate {
    tokens: number;
    /** Completeness for admission (deciding whether to send); may use a conservative
     * fit multiplier. */
    trusted: boolean;
    /** Refusal-grade evidence: complete, calibrated proof for this route that the
     * request does not fit. */
    refusalGrade?: boolean;
    refusalTokens?: number;
}

/** Only protected results that cannot fit by themselves justify a new healthy
 * refusal. Other pressure keeps the provider-overflow and fold behavior: a
 * complete estimate, or even usage from an accepted reply, is not a new reason
 * to stop a turn whose protected results fit. */
export function outgoingContextRefusal(
    estimate: ContextRefusalEstimate | undefined,
    limit: number | undefined,
    protectedToolTokens = 0,
): string | undefined {
    if (
        estimate?.refusalGrade !== true ||
        typeof estimate.refusalTokens !== "number" ||
        !Number.isFinite(estimate.refusalTokens) ||
        !limit ||
        !Number.isFinite(limit) ||
        limit <= 0 ||
        estimate.refusalTokens <= limit ||
        !Number.isFinite(protectedToolTokens) ||
        protectedToolTokens <= limit
    )
        return undefined;
    return PROTECTED_TOOL_RESULTS_OVER_LIMIT;
}

export class EmergencyFailClosedError extends Error {
    readonly code: string;

    constructor(message: string, options?: { cause?: unknown; code?: string }) {
        super(message, options);
        this.code = options?.code ?? "EMERGENCY_FAIL_CLOSED";
        this.name = "EmergencyFailClosedError";
    }
}
