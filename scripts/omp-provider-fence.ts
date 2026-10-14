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
if (version !== "18.10.4")
	throw new Error(`expected OMP 18.10.4, got ${version}`);
const selector = process.argv[2]!;
const api = selector === "cline-pass" ? "openai-completions" : selector;
const mode = process.argv[3] ?? "managed";
if (mode !== "managed" && mode !== "raw") throw new Error("unknown mode");
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
const plugin = resolve(import.meta.dir, "../packages/pi-plugin/dist/index.js");
const probe = join(root, "probe.mjs");
writeFileSync(
	probe,
	`
import magic from ${JSON.stringify(plugin)};
import {appendFileSync} from 'node:fs';
const log = value => appendFileSync(${JSON.stringify(join(root, "hooks.jsonl"))},JSON.stringify({at:Date.now(),...value})+'\\n');
export default async pi => {
  const proxy = new Proxy(pi,{get(target,key){
    if(key==='on') return (name,handler)=>target.on(name,async(event,ctx)=>{
      const raw=name==='context'?structuredClone(event.messages):undefined;
      if(['context','before_provider_request','agent_start','agent_end'].includes(name)) log({phase:name,messages:event.messages,payload:event.payload});
      const wrapped=Object.defineProperties(Object.create(ctx),{
        abort:{value:()=>{log({phase:'abort',hook:name});return ctx.abort();}},
      });
      const result=await handler(event,wrapped);
      if(name==='context') {
        log({phase:'prepared',messages:result?.messages});
        if(${JSON.stringify(mode)}==='raw') return {messages:raw};
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
try {
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: isolated.PI_CODING_AGENT_DIR,
		model,
		getApiKey: async () => apiKey,
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
	await session.prompt("PROVIDER683 first prepared turn");
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
	audit({
		phase: "summary",
		api,
		mode,
		wires,
		attempts: attempts.length,
		refusals,
		version,
		bun: Bun.version,
	});
	const name =
		mode === "raw"
			? `${selector}: raw request refused before transport`
			: `${selector}: prepared first turn admitted`;
	const ok =
		mode === "raw"
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
