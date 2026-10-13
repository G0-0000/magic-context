import { afterEach, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    setPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { estimateFinalWireInputTokens, estimateMessageTokens } from "./final-wire-token-estimate";
import {
    capturePrefixTrimSourceOrder,
    clearInjectionCache,
    injectM0M1,
    materializeM0,
    prepareCompartmentInjection,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

// The ordinary run records known failures without making the rest of the suite red.
// Run MC_POST_FLUSH_EXPECT_FIXED=1 to see the unfixed assertions fail normally.
const regression = process.env.MC_POST_FLUSH_EXPECT_FIXED === "1" ? it : it.failing;
const sessionId = "ses-post-flush-reproduction";
const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const originalDataHome = process.env.XDG_DATA_HOME;
let root: string | undefined;

function setup() {
    root = createTestTempDirFromPath(join(tmpdir(), "post-flush-reproduction-"));
    process.env.XDG_DATA_HOME = root;
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    resolveCtxReduceAvailabilityFromMessages(sessionId, [message("user", "user")] as never);
    return db;
}

afterEach(() => {
    clearInjectionCache(sessionId);
    clearCtxReduceAvailability(sessionId);
    closeReadOnlySessionDb();
    closeDatabase();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
});

function message(id: string, role: "user" | "assistant"): MessageLike {
    return { info: { id, role, sessionID: sessionId }, parts: [{ type: "text", text: id }] };
}

function promptHandler(db: ReturnType<typeof setup>) {
    const historyRefreshSessions = new Set<string>();
    const systemPromptRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const { handler } = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => model,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId: new Map(),
    });
    return {
        handler,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
    };
}

it("recognized date freezes on warm passes and advances with a refresh signal", async () => {
    const db = setup();
    const { handler, systemPromptRefreshSessions, pendingMaterializationSessions } =
        promptHandler(db);
    await handler({ sessionID: sessionId }, { system: ["Base\nToday's date: 2026-10-12"] });
    const warm = { system: ["Base\nToday's date: 2026-10-13"] };
    await handler({ sessionID: sessionId }, warm);
    expect(warm.system.join("\n")).toContain("Today's date: 2026-10-12");
    expect(pendingMaterializationSessions.size).toBe(0);
    systemPromptRefreshSessions.add(sessionId);
    const refresh = { system: ["Base\nToday's date: 2026-10-13"] };
    await handler({ sessionID: sessionId }, refresh);
    expect(refresh.system.join("\n")).toContain("Today's date: 2026-10-13");
    expect(systemPromptRefreshSessions.size).toBe(0);
});

regression("plugin-env Date stays frozen on a warm signed-loop request", async () => {
    const db = setup();
    const { handler } = promptHandler(db);
    const prompt = (date: string) => `Base\n<plugin-env>\n  Date: ${date}\n</plugin-env>`;
    await handler({ sessionID: sessionId }, { system: [prompt("2026-10-12")] });
    const warm = { system: [prompt("2026-10-13")] };
    await handler({ sessionID: sessionId }, warm);
    expect(warm.system.join("\n")).toContain("Date: 2026-10-12");
});

