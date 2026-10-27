/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { closeDatabase, getTagsBySession, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { clearLegacyForeignTextTagsForTest, collectForeignTextParts } from "./foreign-text-parts";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
    __ignoredNotificationTest.setHoldDetector(() => false);
    tempDir = createTestTempDirFromPath(join(tmpdir(), "context-transform-foreign-text-"));
    process.env.XDG_DATA_HOME = tempDir;
    process.env.XDG_CACHE_HOME = tempDir;
});

afterEach(() => {
    __ignoredNotificationTest.reset();
    __resetMessageIndexAsyncForTests();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    clearLegacyForeignTextTagsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tempDir = undefined;
});

it("an OpenCode 1 defer pass serves another plugin's appended marker as that plugin wrote it", async () => {
    const sessionId = "ses-foreign-transform";
    const scheduler: Scheduler = { shouldExecute: () => "defer" };
    const contextUsageMap = new Map<string, { usage: ContextUsage; updatedAt: number }>([
        [sessionId, { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() }],
    ]);
    const db = openDatabase();
    const transform = createTransform({
        tagger: createTagger(),
        // The same dependency the OpenCode 1 hook supplies.
        collectForeignTextParts,
        scheduler,
        contextUsageMap,
        db,
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
    });
    // OpenCode 1 rebuilds the array from storage on every step; the other
    // plugin then appends its current marker as a fresh id-less part.
    const pass = async (marker: string) => {
        const user = {
            info: { id: "m-user", role: "user", sessionID: sessionId },
            parts: [
                { id: "prt_1", type: "text", text: "Plan this change" },
                { type: "text", text: marker },
            ],
        };
        const messages = [
            user,
            {
                info: { id: "m-assistant", role: "assistant", sessionID: sessionId },
                parts: [{ id: "prt_2", type: "text", text: "Working on it" }],
            },
        ];
        await transform({}, { messages });
        return user.parts.map((part) => part.text);
    };

    const first = await pass("<cortexkit-internal-effort-anchor-v1 digest=\"a\"/>");
    const second = await pass("<cortexkit-internal-effort-anchor-v1 digest=\"b\"/>");

    expect(first?.[0]).toStartWith("§1§ ");
    expect(first?.[1]).toBe("<cortexkit-internal-effort-anchor-v1 digest=\"a\"/>");
    expect(second?.[0]).toBe(first?.[0]);
    expect(second?.[1]).toBe("<cortexkit-internal-effort-anchor-v1 digest=\"b\"/>");
    expect(getTagsBySession(db, sessionId).some((tag) => tag.messageId === "m-user:p1")).toBe(
        false,
    );
});
