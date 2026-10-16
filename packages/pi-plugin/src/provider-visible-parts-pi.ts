type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PART_FIELDS: Readonly<Record<string, readonly string[]>> = {
	text: ["type", "text", "textSignature"],
	thinking: ["type", "thinking", "thinkingSignature", "redacted"],
	image: ["type", "data", "mimeType"],
	toolCall: [
		"type",
		"id",
		"name",
		"arguments",
		"thoughtSignature",
		"namespace",
	],
};
const MESSAGE_FIELDS = [
	"role",
	"provider",
	"api",
	"model",
	"stopReason",
	"toolCallId",
	"toolName",
	"isError",
] as const;

function pick(value: RecordValue, fields: readonly string[]): RecordValue {
	const view: RecordValue = {};
	for (const field of fields) {
		if (Object.hasOwn(value, field)) view[field] = value[field];
	}
	return view;
}

/**
 * Inputs read by Pi's Anthropic, Google and OpenAI message converters, including
 * their signature/model replay checks. UI metadata/details are never enumerated.
 * Tool arguments are opaque provider input: a field named metadata inside them
 * must not be removed. See pi-ai 0.87.1 dist/api/* message converters.
 */
export function providerVisiblePiPart(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(providerVisiblePiPart);
	if (!isRecord(value)) return value;
	if (typeof value.role === "string") {
		const view = pick(value, MESSAGE_FIELDS);
		if (Object.hasOwn(value, "content")) {
			view.content = Array.isArray(value.content)
				? value.content.map(providerVisiblePiPart)
				: typeof value.content === "string"
					? value.content
					: undefined;
		}
		return view;
	}
	const type = typeof value.type === "string" ? value.type : "";
	return pick(
		value,
		Object.hasOwn(PART_FIELDS, type) ? PART_FIELDS[type] : ["type"],
	);
}
