import {
	type OutputReserveConfig,
	resolveOutputReserve,
} from "@magic-context/core/shared/models-dev-cache";
import {
	deriveWindowGeometry,
	getWindowOverlay,
	resolveWindowOverlayFacts,
	type WindowGeometryResult,
} from "@magic-context/core/shared/window-geometry";

const MIN_SANE_LIMIT = 16_000;
const MAX_SANE_LIMIT = 10_000_000;

export interface PiModelLimit {
	provider?: string;
	id?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ResolvePiWindowGeometryArgs {
	rawContextWindow?: number;
	model?: PiModelLimit;
	detectedContextLimit?: number;
	provenInputTokens?: number;
	persistedInputTokens?: number;
	persistedPercentage?: number;
	reserveConfig?: OutputReserveConfig;
}

function isSaneLimit(value: number | undefined): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_SANE_LIMIT &&
		value <= MAX_SANE_LIMIT
	);
}

export function resolvePiWindowGeometry(
	args: ResolvePiWindowGeometryArgs,
): WindowGeometryResult | undefined {
	const runtimeWindow = isSaneLimit(args.rawContextWindow)
		? args.rawContextWindow
		: isSaneLimit(args.model?.contextWindow)
			? args.model.contextWindow
			: undefined;
	const persistedUsable =
		isSaneLimit(args.persistedInputTokens) &&
		typeof args.persistedPercentage === "number" &&
		Number.isFinite(args.persistedPercentage) &&
		args.persistedPercentage > 0
			? args.persistedInputTokens / (args.persistedPercentage / 100)
			: undefined;
	const persistedWindow =
		isSaneLimit(args.persistedInputTokens) &&
		typeof args.persistedPercentage === "number" &&
		Number.isFinite(args.persistedPercentage) &&
		args.persistedPercentage > 0
			? args.persistedInputTokens / (args.persistedPercentage / 100)
			: undefined;
	const context = runtimeWindow ?? persistedWindow;
	if (!isSaneLimit(context)) return undefined;
	const providerID = args.model?.provider ?? "unknown";
	const modelID = args.model?.id ?? "unknown";
	const outputReserveOverride = resolveOutputReserve(
		providerID,
		modelID,
		args.reserveConfig,
	);
	const result = deriveWindowGeometry(
		providerID,
		modelID,
		{
			context,
			output: args.model?.maxTokens,
		},
		{
			overlay: resolveWindowOverlayFacts(
				providerID,
				modelID,
				getWindowOverlay(),
			),
			contextCap: isSaneLimit(args.detectedContextLimit)
				? args.detectedContextLimit
				: undefined,
			outputReserveOverride,
			harness: "pi",
		},
	);
	if (!result) return result;
	let resolved = result;
	if (outputReserveOverride === undefined && isSaneLimit(persistedUsable)) {
		const usableSoft = Math.round(persistedUsable);
		resolved = {
			...resolved,
			usableSoft,
			usableHard: Math.max(usableSoft, resolved.usableHard),
			derivation: {
				...resolved.derivation,
				reserve: Math.max(0, resolved.derivation.window - usableSoft),
			},
		};
	}

	if (
		!isSaneLimit(args.detectedContextLimit) &&
		isSaneLimit(args.provenInputTokens) &&
		args.provenInputTokens > resolved.usableSoft
	) {
		const usableSoft = args.provenInputTokens;
		const window = Math.max(resolved.derivation.window, usableSoft);
		resolved = {
			...resolved,
			usableSoft,
			usableHard: Math.max(usableSoft, resolved.usableHard),
			derivation: {
				...resolved.derivation,
				window,
				reserve: Math.max(0, window - usableSoft),
			},
		};
	}

	return resolved;
}

export function resolvePiUsableContextLimit(
	args: ResolvePiWindowGeometryArgs,
): number | undefined {
	return resolvePiWindowGeometry(args)?.usableSoft;
}
