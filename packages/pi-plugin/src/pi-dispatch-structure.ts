interface MessageStructure {
	role: "user" | "assistant" | "toolResult";
	calls: string[];
	results: string[];
	timestamp?: number;
}

/** Transport-independent roles and ordered tool IDs, captured before text transforms. */
export interface PiPreparedStructure {
	messages: readonly MessageStructure[];
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
		}
	}
	return row;
}

export function piPreparedStructure(
	messages: readonly unknown[],
): PiPreparedStructure | undefined {
	if (!messages.length || messages.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	for (const message of messages) {
		const source = object(message);
		if (
			(source?.role === "bashExecution" ||
				source?.role === "pythonExecution") &&
			source.excludeFromContext === true
		)
			continue;
		const row = messageStructure(message);
		if (!row) return undefined;
		rows.push(row);
	}
	return { messages: rows };
}

function payloadStructure(payload: unknown): MessageStructure[] | undefined {
	const body = object(payload);
	if (!body) return undefined;
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
				(block) => object(block)?.type === "tool_result",
			);
			if (results.length) {
				// Anthropic packs a consecutive result run into one user message;
				// expand it back to the prepared array's roles and result IDs.
				for (const block of results) {
					if (typeof block.tool_use_id !== "string") return undefined;
					rows.push({
						role: "toolResult",
						calls: [],
						results: [block.tool_use_id],
					});
				}
				continue;
			}
		}
		const row = messageStructure(message);
		if (!row) return undefined;
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

/** Check the latest turn as well as every preceding role and ordered tool ID. */
export function piMatchesPreparedStructure(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
): boolean {
	try {
		const rows = payloadStructure(payload);
		if (!rows || !prepared || rows.length !== prepared.messages.length)
			return false;
		const body = payload as Record<string, unknown>;
		const anthropic =
			typeof body.system === "string" || Array.isArray(body.system);
		const responses = body.messages === undefined && Array.isArray(body.input);
		for (let i = 0; i < rows.length; i++) {
			const expected = prepared.messages[i];
			const actual = rows[i];
			if (
				actual.role !== expected.role ||
				actual.calls.length !== expected.calls.length ||
				actual.results.length !== expected.results.length ||
				(actual.timestamp !== undefined &&
					actual.timestamp !== expected.timestamp)
			)
				return false;
			for (let j = 0; j < actual.calls.length; j++)
				if (actual.calls[j] !== wireId(expected.calls[j], anthropic, responses))
					return false;
			for (let j = 0; j < actual.results.length; j++)
				if (
					actual.results[j] !==
					wireId(expected.results[j], anthropic, responses)
				)
					return false;
		}
		return true;
	} catch {
		return false;
	}
}
