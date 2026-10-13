import { afterEach, expect, test } from "bun:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	assistantMessage,
	assistantToolCall,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

type Body = Record<string, unknown>;
const sessions: string[] = [];
const input = [
	userMessage("first goal", 10),
	assistantMessage("progress", 20),
	userMessage("continue goal", 30),
];

function harness(messages = input) {
	__setPiHarnessKindForTesting("omp");
	const id = `issue-673-review-${sessions.length}`;
	sessions.push(id);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let current = structuredClone(messages);
	let managed: ContextEvent["messages"] = [];
	let aborts = 0;
	const refusals: string[] = [];
	const ctx = {
		...fakeContext(id),
		isIdle: () => false,
		sessionManager: {
			getSessionId: () => id,
			getBranch: () =>
				current.map((message, index) => ({
					type: "message",
					id: `entry-${index}`,
					message,
				})),
		},
		abort: () => aborts++,
	};
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event) => {
			event.messages.unshift(userMessage("<memory>managed</memory>", 1));
			managed = structuredClone(event.messages);
			return { messages: event.messages };
		},
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	return {
		emit,
		refusals,
		get aborts() {
			return aborts;
		},
		set native(value: ContextEvent["messages"]) {
			current = value;
		},
		payload: (): Body => ({ messages: structuredClone(managed) }),
		dispatch(body: Body) {
			emit("before_provider_request", { payload: body });
		},
		async prepare(body?: (managed: Body) => Body) {
			emit("agent_start");
			emit("agent_start");
			await emit("context", { messages: structuredClone(messages) });
			const first = body ? body(this.payload()) : this.payload();
			this.dispatch(first);
			expect(refusals).toEqual([]);
			return first;
		},
		retain() {
			emit("agent_end", { messages: structuredClone(messages.slice(0, 2)) });
		},
	};
}

afterEach(() => {
	for (const id of sessions) clearPiContextReceipt(id);
	__setPiHarnessKindForTesting(undefined);
});

test("review safety: retained Responses instructions and conversation are bound", async () => {
	for (const field of ["instructions", "conversation"]) {
		const h = harness();
		const body = await h.prepare((managed) => ({
			input: managed.messages,
			instructions: "managed system",
			conversation: "conv-prepared",
		}));
		h.retain();
		h.dispatch({ ...body, [field]: "stale conversation" });
		expect(h.aborts).toBe(1);
		expect(h.refusals[0]).toContain("does not match");
	}
});

test("review identity: nested cache metadata and reasoning items are compared", async () => {
	for (const change of ["cache", "metadata", "reasoning"]) {
		const h = harness();
		const body = await h.prepare((managed) => ({
			input: [
				...(managed.messages as unknown[]),
				{ type: "reasoning", id: "rs_1", encrypted_content: "prepared" },
			],
			instructions: "managed system",
		}));
		h.retain();
		const retry = structuredClone(body);
		const items = retry.input as Body[];
		if (change === "reasoning")
			items[items.length - 1].encrypted_content = "stale";
		else items[0][change === "cache" ? "cache_control" : "metadata"] = "new";
		h.dispatch(retry);
		expect(h.aborts).toBe(1);
	}
});

test("review compatibility: top-level controls and tool ordering can change", async () => {
	const h = harness();
	const body = await h.prepare((managed) => ({
		...managed,
		tools: [{ name: "one" }, { name: "two" }],
		metadata: { user_id: "before" },
	}));
	h.retain();
	h.dispatch({
		...body,
		tools: [{ name: "two" }, { name: "one" }],
		metadata: { user_id: "after" },
		cache_control: { type: "ephemeral" },
		model: "another-model",
	});
	expect(h.aborts).toBe(0);
});

test("review compatibility: actual tool-loop followup needs no new start", async () => {
	const h = harness();
	await h.prepare();
	h.retain();
	const next = [
		...input,
		assistantToolCall("tool-1", "Read", { path: "example" }, 40),
		toolResultMessage("tool-1", "result", 50),
	];
	h.native = structuredClone(next);
	await h.emit("context", { messages: structuredClone(next) });
	h.dispatch(h.payload());
	expect(h.aborts).toBe(0);
	expect(h.refusals).toEqual([]);
});

// Witnesses record current fence behavior, including defects, not desired contracts.
test("review witness: dropping Anthropic cache breakpoints refuses unchanged text", async () => {
	const h = harness();
	const body = await h.prepare((managed) => ({
		...managed,
		system: [
			{
				type: "text",
				text: "unchanged managed system",
				cache_control: { type: "ephemeral" },
			},
		],
	}));
	h.retain();
	const retry = structuredClone(body);
	delete (retry.system as Body[])[0].cache_control;
	h.dispatch(retry);
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain("does not match");
});

