import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { UnifiedSearchResult } from "../../features/magic-context/search";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import { buildTransientMaterial } from "./transient-material";

const sessionId = "ses-material";
const query = "sqlite";

function git(id: number, content = `preview ${id}`): UnifiedSearchResult {
    return { source: "git_commit", content, score: 1, sha: `sha${id}`, shortSha: `s${id}`, author: null, committedAtMs: 1767225600000, matchType: "fts" };
}
function primer(id: number, content = "primer preview"): UnifiedSearchResult {
    return { source: "primer", content, score: 1, primerId: id, question: "question", support: 1, lastObservedAt: null, matchType: "fts" };
}
function note(id: number, content = "note preview"): UnifiedSearchResult {
    return { source: "note", content, score: 1, noteId: id, status: "active", createdAt: 1767225600000, anchorOrdinal: null, sourceSessionId: null };
}
function message(ordinal: number): UnifiedSearchResult {
    return { source: "message", content: "fallback preview", score: 1, messageOrdinal: ordinal, messageId: `m${ordinal}`, role: "user" };
}
function compartment(): UnifiedSearchResult {
    return { source: "compartment", content: "preview", score: 1, compartmentId: 7, sessionId, title: "Archived conversation", startOrdinal: 4, endOrdinal: 12, matchType: "hybrid", snippet: "SECRET BODY" };
}
function priced(text: string): number {
    return text ? text.split("\n").reduce((total, line) => total + estimateTokens(line) + 1, 0) : 0;
}

