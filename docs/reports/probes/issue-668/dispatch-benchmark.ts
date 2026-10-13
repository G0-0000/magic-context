import { strict as assert } from "node:assert";
import * as after from "../../../../packages/pi-plugin/src/pi-context-refusal";
import { __setPiHarnessKindForTesting } from "../../../../packages/pi-plugin/src/pi-harness-kind";

// Compare with a copy of pi-context-refusal from before the serialization change.
// Place the copy beside the original so its imports resolve to the same modules;
// remove it after benchmarking because production uses the original module.
const before = await import(new URL("../../../../packages/pi-plugin/src/issue-668-benchmark-before.ts", import.meta.url).href) as typeof after;
const warmup = 100;
const iterations = 1000;
const fields = {
	model: "benchmark-model",
	system: [{ type: "text", text: "Ordinary conversation; not an advisor or auto-learn request." }],
	tools: [],
	messages: Array.from({ length: 100 }, (_, index) => ({
		role: index % 2 ? "assistant" : "user",
		content: "benchmark conversation content ".repeat(2000).slice(0, 52_428),
	})),
};
let serializations = 0;
const payload = {
	...fields,
	toJSON() {
		serializations++;
		return fields;
	},
};
const bytes = Buffer.byteLength(JSON.stringify(payload));
assert(bytes > 5_000_000 && bytes < 5_500_000);

async function dispatchFor(guard: typeof after, sessionId: string, nonceCount: number) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	guard.registerPiGuardedContext({
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		appendEntry: () => { throw new Error("unexpected benchmark refusal"); },
	} as never, async event => {
		if (event.messages[0]?.content === "superseded") throw new guard.PiContextSupersededError("replaced pass");
		return { messages: event.messages };
	});
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		abort: () => { throw new Error("unexpected benchmark abort"); },
		ui: { notify: () => {} },
	};
	const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	for (let index = 0; index < nonceCount; index++) {
		const messages = [{ role: "user", content: "superseded", timestamp: index }];
		await assert.rejects(Promise.resolve(emit("context", { messages })), guard.PiContextSupersededError);
		assert.equal(messages.length, 2);
	}
	await emit("context", { messages: [{ role: "user", content: "managed", timestamp: 100 }] });
	return () => emit("before_provider_request", { payload });
}

function measure(name: string, dispatch: () => unknown, expectSerialization: boolean) {
	const callsBefore = serializations;
	for (let index = 0; index < warmup; index++) dispatch();
	const samples: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const start = performance.now();
		dispatch();
		samples.push(performance.now() - start);
	}
	const serializationCalls = serializations - callsBefore;
	assert.equal(serializationCalls, expectSerialization ? warmup + iterations : 0, name);
	samples.sort((a, b) => a - b);
	return {
		name, nonceCount: name.endsWith("32-nonces") ? 32 : 0,
		serializationCalls,
		meanMs: samples.reduce((sum, sample) => sum + sample, 0) / iterations,
		medianMs: samples[Math.floor(iterations * 0.5)],
		p95Ms: samples[Math.floor(iterations * 0.95)],
	};
}

__setPiHarnessKindForTesting("omp");
const results = [];
try {
	for (const [name, guard, count, serialize] of [
		["before-no-nonces", before, 0, true],
		["after-no-nonces", after, 0, false],
		["before-32-nonces", before, 32, true],
		["after-32-nonces", after, 32, true],
	] as const) {
		const dispatch = await dispatchFor(guard, name, count);
		results.push(measure(name, dispatch, serialize));
		guard.clearPiContextReceipt(name);
	}
} finally {
	__setPiHarnessKindForTesting(undefined);
}
console.log(JSON.stringify({
	bun: Bun.version, platform: process.platform, arch: process.arch,
	baselineRevision: "850a28cbdef23a69b8ca8276cdff56ed7734f86f",
	payloadBytes: bytes, warmup, iterations, timing: "synchronous registered before_provider_request hook; milliseconds per request",
	results,
}, null, 2));
console.error(`Bun ${Bun.version}: 4 dispatch cases, ${4 * (warmup + iterations)} requests; all serialization-count controls passed`);
