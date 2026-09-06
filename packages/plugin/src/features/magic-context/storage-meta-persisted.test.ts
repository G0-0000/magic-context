/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    clearDeferredExecutePendingIfMatches,
    type DeferredExecutePayload,
    getPersistedEpochFloor,
    peekDeferredExecutePending,
    persistEpochFloorSnapshot,
    resetEpochFloorRegistryForTest,
    resolveEpochFloorForPass,
    setDeferredExecutePendingIfAbsent,
} from "./storage-meta-persisted";
import { ensureSessionMetaRow } from "./storage-meta-shared";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            harness TEXT NOT NULL DEFAULT 'opencode',
            last_response_time INTEGER NOT NULL DEFAULT 0,
            cache_ttl TEXT NOT NULL DEFAULT '5m',
            counter INTEGER NOT NULL DEFAULT 0,
            last_nudge_tokens INTEGER NOT NULL DEFAULT 0,
            last_nudge_band TEXT NOT NULL DEFAULT '',
            last_transform_error TEXT NOT NULL DEFAULT '',
            is_subagent INTEGER NOT NULL DEFAULT 0,
            last_context_percentage REAL NOT NULL DEFAULT 0,
            last_input_tokens INTEGER NOT NULL DEFAULT 0,
            observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_alert_sent INTEGER NOT NULL DEFAULT 0,
            times_execute_threshold_reached INTEGER NOT NULL DEFAULT 0,
            compartment_in_progress INTEGER NOT NULL DEFAULT 0,
            system_prompt_hash TEXT NOT NULL DEFAULT '',
            system_prompt_tokens INTEGER NOT NULL DEFAULT 0,
            conversation_tokens INTEGER NOT NULL DEFAULT 0,
            tool_call_tokens INTEGER NOT NULL DEFAULT 0,
            cleared_reasoning_through_tag INTEGER NOT NULL DEFAULT 0,
            last_todo_state TEXT NOT NULL DEFAULT '',
            deferred_execute_state TEXT,
            protected_tokens_effective INTEGER
        )
    `);
    return db;
}

const payload: DeferredExecutePayload = {
    id: "flag-1",
    reason: "execute-none",
    recordedAt: 1_700_000_000_000,
};

describe("deferred execute state", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it("peeks null when no deferred execute state is present", () => {
        ensureSessionMetaRow(db, "session-1");

        expect(peekDeferredExecutePending(db, "session-1")).toBeNull();
    });

    it("peeks non-null deferred execute state", () => {
        ensureSessionMetaRow(db, "session-1");
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify(payload),
            "session-1",
        );

        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });

    it("set-then-set fails when a deferred execute state already exists", () => {
        expect(setDeferredExecutePendingIfAbsent(db, "session-1", payload)).toBe(true);

        const second: DeferredExecutePayload = { ...payload, id: "flag-2" };
        expect(setDeferredExecutePendingIfAbsent(db, "session-1", second)).toBe(false);
    });

    it("set-then-peek returns the recorded deferred execute payload", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });

    it("clear-matches removes the deferred execute payload", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        expect(clearDeferredExecutePendingIfMatches(db, "session-1", payload)).toBe(true);
        expect(peekDeferredExecutePending(db, "session-1")).toBeNull();
    });

    it("clear-stale-fails leaves the deferred execute payload intact", () => {
        setDeferredExecutePendingIfAbsent(db, "session-1", payload);

        const stale: DeferredExecutePayload = { ...payload, id: "stale" };
        expect(clearDeferredExecutePendingIfMatches(db, "session-1", stale)).toBe(false);
        expect(peekDeferredExecutePending(db, "session-1")).toEqual(payload);
    });
});

describe("floor snapshot write & lifecycle (protected_tokens_effective)", () => {
    let db: Database;
    const SES = "session-test-floor";

    beforeEach(() => {
        db = createTestDb();
        resetEpochFloorRegistryForTest();
    });

    it("round-trips the snapshotted floor on a migrated schema", () => {
        expect(getPersistedEpochFloor(db, SES)).toBeNull();

        persistEpochFloorSnapshot(db, SES, 20_000);
        expect(getPersistedEpochFloor(db, SES)).toBe(20_000);

        persistEpochFloorSnapshot(db, SES, 32_000);
        expect(getPersistedEpochFloor(db, SES)).toBe(32_000);
    });

    it("does not add protected_tokens_effective from the write path", () => {
        db.exec("ALTER TABLE session_meta DROP COLUMN protected_tokens_effective");

        expect(() => persistEpochFloorSnapshot(db, SES, 20_000)).toThrow();
        const columns = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
            name: string;
        }>;
        expect(columns.some((column) => column.name === "protected_tokens_effective")).toBe(false);
    });

    it("lifecycle (a): resolves and writes on the first cache-busting pass", () => {
        expect(getPersistedEpochFloor(db, SES)).toBeNull();

        const result = resolveEpochFloorForPass(db, SES, {
            usableSoft: 200_000,
            isCacheBustingPass: true,
        });

        expect(result.floor).toBe(16_000);
        expect(result.isSnapshotPersisted).toBe(true);
        expect(result.provenance).toBe("derived");
        expect(getPersistedEpochFloor(db, SES)).toBe(16_000);
    });

    it("lifecycle (b): unsnapshotted defer pass resolves effective floor without persisting (no bust)", () => {
        expect(getPersistedEpochFloor(db, SES)).toBeNull();

        const result = resolveEpochFloorForPass(db, SES, {
            usableSoft: 200_000,
            isCacheBustingPass: false,
        });

        expect(result.floor).toBe(16_000);
        expect(result.isSnapshotPersisted).toBe(false);
        expect(result.provenance).toBe("derived");
        // Must NOT persist to DB
        expect(getPersistedEpochFloor(db, SES)).toBeNull();
    });

    it("lifecycle (b) with override: uses absolute override in pre-snapshot state", () => {
        const result = resolveEpochFloorForPass(db, SES, {
            configuredOverride: 30_000,
            usableSoft: 200_000,
            isCacheBustingPass: false,
        });

        expect(result.floor).toBe(30_000);
        expect(result.isSnapshotPersisted).toBe(false);
        expect(result.provenance).toBe("override");
        expect(getPersistedEpochFloor(db, SES)).toBeNull();
    });

    it("lifecycle (c) & (d): reads verbatim on every pass until next cache-busting pass across restart; mid-epoch changes ignored", () => {
        // First cache-busting pass snapshots 16,000
        resolveEpochFloorForPass(db, SES, {
            usableSoft: 200_000,
            isCacheBustingPass: true,
        });
        expect(getPersistedEpochFloor(db, SES)).toBe(16_000);

        // Subsequent defer pass reads snapshot verbatim
        const deferPass = resolveEpochFloorForPass(db, SES, {
            usableSoft: 200_000,
            isCacheBustingPass: false,
        });
        expect(deferPass.floor).toBe(16_000);
        expect(deferPass.isSnapshotPersisted).toBe(true);

        // Mid-epoch config change (override added or raised) or geometry move NEVER takes effect mid-epoch
        const midEpochChange = resolveEpochFloorForPass(db, SES, {
            configuredOverride: 64_000,
            usableSoft: 872_000, // would derive 43,600
            isCacheBustingPass: false,
        });
        expect(midEpochChange.floor).toBe(16_000); // untouched mid-epoch!
        expect(midEpochChange.isSnapshotPersisted).toBe(true);

        // Simulating restart: in-memory state cleared, but DB retains snapshot
        resetEpochFloorRegistryForTest();
        const postRestartDefer = resolveEpochFloorForPass(db, SES, {
            configuredOverride: 64_000,
            usableSoft: 872_000,
            isCacheBustingPass: false,
        });
        expect(postRestartDefer.floor).toBe(16_000);
    });

    it("refreshes the snapshot from current config and geometry on the next cache-busting pass", () => {
        resolveEpochFloorForPass(db, SES, {
            usableSoft: 200_000,
            isCacheBustingPass: true,
        });

        const refreshed = resolveEpochFloorForPass(db, SES, {
            configuredOverride: 32_000,
            usableSoft: 872_000,
            isCacheBustingPass: true,
        });

        expect(refreshed.floor).toBe(32_000);
        expect(refreshed.provenance).toBe("override");
        expect(refreshed.snapshotChanged).toBe(true);
        expect(getPersistedEpochFloor(db, SES)).toBe(32_000);
    });

    describe("pre-snapshot scoping in both halves", () => {
        it("Half 1: with inputs unchanged, floor identical across repeated defer passes and across restart", () => {
            // First defer pass
            const pass1 = resolveEpochFloorForPass(db, SES, {
                configuredOverride: 16_000,
                usableSoft: 200_000,
                isCacheBustingPass: false,
            });
            expect(pass1.floor).toBe(16_000);
            expect(pass1.preSnapshotInputChanged).toBe(false);

            // Repeated defer pass with unchanged inputs
            const pass2 = resolveEpochFloorForPass(db, SES, {
                configuredOverride: 16_000,
                usableSoft: 200_000,
                isCacheBustingPass: false,
            });
            expect(pass2.floor).toBe(16_000);
            expect(pass2.preSnapshotInputChanged).toBe(false);

            // Restart with unchanged inputs
            resetEpochFloorRegistryForTest();
            const postRestart = resolveEpochFloorForPass(db, SES, {
                configuredOverride: 16_000,
                usableSoft: 200_000,
                isCacheBustingPass: false,
            });
            expect(postRestart.floor).toBe(16_000);
            expect(getPersistedEpochFloor(db, SES)).toBeNull(); // still unsnapshotted
        });

        it("Half 2: pre-snapshot override edit (16,000 -> 32,000) changes resolved floor and is surfaced as config-re-read bust", () => {
            const pass1 = resolveEpochFloorForPass(db, SES, {
                configuredOverride: 16_000,
                usableSoft: 200_000,
                isCacheBustingPass: false,
            });
            expect(pass1.floor).toBe(16_000);

            // Override edited from 16,000 to 32,000 before any priced pass
            const pass2 = resolveEpochFloorForPass(db, SES, {
                configuredOverride: 32_000,
                usableSoft: 200_000,
                isCacheBustingPass: false,
            });
            expect(pass2.floor).toBe(32_000);
            expect(pass2.preSnapshotInputChanged).toBe(true);
            expect(pass2.preSnapshotBustReason).toBe("config-re-read");
            expect(pass2.floor).not.toBe(16_000);
        });

        it("Half 2: pre-snapshot geometry move changes derived floor and is surfaced as live-geometry bust", () => {
            const pass1 = resolveEpochFloorForPass(db, SES, {
                usableSoft: 100_000, // derives 8,000
                isCacheBustingPass: false,
            });
            expect(pass1.floor).toBe(8_000);

            // Geometry moves from 100k to 200k (derives 16,000)
            const pass2 = resolveEpochFloorForPass(db, SES, {
                usableSoft: 200_000,
                isCacheBustingPass: false,
            });
            expect(pass2.floor).toBe(16_000);
            expect(pass2.preSnapshotInputChanged).toBe(true);
            expect(pass2.preSnapshotBustReason).toBe("live-geometry");
        });
    });
});
