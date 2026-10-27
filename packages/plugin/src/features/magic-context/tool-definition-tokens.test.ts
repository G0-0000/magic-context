import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    __resetToolDefinitionMeasurements,
    getCurrentToolSetHash,
    getMeasuredToolDefinitionTokens,
    getSessionToolDefinitionTokens,
    getToolDefinitionMeasurementSignature,
    getToolDefinitionSnapshot,
    loadToolDefinitionMeasurements,
    recordToolDefinition,
    recordToolDefinitionSet,
    setDatabase,
} from "./tool-definition-tokens";

function createTestDb(): Database {
    const db = new Database(":memory:");
    // initializeDatabase creates session_meta + tags etc., needed by older
    // migrations (v5 heal, v6 counter heal). Then runMigrations applies the
    // versioned migrations including v9 (tool_definition_measurements).
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("tool-definition-tokens", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("returns undefined before any measurement", () => {
        expect(
            getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus"),
        ).toBeUndefined();
    });

    test("hashes observed tool names without treating schema edits as tool-set changes", () => {
        expect(getCurrentToolSetHash("p", "m", "a")).toBe("");
        recordToolDefinition("p", "m", "a", "bash", "schema one", { version: 1 });
        const first = getCurrentToolSetHash("p", "m", "a");
        recordToolDefinition("p", "m", "a", "bash", "schema two", { version: 2 });
        expect(getCurrentToolSetHash("p", "m", "a")).toBe(first);
        recordToolDefinition("p", "m", "a", "edit", "edit schema", {});
        expect(getCurrentToolSetHash("p", "m", "a")).not.toBe(first);
    });

    test("records and retrieves tokens for a provider/model/agent key", () => {
        recordToolDefinition(
            "anthropic",
            "claude-sonnet-4.7",
            "sisyphus",
            "bash",
            "Run a shell command",
            { type: "object", properties: { command: { type: "string" } } },
        );
        const total = getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus");
        expect(total).toBeGreaterThan(0);
        // Description + serialized params should both contribute.
        expect(total).toBeGreaterThan(5);
    });

    test("sums multiple tools under same key", () => {
        recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
            type: "object",
        });
        recordToolDefinition("p", "m", "a", "edit", "Edit a file", {
            type: "object",
        });
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(total).toBeGreaterThan(0);

        // Removing one tool via a snapshot helper doesn't exist — idempotent
        // re-record should replace, not add.
        recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
            type: "object",
        });
        const after = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(after).toBe(total);
    });

    test("isolates measurements by agent within same model", () => {
        recordToolDefinition("p", "m", "sisyphus", "bash", "x".repeat(100), {});
        recordToolDefinition("p", "m", "historian", "summarize", "y".repeat(50), {});
        const a = getMeasuredToolDefinitionTokens("p", "m", "sisyphus") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "m", "historian") ?? 0;
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(0);
        expect(a).not.toBe(b);
    });

    test("isolates measurements by model within same agent", () => {
        recordToolDefinition("p", "model-a", "sisyphus", "bash", "x".repeat(100), {});
        recordToolDefinition("p", "model-b", "sisyphus", "bash", "x".repeat(50), {});
        const a = getMeasuredToolDefinitionTokens("p", "model-a", "sisyphus") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "model-b", "sisyphus") ?? 0;
        expect(a).toBeGreaterThan(b);
    });

    test("treats missing agent as 'default' scope", () => {
        recordToolDefinition("p", "m", undefined, "bash", "x".repeat(40), {});
        const explicit = getMeasuredToolDefinitionTokens("p", "m", "default");
        const implicit = getMeasuredToolDefinitionTokens("p", "m", undefined);
        expect(explicit).toBe(implicit);
        expect(implicit).toBeGreaterThan(0);
    });

    test("same toolID on later flight overwrites its slot, not accumulates", () => {
        recordToolDefinition("p", "m", "a", "bash", "v1 description", { v: 1 });
        const first = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        recordToolDefinition("p", "m", "a", "bash", "v2 description", { v: 2 });
        const second = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        // Second flight replaces first — totals should reflect v2 only, not v1+v2.
        expect(second).toBeGreaterThan(0);
        expect(second).not.toBe(first * 2);
    });

    test("ignores invalid inputs", () => {
        recordToolDefinition("", "m", "a", "bash", "desc", {});
        recordToolDefinition("p", "", "a", "bash", "desc", {});
        recordToolDefinition("p", "m", "a", "", "desc", {});
        expect(getMeasuredToolDefinitionTokens("", "m", "a")).toBeUndefined();
        expect(getMeasuredToolDefinitionTokens("p", "", "a")).toBeUndefined();
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBeUndefined();
    });

    test("handles unserializable parameters without throwing", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        // Should not throw even when JSON.stringify would fail.
        recordToolDefinition("p", "m", "a", "bad-tool", "desc", circular);
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        // Description still contributes even if params can't be serialized.
        expect(total).toBeGreaterThan(0);
    });

    test("snapshot helper lists all measurements", () => {
        recordToolDefinition("anthropic", "sonnet", "sisyphus", "bash", "a", {});
        recordToolDefinition("openai", "gpt-5", "historian", "sum", "b", {});
        const snapshot = getToolDefinitionSnapshot();
        expect(snapshot.length).toBe(2);
        expect(snapshot.every((s) => s.totalTokens > 0)).toBe(true);
        expect(snapshot.every((s) => s.toolCount === 1)).toBe(true);
    });
});

