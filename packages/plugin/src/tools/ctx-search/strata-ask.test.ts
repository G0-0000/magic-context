import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "../../config";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { LIVE_RELOAD_CONFIG_PATHS, MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as logger from "../../shared/logger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    DEFAULT_TRANSIENT_BUDGET_TOKENS,
    isStrataAskEligible,
    strataRouteFor,
    tryStrataAskDetailed,
    resolveOpenCodeStrataAsk,
    STRATA_ASK_FOOTER,
    STRATA_ASK_T4,
    strataAskConnectionFromConfig,
    strataAskConnectionForProject,
    strataNoThinking,
    tryStrataAsk,
    type StrataAskConnection,
} from "./strata-ask";
import { readSidecarStale, staleMarkerPathFor } from "./sidecar-stale";

const PREFIX = [
    { role: "system", content: "sys-bytes" },
    { role: "user", content: "memory-bytes" },
    { role: "assistant", content: "ack-bytes" },
];

function connection(baseUrl: string, patch: Partial<StrataAskConnection> = {}): StrataAskConnection {
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

function readPrefix(): string {
    return JSON.stringify(PREFIX);
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
        expect(strataRouteFor({ query: "where", sources: ["memory"], limit: 3 })).toBe("memory-only");
        expect(strataRouteFor({ query: "where", sources: ["memory", "memory"], limit: 3 })).toBe("memory-only");
        expect(strataRouteFor({ query: "where", sources: [] })).toBeNull();
        expect(strataRouteFor({ query: "where", sources: [], limit: 3 })).toBeNull();
        expect(strataRouteFor({ query: "where", sources: ["memory", "note"] })).toBeNull();
        expect(strataRouteFor({ query: "where", sources: ["memory", "note"], limit: 3 })).toBeNull();
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
            enabled: true, base_url: "http://localhost:9", api_key: "key", model: "model",
            project: "git:main", slot_file: "main.bin", prefix_path: "/tmp/main.json",
            max_tokens: 2048, timeout_ms: 60000,
        };
        const resolve = (value?: number) => strataAskConnectionFromConfig({
            memory: { strata_ask: { ...raw, transient_budget_tokens: value } },
        })?.transientBudgetTokens;
        expect(resolve()).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
        expect(resolve(321.5)).toBe(321.5);
        expect(resolve(0)).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
        expect(resolve(Infinity)).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
        expect(resolve(8193)).toBe(DEFAULT_TRANSIENT_BUDGET_TOKENS);
    });

    it("requires exactly the three target strings", () => {
        const parse = (target: object) => MagicContextConfigSchema.safeParse({ memory: { strata_ask: { targets: [target] } } });
        const target = { project: "git:other", slot_file: "other.bin", prefix_path: "/tmp/other.json" };
        expect(parse(target).success).toBe(true);
        expect(parse({ project: target.project, slot_file: target.slot_file }).success).toBe(false);
        expect(parse({ ...target, model: "override" }).success).toBe(false);
    });

    it("routes primary first, then targets, and disables unmatched or non-enabled projects", () => {
        const raw = {
            enabled: true, base_url: "http://localhost:9", api_key: "key", model: "model",
            project: "git:main", slot_file: "main.bin", prefix_path: "/tmp/main.json",
            max_tokens: 2048, timeout_ms: 60000,
            targets: [
                { project: "git:main", slot_file: "shadow.bin", prefix_path: "/tmp/shadow.json" },
                { project: "git:other", slot_file: "other.bin", prefix_path: "/tmp/other.json" },
                { project: "git:other", slot_file: "later.bin", prefix_path: "/tmp/later.json" },
            ],
        };
        const config = { memory: { strata_ask: raw } };
        expect(strataAskConnectionForProject(config, "git:main")?.slotFile).toBe("main.bin");
        expect(strataAskConnectionForProject(config, "git:other")?.slotFile).toBe("other.bin");
        expect(strataAskConnectionForProject(config, "git:other")?.prefixPath).toBe("/tmp/other.json");
        expect(strataAskConnectionForProject(config, "git:missing")).toBeNull();
        expect(strataAskConnectionForProject({ memory: { strata_ask: { ...raw, enabled: false } } }, "git:other")).toBeNull();
        expect(strataAskConnectionForProject({ memory: { strata_ask: { ...raw, enabled: undefined } } }, "git:other")).toBeNull();
        expect(strataAskConnectionFromConfig({ memory: { strata_ask: { ...raw, project: undefined } } })).toBeNull();
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
            "问题：{q}\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 讣告作废之条目勿引；修正之条目以新文为准；据作废条目作答即为错。\n4. 记忆库无相关信息，则只答「记忆库中无」。",
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
            readFileImpl: () => {
                throw new Error("the query path must not read prefix.json");
            },
        });
        expect(seen.map((row) => row.path)).toEqual(["/v1/chat/completions"]);
        expect(seen[0]?.auth).toBe("Bearer strata-test-key");
        expect(seen[0]?.body).toEqual(compositeBody(STRATA_ASK_T4.replace("{q}", "sqlite 在哪")));
        const messages = (seen[0]?.body as { messages: Array<{ role: string }> }).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]?.role).toBe("user");
        expect(STRATA_ASK_FOOTER).toBe(
            "——本答案由项目记忆缓存合成，可能融合期外材料摘要；记忆原文可按 #id 用 ctx_memory get，其余确切原文请用 ctx_expand 或显式 sources 参数",
        );
        expect(result).toBe(`答案一行\n#1032：概括\n${STRATA_ASK_FOOTER}`);
        expect(result).not.toContain("do-not-surface");
    });

    it("distinguishes answered, miss and failed outcomes", async () => {
        let mode = "answered";
        const fetchImpl: typeof fetch = async () => {
            if (mode === "failed") return new Response(null, { status: 404 });
            return Response.json({ choices: [{ message: { content: mode === "miss" ? "记忆库中无" : "答案" } }] });
        };
        const args = { query: "q", config: connection("http://127.0.0.1:9"), fetchImpl, readFileImpl: readPrefix };
        expect(await tryStrataAskDetailed(args)).toEqual({ status: "answered", text: `答案\n${STRATA_ASK_FOOTER}` });
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
        const args = { query: "哪里", config: connection("http://127.0.0.1:9"), fetchImpl, readFileImpl: readPrefix };
        await tryStrataAskDetailed(args);
        await tryStrataAskDetailed({ ...args, transient: "" });
        await tryStrataAskDetailed({ ...args, transient: "[message] ord=42 :: 材料 {q}" });
        const plain = [{ role: "user", content: STRATA_ASK_T4.replace("{q}", "哪里") }];
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
            seen.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
            return Response.json({ choices: [{ message: { content: "答案" } }] });
        };
        await tryStrataAskDetailed({
            query: "q",
            config: connection("http://127.0.0.1:9"),
            fetchImpl,
            readFileImpl: readPrefix,
        });
        expect(seen.map((row) => row.path)).toEqual(["/v1/chat/completions"]);
        expect(JSON.stringify(strataNoThinking())).toBe('{"chat_template_kwargs":{"enable_thinking":false}}');
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
        expect(messages).toEqual([{ role: "user", content: STRATA_ASK_T4.replace("{q}", "q") }]);
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
                return Response.json({ choices: [{ message: { content: "  ", reasoning_content: key } }] });
            }
            if (mode === "quoted") {
                return Response.json({ choices: [{ message: { content: "「记忆库中无」" } }] });
            }
            if (mode === "malformed") return new Response("not-json", { status: 200 });
            return Response.json({ choices: [{ message: { content: "记忆库中无" } }] });
        });
        const config = connection(String(server.url).replace(/\/$/, ""), { apiKey: key });
        try {
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
            mode = "quoted";
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
            mode = "empty";
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
            mode = "404";
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
            mode = "401";
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
            mode = "malformed";
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
            // The composite path is the only network call: no restore, no legacy retry.
            expect(calls.filter((path) => path === "/v1/chat/completions")).toHaveLength(6);
            expect(calls.filter((path) => path === "/slots/0")).toHaveLength(0);
            const dumped = JSON.stringify(logged.mock.calls);
            expect(dumped).not.toContain(key);
            expect(dumped).not.toContain("not-json");
        } finally {
            logged.mockRestore();
        }
    });

    it("answers through the byte-identical legacy flow on splice errors and marks the sidecar stale", async () => {
        const rows: Array<{ path: string; raw: string }> = [];
        let mode: "splice_stale" | "splice_base_seam" | "splice_render_mismatch" = "splice_stale";
        const server = serve(async (req) => {
            const url = new URL(req.url);
            rows.push({ path: `${url.pathname}${url.search}`, raw: await req.text() });
            if (url.pathname === "/slots/0") return Response.json({ n_restored: 1 });
            if (rows.filter((row) => row.path === "/v1/chat/completions").length === 1) {
                if (mode === "splice_render_mismatch") {
                    return Response.json(
                        { error: { type: "invalid_request_error", message: "splice_render_mismatch: no anchor" } },
                        { status: 400 },
                    );
                }
                return Response.json({ error: { type: mode, message: "sidecar cannot splice" } }, { status: 409 });
            }
            return Response.json({ choices: [{ message: { content: "旧路答案" } }] });
        });
        const baseUrl = String(server.url).replace(/\/$/, "");
        const legacy = JSON.stringify({
            model: "qwen-test",
            messages: [...PREFIX, { role: "user", content: STRATA_ASK_T4.replace("{q}", "q") }],
            max_tokens: 2048,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
        });
        const tmp = tempPrefix();
        try {
            for (const reason of ["splice_stale", "splice_base_seam", "splice_render_mismatch"] as const) {
                mode = reason;
                rows.length = 0;
                const result = await tryStrataAskDetailed({
                    query: "q",
                    config: connection(baseUrl, { prefixPath: tmp.prefixPath }),
                    readFileImpl: readPrefix,
                });
                expect(result).toEqual({ status: "answered", text: `旧路答案\n${STRATA_ASK_FOOTER}` });
                expect(rows.map((row) => row.path)).toEqual([
                    "/v1/chat/completions",
                    "/slots/0?action=restore",
                    "/v1/chat/completions",
                ]);
                // The query write is splice-only; the legacy replay is byte-identical
                // to the request this module sent before the composite endpoint.
                expect((JSON.parse(rows[0]!.raw) as { strata_session: unknown }).strata_session)
                    .toEqual({ restore: "mc-mem-v1.bin", splice: true });
                expect(rows[2]!.raw).toBe(legacy);
                expect(readSidecarStale(tmp.prefixPath)?.reason).toBe(reason);
            }
        } finally {
            tmp.cleanup();
        }
    });

    it("treats a 409 model_busy as a plain failure and never replays the legacy flow", async () => {
        const tmp = tempPrefix();
        const seen: string[] = [];
        const server = serve((req) => {
            seen.push(new URL(req.url).pathname);
            return Response.json({ error: { type: "model_busy", message: "busy" } }, { status: 409 });
        });
        try {
            const result = await tryStrataAskDetailed({
                query: "q",
                config: connection(String(server.url).replace(/\/$/, ""), { prefixPath: tmp.prefixPath }),
                readFileImpl: readPrefix,
            });
            expect(result).toEqual({ status: "failed", reason: "http_409" });
            expect(seen).toEqual(["/v1/chat/completions"]);
            expect(readSidecarStale(tmp.prefixPath)).toBeNull();
        } finally {
            tmp.cleanup();
        }
    });

    it("fails when the legacy fallback fails too and keeps the stale marker", async () => {
        const tmp = tempPrefix();
        const seen: string[] = [];
        const server = serve((req) => {
            const path = new URL(req.url).pathname;
            seen.push(path);
            if (path === "/slots/0") return Response.json({ n_restored: 1 });
            if (seen.filter((entry) => entry === "/v1/chat/completions").length === 1) {
                return Response.json({ error: { type: "splice_stale", message: "stale" } }, { status: 409 });
            }
            return new Response("boom", { status: 500 });
        });
        try {
            const result = await tryStrataAskDetailed({
                query: "q",
                config: connection(String(server.url).replace(/\/$/, ""), { prefixPath: tmp.prefixPath }),
                readFileImpl: readPrefix,
            });
            expect(result).toEqual({ status: "failed", reason: "http_500" });
            expect(readSidecarStale(tmp.prefixPath)?.reason).toBe("splice_stale");
        } finally {
            tmp.cleanup();
        }
    });

    it("fails with file_error when the legacy prefix is unreadable", async () => {
        const tmp = tempPrefix();
        const seen: string[] = [];
        const server = serve((req) => {
            seen.push(new URL(req.url).pathname);
            return Response.json({ error: { type: "splice_stale", message: "stale" } }, { status: 409 });
        });
        try {
            const result = await tryStrataAskDetailed({
                query: "q",
                config: connection(String(server.url).replace(/\/$/, ""), { prefixPath: tmp.prefixPath }),
                readFileImpl: () => {
                    throw new Error("missing");
                },
            });
            expect(result).toEqual({ status: "failed", reason: "file_error" });
            // The prefix read happens before the legacy restore, so nothing else is sent.
            expect(seen).toEqual(["/v1/chat/completions"]);
        } finally {
            tmp.cleanup();
        }
    });

    it("returns null on timeout without leaving the queue stuck", async () => {
        const server = serve(() => new Promise<Response>(() => {}));
        const result = await tryStrataAsk({
            query: "q",
            config: connection(String(server.url).replace(/\/$/, ""), { timeoutMs: 80 }),
            readFileImpl: readPrefix,
        });
        expect(result).toBeNull();
        const follow = serve(async () => Response.json({ choices: [{ message: { content: "答案" } }] }));
        expect(
            await tryStrataAsk({
                query: "q",
                config: connection(String(follow.url).replace(/\/$/, "")),
                readFileImpl: readPrefix,
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
            return Response.json({ choices: [{ message: { content: `一行答案${index}\n#1：概括` } }] });
        };
        const config = connection("http://127.0.0.1:9");
        const first = tryStrataAsk({ query: "one", config, fetchImpl, readFileImpl: readPrefix });
        for (let i = 0; i < 50 && started < 1; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const second = tryStrataAsk({ query: "two", config, fetchImpl, readFileImpl: readPrefix });
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
            expect(await tryStrataAsk({ query: "q", config, readFileImpl: readPrefix })).toBeNull();
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
        const first = tryStrataAsk({ query: "one", config, fetchImpl, readFileImpl: readPrefix });
        for (let i = 0; i < 50 && started < 1; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const controller = new AbortController();
        const second = tryStrataAsk({
            query: "two",
            config,
            fetchImpl,
            readFileImpl: readPrefix,
            signal: controller.signal,
        });
        controller.abort();
        expect(await second).toBeNull();
        expect(started).toBe(1);
        release();
        expect(await first).toContain(STRATA_ASK_FOOTER);
    });

    it("bounds a hung legacy prefix read and lets the next request proceed", async () => {
        const server = serve(() => Response.json({ error: { type: "splice_stale", message: "stale" } }, { status: 409 }));
        const tmp = tempPrefix();
        try {
            const config = connection(String(server.url).replace(/\/$/, ""), {
                timeoutMs: 40,
                prefixPath: tmp.prefixPath,
            });
            const hung = tryStrataAsk({
                query: "q",
                config,
                readFileImpl: () => new Promise<string>(() => {}),
            });
            expect(await hung).toBeNull();
            expect(
                await tryStrataAsk({
                    query: "q",
                    config: connection(String(server.url).replace(/\/$/, ""), {
                        timeoutMs: 40,
                        prefixPath: tmp.prefixPath,
                    }),
                    readFileImpl: () => {
                        throw new Error("stop");
                    },
                }),
            ).toBeNull();
        } finally {
            tmp.cleanup();
        }
    });

    it("gives each HTTP call its own timeout signal", async () => {
        const signals: AbortSignal[] = [];
        let index = 0;
        const fetchImpl: typeof fetch = async (input, init) => {
            index++;
            if (init?.signal) signals.push(init.signal);
            if (index === 1) {
                return Response.json({ error: { type: "splice_stale", message: "stale" } }, { status: 409 });
            }
            if (new URL(String(input)).pathname === "/slots/0") return Response.json({ n_restored: 1 });
            return Response.json({ choices: [{ message: { content: "一行答案" } }] });
        };
        const tmp = tempPrefix();
        try {
            expect(
                await tryStrataAsk({
                    query: "q",
                    config: connection("http://127.0.0.1:9", { prefixPath: tmp.prefixPath }),
                    fetchImpl,
                    readFileImpl: readPrefix,
                }),
            ).toContain(STRATA_ASK_FOOTER);
            // Composite query, then the legacy restore and chat: one deadline each.
            expect(signals).toHaveLength(3);
            expect(new Set(signals).size).toBe(3);
        } finally {
            tmp.cleanup();
        }
    });

    it("places the stale marker beside the prefix file it belongs to", () => {
        const prefixPath = join(tmpdir(), "mc-strata-marker", "prefix.json");
        expect(staleMarkerPathFor(prefixPath)).toBe(join(tmpdir(), "mc-strata-marker", "prefix.json.sidecar-stale.json"));
    });
});
