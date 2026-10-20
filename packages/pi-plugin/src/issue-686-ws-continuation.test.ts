import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

// Oh My Pi 18.12.x with WebSockets on (providers.openaiWebsockets) sends a
// Codex continuation as only the items appended after the previous response,
// naming that response in previous_response_id. It builds that frame before
// emitting before_provider_request (@oh-my-pi/pi-ai 18.12.3,
// src/providers/openai-codex-responses.ts:3864-3880 and 1955-1962), so the
// frame holds none of the managed history head. These shapes follow that
// provider: response IDs and native output items come from response.completed
// (2739-2785) and reach extensions through the awaited assistant_message event.
const session = "issue-686-ws-continuation";
const model = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-6.1-sol",
};
const own = { api: model.api, provider: model.provider, model: model.id };
const signature = (id: string, phase: string) =>
	JSON.stringify({ v: 1, id, phase });

const HEAD = "<session-history>managed</session-history>";
const head = userMessage(HEAD, 1);
const user = (text: string, timestamp: number) => userMessage(text, timestamp);
const userItem = (text: string) => ({
	role: "user",
	content: [{ type: "input_text", text }],
});
const reasoningItem = (id: string) => ({
	type: "reasoning",
	id,
	summary: [],
	encrypted_content: `opaque-${id}`,
});
const messageItem = (text: string, id: string, phase: string) => ({
	type: "message",
	role: "assistant",
	id,
	phase,
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});
const callItem = (callId: string) => ({
	type: "function_call",
	id: `fc_${callId}`,
	call_id: callId,
	name: "read",
	arguments: "{}",
});
const outputItem = (callId: string, output: string) => ({
	type: "function_call_output",
	call_id: callId,
	output,
});

/**
 * One completed Codex response. `host` is the message as Oh My Pi finalizes
 * it (assistant_message); `prepared` is the same message after Magic Context
 * tagged its text for the next pass.
 */
