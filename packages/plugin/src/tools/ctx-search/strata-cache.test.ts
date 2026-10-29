import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { insertMemory, updateMemoryStatus } from "../../features/magic-context/memory/storage-memory";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS, strataAskConnectionForProject, strataAskConnectionFromConfig } from "./strata-ask";
import { composeSlotUser, docsSectionOf, drainPendingChanges, maintainCache, rebuildCache, renderDocsSection } from "./strata-cache";
import PROMPTS from "./strata-prompts.json";

const HEADER = "【项目参考文档】";
const NOTICE = "本节为本项目参考文档，属记忆库之组成部分；非记忆条目，不计入记忆库条数。";
const FOOTER = "【参考文档终】";
const CHANGE_LOG = "【变更流水】";
const WATERMARK = "本库共 1 条，截至 #1，重建于 2026-10-30T00:00:00.000Z，变更水位 #0";

function withDocs(run: (directory: string) => void): void {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-docs-"));
    try {
        run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe("reference document section", () => {
    it("keeps the watermark last, puts docs after memory and before acknowledgement, and round-trips (C1, C3, C5)", () => {
        withDocs((directory) => {
            const text = `original\n\n${FOOTER}\nstill original`;
            writeFileSync(join(directory, "guide.md"), text);
            const docs = renderDocsSection(directory, ["guide.md"], 4000)!;
            const blocks = "#1 [OPS_RULES] 〔2026-10-30T00:00:00.000Z〕：\nmemory";
            const user = composeSlotUser(PROMPTS.intro, blocks, docs.section, PROMPTS.ackRequest, WATERMARK);
            expect(user.slice(user.lastIndexOf("\n") + 1)).toBe(WATERMARK);
            expect(user.indexOf(blocks)).toBeLessThan(user.indexOf(docs.section));
            expect(user.indexOf(docs.section)).toBeLessThan(user.indexOf(PROMPTS.ackRequest));
            expect(docs.section.startsWith(`${HEADER}\n${NOTICE}`)).toBe(true);
            expect(docs.section.endsWith(FOOTER)).toBe(true);
            expect(docs.section).toContain(`〔guide.md〕\n${text}`);
            expect(docsSectionOf(user)).toBe(docs.section);
            expect(docs.files).toEqual(["guide.md"]);
            expect(docs.truncated).toEqual([false]);
        });
    });

    it("leaves the legacy composition byte-identical for empty or absent docs (C2)", () => {
        const oldExpression = [PROMPTS.intro, "memory block", PROMPTS.ackRequest, WATERMARK].filter(Boolean).join("\n\n");
        expect(renderDocsSection("/unused", [], 4000)).toBeNull();
        expect(composeSlotUser(PROMPTS.intro, "memory block", null, PROMPTS.ackRequest, WATERMARK)).toBe(oldExpression);
        expect(composeSlotUser(PROMPTS.intro, "memory block", "", PROMPTS.ackRequest, WATERMARK)).toBe(oldExpression);
        expect(docsSectionOf(oldExpression)).toBeNull();
        expect(docsSectionOf(`${HEADER}\nmissing footer`)).toBeNull();
        expect(docsSectionOf(`before ${HEADER}\nbody\n${FOOTER} after`)).toBe(`${HEADER}\nbody\n${FOOTER}`);
    });

    it("reads project-relative and absolute files in order and skips missing files and directories", () => {
        withDocs((directory) => {
            const absolute = join(directory, "second.md");
            writeFileSync(join(directory, "first.md"), "first raw text\n");
            writeFileSync(absolute, "second raw text");
            const docs = renderDocsSection(directory, ["missing.md", "first.md", directory, absolute], 4000)!;
            expect(docs.files).toEqual(["first.md", absolute]);
            expect(docs.truncated).toEqual([false, false]);
            expect(docs.section.indexOf("first raw text")).toBeLessThan(docs.section.indexOf("second raw text"));
            expect(renderDocsSection(directory, ["missing.md", directory], 4000)).toBeNull();
        });
    });

    it("enforces the full-section budget, truncates at a line boundary and notes remaining files", () => {
        withDocs((directory) => {
            const lines = Array.from({ length: 80 }, (_, index) => `line ${index}: ${"example words ".repeat(6)}\n`);
            const text = lines.join("");
            const fragment = lines.slice(0, 5).join("");
            writeFileSync(join(directory, "first.md"), text);
            writeFileSync(join(directory, "second.md"), "not loaded");
            const sample = `${HEADER}\n${NOTICE}\n\n〔first.md（已截断：原文 ${text.length} 字符，载入 ${fragment.length} 字符）〕\n${fragment}\n\n〔second.md（未载：预算已用尽）〕\n\n${FOOTER}`;
            const budget = estimateTokens(sample);
            const docs = renderDocsSection(directory, ["first.md", "second.md"], budget)!;
            expect(estimateTokens(docs.section)).toBeLessThanOrEqual(budget);
            expect(docs.files).toEqual(["first.md"]);
            expect(docs.truncated).toEqual([true]);
            const label = /〔first\.md（已截断：原文 (\d+) 字符，载入 (\d+) 字符）〕\n/.exec(docs.section)!;
            const loaded = Number(label[2]);
            expect(Number(label[1])).toBe(text.length);
            expect(loaded).toBeGreaterThan(0);
            expect(loaded).toBeLessThan(text.length);
            expect(text.slice(0, loaded).endsWith("\n")).toBe(true);
            expect(docs.section).toContain(`${label[0]}${text.slice(0, loaded)}`);
            expect(docs.section).toContain("（未载：预算已用尽）");
            expect(docs.section.endsWith(FOOTER)).toBe(true);
            expect(renderDocsSection(directory, ["first.md"], 1)).toBeNull();
        });
    });
});

describe("project document routing", () => {
    const raw = {
        enabled: true, base_url: "http://localhost:9", api_key: "key", model: "model",
        project: "git:main", slot_file: "main.bin", prefix_path: "/tmp/main.json",
        max_tokens: 2048, timeout_ms: 60000, context_docs: ["main-private.md"],
        context_docs_budget_tokens: 1234,
        targets: [
            { project: "git:other", slot_file: "other.bin", prefix_path: "/tmp/other.json", context_docs: ["other.md"] },
            { project: "git:empty", slot_file: "empty.bin", prefix_path: "/tmp/empty.json" },
        ],
    };

    it("uses a target's own list, not the main project's list", () => {
        const config = { memory: { strata_ask: raw } };
        expect(strataAskConnectionForProject(config, "git:main")?.contextDocs).toEqual(["main-private.md"]);
        expect(strataAskConnectionForProject(config, "git:other")?.contextDocs).toEqual(["other.md"]);
        expect(strataAskConnectionForProject(config, "git:other")?.contextDocsBudgetTokens).toBe(1234);
    });

    it("defaults an unspecified target list to empty and validates the budget fallback", () => {
        expect(strataAskConnectionForProject({ memory: { strata_ask: raw } }, "git:empty")?.contextDocs).toEqual([]);
        for (const budget of [undefined, 0, 32769, 1.5, Infinity]) {
            const connection = strataAskConnectionFromConfig({ memory: { strata_ask: { ...raw, context_docs_budget_tokens: budget } } });
            expect(connection?.contextDocsBudgetTokens).toBe(DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS);
        }
    });
});

type TestMessage = { role: string; content: string };

type CacheFixture = {
    directory: string;
    prefixPath: string;
    pendingPath: string;
    project: string;
    db: NonNullable<ReturnType<typeof openDatabase>>;
    countQuestions: string[];
    failNextChecks: (count: number) => void;
};

async function withCacheFixture(run: (fixture: CacheFixture) => Promise<void>, docs = ["guide.md"]): Promise<void> {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-strata-cache-"));
    const directory = join(root, "project");
    const configHome = join(root, "config");
    const dataHome = join(root, "data");
    const prefixPath = join(root, "slot", "prefix.json");
    const pendingPath = join(dirname(prefixPath), "pending-changes.jsonl");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(configHome, "cortexkit"), { recursive: true });
    mkdirSync(dirname(prefixPath), { recursive: true });
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    let failingChecks = 0;
    const countQuestions: string[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            if (new URL(request.url).pathname === "/slots/0") return Response.json({ n_restored: 1 });
            const body = await request.json() as { messages: TestMessage[] };
            const messages = body.messages;
            if (messages.length === 2) return Response.json({ choices: [{ message: { content: "已加载" } }] });
            countQuestions.push(messages.at(-1)!.content);
            const line = messages[1]!.content.split("\n").at(-1)!;
            const count = Number(/^本库共 (\d+) 条/.exec(line)![1]);
            const answer = failingChecks > 0 ? count + 1 : count;
            if (failingChecks > 0) failingChecks--;
            return Response.json({ choices: [{ message: { content: String(answer) } }] });
        },
    });
    try {
        const project = resolveProjectIdentityForSession(directory)!;
        writeFileSync(join(configHome, "cortexkit", "magic-context.jsonc"), JSON.stringify({
            memory: { strata_ask: {
                enabled: true, base_url: String(server.url).replace(/\/$/, ""), api_key: "test-key",
                model: "test-model", project, slot_file: "test.bin", prefix_path: prefixPath,
                context_docs: docs, context_docs_budget_tokens: 4000,
            } },
        }));
        const db = openDatabase();
        if (!db) throw new Error("isolated test database unavailable");
        await run({ directory, prefixPath, pendingPath, project, db, countQuestions, failNextChecks: (count) => { failingChecks = count; } });
    } finally {
        server.stop(true);
        await closeDatabase();
        if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfig;
        if (previousData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousData;
        rmSync(root, { recursive: true, force: true });
    }
}

