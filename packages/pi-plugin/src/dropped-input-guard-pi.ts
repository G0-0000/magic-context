import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	containsDroppedInputPlaceholder,
	DROPPED_INPUT_MESSAGE,
} from "@magic-context/core/hooks/magic-context/dropped-input-guard";

export function createPiDroppedInputGuard(): (
	event: ToolCallEvent,
) => ToolCallEventResult | undefined {
	return (event) => {
		if (!containsDroppedInputPlaceholder(event.input)) return undefined;
		return { block: true, reason: DROPPED_INPUT_MESSAGE };
	};
}

export function registerPiDroppedInputGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", createPiDroppedInputGuard());
}
