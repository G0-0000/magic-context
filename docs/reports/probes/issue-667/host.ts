#!/usr/bin/env bun
// Drive Oh My Pi's JSON-lines RPC host against a loopback mock provider that
// captures every request body, with throwaway database/config roots only.
//
// Modes (all hold the guard's agent_end notification for the first run until
// the next pass's context result has returned, reproducing OMP's detached
// agent_end delivery deterministically):
//   late-end  two prompts; the second is sent as soon as the first run ends
//   retry     the first provider response is a retryable error; OMP's
//             session retry schedules a continuation before notifying
//             extensions of the failed run's end (willContinue)
//   slow      the first pass outlives OMP's 30 s context timeout, the fence
//             refuses the raw dispatch, the user resends while that slow pass
//             is still running
// Flags: --baseline loads .cache/issue-667/guard-baseline.mjs (built from the
// guard before the fix); --full-plugin loads packages/pi-plugin/dist/index.js.
import { execFileSync, spawn } from "node:child_process";
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
const root = join(realpathSync(tmpdir()), "magic-context", "issue-667");
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
const mode = process.argv[2] ?? "late-end";
if (!["late-end", "retry", "slow"].includes(mode))
	throw new Error("unknown probe mode");
const baseline = process.argv.includes("--baseline");
const fullPlugin = process.argv.includes("--full-plugin");
const hostDir = process.env.MC667_HOST ?? "18.7.0";
const hold = !process.argv.includes("--no-hold");
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
		advisor: { enabled: false },
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
	},
});
const env = childEnv(iso);
const storeKeys = [
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"OPENCODE_DB",
	"MAGIC_CONTEXT_STORAGE_DIR",
];
const isolatedEnvironment = Object.fromEntries(
	storeKeys.map((key) => [key, env[key]]),
);
if (storeKeys.some((key) => !env[key]?.startsWith(`${iso.baseDir}/`)))
	throw new Error("host store environment escaped isolation");
