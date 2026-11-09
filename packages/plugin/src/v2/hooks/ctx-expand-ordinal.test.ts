import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { insertTag } from "../../features/magic-context/storage-tags";
import { setBoundedRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createCtxExpandTools } from "../../tools/ctx-expand/tools";
import { stopV2ArchiveReader } from "../../tools/ctx-expand/v2-archive-reader";
import { V2StoreReader } from "../store-reader";
import { createV2RecoveryAttachments } from "./expand-attachments";
import { createV2RawMessageProvider, createV2RawMessageReader } from "./store";

const SESSION_ID = "ses-expand-out-of-range";
const FIRST_MESSAGE_TEXT = "first source text must never be labelled as 9999";

function createSessionDatabase(path: string): Database {
    const db = new Database(path);
    db.exec(`
        CREATE TABLE session_message(
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            time_created INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL
        );
        CREATE TABLE compartments(
            session_id TEXT NOT NULL,
            end_message INTEGER,
            rebase_status TEXT
        );
    `);
    const insert = db.prepare(
        "INSERT INTO session_message(id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("user-1", SESSION_ID, "user", 1, JSON.stringify({ text: FIRST_MESSAGE_TEXT }));
    insert.run(
        "assistant-2",
        SESSION_ID,
        "assistant",
        2,
        JSON.stringify({ content: [{ type: "text", text: "second message text" }] }),
    );
    insert.run("user-3", SESSION_ID, "user", 3, JSON.stringify({ text: "third message text" }));
    return db;
}

describe("OpenCode 2 ctx_expand ordinal resolution", () => {
    it("recovers attachment metadata only on the expand path, leaving shared projection bytes unchanged", async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-v2-expand-files-");
        const path = join(root, "opencode.db");
        const db = createSessionDatabase(path);
        const contextDb = new Database(join(root, "context.db"));
        initializeDatabase(contextDb);
        runMigrations(contextDb);
        const reader = createV2RawMessageReader(() => new V2StoreReader(path), path);
        const sharedBefore = JSON.stringify(reader.findById(SESSION_ID, "user-1"));
        const files = [
            {
                name: "report.pdf",
                mime: "application/pdf",
                data: "secret-file-bytes",
                source: { type: "uri", uri: "file:///work/report.pdf" },
            },
            {
                name: "screenshot.png",
                mime: "image/png",
                data: "secret-image-bytes",
                source: { type: "inline" },
            },
        ];
        db.prepare("UPDATE session_message SET data = ? WHERE id = 'user-1'").run(
            JSON.stringify({ text: FIRST_MESSAGE_TEXT, files }),
        );
        const provider = createV2RawMessageProvider(reader, SESSION_ID);
        const byId = spyOn(provider, "readMessageById");
        const page = spyOn(provider, "readMessagePage");
        const range = spyOn(provider, "readMessageIdOrdinalsForRange");
        const unregister = setBoundedRawMessageProvider(SESSION_ID, provider);
        try {
            expect(JSON.stringify(reader.findById(SESSION_ID, "user-1"))).toBe(sharedBefore);
            expect(JSON.stringify(reader.readPage(SESSION_ID, 0, 1, 3)[0])).toBe(sharedBefore);
            const metadataReader = new V2StoreReader(path);
            try {
                expect(createV2RecoveryAttachments(metadataReader)(SESSION_ID, "user-1")).toEqual([
                    {
                        type: "file",
                        filename: "report.pdf",
                        mime: "application/pdf",
                        url: "file:///work/report.pdf",
                        partIndex: 1,
                    },
                    {
                        type: "file",
                        filename: "screenshot.png",
                        mime: "image/png",
                        url: undefined,
                        partIndex: 2,
                    },
                ]);
            } finally {
                metadataReader.close();
            }
            const expand = createCtxExpandTools({
                db: contextDb,
                recoveryAttachments: () => {
                    throw new Error(
                        "OpenCode 2 recovery must not read attachments on the main thread",
                    );
                },
            }).ctx_expand;
            const ctx = { sessionID: SESSION_ID } as never;
            const notices = [
                "[file] report.pdf (application/pdf) — stored location: file:///work/report.pdf; content not recovered. If needed, ask the user to attach it again.",
                "[file] screenshot.png (image/png); content not recovered. If needed, ask the user to attach it again.",
            ];
            for (const [index, notice] of notices.entries()) {
                insertTag(contextDb, SESSION_ID, `user-1:file${index + 1}`, "file", 10, index + 1);
                for (const args of [
                    { tag: index + 1 },
                    { message: 1 },
                    { start: 1, end: 3, verbose: true },
                ]) {
                    const output = await expand.execute(args, ctx);
                    expect(output).toContain(notice);
                    expect(output).not.toContain("secret-");
                }
            }
            expect(byId).not.toHaveBeenCalled();
            expect(page).not.toHaveBeenCalled();
            expect(range).not.toHaveBeenCalled();
            expect(JSON.stringify(reader.findById(SESSION_ID, "user-1"))).toBe(sharedBefore);
        } finally {
            await stopV2ArchiveReader();
            byId.mockRestore();
            page.mockRestore();
            range.mockRestore();
            unregister();
            contextDb.close();
            db.close();
            cleanup();
        }
    }, 30_000);

    it("expands another session's indexed text through the archive with the ownership gate", async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-v2-ctx-expand-cross-session-");
        let contextDb: Database | undefined;
        try {
            contextDb = new Database(join(root, "context.db"));
            initializeDatabase(contextDb);
            runMigrations(contextDb);
            const insertMapping = contextDb.prepare(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?,?,?,?)",
            );
            insertMapping.run(SESSION_ID, "opencode", "git:v2-cross", 1);
            insertMapping.run("ses-v2-target", "opencode", "git:v2-cross", 1);
            insertMapping.run("ses-v2-foreign", "opencode", "git:v2-other", 1);
            const insertArchive = contextDb.prepare(
                "INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?,?,?,?,?)",
            );
            insertArchive.run("ses-v2-target", 1, "t1", "user", "v2 cross session indexed text");
            const ctxExpand = createCtxExpandTools({
                db: contextDb as never,
                resolveProjectPath: () => "git:v2-cross",
            }).ctx_expand;
            const context = { sessionID: SESSION_ID, directory: root } as never;

            const hit = await ctxExpand.execute(
                { sessionId: "ses-v2-target", message: 1 },
                context,
            );
            expect(hit).toStartWith("From the search archive of session ses-v2-target:");
            expect(hit).toContain("[1] U: v2 cross session indexed text");

            const foreign = await ctxExpand.execute(
                { sessionId: "ses-v2-foreign", message: 1 },
                context,
            );
            expect(foreign).toContain("different project");

            const missing = await ctxExpand.execute(
                { sessionId: "ses-v2-missing", message: 1 },
                context,
            );
            expect(missing).toContain("no recorded project mapping");

            // A session that moved projects keeps old-project rows indexed
            // under the same session id; the attribution gate must refuse them.
            insertMapping.run("ses-v2-moved", "opencode", "git:v2-cross", 5000);
            insertArchive.run("ses-v2-moved", 1, "mv1", "user", "v2 pre-move text");
            const movedRow = contextDb
                .prepare(
                    "SELECT rowid FROM message_history_fts WHERE session_id = ? AND message_ordinal = ?",
                )
                .get("ses-v2-moved", 1) as { rowid: number };
            contextDb
                .prepare(
                    "INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid, message_time_ms) VALUES (?,?,?,?)",
                )
                .run("ses-v2-moved", 1, movedRow.rowid, 1000);
            const moved = await ctxExpand.execute(
                { sessionId: "ses-v2-moved", message: 1 },
                context,
            );
            expect(moved).toContain("indexed before the session changed project");
            expect(moved).not.toContain("v2 pre-move text");
        } finally {
            contextDb?.close();
            cleanup();
        }
    });

    it("does not relabel the first source message as an out-of-range ordinal", async () => {
        const { dir: root, cleanup } = createTestTempDir("mc-v2-ctx-expand-ordinal-");
        const path = join(root, "opencode.db");
        let db: Database | undefined;
        let contextDb: Database | undefined;
        let unregister: (() => void) | undefined;

        try {
            db = createSessionDatabase(path);
            contextDb = new Database(":memory:");
            initializeDatabase(contextDb);
            runMigrations(contextDb);
            const reader = createV2RawMessageReader(() => new V2StoreReader(path));
            unregister = setBoundedRawMessageProvider(
                SESSION_ID,
                createV2RawMessageProvider(reader, SESSION_ID),
            );
            const ctxExpand = createCtxExpandTools({ db: contextDb as never }).ctx_expand;
            const context = { sessionID: SESSION_ID } as never;

            const message = await ctxExpand.execute({ message: 9999 }, context);
            const range = await ctxExpand.execute({ start: 9999, end: 10000 }, context);
            const partialRange = await ctxExpand.execute({ start: 1, end: 10000 }, context);
            const verboseRange = await ctxExpand.execute(
                { start: 9999, end: 10000, verbose: true },
                context,
            );

            expect(message).toContain("No message at ordinal 9999");
            expect(message).not.toContain(FIRST_MESSAGE_TEXT);
            expect(range).toContain("No messages found in range 9999-10000");
            expect(range).not.toContain(FIRST_MESSAGE_TEXT);
            expect(partialRange).toContain("Messages 1-3 (3 messages,");
            expect(partialRange).toContain("[1] U:");
            expect(partialRange).toContain("[2] A:");
            expect(partialRange).toContain("[3] U:");
            expect(partialRange).not.toContain("[10000]");
            expect(verboseRange).toContain("No messages found in range 9999-10000");
            expect(verboseRange).not.toContain(FIRST_MESSAGE_TEXT);
        } finally {
            unregister?.();
            contextDb?.close();
            db?.close();
            cleanup();
        }
    });
});
