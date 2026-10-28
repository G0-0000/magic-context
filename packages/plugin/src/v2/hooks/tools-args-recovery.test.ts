/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginConfig } from "../../config";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    type ContextDatabase,
    closeDatabase,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerTools } from "./tools";
import type { V2Context } from "./types";

/**
 * The OpenCode 2 adapter must hand each tool the same arguments OpenCode 1 does.
 * Every ctx_* tool parses its own arguments with passthrough and falls back to
 * the raw input, so it can recover a call whose real arguments arrived wrapped
 * as `{ reduced: true, summary: "<json>" }` and tolerate a wrongly typed field.
 * A strict parse in the adapter stripped `reduced`/`summary` and threw on a bad
 * type before the tool ever saw the call.
 */

let dir: string;
let db: ContextDatabase;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-v2-tool-args-"));
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const opened = openDatabase();
    if (!opened) throw new Error("test database unavailable");
    db = opened;
});

afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

interface RegisteredTool {
    name: string;
    execute: (input: unknown, call: Record<string, unknown>) => Promise<{ content: string }>;
}

async function registeredSearch(): Promise<RegisteredTool> {
    const registered: RegisteredTool[] = [];
    const context = {
        location: { directory: dir },
        tool: {
            async transform(callback: (editor: { add: (tool: RegisteredTool) => void }) => void) {
                callback({ add: (tool) => registered.push(tool) });
            },
        },
    } as unknown as V2Context;
    await registerTools(context, db, parsePluginConfig({ memory: { enabled: true } }), undefined);
    const search = registered.find((tool) => tool.name === "ctx_search");
    if (!search) throw new Error("ctx_search was not registered");
    return search;
}

const call = { sessionID: "ses-1", messageID: "msg-1", agent: "build", progress: () => {} };

test("ctx_search recovers arguments wrapped as reduced/summary", async () => {
    const search = await registeredSearch();
    const result = await search.execute(
        { reduced: true, summary: JSON.stringify({ query: "leader election" }) },
        call,
    );
    expect(result.content).not.toContain("'query' is required");
});

test("ctx_search tolerates a wrongly typed argument instead of throwing", async () => {
    const search = await registeredSearch();
    const result = await search.execute({ query: "leader election", limit: "5" }, call);
    expect(result.content).not.toContain("'query' is required");
});

async function waitFor(ready: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !ready(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("ctx_search aborts the OC2 call signal's in-flight strata request", async () => {
    const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-oc2-strata-"));
    const identity = resolveProjectIdentityForSession(projectDir, false);
    expect(identity).toBeTruthy();
    const prefixPath = join(projectDir, "prefix.json");
    writeFileSync(prefixPath, JSON.stringify([{ role: "system", content: "sys" }]));
    let calls = 0;
    let aborted = 0;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            calls++;
            req.signal.addEventListener("abort", () => {
                aborted++;
            });
            return new Promise(() => {});
        },
    });
    const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-oc2-strata-xdg-"));
    mkdirSync(join(xdg, "cortexkit"), { recursive: true });
    writeFileSync(
        join(xdg, "cortexkit", "magic-context.jsonc"),
        JSON.stringify({
            memory: {
                strata_ask: {
                    enabled: true,
                    base_url: String(server.url).replace(/\/$/, ""),
                    api_key: "oc2-key",
                    model: "qwen-test",
                    slot_file: "mc-mem-v1.bin",
                    prefix_path: prefixPath,
                    project: identity,
                    timeout_ms: 60_000,
                },
            },
        }),
    );
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    const registered: RegisteredTool[] = [];
    const context = {
        location: { directory: projectDir },
        tool: {
            async transform(callback: (editor: { add: (tool: RegisteredTool) => void }) => void) {
                callback({ add: (tool) => registered.push(tool) });
            },
        },
    } as unknown as V2Context;
    try {
        await registerTools(context, db, parsePluginConfig({ memory: { enabled: true } }), undefined);
        const search = registered.find((tool) => tool.name === "ctx_search");
        if (!search) throw new Error("ctx_search was not registered");
        const controller = new AbortController();
        const pending = search.execute(
            { query: "where is sqlite" },
            { ...call, signal: controller.signal },
        );
        await waitFor(() => calls >= 1);
        expect(calls).toBeGreaterThan(0);
        controller.abort();
        const result = await pending;
        // The tool can return before Bun observes the client disconnect on the server.
        await waitFor(() => aborted >= 1);
        expect(aborted).toBeGreaterThan(0);
        expect(result.content).not.toContain("本答案由项目记忆缓存合成");
        const follow = new AbortController();
        const again = search.execute({ query: "where is sqlite" }, { ...call, signal: follow.signal });
        await waitFor(() => calls >= 2);
        expect(calls).toBeGreaterThanOrEqual(2);
        follow.abort();
        await again;
        await waitFor(() => aborted >= 2);
        expect(aborted).toBeGreaterThanOrEqual(2);
    } finally {
        server.stop(true);
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous;
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(xdg, { recursive: true, force: true });
    }
});
