import { drainNotifications } from "../../shared/rpc-notifications";
/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getActiveCompartmentRun, registerActiveCompartmentRun } from "./compartment-runner";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import { __ignoredNotificationTest } from "./send-session-notification";
import { runCompartmentPhase } from "./transform-compartment-phase";

function createOpenCodeDb(
    sessionId: string,
    messages: Array<{ id: string; role: string; text: string }>,
): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS part (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        messages.forEach((m, idx) => {
            const ts = idx + 1;
            insertMessage.run(
                m.id,
                sessionId,
                ts,
                ts,
                JSON.stringify({ id: m.id, role: m.role, sessionID: sessionId }),
            );
            insertPart.run(m.id, sessionId, ts, ts, JSON.stringify({ type: "text", text: m.text }));
        });
    } finally {
        closeQuietly(db);
    }
}

let tempDir: string | undefined;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mc-compartment-phase-"));
    process.env.XDG_DATA_HOME = tempDir;
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    __ignoredNotificationTest.reset();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tempDir)
        try {
            rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
});

describe("runCompartmentPhase boundary handoff", () => {
    it("reuses the trigger boundary anchor without rereading the compartment row", async () => {
        const sessionId = "ses-boundary-handoff";
        createOpenCodeDb(
            sessionId,
            Array.from({ length: 6 }, (_, index) => ({
                id: `m${index + 1}`,
                role: index % 2 === 0 ? "user" : "assistant",
                text: `message ${index + 1}`,
            })),
        );
        const realDb = openDatabase();
        appendCompartments(realDb, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                title: "one",
                content: "summary",
            },
        ]);
        const preparedSql: string[] = [];
        const db = new Proxy(realDb, {
            get(target, prop, receiver) {
                if (prop === "prepare") {
                    return (sql: string) => {
                        preparedSql.push(sql);
                        return target.prepare.call(target, sql);
                    };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        }) as typeof realDb;
        const input = [{ info: { id: "m6", role: "assistant" }, parts: [] }];
        const run = async () => {
            const messages = structuredClone(input);
            await runCompartmentPhase({
                canRunCompartments: true,
                fullFeatureMode: true,
                sessionMeta: { compartmentInProgress: true },
                contextUsage: { percentage: 20 },
                boundaryContextLimit: 12_000,
                boundaryExecuteThresholdPercentage: 65,
                boundaryUsage: { percentage: 20, inputTokens: 1_000 },
                boundaryUsageSource: "live",
                db,
                sessionId,
                resolvedSessionId: sessionId,
                historianChunkTokens: 25_000,
                compartmentDirectory: "/tmp",
                messages: messages as never,
                pendingCompartmentInjection: null,
                deferredHistoryRefreshSessions: new Set(),
                preResolvedBoundarySnapshot: {
                    ...createDefaultBoundarySnapshotForTests(sessionId),
                    mode: "transform-force",
                    offset: 3,
                    lastCompartmentEndMessageId: "m2",
                    protectedTailStart: 5,
                    eligibleEndOrdinal: 5,
                    rawMessageCountAtTrigger: 6,
                },
            });
            return messages;
        };
        const first = await run();
        const second = await run();
        const digest = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");

        expect(digest(second)).toBe(digest(first));
        expect(
            preparedSql.some(
                (sql) =>
                    sql.includes("MAX(end_message)") ||
                    (sql.includes("SELECT end_message_id") && sql.includes("ORDER BY sequence")),
            ),
        ).toBe(false);
    });
});

