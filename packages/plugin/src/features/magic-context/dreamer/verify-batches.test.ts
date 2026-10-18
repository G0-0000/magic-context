import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { insertMemory } from "../memory";
import {
    getMemoryVerifications,
    recordMemoryVerifications,
} from "../memory/storage-memory-verifications";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { acquireLease } from "./lease";
import { createDreamTokenBudget, DreamTokenBudgetExceeded } from "./token-budget";
import { runVerify, VERIFY_TOKENS_PER_MEMORY, verifyBatchTokenBudget } from "./verify";
import { parsePartialVerifyManifest, seedVerifyCandidates } from "./verify-prompt";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(count: number) {
    const directory = createTestTempDirFromPath(path.join(tmpdir(), "mc-verify-batches-"));
    dirs.push(directory);
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "src/fact.ts"), "export const currentFact = 1;\n");
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const ids = Array.from(
        { length: count },
        (_, i) =>
            insertMemory(db, {
                projectPath: "git:batch-fixture",
                category: "ARCHITECTURE",
                content: `currentFact backs fact ${i}`,
            }).id,
    );
    for (const id of ids) recordMemoryVerifications(db, id, ["src/fact.ts"], 1_000);
    expect(acquireLease(db, "holder", "batch-test")).toBe(true);
    return {
        db,
        directory,
        ids,
        args: {
            db,
            projectIdentity: "git:batch-fixture",
            sessionDirectory: directory,
            holderId: "holder",
            leaseKey: "batch-test",
            deadline: Date.now() + 900_000,
            forceBroad: true,
        },
    };
}

function message(text: string, input = 0) {
    return {
        info: {
            role: "assistant",
            finish: "stop",
            tokens: { input },
            time: { created: Date.now() },
        },
        parts: [{ type: "text", text }],
    };
}

test("verify allocates at most 100k prompt tokens per input including a short batch", () => {
    expect(VERIFY_TOKENS_PER_MEMORY).toBe(100_000);
    expect(verifyBatchTokenBudget(5, 2_500_000)).toBe(500_000);
    expect(verifyBatchTokenBudget(1)).toBe(100_000);
    expect(verifyBatchTokenBudget(5, 40_000)).toBe(40_000);
    const guard = createDreamTokenBudget(verifyBatchTokenBudget(1));
    expect(guard.charge(80_000, 0, 0)).toBe("finalize");
    expect(guard.charge(20_000, 0, 0)).toBe("stop");
});

test("verify recovers only closed non-conflicting expected verdicts", () => {
    expect(
        parsePartialVerifyManifest('<verify><verified id="1"/><update id="2">cut', new Set([1, 2])),
    ).toMatchObject({ verified: [{ id: 1 }], updated: [] });
    expect(
        parsePartialVerifyManifest(
            '<verify><verified id="1"/><archive id="1"/><verified id="9"/>',
            new Set([1]),
        ),
    ).toMatchObject({ verified: [], archived: [] });
});

test("verify candidate lookup leaves backing mappings intact outside git", async () => {
    const f = fixture(1);
    try {
        const memories = [
            {
                id: 1,
                category: "ARCHITECTURE",
                content: "currentFact",
                mappedFiles: ["src/fact.ts"],
            },
        ];
        expect((await seedVerifyCandidates(memories, f.directory))[0].mappedFiles).toEqual([
            "src/fact.ts",
        ]);
    } finally {
        f.db.close();
    }
});

test("verify prefilters identifier candidates asynchronously without replacing backing mappings", async () => {
    const f = fixture(1);
    try {
        execFileSync("git", ["init", "--quiet"], { cwd: f.directory, windowsHide: true });
        execFileSync("git", ["add", "src/fact.ts"], { cwd: f.directory, windowsHide: true });
        const [memory] = await seedVerifyCandidates(
            [
                {
                    id: 1,
                    category: "ARCHITECTURE",
                    content: "currentFact is one",
                    mappedFiles: ["src/old.ts"],
                },
            ],
            f.directory,
        );
        expect(memory.candidates).toEqual(["src/fact.ts"]);
        expect(memory.mappedFiles).toEqual(["src/old.ts"]);
    } finally {
        f.db.close();
    }
});

