import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "../../config";
import {
    LIVE_RELOAD_CONFIG_PATHS,
    MagicContextConfigSchema,
} from "../../config/schema/magic-context";
import { computeNormalizedHash } from "../../features/magic-context/memory";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import * as storageMemory from "../../features/magic-context/memory/storage-memory";
import {
    insertMemory,
    updateMemoryContent,
    updateMemoryStatus,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    parseStatusChanges,
    renderStatusRow,
    type StatusChange,
    type StatusMemoryView,
    statusChangesPathFor,
} from "./flow-render";
import { markSidecarStale, readSidecarStale, staleMarkerPathFor } from "./sidecar-stale";
import { STATUS_LEDGER_FIXTURES } from "./status-ledger-fixture";
import {
    buildStrataStatusBlock,
    DEFAULT_STATUS_BUDGET_TOKENS,
    DEFAULT_TRANSIENT_BUDGET_TOKENS,
    isStrataAskEligible,
    readStrataStatusDocument,
    renderQueryMessage,
    resolveOpenCodeStrataAsk,
    STRATA_ASK_FOOTER,
    STRATA_ASK_T4,
    type StrataAskConnection,
    strataAskConnectionForProject,
    strataAskConnectionFromConfig,
    strataNoThinking,
    strataRouteFor,
    tryStrataAsk,
    tryStrataAskDetailed,
} from "./strata-ask";
import { parseChanges } from "./strata-cache";
import PROMPTS from "./strata-prompts.json";
import { createCtxSearchTools } from "./tools";

/** In-memory store with the migrated memories schema, for status lookup tests. */
function createStatusDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function connection(
    baseUrl: string,
    patch: Partial<StrataAskConnection> = {},
): StrataAskConnection {
    return {
        baseUrl,
        apiKey: "strata-test-key",
        apiKeyEnv: null,
        model: "qwen-test",
        slotFile: "mc-mem-v1.bin",
        prefixPath: "/tmp/strata-ask-prefix.json",
        project: "git:bound",
        maxTokens: 2048,
        timeoutMs: 60_000,
        transientBudgetTokens: 1000,
        contextDocs: [],
        contextDocsBudgetTokens: 4000,
        ...patch,
    };
}

describe("isStrataAskEligible", () => {
    it("accepts a bare query and ignores unknown host fields", () => {
        expect(isStrataAskEligible({ query: " where is sqlite? " })).toBe(true);
        expect(isStrataAskEligible({ query: "where is sqlite?", hostMeta: 1, reduced: true })).toBe(
            true,
        );
    });

    it("routes cache queries with or without limit and rejects dates, other sources and id queries", () => {
        expect(strataRouteFor({ query: "where" })).toBe("fusion");
        expect(strataRouteFor({ query: "where", limit: 3 })).toBe("fusion");
        expect(strataRouteFor({ query: "where", sources: ["memory"] })).toBe("memory-only");
        expect(strataRouteFor({ query: "where", sources: ["memory"], limit: 3 })).toBe(
            "memory-only",
        );
        expect(strataRouteFor({ query: "where", sources: ["memory", "memory"], limit: 3 })).toBe(
            "memory-only",
        );
        expect(strataRouteFor({ query: "where", sources: [] })).toBeNull();
        expect(strataRouteFor({ query: "where", sources: [], limit: 3 })).toBeNull();
        expect(strataRouteFor({ query: "where", sources: ["memory", "note"] })).toBeNull();
        expect(
            strataRouteFor({ query: "where", sources: ["memory", "note"], limit: 3 }),
        ).toBeNull();
        expect(isStrataAskEligible({ query: "where", limit: 3 })).toBe(true);
        expect(isStrataAskEligible({ query: "where", sources: [] })).toBe(false);
        expect(isStrataAskEligible({ query: "where", sources: ["memory"] })).toBe(true);
        expect(isStrataAskEligible({ query: "where", from: "2026-01-01" })).toBe(false);
        expect(isStrataAskEligible({ query: "where", to: "2026-02-01" })).toBe(false);
        expect(isStrataAskEligible({ query: "where", from: "2026-01-01", limit: 3 })).toBe(false);
        expect(isStrataAskEligible({ query: "#1035" })).toBe(false);
        expect(isStrataAskEligible({ query: "1032, 1035" })).toBe(false);
        expect(isStrataAskEligible({ query: "   " })).toBe(false);
        expect(isStrataAskEligible({})).toBe(false);
    });
});

