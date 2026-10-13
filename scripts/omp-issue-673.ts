#!/usr/bin/env bun
// Drive Oh My Pi 18.9.2 with a loopback mock provider and throwaway configuration/databases.
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = realpathSync(process.env.MC673_RUN_ROOT!);
if (!root.includes("/magic-context/issue-673/"))
	throw new Error("throwaway issue-673 root required");
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
	OPENCODE_DB: join(root, "data/opencode/opencode.db"),
};
for (const [key, value] of Object.entries(isolated)) {
	if (process.env[key] !== value)
		throw new Error(`${key} must be isolated before host startup`);
	if (key !== "OPENCODE_DB") mkdirSync(value, { recursive: true });
}
const install = process.env.MC673_HOST!;
const host = join(install, "node_modules/@oh-my-pi/pi-coding-agent");
const version = JSON.parse(
	readFileSync(join(host, "package.json"), "utf8"),
).version;
if (version !== "18.9.2")
	throw new Error(`expected OMP 18.9.2, got ${version}`);
const mode = process.argv[2] ?? "late-retry";
if (!["normal", "late-retry"].includes(mode)) throw new Error("unknown mode");
const audit = (value: unknown) =>
	appendFileSync(
		join(root, "audit.jsonl"),
		JSON.stringify({ at: Date.now(), ...(value as object) }) + "\n",
	);
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
const { MockProvider } = await import(
	"../packages/e2e-tests/src/mock-provider/server"
);
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({
	text: "mock reply",
	usage: { input_tokens: 1000, output_tokens: 10 },
});
let rejected = false;
mock.addMatcher((body) => {
	audit({ phase: "wire", body });
	if (
		mode === "late-retry" &&
		!rejected &&
		JSON.stringify(body).includes("SECOND673")
	) {
		rejected = true;
		(globalThis as any).__mc673ReleaseEnd();
		return {
			error: {
				status: 400,
				type: "invalid_request_error",
				message: "structured_outputs not supported",
			},
		};
	}
	return null;
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
		quietStartup: true,
		enableInstallTelemetry: false,
	}),
);
writeFileSync(
	join(isolated.PI_CODING_AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: baseURL,
				apiKey: "test-key-not-real",
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
	process.env.MC673_PLUGIN ??
	resolve(import.meta.dir, "../packages/pi-plugin/dist/index.js");
const probe = join(root, "probe.mjs");
writeFileSync(
	probe,
	`
import { appendFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import magic from ${JSON.stringify(plugin)};
const log = value => appendFileSync(${JSON.stringify(join(root, "hooks.jsonl"))}, JSON.stringify({at:Date.now(),...value})+'\\n');
export default async pi => {
  let ends=0, attempts=0, releaseEnd, endDelivered;
  const heldEnd=new Promise(resolve=>{releaseEnd=resolve;});
  const delivered=new Promise(resolve=>{endDelivered=resolve;});
  globalThis.__mc673ReleaseEnd=releaseEnd;
  pi.on('agent_end',async event=>{
    if(++ends===1 && ${JSON.stringify(mode)}==='late-retry') {
      log({phase:'held-earlier-end',messages:event.messages});
      await heldEnd;
    }
  });
  const proxy = new Proxy(pi, {get(target,key) {
    if(key==='on') return (name,handler)=>target.on(name,async (event,ctx)=>{
      if(name==='before_provider_request' && JSON.stringify(event.payload).includes('SECOND673') && ++attempts===2 && ${JSON.stringify(mode)}==='late-retry') await delivered;
      if(['agent_start','agent_end','context','before_provider_request'].includes(name)) log({phase:name,messages:event.messages,payload:event.payload,willContinue:event.willContinue,idle:ctx.isIdle(),branch:name!=='agent_start'?ctx.sessionManager.getBranch():undefined});
      const wrapped = Object.defineProperties(Object.create(ctx), {
        abort: {value:()=>{log({phase:'abort',hook:name});return ctx.abort();}},
        ui: {value:Object.defineProperty(Object.create(ctx.ui),'notify',{value:(text,level)=>{log({phase:'notice',text,level});return ctx.ui.notify(text,level);}})},
      });
      const result = await handler(event,wrapped);
      if(name==='context' && result?.messages) {
        const db=new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR+'/context.db',{readonly:true});
        try { log({phase:'lkg-publication',rows:db.query('SELECT session_id, captured_at, capture_sequence, input_id_seq, json_prefix_hash FROM lkg_slots').all()}); }
        finally {db.close();}
      }
      if(['agent_start','agent_end','context','before_provider_request'].includes(name)) log({phase:name+'-end',messages:result?.messages});
      return result;
    });
    if(key==='appendEntry') return (type,data)=>{log({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await magic(proxy);
  pi.on('agent_end',()=>{if(ends===1) {log({phase:'earlier-end-delivered'});endDelivered();}});
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
let session: any;
try {
	audit({ phase: "host", version, bun: Bun.version, root, plugin, mode });
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: isolated.PI_CODING_AGENT_DIR,
		additionalExtensionPaths: [probe],
		disableExtensionDiscovery: true,
	}));
	await initializeExtensions(session, {
		mode: "rpc",
		reportRuntimeError: (error: unknown) =>
			audit({ phase: "runtime-error", error: String(error) }),
		reportSendError: (_action: string, error: unknown) =>
			audit({ phase: "send-error", error: String(error) }),
	});
	session.subscribe((event: any) => {
		if (["agent_start", "agent_end"].includes(event.type))
			audit({ phase: "public-" + event.type, messages: event.messages });
	});
	isolation("start");
	await session.prompt("FIRST673");
	await session.prompt("SECOND673");
	await session.flushToDisk();
	isolation("end");
	const hooks = readFileSync(join(root, "hooks.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const wires = readFileSync(join(root, "audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((e) => e.phase === "wire");
	const check = (name: string, ok: boolean) => {
		audit({ phase: "check", name, passed: ok });
		if (!ok) throw new Error(`FAIL ${name}`);
	};
	check(
		"all HTTP requests contain managed ordinal tags",
		wires.every((e) =>
			/§\d+§ (?:FIRST|SECOND)673/.test(JSON.stringify(e.body)),
		),
	);
	if (mode === "late-retry") {
		check(
			"retried context pass publishes a durable LKG slot before dispatch",
			hooks.filter((e) => e.phase === "lkg-publication").at(-1)?.rows.length === 1,
		);
		const attempts = hooks.filter(
			(e) =>
				e.phase === "before_provider_request" &&
				JSON.stringify(e.payload).includes("SECOND673"),
		);
		check(
			"retry keeps the same native anchor and original transcript",
			attempts.length === 2 &&
				JSON.stringify(attempts[0].branch) ===
					JSON.stringify(attempts[1].branch),
		);
		check(
			"strict fallback reuses exactly the same managed messages",
			wires.length === 3 &&
				JSON.stringify(wires[1].body.messages) ===
					JSON.stringify(wires[2].body.messages),
		);
		check(
			"late earlier end causes no refusal",
			!hooks.some(
				(e) => e.phase === "entry" && e.type === "magic-context-turn-refused",
			),
		);
	}
	console.log(
		`Bun ${Bun.version}; OMP ${version}; ${mode === "late-retry" ? 5 : 1} checks passed; evidence ${root}`,
	);
} finally {
	await session?.dispose();
	await mock.stop();
}
