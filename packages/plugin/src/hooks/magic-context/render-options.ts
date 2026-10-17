import type { ContextUsage } from "../../features/magic-context/types";
import { historyBudgetPolicyIdentity, resolveExecuteThreshold } from "./event-resolvers";
import type { TransformDeps } from "./transform";

type RenderControls = Pick<
    TransformDeps,
    | "injectDocs"
    | "muralEnabled"
    | "experimentalTemporalAwareness"
    | "historyBudgetPercentage"
    | "executeThresholdPercentage"
    | "executeThresholdTokens"
>;

/**
 * Share docs, mural, temporal and history-budget settings between context requests
 * and host folds. A fold that records defaults would force another prefix rebuild
 * when the next request restores the configured settings.
 */
export function createM0RenderOptions(
    controls: RenderControls,
    contextUsage: ContextUsage,
    modelKey: string | undefined,
    resolvedContextLimit?: number,
) {
    return {
        injectDocs: controls.injectDocs,
        muralEnabled: controls.muralEnabled,
        temporalAwareness: controls.experimentalTemporalAwareness,
        historyBudgetTokens: resolveHistoryBudgetTokens(
            controls.historyBudgetPercentage,
            contextUsage,
            controls.executeThresholdPercentage,
            modelKey,
            controls.executeThresholdTokens,
            resolvedContextLimit,
        ),
        historyBudgetPolicyIdentity: historyBudgetPolicyIdentity(
            controls.historyBudgetPercentage,
            controls.executeThresholdPercentage,
            modelKey,
            controls.executeThresholdTokens,
        ),
    };
}

export function resolveHistoryBudgetTokens(
    historyBudgetPercentage: number | undefined,
    contextUsage: ContextUsage,
    executeThresholdPercentage: TransformDeps["executeThresholdPercentage"],
    modelKey: string | undefined,
    executeThresholdTokens?: TransformDeps["executeThresholdTokens"],
    resolvedContextLimit?: number,
): number | undefined {
    if (!historyBudgetPercentage) return undefined;

    // The first request after a restart can report zero input tokens and zero
    // usage percentage. Prefer the known model limit; derive it from usage only
    // when no limit is known. Otherwise the renderer falls back to 60,000 tokens
    // and may archive history that still fits the model's configured allowance.
    let contextLimit = resolvedContextLimit && resolvedContextLimit > 0 ? resolvedContextLimit : 0;
    if (contextLimit <= 0) {
        if (contextUsage.percentage <= 0) return undefined;
        contextLimit = contextUsage.inputTokens / (contextUsage.percentage / 100);
    }
    if (!Number.isFinite(contextLimit) || contextLimit <= 0) return undefined;

    return Math.floor(
        contextLimit *
            (resolveExecuteThreshold(executeThresholdPercentage ?? 65, modelKey, 65, {
                tokensConfig: executeThresholdTokens,
                contextLimit,
            }) /
                100) *
            historyBudgetPercentage,
    );
}