test("review witness: retained Responses receipt ignores a changed prompt template", async () => {
	const h = harness();
	const body = await h.prepare((managed) => ({
		input: (managed.messages as Body[]).map((message) => ({
			role: message.role,
			content:
				typeof message.content === "string"
					? message.content
					: (message.content as { text?: string }[])
							.map((part) => part.text ?? "")
							.join("\n"),
		})),
		instructions: "managed system",
		prompt: { id: "pmpt_first", variables: { transcript: "prepared" } },
	}));
	h.retain();
	h.dispatch({
		...body,
		prompt: { id: "pmpt_other", variables: { transcript: "RAW_UNPREPARED" } },
	});
	expect(h.aborts).toBe(0);
	expect(h.refusals).toEqual([]);
	h.dispatch({
		...body,
		input: [{ role: "user", content: "changed raw input" }],
	});
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain("does not match");
});

test("review witness: retained receipt accepts a hybrid unknown history representation", async () => {
	const h = harness();
	const body = await h.prepare();
	h.retain();
	h.dispatch({
		...body,
		contents: [{ role: "user", parts: [{ text: "RAW_UNPREPARED" }] }],
		systemInstruction: { parts: [{ text: "different system" }] },
	});
	expect(h.aborts).toBe(0);
});

test("review witness: retained receipt is not rechecked after native branch replacement", async () => {
	const h = harness();
	const body = await h.prepare();
	h.retain();
	h.native = [userMessage("compacted replacement", 100)];
	h.dispatch(body);
	expect(h.aborts).toBe(0);
});

test("review witness: a completed overlapping pass authorizes the prior raw request", async () => {
	const h = harness();
	await h.prepare();
	const next = [...input, userMessage("different next run", 40)];
	h.native = structuredClone(next);
	h.emit("agent_start");
	await h.emit("context", { messages: structuredClone(next) });
	h.dispatch({ messages: structuredClone(input) });
	expect(h.aborts).toBe(0);
	expect(h.refusals).toEqual([]);
});

test("review witness: equivalent message object key order is refused", async () => {
	const h = harness();
	const body = await h.prepare();
	h.retain();
	const retry = structuredClone(body);
	retry.messages = (retry.messages as Body[]).map((message) =>
		Object.fromEntries(Object.entries(message).reverse()),
	);
	h.dispatch(retry);
	expect(h.aborts).toBe(1);
	expect(h.refusals[0]).toContain("does not match");
});

test.skipIf(!process.env.MC673_REVIEW_BENCH)(
	"review cost: full dispatch identity for 1000 multi-megabyte messages",
	async () => {
		const large = Array.from({ length: 1000 }, (_, index) =>
			userMessage(`${index}: ${"review history ".repeat(350)}`, index + 10),
		);
		const h = harness(large);
		h.emit("agent_start");
		h.emit("agent_start");
		const contextStart = performance.now();
		await h.emit("context", { messages: structuredClone(large) });
		const context_ms = performance.now() - contextStart;
		const body = h.payload();
		const firstStart = performance.now();
		h.dispatch(body);
		const first_dispatch_ms = performance.now() - firstStart;
		const bytes = Buffer.byteLength(JSON.stringify(body));
		const measure = (action: () => void, count = 100) => {
			for (let i = 0; i < 10; i++) action();
			const times = Array.from({ length: count }, () => {
				const start = performance.now();
				action();
				return performance.now() - start;
			}).sort((a, b) => a - b);
			return {
				count,
				median_ms: times[Math.floor(count / 2)],
				p95_ms: times[Math.floor(count * 0.95)],
				max_ms: times.at(-1),
			};
		};
		const ordinary = measure(() => h.dispatch(body));
		const endStart = performance.now();
		h.retain();
		const end_ms = performance.now() - endStart;
		const retained_same_objects = measure(() => h.dispatch(body));
		const copies = Array.from({ length: 20 }, () =>
			JSON.parse(JSON.stringify(body)),
		);
		let copyIndex = 0;
		const retained_distinct_strings = measure(() =>
			h.dispatch(copies[copyIndex++ % copies.length]),
		);
		const stringify = measure(() => {
			JSON.stringify(body);
		});
		console.log(
			JSON.stringify({
				bytes,
				messages: large.length,
				context_ms,
				first_dispatch_ms,
				ordinary,
				end_ms,
				retained_same_objects,
				retained_distinct_strings,
				stringify,
			}),
		);
		expect(h.aborts).toBe(0);
	},
);