for (const hasSourceOrder of [false, true]) {
    const run = hasSourceOrder ? it : regression;
    run(
        `fresh prefix and replay cut at the same removed assistant seam (sourceOrder=${hasSourceOrder})`,
        () => {
            const db = setup();
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "covered-user",
                    endMessageId: "assistant-boundary",
                    title: "Covered history",
                    content: "The previous request completed.",
                },
            ]);
            const options = {
                db,
                sessionId,
                state: getOrCreateSessionMeta(db, sessionId),
                injectDocs: false,
            };
            const rendered = materializeM0(options);
            const source = [
                message("covered-user", "user"),
                message("assistant-boundary", "assistant"),
                message("retained-user", "user"),
            ];
            // Preserve the original row order, but remove the assistant boundary
            // from the live array before injectM0M1 delivers the history prefix.
            const fresh = source.filter((m) => m.info.id !== "assistant-boundary");
            const delivered = injectM0M1({
                ...options,
                messages: fresh,
                isCacheBustingPass: true,
                prefixTrimSourceOrder: hasSourceOrder
                    ? capturePrefixTrimSourceOrder(source)
                    : undefined,
                preparedPrefix: {
                    injected: true,
                    prependedMessageCount: 0,
                    m0RematerializedThisPass: true,
                    materializationContentionRetryExhausted: false,
                    decision: { value: true, reason: "explicit_flush" },
                    m0Bytes: rendered.m0Bytes,
                    m1Text: rendered.m1Text,
                    preparedMessages: [],
                    preparedTrimBoundaryId: "assistant-boundary",
                },
            });
            const replay = structuredClone(source);
            prepareCompartmentInjection(db, sessionId, replay, false);
            expect(replay.map((m) => m.info.id)).toEqual(["retained-user"]);
            expect(delivered.preparedTrimBoundaryId).toBe("assistant-boundary");
            expect(fresh.map((m) => m.info.id)).toEqual(replay.map((m) => m.info.id));
        },
    );
}