describe("strata ask config", () => {
    it("is not a live-reload key and defaults to disabled", () => {
        expect(LIVE_RELOAD_CONFIG_PATHS.some((path) => path.startsWith("memory.strata_ask"))).toBe(
            false,
        );
        const parsed = MagicContextConfigSchema.parse({});
        expect(parsed.memory.strata_ask).toEqual({
            enabled: false,
            max_tokens: 2048,
            timeout_ms: 60_000,
            transient_budget_tokens: 2000,
            context_docs: [],
            context_docs_budget_tokens: 4000,
        });
        expect(strataAskConnectionFromConfig(parsed)).toBeNull();
    });

    it("uses the raw transient budget or the default for invalid values", () => {
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
        };
        const resolve = (value?: number) =>
            strataAskConnectionFromConfig({
                memory: { strata_ask: { ...raw, transient_budget_tokens: value } },
            })?.transientBudgetTokens;
        expect(resolve()).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
        expect(resolve(321.5)).toBe(321.5);
        expect(resolve(0)).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
        expect(resolve(Infinity)).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
        expect(resolve(8193)).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
    });

    it("requires exactly the three target strings", () => {
        const parse = (target: object) =>
            MagicContextConfigSchema.safeParse({ memory: { strata_ask: { targets: [target] } } });
        const target = {
            project: "git:other",
            slot_file: "other.bin",
            prefix_path: "/tmp/other.json",
        };
        expect(parse(target).success).toBe(true);
        expect(parse({ project: target.project, slot_file: target.slot_file }).success).toBe(false);
        expect(parse({ ...target, model: "override" }).success).toBe(false);
    });

    it("routes primary first, then targets, and disables unmatched or non-enabled projects", () => {
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
            targets: [
                { project: "git:main", slot_file: "shadow.bin", prefix_path: "/tmp/shadow.json" },
                { project: "git:other", slot_file: "other.bin", prefix_path: "/tmp/other.json" },
                { project: "git:other", slot_file: "later.bin", prefix_path: "/tmp/later.json" },
            ],
        };
        const config = { memory: { strata_ask: raw } };
        expect(strataAskConnectionForProject(config, "git:main")?.slotFile).toBe("main.bin");
        expect(strataAskConnectionForProject(config, "git:other")?.slotFile).toBe("other.bin");
        expect(strataAskConnectionForProject(config, "git:other")?.prefixPath).toBe(
            "/tmp/other.json",
        );
        expect(strataAskConnectionForProject(config, "git:missing")).toBeNull();
        expect(
            strataAskConnectionForProject(
                { memory: { strata_ask: { ...raw, enabled: false } } },
                "git:other",
            ),
        ).toBeNull();
        expect(
            strataAskConnectionForProject(
                { memory: { strata_ask: { ...raw, enabled: undefined } } },
                "git:other",
            ),
        ).toBeNull();
        expect(
            strataAskConnectionFromConfig({
                memory: { strata_ask: { ...raw, project: undefined } },
            }),
        ).toBeNull();
    });

    it("keeps a project enabled opt-in and strips project connection fields", () => {
        const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-strata-xdg-"));
        const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-strata-proj-"));
        mkdirSync(join(xdg, "cortexkit"), { recursive: true });
        mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
        const projectIdentity = resolveProjectIdentityForSession(projectDir)!;
        writeFileSync(
            join(xdg, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: false,
                        base_url: "http://127.0.0.1:9",
                        api_key: "user-key",
                        model: "user-model",
                        slot_file: "mc-mem-v1.bin",
                        prefix_path: "/var/lib/strata/prefix.json",
                        project: projectIdentity,
                        max_tokens: 1024,
                        timeout_ms: 1500,
                    },
                },
            }),
        );
        writeFileSync(
            join(projectDir, ".cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: true,
                        base_url: "http://evil.example",
                        api_key: "project-key",
                        api_key_env: "PROJECT_KEY",
                        model: "project-model",
                        slot_file: "../secret.bin",
                        prefix_path: "/etc/passwd",
                        project: "git:evil",
                        max_tokens: 1,
                        timeout_ms: 1,
                    },
                },
            }),
        );
        const previous = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = xdg;
        try {
            const loaded = loadPluginConfig(projectDir);
            expect(loaded.memory.strata_ask.enabled).toBe(true);
            expect(loaded.memory.strata_ask.base_url).toBe("http://127.0.0.1:9");
            expect(loaded.memory.strata_ask.api_key).toBe("user-key");
            expect(loaded.memory.strata_ask.model).toBe("user-model");
            expect(loaded.memory.strata_ask.slot_file).toBe("mc-mem-v1.bin");
            expect(loaded.memory.strata_ask.prefix_path).toBe("/var/lib/strata/prefix.json");
            expect(loaded.memory.strata_ask.project).toBe(projectIdentity);
            expect(loaded.memory.strata_ask.max_tokens).toBe(1024);
            expect(loaded.memory.strata_ask.timeout_ms).toBe(1500);
            expect(loaded.configWarnings?.join("\n")).toContain("memory.strata_ask.base_url");
            expect(loaded.configWarnings?.join("\n")).toContain("/prefix_path/project/");
            expect(JSON.stringify(loaded.configWarnings)).not.toContain("project-key");
            const resolved = resolveOpenCodeStrataAsk(projectDir);
            expect(resolved).toEqual({
                baseUrl: "http://127.0.0.1:9",
                apiKey: "user-key",
                apiKeyEnv: null,
                model: "user-model",
                slotFile: "mc-mem-v1.bin",
                prefixPath: "/var/lib/strata/prefix.json",
                project: projectIdentity,
                maxTokens: 1024,
                timeoutMs: 1500,
                transientBudgetTokens: 2000,
                contextDocs: [],
                contextDocsBudgetTokens: 4000,
            });
        } finally {
            if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous;
            rmSync(xdg, { recursive: true, force: true });
            rmSync(projectDir, { recursive: true, force: true });
        }
    });

    it("treats a user substitution failure as disabled with zero network", async () => {
        const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-strata-xdg-"));
        const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-strata-proj-"));
        let calls = 0;
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch() {
                calls++;
                return Response.json({ n_restored: 1 });
            },
        });
        mkdirSync(join(xdg, "cortexkit"), { recursive: true });
        writeFileSync(
            join(xdg, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: true,
                        base_url: String(server.url).replace(/\/$/, ""),
                        api_key: "still-valid",
                        model: "user-model",
                        slot_file: "mc-mem-v1.bin",
                        // Missing token expands to "", leaving a complete connection.
                        // substitution-failure must still disable it.
                        prefix_path: "/var/lib/strata/prefix.json{env:MC_STRATA_MISSING_LANG}",
                        project: "git:bound",
                    },
                },
            }),
        );
        const previous = process.env.XDG_CONFIG_HOME;
        const previousLang = process.env.MC_STRATA_MISSING_LANG;
        delete process.env.MC_STRATA_MISSING_LANG;
        process.env.XDG_CONFIG_HOME = xdg;
        try {
            expect(resolveOpenCodeStrataAsk(projectDir)).toBeNull();
            expect(calls).toBe(0);
        } finally {
            server.stop(true);
            if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous;
            if (previousLang === undefined) delete process.env.MC_STRATA_MISSING_LANG;
            else process.env.MC_STRATA_MISSING_LANG = previousLang;
            rmSync(xdg, { recursive: true, force: true });
            rmSync(projectDir, { recursive: true, force: true });
        }
    });

    it("treats a project parse failure as disabled", () => {
        const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-strata-xdg-"));
        const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-strata-proj-"));
        mkdirSync(join(xdg, "cortexkit"), { recursive: true });
        mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
        writeFileSync(
            join(xdg, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: true,
                        base_url: "http://127.0.0.1:9",
                        api_key: "user-key",
                        model: "user-model",
                        slot_file: "mc-mem-v1.bin",
                        prefix_path: "/var/lib/strata/prefix.json",
                        project: "git:bound",
                    },
                },
            }),
        );
        writeFileSync(join(projectDir, ".cortexkit", "magic-context.jsonc"), "{");
        const previous = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = xdg;
        try {
            expect(resolveOpenCodeStrataAsk(projectDir)).toBeNull();
        } finally {
            if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous;
            rmSync(xdg, { recursive: true, force: true });
            rmSync(projectDir, { recursive: true, force: true });
        }
    });
});

