/// <reference types="bun-types" />

/**
 * Reproduction for the first transform pass after a process restart (GitHub
 * issue 752). Skipped unless MC_REPRO_752=1.
 *
 * Magic Context keeps live provider usage in memory. After a restart that map
 * is empty and the first pass resets the persisted usage reading, so a pass
 * that is already allowed to rewrite the prefix sizes the session from a local
 * estimate of the outgoing request instead. These cases compare that boot pass
 * with the same pass in a process that still holds the live reading.
 *
 * The model is absent from the tokenizer calibration table, as any model Magic
 * Context has no measurements for is. The sizing cases request a /ctx-flush
 * with the scheduler deferring, on a session the provider last measured at 60%
 * of its usable window, with a drop queued on the newest tool output. At 60%
 * the protected tail keeps that output, so it must stay active on both the
 * warm pass and the first pass after a restart. Only a reading at 95% or more
 * lifts that protection.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resolveContextLimit, resolveContextWindowGeometry } from "./event-resolvers";
import { requestPendingMaterialization } from "./pending-materialization";
import { createTransform } from "./transform";

const ENABLED = process.env.MC_REPRO_752 === "1";
const MODEL = { providerID: "issue-752-provider", modelID: "issue-752-model" };
const MODEL_KEY = `${MODEL.providerID}/${MODEL.modelID}`;
const TRUE_PERCENTAGE = 60;

type TestMessage = {
    info: { id: string; role: string; sessionID: string };
    parts: Array<
        | { type: "text"; text: string }
        | {
              type: "tool";
              callID: string;
              tool: string;
              state: { status: "completed"; input: Record<string, string>; output: string };
          }
    >;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

beforeEach(async () => {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: {
                                [MODEL.modelID]: { limit: { context: 20_000, output: 2_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
});

afterEach(() => {
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

/** Varied prose so the tokenizer estimate stays near four characters a token. */
function prose(chars: number, seed: number): string {
    const words = ["boundary", "session", "window", "pressure", "replay", "baseline", "ordinal"];
    const out: string[] = [];
    let length = 0;
    for (let i = seed; length < chars; i++) {
        const word = words[i % words.length]!;
        out.push(word);
        length += word.length + 1;
    }
    return out.join(" ");
}

type Shape = { tools: number; chars: number };
const FEW_LARGE: Shape = { tools: 8, chars: 12_000 };
const MANY_SMALL: Shape = { tools: 60, chars: 1_400 };

function sessionMessages(sessionId: string, shape: Shape): TestMessage[] {
    const messages: TestMessage[] = [
        {
            info: { id: "u-0", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "run the listings" }],
        },
    ];
    for (let i = 0; i < shape.tools; i++) {
        messages.push({
            info: { id: `a-${i}`, role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool",
                    callID: `call-${i}`,
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: `listing ${i}` },
                        output: prose(shape.chars, i),
                    },
                },
            ],
        });
    }
    messages.push({
        info: { id: "u-1", role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: "continue" }],
    });
    return messages;
}

function newProcess(args: {
    db: ReturnType<typeof openDatabase>;
    sessionId: string;
    pending: Set<string>;
    liveUsage?: ContextUsage;
}) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: new Map(
            args.liveUsage
                ? [
                      [
                          args.sessionId,
                          { usage: args.liveUsage, updatedAt: Date.now(), hasUsageTokens: true },
                      ],
                  ]
                : [],
        ),
        db: args.db,
        liveModelBySession: new Map([[args.sessionId, MODEL]]),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: args.pending,
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
    });
}

/**
 * Seeds a session in one process, then runs a pass carrying a materialization
 * request (a /ctx-flush unless stated) with one queued drop, either in that
 * same process (live usage present) or in a fresh one (the first pass after a
 * restart).
 */
