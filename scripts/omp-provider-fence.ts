#!/usr/bin/env bun
// Exercise native OMP provider serializers with Magic Context and a loopback mock.
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = realpathSync(process.env.MC683_RUN_ROOT!);
if (!root.includes("/magic-context/issue-673/"))
	throw new Error("isolated probe root required");
const isolated = {
	HOME: root,
	CFFIXED_USER_HOME: root,
	TMPDIR: root,
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_RUNTIME_DIR: join(root, "runtime"),
	PI_CODING_AGENT_DIR: join(root, ".omp/agent"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "data/cortexkit/magic-context"),
};
for (const [key, value] of Object.entries(isolated)) {
	if (process.env[key] !== value)
		throw new Error(`${key} was not isolated before startup`);
	mkdirSync(value, { recursive: true });
}
const host = join(
	process.env.MC683_HOST!,
	"node_modules/@oh-my-pi/pi-coding-agent",
);
const version = JSON.parse(
	readFileSync(join(host, "package.json"), "utf8"),
).version;
if (!["18.10.4", "18.11.0"].includes(version))
	throw new Error(`expected OMP 18.10.4 or 18.11.0, got ${version}`);
const selector = process.argv[2]!;
const api = selector === "cline-pass" ? "openai-completions" : selector;
const mode = process.argv[3] ?? "managed";
if (!["managed", "raw", "managed-then-raw", "drop-commentary"].includes(mode))
	throw new Error("unknown mode");
const historyCase = process.argv[4] ?? "fresh";
if (
	![
		"fresh",
		"tool-arc",
		"resume",
		"user-image",
		"tool-image",
		"thinking",
		"consecutive-users",
		"empty-assistant",
		"aborted-assistant",
		"removed-tool",
		"orphan-result",
		"missing-result",
		"interrupted-tool",
		"summary",
		"mixed",
		"materialized",
		"responses-history",
	].includes(historyCase)
)
	throw new Error("unknown history case");
const audit = (value: object) =>
	appendFileSync(
		join(root, "audit.jsonl"),
		JSON.stringify({ at: Date.now(), ...value }) + "\n",
	);
