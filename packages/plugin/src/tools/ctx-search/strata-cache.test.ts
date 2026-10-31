import { describe, expect, it, jest } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { insertMemory, updateMemoryStatus } from "../../features/magic-context/memory/storage-memory";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS, strataAskConnectionForProject, strataAskConnectionFromConfig } from "./strata-ask";
import {
    cacheLockDirectoryFor,
    composeSlotUser,
    docsSectionOf,
    drainPendingChanges,
    maintainCache,
    maintenanceStatePathFor,
    pendingChangesPathFor,
    rebuildCache,
    renderDocsSection,
    withCacheLock,
} from "./strata-cache";
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

const SLOT_FILE = "test.bin";
const PEER_SLOT_FILE = "peer.bin";

type CacheFixture = {
    directory: string;
    prefixPath: string;
    pendingPath: string;
    maintenancePath: string;
    lockDirectory: string;
    peerPendingPath: string;
    project: string;
    db: NonNullable<ReturnType<typeof openDatabase>>;
    countQuestions: string[];
    chatBodies: Array<Record<string, unknown>>;
    calls: string[];
    lockSeenDuringCalls: boolean[];
    failNextChecks: (count: number) => void;
    failRestore: (status: number | null, times?: number) => void;
};

/** Candidate files currently in a lock directory; empty when no one holds it. */
function lockCandidates(directory: string): string[] {
    try {
        return readdirSync(directory).sort();
    } catch {
        return [];
    }
}