async function flushPass(
    restarted: boolean,
    shape: Shape = FEW_LARGE,
    origin: "user_flush" | "boundary_repair" = "user_flush",
    target: "newest" | "oldest" = "newest",
) {
    useTempDataHome(`issue-752-${restarted ? "boot" : "warm"}-`);
    const sessionId = `ses-issue-752-${restarted ? "boot" : "warm"}-${origin}`;
    const db = openDatabase();
    const liveLimit = resolveContextLimit(MODEL.providerID, MODEL.modelID, {
        db,
        sessionID: sessionId,
    });
    const usableHard = resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, {
        db,
        sessionID: sessionId,
    })?.usableHard;
    const liveUsage = {
        percentage: TRUE_PERCENTAGE,
        inputTokens: Math.round((liveLimit * TRUE_PERCENTAGE) / 100),
    };
    const pending = new Set<string>();
    const first = newProcess({ db, sessionId, pending, liveUsage });
    await first({}, { messages: sessionMessages(sessionId, shape) });
    // What the event handler persists after the provider measured the last reply.
    updateSessionMeta(db, sessionId, {
        lastContextPercentage: liveUsage.percentage,
        lastInputTokens: liveUsage.inputTokens,
        lastUsageContextLimit: liveLimit,
        lastObservedModelKey: MODEL_KEY,
        lastResponseTime: Date.now() - 60_000,
        cacheTtl: "1h",
    });
    const tools = getTagsBySession(db, sessionId)
        .filter((tag) => tag.type === "tool")
        .sort((a, b) => b.tagNumber - a.tagNumber);
    const newestTool = tools[0]!;
    // The newest tool output sits in the protected tail; the oldest does not.
    const queued = target === "newest" ? newestTool : tools.at(-1)!;
    queuePendingOp(db, sessionId, queued.tagNumber, "drop");

    const pass = restarted ? newProcess({ db, sessionId, pending }) : first;
    requestPendingMaterialization(pending, sessionId, origin);
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id === sessionId) lines.push(rest.map(String).join(" "));
    });
    try {
        await pass({}, { messages: sessionMessages(sessionId, shape) });
    } finally {
        spy.mockRestore();
    }
    const after = getTagsBySession(db, sessionId).find(
        (tag) => tag.tagNumber === newestTool.tagNumber,
    );
    return {
        liveLimit,
        usableHard,
        newestToolStatus: after?.status,
        droppedTools: getTagsBySession(db, sessionId).filter(
            (tag) => tag.type === "tool" && tag.status === "dropped",
        ).length,
        pendingAfter: getPendingOps(db, sessionId).length,
        passLog: lines.filter((line) =>
            /unknown provider usage|transform scheduler:|first pass reset|heuristics WILL|pending ops|emergency tiered drop/.test(
                line,
            ),
        ),
    };
}

describe.skipIf(!ENABLED)("issue 752: first pass after a restart", () => {
    // The issue claims a materialization request that is not a user /ctx-flush
    // (here the compartment boundary repair a host replay can raise) lets queued
    // drops apply. It must not: only a user /ctx-flush, a fold that changes the
    // served prefix, freshly published history or a genuine force-band reading
    // authorizes them, so on a deferred pass the queued drop stays queued.
    it("a non-user materialization request on a defer pass leaves the queued drop queued", async () => {
        const result = await flushPass(false, FEW_LARGE, "boundary_repair", "oldest");
        console.log("ISSUE_752_UNIT warm-boundary-repair", JSON.stringify(result));
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });

    it("control: a /ctx-flush with live usage keeps the protected newest tool output", async () => {
        const result = await flushPass(false);
        console.log("ISSUE_752_UNIT warm", JSON.stringify(result));
        expect(result.newestToolStatus).toBe("active");
    });

    it("a /ctx-flush on the first pass after a restart keeps the protected newest tool output", async () => {
        const result = await flushPass(true);
        console.log("ISSUE_752_UNIT boot", JSON.stringify(result));
        expect(result.newestToolStatus).toBe("active");
    });

    it("control: a /ctx-flush with live usage over many tool outputs drops only what was queued", async () => {
        const result = await flushPass(false, MANY_SMALL);
        console.log("ISSUE_752_UNIT warm-many", JSON.stringify(result));
        expect(result.droppedTools).toBeLessThanOrEqual(1);
    });

    it("a /ctx-flush after a restart over many tool outputs runs no emergency tool drop", async () => {
        const result = await flushPass(true, MANY_SMALL);
        console.log("ISSUE_752_UNIT boot-many", JSON.stringify(result));
        expect(result.passLog.some((line) => /emergency tiered drop: /.test(line))).toBe(false);
        expect(result.droppedTools).toBeLessThanOrEqual(1);
    });
});
