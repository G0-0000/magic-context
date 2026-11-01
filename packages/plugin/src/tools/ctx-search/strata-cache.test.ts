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
import { computeNormalizedHash } from "../../features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    insertMemory,
    updateMemoryContent,
    updateMemoryStatus,
} from "../../features/magic-context/memory/storage-memory";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { parseStatusChanges } from "./flow-render";
import { reduceLedgerRows } from "./ledger-reduce";
import { markSidecarStale, readSidecarStale, staleMarkerPathFor } from "./sidecar-stale";
import {
    DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS,
    strataAskConnectionForProject,
    strataAskConnectionFromConfig,
} from "./strata-ask";
import {
    cacheLockDirectoryFor,
    composeSlotUser,
    consolidateCache,
    docsSectionOf,
    maintainCache,
    maintenanceStatePathFor,
    parseChanges,
    pendingChangesPathFor,
    rebuildCache,
    recordMemoryChange,
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
            const user = composeSlotUser(
                PROMPTS.intro,
                blocks,
                docs.section,
                PROMPTS.ackRequest,
                WATERMARK,
            );
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
        const oldExpression = [PROMPTS.intro, "memory block", PROMPTS.ackRequest, WATERMARK]
            .filter(Boolean)
            .join("\n\n");
        expect(renderDocsSection("/unused", [], 4000)).toBeNull();
        expect(
            composeSlotUser(PROMPTS.intro, "memory block", null, PROMPTS.ackRequest, WATERMARK),
        ).toBe(oldExpression);
        expect(
            composeSlotUser(PROMPTS.intro, "memory block", "", PROMPTS.ackRequest, WATERMARK),
        ).toBe(oldExpression);
        expect(docsSectionOf(oldExpression)).toBeNull();
        expect(docsSectionOf(`${HEADER}\nmissing footer`)).toBeNull();
        expect(docsSectionOf(`before ${HEADER}\nbody\n${FOOTER} after`)).toBe(
            `${HEADER}\nbody\n${FOOTER}`,
        );
    });

    it("reads project-relative and absolute files in order and skips missing files and directories", () => {
        withDocs((directory) => {
            const absolute = join(directory, "second.md");
            writeFileSync(join(directory, "first.md"), "first raw text\n");
            writeFileSync(absolute, "second raw text");
            const docs = renderDocsSection(
                directory,
                ["missing.md", "first.md", directory, absolute],
                4000,
            )!;
            expect(docs.files).toEqual(["first.md", absolute]);
            expect(docs.truncated).toEqual([false, false]);
            expect(docs.section.indexOf("first raw text")).toBeLessThan(
                docs.section.indexOf("second raw text"),
            );
            expect(renderDocsSection(directory, ["missing.md", directory], 4000)).toBeNull();
        });
    });

    it("enforces the full-section budget, truncates at a line boundary and notes remaining files", () => {
        withDocs((directory) => {
            const lines = Array.from(
                { length: 80 },
                (_, index) => `line ${index}: ${"example words ".repeat(6)}\n`,
            );
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
            const label = /〔first\.md（已截断：原文 (\d+) 字符，载入 (\d+) 字符）〕\n/.exec(
                docs.section,
            )!;
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
        enabled: true,
        base_url: "http://localhost:9",
        api_key: "key",
        model: "model",
        project: "git:main",
        slot_file: "main.bin",
        prefix_path: "/tmp/main.json",
        max_tokens: 2048,
        timeout_ms: 60000,
        context_docs: ["main-private.md"],
        context_docs_budget_tokens: 1234,
        targets: [
            {
                project: "git:other",
                slot_file: "other.bin",
                prefix_path: "/tmp/other.json",
                context_docs: ["other.md"],
            },
            { project: "git:empty", slot_file: "empty.bin", prefix_path: "/tmp/empty.json" },
        ],
    };

    it("uses a target's own list, not the main project's list", () => {
        const config = { memory: { strata_ask: raw } };
        expect(strataAskConnectionForProject(config, "git:main")?.contextDocs).toEqual([
            "main-private.md",
        ]);
        expect(strataAskConnectionForProject(config, "git:other")?.contextDocs).toEqual([
            "other.md",
        ]);
        expect(strataAskConnectionForProject(config, "git:other")?.contextDocsBudgetTokens).toBe(
            1234,
        );
    });

    it("defaults an unspecified target list to empty and validates the budget fallback", () => {
        expect(
            strataAskConnectionForProject({ memory: { strata_ask: raw } }, "git:empty")
                ?.contextDocs,
        ).toEqual([]);
        for (const budget of [undefined, 0, 32769, 1.5, Infinity]) {
            const connection = strataAskConnectionFromConfig({
                memory: { strata_ask: { ...raw, context_docs_budget_tokens: budget } },
            });
            expect(connection?.contextDocsBudgetTokens).toBe(DEFAULT_CONTEXT_DOCS_BUDGET_TOKENS);
        }
    });
});

type TestMessage = { role: string; content: string };

const SLOT_FILE = "test.bin";
const PEER_SLOT_FILE = "peer.bin";

type SaveFailureKind =
    | "splice_stale"
    | "splice_base_seam"
    | "splice_render_mismatch"
    | "model_busy"
    | "save_error"
    | "skipped_recovery"
    | "missing_sidecar"
    | "no_session"
    | "no_saved"
    | "empty_saved"
    | "lost_response";

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
    failSaves: (kind: SaveFailureKind, times?: number) => void;
    onNextSave: (callback: () => void) => void;
    onNextCheck: (callback: () => void) => void;
    remoteSlot: () => TestMessage[];
    remoteSidecar: () => TestMessage[] | undefined;
};

/** Candidate files currently in a lock directory; empty when no one holds it. */
function lockCandidates(directory: string): string[] {
    try {
        return readdirSync(directory).sort();
    } catch {
        return [];
    }
}

/**
 * A second slot in the same prefix directory, so isolation is observable.
 * `docs` also decides maintenance's below-threshold gate: an empty list lets a
 * small memory-only project skip cache creation entirely, so a test that expects
 * `maintainCache` to create must keep the default non-empty list.
 */
