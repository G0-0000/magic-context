/// <reference types="bun-types" />

/**
 * A historian run whose boundary snapshot disagrees with the exact read ends
 * without publishing. The runner never adopts a snapshot re-resolved from the
 * same serving-thread reads: when the exact validation reports stale, the run
 * is a no-op with no failure count, and the next trigger retries from current
 * state (rebuilding any drifted serving-thread ranks first).
 */
import { afterEach, expect, it, mock, spyOn } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import { getCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getHistorianFailureState } from "../../features/magic-context/storage-meta-persisted";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { isServingOrdinalDriftSignal, runCompartmentAgent } from "./compartment-runner-incremental";
import {
    clearProducerModelObservations,
    prepareProducerFixture,
} from "./producer-window-test-support";
import { createDefaultBoundarySnapshotForTests } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanups.reverse()) fn();
    cleanups.length = 0;
});

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function messages(count: number): RawMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        parts: [
            {
                type: "text",
                text: `message ${index + 1} with enough content to survive the noise gate`,
            },
        ],
    }));
}

function historianClient(prompts: string[]): PluginContext["client"] {
    return {
        session: {
            get: mock(async () => ({ data: { directory: "/tmp/stale-refusal" } })),
            create: mock(async () => ({ data: { id: `child-${Math.random()}` } })),
            prompt: mock(async (input: unknown) => {
                prompts.push(JSON.stringify(input));
                return {};
            }),
            messages: mock(async () => ({
                data: [
                    {
                        info: { role: "assistant", time: { created: 1 } },
                        parts: [
                            {
                                type: "text",
                                text: `<output><compartments><compartment start="1" end="2" title="Drifted" episode_type="debug" importance="50"><p1>Must never publish.</p1><p2>Drifted.</p2><p3>Drifted.</p3><p4>drifted</p4></compartment></compartments><meta><messages_processed>1-2</messages_processed><unprocessed_from>3</unprocessed_from></meta></output>`,
                            },
                        ],
                    },
                ],
            })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

it("classifies only serving-read disagreements as ordinal drift signals", () => {
    expect(isServingOrdinalDriftSignal("offset ordinal 12 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("last ordinal 6 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("protectedTailStart ordinal 4 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("eligibleEnd ordinal 3 id changed")).toBe(true);
    expect(isServingOrdinalDriftSignal("raw message count shrank")).toBe(true);
    expect(isServingOrdinalDriftSignal("last compartment moved: offset 1 -> 2")).toBe(false);
    expect(isServingOrdinalDriftSignal("raw range fingerprint changed")).toBe(false);
    expect(isServingOrdinalDriftSignal("context limit changed from 1 to 2")).toBe(false);
    expect(isServingOrdinalDriftSignal(undefined)).toBe(false);
});

it("refuses to publish when the snapshot disagrees with the exact read", async () => {
    const db = createDb();
    const sessionId = "ses-stale-refusal";
    const logSpy = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => messages(6),
        getMessageCount: () => 6,
    });
    cleanups.push(
        () => logSpy.mockRestore(),
        unregister,
        () => closeQuietly(db),
    );
    const logged = () => logSpy.mock.calls.map((call) => call.slice(1).join(" "));

    // The trigger's snapshot names the wrong message at the eligible head's
    // first ordinal, as a drifted serving-thread read would. The exact
    // validation read disagrees, so the snapshot is stale.
    const snapshot = {
        ...createDefaultBoundarySnapshotForTests(sessionId),
        offsetMessageId: "wrong-id",
        rawRangeFingerprint: "non-empty-so-validation-runs",
    };

    const prompts: string[] = [];
    const holderId = `holder-${Math.random()}`;
    expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();
    try {
        await runCompartmentAgent(
            await prepareProducerFixture({
                client: historianClient(prompts),
                db,
                sessionId,
                historianChunkTokens: 10_000,
                historianTimeoutMs: 5_000,
                boundarySnapshot: snapshot,
                currentContextLimit: 128_000,
                directory: "/tmp/stale-refusal",
                memoryEnabled: false,
                fallbackModels: [],
                compartmentLeaseHolderId: holderId,
            }),
        );
    } finally {
        clearProducerModelObservations();
        releaseCompartmentLease(db, sessionId, holderId);
    }

    // Nothing was summarized off the stale snapshot: no model call, no
    // compartment, no failure count. The next trigger retries from current
    // state instead.
    expect(prompts).toHaveLength(0);
    expect(getCompartments(db, sessionId)).toHaveLength(0);
    expect(getHistorianFailureState(db, sessionId).failureCount).toBe(0);
    const runs = db
        .prepare("SELECT status FROM historian_runs WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId) as { status?: string } | null;
    expect(runs?.status).toBe("noop");
    expect(
        logged().some((line) =>
            line.includes(
                "historian: refusing to publish over a stale protected-tail snapshot (was: offset ordinal 1 id changed)",
            ),
        ),
    ).toBe(true);
    // Provider sessions keep no serving-thread ranks, so there is nothing to rebuild.
    expect(logged().some((line) => line.includes("dropped drifted ordinal checkpoints"))).toBe(
        false,
    );
});
