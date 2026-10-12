import type { ContextEvent } from "@earendil-works/pi-coding-agent";

// OMP marks an ephemeral request with a developer reminder and a final user
// prompt, both attributed to "agent" in the context event. Provider adapters
// erase attribution; reminder text on the wire is not proof of a side request.
const SIDE_REMINDER =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

function textContainsReminder(value: unknown): boolean {
	if (typeof value === "string") return value.trim() === SIDE_REMINDER;
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (!block || typeof block !== "object") return false;
		const part = block as { text?: unknown; content?: unknown };
		return typeof part.text === "string" && part.text.trim() === SIDE_REMINDER;
	});
}

export function isOmpSideContext(event: ContextEvent): boolean {
	const tail = event.messages.at(-1) as
		| { role?: unknown; attribution?: unknown }
		| undefined;
	if (tail?.role !== "user" || tail.attribution !== "agent") return false;
	return event.messages.some((message) => {
		const row = message as {
			role?: unknown;
			attribution?: unknown;
			content?: unknown;
		};
		return (
			row.role === "developer" &&
			row.attribution === "agent" &&
			textContainsReminder(row.content)
		);
	});
}

const ADVISOR_PREFIX =
	"<conventions>\nRFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`.\n</conventions>\n\nUser, code-quality, robustness advocate; peer-shadow main agent.\n";
const ADVISOR_WORKFLOW =
	"<workflow>\nReceive incremental agent transcript, including thoughts.\n";
const CAPTURE_PREFIX =
	"Automated capture turn — not a user reply; user has not responded to your previous turn.";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstText(
	value: unknown,
	type: "text" | "input_text",
): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const part = record(value[0]);
	return part?.type === type && typeof part.text === "string"
		? part.text
		: undefined;
}

// Recognize the Anthropic Messages and OpenAI Responses shapes observed on
// OMP 18.8.6. Other shapes must still prove a completed managed context pass
// before sending a conversation; an unknown shape is not an exemption.
function providerRequest(payload: unknown) {
	const body = record(payload);
	if (!body || !Array.isArray(body.tools)) return undefined;
	if (Array.isArray(body.input) && typeof body.instructions === "string") {
		if (
			"messages" in body ||
			"system" in body ||
			!body.tools.every((tool) => record(tool)?.type === "function")
		)
			return undefined;
		return {
			messages: body.input,
			system: [body.instructions],
			tools: body.tools.map((tool) => record(tool)?.name),
			textType: "input_text" as const,
		};
	}
	if (
		!Array.isArray(body.messages) ||
		"input" in body ||
		"instructions" in body
	)
		return undefined;
	const system =
		typeof body.system === "string"
			? [body.system]
			: Array.isArray(body.system)
				? body.system.map(firstTextBlock)
				: [];
	const tools = body.tools.map((tool) => {
		const name = record(tool)?.name;
		return typeof name === "string" && name.startsWith("_")
			? name.slice(1)
			: undefined;
	});
	return { messages: body.messages, system, tools, textType: "text" as const };
}

function firstTextBlock(value: unknown): string | undefined {
	const part = record(value);
	return part?.type === "text" && typeof part.text === "string"
		? part.text
		: undefined;
}

/** OMP's advisor reviews formatted copies of new conversation messages in its own agent history. */
export function isOmpAdvisorRequest(payload: unknown): boolean {
	const request = providerRequest(payload);
	if (!request?.tools.includes("advise")) return false;
	if (
		!request.system.some(
			(text) =>
				text?.startsWith(ADVISOR_PREFIX) && text.includes(ADVISOR_WORKFLOW),
		)
	)
		return false;
	const first = record(request.messages[0]);
	if (first?.role !== "user") return false;
	let text = firstText(first.content, request.textType)?.replace(
		/^<system-reminder>\nToday: [^\n]+\n<\/system-reminder>(?:\n|$)/,
		"",
	);
	// OpenAI Responses separates its date and working-directory reminder from
	// the review text. If the first block is only that reminder, read the next.
	if (text === "" && Array.isArray(first.content))
		text = firstText(first.content.slice(1, 2), request.textType);
	return text?.startsWith("### Session update\n\n") === true;
}

/** OMP auto-learn copies raw conversation messages, skipping Magic Context's tagging/pruning; a main-pass receipt cannot authorize that copy. */
export function isOmpUnmanagedCaptureRequest(payload: unknown): boolean {
	const request = providerRequest(payload);
	if (
		!request?.tools.length ||
		!request.tools.every((name) => name === "manage_skill" || name === "learn")
	)
		return false;
	const last = record(request.messages.at(-1));
	return (
		last?.role === "user" &&
		firstText(last.content, request.textType)?.startsWith(CAPTURE_PREFIX) ===
			true
	);
}
