#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
    DebugHeapSnapshotResponse,
    DebugMemoryUsageResponse,
} from "../../plugin/src/shared/rpc-types";
import { TestHarness } from "../src/harness";

interface Scenario {
    name: string;
    hooksEnabled: boolean;
    embedding: "off" | "local";
    shadow: boolean;
}

interface ScenarioResult {
    scenario: Scenario;
    sessionId: string;
    requestedMessages: number;
    memory: DebugMemoryUsageResponse;
    featureStatus: string;
    heapSnapshotPath?: string;
}

function rpcDiscoveryFile(dataDir: string): string | null {
    const root = join(dataDir, "cortexkit", "magic-context", "rpc");
    if (!existsSync(root)) return null;
    for (const project of readdirSync(root)) {
        const directory = join(root, project);
        for (const entry of readdirSync(directory)) {
            const path = join(directory, entry);
            if (entry.startsWith("port-") && entry.endsWith(".json") && existsSync(path)) return path;
        }
    }
    return null;
}

async function readRpcDiscovery(dataDir: string): Promise<{ port: number; token: string }> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const path = rpcDiscoveryFile(dataDir);
        if (path) {
            return JSON.parse(readFileSync(path, "utf8")) as { port: number; token: string };
        }
        await Bun.sleep(100);
    }
    throw new Error("No hermetic Magic Context RPC discovery record after 30s");
}