Object.assign(env, {
	TMPDIR: root,
	MC667_ROOT: iso.baseDir,
	MC667_MODE: mode,
	MC667_HOLD: hold ? "1" : "0",
	PI_NO_TITLE: "1",
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
import guard from ${JSON.stringify(fullPlugin ? (process.env.MC667_PLUGIN ?? join(repo, "packages/pi-plugin/dist/index.js")) : join(repo, ".cache/issue-667", bundle))};
const db = new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR + '/context.db');
const audit = value => appendFileSync(process.env.MC667_ROOT + '/audit.jsonl', JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
const summarize = messages => Array.isArray(messages) ? messages.map(m => ({role:m.role,timestamp:m.timestamp,text:JSON.stringify(m.content).slice(0,80)})) : messages;
export default async function(pi) {
  let contexts = 0, ends = 0;
  let nextContextReady, endDelivered;
  const contextReady = new Promise(resolve => { nextContextReady = resolve; });
  const endDone = new Promise(resolve => { endDelivered = resolve; });
  const proxied = new Proxy(pi,{get(target,key){
    if(key==='on') return (name,handler)=>target.on(name,async (event,ctx)=>{
      const session = ctx.sessionManager.getSessionId();
      let pass;
      if(name==='context') pass = ++contexts;
      if(name==='agent_end') {
        const end = ++ends;
        audit({phase:'agent_end-arrived',end,willContinue:event.willContinue,messages:summarize(event.messages)});
        // The first run's end reaches Magic Context only after the next pass returned.
        if(end===1 && process.env.MC667_HOLD!=="0") { await Promise.race([contextReady, new Promise(r=>setTimeout(r,60000))]); }
      }
      if(name==='agent_start') {
        db.query('SELECT count(*) FROM sqlite_master').get();
        const lsof=execFileSync('/usr/sbin/lsof',['-p',String(process.pid)],{encoding:'utf8'});
        const dbLines=lsof.split('\\n').filter(line=>/\\.db(?:[- ]|$)/.test(line));
        if(!dbLines.length || dbLines.some(line=>!line.includes(process.env.MC667_ROOT))) throw new Error('store isolation failed');
        audit({phase:'lsof',dbLines});
      }
      audit({phase:name,session,pass,messages:name==='context'?summarize(event.messages):undefined});
      const abort=ctx.abort;
      const before=name==='before_provider_request'?JSON.stringify(event.payload):undefined;
      const result=await handler(event,Object.assign(Object.create(ctx),{abort:()=>{audit({phase:'abort',hook:name});return abort();}}));
      if(before!==undefined && before!==JSON.stringify(event.payload)) throw new Error('dispatch changed provider bytes');
      audit({phase:name+'-end',pass,managed:name==='context'?JSON.stringify(result?.messages ?? null).includes('MANAGED667'):undefined});
      if(name==='agent_end' && ends===1) endDelivered();
      if(name==='context' && pass===2 && process.env.MC667_HOLD!=="0") {
        nextContextReady();
        // Hold dispatch until the late end has been delivered to the guard.
        await Promise.race([endDone, new Promise(r=>setTimeout(r,5000))]);
        audit({phase:'late-end-delivered-before-dispatch'});
      }
      return result;
    });
    if(key==='appendEntry') return (type,data)=>{audit({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await guard(proxied);
}
`,
);
const usage = { input_tokens: 1000, output_tokens: 10 };
mock.setDefault({ text: "mock reply", usage });
let failures = 0;
const failuresWanted = Number(process.env.MC667_FAILS ?? "3");
mock.addMatcher((body) => {
	appendFileSync(
		join(iso.baseDir, "audit.jsonl"),
		JSON.stringify({ at: Date.now(), phase: "wire", body }) + "\n",
	);
	if (mode === "retry" && failures < failuresWanted) {
		failures++;
		return {
			error: { status: 500, type: "api_error", message: "retry probe 667" },
		};
	}
	return null;
});
const cli = join(
	repo,
	`.cache/issue-667/host-${hostDir}/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
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
		timeoutMs: 120000,
	});
const readAudit = () =>
	readFileSync(join(iso.baseDir, "audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
try {
	await command("get_state");
	const firstEnd = rpc.waitForEvent((e) => e.type === "agent_end", {
		timeoutMs: 120000,
	});
	await command("prompt", { message: "FIRST667" });
	await firstEnd;
	if (mode !== "retry") {
		// Resend as soon as the public agent_end frame arrives; OMP notifies
		// extensions of that end separately.
		const secondEnd = rpc.waitForEvent((e) => e.type === "agent_end", {
			timeoutMs: 120000,
		});
		await command("prompt", { message: "SECOND667" });
		await secondEnd;
	} else {
		// The continuation's end, after the scheduled retry.
		await new Promise((r) => setTimeout(r, 3000));
	}
	if (mode === "slow") await new Promise((r) => setTimeout(r, 4000));
	const lsof = execFileSync("/usr/sbin/lsof", ["-p", String(host.pid)], {
		encoding: "utf8",
	});
	const dbLines = lsof
		.split("\n")
		.filter((line) => /\.db(?:[- ]|$)/.test(line));
	if (!dbLines.length || dbLines.some((line) => !line.includes(iso.baseDir)))
		throw new Error("store isolation failed");
	const audit = readAudit();
	if (!audit.some((row) => row.phase === "context"))
		throw new Error("probe extension did not load; see stderr.txt");
	const requests = mock.requests();
	const wire = requests.map((request) => {
		const text = JSON.stringify(request.body.messages ?? request.body.input);
		return {
			receivedAt: request.receivedAt,
			managed: text.includes("MANAGED667") || /§\d+§/.test(text),
			first: text.includes("FIRST667"),
			second: text.includes("SECOND667"),
		};
	});
	const refusals = audit
		.filter(
			(row) => row.phase === "entry" && row.type === "magic-context-turn-refused",
		)
		.map((row) => row.data.message);
	const summary = {
		version,
		hostPackage: hostDir,
		mode,
		baseline,
		fullPlugin,
		isolatedEnvironment,
		root: iso.baseDir,
		pid: host.pid,
		requests: requests.length,
		wire,
		refusals,
		aborts: audit.filter((row) => row.phase === "abort").length,
		lateEndBeforeDispatch: audit.some(
			(row) => row.phase === "late-end-delivered-before-dispatch",
		),
		order: audit
			.filter((row) =>
				[
					"agent_start",
					"agent_end-arrived",
					"agent_end",
					"context",
					"context-end",
					"before_provider_request",
					"abort",
					"wire",
					"entry",
				].includes(row.phase),
			)
			.map((row) =>
				[
					row.phase,
					row.pass ?? "",
					row.willContinue === undefined ? "" : `willContinue=${row.willContinue}`,
				]
					.filter(Boolean)
					.join(" "),
			),
		dbLines,
	};
	const evidence = join(repo, "local-ignore/issue-667/host");
	mkdirSync(evidence, { recursive: true });
	const name = `${hold ? "" : "nohold-"}${mode}${fullPlugin ? "-plugin" : ""}-${hostDir}-${baseline ? "baseline" : "fixed"}`;
	writeFileSync(
		join(evidence, `${name}.json`),
		JSON.stringify({ summary, audit, requests }, null, 2) + "\n",
	);
	writeFileSync(join(evidence, `${name}-lsof.txt`), lsof);
	writeFileSync(
		join(evidence, `${name}-stderr.txt`),
		readFileSync(join(iso.baseDir, "stderr.txt"), "utf8"),
	);
	console.log(JSON.stringify({ ...summary, dbLines: dbLines.length }, null, 1));
} finally {
	host.kill("SIGTERM");
	await new Promise((done) => host.once("exit", done));
	await mock.stop();
	rmSync(iso.baseDir, { recursive: true, force: true });
}