it("mural image estimation is independent of base64 payload length", () => {
    setup();
    const image = (payload: string) =>
        ({
            info: { id: "mural", role: "user" },
            parts: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${payload}` }],
        }) as unknown as MessageLike;
    const tiny = estimateMessageTokens(image("AAAA"));
    const large = estimateMessageTokens(image("AAAA".repeat(32_000)));
    expect(tiny).toEqual(large);
    expect(large.conversation).toBeLessThan(10_000);
});

regression("opaque thinking signatures do not turn a fitting request into refusal evidence", () => {
    setup();
    const plain = {
        info: { id: "thinking", role: "assistant" },
        parts: [
            {
                type: "reasoning",
                text: "A short thought",
                metadata: { anthropic: { signature: "" } },
            },
        ],
    } as unknown as MessageLike;
    const signed = structuredClone(plain);
    const signature = Buffer.from(
        Array.from({ length: 6000 }, (_, i) => (i * 73 + (i >> 2)) % 256),
    ).toString("base64");
    (
        signed.parts[0] as unknown as { metadata: { anthropic: { signature: string } } }
    ).metadata.anthropic.signature = signature;
    const envelope = { ...model, systemPromptTokens: 100, toolDefinitionTokens: 100 };
    const baseline = estimateFinalWireInputTokens({ ...envelope, messages: [plain] });
    const withSignature = estimateFinalWireInputTokens({ ...envelope, messages: [signed] });
    expect(baseline.tokens).toBeLessThan(1_000);
    expect(withSignature.refusalGrade).toBe(true);
    expect(withSignature.refusalTokens).toBeLessThan(1_000);
});

it("system-first date miss queues a second fold and marker write at the next user turn", async () => {
    const db = setup();
    const oldBoundary = "msg_01";
    const oldSummary = "msg_02";
    const newBoundary = "msg_03";
    const newEnd = "msg_04";
    const tailUser = "msg_05";
    const thinking = "msg_06";
    mkdirSync(join(root!, "opencode"), { recursive: true });
    const hostDb = new Database(join(root!, "opencode", "opencode.db"));
    hostDb.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    for (const [index, id] of [
        oldBoundary,
        oldSummary,
        newBoundary,
        newEnd,
        tailUser,
        thinking,
    ].entries()) {
        const role = [oldSummary, newEnd, thinking].includes(id) ? "assistant" : "user";
        hostDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
            id,
            sessionId,
            index * 1000,
            index * 1000,
            JSON.stringify({
                role,
                ...(id === oldSummary ? { summary: true } : {}),
                ...(role === "assistant" ? { finish: "stop" } : {}),
            }),
        );
        hostDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
            `${id}-text`,
            id,
            sessionId,
            index * 1000,
            index * 1000,
            JSON.stringify({
                type: "text",
                text: id === oldSummary ? MARKER_SUMMARY_TEXT : id,
            }),
        );
    }
    hostDb
        .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
        .run(
            "old-compaction",
            oldBoundary,
            sessionId,
            0,
            0,
            JSON.stringify({ type: "compaction", auto: true }),
        );
    hostDb.close();
    setPersistedCompactionMarkerState(db, sessionId, {
        boundaryMessageId: oldBoundary,
        summaryMessageId: oldSummary,
        compactionPartId: "old-compaction",
        summaryPartId: `${oldSummary}-text`,
        boundaryOrdinal: 1,
        targetEndMessageId: oldBoundary,
    });
    const signals = promptHandler(db);
    const prompt = (date: string) => `Base\n<plugin-env>\n  Date: ${date}\n</plugin-env>`;
    await signals.handler({ sessionID: sessionId }, { system: [prompt("2026-10-12")] });
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 1,
            startMessageId: oldBoundary,
            endMessageId: oldBoundary,
            title: "Old",
            content: "Old history",
        },
    ]);
    const deferredHistoryRefreshSessions = new Set<string>();
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => "defer" },
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 35, inputTokens: 30_000 }, updatedAt: Date.now() }],
        ]),
        liveModelBySession: new Map([[sessionId, model]]),
        historyRefreshSessions: signals.historyRefreshSessions,
        pendingMaterializationSessions: signals.pendingMaterializationSessions,
        deferredHistoryRefreshSessions,
        lastHeuristicsTurnId: new Map(),
        directory: root!,
        sessionDirectoryBySession: new Map([[sessionId, root!]]),
        protectedTokens: 0,
    });
    const source = () => [
        message(oldBoundary, "user"),
        {
            ...message(oldSummary, "assistant"),
            info: {
                id: oldSummary,
                role: "assistant",
                sessionID: sessionId,
                summary: true,
                finish: "stop",
            },
            parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
        },
        message(newBoundary, "user"),
        message(newEnd, "assistant"),
        message(tailUser, "user"),
    ];
    await transform({}, { messages: source() });
    const signedSource = () =>
        [
            ...source(),
            {
                info: {
                    id: thinking,
                    role: "assistant",
                    sessionID: sessionId,
                    finish: "tool-calls",
                },
                parts: [
                    {
                        type: "reasoning",
                        text: "Signed thought",
                        metadata: { anthropic: { signature: "opaque-signature" } },
                    },
                    {
                        type: "tool",
                        callID: "read-call",
                        tool: "read",
                        state: { status: "completed", input: {}, output: "small result" },
                    },
                ],
            },
        ] as unknown as MessageLike[];
    const baseline = signedSource();
    await transform({}, { messages: baseline });
    const summaryText = (rows: MessageLike[]) =>
        rows.find((row) => row.info.summary)?.parts[0]?.text;
    const before = summaryText(baseline);
    expect(before).toContain(MARKER_SUMMARY_TEXT);
    appendCompartments(db, sessionId, [
        {
            sequence: 1,
            startMessage: 2,
            endMessage: 4,
            startMessageId: newBoundary,
            endMessageId: newEnd,
            title: "New",
            content: "New history",
        },
    ]);
    setPendingCompactionMarkerState(db, sessionId, {
        ordinal: 4,
        endMessageId: newEnd,
        publishedAt: Date.now(),
    });
    deferredHistoryRefreshSessions.add(sessionId);
    await signals.handler({ sessionID: sessionId }, { system: [prompt("2026-10-13")] });
    expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(true);
    const held = signedSource();
    await transform({}, { messages: held });
    expect(summaryText(held)).toBe(before);
    expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(true);
    expect(getPersistedCompactionMarkerState(db, sessionId)?.summaryMessageId).toBe(oldSummary);
    const released = [...signedSource(), message("msg_07", "user")];
    await transform({}, { messages: released });
    expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(false);
    expect(getPersistedCompactionMarkerState(db, sessionId)?.summaryMessageId).not.toBe(oldSummary);
    expect(summaryText(released)).not.toBe(before);
    expect(summaryText(released)).toContain(MARKER_SUMMARY_TEXT);
});