describe("runCompartmentPhase - 95% emergency notification idempotency", () => {
    // High pressure may survive many transform passes. Publish one RPC status
    // per active historian run, never a user row that could extend that run.
    it("sends the 95% comparting notification at most once per active compartment run", async () => {
        const sessionId = "ses-notification-guard";

        // Create an OpenCode DB with enough messages so hasEligibleHistoryForCompartment
        // returns true (need raw history beyond any existing compartment end).
        createOpenCodeDb(
            sessionId,
            Array.from({ length: 12 }, (_, i) => ({
                id: `m-${i + 1}`,
                role: i % 2 === 0 ? "user" : "assistant",
                text: `message ${i + 1}`,
            })),
        );

        const db = openDatabase();

        // A status update must never call the prompt transport.
        const promptMock = mock(async () => ({ data: {} }));
        const client = {
            session: {
                prompt: promptMock,
            },
        } as unknown as PluginContext["client"];

        // Register a never-resolving active compartment run so the phase sees
        // an in-flight run on every pass. Using registerActiveCompartmentRun
        // directly avoids depending on runCompartmentAgent's network paths.
        const neverResolves = new Promise<void>(() => {});
        registerActiveCompartmentRun(sessionId, neverResolves);

        const activeRun = getActiveCompartmentRun(sessionId);
        expect(activeRun).toBeDefined();
        expect(activeRun?.notificationSent).toBeFalsy();

        const baseArgs = {
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: { compartmentInProgress: false },
            contextUsage: { percentage: 97 }, // >= 95% triggers the notification path
            boundaryContextLimit: 12_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 97, inputTokens: 7_600 },
            boundaryUsageSource: "live" as const,
            client,
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            compartmentDirectory: "/tmp",
            messages: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            // historianTimeoutMs short so the await returns "timed_out" quickly
            // (the registered activeRun never resolves on its own).
            historianTimeoutMs: 50,
        };

        // Pass 1: pressure is high, activeRun exists with notificationSent=false.
        // The notification should fire exactly once and flip notificationSent=true.
        await runCompartmentPhase(baseArgs);
        expect(promptMock).not.toHaveBeenCalled();
        expect(
            drainNotifications(0, sessionId).filter((n) =>
                String(n.payload.message).includes("Context at 97%"),
            ),
        ).toHaveLength(1);
        expect(activeRun?.notificationSent).toBe(true);

        // Pass 2: same activeRun, still notificationSent=true → no additional call.
        await runCompartmentPhase(baseArgs);
        expect(promptMock).not.toHaveBeenCalled();
        expect(
            drainNotifications(0, sessionId).filter((n) =>
                String(n.payload.message).includes("Context at 97%"),
            ),
        ).toHaveLength(1);

        // Pass 3: still 1 — never re-fires while the same run is active.
        await runCompartmentPhase(baseArgs);
        expect(promptMock).not.toHaveBeenCalled();
        expect(
            drainNotifications(0, sessionId).filter((n) =>
                String(n.payload.message).includes("Context at 97%"),
            ),
        ).toHaveLength(1);

        // Verify message text
        const notifText = drainNotifications(0, sessionId)
            .map((notice) => String(notice.payload.message))
            .find((text) => text.includes("comparting history"));
        expect(notifText).toBeDefined();
        expect(notifText).toContain("Context at 97%");
    });
    it("does not start independent compressor when historian is disabled", async () => {
        const sessionId = "ses-compressor-disabled";
        const db = openDatabase();
        appendCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "m1",
                endMessageId: "m10",
                title: "one",
                content: "large content ".repeat(200),
            },
            {
                sequence: 2,
                startMessage: 11,
                endMessage: 20,
                startMessageId: "m11",
                endMessageId: "m20",
                title: "two",
                content: "large content ".repeat(200),
            },
        ]);
        const promptMock = mock(async () => ({ data: {} }));
        const client = { session: { prompt: promptMock } } as unknown as PluginContext["client"];

        await runCompartmentPhase({
            canRunCompartments: false,
            fullFeatureMode: true,
            historianRunnable: false,
            sessionMeta: { compartmentInProgress: false },
            contextUsage: { percentage: 20 },
            boundaryContextLimit: 12_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 20, inputTokens: 1_000 },
            boundaryUsageSource: "live",
            client,
            db,
            sessionId,
            resolvedSessionId: sessionId,
            historianChunkTokens: 25_000,
            historyBudgetTokens: 1,
            compartmentDirectory: "/tmp",
            messages: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set<string>(),
            safeForBackgroundCompression: true,
        });

        expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
        expect(promptMock).not.toHaveBeenCalled();
    });
});
