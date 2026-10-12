#!/usr/bin/env bun
// Exercise the pinned OMP SDK and its real context/provider pipelines in disposable roots.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const taskRoot = process.env.MC668_ROOT;
if (!taskRoot || !taskRoot.includes("/magic-context/")) throw new Error("MC668_ROOT must name the throwaway task root");
const variant = process.argv[2] ?? "master";
const root = realpathSync(process.env.MC668_RUN_ROOT!);
const repo = resolve(import.meta.dir, "../../../..");
mkdirSync(root, { recursive: true });
Object.assign(process.env, {
  HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root,
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  XDG_RUNTIME_DIR: join(root, "runtime"), PI_CODING_AGENT_DIR: join(root, ".omp/agent"),
  MAGIC_CONTEXT_STORAGE_DIR: join(root, "data/cortexkit/magic-context"),
  OPENCODE_DB: join(root, "data/opencode/opencode.db"),
  MAGIC_CONTEXT_LOG_PATH: join(root, "magic-context.log"),
  PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_NO_TITLE: "1", MC_E2E_KEEP: "1",
});
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "PI_CODING_AGENT_DIR", "MAGIC_CONTEXT_STORAGE_DIR"]) mkdirSync(process.env[key]!, { recursive: true });
const audit: unknown[] = [];
const record = (value: unknown) => { audit.push(value); writeFileSync(join(root, "audit.json"), JSON.stringify(audit, null, 2)); };
const host = join(taskRoot, "host/node_modules/@oh-my-pi/pi-coding-agent");
const { MockProvider } = await import("../../../../packages/e2e-tests/src/mock-provider/server");
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({ text: "mock reply", usage: { input_tokens: 1000, output_tokens: 10 } });
mock.addMatcher(body => { record({ phase: "wire", body }); return undefined; });
const agentDir = process.env.PI_CODING_AGENT_DIR!;
writeFileSync(join(agentDir, "config.yml"), JSON.stringify({
  defaultProvider: "mock", defaultModel: "mock-model", enabledModels: ["mock/mock-model"],
  tools: { xdev: false, intentTracing: false }, compaction: { enabled: false },
  advisor: { enabled: false }, autolearn: { enabled: false }, retry: { enabled: false },
  quietStartup: true, enableInstallTelemetry: false,
}));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: {
  api: process.argv.includes("--responses") ? "openai-responses" : "anthropic-messages", baseUrl: baseURL, apiKey: "test-key-not-real",
  models: [{ id: "mock-model", name: "Mock Model", input: ["text"], contextWindow: 1000000,
    maxTokens: 8192, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
mkdirSync(join(root, "config/cortexkit"), { recursive: true });
writeFileSync(join(root, "config/cortexkit/magic-context.jsonc"), JSON.stringify({
  enabled: true, memory: { enabled: false }, embedding: { provider: "off" }, dreamer: { disable: true },
  historian: { model: "mock/mock-model" },
}));
const plugin = process.env.MC668_PLUGIN ?? join(repo, "packages/pi-plugin/dist/index.js");
const responses = process.argv.includes("--responses");
const conflict = process.argv.includes("--conflict");
const probe = join(root, "probe.mjs");
writeFileSync(probe, `
import { appendFileSync } from 'node:fs';
import magic from ${JSON.stringify(plugin)};
const log = value => appendFileSync(${JSON.stringify(join(root, "hooks.jsonl"))}, JSON.stringify(value)+'\\n');
export default async pi => {
  const proxy=new Proxy(pi,{get(target,key){
    if(key==='on') return (name,handler)=>target.on(name,async (event,ctx)=>{
      if(name==='context') {
        const previous=Error.stackTraceLimit;Error.stackTraceLimit=60;
        log({phase:name,eventKeys:Reflect.ownKeys(event).map(String),ctxKeys:Reflect.ownKeys(ctx).map(String),stack:new Error().stack,messages:event.messages});
        Error.stackTraceLimit=previous;
      }
      if(name==='before_provider_request') {
        if(globalThis.__mc668ReplayPayload) { const payload=globalThis.__mc668ReplayPayload;delete globalThis.__mc668ReplayPayload;for(const key of Object.keys(event.payload))delete event.payload[key];Object.assign(event.payload,payload); }
        if(JSON.stringify(event.payload).includes('live turn while diagnostic')) globalThis.__mc668FallbackPayload=structuredClone(event.payload);
        log({phase:name,payload:event.payload});
        await globalThis.__mc668DispatchGate?.(event.payload);
      }
      const wrapped=Object.defineProperties(Object.create(ctx),{abort:{value:()=>{log({phase:'abort',hook:name});return ctx.abort();}},ui:{value:Object.defineProperty(Object.create(ctx.ui),'notify',{value:(text,level)=>{log({phase:'notify',text,level});return ctx.ui.notify(text,level);}})}});
      const pending=handler(event,wrapped);
      if(name==='context') globalThis.__mc668Entered?.();
      return Promise.resolve(pending).then(result=>{log({phase:name+'-end',result});return result;},error=>{log({phase:name+'-error',error:String(error)});throw error;});
    });
    if(key==='appendEntry') return (type,data)=>{log({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await magic(proxy);
};
`);
const { prepareContextDatabase } = await import("../../../../packages/e2e-tests/src/prepare-context-db");
prepareContextDatabase(process.env.XDG_DATA_HOME!);
process.title = "omp";
const { createAgentSession } = await import(join(host, "src/sdk.ts"));
const { SessionManager } = await import(join(host, "src/session/session-manager.ts"));
let session: any;
const { initializeExtensions } = await import(join(host, "src/modes/runtime-init.ts"));
const attach = async () => {
  await initializeExtensions(session, {
    mode: "rpc",
    reportRuntimeError: (error: unknown) => record({ phase: "banner", error }),
    reportSendError: (_action: string, error: unknown) => record({ phase: "send-error", error: String(error) }),
  });
  session.subscribe((event: any) => { if (["agent_start", "agent_end"].includes(event.type)) record({ phase: event.type }); });
};
const isolation = (label: string) => {
  const lsof = execFileSync("/usr/sbin/lsof", ["-p", String(process.pid)], { encoding: "utf8" });
  writeFileSync(join(root, `lsof-${label}.txt`), lsof);
  const files = lsof.split("\n").filter(line => /(?:\.db(?:[- ]|$)|\/\.omp\/|\/\.pi\/|\/\.config\/)/.test(line));
  if (files.some(line => !line.includes(root))) throw new Error("host store isolation failed");
  record({ phase: "isolation", label, pid: process.pid, files });
};
const { Database } = await import("bun:sqlite");
const durable = () => {
  const rows: Record<string, unknown> = {};
  for (const name of ["context.db", "store.db"]) {
    const path = join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, name);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      for (const table of tables) rows[`${name}:${table.name}`] = db.query(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all();
    } finally { db.close(); }
  }
  return JSON.stringify({ rows, session: session.sessionFile && readFileSync(session.sessionFile, "utf8") });
};
try {
  record({ phase: "host", version: JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version, root, variant });
  ({ session } = await createAgentSession({ cwd: root, agentDir, additionalExtensionPaths: [probe], disableExtensionDiscovery: true }));
  await attach(); isolation("start");
  await session.prompt("warm throwaway session");
  await session.flushToDisk();
  const sessionFile = session.sessionFile;
  await session.dispose();
  ({ session } = await createAgentSession({ cwd: root, agentDir, sessionManager: await SessionManager.open(sessionFile), additionalExtensionPaths: [probe], disableExtensionDiscovery: true }));
  await attach();
  record({ phase: "resumed", sessionFile });
  isolation("resumed");
  const beforeIdle = durable();
  record({ phase: "idle-dump-start" });
  const idleDump = await session.dumpLlmRequestToTmpDir();
  const idleUnchanged = beforeIdle === durable();
  record({ phase: "idle-dump-end", path: idleDump, bytes: idleDump && readFileSync(idleDump).length, durableUnchanged: idleUnchanged });
  if (variant === "fixed" && !idleUnchanged) throw new Error("diagnostic changed durable state");
  record({ phase: "overlap-start" });
  let entered!: () => void;
  const inPass = new Promise<void>(resolve => { entered = resolve; });
  (globalThis as any).__mc668Entered = entered;
  let releaseDispatch!: () => void;
  const dispatchHeld = new Promise<void>(resolve => { releaseDispatch = resolve; });
  if (conflict) (globalThis as any).__mc668DispatchGate = (payload: unknown) => JSON.stringify(payload).includes("live turn while diagnostic") ? dispatchHeld : undefined;
  const turn = session.prompt("live turn while diagnostic is emitted");
  await inPass;
  delete (globalThis as any).__mc668Entered;
  const fallback = conflict
    ? session.convertMessagesToLlm([{ role: "user", content: "replacement live history", timestamp: Date.now() }])
    : session.dumpLlmRequestToTmpDir();
  const overlapDump = await fallback;
  if (conflict) {
    const { streamSimple } = await import(join(taskRoot, "host/node_modules/@oh-my-pi/pi-ai/src/index.ts"));
    const reply = await streamSimple(session.model, { messages: overlapDump, systemPrompt: "managed replacement request" }, session.prepareSimpleStreamOptions({ apiKey: "test-key-not-real", maxTokens: 100 }, session.model.provider)).result();
    record({ phase: "newer-request", stopReason: reply.stopReason });
  }
  releaseDispatch();
  delete (globalThis as any).__mc668DispatchGate;
  await turn;
  record({ phase: "overlap-end", path: typeof overlapDump === "string" ? overlapDump : undefined, bytes: typeof overlapDump === "string" ? readFileSync(overlapDump).length : undefined, conflict });
  const storedSession = readFileSync(session.sessionFile, "utf8");
  record({ phase: "sentinel-not-persisted", absent: !storedSession.includes("Magic Context refused this request"), sessionBytes: storedSession.length });
  if (storedSession.includes("Magic Context refused this request")) throw new Error("fallback sentinel persisted");
  if (conflict && variant === "fixed") {
    (globalThis as any).__mc668ReplayPayload = (globalThis as any).__mc668FallbackPayload;
    await session.prompt("retry marked body");
    await session.prompt("later clean turn");
  }
  isolation("end");
} finally {
  await session?.dispose();
  await mock.stop();
  console.log(JSON.stringify({ root, audit }, null, 2));
}