async function withCacheFixture(
    run: (fixture: CacheFixture) => Promise<void>,
    docs = ["guide.md"],
): Promise<void> {
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
    let saveFailures: { kind: SaveFailureKind; remaining: number } | null = null;
    let nextSave: (() => void) | undefined;
    let nextCheck: (() => void) | undefined;
    const slots = new Map<string, TestMessage[]>();
    const sidecars = new Map<string, TestMessage[]>();
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
            lockSeenDuringCalls.push(lockCandidates(lockDirectory).length > 0);
            if (url.pathname === "/slots/0") {
                calls.push(slotAction ?? "slot");
                if (restoreFailures && restoreFailures.remaining > 0) {
                    restoreFailures.remaining--;
                    return new Response("restore rejected", { status: restoreFailures.status });
                }
                return Response.json({ n_restored: 1 });
            }
            calls.push("chat");
            const body = (await request.json()) as Record<string, unknown> & {
                messages: TestMessage[];
                strata_session?: { restore?: string; save?: string; splice?: boolean };
            };
            chatBodies.push(body);
            const session = body.strata_session;
            // A restore rides either the bare probe or the composite write.
            if (session?.restore && restoreFailures && restoreFailures.remaining > 0) {
                restoreFailures.remaining--;
                return new Response("session file: no such file", {
                    status: restoreFailures.status,
                });
            }
            if (session?.save) {
                const callback = nextSave;
                nextSave = undefined;
                callback?.();
                const failure = saveFailures;
                if (failure && failure.remaining > 0) {
                    failure.remaining--;
                    if (
                        [
                            "splice_stale",
                            "splice_base_seam",
                            "splice_render_mismatch",
                            "model_busy",
                        ].includes(failure.kind)
                    ) {
                        return Response.json(
                            {
                                error: {
                                    type: failure.kind,
                                    message:
                                        failure.kind === "splice_render_mismatch"
                                            ? "splice_render_mismatch: invalid rendering"
                                            : "request rejected",
                                },
                            },
                            { status: failure.kind === "splice_render_mismatch" ? 400 : 409 },
                        );
                    }
                    if (failure.kind === "no_saved" || failure.kind === "empty_saved") {
                        return Response.json({
                            choices: [{ message: { content: "已加载" } }],
                            session: failure.kind === "empty_saved" ? { saved: {} } : {},
                        });
                    }
                    if (failure.kind === "no_session" && session.splice) {
                        return Response.json({ choices: [{ message: { content: "已加载" } }] });
                    }
                    if (failure.kind === "save_error") {
                        return Response.json({
                            choices: [{ message: { content: "已加载" } }],
                            session: { save_error: { kind: "storage", reason: "disk full" } },
                        });
                    }
                    if (failure.kind === "lost_response") {
                        slots.set(session.save, [
                            ...(slots.get(session.restore!) ?? []),
                            ...body.messages,
                            { role: "assistant", content: "已加载" },
                        ]);
                        return new Response("response lost", { status: 503 });
                    }
                    slots.set(session.save, [
                        ...(session.splice ? (slots.get(session.restore!) ?? []) : []),
                        ...body.messages,
                        { role: "assistant", content: "已加载" },
                    ]);
                    if (failure.kind === "missing_sidecar") {
                        return Response.json({
                            choices: [{ message: { content: "已加载" } }],
                            session: { saved: { tokens: 3, bytes: 1024, ms: 1 } },
                        });
                    }
                    if (failure.kind === "no_session")
                        return Response.json({ choices: [{ message: { content: "已加载" } }] });
                    return Response.json({
                        choices: [{ message: { content: "已加载" } }],
                        session: {
                            saved: { tokens: 3, bytes: 1024, ms: 1 },
                            sidecar: "skipped_recovery",
                        },
                    });
                }
                slots.set(session.save, [
                    ...(session.splice ? (slots.get(session.restore!) ?? []) : []),
                    ...body.messages,
                    { role: "assistant", content: "已加载" },
                ]);
                sidecars.set(session.save, [...slots.get(session.save)!]);
                return Response.json({
                    choices: [{ message: { content: "已加载" } }],
                    session: { saved: { tokens: 3, bytes: 1024, ms: 1 } },
                });
            }
            const callback = nextCheck;
            nextCheck = undefined;
            callback?.();
            countQuestions.push(body.messages.at(-1)!.content);
            const sidecar = sidecars.get(session?.restore ?? "");
            if (!sidecar) {
                return Response.json({ error: { type: "splice_stale" } }, { status: 409 });
            }
            const line = sidecar
                .filter((message) => message.role === "user")
                .at(-1)!
                .content.split("\n")
                .at(-1)!;
            const count = Number(/^本库共 (\d+) 条/.exec(line)![1]);
            const answer = failingChecks > 0 ? count + 1 : count;
            if (failingChecks > 0) failingChecks--;
            return Response.json({ choices: [{ message: { content: String(answer) } }] });
        },
    });
    try {
        const project = resolveProjectIdentityForSession(directory)!;
        const peerProject = resolveProjectIdentityForSession(peerDirectory)!;
        writeFileSync(
            join(configHome, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: true,
                        base_url: String(server.url).replace(/\/$/, ""),
                        api_key: "test-key",
                        model: "test-model",
                        project,
                        slot_file: SLOT_FILE,
                        prefix_path: prefixPath,
                        context_docs: docs,
                        context_docs_budget_tokens: 4000,
                        targets: [
                            {
                                project: peerProject,
                                slot_file: PEER_SLOT_FILE,
                                prefix_path: peerPrefixPath,
                            },
                        ],
                    },
                },
            }),
        );
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
            failNextChecks: (count) => {
                failingChecks = count;
            },
            failRestore: (status, times = 1) => {
                restoreFailures = status === null ? null : { status, remaining: times };
            },
            failSaves: (kind, times = 1) => {
                saveFailures = { kind, remaining: times };
            },
            onNextSave: (callback) => {
                nextSave = callback;
            },
            onNextCheck: (callback) => {
                nextCheck = callback;
            },
            remoteSlot: () => slots.get(SLOT_FILE) ?? [],
            remoteSidecar: () => sidecars.get(SLOT_FILE),
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
    return (JSON.parse(readFileSync(path, "utf8")) as TestMessage[])
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n\n");
}

function writeChange(path: string, event: object): void {
    writeFileSync(path, `${JSON.stringify({ ...event, ts: "2026-10-30T00:00:00.000Z" })}\n`);
}

/** Memory text whose rendered change line is far past the consolidation threshold. */
function largeMemoryContent(): string {
    return `large: ${"memory content ".repeat(2000)}`;
}

/** The `strata_session` of every chat this fixture saw, in order. */
function chatSessions(bodies: Array<Record<string, unknown>>): unknown[] {
    return bodies.map((body) => body.strata_session);
}

/** Pretend the previous maintenance finished long ago, so its cooldown is over. */
function ageMaintenance(path: string): void {
    writeFileSync(
        path,
        `${JSON.stringify({ completedAt: new Date(Date.now() - 3_600_000).toISOString() }, null, 2)}\n`,
    );
}