function prefixUser(path: string): string {
    return (JSON.parse(readFileSync(path, "utf8")) as TestMessage[])[1]!.content;
}

function writeChange(path: string, event: object): void {
    writeFileSync(path, `${JSON.stringify({ ...event, ts: "2026-10-30T00:00:00.000Z" })}\n`);
}

describe("rebuild and append", () => {
    it("creates for low memory plus docs and preserves docs while appending the real ledger (C4)", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            const first = insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "first memory" });
            const fakeId = first.id + 1;
            const text = `reference\n\n${PROMPTS.ackRequest}\n\n${CHANGE_LOG}\nnot a real ledger\n\n#${fakeId} [OPS_RULES] 〔2026-10-30T00:00:00.000Z〕：\nnot a memory`;
            writeFileSync(join(directory, "guide.md"), text);
            expect((await maintainCache(directory)).action).toBe("created");
            const initial = prefixUser(prefixPath);
            const docs = docsSectionOf(initial)!;
            expect(docs).toContain(text);

            writeFileSync(join(directory, "guide.md"), "changed on disk");
            expect((await maintainCache(directory)).detail).toBe("unchanged");
            expect(prefixUser(prefixPath)).toBe(initial);

            const second = insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "second memory" });
            expect(second.id).toBe(fakeId);
            writeChange(pendingPath, { op: "add", id: second.id });
            const added = await drainPendingChanges(directory);
            expect(added.action).toBe("appended");
            expect(added.watermark?.count).toBe(2);
            let user = prefixUser(prefixPath);
            expect(docsSectionOf(user)).toBe(docs);
            const afterAck = user.slice(user.lastIndexOf(PROMPTS.ackRequest) + PROMPTS.ackRequest.length);
            expect(afterAck.split(CHANGE_LOG)).toHaveLength(2);
            expect(user.split("\n").at(-1)).toStartWith("本库共 2 条");

            updateMemoryStatus(db, second.id, "archived");
            writeChange(pendingPath, { op: "remove", id: second.id, kind: "archive" });
            const removed = await drainPendingChanges(directory);
            expect(removed.action).toBe("appended");
            expect(removed.watermark?.count).toBe(1);
            user = prefixUser(prefixPath);
            expect(docsSectionOf(user)).toBe(docs);
            expect(user.slice(user.lastIndexOf(PROMPTS.ackRequest) + PROMPTS.ackRequest.length).split(CHANGE_LOG)).toHaveLength(2);
            expect(user.split("\n").at(-1)).toStartWith("本库共 1 条");

            expect((await rebuildCache(directory, "daily-compaction")).action).toBe("rebuilt");
            expect(docsSectionOf(prefixUser(prefixPath))).toContain("changed on disk");
        });
    });

    it("retries the count self-check once with docs before publishing", async () => {
        await withCacheFixture(async ({ directory, prefixPath, project, db, countQuestions, failNextChecks }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            failNextChecks(1);
            expect((await maintainCache(directory)).action).toBe("created");
            expect(countQuestions).toHaveLength(2);
            expect(countQuestions[0]).toBe(countQuestions[1]);
            expect(countQuestions[0]).toContain("变更流水中现行有效之条目（含新增、不含已作废者）");
            expect(countQuestions[0]).toContain("参考文档一节不计入");
            expect(docsSectionOf(prefixUser(prefixPath))).not.toBeNull();
        });
    });

    it("does not publish a prefix or consume pending events if both checks fail", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db, countQuestions, failNextChecks }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const memory = insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            writeChange(pendingPath, { op: "add", id: memory.id });
            const pending = readFileSync(pendingPath, "utf8");
            failNextChecks(2);
            expect((await rebuildCache(directory, "test")).action).toBe("error");
            expect(countQuestions).toHaveLength(2);
            expect(existsSync(prefixPath)).toBe(false);
            expect(readFileSync(pendingPath, "utf8")).toBe(pending);
        });
    });

    it("still skips low-memory cache creation when no documents are configured", async () => {
        await withCacheFixture(async ({ directory, prefixPath, project, db, countQuestions }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            const result = await maintainCache(directory);
            expect(result.action).toBe("skipped");
            expect(result.detail).toBe("below-threshold");
            expect(existsSync(prefixPath)).toBe(false);
            expect(countQuestions).toHaveLength(0);
        }, []);
    });

    it("does not retry the self-check without a docs section", async () => {
        await withCacheFixture(async ({ directory, prefixPath, project, db, countQuestions, failNextChecks }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            failNextChecks(1);
            expect((await rebuildCache(directory, "test")).action).toBe("error");
            expect(countQuestions).toHaveLength(1);
            expect(existsSync(prefixPath)).toBe(false);
        }, []);
    });
});