async function callDebugRpc<T>(
    discovery: { port: number; token: string },
    method: "debug.memoryUsage" | "debug.heapSnapshot",
): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${discovery.token}` },
        body: "{}",
        signal: AbortSignal.timeout(180_000),
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok || result.error) {
        throw new Error(`${method} failed (${response.status}): ${result.error ?? "unknown"}`);
    }
    return result;
}

function scenarioConfig(scenario: Scenario): Record<string, unknown> {
    return {
        enabled: scenario.hooksEnabled,
        debug_rpc: true,
        dreamer: { disable: true },
        sidekick: { disable: true },
        memory: { enabled: true },
        embedding:
            scenario.embedding === "local"
                ? { provider: "local", local_runtime: "native" }
                : { provider: "off" },
        shadow_embedding: { enabled: scenario.shadow },
        commit_cluster_trigger: { enabled: false },
    };
}

async function runScenario(
    scenario: Scenario,
    requestedMessages: number,
    captureHeap: boolean,
): Promise<ScenarioResult> {
    const prompts = Math.ceil(requestedMessages / 2);
    const harness = await TestHarness.create({
        magicContextConfig: scenarioConfig(scenario),
        expectedMagicContextState: scenario.hooksEnabled ? "enabled" : "configured-disabled",
        modelContextLimit: 1_000_000,
    });

    try {
        const discovery = await readRpcDiscovery(harness.opencode.env.dataDir);
        const sessionId = await harness.createSession();
        for (let turn = 1; turn <= prompts; turn += 1) {
            await harness.sendPrompt(
                sessionId,
                `Hermetic native-memory A/B turn ${String(turn).padStart(4, "0")}: retain this fixed-width marker.`,
            );
            if (turn % 100 === 0) {
                console.error(`[${scenario.name}] drove ${turn * 2} messages`);
            }
        }
        await harness.waitForMockQuiescence({ label: scenario.name });

        let memory = await callDebugRpc<DebugMemoryUsageResponse>(
            discovery,
            "debug.memoryUsage",
        );
        if (scenario.embedding === "local") {
            const deadline = Date.now() + 120_000;
            while (!memory.native.localEmbedding.loaded && Date.now() < deadline) {
                await Bun.sleep(500);
                memory = await callDebugRpc<DebugMemoryUsageResponse>(
                    discovery,
                    "debug.memoryUsage",
                );
            }
        }

        const driven = memory.holders.sessions.find((session) => session.sessionId === sessionId);
        if (
            scenario.hooksEnabled &&
            (!driven || driven.taggerAssignments < requestedMessages)
        ) {
            throw new Error(
                `long-session holder proof failed: expected >=${requestedMessages} assignments, got ${driven?.taggerAssignments ?? 0}`,
            );
        }

        let heapSnapshotPath: string | undefined;
        if (captureHeap && scenario.name === "mc-on-embeddings-off") {
            const snapshot = await callDebugRpc<DebugHeapSnapshotResponse>(
                discovery,
                "debug.heapSnapshot",
            );
            heapSnapshotPath = snapshot.path;
        }

        return {
            scenario,
            sessionId,
            requestedMessages,
            memory,
            featureStatus:
                scenario.embedding === "local" && !memory.native.localEmbedding.loaded
                    ? "local model was not loaded within 120s"
                    : scenario.shadow
                      ? "shadow requested; inspect routing logs/native table"
                      : "exercised",
            ...(heapSnapshotPath ? { heapSnapshotPath } : {}),
        };
    } finally {
        await harness.dispose();
    }
}

function mib(bytes: number | null | undefined): string {
    return bytes === null || bytes === undefined ? "n/a" : (bytes / 1024 / 1024).toFixed(1);
}

function printTable(results: ScenarioResult[]): void {
    const baseline = results.find(
        (result) => result.scenario.name === "hooks-off",
    )?.memory.memoryUsage;
    const embeddingBaseline = results.find(
        (result) => result.scenario.name === "mc-on-embeddings-off",
    )?.memory.memoryUsage;
    const embeddingOn = results.find(
        (result) => result.scenario.name === "mc-on-embeddings-on",
    )?.memory.memoryUsage;
    const header = [
        "scenario",
        "RSS MiB",
        "ΔRSS vs hooks-off MiB",
        "ΔRSS feature MiB",
        "heap MiB",
        "external MiB",
        "arrayBuffers MiB",
        "SQLite conns",
        "SQLite cache max MiB",
        "LKG MiB",
        "wire est. MiB",
        "tokenizer table MiB",
        "model cache MiB",
        "embedding",
    ];
    const rows = results.map(({ scenario, memory, featureStatus }) => {
        const featureBaseline = scenario.shadow ? embeddingOn : embeddingBaseline;
        return [
            scenario.name,
            mib(memory.memoryUsage.rss),
            baseline ? mib(memory.memoryUsage.rss - baseline.rss) : "0.0",
            scenario.embedding === "local" && featureBaseline
                ? mib(memory.memoryUsage.rss - featureBaseline.rss)
                : "n/a",
            mib(memory.memoryUsage.heapTotal),
            mib(memory.memoryUsage.external),
            mib(memory.memoryUsage.arrayBuffers),
            String(memory.native.sqlite.connectionCount),
            mib(memory.native.sqlite.cacheUpperBoundBytes),
            mib(memory.holders.lkgSlots.totalBytes),
            mib(memory.holders.wireCache.estimatedBytes),
            mib(memory.native.tokenizer.tableBytes),
            mib(memory.native.localEmbedding.modelCacheBytes),
            `${memory.native.localEmbedding.loaded ? "loaded" : "off"} (${featureStatus})`,
        ];
    });
    console.log(`| ${header.join(" | ")} |`);
    console.log(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

async function main(): Promise<void> {
    const requestedMessages = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 2_000);
    if (!Number.isSafeInteger(requestedMessages) || requestedMessages < 2_000) {
        throw new Error("message target must be an integer >= 2000");
    }
    const captureHeap = process.argv.includes("--heap");
    const scenarios: Scenario[] = [
        { name: "hooks-off", hooksEnabled: false, embedding: "off", shadow: false },
        { name: "mc-on-embeddings-off", hooksEnabled: true, embedding: "off", shadow: false },
        { name: "mc-on-embeddings-on", hooksEnabled: true, embedding: "local", shadow: false },
    ];
    if (process.env.MC_E2E_MODE === "rust") {
        scenarios.push({
            name: "mc-on-shadow-on",
            hooksEnabled: true,
            embedding: "local",
            shadow: true,
        });
    }

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
        results.push(await runScenario(scenario, requestedMessages, captureHeap));
    }
    printTable(results);
    if (process.env.MC_E2E_MODE !== "rust") {
        console.log("\nshadow A/B skipped: the TS fixture has no hermetic subc/Synapse lane");
    }
    console.log(`\nraw=${JSON.stringify(results, null, 2)}`);
}

if (import.meta.main) await main();