describe("rebuild and append", () => {
    for (const path of ["explicit", "daily", "stale"] as const) {
        for (const saveFailure of ["no_saved", "empty_saved"] as const) {
            it(`retains the mirror and ledger when ${path} rebuild receives ${saveFailure}`, async () => {
                await withCacheFixture(
                    async ({
                        directory,
                        prefixPath,
                        pendingPath,
                        maintenancePath,
                        project,
                        db,
                        failSaves,
                        remoteSlot,
                        countQuestions,
                    }) => {
                        const memory = insertMemory(db, {
                            projectPath: project,
                            category: "OPS_RULES",
                            content: "original memory",
                        });
                        expect((await maintainCache(directory)).action).toBe("created");
                        const mirror = readFileSync(prefixPath, "utf8");
                        const remote = JSON.stringify(remoteSlot());
                        const updated = "updated memory";
                        updateMemoryContent(db, memory.id, updated, computeNormalizedHash(updated));
                        writeChange(pendingPath, { op: "update", id: memory.id });
                        const ledger = readFileSync(pendingPath, "utf8");
                        if (path === "stale") markSidecarStale(prefixPath, "splice_stale");
                        ageMaintenance(maintenancePath);
                        const checks = countQuestions.length;
                        failSaves(saveFailure);
                        const result =
                            path === "explicit"
                                ? await rebuildCache(directory, "test")
                                : await maintainCache(directory);
                        expect(result.action).toBe("error");
                        expect(readFileSync(prefixPath, "utf8")).toBe(mirror);
                        expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
                        expect(JSON.stringify(remoteSlot())).toBe(remote);
                        expect(countQuestions).toHaveLength(checks);
                        expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                        if (path === "stale") {
                            expect(readSidecarStale(prefixPath)).toMatchObject({
                                reason: "splice_stale",
                            });
                        }
                        expect((await consolidateCache(directory)).detail).toBe("pending-write");
                        expect(prefixUser(prefixPath)).toContain(updated);
                        expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(false);
                    },
                );
            });
        }
    }

    it("daily maintenance recovers a failed first save below the creation threshold", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, failSaves, remoteSlot }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "small memory",
                });
                failSaves("empty_saved");
                expect((await rebuildCache(directory, "bootstrap")).action).toBe("error");
                expect(existsSync(prefixPath)).toBe(false);
                expect(existsSync(pendingPath)).toBe(false);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                expect(remoteSlot()).toEqual([]);
                const result = await maintainCache(directory);
                expect(result.action).toBe("rebuilt");
                expect(result.detail).toBe("pending-write");
                expect(prefixUser(prefixPath)).toContain("small memory");
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(false);
            },
            [],
        );
    });

    it("creates for low memory plus docs, splices a large pure-addition ledger, and queues a small removal (C4)", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                maintenancePath,
                project,
                db,
                chatBodies,
            }) => {
                const first = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "first memory",
                });
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
                // The daily pass always rebuilds from the database snapshot, so
                // the edited reference doc lands even though no memory changed.
                const maintained = await maintainCache(directory);
                expect(maintained.action).toBe("rebuilt");
                expect(maintained.detail).toBe("daily-compaction");
                const refreshed = prefixUser(prefixPath);
                expect(refreshed).toContain("changed on disk");
                expect(refreshed).not.toBe(initial);

                // A full rebuild re-reads the reference docs from disk (C4):
                // the edited guide must come back, not what the previous
                // prefix carried.
                writeFileSync(join(directory, "guide.md"), "changed again before rebuild");
                expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
                const rebuiltDocs = docsSectionOf(prefixUser(prefixPath));
                expect(rebuiltDocs).toContain("changed again before rebuild");
                expect(rebuiltDocs).not.toContain("changed on disk");

                const second = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                expect(second.id).toBe(fakeId);
                writeChange(pendingPath, { op: "add", id: second.id });
                const added = await consolidateCache(directory);
                expect(added.action).toBe("appended");
                expect(added.watermark?.count).toBe(2);
                const user = prefixUser(prefixPath);
                expect(docsSectionOf(user)).toBe(rebuiltDocs);
                const afterAck = user.slice(
                    user.lastIndexOf(PROMPTS.ackRequest) + PROMPTS.ackRequest.length,
                );
                expect(afterAck.split(CHANGE_LOG)).toHaveLength(2);
                expect(user.split("\n").at(-1)).toStartWith("本库共 2 条");
                const appendBody = chatBodies.at(-2)!;
                expect(appendBody.strata_session).toEqual({
                    restore: SLOT_FILE,
                    splice: true,
                    save: SLOT_FILE,
                });
                const appendMessages = appendBody.messages as TestMessage[];
                expect(appendMessages).toHaveLength(1);
                expect(appendMessages[0]!.role).toBe("user");
                expect(appendMessages[0]!.content).toContain("增：");
                expect(appendMessages[0]!.content).toContain(largeMemoryContent());
                expect(appendMessages[0]!.content).not.toContain("first memory");
                expect(appendMessages[0]!.content.split("\n").at(-1)).toStartWith("本库共 2 条");
                const mirror = JSON.parse(readFileSync(prefixPath, "utf8")) as TestMessage[];
                expect(mirror).toHaveLength(5);
                expect(mirror[3]).toEqual(appendMessages[0]);
                expect(mirror[4]!.role).toBe("assistant");
                const checkBody = chatBodies.at(-1)!;
                expect(checkBody.strata_session).toEqual({ restore: SLOT_FILE, splice: true });
                expect(checkBody.messages as TestMessage[]).toHaveLength(1);
                expect((checkBody.messages as TestMessage[])[0]!.role).toBe("user");

                updateMemoryStatus(db, second.id, "archived");
                writeChange(pendingPath, { op: "remove", id: second.id, kind: "archive" });
                const published = readFileSync(prefixPath, "utf8");
                const removed = await consolidateCache(directory);
                // The removal arrives alone, far below the consolidation gate, so it
                // queues for the next consolidation instead of rewriting the slot;
                // the published prefix stays byte-identical. A large batch carrying
                // a removal does rebuild — that case lives in the consolidation section.
                expect(removed.action).toBe("skipped");
                expect(removed.detail).toBe("below-threshold");
                expect(readFileSync(prefixPath, "utf8")).toBe(published);
            },
        );
    });

    it("preserves successive append turns and reads the latest watermark", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, chatBodies }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "base memory",
                });
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                for (let i = 0; i < 2; i++) {
                    const memory = insertMemory(db, {
                        projectPath: project,
                        category: "OPS_RULES",
                        content: `${i} ${largeMemoryContent()}`,
                    });
                    writeChange(pendingPath, { op: "add", id: memory.id });
                    const result = await consolidateCache(directory);
                    expect(result.action).toBe("appended");
                    expect(result.watermark?.count).toBe(i + 2);
                    expect(chatBodies.at(-2)!.messages as TestMessage[]).toHaveLength(1);
                }
                const mirror = JSON.parse(readFileSync(prefixPath, "utf8")) as TestMessage[];
                expect(mirror.map((message) => message.role)).toEqual([
                    "system",
                    "user",
                    "assistant",
                    "user",
                    "assistant",
                    "user",
                    "assistant",
                ]);
                expect(mirror[5]!.content.split("\n").at(-1)).toStartWith("本库共 3 条");
            },
            [],
        );
    });

    for (const kind of ["splice_stale", "splice_base_seam", "splice_render_mismatch"] as const) {
        it(`marks ${kind} stale before rebuilding`, async () => {
            await withCacheFixture(
                async ({
                    directory,
                    prefixPath,
                    pendingPath,
                    project,
                    db,
                    failSaves,
                    onNextSave,
                    chatBodies,
                }) => {
                    expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                    const memory = insertMemory(db, {
                        projectPath: project,
                        category: "OPS_RULES",
                        content: largeMemoryContent(),
                    });
                    writeChange(pendingPath, { op: "add", id: memory.id });
                    failSaves(kind);
                    let marked = false;
                    // The callback on the failed splice installs a callback for the rebuild.
                    onNextSave(() =>
                        onNextSave(() => {
                            marked = readSidecarStale(prefixPath) !== null;
                        }),
                    );
                    const result = await consolidateCache(directory);
                    expect(result.action).toBe("rebuilt");
                    expect(result.detail).toBe("sidecar-stale");
                    expect(marked).toBe(true);
                    expect(readSidecarStale(prefixPath)).toBeNull();
                    expect((chatBodies.at(-3)!.strata_session as { splice?: boolean }).splice).toBe(
                        true,
                    );
                    expect(
                        JSON.parse(readFileSync(prefixPath, "utf8")) as TestMessage[],
                    ).toHaveLength(3);
                    expect(readFileSync(pendingPath, "utf8")).toBe("");
                },
                [],
            );
        });
    }

    it("retries the count self-check once with docs before publishing", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, project, db, countQuestions, failNextChecks }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                failNextChecks(1);
                expect((await maintainCache(directory)).action).toBe("created");
                expect(countQuestions).toHaveLength(2);
                expect(countQuestions[0]).toBe(countQuestions[1]);
                expect(countQuestions[0]).toContain(
                    "变更流水中现行有效之条目（含新增、不含已作废者）",
                );
                expect(countQuestions[0]).toContain("参考文档一节不计入");
                expect(docsSectionOf(prefixUser(prefixPath))).not.toBeNull();
            },
        );
    });

    it("asks for no reasoning on the ack and the count self-check chat and changes nothing else", async () => {
        await withCacheFixture(async ({ directory, project, db, chatBodies }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            // One ack chat for the rebuild, then one count self-check chat.
            expect(chatBodies).toHaveLength(2);
            for (const body of chatBodies) {
                expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
                // No other field appears, and the existing four keep their values.
                const { model, messages, max_tokens, stream, strata_session } = body;
                expect(body).toEqual({
                    model,
                    messages,
                    max_tokens,
                    stream,
                    strata_session,
                    chat_template_kwargs: { enable_thinking: false },
                });
                expect(model).toBe("test-model");
                expect(max_tokens).toBe(2048);
                expect(stream).toBe(false);
                expect(Array.isArray(messages)).toBe(true);
                expect(strata_session).toBeDefined();
            }
        });
    });

    it("does not publish a prefix or consume pending events if both checks fail", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                countQuestions,
                failNextChecks,
            }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                writeChange(pendingPath, { op: "add", id: memory.id });
                const pending = readFileSync(pendingPath, "utf8");
                failNextChecks(2);
                expect((await rebuildCache(directory, "test")).action).toBe("error");
                expect(countQuestions).toHaveLength(2);
                expect(existsSync(prefixPath)).toBe(false);
                expect(readFileSync(pendingPath, "utf8")).toBe(pending);
            },
        );
    });

    it("still skips low-memory cache creation when no documents are configured", async () => {
        await withCacheFixture(async ({ directory, prefixPath, project, db, countQuestions }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            const result = await maintainCache(directory);
            expect(result.action).toBe("skipped");
            expect(result.detail).toBe("below-threshold");
            expect(existsSync(prefixPath)).toBe(false);
            expect(countQuestions).toHaveLength(0);
        }, []);
    });

    it("does not retry the self-check without a docs section", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, project, db, countQuestions, failNextChecks }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                failNextChecks(1);
                expect((await rebuildCache(directory, "test")).action).toBe("error");
                expect(countQuestions).toHaveLength(1);
                expect(existsSync(prefixPath)).toBe(false);
            },
            [],
        );
    });

    it("rebuilds at maintenance when an unrecorded addition left the count short", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, maintenancePath, project, db }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                const first = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "first memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                // The dreamer can add a memory without recording a ledger event;
                // a later recorded append then advances the max-id watermark past
                // it while the slot stays one entry short.
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "dreamer memory",
                });
                const third = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                expect(third.id).toBe(first.id + 2);
                writeChange(pendingPath, { op: "add", id: third.id });
                const appended = await consolidateCache(directory);
                expect(appended.action).toBe("appended");
                expect(appended.watermark?.count).toBe(2);
                expect(appended.watermark?.maxMemoryId).toBe(third.id);

                // Daily maintenance: every max watermark matches, but the slot's
                // count diverges from the database, so the slot rebuilds and the
                // unrecorded dreamer memory lands after all.
                ageMaintenance(maintenancePath);
                const maintained = await maintainCache(directory);
                expect(maintained.action).toBe("rebuilt");
                expect(maintained.detail).toBe("daily-compaction");
                const user = prefixUser(prefixPath);
                expect(user).toContain("dreamer memory");
                expect(user).not.toContain(CHANGE_LOG);
                expect(user.split("\n").at(-1)).toStartWith("本库共 3 条");
            },
        );
    });

    it("rebuilds at maintenance even when count and every max id match a divergent slot", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, maintenancePath, project, db }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                const first = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "first memory",
                });
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "second memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");

                // migrate-session moves #1 to another project with no ledger
                // row; a dreamer addition lands unrecorded; a recorded append
                // then advances the slot's max id to match the database. The
                // slot holds #1,#2,#4 and the database holds #2,#3,#4: equal
                // counts AND equal max ids, while the slot still carries the
                // moved memory and never received the dreamer one.
                db.prepare("UPDATE memories SET project_path = ? WHERE id = ?").run(
                    "git:moved-away",
                    first.id,
                );
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "dreamer memory",
                });
                const fourth = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                writeChange(pendingPath, { op: "add", id: fourth.id });
                const appended = await consolidateCache(directory);
                expect(appended.action).toBe("appended");
                expect(appended.watermark?.count).toBe(3);
                expect(appended.watermark?.maxMemoryId).toBe(fourth.id);

                ageMaintenance(maintenancePath);
                const maintained = await maintainCache(directory);
                expect(maintained.action).toBe("rebuilt");
                expect(maintained.detail).toBe("daily-compaction");
                const user = prefixUser(prefixPath);
                expect(user).toContain("second memory");
                expect(user).toContain("dreamer memory");
                expect(user).not.toContain("first memory");
                expect(user.split("\n").at(-1)).toStartWith("本库共 3 条");
            },
        );
    });

    it("rebuilds a dead ledger even when divergent slot watermarks match", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const first = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "first memory",
            });
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "second memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            db.prepare("UPDATE memories SET project_path = ? WHERE id = ?").run(
                "git:moved-away",
                first.id,
            );
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "dreamer memory",
            });
            const fourth = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            writeChange(pendingPath, { op: "add", id: fourth.id });
            const appended = await consolidateCache(directory);
            expect(appended.action).toBe("appended");
            expect(appended.watermark?.count).toBe(3);
            expect(appended.watermark?.maxMemoryId).toBe(fourth.id);
            expect(prefixUser(prefixPath)).toContain("first memory");
            expect(prefixUser(prefixPath)).not.toContain("dreamer memory");

            writeChange(pendingPath, { op: "add", id: first.id });
            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.watermark?.count).toBe(appended.watermark?.count);
            expect(result.watermark?.maxMemoryId).toBe(appended.watermark?.maxMemoryId);
            expect(result.watermark?.maxMutationId).toBe(appended.watermark?.maxMutationId);
            expect(prefixUser(prefixPath)).not.toContain("first memory");
            expect(prefixUser(prefixPath)).toContain("dreamer memory");
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("includes a permanent memory in the consolidation measure and the splice", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "first memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            // A merge can leave the NEW memory permanent; its add event is
            // recorded like any other, so consolidation must see its text.
            const merged = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            updateMemoryStatus(db, merged.id, "permanent");
            writeChange(pendingPath, { op: "add", id: merged.id });

            const appended = await consolidateCache(directory);
            expect(appended.action).toBe("appended");
            expect(appended.watermark?.count).toBe(2);
            const user = prefixUser(prefixPath);
            expect(user).toContain(largeMemoryContent());
            expect(user.split("\n").at(-1)).toStartWith("本库共 2 条");
        });
    });

    it("renders permanent memories into a fresh slot", async () => {
        await withCacheFixture(async ({ directory, prefixPath, project, db }) => {
            const permanent = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "permanent memory",
            });
            updateMemoryStatus(db, permanent.id, "permanent");

            const result = await rebuildCache(directory, "test");
            expect(result.action).toBe("rebuilt");
            expect(result.watermark?.count).toBe(1);
            const user = prefixUser(prefixPath);
            expect(user).toContain("permanent memory");
            expect(user.split("\n").at(-1)).toStartWith("本库共 1 条");
        }, []);
    });
});