let wires = 0;
const mock = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (
			request.method !== "POST" ||
			!/(?:\/messages$|\/chat\/completions$|\/responses$|streamGenerateContent|converse-stream|\/api\/chat$)/.test(
				new URL(request.url).pathname,
			)
		)
			return Response.json({ data: [] });
		wires++;
		audit({ phase: "wire", url: request.url, body: await request.text() });
		if (historyCase === "mixed") {
			const chunk = (delta: object, finish_reason: string | null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-history683", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })}\n\n`;
			return new Response(
				chunk(
					{ role: "assistant", content: "HISTORY683 provider reply" },
					null,
				) +
					chunk({}, "stop") +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		}
		// A terminal mock error stops inference after transport admission. The probe
		// checks the fence, not response parsing or the model's answer.
		return Response.json(
			{ error: { type: "mock_end", message: "probe transport reached" } },
			{ status: 400 },
		);
	},
});
const baseUrl = `http://127.0.0.1:${mock.port}/v1`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
	);
	// Some native adapters have fixed endpoints. Redirect those to the same mock;
	// no network request in this probe is permitted to reach a real provider.
	if (url.hostname !== "127.0.0.1") {
		audit({ phase: "redirect", url: url.href });
		input =
			input instanceof Request
				? new Request(`${baseUrl}${url.pathname}`, input)
				: `${baseUrl}${url.pathname}`;
	}
	return nativeFetch(input, init);
}) as typeof fetch;
Object.assign(process.env, {
	AWS_ACCESS_KEY_ID: "probe-key",
	AWS_SECRET_ACCESS_KEY: "probe-secret",
	AWS_REGION: "us-east-1",
	AWS_EC2_METADATA_DISABLED: "true",
	GOOGLE_CLOUD_PROJECT: "probe-project",
	GOOGLE_CLOUD_LOCATION: "us-central1",
	GOOGLE_CLOUD_ACCESS_TOKEN: "probe-token",
	GOOGLE_APPLICATION_CREDENTIALS: join(root, "no-credentials.json"),
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_NO_TITLE: "1",
	MC_E2E_KEEP: "1",
});
writeFileSync(
	join(isolated.PI_CODING_AGENT_DIR, "config.yml"),
	JSON.stringify({
		defaultProvider: "mock",
		defaultModel: "mock-model",
		enabledModels: ["mock/mock-model"],
		tools: { xdev: false, intentTracing: false },
		compaction: { enabled: false },
		advisor: { enabled: false },
		autolearn: { enabled: false },
		retry: { enabled: false },
		secrets: { enabled: false },
		snapcompact: { systemPrompt: "none", toolResults: false },
		quietStartup: true,
		enableInstallTelemetry: false,
		providers: { openaiWebsockets: "off" },
	}),
);
writeFileSync(
	join(isolated.PI_CODING_AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api,
				baseUrl,
				apiKey:
					api === "google-gemini-cli"
						? JSON.stringify({
								token: "probe-token",
								projectId: "probe-project",
							})
						: "probe-token",
				models: [
					{
						id: "mock-model",
						name: "Mock Model",
						input: ["text"],
						contextWindow: 1000000,
						maxTokens: 8192,
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
mkdirSync(join(root, "config/cortexkit"), { recursive: true });
writeFileSync(
	join(root, "config/cortexkit/magic-context.jsonc"),
	JSON.stringify({
		enabled: true,
		memory: { enabled: false },
		embedding: { provider: "off" },
		dreamer: { disable: true },
	}),
);
const plugin =
	process.env.MC683_PLUGIN ??
	resolve(import.meta.dir, "../packages/pi-plugin/dist/index.js");
const probe = join(root, "probe.mjs");
writeFileSync(
	probe,
	`
import magic from ${JSON.stringify(plugin)};
import {appendFileSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {appendCompartments} from ${JSON.stringify(resolve(import.meta.dir, "../packages/plugin/src/features/magic-context/compartment-storage.ts"))};
import {piPreparedStructure} from ${JSON.stringify(resolve(import.meta.dir, "../packages/pi-plugin/src/pi-dispatch-structure.ts"))};
const log = value => appendFileSync(${JSON.stringify(join(root, "hooks.jsonl"))},JSON.stringify({at:Date.now(),...value})+'\\n');
export default async pi => {
  let seeded=false;
  pi.on('context',(event,ctx)=>{
    if(${JSON.stringify(historyCase)}!=='materialized' || seeded) return;
    seeded=true;
    const first=ctx.sessionManager.getBranch().find(entry=>entry.type==='message');
    if(!first) throw new Error('materialization probe requires persisted history');
    const db=new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR+'/context.db');
    try {appendCompartments(db,ctx.sessionManager.getSessionId(),[{sequence:0,startMessage:1,endMessage:1,startMessageId:first.id,endMessageId:first.id,title:'Real compartment 686',content:'U: prior turn\\nCOMPARTMENT686_BODY'}]);}
    finally {db.close();}
  });
  const proxy = new Proxy(pi,{get(target,key){
    if(key==='on') return (name,handler)=>target.on(name,async(event,ctx)=>{
      const raw=name==='context'?structuredClone(event.messages):undefined;
      if(name==='before_provider_request' && ${JSON.stringify(mode)}==='drop-commentary') {
        const input=event.payload?.input;
        const index=input?.findIndex(item=>item.role==='assistant' && item.content?.some(part=>part.type==='output_text' && part.text.includes('HISTORY686 signed commentary')));
        if(!Array.isArray(input) || index<0) throw new Error('commentary drop did not reach signed wire text');
        input.splice(index,1);
        log({phase:'dropped-commentary',index});
      }
      if(['context','before_provider_request','agent_start','agent_end'].includes(name)) log({phase:name,messages:event.messages,payload:event.payload});
      const wrapped=Object.defineProperties(Object.create(ctx),{
        abort:{value:()=>{log({phase:'abort',hook:name});return ctx.abort();}},
      });
      const result=await handler(event,wrapped);
      if(name==='context') {
        log({phase:'prepared',messages:result?.messages,structure:piPreparedStructure(result?.messages??[],ctx.model)});
        if(${JSON.stringify(historyCase)}==='materialized' && result?.messages) {
          const db=new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR+'/context.db',{readonly:true});
          try {log({phase:'materialized-proof',leadingRoles:result.messages.map(message=>message.role),rows:db.query('SELECT cached_m0_bytes,cached_m1_bytes FROM session_meta WHERE session_id=?').all(ctx.sessionManager.getSessionId()).map(row=>({m0:new TextDecoder().decode(row.cached_m0_bytes),m1:new TextDecoder().decode(row.cached_m1_bytes)}))});}
          finally {db.close();}
        }
        if(${JSON.stringify(mode)}==='raw' || globalThis.__mc683Raw) return {messages:raw};
      }
      return result;
    });
    if(key==='appendEntry') return (type,data)=>{log({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await magic(proxy);
};
`,
);
const { prepareContextDatabase } = await import(
	"../packages/e2e-tests/src/prepare-context-db"
);
prepareContextDatabase(isolated.XDG_DATA_HOME);
process.title = "omp";
const { createAgentSession } = await import(join(host, "src/sdk.ts"));
const { initializeExtensions } = await import(
	join(host, "src/modes/runtime-init.ts")
);
const catalog = await import(
	join(
		process.env.MC683_HOST!,
		"node_modules/@oh-my-pi/pi-catalog/src/index.ts",
	)
);
const templates = catalog
	.getBundledProviders()
	.flatMap((provider: any) => catalog.getBundledModels(provider));
const template =
	selector === "cline-pass"
		? templates.find(
				(model: any) =>
					model.provider === "cline-pass" &&
					model.name === "Muse Spark 1.3 (C) (free)",
			)
		: templates.find((model: any) => model.api === api);
if (!template) throw new Error(`no bundled model for ${selector}`);
const model = { ...template, baseUrl, preferWebsockets: false };
const apiKey =
	api === "google-gemini-cli"
		? JSON.stringify({ token: "probe-token", projectId: "probe-project" })
		: "probe-token";
writeFileSync(
	join(isolated.PI_CODING_AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			[model.provider]: { baseUrl, apiKey },
		},
	}),
);
audit({ phase: "catalog-model", selector, model });
let session: any;
let interruptedCall: unknown;
try {
	const { SessionManager } = await import(
		join(host, "src/session/session-manager.ts")
	);
	let historyManager: any;
	if (historyCase !== "fresh") {
		const stamp = Date.now() - 10000;
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=";
		const user = (text: string, timestamp: number) => ({
			role: "user",
			content: [{ type: "text", text }],
			timestamp,
		});
		const assistant = (
			content: unknown[],
			timestamp: number,
			stopReason = "stop",
		) => ({
			role: "assistant",
			content,
			timestamp,
			stopReason,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const toolName =
			historyCase === "removed-tool" ? "legacy_tool_removed_683" : "Read";
		const call = assistant(
			[
				{
					type: "toolCall",
					id: "history_call_683",
					name: toolName,
					arguments: { path: "seed.txt" },
				},
			],
			stamp + 1,
			"toolUse",
		);
		const result = {
			role: "toolResult",
			toolCallId: "history_call_683",
			toolName,
			content: [{ type: "text", text: "HISTORY683 tool output" }] as unknown[],
			isError: false,
			timestamp: stamp + 2,
		};
		const reply = assistant(
			[{ type: "text", text: "HISTORY683 previous reply" }],
			stamp + 3,
		);
		let history: any[];
		switch (historyCase) {
			case "responses-history": {
				const signed = (text: string, id: string, timestamp: number) => ({
					...assistant(
						[
							{
								type: "text",
								text,
								textSignature: JSON.stringify({
									v: 1,
									id,
									phase: "commentary",
								}),
							},
						],
						timestamp,
					),
					api: "openai-responses",
				});
				const cached = signed(
					"HISTORY686 cached commentary",
					"rs_cached686",
					stamp + 2,
				);
				(cached as any).providerPayload = {
					type: "openaiResponsesHistory",
					provider: model.provider,
					dt: true,
					items: [
						{
							type: "message",
							role: "assistant",
							id: "rs_cached686",
							phase: "commentary",
							status: "completed",
							content: [
								{
									type: "output_text",
									text: "HISTORY686 cached commentary",
									annotations: [],
								},
							],
						},
					],
				};
				history = [
					user("HISTORY686 responses first user", stamp),
					signed("HISTORY686 signed commentary", "rs_signed686", stamp + 1),
					cached,
					{ ...reply, api: "openai-completions", timestamp: stamp + 3 },
					{ ...call, api: "openai-responses", timestamp: stamp + 4 },
					{ ...result, timestamp: stamp + 5 },
					{ ...reply, api: "openai-completions", timestamp: stamp + 6 },
				];
				break;
			}
			case "consecutive-users":
				history = [
					user("HISTORY683 first user", stamp),
					user("HISTORY683 consecutive user", stamp + 1),
				];
				break;
			case "empty-assistant":
				history = [
					user("HISTORY683 first user", stamp),
					assistant([], stamp + 1),
				];
				break;
			case "aborted-assistant":
				history = [
					user("HISTORY683 first user", stamp),
					assistant(
						[
							{
								type: "thinking",
								thinking: "HISTORY683 interrupted reasoning",
							},
						],
						stamp + 1,
						"aborted",
					),
				];
				break;
			case "thinking":
				history = [
					user("HISTORY683 first user", stamp),
					assistant(
						[{ type: "thinking", thinking: "HISTORY683 prior reasoning" }],
						stamp + 1,
					),
				];
				break;
			case "user-image":
				history = [
					{
						...user("HISTORY683 image", stamp),
						content: [
							{ type: "text", text: "HISTORY683 image" },
							{ type: "image", data: png, mimeType: "image/png" },
						],
					},
					reply,
				];
				break;
			case "tool-image":
				result.content.push({
					type: "image",
					data: png,
					mimeType: "image/png",
				});
				history = [user("HISTORY683 first user", stamp), call, result, reply];
				break;
			case "orphan-result":
				history = [user("HISTORY683 first user", stamp), result, reply];
				break;
			case "missing-result":
				history = [user("HISTORY683 first user", stamp), call, reply];
				break;
			case "interrupted-tool":
				// A crash after the assistant's message_end persists the toolUse turn
				// before tool execution can persist a toolResult (agent-session.ts:3939).
				history = [user("HISTORY686 interrupted tool turn", stamp), call];
				interruptedCall = call;
				break;
			case "mixed":
				history = [
					user("HISTORY683 first user", stamp),
					call,
					result,
					reply,
					assistant(
						[
							{
								type: "toolCall",
								id: "normal_call_683",
								name: "Read",
								arguments: {},
							},
							{
								type: "toolCall",
								id: "second_call_683",
								name: "Read",
								arguments: {},
							},
						],
						stamp + 4,
						"toolUse",
					),
					{
						...result,
						toolCallId: "normal_call_683",
						content: [
							...result.content,
							{ type: "image", data: png, mimeType: "image/png" },
						],
						timestamp: stamp + 5,
					},
					{ ...result, toolCallId: "second_call_683", timestamp: stamp + 6 },
					assistant(
						[{ type: "text", text: "HISTORY683 normal arc complete" }],
						stamp + 7,
					),
					user("HISTORY683 followup one", stamp + 8),
					user("HISTORY683 followup two", stamp + 9),
					assistant([], stamp + 10),
					assistant(
						[
							{
								type: "thinking",
								thinking: "HISTORY683 unsupported reasoning",
							},
						],
						stamp + 11,
					),
					assistant(
						[{ type: "thinking", thinking: "HISTORY683 aborted reasoning" }],
						stamp + 12,
						"aborted",
					),
					{
						...result,
						toolCallId: "orphan_call_683",
						toolName: "legacy_tool_removed_683",
						timestamp: stamp + 13,
					},
				];
				break;
			default:
				history = [user("HISTORY683 first user", stamp), call, result, reply];
		}
		historyManager = SessionManager.create(
			root,
			join(isolated.PI_CODING_AGENT_DIR, "sessions/history-probe"),
		);
		const entries: string[] = [];
		for (const message of history)
			entries.push(await historyManager.appendMessage(message));
		if (historyCase === "summary" || historyCase === "mixed")
			historyManager.appendCompaction(
				"HISTORY683 replayed summary",
				undefined,
				entries[2],
				1000,
			);
		await historyManager.ensureOnDisk();
		await historyManager.flush();
		const file = historyManager.getSessionFile();
		if (!file || !historyManager.isSessionOnDisk())
			throw new Error("history was not persisted");
		if (historyCase === "interrupted-tool")
			audit({
				phase: "interrupted-persisted",
				entries: readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			});
		if (
			historyCase === "resume" ||
			historyCase === "summary" ||
			historyCase === "mixed" ||
			historyCase === "responses-history" ||
			historyCase === "interrupted-tool"
		) {
			await historyManager.close();
			historyManager = await SessionManager.open(file, undefined, undefined, {
				throwIfMissing: true,
				initialCwd: root,
			});
		}
		audit({
			phase: "history-seed",
			historyCase,
			rows: history.length,
			file,
			restoredRows: historyManager.buildSessionContext().messages.length,
			history,
		});
	}
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: isolated.PI_CODING_AGENT_DIR,
		model,
		getApiKey: async () => apiKey,
		...(historyManager ? { sessionManager: historyManager } : {}),
		additionalExtensionPaths: [probe],
		disableExtensionDiscovery: true,
	}));
	await initializeExtensions(session, {
		mode: "rpc",
		reportRuntimeError: (error: unknown) =>
			audit({ phase: "runtime-error", error: String(error) }),
		reportSendError: (_: unknown, error: unknown) =>
			audit({ phase: "send-error", error: String(error) }),
	});
	if (interruptedCall) {
		// Session replay trims incomplete tail calls. Restore the persisted call
		// to the active agent to model interruption before the tool result arrives.
		session.agent.appendMessage(interruptedCall);
		const messages = session.agent.state.messages;
		if (
			messages.at(-1) !== interruptedCall ||
			messages.some((message: any) => message.role === "toolResult")
		)
			throw new Error("interrupted call must have no result before prompting");
		audit({ phase: "interrupted-session", messages });
	}
	const isolation = (label: string) => {
		const text = execFileSync("/usr/sbin/lsof", ["-p", String(process.pid)], {
			encoding: "utf8",
		});
		writeFileSync(join(root, `lsof-${label}.txt`), text);
		const stores = text
			.split("\n")
			.filter((line) =>
				/(?:\.db(?:[- ]|$)|\/\.omp\/|\/\.pi\/|\/\.config\/)/.test(line),
			);
		if (stores.some((line) => !line.includes(root)))
			throw new Error("live store descriptor found");
		audit({ phase: "isolation", label, pid: process.pid, stores });
	};
	isolation("start");
	const managedTurns = historyCase === "mixed" && mode !== "raw" ? 3 : 1;
	const managedOutcomes: object[] = [];
	for (let i = 0; i < managedTurns; i++) {
		const before = wires;
		await session.prompt(`PROVIDER683 prepared turn ${i + 1}`);
		if (historyCase === "mixed" && mode !== "raw") {
			const turnHooks = readFileSync(join(root, "hooks.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const refused = turnHooks.some(
				(event) =>
					event.phase === "entry" &&
					event.type === "magic-context-turn-refused",
			);
			const last = session.agent.state.messages.at(-1);
			const ok =
				!refused &&
				wires === before + 1 &&
				last?.role === "assistant" &&
				last.stopReason === "stop" &&
				last.content.some(
					(part: any) =>
						part.type === "text" && part.text === "HISTORY683 provider reply",
				);
			managedOutcomes.push({
				turn: i + 1,
				passed: ok,
				wires: wires - before,
				stopReason: last?.stopReason,
			});
			if (!ok)
				throw new Error(
					`cline-pass mixed managed turn ${i + 1} did not complete`,
				);
		}
	}
	if (mode === "managed-then-raw") {
		(globalThis as any).__mc683Raw = true;
		await session.prompt("PROVIDER683 raw final turn in the same session");
	}
	await session.flushToDisk();
	isolation("end");
	const hooks = readFileSync(join(root, "hooks.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const attempts = hooks.filter((e) => e.phase === "before_provider_request");
	const refusals = hooks.filter(
		(e) => e.phase === "entry" && e.type === "magic-context-turn-refused",
	);
	if (historyCase === "responses-history") {
		const body = attempts[0]?.payload;
		const input = body?.input;
		const wireTexts = Array.isArray(input)
			? input
					.filter((item: { role?: string }) => item.role === "assistant")
					.flatMap(
						(item: { content?: { type?: string; text?: string }[] }) =>
							item.content
								?.filter((part) => part.type === "output_text")
								.map((part) => part.text) ?? [],
					)
			: [];
		const signedPresent = wireTexts.some((text) =>
			text?.includes("HISTORY686 signed commentary"),
		);
		const cachedPresent = wireTexts.includes("HISTORY686 cached commentary");
		const switchedPresent = wireTexts.some((text) =>
			text?.includes("HISTORY683 previous reply"),
		);
		if (
			signedPresent !== (mode !== "drop-commentary") ||
			!cachedPresent ||
			!switchedPresent
		)
			throw new Error("Responses text fixture did not reach the wire input");
		audit({
			phase: "responses-history-proof",
			signedPresent,
			cachedPresent,
			switchedPresent,
			assistantTextItems: wireTexts.length,
			eventOrder: hooks.map((event) => event.phase),
		});
	}
	if (historyCase === "materialized") {
		const proof = hooks.find((event) => event.phase === "materialized-proof");
		if (
			!proof ||
			!proof.rows.some(
				(row: any) =>
					typeof row.m0 === "string" &&
					row.m0.includes("COMPARTMENT686_BODY") &&
					typeof row.m1 === "string",
			)
		)
			throw new Error("compartments did not produce persisted m0/m1");
	}
	audit({
		phase: "summary",
		api,
		mode,
		managedTurns,
		managedOutcomes,
		historyCase,
		wires,
		attempts: attempts.length,
		refusals,
		version,
		bun: Bun.version,
	});
	const name =
		mode === "managed-then-raw"
			? `${selector}: mixed managed history turns admit and raw final turn refuses`
			: mode === "drop-commentary"
				? `${selector}: dropped signed commentary refused before transport`
				: mode === "raw"
					? `${selector}: raw request refused before transport`
					: `${selector}: prepared ${historyCase === "fresh" ? "first" : historyCase} turn admitted`;
	const ok =
		mode === "managed-then-raw"
			? managedOutcomes.length === managedTurns &&
				attempts.length === managedTurns + 1 &&
				wires === managedTurns &&
				refusals.length === 1 &&
				refusals[0].data.message.includes("missing current receipt signature")
			: mode === "drop-commentary"
				? attempts.length === 1 &&
					wires === 0 &&
					refusals.length === 1 &&
					refusals[0].data.message.includes("comparison=content") &&
					hooks.some((event) => event.phase === "dropped-commentary")
				: mode === "raw"
					? attempts.length > 0 && wires === 0 && refusals.length === 1
					: attempts.length > 0 && wires > 0 && refusals.length === 0;
	console.log(
		`Bun ${Bun.version}; OMP ${version}; ${ok ? "PASS" : "FAIL"} ${name}; attempts=${attempts.length} wires=${wires} refusals=${refusals.length}; evidence=${root}`,
	);
	if (!ok) throw new Error(name);
} finally {
	await session?.dispose();
	mock.stop(true);
}
