/**
 * The cross-session expand ownership gate reads `session_projects.updated_at`
 * as "when this session last changed project", so the upsert semantic is
 * pinned here: a no-op re-observation keeps the original `updated_at`, and
 * only an actual project-path change bumps it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { recordSessionProjectIdentity } from "./session-project-storage";

const PROJECT_A = "git:storage-a";
const PROJECT_B = "git:storage-b";

function readUpdatedAt(db: Database, sessionId: string): number | undefined {
    const row = db
        .prepare("SELECT updated_at AS updatedAt FROM session_projects WHERE session_id = ?")
        .get(sessionId) as { updatedAt: number } | undefined;
    return row?.updatedAt;
}

describe("recordSessionProjectIdentity updated_at semantics", () => {
    let root: string;
    let cleanup: () => void;
    let db: Database | undefined;
    const originalNow = Date.now;

    beforeEach(() => {
        const temp = createTestTempDir("mc-session-project-storage-");
        root = temp.dir;
        cleanup = temp.cleanup;
        db = new Database(join(root, "context.db"));
        initializeDatabase(db);
        runMigrations(db);
        // The harness latch is one-way; each test starts from the unlocked
        // default so a harness switch (or another test file's lock) cannot leak.
        _resetHarnessForTesting();
        setHarness("opencode");
    });

    afterEach(() => {
        db?.close();
        cleanup();
        Date.now = originalNow;
        _resetHarnessForTesting();
    });

    it("keeps the original updated_at on a no-op re-observation and bumps it only on an actual project change", () => {
        Date.now = () => 100;
        recordSessionProjectIdentity(db!, "ses-a", PROJECT_A);
        expect(readUpdatedAt(db!, "ses-a")).toBe(100);

        Date.now = () => 300;
        recordSessionProjectIdentity(db!, "ses-a", PROJECT_A);
        expect(readUpdatedAt(db!, "ses-a")).toBe(100);

        Date.now = () => 400;
        recordSessionProjectIdentity(db!, "ses-a", PROJECT_B);
        expect(readUpdatedAt(db!, "ses-a")).toBe(400);

        Date.now = () => 900;
        recordSessionProjectIdentity(db!, "ses-a", PROJECT_B);
        expect(readUpdatedAt(db!, "ses-a")).toBe(400);
    });

    it("scopes the binding to the active harness", () => {
        Date.now = () => 100;
        recordSessionProjectIdentity(db!, "ses-multi", PROJECT_A);
        // Same mechanism as session-retention.test.ts: reset the one-way latch,
        // then lock to the second harness.
        _resetHarnessForTesting();
        setHarness("opencode2");
        Date.now = () => 500;
        recordSessionProjectIdentity(db!, "ses-multi", PROJECT_A);
        const rows = db!
            .prepare(
                "SELECT harness, updated_at AS updatedAt FROM session_projects WHERE session_id = ? ORDER BY harness",
            )
            .all("ses-multi") as Array<{ harness: string; updatedAt: number }>;
        expect(rows).toEqual([
            { harness: "opencode", updatedAt: 100 },
            { harness: "opencode2", updatedAt: 500 },
        ]);
    });
});