describe("status ledger reduction", () => {
    const ts = "2026-10-30T00:00:00.000Z";
    const row = (op: "add" | "update" | "remove", id = 1) =>
        op === "remove" ? { op, id, ts, kind: "archive" } : { op, id, ts };
    const cases = [
        ["add", "update", "update", 1],
        ["add", "remove", "remove", 1],
        ["update", "update", "update", 1],
        ["update", "remove", "remove", 1],
        ["remove", "update", "update", 1],
        ["remove", "remove", "remove", 1],
        ["add", "add", "add", 1],
        ["update", "add", "update", 0],
        ["remove", "add", "remove", 0],
    ] as const;
    for (const [first, second, expected, index] of cases) {
        it(`${first} then ${second} retains ${expected}`, () => {
            const input = [row(first), row(second)];
            const reduced = reduceLedgerRows(input, (change) => change);
            expect(reduced.map((change) => change.op)).toEqual([expected]);
            expect(reduced[0]).toBe(input[index]);
        });
    }
    it("keeps the last row of each interleaved sequence in physical order", () => {
        const input = [
            row("add", 1),
            row("update", 2),
            row("update", 1),
            row("remove", 1),
            row("remove", 2),
            row("update", 2),
        ];
        expect(reduceLedgerRows(input, (change) => change)).toEqual([input[3], input[5]]);
    });
    it("orders late adds before the last non-add for each id", () => {
        const input = [
            row("update", 1),
            row("remove", 2),
            row("add", 1),
            row("add", 2),
            row("remove", 1),
            row("add", 1),
            row("update", 2),
        ];
        expect(reduceLedgerRows(input, (change) => change)).toEqual([input[4], input[6]]);
    });
    it("preserves other ids and malformed bytes and both parsers reduce identically", () => {
        const malformed = '{"op":"add","id":';
        const lines = [
            JSON.stringify(row("update")),
            malformed,
            JSON.stringify(row("add", 2)),
            JSON.stringify(row("remove")),
        ];
        const reduced = reduceLedgerRows(lines, (line) => parseChanges(line).changes[0] ?? null);
        expect(reduced).toEqual([malformed, lines[2], lines[3]]);
        const raw = `${lines.join("\n")}\n`;
        const writer = reduceLedgerRows(parseChanges(raw).changes, (change) => change);
        const reader = reduceLedgerRows(parseStatusChanges(raw), (change) => change);
        expect(reader).toEqual(writer);
        expect(parseChanges(raw).skipped).toBe(1);
    });
    it("keeps physical rows append-only and queues a small add-then-remove ledger", async () => {
        await withCacheFixture(async ({ directory, pendingPath }) => {
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            recordMemoryChange(directory, { op: "add", memoryId: 1019 });
            recordMemoryChange(directory, { op: "remove", memoryId: 1019, kind: "archive" });
            const raw = readFileSync(pendingPath, "utf8");
            expect(parseChanges(raw).changes).toHaveLength(2);
            expect((await consolidateCache(directory)).detail).toBe("below-threshold");
            expect(readFileSync(pendingPath, "utf8")).toBe(raw);
        }, []);
    });
});

