import {
	type PiChatHistoryModel,
	piChatHistoryPlan,
	piMatchesChatImages,
} from "./pi-dispatch-chat-history";
import { piGoogleConversation } from "./pi-dispatch-google";

interface MessageStructure {
	role: "user" | "assistant" | "toolResult";
	calls: string[];
	results: string[];
	callNames?: string[];
	resultNames?: string[];
	timestamp?: number;
	exactText?: string;
	exactImages?: readonly string[];
	wireContent?: unknown;
	wireRole?: unknown;
}

/** Transport-independent roles and ordered tool IDs, captured before text transforms. */
export interface PiPreparedStructure {
	messages: readonly MessageStructure[];
	chatMessages?: readonly MessageStructure[];
}

const MAX_MESSAGES = 100_000;

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function messageStructure(value: unknown): MessageStructure | undefined {
	const message = object(value);
	if (!message) return undefined;
	const role = [
		"custom",
		"hookMessage",
		"developer",
		"branchSummary",
		"compactionSummary",
		"bashExecution",
		"pythonExecution",
	].includes(String(message.role))
		? "user"
		: message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult")
		return undefined;
	const row: MessageStructure = { role, calls: [], results: [] };
	if (typeof message.timestamp === "number") row.timestamp = message.timestamp;
	if (role === "toolResult") {
		if (typeof message.toolCallId !== "string") return undefined;
		row.results.push(message.toolCallId);
	}
	if (role === "assistant" && Array.isArray(message.content)) {
		for (const value of message.content) {
			const block = object(value);
			if (block?.type !== "toolCall" && block?.type !== "tool_use") continue;
			if (typeof block.id !== "string") return undefined;
			row.calls.push(block.id);
			row.callNames ??= [];
			row.callNames.push(typeof block.name === "string" ? block.name : "");
		}
	}
	return row;
}

export function piPreparedStructure(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
): PiPreparedStructure | undefined {
	if (!messages.length || messages.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	const toolNames = new Map<string, string>();
	const byIndex = new Map<number, MessageStructure>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const source = object(message);
		if (
			(source?.role === "bashExecution" ||
				source?.role === "pythonExecution") &&
			source.excludeFromContext === true
		)
			continue;
		const row = messageStructure(message);
		if (!row) return undefined;
		row.calls.forEach((id, index) => {
			toolNames.set(id, row.callNames?.[index] ?? "");
		});
		if (row.results.length)
			row.resultNames = row.results.map((id) => toolNames.get(id) ?? "");
		rows.push(row);
		byIndex.set(index, row);
	}
	const plan = piChatHistoryPlan(messages, model);
	const chatMessages = plan?.flatMap((step): MessageStructure[] => {
		if (step.kind === "source") {
			const row = byIndex.get(step.index);
			return row ? [row] : [];
		}
		return [
			{
				role: "user",
				calls: [],
				results: [],
				...(step.kind === "note"
					? { exactText: step.text }
					: { exactImages: step.urls }),
			},
		];
	});
	return { messages: rows, ...(chatMessages ? { chatMessages } : {}) };
}

