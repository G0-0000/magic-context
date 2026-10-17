import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { setHarness } from "../../shared/harness";
import * as logger from "../../shared/logger";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context, V2Message } from "./types";

const prose =
    "Please review the implementation and verify the results carefully before we continue with the next deployment cache invalidation step. ";

// Replace OpenCode's hook transport, config loader and initial storage probe;
// compaction, context rendering and durable SQLite use their real implementations.
async function fixture(seed: number, overrides: Record<string, unknown>) {
    setHarness("opencode2");
    const base = join(tmpdir(), "magic-context/memory-off-historian");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, `seed-${seed}-`));
    const keys = [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "MAGIC_CONTEXT_STORAGE_DIR",
        "MAGIC_CONTEXT_LOG_PATH",
        "OPENCODE_DB",
        "MC_OC2_INVISIBLE_FOLD",
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys.filter((key) => key !== "MC_OC2_INVISIBLE_FOLD"))
        process.env[key] = join(root, key);
    delete process.env.MC_OC2_INVISIBLE_FOLD;
    const clock = spyOn(Date, "now").mockReturnValue(1770000000000 + seed * 10000000);
    for (const key of keys.filter(
        (key) => !["MAGIC_CONTEXT_LOG_PATH", "OPENCODE_DB", "MC_OC2_INVISIBLE_FOLD"].includes(key),
    ))
        mkdirSync(process.env[key]!, { recursive: true });
    resetOpenCodeDbPathStateForTesting();
    const raw = new Database(process.env.OPENCODE_DB!);
    raw.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT);",
    );
    const db = openDatabase();
    if (!db) throw new Error("isolated review database unavailable");
    const opened = db.prepare("PRAGMA database_list").all() as Array<{ file: string }>;
    if (opened.some((row) => row.file && !row.file.startsWith(`${root}/`)))
        throw new Error("review database escaped isolated root");
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        embedding: { provider: "off" },
        historian: { disable: true },
        protected_tokens: 4000,
        keep_reasoning_tokens: 100000,
        commit_cluster_trigger: { enabled: false },
        ...overrides,
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    const logs = spyOn(logger, "sessionLog");
    const storage = new Map<string, unknown>();
    const hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    const host = {
        location: { directory: root },
        agent: { transform: async () => {}, reload: async () => {} },
        model: {
            list: () => [{ id: "gpt-4.1", providerID: "openai", limit: { context: 1000000 } }],
        },
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => storage.set(key, structuredClone(value)),
        },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get: async () => ({ location: { directory: root } }),
        },
    } as unknown as V2Context;
    const session = `ses709review-${seed}`;
    raw.prepare("INSERT INTO session_v2(id,directory) VALUES (?,?)").run(session, root);
    const source: V2Message[] = Array.from({ length: 24 + (seed % 8) }, (_, n) => ({
        id: `s${seed}-${n}`,
        role: n % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `${seed}/${n}: ${prose.repeat(2 + ((seed + n) % 7))}` }],
    }));
    if (source.at(-1)?.role !== "user") source.pop();
    for (const [seq, message] of source.entries())
        raw.prepare(
            "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
        ).run(
            message.id!,
            session,
            message.role,
            seq,
            Date.now() - 2000000 + seq * 1000,
            JSON.stringify({
                content: message.content,
                model: { providerID: "openai", id: "gpt-4.1" },
                time: { completed: Date.now() },
                tokens: { input: 10000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
        );
    resetCtxReduceRegisteredGloballyForTest();
    resetLkgSlotsForTest();
    const duties = await registerContext(host);
    let checkpoint: V2Message | undefined;
    function inputDraft(): SessionContext {
        return {
            sessionID: session,
            model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
            agent: "build",
            system: [{ type: "text", text: "Review the isolated project." }],
            tools: { read: { description: "Read a file", input: { type: "object" } } },
            options: {},
            messages: structuredClone(checkpoint ? [checkpoint, ...source.slice(-3)] : source),
        };
    }
    return {
        meta: () => getOrCreateSessionMeta(db, session),
        async pass() {
            const draft = inputDraft();
            const before = logs.mock.calls.length;
            await hooks.get("context")!(draft);
            return {
                bytes: JSON.stringify({
                    system: draft.system,
                    tools: draft.tools,
                    messages: draft.messages,
                }),
                logs: logs.mock.calls.slice(before).map((args) => args.map(String).join(" ")),
            };
        },
        async fold(_beforeContext: boolean) {
            const draft = inputDraft();
            await hooks.get("compaction")!(draft);
            if (!draft.result) throw new Error("compaction hook supplied no summary");
            const id = `fold-${seed}`;
            raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            ).run(
                id,
                session,
                "compaction",
                source.length,
                Date.now(),
                JSON.stringify({
                    status: "completed",
                    summary: draft.result.summary,
                    time: { completed: Date.now() },
                }),
            );
            checkpoint = {
                id,
                role: "user",
                content: [{ type: "text", text: `<summary>\n${draft.result.summary}\n</summary>` }],
            };
        },
        async cleanup() {
            await duties.dispose();
            logs.mockRestore();
            probe.mockRestore();
            load.mockRestore();
            clock.mockRestore();
            _resetDreamTimerForTests();
            closeDatabase();
            raw.close();
            resetLkgSlotsForTest();
            resetCtxReduceRegisteredGloballyForTest();
            for (const key of keys) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
            resetOpenCodeDbPathStateForTesting();
            cleanupTestTempDir(root);
        },
    };
}

const foldFeaturesOff = {
    dreamer: { disable: true, inject_docs: true },
    memory: {
        enabled: true,
        auto_search: { enabled: false },
        git_commit_indexing: { enabled: false },
    },
    temporal_awareness: false,
    mural: { enabled: false },
    caveman_text_compression: { enabled: false },
    history_budget_percentage: 0.15,
};

test("render review: first compaction before context initializes durable storage", async () => {
    const f = await fixture(4910, foldFeaturesOff);
    try {
        expect(f.meta().systemPromptHash ?? "").toBe("");
        await f.fold(true);
        expect(f.meta().cachedM0SystemHash ?? "").toBe("");
        const first = await f.pass();
        const replay = await f.pass();
        console.log(
            `FIRST_FOLD ${JSON.stringify({ systemHash: f.meta().systemPromptHash, cachedHash: f.meta().cachedM0SystemHash, logs: first.logs })}`,
        );
        expect(replay.bytes).toBe(first.bytes);
        expect(first.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
        expect(replay.logs.filter((line) => /HARD.*executed=true/.test(line))).toEqual([]);
    } finally {
        await f.cleanup();
    }
});

test("cold fold adopts the initialized MD5 system identity without a corrective HARD", async () => {
    const f = await fixture(4911, foldFeaturesOff);
    try {
        await f.fold(true);
        expect(f.meta().cachedM0SystemHash ?? "").toBe("");
        const first = await f.pass();
        expect(f.meta().systemPromptHash).toMatch(/^[a-f0-9]{32}$/);
        expect(f.meta().cachedM0SystemHash).toBe(f.meta().systemPromptHash);
        const replay = await f.pass();
        expect(replay.bytes).toBe(first.bytes);
        expect(
            [...first.logs, ...replay.logs].filter((line) =>
                /HARD.*executed=true|HARD reason=boot_recovery/.test(line),
            ),
        ).toEqual([]);
    } finally {
        await f.cleanup();
    }
});