describe("status ledger consolidation", () => {
    it("retains the ledger and mirror when an append skips sidecar recovery", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                failSaves,
                remoteSlot,
                remoteSidecar,
                countQuestions,
            }) => {
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                const mirror = readFileSync(prefixPath, "utf8");
                const sidecar = JSON.stringify(remoteSidecar());
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                writeChange(pendingPath, { op: "add", id: memory.id });
                const ledger = readFileSync(pendingPath, "utf8");
                const checks = countQuestions.length;
                failSaves("skipped_recovery");
                expect((await consolidateCache(directory)).action).toBe("error");
                expect(JSON.stringify(remoteSlot())).not.toBe(sidecar);
                expect(JSON.stringify(remoteSidecar())).toBe(sidecar);
                expect(countQuestions).toHaveLength(checks);
                expect(readFileSync(prefixPath, "utf8")).toBe(mirror);
                expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                expect(readSidecarStale(prefixPath)).toMatchObject({ reason: "skipped_recovery" });
                expect((await consolidateCache(directory)).detail).toBe("pending-write");
                expect(remoteSidecar()).toEqual(remoteSlot());
            },
            [],
        );
    });

    it("keeps a concurrent rebuild's leftover add followed by an archive, then rebuilds at the threshold", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, onNextSave }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "concurrent archived memory",
                });
                // The rebuild has already read its ledger and database snapshot when
                // the add arrives during the remote save, so it remains queued even
                // though the resulting slot includes the memory.
                onNextSave(() => recordMemoryChange(directory, { op: "add", memoryId: memory.id }));
                expect((await rebuildCache(directory, "concurrent")).action).toBe("rebuilt");
                expect(prefixUser(prefixPath)).toContain("concurrent archived memory");
                expect(
                    parseChanges(readFileSync(pendingPath, "utf8")).changes.map((row) => row.op),
                ).toEqual(["add"]);
                updateMemoryStatus(db, memory.id, "archived");
                recordMemoryChange(directory, {
                    op: "remove",
                    memoryId: memory.id,
                    kind: "archive",
                });
                const pending = readFileSync(pendingPath, "utf8");
                expect((await consolidateCache(directory)).detail).toBe("below-threshold");
                expect(readFileSync(pendingPath, "utf8")).toBe(pending);
                expect(prefixUser(prefixPath)).toContain("concurrent archived memory");

                const large = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                recordMemoryChange(directory, { op: "add", memoryId: large.id });
                const result = await consolidateCache(directory);
                expect(result.action).toBe("rebuilt");
                expect(result.detail).toBe("status-mixed-changes");
                expect(result.watermark?.count).toBe(1);
                expect(prefixUser(prefixPath)).not.toContain("concurrent archived memory");
                expect(prefixUser(prefixPath)).toContain(largeMemoryContent());
                expect(readFileSync(pendingPath, "utf8")).toBe("");
            },
        );
    });

    it("keeps an update after a leftover add and rebuilds the old slot text at the threshold", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const memory = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "old slot text",
            });
            expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
            recordMemoryChange(directory, { op: "add", memoryId: memory.id });
            const updated = "updated memory text";
            updateMemoryContent(db, memory.id, updated, computeNormalizedHash(updated));
            recordMemoryChange(directory, { op: "update", memoryId: memory.id });
            const pending = readFileSync(pendingPath, "utf8");
            expect((await consolidateCache(directory)).detail).toBe("below-threshold");
            expect(readFileSync(pendingPath, "utf8")).toBe(pending);
            expect(prefixUser(prefixPath)).toContain("old slot text");

            const large = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            recordMemoryChange(directory, { op: "add", memoryId: large.id });
            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("status-mixed-changes");
            expect(result.watermark?.count).toBe(2);
            expect(prefixUser(prefixPath)).not.toContain("old slot text");
            expect(prefixUser(prefixPath)).toContain(updated);
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("rebuilds rather than splicing when adds are recorded after their update and removal", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const updated = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "late add old text",
            });
            const archived = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "late add archived text",
            });
            // A rebuild can observe both insertions while their writers have not
            // yet appended the corresponding add events.
            expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
            const newContent = "late add new text";
            updateMemoryContent(db, updated.id, newContent, computeNormalizedHash(newContent));
            recordMemoryChange(directory, { op: "update", memoryId: updated.id });
            updateMemoryStatus(db, archived.id, "archived");
            recordMemoryChange(directory, { op: "remove", memoryId: archived.id, kind: "archive" });
            recordMemoryChange(directory, { op: "add", memoryId: updated.id });
            recordMemoryChange(directory, { op: "add", memoryId: archived.id });
            const pending = readFileSync(pendingPath, "utf8");
            expect(
                reduceLedgerRows(parseChanges(pending).changes, (row) => row).map((row) => row.op),
            ).toEqual(["update", "remove"]);
            expect((await consolidateCache(directory)).detail).toBe("below-threshold");
            expect(readFileSync(pendingPath, "utf8")).toBe(pending);

            const large = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            recordMemoryChange(directory, { op: "add", memoryId: large.id });
            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("status-mixed-changes");
            expect(result.watermark?.count).toBe(2);
            expect(prefixUser(prefixPath)).toContain(newContent);
            expect(prefixUser(prefixPath)).not.toContain("late add old text");
            expect(prefixUser(prefixPath)).not.toContain("late add archived text");
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("keeps a small ledger queued and leaves the published slot byte-identical", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, chatBodies }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "a small memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                const published = readFileSync(prefixPath, "utf8");
                const ledger = `${JSON.stringify({ op: "add", id: memory.id, ts: "2026-10-30T00:00:00.000Z" })}\n`;
                writeFileSync(pendingPath, ledger);
                chatBodies.length = 0;

                const result = await consolidateCache(directory);
                expect(result.action).toBe("skipped");
                expect(result.detail).toBe("below-threshold");
                // No remote write at all: the ledger keeps accumulating.
                expect(chatBodies).toHaveLength(0);
                expect(readFileSync(prefixPath, "utf8")).toBe(published);
                expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
            },
        );
    });

    it("rebuilds instead of splicing when a large batch carries a removal", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const first = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "first memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            const second = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            updateMemoryStatus(db, first.id, "archived");
            writeFileSync(
                pendingPath,
                [
                    JSON.stringify({ op: "add", id: second.id, ts: "2026-10-30T00:00:00.000Z" }),
                    JSON.stringify({
                        op: "remove",
                        id: first.id,
                        kind: "archive",
                        ts: "2026-10-30T00:00:01.000Z",
                    }),
                    "",
                ].join("\n"),
            );

            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("status-mixed-changes");
            expect(result.watermark?.count).toBe(1);
            const user = prefixUser(prefixPath);
            expect(user).not.toContain(CHANGE_LOG);
            expect(user).not.toContain("first memory");
            expect(user.split("\n").at(-1)).toStartWith("本库共 1 条");
        });
    });

    it("never splices a ledger carrying a torn or corrupt line, rebuilding instead", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const first = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "first memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            const published = prefixUser(prefixPath);
            // A killed process can leave a corrupt complete row and a partial one.
            const corruptLedger = `${JSON.stringify({ op: "add", id: first.id, ts: "2026-10-30T00:00:00.000Z" })}\n{"op":"add","id":\n{"op":"add","id":`;
            writeFileSync(pendingPath, corruptLedger);
            const tolerated = await consolidateCache(directory);
            // No throw: the readable row is still below the commit threshold,
            // so the batch — bad rows included — stays queued under a warning.
            expect(tolerated.action).toBe("skipped");
            expect(tolerated.detail).toBe("below-threshold");
            expect(prefixUser(prefixPath)).toBe(published);
            expect(readFileSync(pendingPath, "utf8")).toBe(corruptLedger);

            // Once the batch is commit-worthy, the corrupt rows veto the splice:
            // what looks like pure additions may hide a removal or an update, so
            // the whole batch rebuilds from the database snapshot and is consumed
            // only after the rebuild's passed self-check.
            const large = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            recordMemoryChange(directory, { op: "add", memoryId: large.id });
            const committed = await consolidateCache(directory);
            expect(committed.action).toBe("rebuilt");
            expect(committed.detail).toBe("status-unparseable");
            expect(committed.watermark?.count).toBe(2);
            const user = prefixUser(prefixPath);
            expect(user).not.toContain(CHANGE_LOG);
            expect(user).toContain("first memory");
            expect(user).toContain(largeMemoryContent());
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("rebuilds a dead ledger only after a successful self-check", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                countQuestions,
                failNextChecks,
            }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "first memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                // An add event whose memory is already gone renders nothing; the
                // dead ledger may still be deleted only after a passed self-check.
                writeChange(pendingPath, { op: "add", id: 999 });
                countQuestions.length = 0;
                failNextChecks(2);
                const failed = await consolidateCache(directory);
                expect(failed.action).toBe("error");
                expect(readFileSync(pendingPath, "utf8")).not.toBe("");

                const consumed = await consolidateCache(directory);
                expect(consumed.action).toBe("rebuilt");
                expect(consumed.detail).toBe("pending-write");
                expect(countQuestions.length).toBeGreaterThanOrEqual(2);
                expect(readFileSync(pendingPath, "utf8")).toBe("");
                expect(prefixUser(prefixPath)).toContain("first memory");
            },
        );
    });

    it("rebuilds instead of consuming a dead ledger when the slot lags the database", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const first = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "first memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            // A leftover add row (a concurrent rebuild already wrote the memory
            // into the slot archive) followed by an unrecorded archive: the
            // event renders nothing, but consuming it would leave the archived
            // entry in the only copy queries read, so the slot must be rebuilt
            // against the current snapshot instead.
            writeChange(pendingPath, { op: "add", id: first.id });
            updateMemoryStatus(db, first.id, "archived");

            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("snapshot-mismatch");
            const user = prefixUser(prefixPath);
            expect(user).not.toContain("first memory");
            expect(user.split("\n").at(-1)).toStartWith("本库共 0 条");
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("rebuilds an add-then-remove restored and edited without a new ledger row", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
            const memory = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "before dashboard restore",
            });
            recordMemoryChange(directory, { op: "add", memoryId: memory.id });
            updateMemoryStatus(db, memory.id, "archived");
            recordMemoryChange(directory, { op: "remove", memoryId: memory.id, kind: "archive" });
            updateMemoryStatus(db, memory.id, "active");
            const restored = "dashboard restored and edited";
            updateMemoryContent(db, memory.id, restored, computeNormalizedHash(restored));
            expect(prefixUser(prefixPath)).not.toContain("before dashboard restore");
            expect(
                parseChanges(readFileSync(pendingPath, "utf8")).changes.map((row) => row.op),
            ).toEqual(["add", "remove"]);

            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("snapshot-mismatch");
            expect(result.watermark?.count).toBe(1);
            expect(prefixUser(prefixPath)).toContain(restored);
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("does not splice a large addition batch containing a restored add-then-remove", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
            const memory = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "before dashboard restore",
            });
            recordMemoryChange(directory, { op: "add", memoryId: memory.id });
            updateMemoryStatus(db, memory.id, "archived");
            recordMemoryChange(directory, { op: "remove", memoryId: memory.id, kind: "archive" });
            updateMemoryStatus(db, memory.id, "active");
            const restored = "large batch restored and edited";
            updateMemoryContent(db, memory.id, restored, computeNormalizedHash(restored));
            const large = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: largeMemoryContent(),
            });
            recordMemoryChange(directory, { op: "add", memoryId: large.id });

            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("status-mixed-changes");
            expect(result.watermark?.count).toBe(2);
            expect(prefixUser(prefixPath)).toContain(restored);
            expect(prefixUser(prefixPath)).toContain(largeMemoryContent());
            expect(readFileSync(pendingPath, "utf8")).toBe("");
        });
    });

    it("retains a removal after a remote save passes but the rebuild self-check fails", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                onNextSave,
                failNextChecks,
                chatBodies,
                remoteSlot,
            }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                const originalPrefix = readFileSync(prefixPath, "utf8");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "saved before failed check",
                });
                onNextSave(() => recordMemoryChange(directory, { op: "add", memoryId: memory.id }));
                failNextChecks(2);
                expect((await rebuildCache(directory, "failed-check")).action).toBe("error");
                const saveRequest = chatBodies.at(-3)!;
                expect(saveRequest.strata_session).toMatchObject({ save: SLOT_FILE });
                expect((saveRequest.messages as TestMessage[])[1]!.content).toContain(
                    "saved before failed check",
                );
                expect(readFileSync(prefixPath, "utf8")).toBe(originalPrefix);
                expect(
                    parseChanges(readFileSync(pendingPath, "utf8")).changes.map((row) => row.op),
                ).toEqual(["add"]);
                updateMemoryStatus(db, memory.id, "archived");
                recordMemoryChange(directory, {
                    op: "remove",
                    memoryId: memory.id,
                    kind: "archive",
                });
                const pending = readFileSync(pendingPath, "utf8");
                expect(
                    reduceLedgerRows(parseChanges(pending).changes, (row) => row).map(
                        (row) => row.op,
                    ),
                ).toEqual(["remove"]);
                expect(readFileSync(pendingPath, "utf8")).toBe(pending);

                const large = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                recordMemoryChange(directory, { op: "add", memoryId: large.id });
                const result = await consolidateCache(directory);
                expect(result.action).toBe("rebuilt");
                expect(result.detail).toBe("pending-write");
                expect(prefixUser(prefixPath)).not.toContain("saved before failed check");
                expect(prefixUser(prefixPath)).toContain(largeMemoryContent());
                expect(readFileSync(pendingPath, "utf8")).toBe("");
                const remote = JSON.stringify(remoteSlot());
                expect(remote).not.toContain("saved before failed check");
                expect(remote).toContain(largeMemoryContent());
            },
        );
    });

    it("rebuilds when a removal's memory is active again", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, countQuestions }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                const first = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "first memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                // Archived (removal recorded), then restored — the dashboard
                // restore only bumps the epoch, so the stale removal row stays
                // in the ledger. The row renders on neither side and must not
                // decrement the count; the dead ledger is consumed only after
                // the slot passes a self-check against the current snapshot.
                updateMemoryStatus(db, first.id, "archived");
                writeChange(pendingPath, { op: "remove", id: first.id, kind: "archive" });
                updateMemoryStatus(db, first.id, "active");
                countQuestions.length = 0;

                const result = await consolidateCache(directory);
                expect(result.action).toBe("rebuilt");
                expect(result.detail).toBe("snapshot-mismatch");
                expect(result.watermark?.count).toBe(1);
                expect(readFileSync(pendingPath, "utf8")).toBe("");
                expect(countQuestions).toHaveLength(1);
                const user = prefixUser(prefixPath);
                expect(user).toContain("first memory");
                expect(user).not.toContain("讣");
            },
        );
    });

    it("measures a boundary batch of archived adds identically to the query side", async () => {
        await withCacheFixture(async ({ directory, prefixPath, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const first = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "first memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            const published = readFileSync(prefixPath, "utf8");
            updateMemoryStatus(db, first.id, "archived");

            // Archived adds: each recorded, then archived before consolidation.
            // The shared row-selection rule skips them on both sides and prices
            // only the remove row. Grow the batch until pricing the adds as
            // obits (the old query-side behavior) would blow the commit cap
            // while the agreed measure stays under it.
            const ts = "2026-10-30T00:00:00.000Z";
            const obitOf = (id: number) => `〔${ts}〕讣：#${id} 已删除/已归档，上文同号条目作废`;
            const removeRow = obitOf(first.id);
            const ghosts: number[] = [];
            while (estimateTokens([removeRow, ...ghosts.map(obitOf)].join("\n\n")) <= 2000) {
                const ghost = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: `ghost memory ${ghosts.length}`,
                });
                updateMemoryStatus(db, ghost.id, "archived");
                ghosts.push(ghost.id);
            }
            const ledger = [
                ...ghosts.map((id) => JSON.stringify({ op: "add", id, ts })),
                JSON.stringify({ op: "remove", id: first.id, kind: "archive", ts }),
            ].join("\n");
            writeFileSync(pendingPath, `${ledger}\n`);

            // Both sides now measure exactly the remove row: the write side
            // stays below its cap (STATUS_CONSOLIDATION_TOKENS = 2000) and the
            // query side's status block is identically under budget, so the
            // batch can no longer wedge queries into perpetual fallback.
            expect(estimateTokens(removeRow)).toBeLessThanOrEqual(2000);
            expect(estimateTokens([removeRow, ...ghosts.map(obitOf)].join("\n\n"))).toBeGreaterThan(
                2000,
            );

            const result = await consolidateCache(directory);
            expect(result.action).toBe("skipped");
            expect(result.detail).toBe("below-threshold");
            expect(readFileSync(prefixPath, "utf8")).toBe(published);
            expect(readFileSync(pendingPath, "utf8")).toBe(`${ledger}\n`);
        });
    });

    it("prices a vanished update as an obituary during consolidation", async () => {
        await withCacheFixture(async ({ directory, pendingPath, project, db }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            const ts = "2026-10-30T00:00:00.000Z";
            const ids: number[] = [];
            const rows: string[] = [];
            const obits: string[] = [];
            // Distinct ids keep each update through ledger reduction for threshold pricing.
            while (estimateTokens(obits.join("\n\n")) <= 2000) {
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: `vanished memory ${ids.length}`,
                });
                ids.push(memory.id);
                rows.push(JSON.stringify({ op: "update", id: memory.id, ts }));
                obits.push(`〔${ts}〕讣：#${memory.id} 已删除/已归档，上文同号条目作废`);
            }
            expect((await maintainCache(directory)).action).toBe("created");
            for (const id of ids) updateMemoryStatus(db, id, "archived");
            writeFileSync(pendingPath, `${rows.slice(1).join("\n")}\n`);
            expect((await consolidateCache(directory)).detail).toBe("below-threshold");
            writeFileSync(pendingPath, `${rows.join("\n")}\n`);
            const result = await consolidateCache(directory);
            expect(result.action).toBe("rebuilt");
            expect(result.detail).toBe("status-mixed-changes");
        });
    });

    it("lets a stale sidecar outrank a below-threshold ledger", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, chatBodies }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                writeChange(pendingPath, { op: "add", id: memory.id });
                markSidecarStale(prefixPath, "splice_stale");
                chatBodies.length = 0;

                const result = await consolidateCache(directory);
                expect(result.action).toBe("rebuilt");
                expect(result.detail).toBe("sidecar-stale");
                expect(readSidecarStale(prefixPath)).toBeNull();
            },
        );
    });

    for (const saveFailure of ["no_saved", "empty_saved"] as const) {
        it(`rejects an append with ${saveFailure} and rebuilds on the next pass`, async () => {
            await withCacheFixture(
                async ({
                    directory,
                    prefixPath,
                    pendingPath,
                    project,
                    db,
                    failSaves,
                    remoteSlot,
                    chatBodies,
                }) => {
                    expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                    const before = readFileSync(prefixPath, "utf8");
                    const memory = insertMemory(db, {
                        projectPath: project,
                        category: "OPS_RULES",
                        content: largeMemoryContent(),
                    });
                    writeChange(pendingPath, { op: "add", id: memory.id });
                    const ledger = readFileSync(pendingPath, "utf8");
                    failSaves(saveFailure);
                    expect((await consolidateCache(directory)).action).toBe("error");
                    expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                    expect(readFileSync(prefixPath, "utf8")).toBe(before);
                    expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
                    expect(remoteSlot()).toHaveLength(3);
                    chatBodies.length = 0;
                    expect((await consolidateCache(directory)).detail).toBe("pending-write");
                    expect(
                        (chatBodies[0]!.strata_session as { splice?: boolean }).splice,
                    ).toBeUndefined();
                    expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(false);
                },
                [],
            );
        });
    }

    it("rebuilds after a lost append response without duplicating the remote increment", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                failSaves,
                remoteSlot,
                chatBodies,
                onNextSave,
                onNextCheck,
            }) => {
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                writeChange(pendingPath, { op: "add", id: memory.id });
                const marker = `${prefixPath}.pending-write.json`;
                onNextSave(() => expect(existsSync(marker)).toBe(true));
                failSaves("lost_response");
                expect((await consolidateCache(directory)).action).toBe("error");
                expect(existsSync(marker)).toBe(true);
                expect(remoteSlot()).toHaveLength(5);
                chatBodies.length = 0;
                onNextCheck(() => {
                    expect(existsSync(marker)).toBe(true);
                    expect(readFileSync(pendingPath, "utf8")).not.toBe("");
                });
                expect((await consolidateCache(directory)).detail).toBe("pending-write");
                expect(
                    (chatBodies[0]!.strata_session as { splice?: boolean }).splice,
                ).toBeUndefined();
                expect(remoteSlot()).toHaveLength(3);
                expect(
                    remoteSlot()
                        .map((message) => message.content)
                        .join("\n")
                        .split(largeMemoryContent()),
                ).toHaveLength(2);
                expect(readFileSync(pendingPath, "utf8")).toBe("");
                expect(existsSync(marker)).toBe(false);
            },
            [],
        );
    });

    it("retains the marker if ledger consumption fails after publishing the mirror", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, onNextCheck }) => {
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                writeChange(pendingPath, { op: "add", id: memory.id });
                const marker = `${prefixPath}.pending-write.json`;
                onNextCheck(() => {
                    expect(existsSync(marker)).toBe(true);
                    writeFileSync(pendingPath, "changed during check\n");
                });
                expect((await consolidateCache(directory)).action).toBe("error");
                expect(prefixUser(prefixPath)).toContain(largeMemoryContent());
                expect(existsSync(marker)).toBe(true);
                expect((await consolidateCache(directory)).detail).toBe("pending-write");
                expect(existsSync(marker)).toBe(false);
                expect(readFileSync(pendingPath, "utf8")).toBe("");
            },
            [],
        );
    });

    it("publishes nothing and keeps the ledger when the append self-check fails", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                failNextChecks,
                remoteSlot,
                chatBodies,
            }) => {
                writeFileSync(join(directory, "guide.md"), "reference text");
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "first memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                const published = readFileSync(prefixPath, "utf8");
                const large = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: largeMemoryContent(),
                });
                writeChange(pendingPath, { op: "add", id: large.id });
                const ledger = readFileSync(pendingPath, "utf8");
                // The append's check, then the rebuild fallback's check and its docs
                // retry: every one of them fails.
                failNextChecks(3);

                expect((await consolidateCache(directory)).action).toBe("error");
                expect(readFileSync(prefixPath, "utf8")).toBe(published);
                expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                chatBodies.length = 0;
                expect((await consolidateCache(directory)).detail).toBe("pending-write");
                expect(
                    (chatBodies[0]!.strata_session as { splice?: boolean }).splice,
                ).toBeUndefined();
                expect(remoteSlot()).toHaveLength(3);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(false);
            },
        );
    });
    it("starts a new line under a torn row so the next event is not swallowed", async () => {
        await withCacheFixture(async ({ directory, pendingPath, project, db }) => {
            const memory = insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            writeFileSync(pendingPath, `{"op":"add","id":`);

            recordMemoryChange(directory, { op: "add", memoryId: memory.id });

            const lines = readFileSync(pendingPath, "utf8").split("\n");
            expect(lines[0]).toBe(`{"op":"add","id":`);
            expect(JSON.parse(lines[1]!)).toMatchObject({ op: "add", id: memory.id });
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
        expect(pendingChangesPathFor(prefix, "主库 v2.bin")).not.toBe(
            pendingChangesPathFor(prefix, "主库 v3.bin"),
        );
        for (const slotFile of ["主库 v2.bin", "..", ".", "a/b", ""]) {
            const path = pendingChangesPathFor(prefix, slotFile);
            expect(dirname(path)).toBe(directory);
            expect(basename(path)).toMatch(/^[A-Za-z0-9._-]+\.jsonl$/);
        }
    });

    it("keeps the sidecar marker per prefix file beside it", () => {
        const directory = join(tmpdir(), "mc-strata-slot");
        expect(staleMarkerPathFor(join(directory, "prefix.json"))).toBe(
            join(directory, "prefix.json.sidecar-stale.json"),
        );
        expect(staleMarkerPathFor(join(directory, "prefix-other.json"))).toBe(
            join(directory, "prefix-other.json.sidecar-stale.json"),
        );
    });

    it("keeps one slot's status ledger out of another slot's consolidation", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, peerPendingPath, project, db }) => {
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
                const published = prefixUser(prefixPath);
                expect(existsSync(pendingPath)).toBe(false);

                writeChange(peerPendingPath, { op: "add", id: memory.id });
                const consolidated = await consolidateCache(directory);
                expect(consolidated.action).toBe("skipped");
                expect(consolidated.detail).toBe("no-pending-changes");
                expect(readFileSync(peerPendingPath, "utf8")).toContain(`"id":${memory.id}`);
                expect(prefixUser(prefixPath)).toBe(published);
            },
            [],
        );
    });
});