describe("buildTransientMaterial", () => {
    let db: Database;
    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(`
            CREATE TABLE git_commits (sha TEXT PRIMARY KEY, message TEXT);
            CREATE TABLE primers (id INTEGER PRIMARY KEY, question TEXT, answer TEXT);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT, ready_reason TEXT);
            CREATE TABLE message_history_fts (session_id TEXT, message_ordinal INTEGER, message_id TEXT, content TEXT);
            CREATE TABLE message_fts_rowid_map (session_id TEXT, message_ordinal INTEGER, fts_rowid INTEGER, message_time_ms INTEGER, PRIMARY KEY(session_id, message_ordinal));
        `);
    });
    afterEach(() => db.close());

    const build = (results: UnifiedSearchResult[], budgetTokens = 1000) =>
        buildTransientMaterial({ db, sessionId, query, results, budgetTokens });

    it("uses full git/primer/note text, a matching message excerpt and title/range only for compartments", () => {
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run("sha1", `${"g".repeat(260)} git-tail`);
        db.prepare("INSERT INTO primers VALUES (?, ?, ?)").run(2, "original question", `${"a".repeat(250)} primer-tail`);
        db.prepare("INSERT INTO notes VALUES (?, ?, ?)").run(3, `${"n".repeat(250)} note-tail`, "ready detail");
        const rawMessage = `${"filler ".repeat(50)}sqlite ${"after ".repeat(80)}`;
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (?, ?, ?, ?, ?)").run(1, sessionId, 10, "m10", rawMessage);
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(sessionId, 10, 1, 1767225600000);
        const result = build([git(1), primer(2), note(3), message(10), compartment()], 3000)!;
        expect(result.included).toBe(5);
        expect(result.text).toContain("git-tail");
        expect(result.text).toContain("Q: original question A:");
        expect(result.text).toContain("primer-tail");
        expect(result.text).toContain("note-tail Reason: ready detail");
        expect(result.text).toContain("[message] ord=10 range=7-13 time=2026-01-01T00:00:00.000Z role=user ::");
        const messageLine = result.text.split("\n").find((line) => line.startsWith("[message]"))!;
        expect(messageLine).toContain("sqlite");
        expect(Array.from(messageLine.split(" :: ")[1]!).length).toBeLessThanOrEqual(300);
        expect(result.text).toContain("[compartment] #7 range=4-12 title=Archived conversation");
        expect(result.text).not.toContain("SECRET BODY");
    });

    it("batch-looks up timestamps for this session and tolerates null timestamps", () => {
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (?, ?, ?, ?, ?)").run(1, sessionId, 1, "m1", "sqlite first");
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (?, ?, ?, ?, ?)").run(2, sessionId, 2, "m2", "sqlite second");
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(sessionId, 1, 1, 1767225600000);
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(sessionId, 2, 2, null);
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run("other", 2, 3, 1767225600000);
        const prepare = spyOn(db, "prepare");
        try {
            const result = build([message(1), message(2)])!;
            expect(result.text).toContain("ord=1 range=1-4 time=2026-01-01T00:00:00.000Z");
            expect(result.text).toContain("ord=2 range=1-5 time=?");
            expect(result.text).not.toContain("1970-01-01");
            const timeQueries = prepare.mock.calls.filter(([sql]) =>
                sql.includes("SELECT message_ordinal, message_time_ms"),
            );
            expect(timeQueries).toHaveLength(1);
            expect(timeQueries[0]?.[0]).toContain("WHERE session_id=? AND message_ordinal IN (?,?)");
        } finally {
            prepare.mockRestore();
        }
    });

    it("caps each full-text body at 700 characters and 1024 UTF-8 bytes with an ellipsis", () => {
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run("sha1", "x".repeat(900));
        db.prepare("INSERT INTO notes VALUES (?, ?, ?)").run(3, "记忆".repeat(500), null);
        const result = build([git(1), note(3)], 5000)!;
        const bodies = result.text.split("\n").map((line) => line.split(" :: ")[1]!);
        expect(Array.from(bodies[0]!).length).toBe(700);
        expect(bodies[0]!.endsWith("…")).toBe(true);
        expect(Buffer.byteLength(result.text.split("\n")[1]!, "utf8")).toBeLessThanOrEqual(1024);
        expect(bodies[1]!.endsWith("…")).toBe(true);
        expect(result.truncated).toBe(true);
    });

    it("preserves the first hit of each source at the normal 1000-token budget", () => {
        const hits = [...Array.from({ length: 10 }, (_, i) => git(i, `commit ${i}`)), primer(1), note(2), message(3), compartment()];
        const result = build(hits)!;
        expect(result.included).toBe(8);
        expect(result.text).toContain("[git_commit] s0 ");
        expect(result.text).toContain("[primer] #1 ");
        expect(result.text).toContain("[note] #2 ");
        expect(result.text).toContain("[message] ord=3 ");
        expect(result.text).toContain("[compartment] #7 ");
        expect(result.truncated).toBe(true);
        expect(priced(result.text)).toBeLessThanOrEqual(1000);
    });

    it("shrinks long bodies while preserving every source's first hit at the normal budget", () => {
        const long = "中文临时材料".repeat(120);
        const result = build([git(0, long), git(1, long), primer(2, long), note(3, long), message(4), compartment()])!;
        for (const label of ["[git_commit] s0", "[primer] #2", "[note] #3", "[message] ord=4", "[compartment] #7"]) {
            expect(result.text).toContain(label);
        }
        expect(priced(result.text)).toBeLessThanOrEqual(1000);
        expect(result.truncated).toBe(true);
    });

    it("honors a tiny hard budget by skipping lines that cannot fit and marking truncation", () => {
        const result = build([git(1), primer(2), note(3)], 1)!;
        expect(priced(result.text)).toBeLessThanOrEqual(1);
        expect(result.included).toBe(0);
        expect(result.truncated).toBe(true);
    });

    it("caps 20 results at eight items and prices Chinese with estimateTokens", () => {
        const hits = Array.from({ length: 20 }, (_, i) => git(i, `中文缓存记忆材料${i}`.repeat(100)));
        const limited = build(hits, 200)!;
        expect(limited.included).toBeLessThanOrEqual(8);
        expect(limited.truncated).toBe(true);
        expect(priced(limited.text)).toBeLessThanOrEqual(200);
        const generous = build(hits, 10000)!;
        expect(generous.included).toBe(8);
        expect(generous.text).toContain("另有 12 条未纳入");
        expect(priced(generous.text)).toBeLessThanOrEqual(10000);
    });

    it("returns null when there are no non-memory hits", () => {
        expect(build([])).toBeNull();
        expect(build([{ source: "memory", memoryId: 1, category: "OPS_RULES", content: "memory", score: 1, matchType: "fts" }])).toBeNull();
    });
});
