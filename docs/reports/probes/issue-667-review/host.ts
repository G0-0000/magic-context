#!/usr/bin/env bun
// Adversarial lifecycle orderings for the OMP dispatch fence, driven through
// Oh My Pi's JSON-lines RPC host against a loopback mock provider that
// captures every request body. Throwaway database/config roots only.
// Run 1 and run 2 are the agent runs of two consecutive prompts (FIRST667,
// then SECOND667, sent as soon as the first run's public agent_end arrives).
//
// Modes:
//   late-start-end    run 2's context pass returns, then run 1's late
//                     agent_end, then run 2's late agent_start, then dispatch
//   start-before-end  run 2's context pass returns, then run 2's late
//                     agent_start, then run 1's late agent_end, then dispatch
//   abort-before-dispatch
//                     run 1 is aborted right after its context pass returned
//                     and before its request is built; run 2 follows normally
// Flags: --full-plugin loads packages/pi-plugin/dist/index.js, whose managed
// requests carry §N§ tags; otherwise the guard bundle .cache/issue-667/guard.mjs
// (built from docs/reports/probes/issue-667/guard.ts) prefixes every user
// message with MANAGED667. Either marker in a captured body proves the request
// carries a context pass's managed result rather than OMP's raw messages.
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const root = join(realpathSync(tmpdir()), "magic-context", "issue-667-review");
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
const modes = ["late-start-end", "start-before-end", "abort-before-dispatch"];
const mode = process.argv[2] ?? "late-start-end";
if (!modes.includes(mode)) throw new Error("unknown probe mode");
const fullPlugin = process.argv.includes("--full-plugin");
const hostDir = process.env.MC667_HOST ?? "18.7.0";
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
const logPath = join(iso.baseDir, "magic-context.log");
Object.assign(env, {
	TMPDIR: root,
	MC667_ROOT: iso.baseDir,
	MC667_MODE: mode,
	PI_NO_TITLE: "1",
	MAGIC_CONTEXT_LOG_PATH: logPath,
});
const probe = join(iso.baseDir, "probe.mjs");
const extension = fullPlugin
	? join(repo, "packages/pi-plugin/dist/index.js")
	: join(repo, ".cache/issue-667/guard.mjs");