/** A second slot in the same prefix directory, so isolation is observable. */
async function withCacheFixture(run: (fixture: CacheFixture) => Promise<void>, docs = ["guide.md"]): Promise<void> {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-strata-cache-"));
    const directory = join(root, "project");
    const peerDirectory = join(root, "peer");
    const configHome = join(root, "config");
    const dataHome = join(root, "data");
    const prefixPath = join(root, "slot", "prefix.json");
    const slotDirectory = dirname(prefixPath);
    const pendingPath = pendingChangesPathFor(prefixPath, SLOT_FILE);
    const maintenancePath = maintenanceStatePathFor(prefixPath);
    const lockDirectory = cacheLockDirectoryFor(prefixPath);
    const peerPrefixPath = join(slotDirectory, "peer.json");
    const peerPendingPath = pendingChangesPathFor(peerPrefixPath, PEER_SLOT_FILE);
    mkdirSync(directory, { recursive: true });
    mkdirSync(peerDirectory, { recursive: true });
    mkdirSync(join(configHome, "cortexkit"), { recursive: true });
    mkdirSync(slotDirectory, { recursive: true });
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    let failingChecks = 0;
    let restoreFailures: { status: number; remaining: number } | null = null;
    const countQuestions: string[] = [];
    const chatBodies: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const lockSeenDuringCalls: boolean[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const url = new URL(request.url);
            const slotAction = url.searchParams.get("action");
            calls.push(url.pathname === "/slots/0" ? (slotAction ?? "slot") : "chat");
            lockSeenDuringCalls.push(lockCandidates(lockDirectory).length > 0);
            if (url.pathname === "/slots/0") {
                if (restoreFailures && slotAction === "restore" && restoreFailures.remaining > 0) {
                    restoreFailures.remaining--;
                    return new Response("restore rejected", { status: restoreFailures.status });
                }
                return Response.json({ n_restored: 1 });
            }
            const body = await request.json() as Record<string, unknown> & { messages: TestMessage[] };
            chatBodies.push(body);
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
        const peerProject = resolveProjectIdentityForSession(peerDirectory)!;
        writeFileSync(join(configHome, "cortexkit", "magic-context.jsonc"), JSON.stringify({
            memory: { strata_ask: {
                enabled: true, base_url: String(server.url).replace(/\/$/, ""), api_key: "test-key",
                model: "test-model", project, slot_file: SLOT_FILE, prefix_path: prefixPath,
                context_docs: docs, context_docs_budget_tokens: 4000,
                targets: [{ project: peerProject, slot_file: PEER_SLOT_FILE, prefix_path: peerPrefixPath }],
            } },
        }));
        const db = openDatabase();
        if (!db) throw new Error("isolated test database unavailable");
        await run({
            directory,
            prefixPath,
            pendingPath,
            maintenancePath,
            lockDirectory,
            peerPendingPath,
            project,
            db,
            countQuestions,
            chatBodies,
            calls,
            lockSeenDuringCalls,
            failNextChecks: (count) => { failingChecks = count; },
            failRestore: (status, times = 1) => {
                restoreFailures = status === null ? null : { status, remaining: times };
            },
        });
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

/** Pretend the previous maintenance finished long ago, so its cooldown is over. */
function ageMaintenance(path: string): void {
    writeFileSync(path, `${JSON.stringify({ completedAt: new Date(Date.now() - 3_600_000).toISOString() }, null, 2)}\n`);
}

describe("rebuild and append", () => {
    it("creates for low memory plus docs and preserves docs while appending the real ledger (C4)", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, maintenancePath, project, db }) => {
            const first = insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "first memory" });
            const fakeId = first.id + 1;
            const text = `reference\n\n${PROMPTS.ackRequest}\n\n${CHANGE_LOG}\nnot a real ledger\n\n#${fakeId} [OPS_RULES] 〔2026-10-30T00:00:00.000Z〕：\nnot a memory`;
            writeFileSync(join(directory, "guide.md"), text);
            expect((await maintainCache(directory)).action).toBe("created");
            const initial = prefixUser(prefixPath);
            const docs = docsSectionOf(initial)!;
            expect(docs).toContain(text);

            writeFileSync(join(directory, "guide.md"), "changed on disk");
            // Maintenance now cools down for 60 s after each completion, so this
            // second pass is only immediate once the previous one looks old.
            ageMaintenance(maintenancePath);
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

    it("asks for no reasoning on the ack and the count self-check chat and changes nothing else", async () => {
        await withCacheFixture(async ({ directory, project, db, chatBodies }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await maintainCache(directory)).action).toBe("created");
            // One ack chat for the rebuild, then one count self-check chat.
            expect(chatBodies).toHaveLength(2);
            for (const body of chatBodies) {
                expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
                // No other field appears, and the existing four keep their values.
                const { model, messages, max_tokens, stream } = body;
                expect(body).toEqual({
                    model,
                    messages,
                    max_tokens,
                    stream,
                    chat_template_kwargs: { enable_thinking: false },
                });
                expect(model).toBe("test-model");
                expect(max_tokens).toBe(2048);
                expect(stream).toBe(false);
                expect(Array.isArray(messages)).toBe(true);
            }
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

describe("cache state paths", () => {
    it("keeps pending files per slot and shares one maintenance stamp beside the lock", () => {
        const directory = join(tmpdir(), "mc-strata-slot");
        const prefix = join(directory, "prefix.json");
        const first = pendingChangesPathFor(prefix, "main.bin");
        const second = pendingChangesPathFor(join(directory, "other.json"), "other.bin");
        expect(dirname(first)).toBe(directory);
        expect(dirname(second)).toBe(directory);
        expect(first).not.toBe(second);
        const maintenance = maintenanceStatePathFor(prefix);
        expect(maintenance).toBe(join(directory, "maintenance.json"));
        expect(maintenanceStatePathFor(join(directory, "other.json"))).toBe(maintenance);
        expect(maintenance).not.toBe(first);
        expect(pendingChangesPathFor(prefix, "主库 v2.bin")).not.toBe(pendingChangesPathFor(prefix, "主库 v3.bin"));
        for (const slotFile of ["主库 v2.bin", "..", ".", "a/b", ""]) {
            const path = pendingChangesPathFor(prefix, slotFile);
            expect(dirname(path)).toBe(directory);
            expect(basename(path)).toMatch(/^[A-Za-z0-9._-]+\.jsonl$/);
        }
    });

    it("keeps one slot's pending events out of another slot's drain", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, peerPendingPath, project, db }) => {
            const memory = insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            const published = prefixUser(prefixPath);
            expect(existsSync(pendingPath)).toBe(false);

            writeChange(peerPendingPath, { op: "add", id: memory.id });
            const drained = await drainPendingChanges(directory);
            expect(drained.action).toBe("skipped");
            expect(drained.detail).toBe("no-pending-changes");
            expect(readFileSync(peerPendingPath, "utf8")).toContain(`"id":${memory.id}`);
            expect(prefixUser(prefixPath)).toBe(published);
        }, []);
    });
});