test("fake provider emits five-memory progress and banks an interrupted verdict at the wall slice", async () => {
    const f = fixture(12);
    const sizes: number[] = [];
    const budgets: number[] = [];
    const progress: number[] = [];
    let text = "";
    let child = 0;
    let calls = 0;
    const realTimeout = globalThis.setTimeout;
    let sliceFiredAt = 0;
    // Speed up the real wall timer without replacing the retry or abort machinery.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: TimerHandler,
        ms?: number,
        ...args: unknown[]
    ) =>
        realTimeout(
            ms && ms >= 30_000
                ? (...values: unknown[]) => {
                      sliceFiredAt ||= Date.now();
                      (fn as (...a: unknown[]) => void)(...values);
                  }
                : fn,
            ms && ms >= 30_000 ? 120 : ms,
            ...args,
        )) as typeof setTimeout);
    try {
        const result = await runVerify({
            ...f.args,
            onProgress: (n) => progress.push(n),
            fallbackModels: ["fixture/fallback"],
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async (spec) => {
                    budgets.push(spec.metadata?.tokenBudget as number);
                    return { id: `child-${++child}` };
                },
                attempt: async (_handle, request) => {
                    calls++;
                    const ids = [
                        ...(request.body.parts?.[0] as { text: string }).text.matchAll(
                            /^\[(\d+)\]/gm,
                        ),
                    ].map((m) => Number(m[1]));
                    sizes.push(ids.length);
                    text = `<verify>${ids
                        .slice(0, child === 1 ? 5 : 1)
                        .map((id) => `<verified id="${id}" files="src/fact.ts"/>`)
                        .join("")}${child === 1 ? "</verify>" : ""}`;
                    if (child > 1) await new Promise(() => {});
                },
                collect: async () => ({
                    text,
                    messages: [message(text)],
                    usage: { input: 10, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(sizes).toEqual([5, 5]);
        expect(budgets).toEqual([500_000, 500_000]);
        expect(calls).toBe(2);
        expect(progress).toEqual([5, 6]);
        expect(result).toMatchObject({
            verified: 6,
            remaining: 6,
            complete: false,
            stopReason: "batch-timeout",
        });
        const stored = getMemoryVerifications(f.db, f.ids);
        expect([...stored.values()].filter((m) => m.verifiedAt > 1_000)).toHaveLength(6);
        console.log(
            `FAKE VERIFY: batch sizes=${sizes}; progress=${progress}; stop=${result.stopReason}; durable=6; fallback not started; settlement_tail_ms=${Date.now() - sliceFiredAt}`,
        );
    } finally {
        timer.mockRestore();
        f.db.close();
    }
});

/** Fixed provider trace: three 1,000-token code reads per memory, replayed each turn. */
function replayCost(batchSize: number, count: number) {
    let tokens = 0;
    for (let start = 0; start < count; start += batchSize) {
        let context = 2_000;
        for (let memory = start; memory < Math.min(count, start + batchSize); memory++) {
            for (let read = 0; read < 3; read++) {
                tokens += context;
                context += 1_000;
            }
        }
        tokens += context;
    }
    return tokens;
}

test("fixed replay fixture compares provider-reported tokens per verified memory", async () => {
    const f = fixture(20);
    let text = "";
    let spent = 0;
    const sizes: number[] = [];
    try {
        const result = await runVerify({
            ...f.args,
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async () => ({ id: `fixture-${sizes.length}` }),
                attempt: async (_h, request) => {
                    const ids = [
                        ...(request.body.parts?.[0] as { text: string }).text.matchAll(
                            /^\[(\d+)\]/gm,
                        ),
                    ].map((m) => Number(m[1]));
                    sizes.push(ids.length);
                    spent += replayCost(ids.length, ids.length);
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                },
                collect: async () => ({
                    text,
                    messages: [message(text, spent)],
                    usage: { input: spent, output: 0 },
                }),
                close: async () => {},
            } as never,
        });
        const before = replayCost(20, 20);
        expect(sizes).toEqual([5, 5, 5, 5]);
        expect(result.verified).toBe(20);
        expect(before).toBe(1_952_000);
        expect(spent).toBe(608_000);
        console.log(
            `FIXED TRACE: before=${before / 20} tokens/verified memory; after=${spent / result.verified}; verified=20/20 (synthetic usage, not live quota)`,
        );
    } finally {
        f.db.close();
    }
});

test("verify shares the run token ceiling across five children and records each child's spend", async () => {
    const f = fixture(30);
    const budgets: number[] = [];
    const updates: Array<{ sessionId?: string; spent: number }> = [];
    let text = "";
    let update: (s: { spent: number; finalizeFired: boolean; sessionId: string }) => void;
    try {
        const result = await runVerify({
            ...f.args,
            onBudgetUpdate: (s) => updates.push(s),
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async (spec) => {
                    budgets.push(spec.metadata.tokenBudget);
                    update = spec.metadata.onBudgetUpdate;
                    return { id: `budget-${budgets.length}` };
                },
                attempt: async (_h, request) => {
                    const ids = [...request.body.parts[0].text.matchAll(/^\[(\d+)\]/gm)].map((m) =>
                        Number(m[1]),
                    );
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                    update({
                        spent: 500_000,
                        finalizeFired: false,
                        sessionId: `budget-${budgets.length}`,
                    });
                },
                collect: async () => ({
                    text,
                    messages: [message(text, 500_000)],
                    usage: { input: 500_000, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(budgets).toEqual([500_000, 500_000, 500_000, 500_000, 500_000]);
        expect(result).toMatchObject({ verified: 25, remaining: 5, stopReason: "token-budget" });
        expect(new Set(updates.map((s) => s.sessionId)).size).toBe(5);
        console.log(
            "FAKE RUN CAP: 5 children x 500000 = 2500000 prompt tokens; no sixth child; 25 durable verdicts",
        );
    } finally {
        f.db.close();
    }
});

test("a failing fake provider exhausts one 500k envelope without retrying and banks its verdict", async () => {
    const f = fixture(20);
    let guard: ReturnType<typeof createDreamTokenBudget>;
    let update: (state: { spent: number; finalizeFired: boolean; sessionId: string }) => void;
    let calls = 0;
    let text = "";
    try {
        const result = await runVerify({
            ...f.args,
            fallbackModels: ["fixture/fallback"],
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async (spec) => {
                    guard = createDreamTokenBudget(spec.metadata.tokenBudget);
                    update = spec.metadata.onBudgetUpdate;
                    return { id: "failing-child" };
                },
                attempt: async (_h, request) => {
                    calls++;
                    const id = request.body.parts[0].text.match(/^\[(\d+)\]/m)[1];
                    text = `<verify><verified id="${id}" files="src/fact.ts"/>`;
                    for (let step = 0; step < 5; step++) {
                        const action = guard.charge(100_000, 0, 0);
                        update({ ...guard.snapshot(), sessionId: "failing-child" });
                        if (action === "stop")
                            throw new DreamTokenBudgetExceeded(
                                "failing-child",
                                guard.snapshot().spent,
                            );
                    }
                },
                collect: async () => ({
                    text,
                    messages: [message(text, guard.snapshot().spent)],
                    usage: { input: guard.snapshot().spent, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(calls).toBe(1);
        expect(guard!.snapshot().spent).toBe(500_000);
        expect(result).toMatchObject({ verified: 1, remaining: 19, stopReason: "token-budget" });
        console.log(
            "FAKE FAILING CAP: child spent=500000; calls=1; fallback=0; durable=1; stopped cleanly",
        );
    } finally {
        f.db.close();
    }
});

test("verify run slice is shared across batches, not renewed after progress", async () => {
    const f = fixture(25);
    let clock = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    let text = "";
    let children = 0;
    try {
        const result = await runVerify({
            ...f.args,
            onProgress: () => {
                clock += 240_000;
            },
            hiddenCompletionExecutor: {
                capabilities: { tools: true },
                open: async () => ({ id: `slice-${++children}` }),
                attempt: async (_h, request) => {
                    const ids = [...request.body.parts[0].text.matchAll(/^\[(\d+)\]/gm)].map((m) =>
                        Number(m[1]),
                    );
                    text = `<verify>${ids.map((id) => `<verified id="${id}" files="src/fact.ts"/>`).join("")}</verify>`;
                },
                collect: async () => ({
                    text,
                    messages: [message(text)],
                    usage: { input: 10, output: 10 },
                }),
                close: async () => {},
            } as never,
        });
        expect(children).toBe(1);
        expect(result).toMatchObject({ verified: 5, remaining: 20, stopReason: "deadline" });
    } finally {
        now.mockRestore();
        f.db.close();
    }
});
