/// <reference types="bun-types" />
// Reproductions of places where an OpenCode 2 instruction row (an id-less
// `system` message) that the history boundary covers is not kept the same way
// on every pass, so one pass serves it and the next does not. Each test fails
// on the current code and is skipped by default so the suite stays green; set
// MC_CACHE_REVIEW_FINDINGS=1 to run them.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { isHostRenderedSystemMessage } from "./host-served-rows";
import { prepareCompartmentInjection } from "./inject-compartments";
import { runCompartmentPhase } from "./transform-compartment-phase";

const findingTest = process.env.MC_CACHE_REVIEW_FINDINGS === "1" ? test : test.skip;

let tempDir: string | undefined;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-issue-750-cache-review-"));
    process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// At 95% context the transform waits for a running historian and, when the
// run published history that a deferred refresh is waiting on, prepares the
// history injection a second time (transform-compartment-phase.ts,
// awaitCompartmentRun). That second preparation trims the request without the
// list that sets covered OpenCode 2 instruction rows (id-less `system`
// messages) aside, so an instruction row the new compartment covers is dropped
// from this pass. The next pass trims at the same boundary through the first
// preparation, sets the row aside and, with the session's retention switch on,
// serves it again: a defer pass that no longer matches its predecessor.
findingTest(
    "cache review finding: fails until fixed — historian inline-join re-preparation drops a covered OpenCode 2 instruction row",
    async () => {
        const sessionId = "ses-750-review-inline-join";
        const db = openDatabase();
        if (!db) throw new Error("isolated database unavailable");
        let finishHistorian!: () => void;
        const activeRun = registerActiveCompartmentRun(
            sessionId,
            new Promise<void>((resolve) => {
                finishHistorian = resolve;
            }),
        );
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 3,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "Inline fold",
                content: "The historian completed within the inline join budget.",
            },
        ]);
        activeRun.published = true;
        const instruction = {
            info: { role: "system" },
            parts: [{ type: "text", text: "Today's date is now: day 2." }],
        };
        const input = [
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "start" }] },
            instruction,
            { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
            { info: { id: "m3", role: "user" }, parts: [{ type: "text", text: "next" }] },
        ];
        const messages = [...input];
        expect(isHostRenderedSystemMessage(instruction as never)).toBe(true);
        const pass = runCompartmentPhase({
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: true },
            contextUsage: { percentage: 97 },
            boundaryContextLimit: 100_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 97, inputTokens: 97_000 },
            boundaryUsageSource: "live",
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            historianTimeoutMs: 600_000,
            skipAwaitForThisPass: true,
            compartmentDirectory: "/tmp",
            messages: messages as never,
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set([sessionId]),
        });
        finishHistorian();
        const result = await pass;
        expect(result.awaitedCompartmentRun).toBe(true);
        expect(result.pendingCompartmentInjection?.block).toContain("Inline fold");
        // The next pass's history preparation replays this boundary and sets the
        // instruction row aside, so that pass serves it (retention switch on).
        const nextPassSetAside: unknown[] = [];
        prepareCompartmentInjection(
            db,
            sessionId,
            structuredClone(input) as never,
            false,
            undefined,
            undefined,
            undefined,
            nextPassSetAside as never,
        );
        expect(nextPassSetAside).toHaveLength(1);
        // The covered rows are cut, but the instruction row must survive the
        // trim, as it does when the first preparation of a pass makes the cut.
        expect(messages.map((message) => message.info.id ?? "instruction")).toContain(
            "instruction",
        );
    },
);
