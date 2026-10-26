import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lkgContentFields } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
} from "./__tests__/omp-log-files";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import { piExpandChainedRequest, piPreparedHistory } from "./pi-dispatch-chain";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext } from "./test-utils.test";

const parent = join(tmpdir(), "magic-context");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "omp-head-host-"));
const previous: Record<string, string | undefined> = {};
for (const key of [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"PI_CODING_AGENT_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
]) {
	previous[key] = process.env[key];
	const path = join(root, key);
	process.env[key] = path;
	mkdirSync(path, { recursive: true });
}
const require = createRequire(import.meta.url);
const definitions = [
	{ version: "18.12.3", agent: "omp-coding-agent-1812", ai: "omp-pi-ai-1812" },
	{
		version: "18.12.6",
		agent: "omp-coding-agent-18126",
		ai: "omp-pi-ai-18126",
	},
];
const aliases = definitions.flatMap(({ agent, ai }) => [agent, ai]);
await pinOmpLoggerFiles(root, aliases);
const hosts = await Promise.all(
	definitions.map(async (definition) => {
		const path = (alias: string) =>
			require.resolve(`${alias}/package.json`).slice(0, -12);
		expect(require(`${path(definition.agent)}package.json`).version).toBe(
			definition.version,
		);
		expect(require(`${path(definition.ai)}package.json`).version).toBe(
			definition.version,
		);
		return {
			...definition,
			agentRoot: path(definition.agent),
			messages: await import(
				`${path(definition.agent)}src/session/messages.ts`
			),
			Runner: (
				await import(
					`${path(definition.agent)}src/extensibility/extensions/runner.ts`
				)
			).ExtensionRunner,
			codex: (
				await import(
					`${path(definition.ai)}src/providers/openai-codex-responses.ts`
				)
			).buildTransformedCodexRequestBody,
		};
	}),
);
await exerciseOmpLoggerFiles(aliases);
const descriptors =
	process.platform === "linux"
		? execFileSync("lsof", ["-nP", "-p", String(process.pid)], {
				encoding: "utf8",
			})
		: "";
for (const line of descriptors.split("\n")) {
	if (/omp\..*\.log/.test(line)) {
		expect(line).toContain(root);
		console.log("isolated OMP host descriptor:", line);
	}
	expect(line).not.toMatch(/\/(?:context|store)\.db\b/);
}
afterAll(() => {
	__setPiHarnessKindForTesting(undefined);
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const model = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-5",
	input: ["text", "image"],
	compat: {},
	identity: { class: "gpt", model: "gpt-5" },
};
const user = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
const pair = (timestamp: number) => [
	user("<session-history>managed</session-history>", timestamp - 2),
	user(
		"<session-history-since>(no new content since last materialization)</session-history-since>",
		timestamp - 1,
	),
];
const call = {
	type: "function_call",
	call_id: "call_1",
	id: "fc_1",
	name: "read",
	arguments: "{}",
};
const assistant = {
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	timestamp: 1001,
	stopReason: "toolUse",
	responseId: "resp_1",
	content: [
		{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: {} },
	],
	providerPayload: {
		type: "openaiResponsesHistory",
		provider: model.provider,
		dt: true,
		items: [call],
	},
};
const result = {
	role: "toolResult",
	toolCallId: "call_1|fc_1",
	toolName: "read",
	timestamp: 1002,
	content: [{ type: "text", text: "file body" }],
};

function harness(host: (typeof hosts)[number]) {
	__setPiHarnessKindForTesting("omp");
	const session = `omp-head-${host.version}`;
	const handlers = new Map();
	const refusals: string[] = [];
	let aborts = 0;
	let prepared: unknown[] = [];
	const ctx = { ...fakeContext(session), model, abort: () => aborts++ };
	registerPiGuardedContext(
		{
			on: (name: string, fn: unknown) => handlers.set(name, [fn]),
			appendEntry: (_: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: prepared }) as never,
	);
	const runner = new host.Runner(
		[{ path: "managed", handlers }],
		{},
		root,
		{},
		{},
	);
	runner.createContext = () => ctx;
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const emit = async (name: string, event: unknown = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	return {
		refusals,
		get aborts() {
			return aborts;
		},
		async pass(messages: unknown[]) {
			prepared = structuredClone(messages);
			const returned = await runner.emitContext(messages);
			// This is the SDK transformContext order: emitContext, then steering wrap.
			return host.messages.convertToLlm(
				host.messages.wrapSteeringForModel(returned),
			);
		},
		async start() {
			await emit("agent_start");
		},
		async respond() {
			await runner.emitAssistantMessage(structuredClone(assistant));
		},
		send: (payload: unknown) =>
			runner.emitBeforeProviderRequest(payload, model),
		close: () => clearPiContextReceipt(session),
	};
}

for (const host of hosts) {
	test(`${host.version}: injected timestamps are chain-only identity; defer bytes and m0/m1 text stay identical`, async () => {
		const h = harness(host);
		try {
			const before = [...pair(100), user("read", 1000)];
			const after = [...pair(533), user("read", 1000)];
			const beforeBytes = JSON.stringify(before);
			const afterBytes = JSON.stringify(after);
			const body = (messages: unknown[]) =>
				host.codex(
					model,
					{ messages, systemPrompt: "system" },
					undefined,
					"fixture-cache",
				);
			const expectedWire = JSON.stringify(await body(before));
			expect(JSON.stringify(await body(after))).toBe(expectedWire);
			piPreparedHistory(before, model);
			piPreparedHistory(after, model);
			expect(JSON.stringify(before)).toBe(beforeBytes);
			expect(JSON.stringify(after)).toBe(afterBytes);
			expect(before.slice(0, 2).map((row) => row.content)).toEqual(
				after.slice(0, 2).map((row) => row.content),
			);
			expect(JSON.stringify(await body(before))).toBe(expectedWire);
			expect(JSON.stringify(await body(after))).toBe(expectedWire);
			await h.start();
			const first = await body(await h.pass(before));
			await h.send(first);
			await h.respond();
			const next = await body(await h.pass([...after, assistant, result]));
			const delta = [
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "file body",
				},
			];
			expect(next.input.at(-1)).toEqual(delta[0]);
			// Recreate the original prepared-history snapshots, which included every
			// timestamp, while retaining the real host's encoded provider request.
			const baseline = (messages: unknown[]) => {
				const prepared = piPreparedHistory(messages, model);
				if (!prepared) throw new Error("fixture history unavailable");
				return {
					...prepared,
					snapshots: messages.map((message) => {
						const fields = lkgContentFields(message);
						if (!fields) throw new Error("fixture snapshot unavailable");
						return { id: "", fields };
					}),
				};
			};
			expect(
				piExpandChainedRequest(
					{ input: delta },
					{ previousResponseId: "resp_1", delta },
					{
						input: first.input,
						prepared: baseline(before),
						responseId: "resp_1",
						responseItems: [call],
					},
					baseline([...after, assistant, result]),
					{ current: {}, resend: false },
				),
			).toEqual({
				refusal:
					"prepared history does not extend the previous managed request",
			});
			await h.send({
				...first,
				type: "response.create",
				previous_response_id: "resp_1",
				input: delta,
			});
			expect(h.refusals).toEqual([]);
			expect(h.aborts).toBe(0);
		} finally {
			h.close();
		}
	});
}