describe("tool-definition-tokens current tool set", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    const fly = (tools: string[], sessionId?: string) => {
        for (const id of tools)
            recordToolDefinition("p", "m", "a", id, `${id} `.repeat(50), {}, sessionId);
    };
    const single = (id: string) => {
        fly([id]);
        const tokens = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        __resetToolDefinitionMeasurements();
        return tokens;
    };

    test("OpenCode 1: a tool the host stopped offering leaves the total two flights later", () => {
        const read = single("read");
        const lsp = single("lsp");
        fly(["read", "lsp"]);
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBe(read + lsp);
        const withLsp = getCurrentToolSetHash("p", "m", "a");
        fly(["read"]);
        // The previous flight still counts: a read in the middle of a flight
        // must not undercount the tools that flight has not fired yet.
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBe(read + lsp);
        fly(["read"]);
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBe(read);
        expect(getCurrentToolSetHash("p", "m", "a")).not.toBe(withLsp);
        expect(getToolDefinitionSnapshot()).toEqual([
            { key: "p/m/a", totalTokens: read, toolCount: 1 },
        ]);
    });

    test("OpenCode 1: repeated flights of one tool set keep one total", () => {
        fly(["read", "edit", "bash"]);
        const total = getMeasuredToolDefinitionTokens("p", "m", "a");
        for (let flight = 0; flight < 5; flight += 1) fly(["read", "edit", "bash"]);
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBe(total);
    });

    test("OpenCode 2: each request's tool set replaces the route's and the session's", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            const set = (ids: string[], sessionId: string) =>
                recordToolDefinitionSet(
                    "p",
                    "m",
                    "a",
                    ids.map((id) => ({ id, description: `${id} `.repeat(50), parameters: {} })),
                    sessionId,
                );
            set(["read", "lsp"], "wide");
            const both = getMeasuredToolDefinitionTokens("p", "m", "a", "wide") ?? 0;
            const wideHash = getCurrentToolSetHash("p", "m", "a", "wide");
            set(["read"], "narrow");
            const read = getMeasuredToolDefinitionTokens("p", "m", "a", "narrow") ?? 0;
            expect(read).toBeGreaterThan(0);
            expect(read).toBeLessThan(both);
            // Each session keeps its own request's set, whichever wrote last.
            expect(getMeasuredToolDefinitionTokens("p", "m", "a", "wide")).toBe(both);
            expect(getCurrentToolSetHash("p", "m", "a", "wide")).toBe(wideHash);
            expect(getCurrentToolSetHash("p", "m", "a", "narrow")).not.toBe(wideHash);
            // Without a session, the route's figure is its last request's set.
            expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBe(read);
            expect(getSessionToolDefinitionTokens("wide")).toBe(both);
            expect(getSessionToolDefinitionTokens("unknown")).toBeUndefined();
            // The stored rows follow the route's current set.
            expect(db.prepare("SELECT tool_id FROM tool_definition_measurements").all()).toEqual([
                { tool_id: "read" },
            ]);
            set([], "empty");
            expect(getMeasuredToolDefinitionTokens("p", "m", "a", "empty")).toBe(0);
            expect(getCurrentToolSetHash("p", "m", "a", "empty")).toBe("");
        } finally {
            closeQuietly(db);
        }
    });

    test("rows loaded at startup count only until the route's first live flight", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            fly(["read", "lsp", "edit"]);
            const all = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            // Restart.
            __resetToolDefinitionMeasurements();
            loadToolDefinitionMeasurements(db);
            setDatabase(db);
            expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBe(all);
            // Loaded content is unverified: no signature can vouch for it.
            expect(getToolDefinitionMeasurementSignature("p", "m", "a")).toBeUndefined();
            fly(["read"]);
            const read = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(read).toBeGreaterThan(0);
            expect(read).toBeLessThan(all);
            expect(getToolDefinitionMeasurementSignature("p", "m", "a")).toBeDefined();
            expect(db.prepare("SELECT tool_id FROM tool_definition_measurements").all()).toEqual([
                { tool_id: "read" },
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("tool-definition-tokens persistence (bug #2)", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("loadToolDefinitionMeasurements restores in-memory map after reset", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            // Record a measurement: this writes to both in-memory map and SQLite.
            recordToolDefinition(
                "anthropic",
                "claude-sonnet-4.7",
                "sisyphus",
                "bash",
                "Run a shell command",
                { type: "object", properties: { command: { type: "string" } } },
            );
            const beforeReset = getMeasuredToolDefinitionTokens(
                "anthropic",
                "claude-sonnet-4.7",
                "sisyphus",
            );
            expect(beforeReset).toBeGreaterThan(0);

            // Simulate a plugin restart: in-memory map cleared but SQLite
            // retains the row. Reset also drops the persistenceDb reference,
            // matching the cold-start state before openDatabase() rewires it.
            __resetToolDefinitionMeasurements();
            expect(
                getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus"),
            ).toBeUndefined();

            // Rehydrate from SQLite. The measurement should be restored.
            loadToolDefinitionMeasurements(db);
            const afterLoad = getMeasuredToolDefinitionTokens(
                "anthropic",
                "claude-sonnet-4.7",
                "sisyphus",
            );
            expect(afterLoad).toBe(beforeReset);
        } finally {
            closeQuietly(db);
        }
    });

    test("INSERT OR REPLACE updates token_count when same key re-recorded", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "v1 description", { v: 1 });
            // Read the persisted row directly. We rely on token_count, not the
            // in-memory map — that's the whole point of this idempotency test.
            const firstRow = db
                .prepare(
                    "SELECT token_count FROM tool_definition_measurements WHERE provider_id=? AND model_id=? AND agent_name=? AND tool_id=?",
                )
                .get("p", "m", "a", "bash") as { token_count: number } | undefined;
            expect(firstRow).toBeDefined();
            const firstCount = firstRow?.token_count ?? 0;
            expect(firstCount).toBeGreaterThan(0);

            // Re-record with a much longer description → larger token count.
            // INSERT OR REPLACE should update the same row, not insert a new one.
            recordToolDefinition("p", "m", "a", "bash", "v2 description ".repeat(50), { v: 2 });

            const allRows = db
                .prepare(
                    "SELECT token_count FROM tool_definition_measurements WHERE provider_id=? AND model_id=? AND agent_name=? AND tool_id=?",
                )
                .all("p", "m", "a", "bash") as Array<{ token_count: number }>;
            expect(allRows.length).toBe(1); // No duplicate row.
            expect(allRows[0].token_count).toBeGreaterThan(firstCount);

            // After reload, in-memory total reflects the new (larger) value.
            __resetToolDefinitionMeasurements();
            loadToolDefinitionMeasurements(db);
            const reloaded = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(reloaded).toBe(allRows[0].token_count);
        } finally {
            closeQuietly(db);
        }
    });

    test("recordToolDefinition without setDatabase still updates in-memory map", () => {
        // Cold path: setDatabase has not been called yet (e.g. during plugin
        // bootstrap before openDatabase has wired the DB). The call must not
        // throw, and the in-memory map must still be updated so the live
        // sidebar shows the correct value before the next restart.
        recordToolDefinition("p", "m", "a", "bash", "desc", {});
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(total).toBeGreaterThan(0);
    });
});

