import { afterEach, expect, spyOn, test } from "bun:test";
import * as diagnostic from "./omp-diagnostic-context";
import { isOmpDumpContextStack } from "./omp-diagnostic-context";
import { PiContextSupersededError, registerPiGuardedContext } from "./pi-context-refusal";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const dumpStack = `Error
    at emitContext (/tmp/host/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:2015:38)
    at #formatLlmRequestJson (/tmp/host/node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:13436:34)
    at dumpLlmRequestToTmpDir (/tmp/host/node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:13431:40)`;

afterEach(() => {
  __setPiHarnessKindForTesting(undefined);
});

function harness(handler: Parameters<typeof registerPiGuardedContext>[1], kind: "omp" | "pi" = "omp") {
  __setPiHarnessKindForTesting(kind);
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const entries: unknown[] = [];
  const notices: unknown[] = [];
  let aborts = 0;
  registerPiGuardedContext({
    on: (name: string, fn: (...args: never[]) => unknown) => handlers.set(name, fn),
    appendEntry: (_type: string, data: unknown) => entries.push(data),
  } as never, handler);
  const ctx = { ...fakeContext("issue-668"), ui: { notify: (...args: unknown[]) => notices.push(args) }, abort: () => aborts++ };
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
  return { emit, entries, notices, get aborts() { return aborts; } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("issue 668: only the pinned OMP dump frames identify a diagnostic", () => {
  expect(isOmpDumpContextStack(dumpStack)).toBe(true);
  expect(isOmpDumpContextStack(dumpStack.replaceAll("/", "\\"))).toBe(true);
  expect(isOmpDumpContextStack(dumpStack.replace("dumpLlmRequestToTmpDir", "dumpSessionArchiveToTmpDir"))).toBe(false);
  expect(isOmpDumpContextStack(dumpStack.replace("#formatLlmRequestJson", "prepareProviderCall"))).toBe(false);
  expect(isOmpDumpContextStack(dumpStack.replaceAll("@oh-my-pi/pi-coding-agent", "extension"))).toBe(false);
  expect(isOmpDumpContextStack(undefined)).toBe(false);
});

test("issue 668: diagnostic snapshots bypass all handler writes and leave a live pass owned", async () => {
  const held = deferred();
  const entered = deferred();
  let calls = 0;
  let ownerChecks = 0;
  const h = harness(async (event, _ctx, budget) => {
    calls++;
    entered.resolve();
    await held.promise;
    budget.assertOutcome();
    ownerChecks++;
    return { messages: event.messages };
  });
  h.emit("agent_start");
  const live = [userMessage("live", 1)];
  const pending = h.emit("context", { messages: live });
  await entered.promise;
  const detect = spyOn(diagnostic, "isOmpDumpContext").mockReturnValue(true);
  try {
    const raw = [userMessage("snapshot", 2)];
    const result = await h.emit("context", { messages: raw });
    expect(result).toEqual({ messages: raw });
    expect((result as { messages: unknown[] }).messages).toBe(raw);
    held.resolve();
    await pending;
    h.emit("before_provider_request", { payload: { messages: [{ role: "user", content: "live" }] } });
    expect(calls).toBe(1);
    expect(ownerChecks).toBe(1);
    expect(h.entries).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.aborts).toBe(0);
  } finally { held.resolve(); detect.mockRestore(); }
});

test("issue 668: an idle diagnostic does not mint a dispatch receipt", async () => {
  let writes = 0;
  const h = harness(async event => { writes++; return { messages: event.messages }; });
  const detect = spyOn(diagnostic, "isOmpDumpContext").mockReturnValue(true);
  try {
    await h.emit("context", { messages: [userMessage("dump", 1)] });
    expect(writes).toBe(0);
    expect(h.entries).toEqual([]);
    h.emit("before_provider_request", { payload: { messages: [] } });
    expect(h.aborts).toBe(1);
    expect(JSON.stringify(h.entries)).toContain("no context pass ran");
  } finally { detect.mockRestore(); }
});

test("issue 668: real conflict fallback and retries refuse without revoking the newer receipt", async () => {
  const held = deferred();
  const entered = deferred();
  let calls = 0;
  const h = harness(async (event, _ctx, budget) => {
    if (++calls === 1) { entered.resolve(); await held.promise; }
    budget.assertOutcome();
    return { messages: event.messages };
  });
  h.emit("agent_start");
  const raw = [userMessage("loser", 1)];
  const old = Promise.resolve(h.emit("context", { messages: raw }));
  await entered.promise;
  const newer = [userMessage("managed winner", 2)];
  const next = Promise.resolve(h.emit("context", { messages: newer }));
  held.resolve();
  await expect(old).rejects.toBeInstanceOf(PiContextSupersededError);
  await next;
  expect(raw).toHaveLength(2);
  expect(JSON.stringify(newer)).not.toContain("Magic Context refused this request");
  for (const payload of [
    { messages: raw },
    { input: raw.map(message => ({ role: "user", content: message.content })) },
  ]) h.emit("before_provider_request", { payload });
  expect(h.aborts).toBe(2);
  expect(JSON.stringify(h.entries)).toContain("superseded context fallback is not a managed request");
  h.emit("before_provider_request", { payload: { messages: newer } });
  expect(h.aborts).toBe(2);
  await h.emit("context", { messages: [userMessage("later clean pass", 3)] });
  h.emit("before_provider_request", { payload: { input: "later clean pass" } });
  expect(h.aborts).toBe(2);
  h.emit("before_provider_request", { payload: { messages: raw } });
  expect(h.aborts).toBe(3);
});

for (const kind of ["pi", "omp-side", "omp-latched"] as const) {
  test(`issue 668: no fallback sentinel when dispatch cannot inspect it (${kind})`, async () => {
    const h = harness(async (_event, _ctx, _budget) => {
      throw new PiContextSupersededError("conflict");
    }, kind === "pi" ? "pi" : "omp");
    const side = [
      { role: "developer", attribution: "agent", content: "<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>", timestamp: 1 },
      { ...userMessage("side prompt", 2), attribution: "agent" },
    ];
    if (kind === "omp-latched") {
      await expect(Promise.resolve(h.emit("context", { messages: side }))).rejects.toThrow("conflict");
    }
    const messages = kind === "omp-side" ? side : [userMessage("normal", 3)];
    const length = messages.length;
    await expect(Promise.resolve(h.emit("context", { messages }))).rejects.toThrow("conflict");
    expect(messages).toHaveLength(length);
    expect(JSON.stringify(messages)).not.toContain("Magic Context refused this request");
  });
}
