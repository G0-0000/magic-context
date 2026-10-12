#!/usr/bin/env bun
// Drive Oh My Pi's JSON-lines RPC host with temporary database/config roots
// and a local mock provider, never the installed user's stores or credentials.
import { spawn, execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const root = join(realpathSync(tmpdir()), "magic-context", "issue-663");
mkdirSync(root, { recursive: true });
Object.assign(process.env, {
	TMPDIR: root,
	HOME: root,
	CFFIXED_USER_HOME: root,
	XDG_DATA_HOME: join(root, "driver-data"),
	XDG_CONFIG_HOME: join(root, "driver-config"),
	XDG_STATE_HOME: join(root, "driver-state"),
	XDG_RUNTIME_DIR: join(root, "driver-runtime"),
	OPENCODE_DB: join(root, "driver-data/opencode/opencode.db"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "driver-data/magic-context"),
	MC_E2E_KEEP: "1",
});
const { createPiIsolatedEnv, childEnv, writeConfigs } = await import(
	"../../../../packages/e2e-tests/src/pi-runner/spawn"
);
const { prepareContextDatabase } = await import(
	"../../../../packages/e2e-tests/src/prepare-context-db"
);
const { PiRpcProtocol, attachStrictJsonlReader } = await import(
	"../../../../packages/e2e-tests/src/pi-runner/rpc-client"
);
const { MockProvider } = await import(
	"../../../../packages/e2e-tests/src/mock-provider/server"
);
const mode = process.argv[2] ?? "main";
if (
	![
		"main",
		"retry",
		"side",
		"steer",
		"task",
		"title",
		"compact",
		"advisor",
		"capture",
		"late-start",
		"skip",
		"no-result",
	].includes(mode)
)
	throw new Error("unknown probe mode");
const baseline = process.argv.includes("--baseline");
const fullPlugin = process.argv.includes("--full-plugin");
const responses = process.argv.includes("--responses");
const mock = new MockProvider();
const { baseURL } = await mock.start();
const iso = createPiIsolatedEnv(undefined, "omp");
prepareContextDatabase(iso.dataDir);
writeConfigs(iso, {
	host: "omp",
	mockProviderURL: baseURL,
	modelContextLimit: 1000000,
	magicContextConfig: {
		memory: { enabled: false },
		embedding: { provider: "off" },
		dreamer: { disable: true },
	},
	piSettingsExtra: {
		...(mode === "advisor"
			? {
					advisor: { enabled: true, tools: [] },
					modelRoles: { advisor: "mock/mock-model" },
				}
			: { advisor: { enabled: false } }),
		...(mode === "capture"
			? { autolearn: { enabled: true, autoContinue: true, minToolCalls: 0 } }
			: {}),
		compaction: {
			enabled: false,
			keepRecentTokens: 1,
			reserveTokens: 1024,
			methodOrder: ["soft"],
		},
		...(mode === "title"
			? {
					modelRoles: { tiny: "mock/mock-model", smol: "mock/mock-model" },
					title: { generator: "tiny" },
				}
			: {}),
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
		task: {
			batch: false,
			isolation: { enabled: false },
			agentModels: { task: "mock/mock-model" },
		},
		async: { enabled: true },
	},
});
if (responses) {
  const path = join(iso.agentDir, "models.json");
  const models = JSON.parse(readFileSync(path, "utf8"));
  models.providers.mock.api = "openai-responses";
  writeFileSync(path, JSON.stringify(models));
}
const env = childEnv(iso);
const storeKeys = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_DB", "MAGIC_CONTEXT_STORAGE_DIR"];
const isolatedEnvironment = Object.fromEntries(storeKeys.map(key => [key, env[key]]));
if (storeKeys.some(key => !env[key]?.startsWith(`${iso.baseDir}/`))) throw new Error("host store environment escaped isolation");
Object.assign(env, {
	TMPDIR: root,
	MC663_ROOT: iso.baseDir,
	MC663_MODE: mode,
	PI_NO_TITLE: mode === "title" ? "" : "1",
	MAGIC_CONTEXT_LOG_PATH: join(iso.baseDir, "magic-context.log"),
});
const probe = join(iso.baseDir, "probe.mjs");
const bundle = baseline ? "guard-baseline.mjs" : "guard.mjs";
writeFileSync(
	probe,
	`
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import guard from ${JSON.stringify(fullPlugin ? join(repo, "packages/pi-plugin/dist/index.js") : join(repo, ".cache/issue-663", bundle))};
const db = new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR + '/context.db');
const audit = value => appendFileSync(process.env.MC663_ROOT + '/audit.jsonl', JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
export default async function(pi) {
  const mode = process.env.MC663_MODE;
  let releaseStart, recordStart;
  const heldStart=new Promise(resolve=>{releaseStart=resolve;});
  const started=new Promise(resolve=>{recordStart=resolve;});
  if(mode==='late-start') pi.on('agent_start',async()=>{audit({phase:'start-blocked'});await heldStart;audit({phase:'start-released'});});
  const proxied = new Proxy(pi,{get(target,key){
    if(key==='on') return (name,handler)=>target.on(name,async (event,ctx)=>{
      audit({phase:name,session:ctx.sessionManager.getSessionId(),child:!!ctx.sessionManager.getHeader()?.parentSession,event});
      if(name==='agent_start') {
        db.query('SELECT count(*) FROM sqlite_master').get();
        const lsof=execFileSync('/usr/sbin/lsof',['-p',String(process.pid)],{encoding:'utf8'});
        const dbLines=lsof.split('\\n').filter(line=>/\\.db(?:[- ]|$)/.test(line));
        if(!dbLines.length || dbLines.some(line=>!line.includes(process.env.MC663_ROOT))) throw new Error('store isolation failed');
        audit({phase:'lsof',lsof,dbLines});
      }
      if(mode==='skip' && name==='context') { audit({phase:'skipped-context'}); return; }
      const abort=ctx.abort;
      const before=name==='before_provider_request'?JSON.stringify(event.payload):undefined;
      const result=await handler(event,Object.assign(Object.create(ctx),{abort:()=>{audit({phase:'abort',hook:name});return abort();}}));
      if(before!==undefined && before!==JSON.stringify(event.payload)) throw new Error('dispatch changed provider bytes');
      if(name==='context' && mode==='late-start') {
        audit({phase:'managed-context-ready'});
        releaseStart();
        await started;
      }
      audit({phase:name+'-end',result});
      if(name==='before_provider_request' && (event.payload?.tools?.some(t=>t.name.replace(/^_/, '')==='advise') || JSON.stringify(event.payload?.messages ?? event.payload?.input).includes('Automated capture turn'))) ctx.ui.notify('INTERNAL663_DONE','info');
      return result;
    });
    if(key==='appendEntry') return (type,data)=>{audit({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await guard(proxied);
  if(mode==='late-start') pi.on('agent_start',()=>{recordStart();});
  if(mode==='side') pi.on('agent_start',async(_event,ctx)=>{
    if(ctx.sessionManager.getHeader()?.parentSession) return;
    void ctx.runEphemeralTurn({promptText:'SIDE663',tools:false}).then(result=>{audit({phase:'side-done',result});ctx.ui.notify('SIDE663_DONE','info');});
    await Bun.sleep(20);
  });
}
`,
);
const usage = { input_tokens: 1000, output_tokens: 10 };
mock.setDefault({
	text:
		mode === "title" ? "<title>Throwaway dispatch probe</title>" : "mock reply",
	usage,
});
let retry = false;
let delegated = false;
let notifyWire!: () => void;
const wireStarted = new Promise<void>((resolve) => {
	notifyWire = resolve;
});
let notifyInternalWire!: () => void;
const internalWire = new Promise<void>(resolve => { notifyInternalWire = resolve; });
mock.addMatcher((body) => {
  if ((body.tools as Array<{ name: string }> | undefined)?.some(tool => tool.name.replace(/^_/, "") === "advise")) notifyInternalWire();
	notifyWire();
	appendFileSync(
		join(iso.baseDir, "audit.jsonl"),
		JSON.stringify({ at: Date.now(), phase: "wire", body }) + "\n",
	);
	if (mode === "retry" && !retry) {
		retry = true;
		return {
			error: { status: 529, type: "overloaded_error", message: "retry probe" },
		};
	}
	if (mode === "steer" && !retry) {
		retry = true;
		return { text: "first reply", usage, delayMs: 1000 };
	}
	if (mode === "side" && JSON.stringify(body.messages ?? body.input).includes("SIDE663"))
		return { text: "side reply", usage, delayMs: 1000 };
	const tools = (body.tools ?? []) as Array<{ name: string }>;
	const yieldTool = tools.find((t) => t.name.replace(/^_/, "") === "yield");
	if (mode === "task" && yieldTool)
		return {
			content: [
				{
					type: "tool_use",
					id: "yield663",
					name: yieldTool.name,
					input: { data: "child completed" },
				},
			],
			stop_reason: "tool_use",
			usage,
		};
	const task = tools.find((t) => t.name.replace(/^_/, "") === "task");
	if (mode === "task" && task && !delegated) {
		delegated = true;
		return {
			content: [
				{
					type: "tool_use",
					id: "task663",
					name: task.name,
					input: {
						name: "Probe663",
						agent: "task",
						task: "Report completion.",
						solutionSpace: "One brief result.",
					},
				},
			],
			stop_reason: "tool_use",
			usage,
		};
	}
	return null;
});
const cli = join(
	repo,
	".cache/issue-663/host/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
);
const version = execFileSync(
	"nice",
	["-n", "10", process.execPath, cli, "--version"],
	{ env, cwd: iso.workdir, encoding: "utf8" },
).trim();
writeFileSync(join(iso.baseDir, "stderr.txt"), "");
const host = spawn(
	"nice",
	[
		"-n",
		"10",
		process.execPath,
		cli,
		"--mode",
		"rpc",
		"--no-extensions",
		"--extension",
		probe,
		"--no-skills",
		"--no-rules",
		"--model",
		"mock/mock-model",
		"--api-key",
		"test-key-not-real",
	],
	{ env, cwd: iso.workdir, stdio: ["pipe", "pipe", "pipe"] },
);
const rpc = new PiRpcProtocol();
attachStrictJsonlReader(host.stdout!, (line) => rpc.dispatchLine(line));
host.stderr!.on("data", (data) =>
	appendFileSync(join(iso.baseDir, "stderr.txt"), data),
);
rpc.onEvent((event) =>
	appendFileSync(
		join(iso.baseDir, "events.jsonl"),
		JSON.stringify({ at: Date.now(), ...event }) + "\n",
	),
);
const command = (type: string, params = {}) =>
	rpc.sendCommand((line) => host.stdin!.write(line), type, params, {
		timeoutMs: 90000,
	});
try {
	await command("get_state");
	const sideDone =
		mode === "side"
			? rpc.waitForEvent(
					(e) =>
						e.type === "extension_ui_request" &&
						e.method === "notify" &&
						e.message === "SIDE663_DONE",
					{ timeoutMs: 90000 },
				)
			: undefined;
	const internalDone = ["advisor", "capture"].includes(mode)
		? rpc.waitForEvent(
				(e) =>
					e.type === "extension_ui_request" &&
					e.method === "notify" &&
					e.message === "INTERNAL663_DONE",
				{ timeoutMs: 90000 },
			)
		: undefined;
	const done = rpc.waitForEvent((e) => e.type === "agent_end", {
		timeoutMs: 90000,
	});
	await command("prompt", { message: "ORIGINAL663" });
	if (mode === "steer") {
		await wireStarted;
		await command("steer", { message: "STEER663" });
	}
	await done;
	await internalDone;
  if (mode === "advisor" && !baseline) {
    await Promise.race([internalWire, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("advisor dispatch did not arrive")), 10000))]);
  }
	await sideDone;
	const resumed =
		mode === "task"
			? rpc.waitForEvent((e) => e.type === "agent_end", { timeoutMs: 90000 })
			: undefined;
	if (mode === "task")
		await rpc.waitForEvent(
			(e) =>
				e.type === "message_end" &&
				(e.message as { customType?: string })?.customType === "async-result",
			{ timeoutMs: 90000 },
		);
	await resumed;
	if (mode === "compact") {
		const next = rpc.waitForEvent((e) => e.type === "agent_end", {
			timeoutMs: 90000,
		});
		await command("prompt", {
			message: "COMPACT663 " + "throwaway summary input ".repeat(600),
		});
		await next;
		await command("compact", {
			customInstructions: "Summarize the probe history",
		});
	}
	if (mode === "title") {
		const title = rpc.waitForEvent((e) => e.type === "session_info_update", {
			timeoutMs: 90000,
		});
		await command("prompt", { message: "/rename" });
		await title;
	}
	const lsof = execFileSync("/usr/sbin/lsof", ["-p", String(host.pid)], {
		encoding: "utf8",
	});
	const dbLines = lsof
		.split("\n")
		.filter((line) => /\.db(?:[- ]|$)/.test(line));
	if (!dbLines.length || dbLines.some((line) => !line.includes(iso.baseDir)))
		throw new Error("store isolation failed");
	const evidence = join(repo, "local-ignore/issue-663/host");
	mkdirSync(evidence, { recursive: true });
	const audit = readFileSync(join(iso.baseDir, "audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const summary = {
		version,
		mode,
		baseline,
		fullPlugin,
		responses,
		isolatedEnvironment,
        root: iso.baseDir,
		pid: host.pid,
		requests: mock.requests().length,
		dbLines,
	};
	writeFileSync(
		join(
			evidence,
			`${mode}${fullPlugin ? "-plugin" : ""}${responses ? "-responses" : ""}-${baseline ? "baseline" : "fixed"}.json`,
		),
		JSON.stringify({ summary, audit, requests: mock.requests() }, null, 2) +
			"\n",
	);
	writeFileSync(
		join(
			evidence,
			`${mode}${fullPlugin ? "-plugin" : ""}${responses ? "-responses" : ""}-${baseline ? "baseline" : "fixed"}-lsof.txt`,
		),
		lsof,
	);
	writeFileSync(
		join(
			evidence,
			`${mode}${fullPlugin ? "-plugin" : ""}${responses ? "-responses" : ""}-${baseline ? "baseline" : "fixed"}-stderr.txt`,
		),
		readFileSync(join(iso.baseDir, "stderr.txt"), "utf8"),
	);
	writeFileSync(
		join(
			evidence,
			`${mode}${fullPlugin ? "-plugin" : ""}${responses ? "-responses" : ""}-${baseline ? "baseline" : "fixed"}-events.jsonl`,
		),
		readFileSync(join(iso.baseDir, "events.jsonl"), "utf8"),
	);
	if (
		!audit.some((row) => row.phase === "agent_start") ||
		!audit.some((row) => row.phase === "before_provider_request")
	)
		throw new Error("guard instrumentation did not load");
	const count = mock.requests().length;
	const expected = {
		main: 1,
		retry: 2,
		side: 2,
		steer: 2,
		task: 4,
		title: 2,
		capture: 1,
		skip: 0,
		"no-result": 0,
		advisor: baseline ? 1 : 2,
		"late-start": baseline ? 0 : 1,
	}[mode];
	if (expected !== undefined && count !== expected)
		throw new Error(`expected ${expected} requests, got ${count}`);
	if (mode === "compact" && count < 3)
		throw new Error("internal summary request missing");
	const entries = audit.filter(
		(row) => row.phase === "entry" && row.type === "magic-context-turn-refused",
	);
	if (["skip", "no-result", "capture"].includes(mode) && !entries.length)
		throw new Error("unsafe dispatch was not visibly refused");
	if (
		!baseline &&
		[
			"main",
			"retry",
			"side",
			"steer",
			"task",
			"title",
			"compact",
			"advisor",
			"late-start",
		].includes(mode) &&
		entries.length
	)
		throw new Error("managed or internal request was refused");
	if (mode === "late-start") {
		const context = audit.findIndex((row) => row.phase === "context");
		const start = audit.findIndex((row) => row.phase === "agent_start");
		const dispatch = audit.findIndex(
			(row) => row.phase === "before_provider_request",
		);
		if (!(context < start && start < dispatch))
			throw new Error("lifecycle race was not reached");
	}
	if (mode === "side") {
		const [side, main] = mock.requests();
		if (
			!side?.responseCompletedAt ||
			!main ||
			side.responseCompletedAt <= main.receivedAt
		)
			throw new Error("same-session operations did not overlap");
	}
	if (["main", "late-start", "task"].includes(mode) && count) {
    const text = JSON.stringify(mock.requests()[0].body.messages ?? mock.requests()[0].body.input);
    if (fullPlugin ? !/§\d+§ ORIGINAL663/.test(text) : !text.includes("MANAGED663 ORIGINAL663")) throw new Error("ordinary user input was not managed");
  }
	console.log(JSON.stringify({ ...summary, dbLines: dbLines.length }));
} finally {
	host.kill("SIGTERM");
	await new Promise((done) => host.once("exit", done));
	await mock.stop();
	rmSync(iso.baseDir, { recursive: true, force: true });
}
