import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { indexMessagesAfterOrdinal } from "../../features/magic-context/message-index";
import { withMessageFtsSessionFilter } from "../../features/magic-context/message-fts-session-filter";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSearchTools } from "../ctx-search/tools";
import { CTX_EXPAND_TOKEN_BUDGET } from "./constants";
import { renderSearchArchive } from "./search-archive";
import { createCtxExpandTools } from "./tools";

const toolContext = { sessionID: "ses-expand-validation" } as never;
const tools = createCtxExpandTools({ db: {} as never });

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("ctx_expand ordinal validation", () => {
    it("rejects zero and fractional message ordinals", async () => {
        expect(await tools.ctx_expand.execute({ message: 0 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
        expect(await tools.ctx_expand.execute({ message: 1.5 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
    });

    it("rejects zero and fractional range ordinals", async () => {
        const error =
            "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
        expect(await tools.ctx_expand.execute({ start: 0, end: 1 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1.5, end: 2 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1, end: 2.5 }, toolContext)).toBe(error);
    });
});

describe("ctx_expand required-all filler", () => {
    let db: Database;
    let expandTools: ReturnType<typeof createCtxExpandTools>;

    afterEach(() => {
        closeQuietly(db);
    });

    beforeEach(() => {
        db = createTestDb();
        expandTools = createCtxExpandTools({ db });
    });

    it("matches the clean call for every mode when unused fields are filled", async () => {
        const session = { sessionID: "ses-expand-filler" } as never;
        const rangeClean = await expandTools.ctx_expand.execute({ start: 1, end: 3 }, session);
        const rangeFiller = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, message: 0, verbose: false },
            session,
        );
        const verboseClean = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, verbose: true },
            session,
        );
        const verboseFiller = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, verbose: true, message: 0 },
            session,
        );
        const messageClean = await expandTools.ctx_expand.execute({ message: 2 }, session);
        const messageFiller = await expandTools.ctx_expand.execute(
            { message: 2, start: 0, end: 0, verbose: false },
            session,
        );

        expect(rangeFiller).toBe(rangeClean);
        expect(verboseFiller).toBe(verboseClean);
        expect(messageFiller).toBe(messageClean);
        expect(rangeClean).toContain("No messages found in range 1-3");
        expect(verboseClean).toContain("No messages found in range 1-3");
        expect(messageClean).toContain("No message at ordinal 2");
    });
});