describe("remote slot lifecycle", () => {
    it("writes the slot and its sidecar in one composite request and restores for the self-check", async () => {
        await withCacheFixture(
            async ({ directory, project, db, calls, chatBodies, lockSeenDuringCalls }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
                // Nothing published yet: the first build has no slot to restore.
                expect(calls).toEqual(["chat", "chat"]);
                expect(chatSessions(chatBodies)).toEqual([
                    { save: SLOT_FILE },
                    { restore: SLOT_FILE, splice: true },
                ]);

                calls.length = 0;
                chatBodies.length = 0;
                lockSeenDuringCalls.length = 0;
                expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
                // The restore rides the write request; the self-check restores on its own.
                expect(calls).toEqual(["chat", "chat"]);
                expect(chatSessions(chatBodies)).toEqual([
                    { restore: SLOT_FILE, save: SLOT_FILE },
                    { restore: SLOT_FILE, splice: true },
                ]);
                expect(lockSeenDuringCalls.every(Boolean)).toBe(true);
            },
            [],
        );
    });

    it("probes the slot once per maintenance rebuild and does not restore again for the write", async () => {
        await withCacheFixture(async ({ directory, project, db, calls, chatBodies }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "second memory",
            });
            calls.length = 0;
            chatBodies.length = 0;
            const maintained = await maintainCache(directory);
            expect(maintained.detail).toBe("daily-compaction");
            expect(calls).toEqual(["restore", "chat", "chat"]);
            expect(chatSessions(chatBodies)).toEqual([
                { save: SLOT_FILE },
                { restore: SLOT_FILE, splice: true },
            ]);
        }, []);
    });

    it("ignores a missing slot on restore but aborts a rebuild on any other restore failure", async () => {
        await withCacheFixture(async ({ directory, project, db, failRestore, chatBodies }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            // The restore is a reuse attempt: 404 means there is nothing to reuse,
            // so the same write is replayed without it instead of failing.
            failRestore(404);
            chatBodies.length = 0;
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            expect(chatSessions(chatBodies)).toEqual([
                { restore: SLOT_FILE, save: SLOT_FILE },
                { save: SLOT_FILE },
                { restore: SLOT_FILE, splice: true },
            ]);
            failRestore(500);
            expect((await rebuildCache(directory, "test")).action).toBe("error");
            failRestore(null);
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
        }, []);
    });

    it("fails the write and keeps pending events when the server reports save_error", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, pendingPath, project, db, failSaves }) => {
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                writeChange(pendingPath, { op: "add", id: memory.id });
                const pending = readFileSync(pendingPath, "utf8");
                failSaves("save_error");
                expect((await rebuildCache(directory, "test")).action).toBe("error");
                expect(existsSync(prefixPath)).toBe(false);
                expect(readFileSync(pendingPath, "utf8")).toBe(pending);
            },
            [],
        );
    });

    it("retains the first saved slot without publishing when the sidecar is missing", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                failSaves,
                remoteSlot,
                remoteSidecar,
            }) => {
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                writeChange(pendingPath, { op: "add", id: memory.id });
                const ledger = readFileSync(pendingPath, "utf8");
                failSaves("missing_sidecar");
                expect((await rebuildCache(directory, "test")).action).toBe("error");
                expect(remoteSlot()).not.toEqual([]);
                expect(remoteSidecar()).toBeUndefined();
                expect(existsSync(prefixPath)).toBe(false);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
                expect((await consolidateCache(directory)).detail).toBe("pending-write");
                expect(remoteSidecar()).toEqual(remoteSlot());
                expect(prefixUser(prefixPath)).toContain("one memory");
            },
            [],
        );
    });

    it("does not trust an old same-count sidecar after skipped recovery", async () => {
        await withCacheFixture(
            async ({
                directory,
                prefixPath,
                pendingPath,
                project,
                db,
                failSaves,
                remoteSlot,
                remoteSidecar,
                countQuestions,
            }) => {
                const memory = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "old memory",
                });
                expect((await rebuildCache(directory, "initial")).action).toBe("rebuilt");
                const mirror = readFileSync(prefixPath, "utf8");
                const oldSidecar = JSON.stringify(remoteSidecar());
                updateMemoryContent(
                    db,
                    memory.id,
                    "new memory",
                    computeNormalizedHash("new memory"),
                );
                writeChange(pendingPath, { op: "update", id: memory.id });
                const ledger = readFileSync(pendingPath, "utf8");
                const checks = countQuestions.length;
                failSaves("skipped_recovery");
                expect((await rebuildCache(directory, "test")).action).toBe("error");
                expect(JSON.stringify(remoteSlot())).toContain("new memory");
                expect(JSON.stringify(remoteSidecar())).toBe(oldSidecar);
                expect(JSON.stringify(remoteSlot())).not.toBe(oldSidecar);
                expect(countQuestions).toHaveLength(checks);
                expect(readFileSync(prefixPath, "utf8")).toBe(mirror);
                expect(readFileSync(pendingPath, "utf8")).toBe(ledger);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                expect(readSidecarStale(prefixPath)).toMatchObject({ reason: "skipped_recovery" });
                expect((await consolidateCache(directory)).detail).toBe("pending-write");
                expect(remoteSidecar()).toEqual(remoteSlot());
                expect(prefixUser(prefixPath)).toContain("new memory");
            },
            [],
        );
    });

    it("retries the composite save once on a concurrent same-name conflict", async () => {
        await withCacheFixture(async ({ directory, project, db, failSaves, chatBodies }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            failSaves("splice_stale");
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            const saves = chatBodies.filter(
                (body) => (body.strata_session as { save?: string } | undefined)?.save,
            );
            expect(saves).toHaveLength(2);
            expect(saves[0]?.strata_session).toEqual(saves[1]?.strata_session);
        }, []);
    });

    it("retries the composite save once on a 409 model_busy", async () => {
        await withCacheFixture(async ({ directory, project, db, failSaves, chatBodies }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            failSaves("model_busy");
            expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
            const saves = chatBodies.filter(
                (body) => (body.strata_session as { save?: string } | undefined)?.save,
            );
            expect(saves).toHaveLength(2);
            expect(saves[0]?.strata_session).toEqual(saves[1]?.strata_session);
        }, []);
    });

    it("fails the write on a persistent conflict and publishes nothing", async () => {
        await withCacheFixture(async ({ directory, prefixPath, project, db, failSaves }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            failSaves("splice_stale", 2);
            expect((await rebuildCache(directory, "test")).action).toBe("error");
            expect(existsSync(prefixPath)).toBe(false);
        }, []);
    });

    it("forces a rebuild when the sidecar marker is present and clears it after the save", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, maintenancePath, project, db, calls }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                markSidecarStale(prefixPath, "splice_stale");
                ageMaintenance(maintenancePath);
                calls.length = 0;
                const maintained = await maintainCache(directory);
                expect(maintained.detail).toBe("sidecar-stale");
                expect(readSidecarStale(prefixPath)).toBeNull();
                expect(calls).toEqual(["restore", "chat", "chat"]);
            },
        );
    });

    it("keeps the marker when the rebuild save skips the sidecar again", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, maintenancePath, project, db, failSaves }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                markSidecarStale(prefixPath, "splice_stale");
                ageMaintenance(maintenancePath);
                failSaves("skipped_recovery");
                expect((await maintainCache(directory)).action).toBe("error");
                expect(readSidecarStale(prefixPath)).toMatchObject({ reason: "skipped_recovery" });
            },
        );
    });

    it("keeps the sidecar marker when a save reply carries no session block", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, maintenancePath, project, db, failSaves }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                markSidecarStale(prefixPath, "splice_stale");
                ageMaintenance(maintenancePath);
                failSaves("no_session");
                // Without save confirmation the rebuild fails and keeps the marker.
                expect((await maintainCache(directory)).action).toBe("error");
                expect(readSidecarStale(prefixPath)).toMatchObject({ reason: "splice_stale" });
            },
        );
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
        const fields = raw
            .slice(raw.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/);
        const token = fields[19];
        return token !== undefined && /^\d+$/.test(token) ? token : null;
    } catch {
        return null;
    }
}

