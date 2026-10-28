import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "../../config";
import { LIVE_RELOAD_CONFIG_PATHS, MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as logger from "../../shared/logger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    isStrataAskEligible,
    resolveOpenCodeStrataAsk,
    STRATA_ASK_FOOTER,
    STRATA_ASK_T4,
    strataAskConnectionFromConfig,
    tryStrataAsk,
    type StrataAskConnection,
} from "./strata-ask";

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

    it("rejects explicit limit, sources including [], from, to, and id-shaped queries", () => {
        expect(isStrataAskEligible({ query: "where", limit: 3 })).toBe(false);
        expect(isStrataAskEligible({ query: "where", sources: [] })).toBe(false);
        expect(isStrataAskEligible({ query: "where", sources: ["memory"] })).toBe(false);
        expect(isStrataAskEligible({ query: "where", from: "2026-01-01" })).toBe(false);
        expect(isStrataAskEligible({ query: "where", to: "2026-02-01" })).toBe(false);
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
        });
        expect(strataAskConnectionFromConfig(parsed)).toBeNull();
    });

    it("keeps a project enabled opt-in and strips project connection fields", () => {
        const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-strata-xdg-"));
        const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-strata-proj-"));
        mkdirSync(join(xdg, "cortexkit"), { recursive: true });
        mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
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
                        project: "git:bound",
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
            expect(loaded.memory.strata_ask.project).toBe("git:bound");
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
                project: "git:bound",
                maxTokens: 1024,
                timeoutMs: 1500,
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

    it("locks the T4 template and replays prefix bytes in restore-then-chat order", async () => {
        expect(STRATA_ASK_T4).toBe(
            "问题：{q}\n\n要求：仅依据记忆库作答，从简：\n1. 第一行给答案，一句话（50字内）。\n2. 其后每行列一条依据记忆，格式「#id：该条记忆之一句话概括（30字内）」。\n3. 记忆库无相关信息，则只答「记忆库中无」。",
        );
        const seen: Array<{ path: string; body: unknown; auth: string | null }> = [];
        const server = serve(async (req) => {
            const url = new URL(req.url);
            seen.push({
                path: `${url.pathname}${url.search}`,
                body: await req.json(),
                auth: req.headers.get("Authorization"),
            });
            if (url.pathname === "/slots/0") return Response.json({ n_restored: 4 });
            return Response.json({
                choices: [
                    {
                        message: {
                            content: "答案一行\n#1032：概括",
                            reasoning_content: "do-not-surface",
                        },
                    },
                ],
            });
        });
        const result = await tryStrataAsk({
            query: "sqlite 在哪",
            config: connection(String(server.url).replace(/\/$/, "")),
            readFileImpl: readPrefix,
        });
        expect(seen.map((row) => row.path)).toEqual([
            "/slots/0?action=restore",
            "/v1/chat/completions",
        ]);
        expect(seen[0]?.body).toEqual({ filename: "mc-mem-v1.bin" });
        expect(seen[0]?.auth).toBe("Bearer strata-test-key");
        const chat = seen[1]?.body as {
            model: string;
            max_tokens: number;
            stream: boolean;
            messages: Array<Record<string, unknown>>;
        };
        expect(chat.model).toBe("qwen-test");
        expect(chat.max_tokens).toBe(2048);
        expect(chat.stream).toBe(false);
        expect(chat.messages.slice(0, 3)).toEqual(PREFIX);
        expect(chat.messages[3]).toEqual({
            role: "user",
            content: STRATA_ASK_T4.replace("{q}", "sqlite 在哪"),
        });
        expect(result).toBe(`答案一行\n#1032：概括\n${STRATA_ASK_FOOTER}`);
        expect(result).not.toContain("do-not-surface");
        expect(result).not.toContain("Found ");
    });

    it("returns null for an exact miss, empty content, 404, 401, malformed JSON, and a missing file", async () => {
        const key = "strata-secret-key-should-not-leak";
        const logged = spyOn(logger, "log").mockImplementation(() => {});
        const calls: string[] = [];
        let mode = "miss";
        const server = serve(async (req) => {
            const url = new URL(req.url);
            calls.push(url.pathname);
            if (url.pathname === "/slots/0") {
                if (mode === "404") return new Response(key, { status: 404 });
                if (mode === "401") return new Response(key, { status: 401 });
                return Response.json({ n_restored: 1 });
            }
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
            expect(
                await tryStrataAsk({
                    query: "q",
                    config,
                    readFileImpl: () => {
                        throw new Error(key);
                    },
                }),
            ).toBeNull();
            expect(calls.filter((path) => path === "/v1/chat/completions")).toHaveLength(4);
            expect(calls.filter((path) => path === "/slots/0")).toHaveLength(6);
            const dumped = JSON.stringify(logged.mock.calls);
            expect(dumped).not.toContain(key);
            expect(dumped).not.toContain("not-json");
        } finally {
            logged.mockRestore();
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
        const follow = serve(async () => Response.json({ n_restored: 1 }));
        expect(
            await tryStrataAsk({
                query: "q",
                config: connection(String(follow.url).replace(/\/$/, "")),
                readFileImpl: () => {
                    throw new Error("stop");
                },
            }),
        ).toBeNull();
    });

    it("serializes restore and chat across concurrent calls", async () => {
        const events: string[] = [];
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fetchImpl: typeof fetch = async (input) => {
            const url = String(input);
            events.push(new URL(url).pathname);
            if (events.length === 1) await gate;
            if (url.includes("/slots/")) return Response.json({ n_restored: 1 });
            return Response.json({
                choices: [{ message: { content: "一行答案\n#1：概括" } }],
            });
        };
        const config = connection("http://127.0.0.1:9");
        const first = tryStrataAsk({ query: "one", config, fetchImpl, readFileImpl: readPrefix });
        for (let i = 0; i < 50 && events.length < 1; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const second = tryStrataAsk({ query: "two", config, fetchImpl, readFileImpl: readPrefix });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(events).toEqual(["/slots/0"]);
        release();
        const [a, b] = await Promise.all([first, second]);
        expect(a).toContain(STRATA_ASK_FOOTER);
        expect(b).toContain(STRATA_ASK_FOOTER);
        expect(events).toEqual(["/slots/0", "/v1/chat/completions", "/slots/0", "/v1/chat/completions"]);
    });

    it("rejects a 2xx restore body that is not a numeric n_restored", async () => {
        const bodies: unknown[] = [{}, null, { error: "no" }, { n_restored: "1" }];
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

    it("aborts a queued call without waiting for the in-flight restore", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started = 0;
        const fetchImpl: typeof fetch = async (input) => {
            started++;
            if (String(input).includes("/slots/")) {
                await gate;
                return Response.json({ n_restored: 1 });
            }
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

    it("bounds a hung prefix read and lets the next request proceed", async () => {
        const config = connection("http://127.0.0.1:9", { timeoutMs: 40 });
        const hung = tryStrataAsk({
            query: "q",
            config,
            readFileImpl: () => new Promise<string>(() => {}),
        });
        expect(await hung).toBeNull();
        expect(
            await tryStrataAsk({
                query: "q",
                config: connection("http://127.0.0.1:9"),
                readFileImpl: () => {
                    throw new Error("stop");
                },
            }),
        ).toBeNull();
    });

    it("gives each HTTP call its own timeout signal", async () => {
        const signals: AbortSignal[] = [];
        const fetchImpl: typeof fetch = async (input, init) => {
            if (init?.signal) signals.push(init.signal);
            if (String(input).includes("/slots/")) return Response.json({ n_restored: 1 });
            return Response.json({ choices: [{ message: { content: "一行答案" } }] });
        };
        expect(
            await tryStrataAsk({
                query: "q",
                config: connection("http://127.0.0.1:9"),
                fetchImpl,
                readFileImpl: readPrefix,
            }),
        ).toContain(STRATA_ASK_FOOTER);
        expect(signals).toHaveLength(2);
        expect(signals[0]).not.toBe(signals[1]);
    });
});