if (!existsSync(extension)) throw new Error(`missing ${extension}`);
writeFileSync(
	probe,
	`
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import guard from ${JSON.stringify(extension)};
const db = new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR + '/context.db');
const mode = process.env.MC667_MODE;
const audit = value => appendFileSync(process.env.MC667_ROOT + '/audit.jsonl', JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\\n');
const signal = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const capped = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(() => r('timeout'), ms))]);
const ctx2Returned = signal(), end1Delivered = signal(), start2Delivered = signal();
// The full plugin registers several handlers per lifecycle event. Number the
// invocations per registration, so 'end 1' is run 1's end for every handler,
// and treat an event as delivered once every registration has finished it.
const registrations = { context: 0, agent_end: 0, agent_start: 0 };
const finished = { end1: 0, start2: 0 };
export default async function(pi) {
  const proxied = new Proxy(pi,{get(target,key){
    if(key==='on') return (name,handler)=>{
      if(name in registrations) registrations[name]++;
      let calls = 0;
      return target.on(name,async (event,ctx)=>{
      let pass, end, start;
      if(name==='context') pass = ++calls;
      if(name==='agent_end') {
        end = ++calls;
        audit({phase:'agent_end-arrived',end,willContinue:event.willContinue});
        if(end===1 && mode==='late-start-end') audit({phase:'hold',what:'end1 until ctx2',result:await capped(ctx2Returned.promise,60000)});
        if(end===1 && mode==='start-before-end') audit({phase:'hold',what:'end1 until start2',result:await capped(start2Delivered.promise,60000)});
      }
      if(name==='agent_start') {
        start = ++calls;
        db.query('SELECT count(*) FROM sqlite_master').get();
        const lsof=execFileSync('/usr/sbin/lsof',['-p',String(process.pid)],{encoding:'utf8'});
        const dbLines=lsof.split('\\n').filter(line=>/\\.db(?:[- ]|$)/.test(line));
        if(!dbLines.length || dbLines.some(line=>!line.includes(process.env.MC667_ROOT))) throw new Error('store isolation failed');
        audit({phase:'lsof',dbLines});
        if(start===2 && mode==='late-start-end') audit({phase:'hold',what:'start2 until end1',result:await capped(end1Delivered.promise,60000)});
        if(start===2 && mode==='start-before-end') audit({phase:'hold',what:'start2 until ctx2',result:await capped(ctx2Returned.promise,60000)});
      }
      audit({phase:name,pass,end,start});
      const abort=ctx.abort;
      const wrapped=Object.assign(Object.create(ctx),{abort:()=>{audit({phase:'abort',hook:name});return abort();}});
      const before=name==='before_provider_request'?JSON.stringify(event.payload):undefined;
      const result=await handler(event,wrapped);
      if(before!==undefined && before!==JSON.stringify(event.payload)) throw new Error('dispatch changed provider bytes');
      audit({phase:name+'-end',pass,end,start,managed:name==='context'?/MANAGED667|§\\d+§/.test(JSON.stringify(result?.messages ?? null)):undefined});
      if(name==='agent_end' && end===1 && ++finished.end1===registrations.agent_end) end1Delivered.resolve();
      if(name==='agent_start' && start===2 && ++finished.start2===registrations.agent_start) start2Delivered.resolve();
      if(name==='context' && pass===1 && mode==='abort-before-dispatch') {
        // The user aborts after the context result returned, before dispatch.
        audit({phase:'probe-abort-after-context'});
        abort();
      }
      if(name==='context' && pass===2 && mode!=='abort-before-dispatch') {
        ctx2Returned.resolve();
        audit({phase:'hold',what:'dispatch2 until end1+start2',result:await capped(Promise.all([end1Delivered.promise,start2Delivered.promise]),5000)});
      }
      return result;
    });
    };
    if(key==='appendEntry') return (type,data)=>{audit({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await guard(proxied);
}
`,
);
const usage = { input_tokens: 1000, output_tokens: 10 };
mock.setDefault({ text: "mock reply", usage });
mock.addMatcher((body) => {
	appendFileSync(
		join(iso.baseDir, "audit.jsonl"),
		JSON.stringify({ at: Date.now(), phase: "wire", body }) + "\n",
	);
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
	const secondEnd = rpc.waitForEvent((e) => e.type === "agent_end", {
		timeoutMs: 120000,
	});
	await command("prompt", { message: "SECOND667" });
	await secondEnd;
	// Let detached extension notifications and the buffered plugin log settle.
	await new Promise((r) => setTimeout(r, 2000));
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
	const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	const fenceLog = log
		.split("\n")
		.filter((line) =>
			/attributed to an earlier run|turn refused|DISCARDED CONTEXT RESULT/.test(
				line,
			),
		)
		.map((line) => line.replace(/^\S+\s+/, "").slice(0, 240));
	const summary = {
		version,
		hostPackage: hostDir,
		mode,
		fullPlugin,
		isolatedEnvironment,
		root: iso.baseDir,
		pid: host.pid,
		requests: requests.length,
		everyRequestManaged: wire.every((row) => row.managed),
		wire,
		refusals: audit
			.filter(
				(row) =>
					row.phase === "entry" && row.type === "magic-context-turn-refused",
			)
			.map((row) => row.data.message),
		aborts: audit.filter((row) => row.phase === "abort").length,
		holds: audit
			.filter((row) => row.phase === "hold")
			.map(
				(row) =>
					`${row.what}: ${row.result === "timeout" ? "timeout" : "released"}`,
			),
		fenceLog,
		order: audit
			.filter((row) =>
				[
					"agent_start",
					"agent_end-arrived",
					"agent_end",
					"context",
					"context-end",
					"before_provider_request",
					"probe-abort-after-context",
					"abort",
					"wire",
					"entry",
				].includes(row.phase),
			)
			.map((row) =>
				[
					row.phase,
					row.pass ?? row.end ?? row.start ?? "",
					row.willContinue === undefined
						? ""
						: `willContinue=${row.willContinue}`,
				]
					.filter(Boolean)
					.join(" "),
			),
		dbLines,
	};
	const evidence = join(repo, "local-ignore/issue-667-review/host");
	mkdirSync(evidence, { recursive: true });
	const name = `${mode}${fullPlugin ? "-plugin" : ""}-${hostDir}`;
	writeFileSync(
		join(evidence, `${name}.json`),
		JSON.stringify({ summary, audit, requests }, null, 2) + "\n",
	);
	writeFileSync(join(evidence, `${name}-lsof.txt`), lsof);
	writeFileSync(join(evidence, `${name}-mc.log`), log);
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