function candidatePayload(
    pid: number,
    nonce: string,
    procStart: string | null = procStartToken(pid),
): string {
    // null omits the process-start token, reproducing a legacy payload.
    return `${JSON.stringify({ pid, nonce, startedAt: new Date().toISOString(), procStart })}\n`;
}

function withLockDirectory(
    run: (prefixPath: string, directory: string) => Promise<void>,
): Promise<void> {
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
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
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
        await withCacheFixture(
            async ({ directory, lockDirectory, project, db, lockSeenDuringCalls }) => {
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                mkdirSync(lockDirectory, { recursive: true });
                writeFileSync(
                    join(lockDirectory, "0000000000001-0000000001-dead"),
                    candidatePayload(2_000_000_000, "dead"),
                );

                expect((await rebuildCache(directory, "test")).action).toBe("rebuilt");
                expect(lockSeenDuringCalls.length).toBeGreaterThan(0);
                expect(lockSeenDuringCalls.every(Boolean)).toBe(true);
                expect(lockCandidates(lockDirectory)).toEqual([]);
            },
            [],
        );
    });

    it("releases the lock when the operation fails", async () => {
        await withCacheFixture(async ({ directory, lockDirectory, project, db, failRestore }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
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

    it.skipIf(procStartToken(process.pid) === null)(
        "reclaims a reused live pid by process-start token but never the same live instance",
        async () => {
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
                    writeFileSync(
                        residentPath,
                        candidatePayload(process.pid, "resident", `${ownStart}0`),
                    );
                    jest.advanceTimersByTime(500);
                    await expect(pending).resolves.toBe("ok");
                    expect(runs).toBe(1);
                    expect(lockCandidates(directory)).toEqual([]);
                } finally {
                    jest.useRealTimers();
                }
            });
        },
    );

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

                writeFileSync(residentPath, '{"pid":');
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
        return Date.parse(
            (JSON.parse(readFileSync(path, "utf8")) as { completedAt: string }).completedAt,
        );
    }

    function writeFreshStamp(path: string): number {
        const completedAt = Date.now();
        writeFileSync(
            path,
            `${JSON.stringify({ completedAt: new Date(completedAt).toISOString() }, null, 2)}\n`,
        );
        return completedAt;
    }

    it("waits a full 60 s from the previous completion before starting again", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, project, db }) => {
            const guide = join(directory, "guide.md");
            writeFileSync(guide, "reference text");
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
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
                expect((await pending).detail).toBe("daily-compaction");
                expect(completedAtOf(maintenancePath)).toBeGreaterThanOrEqual(completedAt + 60_000);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    it("delays slot B for 60 s after slot A completes in the same lock directory", async () => {
        await withCacheFixture(
            async ({ directory, prefixPath, maintenancePath, project, db, calls }) => {
                const guide = join(directory, "guide.md");
                writeFileSync(guide, "reference text");
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
                expect((await maintainCache(directory)).action).toBe("created");
                const completedAt = completedAtOf(maintenancePath);

                // Slot B has a readable cache but has never run maintenance itself.
                const peerDirectory = join(dirname(directory), "peer");
                writeFileSync(
                    join(dirname(prefixPath), "peer.json"),
                    readFileSync(prefixPath, "utf8"),
                );
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
                    // The daily pass always rebuilds, so B rewrites its copied
                    // prefix from its own (empty) snapshot.
                    expect((await pending).detail).toBe("daily-compaction");
                    expect(calls).toEqual(["restore", "chat", "chat"]);
                    expect(completedAtOf(maintenancePath)).toBeGreaterThanOrEqual(
                        completedAt + 60_000,
                    );
                } finally {
                    jest.useRealTimers();
                }
            },
        );
    });

    it("holds neither the cache lock nor the process queue during the cooldown sleep", async () => {
        await withCacheFixture(
            async ({ directory, maintenancePath, lockDirectory, project, db }) => {
                const guide = join(directory, "guide.md");
                writeFileSync(guide, "reference text");
                insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: "one memory",
                });
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

                    // The shared process queue is free: a consolidation runs while maintenance sleeps.
                    const consolidated = consolidateCache(directory);
                    await settleIo(guide);
                    jest.advanceTimersByTime(50);
                    await expect(consolidated).resolves.toMatchObject({
                        detail: "no-pending-changes",
                    });
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
            },
            [],
        );
    });

    it("records completion after a failed attempt so it cannot be hammered", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, project, db, failRestore }) => {
            writeFileSync(join(directory, "guide.md"), "reference text");
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            expect((await maintainCache(directory)).action).toBe("created");
            ageMaintenance(maintenancePath);
            const aged = completedAtOf(maintenancePath);

            failRestore(500);
            expect((await maintainCache(directory)).action).toBe("error");
            expect(completedAtOf(maintenancePath)).toBeGreaterThanOrEqual(aged + 3_600_000);
        });
    });

    it("does not cool down rebuilds or consolidations even with a fresh maintenance stamp", async () => {
        await withCacheFixture(async ({ directory, maintenancePath, project, db }) => {
            insertMemory(db, {
                projectPath: project,
                category: "OPS_RULES",
                content: "one memory",
            });
            const completedAt = writeFreshStamp(maintenancePath);

            jest.useFakeTimers();
            try {
                const rebuilt = rebuildCache(directory, "test");
                await settleIo(maintenancePath);
                jest.advanceTimersByTime(50);
                await expect(rebuilt).resolves.toMatchObject({ action: "rebuilt" });

                const consolidated = consolidateCache(directory);
                await settleIo(maintenancePath);
                jest.advanceTimersByTime(50);
                await expect(consolidated).resolves.toMatchObject({ detail: "no-pending-changes" });

                // Neither operation touched the maintenance cooldown stamp.
                expect(completedAtOf(maintenancePath)).toBe(completedAt);
            } finally {
                jest.useRealTimers();
            }
        }, []);
    });
});