function payloadStructure(payload: unknown): MessageStructure[] | undefined {
	const body = object(payload);
	if (!body) return undefined;
	const google = piGoogleConversation(payload);
	if (google) return googleStructure(google.contents as unknown[]);
	const bedrock = body.inferenceConfig !== undefined;
	if (body.messages === undefined && typeof body.input === "string")
		return [{ role: "user", calls: [], results: [] }];
	const responses = body.messages === undefined && Array.isArray(body.input);
	const messages = responses ? body.input : body.messages;
	if (!Array.isArray(messages) || messages.length > MAX_MESSAGES)
		return undefined;
	const rows: MessageStructure[] = [];
	for (const value of messages) {
		const message = object(value);
		if (!message) return undefined;
		// Chat Completions and Azure Responses render context.systemPrompt before
		// context.messages, using system or developer roles. Leading instructions are not
		// prepared turns. piConversationFields keeps the original instruction rows
		// for exact comparison with the first admitted request on later dispatches.
		if (
			rows.length === 0 &&
			(message.role === "system" || message.role === "developer")
		)
			continue;
		// Responses emits reasoning/text/calls as separate items for one assistant
		// turn. Only its call/result IDs survive every supported replay mode.
		if (responses && message.type === "reasoning") continue;
		if (
			responses &&
			["function_call", "custom_tool_call", "computer_call"].includes(
				String(message.type),
			)
		) {
			if (typeof message.call_id !== "string") return undefined;
			let assistant = rows.at(-1);
			if (assistant?.role !== "assistant") {
				assistant = { role: "assistant", calls: [], results: [] };
				rows.push(assistant);
			}
			assistant.calls.push(message.call_id);
			continue;
		}
		if (
			responses &&
			[
				"function_call_output",
				"custom_tool_call_output",
				"computer_call_output",
			].includes(String(message.type))
		) {
			if (typeof message.call_id !== "string") return undefined;
			rows.push({ role: "toolResult", calls: [], results: [message.call_id] });
			continue;
		}
		if (message.role === "tool") {
			if (typeof message.tool_call_id !== "string") return undefined;
			rows.push({
				role: "toolResult",
				calls: [],
				results: [message.tool_call_id],
			});
			continue;
		}
		if (message.role === "user" && Array.isArray(message.content)) {
			const results = message.content.filter(
				(block) =>
					object(block)?.type === "tool_result" ||
					(bedrock && object(block)?.toolResult),
			);
			if (results.length) {
				// Anthropic and Bedrock pack a consecutive result run into one user message;
				// expand it back to the prepared array's roles and result IDs.
				for (const block of results) {
					const id = bedrock ? block.toolResult?.toolUseId : block.tool_use_id;
					if (typeof id !== "string") return undefined;
					rows.push({
						role: "toolResult",
						calls: [],
						results: [id],
					});
				}
				continue;
			}
		}
		const row = messageStructure(message);
		if (!row) return undefined;
		row.wireContent = message.content;
		row.wireRole = message.role;
		if (bedrock && row.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block?.toolUse) continue;
				if (typeof block.toolUse.toolUseId !== "string") return undefined;
				row.calls.push(block.toolUse.toolUseId);
			}
		}
		if (Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				if (typeof call?.id !== "string") return undefined;
				row.calls.push(call.id);
			}
		}
		if (
			responses &&
			row.role === "assistant" &&
			rows.at(-1)?.role === "assistant"
		) {
			rows[rows.length - 1].calls.push(...row.calls);
		} else rows.push(row);
	}
	return rows;
}