describe("tryStrataAsk", () => {
    const servers: Array<ReturnType<typeof Bun.serve>> = [];

    afterEach(() => {
        for (const server of servers) server.stop(true);
        servers.length = 0;
    });

    function serve(handler: (req: Request) => Promise<Response> | Response) {
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
        servers.push(server);
        return server;
    }

    /** A real directory, so a fallback never writes its marker outside the test. */
    function tempPrefix(): { prefixPath: string; cleanup: () => void } {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-ask-"));
        return {
            prefixPath: join(directory, "prefix.json"),
            cleanup: () => rmSync(directory, { recursive: true, force: true }),
        };
    }

    const compositeBody = (content: string) => ({
        model: "qwen-test",
        messages: [{ role: "user", content }],
        max_tokens: 2048,
        stream: false,
        strata_session: { restore: "mc-mem-v1.bin", splice: true },
        chat_template_kwargs: { enable_thinking: false },
    });

    it("locks the T4 template and sends it as the only turn of one composite splice request", async () => {
        expect(STRATA_ASK_T4).toBe(
            "{status}问题：{q}\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 讣告作废之条目勿引；修正之条目以新文为准；据作废条目作答即为错。\n4. 记忆库无相关信息，则只答「记忆库中无」。",
        );
        const seen: Array<{ path: string; body: unknown; auth: string | null }> = [];
        const server = serve(async (req) => {
            const url = new URL(req.url);
            seen.push({
                path: `${url.pathname}${url.search}`,
                body: await req.json(),
                auth: req.headers.get("Authorization"),
            });
            return Response.json({
                choices: [
                    {
                        message: {
                            content: "答案一行\n#1032：概括",
                            reasoning_content: "do-not-surface",
                        },
                    },
                ],
                session: {
                    restored: { tokens: 78 },
                    splice: { base_tokens: 77, delta_tokens: 28, resume: 78, resume_ok: true },
                },
            });
        });
        const result = await tryStrataAsk({
            query: "sqlite 在哪",
            config: connection(String(server.url).replace(/\/$/, "")),
        });
        expect(seen.map((row) => row.path)).toEqual(["/v1/chat/completions"]);
        expect(seen[0]?.auth).toBe("Bearer strata-test-key");
        // Spelled out literally, not through the production renderer: the
        // assertion must pin the wire shape independently of renderQueryMessage.
        expect(seen[0]?.body).toEqual(
            compositeBody(
                "问题：sqlite 在哪\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 讣告作废之条目勿引；修正之条目以新文为准；据作废条目作答即为错。\n4. 记忆库无相关信息，则只答「记忆库中无」。",
            ),
        );
        const messages = (seen[0]?.body as { messages: Array<{ role: string }> }).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]?.role).toBe("user");
        expect(STRATA_ASK_FOOTER).toBe(
            "——本答案由项目记忆缓存合成，可能融合期外材料摘要；记忆原文可按 #id 用 ctx_memory get，其余确切原文请用 ctx_expand 或显式 sources 参数",
        );
        expect(result).toBe(`答案一行\n#1032：概括\n${STRATA_ASK_FOOTER}`);
        expect(result).not.toContain("do-not-surface");
    });

    it("falls back with status unavailable without a splice when the sidecar is marked stale", async () => {
        const temp = tempPrefix();
        try {
            markSidecarStale(temp.prefixPath, "skipped_recovery");
            let requests = 0;
            const fetchImpl: typeof fetch = async () => {
                requests++;
                return Response.json({ choices: [{ message: { content: "stale answer" } }] });
            };
            expect(
                await tryStrataAskDetailed({
                    query: "memory query",
                    config: connection("http://127.0.0.1:9", { prefixPath: temp.prefixPath }),
                    fetchImpl,
                    statusDocument: null,
                }),
            ).toEqual({ status: "failed", reason: "status_unavailable" });
            expect(requests).toBe(0);
            writeFileSync(staleMarkerPathFor(temp.prefixPath), "{broken");
            expect(
                await tryStrataAskDetailed({
                    query: "memory query",
                    config: connection("http://127.0.0.1:9", { prefixPath: temp.prefixPath }),
                    fetchImpl,
                    statusDocument: null,
                }),
            ).toEqual({ status: "failed", reason: "status_unavailable" });
            expect(requests).toBe(0);
        } finally {
            temp.cleanup();
        }
    });

    it("returns classic memory hits without a splice when the stale marker cannot be read", async () => {
        const temp = tempPrefix();
        const db = createStatusDb();
        let requests = 0;
        const server = serve(() => {
            requests++;
            return Response.json({ choices: [{ message: { content: "stale answer" } }] });
        });
        try {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "RESEARCH",
                content: "where is the sqlite path /data/context.db",
            });
            const markerPath = staleMarkerPathFor(temp.prefixPath);
            mkdirSync(markerPath);
            expect(() => readFileSync(markerPath, "utf8")).toThrow();
            expect(readSidecarStale(temp.prefixPath)).toEqual({ reason: "invalid_marker", at: "" });
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
                resolveStrataAsk: () =>
                    connection(String(server.url).replace(/\/$/, ""), {
                        prefixPath: temp.prefixPath,
                        project: "/repo/project",
                    }),
            });
            const context = { sessionID: "ses-search", directory: "/repo/project" } as never;
            for (const args of [
                { query: "sqlite path" },
                { query: "sqlite path", sources: ["memory"] },
            ]) {
                expect(await tools.ctx_search.execute(args, context)).toContain("/data/context.db");
            }
            expect(requests).toBe(0);
        } finally {
            closeQuietly(db);
            temp.cleanup();
        }
    });

    it("returns classic memory hits for a stale sidecar on both query routes", async () => {
        const temp = tempPrefix();
        const db = createStatusDb();
        let requests = 0;
        let status = 409;
        const server = serve(() => {
            requests++;
            return status === 409
                ? Response.json({ error: { type: "splice_stale" } }, { status })
                : Response.json({ error: { message: "splice_render_mismatch" } }, { status });
        });
        try {
            insertMemory(db, {
                projectPath: "/repo/project",
                category: "RESEARCH",
                content: "where is the sqlite path /data/context.db",
            });
            markSidecarStale(temp.prefixPath, "skipped_recovery");
            const tools = createCtxSearchTools({
                db,
                resolveProjectPath: () => "/repo/project",
                memoryEnabled: true,
                embeddingEnabled: false,
                readMessages: () => [],
                resolveStrataAsk: () =>
                    connection(String(server.url).replace(/\/$/, ""), {
                        prefixPath: temp.prefixPath,
                        project: "/repo/project",
                    }),
            });
            const context = { sessionID: "ses-search", directory: "/repo/project" } as never;
            for (const args of [
                { query: "sqlite path" },
                { query: "sqlite path", sources: ["memory"] },
            ]) {
                expect(await tools.ctx_search.execute(args, context)).toContain("/data/context.db");
            }
            expect(requests).toBe(0);
            // A save may change the slot while its response is lost, leaving
            // only pending-write and no stale marker or updated sidecar.
            rmSync(staleMarkerPathFor(temp.prefixPath), { force: true });
            const slotPath = `${temp.prefixPath}.slot.bin`;
            const sidecarPath = `${slotPath}.tokens.json`;
            writeFileSync(slotPath, "new slot after save");
            writeFileSync(sidecarPath, "old sidecar");
            writeFileSync(`${temp.prefixPath}.pending-write.json`, "{}");
            expect(readSidecarStale(temp.prefixPath)).toBeNull();
            for (const args of [
                { query: "sqlite path" },
                { query: "sqlite path", sources: ["memory"] },
            ]) {
                expect(await tools.ctx_search.execute(args, context)).toContain("/data/context.db");
            }
            expect(requests).toBe(0);
            expect(readFileSync(slotPath, "utf8")).toBe("new slot after save");
            expect(readFileSync(sidecarPath, "utf8")).toBe("old sidecar");
            expect(readFileSync(`${temp.prefixPath}.pending-write.json`, "utf8")).toBe("{}");
            rmSync(`${temp.prefixPath}.pending-write.json`);
            for (status of [409, 400]) {
                rmSync(staleMarkerPathFor(temp.prefixPath), { force: true });
                expect(await tools.ctx_search.execute({ query: "sqlite path" }, context)).toContain(
                    "/data/context.db",
                );
                expect(readSidecarStale(temp.prefixPath)).not.toBeNull();
            }
            expect(requests).toBe(2);
        } finally {
            closeQuietly(db);
            temp.cleanup();
        }
    });

    it("distinguishes answered, miss and failed outcomes", async () => {
        let mode = "answered";
        const fetchImpl: typeof fetch = async () => {
            if (mode === "failed") return new Response(null, { status: 404 });
            return Response.json({
                choices: [{ message: { content: mode === "miss" ? "记忆库中无" : "答案" } }],
            });
        };
        const args = { query: "q", config: connection("http://127.0.0.1:9"), fetchImpl };
        expect(await tryStrataAskDetailed(args)).toEqual({
            status: "answered",
            text: `答案\n${STRATA_ASK_FOOTER}`,
        });
        mode = "miss";
        expect(await tryStrataAskDetailed(args)).toEqual({ status: "miss" });
        mode = "failed";
        expect(await tryStrataAskDetailed(args)).toEqual({ status: "failed", reason: "http_404" });
    });

    it("places transient materials before the question inside the single query turn", async () => {
        const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        const args = { query: "哪里", config: connection("http://127.0.0.1:9"), fetchImpl };
        await tryStrataAskDetailed(args);
        await tryStrataAskDetailed({ ...args, transient: "" });
        await tryStrataAskDetailed({ ...args, transient: "[message] ord=42 :: 材料 {q}" });
        const plain = [
            {
                role: "user",
                content:
                    "问题：哪里\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 讣告作废之条目勿引；修正之条目以新文为准；据作废条目作答即为错。\n4. 记忆库无相关信息，则只答「记忆库中无」。",
            },
        ];
        expect(bodies[0]?.messages).toEqual(plain);
        expect(bodies[1]?.messages).toEqual(plain);
        const fused = bodies[2]!.messages;
        expect(fused).toHaveLength(1);
        const content = fused[0]!.content;
        expect(content).toContain("【期外材料】");
        expect(content).toContain("[message] ord=42 :: 材料 {q}");
        expect(content).toContain("问题：哪里");
        expect(content.indexOf("ord=42")).toBeLessThan(content.indexOf("问题：哪里"));
        expect(content.endsWith("记忆库与期外材料皆无相关信息，则只答「记忆库中无」。")).toBe(true);
    });

    it("asks for no reasoning and adds only the session field to the chat body", async () => {
        const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
        const fetchImpl: typeof fetch = async (input, init) => {
            seen.push({
                path: new URL(String(input)).pathname,
                body: JSON.parse(String(init?.body)),
            });
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        await tryStrataAskDetailed({
            query: "q",
            config: connection("http://127.0.0.1:9"),
            fetchImpl,
        });
        expect(seen.map((row) => row.path)).toEqual(["/v1/chat/completions"]);
        expect(JSON.stringify(strataNoThinking())).toBe(
            '{"chat_template_kwargs":{"enable_thinking":false}}',
        );
        const body = seen[0]!.body;
        const { model, messages, max_tokens, stream, strata_session } = body;
        // No other field appears, and the existing four keep their values.
        expect(body).toEqual({
            model,
            messages,
            max_tokens,
            stream,
            strata_session,
            chat_template_kwargs: { enable_thinking: false },
        });
        expect(strata_session).toEqual({ restore: "mc-mem-v1.bin", splice: true });
        expect(model).toBe("qwen-test");
        expect(max_tokens).toBe(2048);
        expect(stream).toBe(false);
        expect(messages).toEqual([
            {
                role: "user",
                content:
                    "问题：q\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 讣告作废之条目勿引；修正之条目以新文为准；据作废条目作答即为错。\n4. 记忆库无相关信息，则只答「记忆库中无」。",
            },
        ]);
    });

    it("returns null for an exact miss, empty content, 404, 401 and malformed JSON", async () => {
        const key = "strata-secret-key-should-not-leak";
        const logged = spyOn(logger, "log").mockImplementation(() => {});
        const calls: string[] = [];
        let mode = "miss";
        const server = serve(async (req) => {
            const url = new URL(req.url);
            calls.push(url.pathname);
            if (mode === "404") return new Response(key, { status: 404 });
            if (mode === "401") return new Response(key, { status: 401 });
            if (mode === "empty") {
                return Response.json({
                    choices: [{ message: { content: "  ", reasoning_content: key } }],
                });
            }
            if (mode === "quoted") {
                return Response.json({ choices: [{ message: { content: "「记忆库中无」" } }] });
            }
            if (mode === "malformed") return new Response("not-json", { status: 200 });
            return Response.json({ choices: [{ message: { content: "记忆库中无" } }] });
        });
        const config = connection(String(server.url).replace(/\/$/, ""), { apiKey: key });
        try {
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
            mode = "quoted";
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
            mode = "empty";
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
            mode = "404";
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
            mode = "401";
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
            mode = "malformed";
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
            // The composite path is the only network call: no restore follow-up.
            expect(calls.filter((path) => path === "/v1/chat/completions")).toHaveLength(6);
            expect(calls.filter((path) => path === "/slots/0")).toHaveLength(0);
            const dumped = JSON.stringify(logged.mock.calls);
            expect(dumped).not.toContain(key);
            expect(dumped).not.toContain("not-json");
        } finally {
            logged.mockRestore();
        }
    });

    it("marks the sidecar stale on a splice failure and falls back to classic retrieval", async () => {
        const rows: Array<{ path: string; raw: string }> = [];
        let mode: "splice_stale" | "splice_base_seam" | "splice_render_mismatch" = "splice_stale";
        const server = serve(async (req) => {
            const url = new URL(req.url);
            rows.push({ path: `${url.pathname}${url.search}`, raw: await req.text() });
            if (mode === "splice_render_mismatch") {
                return Response.json(
                    {
                        error: {
                            type: "invalid_request_error",
                            message: "splice_render_mismatch: no anchor",
                        },
                    },
                    { status: 400 },
                );
            }
            return Response.json(
                { error: { type: mode, message: "sidecar cannot splice" } },
                { status: 409 },
            );
        });
        const baseUrl = String(server.url).replace(/\/$/, "");
        const expected = {
            splice_stale: "http_409",
            splice_base_seam: "http_409",
            splice_render_mismatch: "http_400",
        } as const;
        const tmp = tempPrefix();
        try {
            for (const reason of [
                "splice_stale",
                "splice_base_seam",
                "splice_render_mismatch",
            ] as const) {
                mode = reason;
                rmSync(staleMarkerPathFor(tmp.prefixPath), { force: true });
                rows.length = 0;
                const result = await tryStrataAskDetailed({
                    query: "q",
                    config: connection(baseUrl, { prefixPath: tmp.prefixPath }),
                });
                // The failed splice is the only request: classic retrieval answers,
                // and the rebuild is left to the write side.
                expect(result).toEqual({ status: "failed", reason: expected[reason] });
                expect(rows.map((row) => row.path)).toEqual(["/v1/chat/completions"]);
                expect(
                    (JSON.parse(rows[0]!.raw) as { strata_session: unknown }).strata_session,
                ).toEqual({ restore: "mc-mem-v1.bin", splice: true });
                expect(readSidecarStale(tmp.prefixPath)?.reason).toBe(reason);
            }
        } finally {
            tmp.cleanup();
        }
    });

    it("treats a 409 model_busy as a plain failure and leaves no stale marker", async () => {
        const tmp = tempPrefix();
        const seen: string[] = [];
        const server = serve((req) => {
            seen.push(new URL(req.url).pathname);
            return Response.json(
                { error: { type: "model_busy", message: "busy" } },
                { status: 409 },
            );
        });
        try {
            const result = await tryStrataAskDetailed({
                query: "q",
                config: connection(String(server.url).replace(/\/$/, ""), {
                    prefixPath: tmp.prefixPath,
                }),
            });
            expect(result).toEqual({ status: "failed", reason: "http_409" });
            expect(seen).toEqual(["/v1/chat/completions"]);
            expect(readSidecarStale(tmp.prefixPath)).toBeNull();
        } finally {
            tmp.cleanup();
        }
    });

    it("returns null on timeout without leaving the queue stuck", async () => {
        const server = serve(() => new Promise<Response>(() => {}));
        const result = await tryStrataAsk({
            query: "q",
            config: connection(String(server.url).replace(/\/$/, ""), { timeoutMs: 80 }),
        });
        expect(result).toBeNull();
        const follow = serve(async () =>
            Response.json({ choices: [{ message: { content: "答案" } }] }),
        );
        expect(
            await tryStrataAsk({
                query: "q",
                config: connection(String(follow.url).replace(/\/$/, "")),
            }),
        ).toContain(STRATA_ASK_FOOTER);
    });

    it("serializes concurrent composite queries", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = 0;
        const fetchImpl: typeof fetch = async () => {
            started++;
            const index = started;
            if (index === 1) await gate;
            return Response.json({
                choices: [{ message: { content: `一行答案${index}\n#1：概括` } }],
            });
        };
        const config = connection("http://127.0.0.1:9");
        const first = tryStrataAsk({ query: "one", config, fetchImpl });
        for (let i = 0; i < 50 && started < 1; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const second = tryStrataAsk({ query: "two", config, fetchImpl });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(started).toBe(1);
        release();
        const [a, b] = await Promise.all([first, second]);
        expect(a).toContain(STRATA_ASK_FOOTER);
        expect(b).toContain(STRATA_ASK_FOOTER);
        expect(started).toBe(2);
    });

    it("rejects a 2xx composite body that is not a chat completion", async () => {
        const bodies: unknown[] = [{}, null, { error: "no" }, { choices: [] }];
        let index = 0;
        const server = serve(() => {
            const body = bodies[index];
            index++;
            return Response.json(body);
        });
        const config = connection(String(server.url).replace(/\/$/, ""));
        for (let i = 0; i < bodies.length; i++) {
            expect(await tryStrataAsk({ query: "q", config })).toBeNull();
        }
        expect(index).toBe(bodies.length);
    });

    it("aborts a queued call without waiting for the in-flight request", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = 0;
        const fetchImpl: typeof fetch = async () => {
            started++;
            if (started === 1) await gate;
            return Response.json({ choices: [{ message: { content: "一行答案" } }] });
        };
        const config = connection("http://127.0.0.1:9");
        const first = tryStrataAsk({ query: "one", config, fetchImpl });
        for (let i = 0; i < 50 && started < 1; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const controller = new AbortController();
        const second = tryStrataAsk({
            query: "two",
            config,
            fetchImpl,
            signal: controller.signal,
        });
        controller.abort();
        expect(await second).toBeNull();
        expect(started).toBe(1);
        release();
        expect(await first).toContain(STRATA_ASK_FOOTER);
    });

    it("gives each query its own timeout signal", async () => {
        const signals: AbortSignal[] = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
            if (init?.signal) signals.push(init.signal);
            return Response.json({ choices: [{ message: { content: "一行答案" } }] });
        };
        const config = connection("http://127.0.0.1:9");
        expect(await tryStrataAsk({ query: "one", config, fetchImpl })).toContain(
            STRATA_ASK_FOOTER,
        );
        expect(await tryStrataAsk({ query: "two", config, fetchImpl })).toContain(
            STRATA_ASK_FOOTER,
        );
        // One request per query, and no two queries share a deadline.
        expect(signals).toHaveLength(2);
        expect(new Set(signals).size).toBe(2);
    });

    it("places the stale marker beside the prefix file it belongs to", () => {
        const prefixPath = join(tmpdir(), "mc-strata-marker", "prefix.json");
        expect(staleMarkerPathFor(prefixPath)).toBe(
            join(tmpdir(), "mc-strata-marker", "prefix.json.sidecar-stale.json"),
        );
    });
});