function response(options: {
	id: string;
	text: string;
	tag: number;
	timestamp: number;
	call?: string;
	stopReason?: string;
}) {
	const msgId = `msg_${options.id}`;
	const phase = options.call ? "commentary" : "final_answer";
	const items = [
		reasoningItem(`rs_${options.id}`),
		messageItem(options.text, msgId, phase),
		...(options.call ? [callItem(options.call)] : []),
	];
	const build = (text: string) => ({
		role: "assistant",
		...own,
		stopReason: options.stopReason ?? (options.call ? "toolUse" : "stop"),
		responseId: options.id,
		timestamp: options.timestamp,
		content: [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify(reasoningItem(`rs_${options.id}`)),
				summary: false,
			},
			{ type: "text", text, textSignature: signature(msgId, phase) },
			...(options.call
				? [
						{
							type: "toolCall",
							id: `${options.call}|fc_${options.call}`,
							name: "read",
							arguments: {},
						},
					]
				: []),
		],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items,
		},
	});
	return {
		host: build(options.text),
		prepared: build(`§${options.tag}§ ${options.text}`),
		// Replay-sanitized items as OMP's full requests carry them.
		wire: items.map(({ id: _id, status: _status, ...item }) => item),
	};
}
const toolResult = (call: string, text: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId: `${call}|fc_${call}`,
	toolName: "read",
	content: [{ type: "text", text }],
	timestamp,
});
const todoReminder = (timestamp: number) => ({
	role: "developer",
	content: [
		{
			type: "text",
			text: "<system-reminder>\nYou stopped with 1 incomplete todo item(s):\n- Work\n  - finish\n</system-reminder>",
		},
	],
	attribution: "agent",
	timestamp,
});
const developerItem = (message: ReturnType<typeof todoReminder>) => ({
	role: "developer",
	content: [{ type: "input_text", text: message.content[0].text }],
});
const full = (input: unknown[]) => ({
	type: "response.create",
	model: model.id,
	instructions: "system",
	input,
	stream: true,
});
const chained = (previous: string, input: unknown[]) => ({
	...full(input),
	previous_response_id: previous,
});

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let aborts = 0;
	let prepared: unknown[] = [];
	let started = false;
	const ctx = { ...fakeContext(session), model, abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone(prepared) }) as never,
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing handler ${name}`);
		return handler(event, ctx);
	};
	return {
		refusals,
		get aborts() {
			return aborts;
		},
		/** One context pass; `newRun` ends the previous run first, as continuations do. */
		async pass(messages: unknown[], newRun = false) {
			if (newRun) emit("agent_end", { messages: [] });
			if (newRun || !started) emit("agent_start");
			started = true;
			prepared = messages;
			await emit("context", { messages: [user("input", 99)] });
		},
		send(body: unknown) {
			emit("before_provider_request", { payload: structuredClone(body) });
		},
		respond(message: unknown) {
			emit("assistant_message", { message: structuredClone(message) });
		},
	};
}

afterEach(() => {
	clearPiContextReceipt(session);
	__setPiHarnessKindForTesting(undefined);
});

const u1 = user("§1§ read the file", 2);
const a1 = response({
	id: "resp_1",
	text: "checking the file",
	tag: 2,
	timestamp: 3,
	call: "call_1",
});
const r1 = toolResult("call_1", "§3§ file body", 4);
const m1 = [head, u1];
const w1 = [userItem(HEAD), userItem("§1§ read the file")];
const m2 = [...m1, a1.prepared, r1];

/** A full first request, its tool-call response, then the pass that continues it. */
async function toolTurn() {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	await h.pass(m2);
	return h;
}

test("issue 686 WebSocket continuation: a full request then a tool-result delta admits", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: a final answer then the automatic todo-reminder continuation admits", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	const a2 = response({ id: "resp_2", text: "done", tag: 4, timestamp: 5 });
	h.respond(a2.host);
	// OMP appends a developer reminder and schedules a new run
	// (pi-coding-agent session/todo-tracker.ts:288-318).
	const reminder = todoReminder(6);
	await h.pass([...m2, a2.prepared, reminder], true);
	h.send(chained("resp_2", [developerItem(reminder)]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: two consecutive user turns on a reused transport admit", async () => {
	const h = harness();
	const answer1 = response({ id: "resp_1", text: "hi", tag: 2, timestamp: 3 });
	const answer2 = response({ id: "resp_2", text: "ok", tag: 4, timestamp: 5 });
	const u2 = user("§3§ second turn", 4);
	const u3 = user("§5§ third turn", 6);
	await h.pass(m1);
	h.send(full(w1));
	h.respond(answer1.host);
	await h.pass([...m1, answer1.prepared, u2], true);
	h.send(chained("resp_1", [userItem("§3§ second turn")]));
	h.respond(answer2.host);
	await h.pass([...m1, answer1.prepared, u2, answer2.prepared, u3], true);
	h.send(chained("resp_2", [userItem("§5§ third turn")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: a provider retry of the admitted continuation admits", async () => {
	const h = await toolTurn();
	const frame = chained("resp_1", [outputItem("call_1", "§3§ file body")]);
	h.send(frame);
	h.send(frame);
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation: a full SSE fallback after the continuation in the same pass admits", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	h.send(full([...w1, ...a1.wire, outputItem("call_1", "§3§ file body")]));
	expect(h.refusals).toEqual([]);
	expect(h.aborts).toBe(0);
});

test("issue 686 WebSocket continuation guard: a history mutation breaks the chain", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	// The earlier prompt changed after the previous request; the provider's
	// stored context no longer matches what this pass prepared.
	await h.pass([head, user("§1§ read the other file", 2), a1.prepared, r1]);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"prepared history does not extend the previous managed request",
	);
});

test("issue 686 WebSocket continuation guard: a stale previous_response_id refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	const a2 = response({ id: "resp_2", text: "done", tag: 4, timestamp: 5 });
	h.respond(a2.host);
	const reminder = todoReminder(6);
	await h.pass([...m2, a2.prepared, reminder], true);
	h.send(chained("resp_1", [developerItem(reminder)]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"continuation does not follow the last managed request's response",
	);
});

test("issue 686 WebSocket continuation guard: a wrong previous_response_id refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_forged", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"continuation does not follow the last managed request's response",
	);
});

test("issue 686 WebSocket continuation guard: a fresh process without the recorded response refuses", async () => {
	const h = harness();
	await h.pass(m2);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"no completed managed response is recorded for this continuation",
	);
});

test("issue 686 WebSocket continuation guard: an unknown prefix before the delta refuses", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(a1.host);
	// The prepared history continues from some other response, not the one the
	// provider holds for this chain.
	const other = response({
		id: "resp_other",
		text: "checking the file",
		tag: 2,
		timestamp: 3,
		call: "call_1",
	});
	await h.pass([...m1, other.prepared, r1]);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"prepared history does not continue from the previous managed response",
	);
});

test("issue 686 WebSocket continuation guard: a delta answering another call refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_other", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain("prepared turn structure");
	expect(h.refusals[0]).toContain("comparison=result id");
});

test("issue 686 WebSocket continuation guard: a delta with an unprepared extra item refuses", async () => {
	const h = await toolTurn();
	h.send(
		chained("resp_1", [
			outputItem("call_1", "§3§ file body"),
			userItem("UNMANAGED appended prompt"),
		]),
	);
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain("prepared turn structure");
	expect(h.refusals[0]).toContain("comparison=count");
});

test("issue 686 WebSocket continuation guard: an altered resend of the admitted continuation refuses", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	h.send(chained("resp_1", [outputItem("call_1", "§3§ altered body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"provider request does not match this pass's managed dispatch",
	);
});

test("issue 686 WebSocket continuation guard: a resend naming another response refuses", async () => {
	const h = await toolTurn();
	const tail = [outputItem("call_1", "§3§ file body")];
	h.send(chained("resp_1", tail));
	h.send(chained("resp_0", tail));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"continuation does not follow the last managed request's response",
	);
});

test("issue 686 WebSocket continuation guard: an errored response is not a continuation point", async () => {
	const h = harness();
	await h.pass(m1);
	h.send(full(w1));
	h.respond(
		response({
			id: "resp_1",
			text: "checking the file",
			tag: 2,
			timestamp: 3,
			call: "call_1",
			stopReason: "error",
		}).host,
	);
	await h.pass(m2);
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"no completed managed response is recorded for this continuation",
	);
});

test("issue 686 WebSocket continuation guard: after an aborted response the earlier response is stale", async () => {
	const h = await toolTurn();
	h.send(chained("resp_1", [outputItem("call_1", "§3§ file body")]));
	// The stream was aborted: Oh My Pi emits no assistant_message
	// (agent-core agent-loop.ts:2800-2840), so that request has no response.
	const u2 = user("§4§ next prompt", 5);
	await h.pass([...m2, u2], true);
	h.send(chained("resp_1", [userItem("§4§ next prompt")]));
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain(
		"the last managed request has no completed response",
	);
});

test("issue 686 WebSocket continuation parity: a delta gets the same tail checks as the full request", async () => {
	// The fence compares structure (roles, call and result IDs, assistant text),
	// not user or tool-result text, because Oh My Pi legitimately rewrites that
	// text after the context hook (secret obfuscation, Harmony escaping). A
	// continuation must be judged exactly like the full request it stands for.
	const tails = [
		{ output: outputItem("call_1", "§3§ edited body"), admits: true },
		{ output: outputItem("call_2", "§3§ file body"), admits: false },
	];
	for (const tail of tails) {
		const viaFull = await toolTurn();
		viaFull.send(full([...w1, ...a1.wire, tail.output]));
		clearPiContextReceipt(session);
		const viaDelta = await toolTurn();
		viaDelta.send(chained("resp_1", [tail.output]));
		clearPiContextReceipt(session);
		expect(viaFull.aborts).toBe(tail.admits ? 0 : 1);
		expect(viaDelta.aborts).toBe(viaFull.aborts);
	}
});