describe("tool-definition-tokens fingerprint skip", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("repeat fire with identical inputs does NOT write to SQLite", () => {
        // Verifies the hot-path skip: tool.definition fires ~58×/flight and
        // tool descriptions/params almost never change between flights, so we
        // skip stringify+tokenize+SQLite when the fingerprint matches the
        // previous fire's value. SQLite write side-effects are the
        // observable proof.
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
                type: "object",
                properties: { command: { type: "string" } },
            });
            const recordedAtAfterFirst = (
                db
                    .prepare("SELECT recorded_at FROM tool_definition_measurements WHERE tool_id=?")
                    .get("bash") as { recorded_at: number }
            ).recorded_at;

            // Mutate the row's recorded_at directly so we can detect a
            // second write — INSERT OR REPLACE would update it to a new
            // Date.now() if the skip is broken.
            db.prepare("UPDATE tool_definition_measurements SET recorded_at=? WHERE tool_id=?").run(
                1, // Sentinel: any later write will overwrite this.
                "bash",
            );

            // Identical re-fire — must skip the SQLite write.
            recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
                type: "object",
                properties: { command: { type: "string" } },
            });

            const recordedAtAfterSecond = (
                db
                    .prepare("SELECT recorded_at FROM tool_definition_measurements WHERE tool_id=?")
                    .get("bash") as { recorded_at: number }
            ).recorded_at;
            expect(recordedAtAfterSecond).toBe(1); // Sentinel preserved → skip held.
            // Sanity: first write happened at all.
            expect(recordedAtAfterFirst).toBeGreaterThan(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("changed description re-measures and re-writes", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "v1", { type: "object" });
            db.prepare("UPDATE tool_definition_measurements SET recorded_at=? WHERE tool_id=?").run(
                1,
                "bash",
            );

            // Description length changes → fingerprint differs → re-measure.
            recordToolDefinition("p", "m", "a", "bash", "v2 description longer", {
                type: "object",
            });

            const row = db
                .prepare("SELECT recorded_at FROM tool_definition_measurements WHERE tool_id=?")
                .get("bash") as { recorded_at: number };
            expect(row.recorded_at).toBeGreaterThan(1); // Sentinel overwritten.
        } finally {
            closeQuietly(db);
        }
    });

    test("changed parameters key set re-measures", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            const tokensBefore = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;

            // Same description length but parameter top-level keys change →
            // fingerprint differs → re-measure (token count grows because
            // serialized object got bigger).
            recordToolDefinition("p", "m", "a", "bash", "desc", {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
            });
            const tokensAfter = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(tokensAfter).toBeGreaterThan(tokensBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("changed nested parameter schema re-measures", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", {
                type: "object",
                properties: { command: { type: "string", description: "short" } },
            });
            db.prepare("UPDATE tool_definition_measurements SET recorded_at=? WHERE tool_id=?").run(
                1,
                "bash",
            );

            const tokensBefore = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            recordToolDefinition("p", "m", "a", "bash", "desc", {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "much longer nested description ".repeat(200),
                    },
                },
            });
            const tokensAfter = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;

            expect(tokensAfter).toBeGreaterThan(tokensBefore);
        } finally {
            closeQuietly(db);
        }
    });

    test("skip is per-toolID — different tool always measured", () => {
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            // Different tool with identical inputs — must NOT be skipped
            // because the fingerprint map is keyed by toolID inside each
            // {provider,model,agent} key.
            recordToolDefinition("p", "m", "a", "edit", "desc", { type: "object" });
            const snapshot = getToolDefinitionSnapshot();
            expect(snapshot[0].toolCount).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });

    test("skip is per-key — different agent always measured", () => {
        // The (provider,model,agent) composite key isolates measurements,
        // so the same toolID under a different agent must not be skipped.
        recordToolDefinition("p", "m", "agentA", "bash", "desc", { type: "object" });
        recordToolDefinition("p", "m", "agentB", "bash", "desc", { type: "object" });
        const a = getMeasuredToolDefinitionTokens("p", "m", "agentA") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "m", "agentB") ?? 0;
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(0);
    });

    test("__resetToolDefinitionMeasurements clears fingerprints too", () => {
        // After reset, the very next fire must NOT be wrongly skipped just
        // because the same {key, toolID, fingerprint} happened pre-reset.
        const db = createTestDb();
        try {
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            __resetToolDefinitionMeasurements();
            // setDatabase again (reset drops the DB ref) and re-fire — must
            // produce a real measurement, not a no-op.
            setDatabase(db);
            recordToolDefinition("p", "m", "a", "bash", "desc", { type: "object" });
            const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
            expect(total).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });
});