describe("ctx_expand cross-session", () => {
    const CALLER = "ses-caller";
    const TARGET = "ses-target";
    const FOREIGN = "ses-foreign";
    const MISSING = "ses-no-mapping";
    const AMBIGUOUS = "ses-ambiguous";
    const CALLER_IDENTITY = "git:proj-a";

    function mapSession(db: Database, sessionId: string, identities: string[]): void {
        const insert = db.prepare(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?,?,?,?)",
        );
        identities.forEach((identity, index) => {
            insert.run(sessionId, index === 0 ? "opencode" : "pi", identity, 1);
        });
    }

    function seedTargetArchive(db: Database): void {
        indexMessagesAfterOrdinal(
            db,
            TARGET,
            [
                {
                    ordinal: 1,
                    id: "t1",
                    role: "user",
                    parts: [{ type: "text", text: "target indexed alpha" }],
                },
                {
                    ordinal: 2,
                    id: "t2",
                    role: "assistant",
                    parts: [{ type: "text", text: "target indexed beta" }],
                },
            ],
            0,
        );
    }

    function seedIndexedRow(
        db: Database,
        sessionId: string,
        ordinal: number,
        id: string,
        role: string,
        content: string,
        indexedAtMs: number | null,
    ): void {
        db.prepare(
            "INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?,?,?,?,?)",
        ).run(sessionId, ordinal, id, role, content);
        const { rowid } = db
            .prepare(
                "SELECT rowid FROM message_history_fts WHERE session_id = ? AND message_ordinal = ?",
            )
            .get(sessionId, ordinal) as { rowid: number };
        db.prepare(
            "INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid, message_time_ms) VALUES (?,?,?,?)",
        ).run(sessionId, ordinal, rowid, indexedAtMs);
    }

    function setup(): { db: Database; expand: ReturnType<typeof createCtxExpandTools> } {
        const db = createTestDb();
        mapSession(db, CALLER, [CALLER_IDENTITY]);
        mapSession(db, TARGET, [CALLER_IDENTITY]);
        mapSession(db, FOREIGN, ["git:proj-b"]);
        mapSession(db, AMBIGUOUS, [CALLER_IDENTITY, "git:proj-b"]);
        seedTargetArchive(db);
        return {
            db,
            expand: createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            }),
        };
    }

    const callerContext = { sessionID: CALLER, directory: "/work/proj-a" } as never;

    it("expands another session of the same project from its search archive", async () => {
        const { db, expand } = setup();
        try {
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 1 },
                callerContext,
            );
            expect(text).toStartWith("From the search archive of session ses-target:");
            expect(text).toContain("[1] U: target indexed alpha");
            expect(text).toContain("indexed text only; no surrounding messages or tool output");

            const range = await expand.ctx_expand.execute(
                { sessionId: TARGET, start: 1, end: 2 },
                callerContext,
            );
            expect(range).toContain("[1] U: target indexed alpha");
            expect(range).toContain("[2] A: target indexed beta");
        } finally {
            closeQuietly(db);
        }
    });

    it("accepts a target mapped to the same identity across two harnesses", async () => {
        const db = createTestDb();
        try {
            mapSession(db, TARGET, [CALLER_IDENTITY, CALLER_IDENTITY]);
            indexMessagesAfterOrdinal(
                db,
                TARGET,
                [
                    {
                        ordinal: 1,
                        id: "t1",
                        role: "user",
                        parts: [{ type: "text", text: "shared identity text" }],
                    },
                ],
                0,
            );
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 1 },
                callerContext,
            );
            expect(text).toContain("shared identity text");
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses foreign, missing, and ambiguous target mappings with distinct errors", async () => {
        const { db, expand } = setup();
        try {
            const foreign = await expand.ctx_expand.execute(
                { sessionId: FOREIGN, message: 1 },
                callerContext,
            );
            expect(foreign).toContain("different project");
            expect(foreign).toContain("git:proj-b");

            const missing = await expand.ctx_expand.execute(
                { sessionId: MISSING, message: 1 },
                callerContext,
            );
            expect(missing).toContain("no recorded project mapping");

            const ambiguous = await expand.ctx_expand.execute(
                { sessionId: AMBIGUOUS, message: 1 },
                callerContext,
            );
            expect(ambiguous).toContain("multiple projects");
            expect(ambiguous).toContain("ambiguous");
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses tag and verbose modes for another session", async () => {
        const { db, expand } = setup();
        try {
            const tag = await expand.ctx_expand.execute(
                { sessionId: TARGET, tag: 3 },
                callerContext,
            );
            expect(tag).toContain("session-local");
            expect(tag).not.toContain("target indexed alpha");

            const verbose = await expand.ctx_expand.execute(
                { sessionId: TARGET, start: 1, end: 2, verbose: true },
                callerContext,
            );
            expect(verbose).toContain("verbose ranges are not available for cross-session expand");
            expect(verbose).not.toContain("target indexed alpha");
        } finally {
            closeQuietly(db);
        }
    });

    it("keeps the target sessionId in the continuation hint", async () => {
        const db = createTestDb();
        try {
            mapSession(db, TARGET, [CALLER_IDENTITY]);
            // Direct FTS rows bypass the index size cap so the first block
            // alone exceeds the token budget and the second is held back.
            const insert = db.prepare(
                "INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?,?,?,?,?)",
            );
            insert.run(TARGET, 1, "t1", "user", `x${"y".repeat(1_000_000)}`);
            insert.run(TARGET, 2, "t2", "user", "second block");
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, start: 1, end: 2 },
                callerContext,
            );
            expect(text).toContain('ctx_expand(sessionId="ses-target", start=2, end=2)');
        } finally {
            closeQuietly(db);
        }
    });

    it("applies no compartment cutoff to the target session", async () => {
        const { db, expand } = setup();
        try {
            // Both histories end at message 1; the target's indexed message 2
            // sits past its own last compartment, where a current-session
            // expand would dismiss it as the live tail. Cross-session must not.
            replaceAllCompartments(db, CALLER, [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    title: "caller history",
                    content: "Summary",
                    p1: "Summary",
                },
            ]);
            replaceAllCompartments(db, TARGET, [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    title: "target history",
                    content: "Summary",
                    p1: "Summary",
                },
            ]);
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 2 },
                callerContext,
            );
            expect(text).toContain("[2] A: target indexed beta");
            expect(text).not.toContain("live tail");
        } finally {
            closeQuietly(db);
        }
    });

    it("reports an empty archive distinctly from a missing message", async () => {
        const { db, expand } = setup();
        try {
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 999 },
                callerContext,
            );
            expect(text).toContain("No indexed text for session ses-target in range 999-999");
            expect(text).not.toContain("message does not exist");
            expect(text).toContain("not proof that the original message was never there");
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses cross-session calls without an injected project resolver", async () => {
        const db = createTestDb();
        try {
            mapSession(db, TARGET, [CALLER_IDENTITY]);
            const expand = createCtxExpandTools({ db });
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 1 },
                callerContext,
            );
            expect(text).toContain("no project-identity resolver is wired");
        } finally {
            closeQuietly(db);
        }
    });

    it("decodes a reduced call whose summary carries the target sessionId", async () => {
        const { db, expand } = setup();
        try {
            const text = await expand.ctx_expand.execute(
                {
                    reduced: true,
                    summary: JSON.stringify({ sessionId: TARGET, message: 1 }),
                },
                callerContext,
            );
            expect(text).toContain("[1] U: target indexed alpha");
        } finally {
            closeQuietly(db);
        }
    });

    it("treats an omitted or equal sessionId as the current session", async () => {
        const { db, expand } = setup();
        try {
            const omitted = await expand.ctx_expand.execute(
                { start: 1, end: 3 },
                callerContext,
            );
            const equal = await expand.ctx_expand.execute(
                { sessionId: CALLER, start: 1, end: 3 },
                callerContext,
            );
            expect(omitted).toContain("No messages found in range 1-3");
            expect(equal).toBe(omitted);
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses message mode with verbose for another session", async () => {
        const { db, expand } = setup();
        try {
            const verbose = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 1, verbose: true },
                callerContext,
            );
            expect(verbose).toContain("verbose ranges are not available for cross-session expand");
            expect(verbose).not.toContain("target indexed alpha");
        } finally {
            closeQuietly(db);
        }
    });

    it("refuses messages indexed before the target session changed project", async () => {
        const db = createTestDb();
        try {
            mapSession(db, CALLER, [CALLER_IDENTITY]);
            db.prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?,?,?,?)",
            ).run("ses-moved", "opencode", CALLER_IDENTITY, 5000);
            // The session moved projects at ms 5000: row 1 was indexed under the
            // previous project, row 2 after the move.
            seedIndexedRow(db, "ses-moved", 1, "m1", "user", "old project alpha", 1000);
            seedIndexedRow(db, "ses-moved", 2, "m2", "assistant", "new project beta", 6000);
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });

            const staleMessage = await expand.ctx_expand.execute(
                { sessionId: "ses-moved", message: 1 },
                callerContext,
            );
            expect(staleMessage).toContain("indexed before the session changed project");
            expect(staleMessage).not.toContain("old project alpha");

            const staleRange = await expand.ctx_expand.execute(
                { sessionId: "ses-moved", start: 1, end: 1 },
                callerContext,
            );
            expect(staleRange).toContain("indexed before the session changed project");

            // A range spanning the move mixes both projects' rows: refuse it
            // whole rather than silently serving the old project's text.
            const mixed = await expand.ctx_expand.execute(
                { sessionId: "ses-moved", start: 1, end: 2 },
                callerContext,
            );
            expect(mixed).toContain("spans its project change");
            expect(mixed).not.toContain("old project alpha");
            expect(mixed).not.toContain("new project beta");

            const fresh = await expand.ctx_expand.execute(
                { sessionId: "ses-moved", message: 2 },
                callerContext,
            );
            expect(fresh).toContain("new project beta");
            expect(fresh).not.toContain("old project alpha");
        } finally {
            closeQuietly(db);
        }
    });

    it("treats a binding with no recorded project change (updated_at 0) as never moved", async () => {
        const db = createTestDb();
        try {
            mapSession(db, CALLER, [CALLER_IDENTITY]);
            db.prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?,?,?,?)",
            ).run("ses-still", "opencode", CALLER_IDENTITY, 0);
            seedIndexedRow(db, "ses-still", 1, "s1", "user", "old-time text", 1000);
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: "ses-still", message: 1 },
                callerContext,
            );
            expect(text).toContain("old-time text");
        } finally {
            closeQuietly(db);
        }
    });

    it("serves rows with an unknown attribution time (the legacy shortcut)", async () => {
        const db = createTestDb();
        try {
            mapSession(db, CALLER, [CALLER_IDENTITY]);
            db.prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?,?,?,?)",
            ).run("ses-legacy", "opencode", CALLER_IDENTITY, 5000);
            seedIndexedRow(db, "ses-legacy", 1, "l1", "user", "unattributed legacy text", null);
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: "ses-legacy", message: 1 },
                callerContext,
            );
            expect(text).toContain("unattributed legacy text");
        } finally {
            closeQuietly(db);
        }
    });

    it("uses the latest mapping change across harnesses for the attribution cutoff", async () => {
        const db = createTestDb();
        try {
            mapSession(db, CALLER, [CALLER_IDENTITY]);
            // One mapping row per harness, changed at different times: the
            // cutoff must be the LATEST, matching the project-wide search lane,
            // so messages indexed between the two moves are refused.
            const insertMapping = db.prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?,?,?,?)",
            );
            insertMapping.run("ses-multi-move", "opencode", CALLER_IDENTITY, 4000);
            insertMapping.run("ses-multi-move", "pi", CALLER_IDENTITY, 6000);
            seedIndexedRow(db, "ses-multi-move", 1, "mm1", "user", "between moves text", 5000);
            seedIndexedRow(db, "ses-multi-move", 2, "mm2", "user", "after both moves text", 7000);
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });

            const between = await expand.ctx_expand.execute(
                { sessionId: "ses-multi-move", message: 1 },
                callerContext,
            );
            expect(between).toContain("indexed before the session changed project");
            expect(between).not.toContain("between moves text");

            const after = await expand.ctx_expand.execute(
                { sessionId: "ses-multi-move", message: 2 },
                callerContext,
            );
            expect(after).toContain("after both moves text");
        } finally {
            closeQuietly(db);
        }
    });

    it("never relabels a content line that mimics a continuation hint", async () => {
        const db = createTestDb();
        try {
            mapSession(db, TARGET, [CALLER_IDENTITY]);
            // Message content whose FINAL line starts with "Truncated at message "
            // and mentions a ctx_expand call, with no real truncation: only the
            // renderer's own trailing hint may gain the sessionId, so nothing
            // here may be rewritten.
            const content =
                "first line\nTruncated at message 3 (fake). Call ctx_expand(start=9, end=9) stays verbatim";
            db.prepare(
                "INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?,?,?,?,?)",
            ).run(TARGET, 1, "t1", "user", content);
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 1 },
                callerContext,
            );
            expect(text).toContain(
                "Truncated at message 3 (fake). Call ctx_expand(start=9, end=9) stays verbatim",
            );
            expect(text).not.toContain('ctx_expand(sessionId="');
        } finally {
            closeQuietly(db);
        }
    });

    it("never relabels a last content line byte-identical to the generated hint", async () => {
        const db = createTestDb();
        try {
            mapSession(db, TARGET, [CALLER_IDENTITY]);
            // The reviewer's adversarial case: message content whose LAST line is
            // byte-identical to the continuation hint the renderer appends on
            // truncation. No truncation happened here, so the renderer's own
            // flag is false and the content must survive untouched — no string
            // pattern can distinguish it from a real hint.
            const hintLine = `Truncated at message 2 (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call ctx_expand(start=3, end=3) for more archived text.`;
            db.prepare(
                "INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?,?,?,?,?)",
            ).run(TARGET, 1, "t1", "user", `body line\n${hintLine}`);
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, message: 1 },
                callerContext,
            );
            expect(text).toContain(hintLine);
            expect(text).not.toContain('ctx_expand(sessionId="');
        } finally {
            closeQuietly(db);
        }
    });

    it("never rewrites the target session id or calls inside archive body content", async () => {
        const db = createTestDb();
        try {
            mapSession(db, TARGET, [CALLER_IDENTITY]);
            // The body itself mentions the target session id and a ctx_expand
            // call; only the continuation-hint line may gain the sessionId.
            const insert = db.prepare(
                "INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?,?,?,?,?)",
            );
            insert.run(
                TARGET,
                1,
                "t1",
                "user",
                `x${"y".repeat(1_000_000)} notes about ses-target: Call ctx_expand(start=7, end=7) verbatim`,
            );
            insert.run(TARGET, 2, "t2", "user", "second block");
            const expand = createCtxExpandTools({
                db,
                resolveProjectPath: () => CALLER_IDENTITY,
            });
            const text = await expand.ctx_expand.execute(
                { sessionId: TARGET, start: 1, end: 2 },
                callerContext,
            );
            expect(text).toContain(
                "notes about ses-target: Call ctx_expand(start=7, end=7) verbatim",
            );
            expect(text).toContain(`ctx_expand(sessionId="${TARGET}", start=2, end=2)`);
        } finally {
            closeQuietly(db);
        }
    });

    it("drops rows indexed before the cutoff when rendering with notBeforeMs", () => {
        const db = createTestDb();
        try {
            seedIndexedRow(db, TARGET, 1, "t1", "user", "before move alpha", 1000);
            seedIndexedRow(db, TARGET, 2, "t2", "assistant", "after move beta", 6000);
            seedIndexedRow(db, TARGET, 3, "t3", "user", "unknown time gamma", null);
            // Full sidecar coverage, so the render provably uses the map path.
            expect(withMessageFtsSessionFilter(db, TARGET, (mapped) => mapped)).toBe(true);
            const text = renderSearchArchive(db, TARGET, 1, 3, 6000, true, undefined, 5000);
            expect(text).toContain("[2] A: after move beta");
            expect(text).toContain("[3] U: unknown time gamma");
            expect(text).not.toContain("before move alpha");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("ctx_expand search archive", () => {
    it("recovers a search citation after host history is pruned in every ordinal mode", async () => {
        const db = createTestDb();
        const sessionId = "ses-expand-pruned";
        const original = [
            {
                ordinal: 1,
                id: "old-1",
                role: "user",
                parts: [{ type: "text", text: "ckdev-mutate 0.9.2 was sent by Ada" }],
            },
            {
                ordinal: 2,
                id: "old-2",
                role: "assistant",
                parts: [{ type: "text", text: "The sender was Ada, not the current user" }],
            },
            {
                ordinal: 3,
                id: "current",
                role: "user",
                parts: [{ type: "text", text: "Unrelated surviving message" }],
            },
        ];
        indexMessagesAfterOrdinal(db, sessionId, original, 0);
        replaceAllCompartments(db, sessionId, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 3,
                title: "Earlier conversation",
                content: "Summary",
                p1: "Summary",
            },
        ]);
        let available = original.slice(2);
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => available,
            readMessageIdOrdinalsForRangeOffThread: async (from, to) =>
                new Map(
                    available
                        .filter((message) => message.ordinal >= from && message.ordinal <= to)
                        .map((message) => [message.id, message.ordinal]),
                ),
        });
        try {
            const context = { sessionID: sessionId } as never;
            const search = createCtxSearchTools({
                db,
                resolveProjectPath: () => "git:archive-test",
                memoryEnabled: false,
                embeddingEnabled: false,
            });
            const hit = await search.ctx_search.execute(
                { query: "ckdev-mutate", sources: ["message"], limit: 4 },
                context,
            );
            expect(hit).toContain("ordinal=1");
            expect(hit).toContain("ctx_expand returns indexed text from the search archive only");
            const expand = createCtxExpandTools({ db }).ctx_expand;
            for (const args of [
                { message: 1 },
                { start: 1, end: 3 },
                { start: 1, end: 3, verbose: true },
            ]) {
                const text = await expand.execute(args, context);
                expect(text).toStartWith("From the search archive:");
                expect(text).toContain("[1] U: ckdev-mutate 0.9.2 was sent by Ada");
                expect(text).toContain("no surrounding messages or tool output");
                expect(text).not.toContain("Unrelated surviving message");
                expect(text).not.toContain("No messages found");
            }
            expect(await expand.execute({ message: 3 }, context)).toContain("full recovery:");
            expect(await expand.execute({ start: 4, end: 5 }, context)).toContain(
                "entirely within the live tail",
            );
            available = [{ ...original[2]!, ordinal: 1 }];
            const renumbered = await expand.execute({ message: 1 }, context);
            expect(renumbered).toContain("[1] U: ckdev-mutate 0.9.2 was sent by Ada");
            expect(renumbered).not.toContain("Unrelated surviving message");
        } finally {
            unregister();
            closeQuietly(db);
        }
    });

    it("bounds archived ranges and excludes other sessions, with a continuation", () => {
        const db = createTestDb();
        const sessionId = "ses-archive-budget";
        const unregister = setRawMessageProvider(sessionId, { readMessages: () => [] });
        try {
            const messages = [1, 2, 3].map((ordinal) => ({
                ordinal,
                id: `m${ordinal}`,
                role: "user",
                parts: [{ type: "text", text: `archived text ${ordinal}` }],
            }));
            indexMessagesAfterOrdinal(db, sessionId, messages, 0);
            indexMessagesAfterOrdinal(
                db,
                "ses-other",
                [{ ...messages[0]!, parts: [{ type: "text", text: "PRIVATE OTHER SESSION" }] }],
                0,
            );
            const text = renderSearchArchive(db, sessionId, 1, 3, 1);
            expect(text).toContain("[1] U: archived text 1");
            expect(text).not.toContain("archived text 2");
            expect(text).not.toContain("PRIVATE OTHER SESSION");
            expect(text).toContain("ctx_expand(start=2, end=3)");
            expect(renderSearchArchive(db, sessionId, 4, 5, 100)).toBeNull();
        } finally {
            unregister();
            closeQuietly(db);
        }
    });
});
