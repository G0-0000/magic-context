import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type {
    MessageSearchResult,
    ReservedSearchCandidates,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import {
    buildReservedHits,
    buildTransientMaterial,
    detectDateIntent,
    renderReservedAppendix,
    withReservedAppendix,
} from "./transient-material";

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
function message(ordinal: number, ownerSession: string = sessionId): UnifiedSearchResult {
    return {
        source: "message", content: "fallback preview", score: 1,
        messageOrdinal: ordinal, messageId: `m${ordinal}`, role: "user",
        sessionId: ownerSession, messageTimeMs: null,
    };
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


const reservedTimeMs = 1767225600000;

function reservedMessage(
    ordinal: number,
    owner: string,
    timeMs: number | null = reservedTimeMs,
    content?: string,
    messageId: string = `m${ordinal}`,
): MessageSearchResult {
    return {
        source: "message",
        content: content ?? `reserved body ${ordinal}`,
        score: 1,
        messageOrdinal: ordinal,
        messageId,
        role: "user",
        sessionId: owner,
        messageTimeMs: timeMs,
    };
}

function reservedGit(id: number, content?: string): UnifiedSearchResult {
    return {
        source: "git_commit",
        content: content ?? `git subject ${id}`,
        score: 1,
        sha: `sha${id}`,
        shortSha: `s${id}`,
        author: null,
        committedAtMs: reservedTimeMs,
        matchType: "fts",
    };
}

function candidatesOf(partial: Partial<ReservedSearchCandidates>): ReservedSearchCandidates {
    return {
        messages: [],
        gitCommits: [],
        currentSessionMessages: [],
        ...partial,
    };
}

describe("reserved hits", () => {
    let db: Database;
    beforeEach(() => {
        db = new Database(":memory:");
        db.exec(`
            CREATE TABLE git_commits (sha TEXT PRIMARY KEY, message TEXT);
            CREATE TABLE message_history_fts (session_id TEXT, message_ordinal INTEGER, message_id TEXT, content TEXT);
            CREATE TABLE message_fts_rowid_map (session_id TEXT, message_ordinal INTEGER, fts_rowid INTEGER, message_time_ms INTEGER, PRIMARY KEY(session_id, message_ordinal));
        `);
    });
    afterEach(() => db.close());

    it("populates reserved hits with identity, time and a capped snippet, and stays empty without candidates", () => {
        const longBody = "x".repeat(250);
        const fiveMessages = Array.from({ length: 5 }, (_, i) =>
            reservedMessage(i + 1, `ses-reserved-${i + 1}`),
        );
        const fiveGit = Array.from({ length: 5 }, (_, i) => reservedGit(i + 1));
        const material = buildTransientMaterial({
            db,
            sessionId: "ses-material",
            query: "sqlite",
            results: [...fiveMessages, ...fiveGit],
            budgetTokens: 5000,
            reservedCandidates: candidatesOf({
                messages: fiveMessages,
                gitCommits: fiveGit,
                currentSessionMessages: [reservedMessage(9, "ses-material")],
            }),
        })!;
        // Up to 3 message hits + 3 git hits; the two message lanes merge
        // (current-session hits fill any message slots the project lane left).
        expect(material.reserved.messages).toHaveLength(3);
        expect(material.reserved.gitCommits).toHaveLength(3);
        const [first] = material.reserved.messages;
        expect(first?.sessionId).toBe("ses-reserved-1");
        expect(first?.messageOrdinal).toBe(1);
        expect(first?.messageTimeMs).toBe(reservedTimeMs);
        // Reserved hits are never injected into the model input.
        expect(material.text).not.toContain("ses-reserved-1");

        const withLongSnippet = buildReservedHits(
            db,
            "sqlite",
            candidatesOf({ messages: [reservedMessage(1, "ses-long", reservedTimeMs, longBody)] }),
        );
        expect(Array.from(withLongSnippet.messages[0]!.snippet)).toHaveLength(200);
        expect(withLongSnippet.messages[0]!.snippet.endsWith("…")).toBe(true);

        const withNullTime = buildReservedHits(
            db,
            "sqlite",
            candidatesOf({ messages: [reservedMessage(2, "ses-null-time", null)] }),
        );
        expect(withNullTime.messages[0]!.messageTimeMs).toBeNull();

        // A hit present in both lanes counts once.
        const shared = reservedMessage(4, "ses-shared");
        const deduped = buildReservedHits(
            db,
            "sqlite",
            candidatesOf({ messages: [shared], currentSessionMessages: [shared] }),
        );
        expect(deduped.messages).toHaveLength(1);

        expect(buildReservedHits(db, "sqlite", undefined)).toEqual({ messages: [], gitCommits: [] });
        const noCandidates = buildTransientMaterial({
            db,
            sessionId: "ses-material",
            query: "sqlite",
            results: [reservedGit(1)],
            budgetTokens: 500,
        })!;
        expect(noCandidates.reserved).toEqual({ messages: [], gitCommits: [] });
    });

    it("renders the appendix with short session id, ISO date, verbatim expand hint and git subject cap", () => {
        const reserved = buildReservedHits(
            db,
            "sqlite",
            candidatesOf({
                messages: [reservedMessage(7, "ses-reserved-full")],
                gitCommits: [reservedGit(1, `${"g".repeat(200)} tail`)],
            }),
        );
        const appendix = renderReservedAppendix(reserved);
        expect(appendix.startsWith("保留命中：")).toBe(true);
        expect(appendix).toContain(
            `- [message] ses-rese 2026-01-01T00:00:00.000Z reserved body 7`,
        );
        // Cross-seam contract with ctx_expand: this exact form, full session id.
        expect(appendix).toContain('ctx_expand(sessionId: "ses-reserved-full", message: 7)');
        const gitLine = appendix.split("\n").find((line) => line.startsWith("- [git_commit]"))!;
        expect(gitLine.startsWith("- [git_commit] s1 2026-01-01T00:00:00.000Z ")).toBe(true);
        expect(Array.from(gitLine.split(".000Z ")[1]!)).toHaveLength(120);
        expect(gitLine.endsWith("…")).toBe(true);
    });

    it("caps the appendix at 3 message hits + 3 git hits", () => {
        const reserved = buildReservedHits(
            db,
            "sqlite",
            candidatesOf({
                messages: Array.from({ length: 5 }, (_, i) =>
                    reservedMessage(i + 1, `ses-many-${i + 1}`),
                ),
                gitCommits: Array.from({ length: 5 }, (_, i) => reservedGit(i + 1)),
            }),
        );
        const appendix = renderReservedAppendix(reserved);
        const bullets = appendix.split("\n").filter((line) => line.startsWith("- "));
        expect(bullets).toHaveLength(6);
        expect(appendix.match(/ctx_expand\(sessionId:/g)).toHaveLength(3);
        expect(renderReservedAppendix({ messages: [], gitCommits: [] })).toBe("");
        expect(
            withReservedAppendix("text", { messages: [], gitCommits: [] }, "sqlite"),
        ).toBe("text");
    });

    it("renders ? for a null message time in the appendix", () => {
        const appendix = renderReservedAppendix(
            buildReservedHits(
                db,
                "sqlite",
                candidatesOf({ messages: [reservedMessage(3, "ses-null-t", null)] }),
            ),
        );
        expect(appendix).toContain("- [message] ses-null ? reserved body 3");
    });

    it("detects zh/en relative-date words only", () => {
        for (const intentQuery of [
            "昨天 改了什么", "今晚的构建", "上周的提交", "前天", "本周", "这周",
            "what broke yesterday", "today's build", "tonight", "last night", "last week", "this week",
        ]) {
            expect(detectDateIntent(intentQuery)).toBe(true);
        }
        for (const plainQuery of ["sqlite 路径", "daylight savings", "containment", "birthday"]) {
            expect(detectDateIntent(plainQuery)).toBe(false);
        }
        expect(detectDateIntent("stale today?")).toBe(true);
    });

    it("orders git first in material inclusion and in the appendix under date intent", () => {
        const hits: UnifiedSearchResult[] = [
            reservedMessage(10, "ses-material"),
            reservedGit(1),
            message(11),
        ];
        const dateQuery = "昨天 sqlite";
        const intentMaterial = buildTransientMaterial({
            db,
            sessionId: "ses-material",
            query: dateQuery,
            results: hits,
            budgetTokens: 5000,
            reservedCandidates: candidatesOf({
                messages: [reservedMessage(10, "ses-material")],
                gitCommits: [reservedGit(1)],
            }),
        })!;
        expect(intentMaterial.text.indexOf("[git_commit]")).toBeLessThan(
            intentMaterial.text.indexOf("[message]"),
        );
        const intentAppendix = renderReservedAppendix(intentMaterial.reserved, {
            dateIntent: detectDateIntent(dateQuery),
        });
        expect(intentAppendix.indexOf("- [git_commit]")).toBeLessThan(
            intentAppendix.indexOf("- [message]"),
        );
        // Without date intent the message hits lead, both in material and appendix.
        const plainMaterial = buildTransientMaterial({
            db,
            sessionId: "ses-material",
            query: "sqlite",
            results: hits,
            budgetTokens: 5000,
            reservedCandidates: candidatesOf({
                messages: [reservedMessage(10, "ses-material")],
                gitCommits: [reservedGit(1)],
            }),
        })!;
        expect(plainMaterial.text.indexOf("[message]")).toBeLessThan(
            plainMaterial.text.indexOf("[git_commit]"),
        );
        const plainAppendix = renderReservedAppendix(plainMaterial.reserved);
        expect(plainAppendix.indexOf("- [message]")).toBeLessThan(
            plainAppendix.indexOf("- [git_commit]"),
        );
    });

    it("resolves each reserved hit's body and time against its own session", () => {
        // Two sessions share message id "dup" AND ordinal 1; only a lookup
        // under each hit's own session keeps the snippets and times apart.
        const alphaTime = 1767225600000;
        const betaTime = 1767312000000;
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (1, 'ses-alpha', 1, 'dup', 'alpha own needle text')").run();
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (2, 'ses-beta', 1, 'dup', 'beta own needle text')").run();
        db.prepare("INSERT INTO message_fts_rowid_map VALUES ('ses-alpha', 1, 1, ?)").run(alphaTime);
        db.prepare("INSERT INTO message_fts_rowid_map VALUES ('ses-beta', 1, 2, ?)").run(betaTime);
        const hitA = reservedMessage(1, "ses-alpha", alphaTime, "alpha preview", "dup");
        const hitB = reservedMessage(1, "ses-beta", betaTime, "beta preview", "dup");
        const reserved = buildReservedHits(db, "needle", candidatesOf({ messages: [hitA, hitB] }));
        expect(reserved.messages[0]?.messageTimeMs).toBe(alphaTime);
        expect(reserved.messages[0]?.snippet).toContain("alpha own needle text");
        expect(reserved.messages[0]?.snippet).not.toContain("beta");
        expect(reserved.messages[1]?.messageTimeMs).toBe(betaTime);
        expect(reserved.messages[1]?.snippet).toContain("beta own needle text");
        expect(reserved.messages[1]?.snippet).not.toContain("alpha");
        const appendix = renderReservedAppendix(reserved);
        expect(appendix).toContain(new Date(alphaTime).toISOString());
        expect(appendix).toContain(new Date(betaTime).toISOString());
        expect(appendix).toContain('ctx_expand(sessionId: "ses-alpha", message: 1)');
        expect(appendix).toContain('ctx_expand(sessionId: "ses-beta", message: 1)');
    });

    it("a stale rowid-map row pointing at another session's row misses instead of leaking", () => {
        // ses-alpha's map claims fts rowid 1, which belongs to ses-beta, and
        // ses-alpha has no FTS row of its own: the join must not return
        // ses-beta's content; the lookup falls back to the hit's preview.
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (1, 'ses-beta', 1, 'dup', 'beta secret needle text')").run();
        db.prepare("INSERT INTO message_fts_rowid_map VALUES ('ses-alpha', 1, 1, 1767225600000)").run();
        const hit = reservedMessage(1, "ses-alpha", 1767225600000, "alpha preview", "dup");
        const reserved = buildReservedHits(db, "needle", candidatesOf({ messages: [hit] }));
        expect(reserved.messages[0]?.snippet).not.toContain("beta secret");
        expect(reserved.messages[0]?.snippet).toContain("alpha preview");
        const appendix = renderReservedAppendix(reserved);
        expect(appendix).not.toContain("beta secret");
        expect(appendix).toContain("alpha preview");
    });
});