describe("strata status document", () => {
    const AT = "2026-11-01T00:00:00.000Z";
    const memoryView = (id: number, content: string): StatusMemoryView => ({
        id,
        category: "RESEARCH",
        content,
        updatedAt: Date.parse("2026-10-01T00:00:00.000Z"),
    });
    const change = (op: StatusChange["op"], id: number): StatusChange => ({ op, id, ts: AT });

    it("renders the ledger rows in the archive's own 增 / 正 / 讣 shapes", () => {
        const memories = new Map<number, StatusMemoryView>([
            [7, memoryView(7, "新的正文")],
            [8, memoryView(8, "改后的正文")],
        ]);
        const block = buildStrataStatusBlock(
            [change("add", 7), change("update", 8), change("remove", 9)],
            memories,
        );
        expect(block).not.toBeNull();
        expect(block!.kept).toBe(3);
        expect(block!.omitted).toBe(0);
        expect(block!.text).toContain("【近期记忆变更】");
        expect(block!.text).toContain(
            `〔${AT}〕增：\n#7 [RESEARCH] 〔2026-10-01T00:00:00.000Z〕：\n新的正文`,
        );
        expect(block!.text).toContain(`〔${AT}〕正：#8 已修改为：「改后的正文」，上文旧文作废`);
        expect(block!.text).toContain(`〔${AT}〕讣：#9 已删除/已归档，上文同号条目作废`);
    });

    it("renders an archived remove but refuses restored and permanent removes", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-restore-"));
        const prefixPath = join(directory, "prefix.json");
        const db = createStatusDb();
        const config = connection("http://127.0.0.1:9", { prefixPath });
        try {
            const restored = insertMemory(db, {
                projectPath: "git:bound",
                category: "RESEARCH",
                content: "restored memory",
            });
            const archived = insertMemory(db, {
                projectPath: "git:bound",
                category: "RESEARCH",
                content: "archived memory",
            });
            const permanent = insertMemory(db, {
                projectPath: "git:bound",
                category: "RESEARCH",
                content: "permanent memory",
            });
            updateMemoryStatus(db, permanent.id, "permanent");
            updateMemoryStatus(db, restored.id, "archived");
            updateMemoryStatus(db, restored.id, "active");
            updateMemoryStatus(db, archived.id, "archived");
            const ledgerPath = statusChangesPathFor(prefixPath, config.slotFile);
            const remove = (id: number) =>
                `${JSON.stringify({ op: "remove", id, kind: "archive", ts: AT })}\n`;
            writeFileSync(ledgerPath, remove(archived.id));
            const result = readStrataStatusDocument(config, db);
            if (!result.ok) throw new Error("expected readable status");
            expect(result.text).toContain(`讣：#${archived.id} 已删除/已归档`);

            // Even a restore without a known edit cannot prove slot content is
            // current; a permanent memory is live and must receive the same guard.
            writeFileSync(ledgerPath, remove(restored.id) + remove(archived.id));
            expect(readStrataStatusDocument(config, db)).toEqual({ ok: false });
            writeFileSync(ledgerPath, remove(permanent.id));
            expect(readStrataStatusDocument(config, db)).toEqual({ ok: false });
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("renders the remove or update even when an add is recorded early or late", async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-last-row-"));
        const prefixPath = join(directory, "prefix.json");
        const config = connection("http://127.0.0.1:9", { prefixPath });
        const ledgerPath = statusChangesPathFor(prefixPath, config.slotFile);
        const db = createStatusDb();
        const requests: string[] = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
            requests.push(body.messages[0]!.content);
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        try {
            const archived = insertMemory(db, {
                projectPath: config.project,
                category: "RESEARCH",
                content: "slot archived text",
            });
            const updated = insertMemory(db, {
                projectPath: config.project,
                category: "RESEARCH",
                content: "slot old text",
            });
            updateMemoryStatus(db, archived.id, "archived");
            const newContent = "slot new text";
            updateMemoryContent(db, updated.id, newContent, computeNormalizedHash(newContent));
            const row = (op: string, id: number) =>
                JSON.stringify({ op, id, ts: AT, ...(op === "remove" ? { kind: "archive" } : {}) });
            const added = [row("add", archived.id), row("add", updated.id)];
            const changed = [row("remove", archived.id), row("update", updated.id)];
            for (const rows of [
                [...added, ...changed],
                [...changed, ...added],
            ]) {
                writeFileSync(ledgerPath, `${rows.join("\n")}\n`);
                const result = readStrataStatusDocument(config, db);
                if (!result.ok) throw new Error("expected readable status");
                expect(result.text).toContain(`讣：#${archived.id} 已删除/已归档`);
                expect(result.text).toContain(
                    `正：#${updated.id} 已修改为：「${newContent}」，上文旧文作废`,
                );
                expect(result.text).not.toContain("增：");
                const outcome = await tryStrataAskDetailed({
                    query: "问",
                    config,
                    fetchImpl,
                    statusDocument: () => readStrataStatusDocument(config, db),
                });
                expect(outcome.status).toBe("answered");
                expect(requests.at(-1)).toContain(result.text!);
            }
            expect(requests).toHaveLength(2);
            // If a dashboard restores an archived memory without a new ledger
            // row, its retained remove must fail closed rather than hide it.
            updateMemoryStatus(db, archived.id, "active");
            expect(readStrataStatusDocument(config, db)).toEqual({ ok: false });
            expect(
                await tryStrataAskDetailed({
                    query: "问",
                    config,
                    fetchImpl,
                    statusDocument: () => readStrataStatusDocument(config, db),
                }),
            ).toEqual({ status: "failed", reason: "status_unavailable" });
            expect(requests).toHaveLength(2);
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("selects rows before pricing: vanished adds and restored removes vanish, updates become obits", () => {
        const live = memoryView(1, "live");
        const memories = new Map([[1, live]]);
        expect(renderStatusRow(change("add", 4), null)).toBeNull();
        expect(renderStatusRow(change("remove", 1), live)).toBeNull();
        const update = renderStatusRow(change("update", 2), null)!;
        const remove = renderStatusRow(change("remove", 3), null)!;
        expect(update).toContain("讣：#2 ");
        expect(remove).toContain("讣：#3 ");
        // Distinct ids prevent ledger reduction from masking row selection.
        const rows = [
            change("add", 4),
            change("remove", 1),
            change("update", 2),
            change("remove", 3),
        ];
        const budget = estimateTokens([update, remove].join("\n\n"));
        const block = buildStrataStatusBlock(rows, memories, budget)!;
        expect(block.kept).toBe(2);
        expect(block.omitted).toBe(0);
        expect(block.text).toContain(update);
        expect(block.text).toContain(remove);
    });

    it("matches the write-side boundary batch of archived adds", () => {
        const ts = "2026-10-30T00:00:00.000Z";
        const obit = (id: number) => `〔${ts}〕讣：#${id} 已删除/已归档，上文同号条目作废`;
        const ghosts: StatusChange[] = [];
        while (
            estimateTokens([obit(1), ...ghosts.map((row) => obit(row.id))].join("\n\n")) <= 2000
        ) {
            ghosts.push({ op: "add", id: ghosts.length + 2, ts });
        }
        const rows: StatusChange[] = [...ghosts, { op: "remove", id: 1, kind: "archive", ts }];
        const block = buildStrataStatusBlock(rows, new Map(), 2000)!;
        expect(estimateTokens(obit(1))).toBeLessThanOrEqual(2000);
        expect(
            estimateTokens([obit(1), ...ghosts.map((row) => obit(row.id))].join("\n\n")),
        ).toBeGreaterThan(2000);
        expect(block.kept).toBe(1);
        expect(block.omitted).toBe(0);
        expect(block.text).toContain(obit(1));
    });

    it("pins both ledger parsers to the shared corpus, including skipped torn lines", () => {
        for (const fixture of STATUS_LEDGER_FIXTURES) {
            const queryRows = parseStatusChanges(fixture.raw);
            const write = parseChanges(fixture.raw);
            const nonblank = fixture.raw
                .split("\n")
                .filter((line) => line.trim().length > 0).length;
            expect(queryRows).toEqual(fixture.changes);
            expect(write.changes).toEqual(queryRows);
            expect(write.skipped).toBe(nonblank - queryRows.length);
        }
    });

    it("rejects every skipped non-empty ledger line while accepting clean corpus rows", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-corrupt-"));
        const prefixPath = join(directory, "prefix.json");
        const config = connection("http://127.0.0.1:9", { prefixPath });
        const ledgerPath = statusChangesPathFor(prefixPath, config.slotFile);
        const db = createStatusDb();
        try {
            for (const fixture of STATUS_LEDGER_FIXTURES) {
                writeFileSync(ledgerPath, fixture.raw);
                const result = readStrataStatusDocument(config, db);
                expect(result.ok).toBe(parseChanges(fixture.raw).skipped === 0);
            }
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("keeps the block ahead of materials and question, and omits it byte-identically when empty", () => {
        const block = buildStrataStatusBlock([change("remove", 9)], new Map())!;
        expect(block.text.endsWith("\n\n")).toBe(true);
        const single = renderQueryMessage("问", undefined, block.text);
        expect(single.startsWith(block.text)).toBe(true);
        expect(single.indexOf("【近期记忆变更】")).toBeLessThan(single.indexOf("问题：问"));
        const fused = renderQueryMessage("问", "[message] ord=3 :: 材料", block.text);
        expect(fused.indexOf("【近期记忆变更】")).toBeLessThan(fused.indexOf("【期外材料】"));
        expect(fused.indexOf("【期外材料】")).toBeLessThan(fused.indexOf("问题：问"));
        expect(buildStrataStatusBlock([], new Map())).toBeNull();
        const plain = renderQueryMessage("问");
        expect(plain).not.toContain("近期记忆变更");
        expect(plain.startsWith("问题：问\n\n要求：")).toBe(true);
        expect(renderQueryMessage("问", undefined, "")).toBe(plain);
    });

    it("drops the oldest rows first when the ledger exceeds its budget", () => {
        // The cap the renderer prices against, apart from the transient budget.
        expect(DEFAULT_STATUS_BUDGET_TOKENS).toBe(2000);
        const rows = Array.from({ length: 30 }, (_, index) => change("update", index + 1));
        const memories = new Map(
            rows.map((row) => [row.id, memoryView(row.id, "很长的记忆正文".repeat(40))]),
        );
        // The price both sides of the ledger measure: flow rows only, no header.
        const price = (list: readonly StatusChange[]) =>
            estimateTokens(
                list
                    .map((row) => renderStatusRow(row, memories.get(row.id) ?? null))
                    .filter((row): row is string => row !== null)
                    .join("\n\n"),
            );
        // Three rows are the whole budget — priced on the newest three, the very
        // rows that must fit: they are kept, the oldest twenty-seven are dropped,
        // and the block says how many it dropped.
        const budget = price(rows.slice(-3));
        const block = buildStrataStatusBlock(rows, memories, budget)!;
        expect(block.kept).toBe(3);
        expect(block.omitted).toBe(27);
        expect(block.kept + block.omitted).toBe(rows.length);
        // The cap is hard on the priced rows, and the newest rows are the ones kept.
        expect(price(rows.slice(-block.kept))).toBeLessThanOrEqual(budget);
        expect(block.text).toContain(`更早的 ${block.omitted} 条变动未载入，已省略`);
        expect(block.text).toContain("#30 已修改为");
        expect(block.text).not.toContain("#1 已修改为");
        // A ledger whose newest row alone cannot fit yields no block at all.
        expect(buildStrataStatusBlock(rows.slice(0, 1), memories, 1)).toBeNull();
        // A whole small ledger fits the default cap without a truncation note.
        expect(buildStrataStatusBlock([change("remove", 9)], new Map())!.omitted).toBe(0);
        // The default 2000-token cap truncates this ledger, newest rows kept.
        const capped = buildStrataStatusBlock(rows, memories)!;
        expect(capped.kept).toBeGreaterThan(0);
        expect(capped.omitted).toBeGreaterThan(0);
        expect(capped.kept + capped.omitted).toBe(rows.length);
        expect(price(rows.slice(-capped.kept))).toBeLessThanOrEqual(DEFAULT_STATUS_BUDGET_TOKENS);
        expect(capped.text).toContain(`更早的 ${capped.omitted} 条变动未载入，已省略`);
        expect(capped.text).toContain("#30 已修改为");
    });

    it("prices flow rows only, exactly like the write side, so a fitting ledger is never truncated for the header", () => {
        const rows = Array.from({ length: 8 }, (_, index) => change("remove", index + 1));
        const rowText = (list: readonly StatusChange[]) =>
            list
                .map((row) => renderStatusRow(row, null))
                .filter((row): row is string => row !== null)
                .join("\n\n");
        const rowsPrice = estimateTokens(rowText(rows));
        // The composed block — header plus rows — is strictly larger than the rows
        // alone; header-inclusive pricing would truncate (or null) this block even
        // though the write side measures these very same rows as under the cap.
        const composedPrice = estimateTokens(
            PROMPTS.statusBlock.replace("{rows}", () => rowText(rows)),
        );
        expect(composedPrice).toBeGreaterThan(rowsPrice);
        const block = buildStrataStatusBlock(rows, new Map(), rowsPrice);
        expect(block).not.toBeNull();
        expect(block!.omitted).toBe(0);
        expect(block!.kept).toBe(rows.length);
        expect(block!.text).toContain("讣：#8 已删除/已归档，上文同号条目作废");
    });

    it("reads the ledger beside prefix_path and sends it inside the single query turn", async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-status-"));
        const prefixPath = join(directory, "prefix.json");
        const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        const config = () => connection("http://127.0.0.1:9", { prefixPath });
        const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
        const plain = [{ role: "user", content: renderQueryMessage("问") }];
        const db = createStatusDb();
        try {
            // No ledger: the turn is exactly the pre-block one.
            await tryStrataAskDetailed({ query: "问", config: config(), fetchImpl });
            expect(bodies[0]?.messages).toEqual(plain);
            // Blank lines are not ledger rows, so the turn stays byte-identical.
            writeFileSync(ledgerPath, "\n   \n");
            expect(readStrataStatusDocument(config(), db)).toEqual({ ok: true, text: null });
            await tryStrataAskDetailed({ query: "问", config: config(), fetchImpl });
            expect(bodies[1]?.messages).toEqual(plain);
            // A torn line may hide a change: fail before any cache request.
            writeFileSync(ledgerPath, '\n{"op":"ad');
            expect(readStrataStatusDocument(config(), db)).toEqual({ ok: false });
            const tornOutcome = await tryStrataAskDetailed({
                query: "问",
                config: config(),
                fetchImpl,
            });
            expect(tornOutcome).toEqual({ status: "failed", reason: "status_unavailable" });
            expect(bodies).toHaveLength(2);
            // A ledger row whose memory lookup ran and found nothing confirms the
            // memory is gone: the row renders as a 讣 and rides the single turn.
            writeFileSync(
                ledgerPath,
                `${JSON.stringify({ op: "remove", id: 42, kind: "archive", ts: AT })}\n`,
            );
            const document = readStrataStatusDocument(config(), db);
            if (!document.ok) throw new Error("expected a readable status document");
            expect(document.text).toContain("【近期记忆变更】");
            expect(document.text).toContain(`〔${AT}〕讣：#42 已删除/已归档，上文同号条目作废`);
            await tryStrataAskDetailed({
                query: "问",
                config: config(),
                fetchImpl,
                statusDocument: () => readStrataStatusDocument(config(), db),
            });
            expect(bodies[2]?.messages).toHaveLength(1);
            const content = bodies[2]!.messages[0]!.content;
            expect(content.startsWith(document.text!)).toBe(true);
            expect(content).toContain("问题：问");
            // An explicit null keeps the turn without a block even with a ledger present.
            await tryStrataAskDetailed({
                query: "问",
                config: config(),
                fetchImpl,
                statusDocument: null,
            });
            expect(bodies[3]?.messages).toEqual(plain);
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("treats an over-cap ledger as unavailable rather than sending a truncated status", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-status-"));
        const prefixPath = join(directory, "prefix.json");
        const db = createStatusDb();
        const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
        const total = 400;
        const rows = Array.from({ length: total }, (_, index) =>
            JSON.stringify({ op: "remove", id: index + 1, kind: "archive", ts: AT }),
        );
        try {
            // Far over the default cap: the block would have to drop rows, and a
            // partial status is never sent — classic retrieval answers instead.
            writeFileSync(ledgerPath, `${rows.join("\n")}\n`);
            expect(
                readStrataStatusDocument(connection("http://127.0.0.1:9", { prefixPath }), db),
            ).toEqual({ ok: false });
            // A ledger that fits still renders completely, newest rows and all.
            writeFileSync(ledgerPath, `${rows[0]}\n`);
            const fitting = readStrataStatusDocument(
                connection("http://127.0.0.1:9", { prefixPath }),
                db,
            );
            if (!fitting.ok) throw new Error("expected a readable status document");
            expect(fitting.text).toContain("讣：#1 已删除/已归档，上文同号条目作废");
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("fails a cache query to classic retrieval when a single ledger row alone exceeds the budget", async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-status-"));
        const prefixPath = join(directory, "prefix.json");
        const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
        // The isolated test store, so the default read reaches the memory lookup.
        expect(openDatabase()).not.toBeNull();
        const giant = {
            id: 7,
            projectPath: "git:bound",
            category: "RESEARCH",
            content: "超长正文，".repeat(3000),
            status: "active",
            updatedAt: Date.parse("2026-10-01T00:00:00.000Z"),
        } as unknown as Memory;
        writeFileSync(ledgerPath, `${JSON.stringify({ op: "add", id: 7, ts: AT })}\n`);
        const bodies: unknown[] = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        const lookup = spyOn(storageMemory, "getMemoriesByIds").mockReturnValue([giant]);
        try {
            // The one row cannot fit the cap: no status is sent at all; the query
            // falls back to classic retrieval instead of answering the slot
            // without the newest change.
            const outcome = await tryStrataAskDetailed({
                query: "问",
                config: connection("http://127.0.0.1:9", { prefixPath }),
                fetchImpl,
            });
            expect(outcome).toEqual({ status: "failed", reason: "status_unavailable" });
            expect(bodies).toHaveLength(0);
        } finally {
            lookup.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("treats a failed memory lookup as unavailable and never renders a 讣 from it", async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-status-"));
        const prefixPath = join(directory, "prefix.json");
        const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
        const db = createStatusDb();
        const config = connection("http://127.0.0.1:9", { prefixPath });
        // An add row: the exact fabrication a failed lookup must not produce.
        writeFileSync(ledgerPath, `${JSON.stringify({ op: "add", id: 7, ts: AT })}\n`);
        const lookup = spyOn(storageMemory, "getMemoriesByIds").mockImplementation(() => {
            throw new Error("database unavailable");
        });
        try {
            // No status text comes out of a failed lookup at all — an add row can
            // never surface as a 讣 — so the query falls back to classic retrieval.
            expect(readStrataStatusDocument(config, db)).toEqual({ ok: false });
            const bodies: unknown[] = [];
            const fetchImpl: typeof fetch = async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return Response.json({ choices: [{ message: { content: "答案" } }] });
            };
            const outcome = await tryStrataAskDetailed({
                query: "问",
                config,
                fetchImpl,
                statusDocument: () => readStrataStatusDocument(config, db),
            });
            expect(outcome).toEqual({ status: "failed", reason: "status_unavailable" });
            expect(bodies).toHaveLength(0);
            // An IO error that is not a missing ledger is a failure too, never
            // silently "no pending".
            rmSync(ledgerPath, { force: true });
            mkdirSync(ledgerPath);
            expect(readStrataStatusDocument(config, db)).toEqual({ ok: false });
            // A missing ledger stays the clean steady state: nothing to carry.
            rmSync(ledgerPath, { recursive: true, force: true });
            expect(readStrataStatusDocument(config, db)).toEqual({ ok: true, text: null });
        } finally {
            lookup.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("reads the status document inside the queue: a ledger written between enqueue and execution rides the query", async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-strata-status-"));
        const prefixPath = join(directory, "prefix.json");
        const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
        // The isolated test store, for the default-path read; the reader form
        // passes its own handle.
        expect(openDatabase()).not.toBeNull();
        const db = createStatusDb();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = 0;
        const bodies: string[] = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
            started++;
            const body = JSON.parse(String(init?.body)) as {
                messages: Array<{ content: string }>;
            };
            bodies.push(body.messages[0]!.content);
            if (started === 1) await gate;
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        const config = connection("http://127.0.0.1:9", { prefixPath });
        const row = `〔${AT}〕讣：#42 已删除/已归档，上文同号条目作废`;
        try {
            // The first query blocks the queue and never reads a status.
            const first = tryStrataAskDetailed({
                query: "先",
                config,
                fetchImpl,
                statusDocument: null,
            });
            for (let i = 0; i < 50 && started < 1; i++) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            // Both are enqueued behind it, before the ledger exists: a read frozen
            // at enqueue time would see nothing; an in-queue read sees the ledger
            // as written now and carries it.
            const second = tryStrataAskDetailed({ query: "后", config, fetchImpl });
            const third = tryStrataAskDetailed({
                query: "再",
                config,
                fetchImpl,
                statusDocument: () => readStrataStatusDocument(config, db),
            });
            writeFileSync(
                ledgerPath,
                `${JSON.stringify({ op: "remove", id: 42, kind: "archive", ts: AT })}\n`,
            );
            release();
            await Promise.all([first, second, third]);
            expect(bodies[0]).toBe(renderQueryMessage("先"));
            expect(bodies[1]).toContain(row);
            expect(bodies[2]).toContain(row);
        } finally {
            closeQuietly(db);
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