describe("remote slot lifecycle", () => {
    it("restores the saved slot before the rebuild chat and saves before the self-check", async () => {
        await withCacheFixture(async ({ directory, project, db, calls, lockSeenDuringCalls }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            // Nothing saved yet: no slot to restore, so the rebuild starts with the chat.
            expect(calls).toEqual(["chat", "save", "restore", "chat"]);

            calls.length = 0;
            lockSeenDuringCalls.length = 0;
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            expect(calls).toEqual(["restore", "chat", "save", "restore", "chat"]);
            expect(lockSeenDuringCalls.every(Boolean)).toBe(true);
        }, []);
    });

    it("restores once per maintenance rebuild instead of twice", async () => {
        await withCacheFixture(async ({ directory, project, db, calls }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "second memory" });
            calls.length = 0;
            const maintained = await maintainCache(directory);
            expect(maintained.detail).toBe("daily-compaction");
            expect(calls).toEqual(["restore", "chat", "save", "restore", "chat"]);
        }, []);
    });

    it("ignores a missing remote slot but aborts a rebuild on any other restore failure", async () => {
        await withCacheFixture(async ({ directory, project, db, failRestore }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            // Only the reuse attempt sees 404; the slot really exists afterwards.
            failRestore(404);
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            failRestore(500);
            expect((await rebuildCache(directory, "test")).action).toBe("error");
            failRestore(null);
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
        }, []);
    });
});

/** Let real I/O run while a fake clock stays frozen. */
async function settleIo(path: string): Promise<void> {
    for (let turn = 0; turn < 20; turn++) await readFile(path, "utf8").catch(() => undefined);
}

/** Field 22 of /proc/<pid>/stat, or null when this host has no procfs. */
function procStartToken(pid: number): string | null {
    try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
        const token = fields[19];
        return token !== undefined && /^\d+$/.test(token) ? token : null;
    } catch {
        return null;
    }
}

function candidatePayload(pid: number, nonce: string, procStart: string | null = procStartToken(pid)): string {
    // null omits the process-start token, reproducing a legacy payload.
    return `${JSON.stringify({ pid, nonce, startedAt: new Date().toISOString(), procStart })}\n`;
}

