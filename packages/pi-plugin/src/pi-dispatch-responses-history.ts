import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";

const MAX_TEXT_UNITS = 32 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function wellFormed(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"\uFFFD",
	);
}

function textIdentity(text: string, phase: unknown): string {
	return JSON.stringify([
		text,
		phase === "commentary" || phase === "final_answer" ? phase : null,
	]);
}

function signaturePhase(block: Record<string, unknown>): unknown {
	try {
		if (typeof block.textSignature === "string") {
			const signature = object(JSON.parse(block.textSignature));
			if (signature?.v === 1 && typeof signature.id === "string")
				return signature.phase;
		}
	} catch {}
	return undefined;
}

/**
 * Capture ordered [text, phase] pairs as JSON strings for OpenAI Responses replay.
 * Cached provider items may omit our leading ordinal only when they represent
 * the same signed text blocks; otherwise require the prepared text verbatim.
 */
export function piResponsesAssistantTexts(
	value: unknown,
	model: PiChatHistoryModel | undefined,
): readonly string[] | undefined {
	const message = object(value);
	if (!message || !Array.isArray(message.content)) return undefined;
	const texts: string[] = [];
	const blocks: Record<string, unknown>[] = [];
	const sameModel =
		message.api === model?.api &&
		message.model === model?.id &&
		message.provider === model?.provider;
	const sameModelThinking =
		model !== undefined &&
		typeof model.api === "string" &&
		typeof model.id === "string" &&
		typeof model.provider === "string" &&
		message.api === model.api &&
		message.model === model.id &&
		message.provider === model.provider;
	let units = 0;
	for (const value of message.content) {
		const block = object(value);
		if (block?.type === "toolCall") continue;
		// The same-model Responses serializer represents canonical thinking as
		// reasoning items (or omits it), neither of which contributes a text row.
		// Cross-model serializers may expose thinking as text, so fail closed there.
		if (block?.type === "thinking" && sameModelThinking) continue;
		if (block?.type !== "text" || typeof block.text !== "string")
			return undefined;
		units += block.text.length;
		if (units > MAX_TEXT_UNITS) return undefined;
		texts.push(
			textIdentity(
				wellFormed(block.text),
				sameModel ? signaturePhase(block) : undefined,
			),
		);
		blocks.push(block);
	}
	// Oh My Pi emits each text block as an output_text item and keeps commentary,
	// so collapsing role rows must retain every block rather than just the first.
	// @oh-my-pi/pi-ai/src/providers/openai-shared.ts:2503-2531 (18.10.4).
	const payload = object(message.providerPayload);
	if (
		message.api !== model?.api ||
		typeof model?.id !== "string" ||
		typeof model?.provider !== "string" ||
		message.model !== model?.id ||
		(payload?.provider ?? message.provider) !== model?.provider ||
		payload?.type !== "openaiResponsesHistory" ||
		payload.dt !== true ||
		!Array.isArray(payload.items) ||
		message.content.length !== blocks.length
	)
		return texts;
	// Matching API/model/provider selects cached wire items instead of converting
	// the prepared blocks. The cache's dt flag marks items to append; without it,
	// replay replaces all preceding input. Allow only append-only text whose v1
	// signature binds the cached item ID and phase to the prepared block, and whose
	// text differs at most by our leading ordinal label. Never excuse other edits.
	// openai-shared.ts:2204-2260; utils.ts:653-663 (18.10.4).
	const replay: string[] = [];
	for (const value of payload.items) {
		const item = object(value);
		if (
			item?.type !== "message" ||
			item.role !== "assistant" ||
			!Array.isArray(item.content)
		)
			return texts;
		for (const value of item.content) {
			const part = object(value);
			const block = blocks[replay.length];
			if (
				!block ||
				part?.type !== "output_text" ||
				typeof part.text !== "string"
			)
				return texts;
			let signature: Record<string, unknown> | undefined;
			try {
				if (typeof block.textSignature === "string")
					signature = object(JSON.parse(block.textSignature));
			} catch {
				return texts;
			}
			if (
				signature?.v !== 1 ||
				typeof signature.id !== "string" ||
				item.id !== signature.id ||
				item.phase !== signature.phase ||
				part.text !== (block.text as string).replace(/^§\d+§ /u, "")
			)
				return texts;
			replay.push(textIdentity(wellFormed(part.text), item.phase));
		}
	}
	return replay.length === texts.length ? replay : texts;
}

/** Keep every wire text item when adjacent assistant items share one role row. */
export function piResponsesWireTexts(
	value: unknown,
	phase?: unknown,
): readonly string[] | undefined {
	if (
		phase !== undefined &&
		phase !== null &&
		phase !== "commentary" &&
		phase !== "final_answer"
	)
		return undefined;
	if (typeof value === "string") return [textIdentity(value, phase)];
	if (!Array.isArray(value)) return undefined;
	const texts: string[] = [];
	let units = 0;
	for (const partValue of value) {
		const part = object(partValue);
		if (part?.type !== "output_text" || typeof part.text !== "string")
			return undefined;
		units += part.text.length;
		if (units > MAX_TEXT_UNITS) return undefined;
		texts.push(textIdentity(part.text, phase));
	}
	return texts;
}