function googleStructure(contents: unknown[]): MessageStructure[] | undefined {
	if (contents.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	for (const value of contents) {
		const message = object(value);
		if (!message || !Array.isArray(message.parts)) return undefined;
		if (message.role !== "user" && message.role !== "model") return undefined;
		const row: MessageStructure = {
			role: message.role === "model" ? "assistant" : "user",
			calls: [],
			results: [],
		};
		const results: MessageStructure[] = [];
		for (const value of message.parts) {
			const part = object(value);
			if (!part) return undefined;
			if (part.functionCall) {
				const call = object(part.functionCall);
				if (
					row.role !== "assistant" ||
					typeof call?.name !== "string" ||
					(call.id !== undefined && typeof call.id !== "string")
				)
					return undefined;
				row.calls.push((call.id as string) ?? "");
				row.callNames ??= [];
				row.callNames.push(call.name);
			}
			if (part.functionResponse) {
				const result = object(part.functionResponse);
				if (
					row.role !== "user" ||
					typeof result?.name !== "string" ||
					(result.id !== undefined && typeof result.id !== "string")
				)
					return undefined;
				results.push({
					role: "toolResult",
					calls: [],
					results: [(result.id as string) ?? ""],
					resultNames: [result.name],
				});
			}
		}
		// Gemini packs adjacent function results into one user content. Its older
		// models omit IDs, but preserve the ordered function names and result run.
		if (results.length) rows.push(...results);
		else rows.push(row);
	}
	return rows;
}

function wireId(
	id: string,
	anthropic: boolean,
	responses: boolean,
): string | undefined {
	if (anthropic) return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	if (responses) {
		const callId = id.split(/[\n|]/, 1)[0];
		// Long/foreign IDs can be provider-hashed. Without that provider's
		// model/compat state we cannot prove the mapping, so refuse rather than guess.
		return /^[a-zA-Z0-9_-]{1,64}$/.test(callId) ? callId : undefined;
	}
	return id;
}

type StructureComparison =
	| "role"
	| "call id"
	| "result id"
	| "name"
	| "count"
	| "timestamp"
	| "content";

function safeRole(
	row: MessageStructure | undefined,
	readable: boolean,
): string {
	if (!readable) return "unreadable";
	if (!row) return "missing";
	return ["user", "assistant", "toolResult"].includes(row.role)
		? row.role
		: "unknown";
}

function safeCount(value: number | undefined): number | "unreadable" {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: "unreadable";
}

function structureDetail(
	index: number,
	expected: readonly MessageStructure[] | undefined,
	actual: readonly MessageStructure[] | undefined,
	comparison: StructureComparison,
): string {
	const expectedRow = expected?.[index];
	const actualRow = actual?.[index];
	// Only enum roles and numeric counts may leave the comparator. IDs, names,
	// message text and exception messages must never enter refusal diagnostics.
	return `row=${index} expectedRows=${safeCount(expected?.length)} actualRows=${safeCount(actual?.length)} expectedRole=${safeRole(expectedRow, !!expected)} actualRole=${safeRole(actualRow, !!actual)} expectedCalls=${safeCount(expected ? (expectedRow?.calls.length ?? 0) : undefined)} actualCalls=${safeCount(actual ? (actualRow?.calls.length ?? 0) : undefined)} expectedResults=${safeCount(expected ? (expectedRow?.results.length ?? 0) : undefined)} actualResults=${safeCount(actual ? (actualRow?.results.length ?? 0) : undefined)} comparison=${comparison}`;
}

/** Return metadata for the first differing zero-based normalized row, or no mismatch. */
export function piPreparedStructureMismatch(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
): string | undefined {
	try {
		const rows = payloadStructure(payload);
		const body = object(payload);
		const chat =
			!!body &&
			Array.isArray(body.messages) &&
			body.system === undefined &&
			body.input === undefined &&
			body.inferenceConfig === undefined;
		const expectedRows =
			chat && prepared?.chatMessages
				? prepared.chatMessages
				: prepared?.messages;
		if (!rows || !expectedRows)
			return structureDetail(0, expectedRows, rows, "count");
		if (!body) return structureDetail(0, expectedRows, rows, "count");
		const google = !!piGoogleConversation(payload);
		const anthropic =
			google ||
			body.inferenceConfig !== undefined ||
			typeof body.system === "string" ||
			Array.isArray(body.system);
		const responses = body.messages === undefined && Array.isArray(body.input);
		for (let i = 0; i < Math.min(rows.length, expectedRows.length); i++) {
			const expected = expectedRows[i];
			const actual = rows[i];
			if (actual.role !== expected.role)
				return structureDetail(i, expectedRows, rows, "role");
			if (
				expected.exactText !== undefined ||
				expected.exactImages !== undefined
			) {
				if (actual.wireRole !== "user")
					return structureDetail(i, expectedRows, rows, "role");
				if (
					(expected.exactText !== undefined &&
						actual.wireContent !== expected.exactText) ||
					(expected.exactImages !== undefined &&
						!piMatchesChatImages(actual.wireContent, expected.exactImages))
				)
					return structureDetail(i, expectedRows, rows, "content");
			}
			if (
				actual.calls.length !== expected.calls.length ||
				actual.results.length !== expected.results.length
			)
				return structureDetail(i, expectedRows, rows, "count");
			if (
				actual.timestamp !== undefined &&
				actual.timestamp !== expected.timestamp
			)
				return structureDetail(i, expectedRows, rows, "timestamp");
			for (let j = 0; j < actual.calls.length; j++)
				if (
					google && actual.calls[j] === ""
						? !expected.callNames?.[j] ||
							actual.callNames?.[j] !== expected.callNames[j]
						: actual.calls[j] !==
							wireId(expected.calls[j], anthropic, responses)
				)
					return structureDetail(
						i,
						expectedRows,
						rows,
						google && actual.calls[j] === "" ? "name" : "call id",
					);
			for (let j = 0; j < actual.results.length; j++)
				if (
					google && actual.results[j] === ""
						? !expected.resultNames?.[j] ||
							actual.resultNames?.[j] !== expected.resultNames[j]
						: actual.results[j] !==
							wireId(expected.results[j], anthropic, responses)
				)
					return structureDetail(
						i,
						expectedRows,
						rows,
						google && actual.results[j] === "" ? "name" : "result id",
					);
		}
		if (rows.length !== expectedRows.length)
			return structureDetail(
				Math.min(rows.length, expectedRows.length),
				expectedRows,
				rows,
				"count",
			);
		return undefined;
	} catch {
		// Unreadable payloads still fail closed without exposing a getter's error.
		return structureDetail(0, undefined, undefined, "count");
	}
}

/** Check the latest turn as well as every preceding role and ordered tool ID. */
export function piMatchesPreparedStructure(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
): boolean {
	return piPreparedStructureMismatch(payload, prepared) === undefined;
}