function withLockDirectory(run: (prefixPath: string, directory: string) => Promise<void>): Promise<void> {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-strata-election-"));
    return (async () => {
        try {
            const prefixPath = join(root, "slot", "prefix.json");
            const directory = cacheLockDirectoryFor(prefixPath);
            mkdirSync(directory, { recursive: true });
            await run(prefixPath, directory);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    })();
}

describe("cross-process cache lock", () => {
    it("makes a second caller wait for a live candidate and then execute instead of returning busy", async () => {
        await withCacheFixture(async ({ directory, lockDirectory, project, db, calls }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            mkdirSync(lockDirectory, { recursive: true });
            // A live holder is identified by its process-start token, so an
            // ancient wall-clock file age alone must not break its candidate.
            const foreignPath = join(lockDirectory, "0000000000001-0000000001-foreign");
            const foreign = candidatePayload(process.pid, "foreign");
            writeFileSync(foreignPath, foreign);
            const ancient = new Date(Date.now() - 6 * 60 * 60_000);
            utimesSync(foreignPath, ancient, ancient);

            jest.useFakeTimers();
            let settled = false;
            const pending = rebuildCache(directory, "test").then((result) => {
                settled = true;
                return result;
            });
            try {
                await settleIo(foreignPath);
                jest.advanceTimersByTime(50);
                await settleIo(foreignPath);
                expect(settled).toBe(false);
                expect(calls).toHaveLength(0);
                expect(readFileSync(foreignPath, "utf8")).toBe(foreign);

                rmSync(foreignPath);
                jest.advanceTimersByTime(50);
                expect((await pending).action).toBe("rebuilt");
                expect(calls.length).toBeGreaterThan(0);
                expect(lockCandidates(lockDirectory)).toEqual([]);
            } finally {
                jest.useRealTimers();
            }
        }, []);
    });

    it("reclaims a candidate whose owner is gone and always releases its own", async () => {
        await withCacheFixture(async ({ directory, lockDirectory, project, db, lockSeenDuringCalls }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            mkdirSync(lockDirectory, { recursive: true });
            writeFileSync(join(lockDirectory, "0000000000001-0000000001-dead"), candidatePayload(2_000_000_000, "dead"));

            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            expect(lockSeenDuringCalls.length).toBeGreaterThan(0);
            expect(lockSeenDuringCalls.every(Boolean)).toBe(true);
            expect(lockCandidates(lockDirectory)).toEqual([]);
        }, []);
    });

    it("releases the lock when the operation fails", async () => {
        await withCacheFixture(async ({ directory, lockDirectory, project, db, failRestore }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            failRestore(500);
            expect((await rebuildCache(directory, "test")).action).toBe("error");
            expect(lockCandidates(lockDirectory)).toEqual([]);
        }, []);
    });
});

describe("cache lock candidate election", () => {
    it("lets only one of two waiters recover the same stale candidate at a time", async () => {
        await withLockDirectory(async (prefixPath, directory) => {
            const stalePath = join(directory, "0000000000001-0000000001-stale");
            writeFileSync(stalePath, candidatePayload(2_000_000_000, "stale"));

            let active = 0;
            let peak = 0;
            let runs = 0;
            const work = async () => {
                runs++;
                active++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 30));
                active--;
            };
            await Promise.all([
                withCacheLock({ prefixPath }, work),
                withCacheLock({ prefixPath }, work),
            ]);

            // Both waiters saw the same stale candidate; exactly one ran at a time.
            expect(runs).toBe(2);
            expect(peak).toBe(1);
            expect(existsSync(stalePath)).toBe(false);
            expect(lockCandidates(directory)).toEqual([]);
        });
    });

    it.skipIf(procStartToken(process.pid) === null)("reclaims a reused live pid by process-start token but never the same live instance", async () => {
        await withLockDirectory(async (prefixPath, directory) => {
            const ownStart = procStartToken(process.pid)!;
            const residentPath = join(directory, "0000000000001-0000000001-resident");
            const held = candidatePayload(process.pid, "resident", ownStart);
            writeFileSync(residentPath, held);
            // An ancient file age cannot expire a matching live instance.
            const ancient = new Date(Date.now() - 6 * 60 * 60_000);
            utimesSync(residentPath, ancient, ancient);

            let runs = 0;
            jest.useFakeTimers();
            try {
                const pending = withCacheLock({ prefixPath }, async () => {
                    runs++;
                    return "ok";
                });
                await settleIo(residentPath);
                jest.advanceTimersByTime(500);
                await settleIo(residentPath);
                // Alive pid and identical start token: still the holder's slot.
                expect(runs).toBe(0);
                expect(readFileSync(residentPath, "utf8")).toBe(held);

                // Same live pid, different start token: the pid was reused and the
                // new process must not inherit the lock. The fresh write also shows
                // the token, not the file age, drives the reclaim.
                writeFileSync(residentPath, candidatePayload(process.pid, "resident", `${ownStart}0`));
                jest.advanceTimersByTime(500);
                await expect(pending).resolves.toBe("ok");
                expect(runs).toBe(1);
                expect(lockCandidates(directory)).toEqual([]);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it("treats a fresh empty or partial candidate as in progress instead of stale", async () => {
        await withLockDirectory(async (prefixPath, directory) => {
            const residentPath = join(directory, "0000000000001-0000000001-resident");
            writeFileSync(residentPath, "");
            let ran = false;
            jest.useFakeTimers();
            try {
                const pending = withCacheLock({ prefixPath }, async () => {
                    ran = true;
                    return "ok";
                });
                await settleIo(residentPath);
                jest.advanceTimersByTime(500);
                await settleIo(residentPath);
                expect(ran).toBe(false);
                expect(existsSync(residentPath)).toBe(true);

                writeFileSync(residentPath, "{\"pid\":");
                jest.advanceTimersByTime(500);
                await settleIo(residentPath);
                expect(ran).toBe(false);
                expect(existsSync(residentPath)).toBe(true);

                // Complete and live: still a holder, still not for sale.
                writeFileSync(residentPath, candidatePayload(process.pid, "resident"));
                jest.advanceTimersByTime(500);
                await settleIo(residentPath);
                expect(ran).toBe(false);

                // Only the owner's own release frees the slot.
                rmSync(residentPath);
                jest.advanceTimersByTime(50);
                await expect(pending).resolves.toBe("ok");
                expect(ran).toBe(true);
                expect(lockCandidates(directory)).toEqual([]);
            } finally {
                jest.useRealTimers();
            }
        });
    });
});

describe("maintenance cooldown", () => {
    function completedAtOf(path: string): number {
        return Date.parse((JSON.parse(readFileSync(path, "utf8")) as { completedAt: string }).completedAt);
    }

    function writeFreshStamp(path: string): number {
        const completedAt = Date.now();
        writeFileSync(path, `${JSON.stringify({ completedAt: new Date(completedAt).toISOString() }, null, 2)}\n`);
        return completedAt;
    }

    it("waits a full 60 s from the previous completion before starting again", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, project, db }) => {
            const guide = join(directory, "guide.md");
            writeFileSync(guide, "reference text");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await maintainCache(directory)).action).toBe("created");
            const completedAt = completedAtOf(maintenancePath);
            expect(Math.abs(Date.now() - completedAt)).toBeLessThan(60_000);

            jest.useFakeTimers();
            jest.setSystemTime(completedAt + 10_000);
            let settled = false;
            const pending = maintainCache(directory).then((result) => {
                settled = true;
                return result;
            });
            try {
                await settleIo(guide);
                // One settle interval to take and release the lock with a deferral.
                jest.advanceTimersByTime(50);
                await settleIo(guide);
                expect(settled).toBe(false);
                jest.advanceTimersByTime(49_949);
                await settleIo(guide);
                expect(settled).toBe(false);
                // The cooldown expires, but the retry must settle before owning.
                jest.advanceTimersByTime(1);
                await settleIo(guide);
                expect(settled).toBe(false);
                jest.advanceTimersByTime(50);
                expect((await pending).detail).toBe("unchanged");
                expect(completedAtOf(maintenancePath)).toBeGreaterThanOrEqual(completedAt + 60_000);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it("delays slot B for 60 s after slot A completes in the same lock directory", async () => {
        await withCacheFixture(async ({ directory, prefixPath, maintenancePath, project, db, calls }) => {
            const guide = join(directory, "guide.md");
            writeFileSync(guide, "reference text");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await maintainCache(directory)).action).toBe("created");
            const completedAt = completedAtOf(maintenancePath);

            // Slot B has a readable cache but has never run maintenance itself.
            const peerDirectory = join(dirname(directory), "peer");
            writeFileSync(join(dirname(prefixPath), "peer.json"), readFileSync(prefixPath, "utf8"));
            calls.length = 0;
            jest.useFakeTimers();
            jest.setSystemTime(completedAt + 10_000);
            let settled = false;
            const pending = maintainCache(peerDirectory).then((result) => {
                settled = true;
                return result;
            });
            try {
                await settleIo(guide);
                jest.advanceTimersByTime(50);
                await settleIo(guide);
                expect(settled).toBe(false);
                jest.advanceTimersByTime(49_949);
                await settleIo(guide);
                expect(settled).toBe(false);
                expect(calls).toHaveLength(0);
                expect(completedAtOf(maintenancePath)).toBe(completedAt);

                // Cooldown reached, then the retry's settle; only then may B run.
                jest.advanceTimersByTime(1);
                await settleIo(guide);
                expect(settled).toBe(false);
                jest.advanceTimersByTime(50);
                expect((await pending).detail).toBe("unchanged");
                expect(calls).toEqual(["restore"]);
                expect(completedAtOf(maintenancePath)).toBeGreaterThanOrEqual(completedAt + 60_000);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it("holds neither the cache lock nor the process queue during the cooldown sleep", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, lockDirectory, project, db }) => {
            const guide = join(directory, "guide.md");
            writeFileSync(guide, "reference text");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            const completedAt = writeFreshStamp(maintenancePath);

            jest.useFakeTimers();
            let settled = false;
            const pending = maintainCache(directory).then((result) => {
                settled = true;
                return result;
            });
            try {
                await settleIo(guide);
                // Take the lock, see the fresh stamp, defer, and release it.
                jest.advanceTimersByTime(50);
                await settleIo(guide);
                expect(settled).toBe(false);
                expect(lockCandidates(lockDirectory)).toEqual([]);
                expect(completedAtOf(maintenancePath)).toBe(completedAt);

                // The shared process queue is free: a drain runs while maintenance sleeps.
                const drained = drainPendingChanges(directory);
                await settleIo(guide);
                jest.advanceTimersByTime(50);
                await expect(drained).resolves.toMatchObject({ detail: "no-pending-changes" });
                expect(settled).toBe(false);
                expect(completedAtOf(maintenancePath)).toBe(completedAt);

                // Let the retry finish so the fixture can close cleanly: the sleep
                // expires, then the retry's own settle interval must elapse.
                jest.advanceTimersByTime(60_000);
                await settleIo(guide);
                jest.advanceTimersByTime(50);
                await expect(pending).resolves.toMatchObject({ detail: "below-threshold" });
            } finally {
                jest.useRealTimers();
            }
        }, []);
    });

    it("records completion after a failed attempt so it cannot be hammered", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, project, db, failRestore }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            expect((await maintainCache(directory)).action).toBe("created");
            ageMaintenance(maintenancePath);
            const aged = completedAtOf(maintenancePath);

            failRestore(500);
            expect((await maintainCache(directory)).action).toBe("error");
            expect(completedAtOf(maintenancePath)).toBeGreaterThanOrEqual(aged + 3_600_000);
        });
    });

    it("does not cool down rebuilds or drains even with a fresh maintenance stamp", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, project, db }) => {
            insertMemory(db, { projectPath: project, category: "OPS_RULES", content: "one memory" });
            const completedAt = writeFreshStamp(maintenancePath);

            jest.useFakeTimers();
            try {
                const rebuilt = rebuildCache(directory, "test");
                await settleIo(maintenancePath);
                jest.advanceTimersByTime(50);
                await expect(rebuilt).resolves.toMatchObject({ action: "rebuilt" });

                const drained = drainPendingChanges(directory);
                await settleIo(maintenancePath);
                jest.advanceTimersByTime(50);
                await expect(drained).resolves.toMatchObject({ detail: "no-pending-changes" });

                // Neither operation touched the maintenance cooldown stamp.
                expect(completedAtOf(maintenancePath)).toBe(completedAt);
            } finally {
                jest.useRealTimers();
            }
        }, []);
    });
});
