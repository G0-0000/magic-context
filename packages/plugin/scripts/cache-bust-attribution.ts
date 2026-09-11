export type CacheBustDivergenceClass =
    | "accounted_hard_model_change"
    | "accounted_hard_system_hash"
    | "accounted_hard_epoch"
    | "accounted_hard_pressure_refold"
    | "accounted_hard_marker_drain"
    | "accounted_soft_m1_execute"
    | "accounted_ctx_reduce"
    | "accounted_ctx_flush"
    | "accounted_force_band"
    | "accounted_provider_system_prompt_change"
    | "unaccounted_defer_pass"
    | "unaccounted_double_bust"
    | "unaccounted_tail_rewrite"
    | "unaccounted_rewrite";

export interface AnalyzedCacheRequest {
    session: string;
    at: string;
    timestampMs: number;
    verdict: "BASE" | "BUST" | "STABLE" | "LATENCY" | "UNMETERED";
    rewrittenTokens?: number;
    divergenceClass?: CacheBustDivergenceClass;
    firstDivergence: string;
    analyzerCmd: string;
}

export interface CacheBustSessionAnalysis {
    requests: AnalyzedCacheRequest[];
    highWaterMarkMs: number | null;
    directory?: string;
}

export interface CacheBustDecisionAttribution {
    timestampMs: number;
    messageId?: string;
    decision: string;
    materialized: boolean;
    materializeReason: string | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
}

export interface CacheBustAttributionInput {
    divergenceIndex: number;
    previousMessageCount: number;
    previousBustDivergenceIndex?: number;
    previousProvider?: string;
    currentProvider?: string;
    firstDivergenceRole?: string;
    contentEvidence?: string;
    compactionSeam?: boolean;
    decision?: CacheBustDecisionAttribution;
}

export interface CacheBustRule {
    divergenceClass: CacheBustDivergenceClass;
    accounted: boolean;
    rule: string;
}

export const CACHE_BUST_RULE_TABLE: readonly CacheBustRule[] = [
    {
        divergenceClass: "unaccounted_defer_pass",
        accounted: false,
        rule: "provider-visible divergence on decision=defer",
    },
    {
        divergenceClass: "accounted_ctx_flush",
        accounted: true,
        rule: "rewrite caused by /ctx-flush (materialize_reason=explicit_flush)",
    },
    {
        divergenceClass: "accounted_ctx_reduce",
        accounted: true,
        rule: "rewrite landing from an agent ctx_reduce call",
    },
    {
        divergenceClass: "accounted_force_band",
        accounted: true,
        rule: "forced emergency batch at the >=85% force band",
    },
    {
        divergenceClass: "accounted_hard_marker_drain",
        accounted: true,
        rule: "HARD/m0 rebuild at a compaction-marker drain seam",
    },
    {
        divergenceClass: "accounted_hard_model_change",
        accounted: true,
        rule: "HARD/m0 rebuild with materialize_reason=model_change",
    },
    {
        divergenceClass: "accounted_hard_system_hash",
        accounted: true,
        rule: "HARD/m0 rebuild with materialize_reason=system_hash",
    },
    {
        divergenceClass: "accounted_hard_epoch",
        accounted: true,
        rule: "HARD/m0 rebuild caused by project, render, or session epoch change",
    },
    {
        divergenceClass: "accounted_hard_pressure_refold",
        accounted: true,
        rule: "HARD/m0 rebuild with materialize_reason=pressure_refold",
    },
    {
        divergenceClass: "accounted_soft_m1_execute",
        accounted: true,
        rule: "SOFT m1_delta/coverage_fold refresh on decision=execute",
    },
    {
        divergenceClass: "accounted_provider_system_prompt_change",
        accounted: true,
        rule: "user-visible provider switch or system-prompt change",
    },
    {
        divergenceClass: "unaccounted_double_bust",
        accounted: false,
        rule: "consecutive BUST at the same first-divergence/read offset",
    },
    {
        divergenceClass: "unaccounted_tail_rewrite",
        accounted: false,
        rule: "unforced rewrite in the previous request's tail",
    },
    {
        divergenceClass: "unaccounted_rewrite",
        accounted: false,
        rule: "BUST with no accounted attribution",
    },
] as const;

const ACCOUNTED_CLASSES = new Set(
    CACHE_BUST_RULE_TABLE.filter((row) => row.accounted).map((row) => row.divergenceClass),
);
const EPOCH_REASONS = new Set(["project_memory_epoch", "epoch_change", "compartment_render_epoch"]);
const M1_REASONS = new Set(["m1_delta", "coverage_fold"]);

export function isUnaccountedCacheBustClass(divergenceClass: string): boolean {
    return !ACCOUNTED_CLASSES.has(divergenceClass as CacheBustDivergenceClass);
}

export function nearestCacheBustDecision(
    decisions: readonly CacheBustDecisionAttribution[],
    timestampMs: number,
    messageId?: string,
): CacheBustDecisionAttribution | undefined {
    if (messageId) {
        const exact = decisions.find((decision) => decision.messageId === messageId);
        if (exact) return exact;
    }
    let nearest: CacheBustDecisionAttribution | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const decision of decisions) {
        const distance = Math.abs(decision.timestampMs - timestampMs);
        if (distance <= 5 * 60_000 && distance < nearestDistance) {
            nearest = decision;
            nearestDistance = distance;
        }
    }
    return nearest;
}

export function classifyCacheBust(input: CacheBustAttributionInput): CacheBustDivergenceClass {
    const decision = input.decision;
    if (decision?.decision === "defer") return "unaccounted_defer_pass";
    if (decision?.materializeReason === "explicit_flush") return "accounted_ctx_flush";

    if (/\bctx_reduce\b/.test(input.contentEvidence ?? "")) {
        return "accounted_ctx_reduce";
    }
    if (decision?.emergency && decision.droppedCount > 0) {
        return "accounted_force_band";
    }
    if (
        input.compactionSeam ||
        (input.contentEvidence ?? "").includes("[Compacted by magic-context")
    ) {
        return "accounted_hard_marker_drain";
    }
    if (decision?.materialized) {
        if (decision.materializeReason === "model_change") {
            return "accounted_hard_model_change";
        }
        if (decision.materializeReason === "system_hash") {
            return "accounted_hard_system_hash";
        }
        if (decision.materializeReason && EPOCH_REASONS.has(decision.materializeReason)) {
            return "accounted_hard_epoch";
        }
        if (decision.materializeReason === "pressure_refold") {
            return "accounted_hard_pressure_refold";
        }
    }
    if (
        decision?.decision === "execute" &&
        !decision.materialized &&
        decision.materializeReason !== null &&
        M1_REASONS.has(decision.materializeReason)
    ) {
        return "accounted_soft_m1_execute";
    }
    if (
        (input.previousProvider &&
            input.currentProvider &&
            input.previousProvider !== input.currentProvider) ||
        input.firstDivergenceRole === "system"
    ) {
        return "accounted_provider_system_prompt_change";
    }
    if (
        input.previousBustDivergenceIndex !== undefined &&
        input.previousBustDivergenceIndex === input.divergenceIndex
    ) {
        return "unaccounted_double_bust";
    }
    if (input.divergenceIndex >= Math.max(0, input.previousMessageCount - 2)) {
        return "unaccounted_tail_rewrite";
    }
    return "unaccounted_rewrite";
}
