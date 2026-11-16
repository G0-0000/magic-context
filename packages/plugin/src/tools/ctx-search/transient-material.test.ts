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

function git(
    id: number,
    content = `preview ${id}`,
): Extract<UnifiedSearchResult, { source: "git_commit" }> {
    return {
        source: "git_commit",
        content,
        score: 1,
        sha: `sha${id}`,
        shortSha: `s${id}`,
        author: null,
        committedAtMs: 1767225600000,
        matchType: "fts",
    };
}
function primer(id: number, content = "primer preview"): UnifiedSearchResult {
    return {
        source: "primer",
        content,
        score: 1,
        primerId: id,
        question: "question",
        support: 1,
        lastObservedAt: null,
        matchType: "fts",
    };
}
function note(id: number, content = "note preview"): UnifiedSearchResult {
    return {
        source: "note",
        content,
        score: 1,
        noteId: id,
        status: "active",
        createdAt: 1767225600000,
        anchorOrdinal: null,
        sourceSessionId: null,
    };
}
function message(ordinal: number, ownerSession: string = sessionId): UnifiedSearchResult {
    return {
        source: "message",
        content: "fallback preview",
        score: 1,
        messageOrdinal: ordinal,
        messageId: `m${ordinal}`,
        role: "user",
        sessionId: ownerSession,
        messageTimeMs: null,
    };
}
function compartment(): UnifiedSearchResult {
    return {
        source: "compartment",
        content: "preview",
        score: 1,
        compartmentId: 7,
        sessionId,
        title: "Archived conversation",
        startOrdinal: 4,
        endOrdinal: 12,
        matchType: "hybrid",
        snippet: "SECRET BODY",
    };
}
function sectionWiki(
    id: number,
    overrides: Partial<Extract<UnifiedSearchResult, { source: "wiki" }>> = {},
): UnifiedSearchResult {
    return {
        source: "wiki",
        content: "sqlite",
        snippet: `section ${id} sqlite ${"body ".repeat(30)}`,
        score: 1,
        path: `guide-${id}.md`,
        line: id + 1,
        modifiedAtMs: 1767225600000,
        heading: `Section ${id}`,
        sectionStartLine: id * 10,
        sectionEndLine: id * 10 + 4,
        ...overrides,
    };
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
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run(
            "sha1",
            `${"g".repeat(260)} git-tail`,
        );
        db.prepare("INSERT INTO primers VALUES (?, ?, ?)").run(
            2,
            "original question",
            `${"a".repeat(250)} primer-tail`,
        );
        db.prepare("INSERT INTO notes VALUES (?, ?, ?)").run(
            3,
            `${"n".repeat(250)} note-tail`,
            "ready detail",
        );
        const rawMessage = `${"filler ".repeat(50)}sqlite ${"after ".repeat(80)}`;
        db.prepare(
            "INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (?, ?, ?, ?, ?)",
        ).run(1, sessionId, 10, "m10", rawMessage);
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(
            sessionId,
            10,
            1,
            1767225600000,
        );
        const result = build([git(1), primer(2), note(3), message(10), compartment()], 3000)!;
        expect(result.included).toBe(5);
        expect(result.text).toContain("git-tail");
        expect(result.text).toContain("Q: original question A:");
        expect(result.text).toContain("primer-tail");
        expect(result.text).toContain("note-tail Reason: ready detail");
        expect(result.text).toContain(
            "[message] ord=10 range=7-13 time=2026-01-01T00:00:00.000Z role=user ::",
        );
        const messageLine = result.text.split("\n").find((line) => line.startsWith("[message]"))!;
        expect(messageLine).toContain("sqlite");
        expect(Array.from(messageLine.split(" :: ")[1]!).length).toBeLessThanOrEqual(300);
        expect(result.text).toContain("[compartment] #7 range=4-12 title=Archived conversation");
        expect(result.text).not.toContain("SECRET BODY");
    });

    it("keeps a query match near the tail of a long commit message within budget", () => {
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run(
            "sha1",
            `${"before ".repeat(200)}sqlite ${"after ".repeat(200)}`,
        );
        const result = build([git(1)], 100)!;
        expect(result.text).toContain("sqlite");
        expect(result.text).toContain("…");
        expect(priced(result.text)).toBeLessThanOrEqual(100);
    });

    it("keeps a git match when the final budget excludes its preceding excerpt context", () => {
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run(
            "sha1",
            `${"before ".repeat(200)}sqlite ${"after ".repeat(200)}`,
        );
        const result = build([git(1)], 40)!;
        expect(result.text).toContain("sqlite");
        expect(priced(result.text)).toBeLessThanOrEqual(40);
    });

    it("matches git terms case-insensitively near a long commit tail", () => {
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run(
            "sha1",
            `${"before ".repeat(200)}tailscale`,
        );
        const result = buildTransientMaterial({
            db,
            sessionId,
            query: "Tailscale",
            results: [git(1)],
            budgetTokens: 100,
        })!;
        expect(result.text).toContain("tailscale");
        expect(priced(result.text)).toBeLessThanOrEqual(100);
    });

    it("retains nonadjacent git query terms in the same bounded excerpt", () => {
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run(
            "sha1",
            `${"before ".repeat(180)}tailscale ${"middle ".repeat(20)} subnet ${"after ".repeat(20)}`,
        );
        const result = buildTransientMaterial({
            db,
            sessionId,
            query: "Tailscale subnet",
            results: [git(1)],
            budgetTokens: 100,
        })!;
        expect(result.text).toContain("tailscale");
        expect(result.text).toContain("subnet");
        expect(priced(result.text)).toBeLessThanOrEqual(100);
    });

    it("batch-looks up timestamps for this session and tolerates null timestamps", () => {
        db.prepare(
            "INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (?, ?, ?, ?, ?)",
        ).run(1, sessionId, 1, "m1", "sqlite first");
        db.prepare(
            "INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (?, ?, ?, ?, ?)",
        ).run(2, sessionId, 2, "m2", "sqlite second");
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(
            sessionId,
            1,
            1,
            1767225600000,
        );
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(
            sessionId,
            2,
            2,
            null,
        );
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?)").run(
            "other",
            2,
            3,
            1767225600000,
        );
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
            expect(timeQueries[0]?.[0]).toContain(
                "WHERE session_id=? AND message_ordinal IN (?,?)",
            );
        } finally {
            prepare.mockRestore();
        }
    });

    it("renders a wiki hit as a path/line header with its bounded snippet", () => {
        const snippet = `${"w".repeat(600)} sqlite ${"w".repeat(600)}`;
        const wiki: UnifiedSearchResult = {
            source: "wiki",
            content: "### Historian lease",
            snippet,
            score: 1,
            path: "guides/\narchitecture.md",
            line: 12,
            modifiedAtMs: 1767225600000,
        };
        const result = build([wiki], 5000)!;
        expect(result.text).toContain('[wiki] path="guides/\\narchitecture.md":12');
        const body = result.text.split("\n")[0]!.split(" :: ")[1]!;
        expect(Array.from(body)).toHaveLength(700);
        expect(body).toContain("sqlite");
        expect(body.endsWith("…")).toBe(true);
        expect(
            Buffer.byteLength(`[wiki] path="guides/\\narchitecture.md":12 :: ${body}`, "utf8"),
        ).toBeLessThanOrEqual(1024);
    });

    it("keeps the wiki hit in a small budget when an oversized preview anchor cannot fit", () => {
        const preview = "🙂".repeat(220);
        const wiki: UnifiedSearchResult = {
            source: "wiki",
            content: preview,
            snippet: `${preview} sqlite actual wiki match`,
            score: 1,
            path: `${"nested/".repeat(35)}file.md`,
            line: 12,
            modifiedAtMs: 1767225600000,
        };

        const result = build([wiki], 100)!;

        expect(result.text).toContain("sqlite");
        expect(priced(result.text)).toBeLessThanOrEqual(100);
    });

    it("keeps explicit non-section snippets with a bounded long-path header", () => {
        const wiki: UnifiedSearchResult = {
            source: "wiki",
            content: "sqlite match",
            snippet: "sqlite match",
            score: 1,
            path: `${"nested/".repeat(200)}file.md`,
            line: 12,
            modifiedAtMs: 1767225600000,
        };

        const result = build([wiki], 5000)!;
        const line = result.text.split("\n")[0]!;
        expect(line).toContain("[wiki] path=");
        expect(line).toContain("…");
        expect(line).toContain("sqlite match");
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(1024);
        expect(result.wikiSections).toEqual([]);
    });

    it("preserves a wiki hit inside the downstream UTF-8 byte cap", () => {
        const snippet = `${"前文🙂".repeat(300)} sqlite ${"后文🙂".repeat(300)}`;
        const wiki: UnifiedSearchResult = {
            source: "wiki",
            content: "sqlite",
            snippet,
            score: 1,
            path: "guides/unicode.md",
            line: 1,
            modifiedAtMs: 1767225600000,
        };

        const result = build([wiki], 5000)!;
        const line = result.text.split("\n")[0]!;
        const body = line.split(" :: ")[1]!;

        expect(body).toContain("sqlite");
        expect(Array.from(body).length).toBeLessThanOrEqual(700);
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(1024);
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
        const hits = [
            ...Array.from({ length: 10 }, (_, i) => git(i, `commit ${i}`)),
            primer(1),
            note(2),
            message(3),
            compartment(),
        ];
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
        const result = build([
            git(0, long),
            git(1, long),
            primer(2, long),
            note(3, long),
            message(4),
            compartment(),
        ])!;
        for (const label of [
            "[git_commit] s0",
            "[primer] #2",
            "[note] #3",
            "[message] ord=4",
            "[compartment] #7",
        ]) {
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
        const hits = Array.from({ length: 20 }, (_, i) =>
            git(i, `中文缓存记忆材料${i}`.repeat(100)),
        );
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
        expect(
            build([
                {
                    source: "memory",
                    memoryId: 1,
                    category: "OPS_RULES",
                    content: "memory",
                    score: 1,
                    matchType: "fts",
                },
            ]),
        ).toBeNull();
    });

    it("uses section bounds, content beyond 700 characters and deterministic citations", () => {
        const tail = "section-tail-marker";
        const wiki = sectionWiki(1, {
            path: "guides/setup.md",
            heading: "Setup",
            sectionStartLine: 12,
            sectionEndLine: 40,
            snippet: `${"before ".repeat(180)} sqlite ${"after ".repeat(180)} ${tail}`,
        });
        const result = build([wiki], 10000)!;
        expect(result.text).toContain("[wiki] path=guides/setup.md:12-40 heading=Setup");
        expect(result.text).toContain(tail);
        expect(result.text.length).toBeGreaterThan(700);
        expect(result.wikiSections).toEqual([
            { path: "guides/setup.md", startLine: 12, endLine: 40, heading: "Setup" },
        ]);
    });

    it("keeps a complete long section locator in material and citations", () => {
        const path = `${"nested/".repeat(100)}file.md`;
        const wiki = sectionWiki(1, { path });
        const result = build([wiki], 10_000)!;
        expect(result.text).toContain(`[wiki] path=${path}:10-14 heading=Section 1`);
        expect(result.wikiSections[0]?.path).toBe(path);
    });

    it("cites only section hits that fit the total material budget", () => {
        const first = sectionWiki(1, { path: "a.md", heading: "One" });
        const second = sectionWiki(2, { path: "b.md", heading: "Two" });
        const firstHeader = "[wiki] path=a.md:10-14 heading=One";
        const result = build([first, second], priced(firstHeader) + 3)!;
        expect(result.included).toBe(1);
        expect(result.wikiSections).toEqual([
            { path: "a.md", startLine: 10, endLine: 14, heading: "One" },
        ]);
        expect(result.text).not.toContain("b.md");
        expect(priced(result.text)).toBeLessThanOrEqual(priced(firstHeader) + 3);
    });

    it("caps explicit mixed-source wiki material at three snippets without inventing citations", () => {
        const hits = Array.from({ length: 4 }, (_, index) =>
            sectionWiki(index + 1, {
                heading: undefined,
                sectionStartLine: undefined,
                sectionEndLine: undefined,
                path: `explicit-${index + 1}.md`,
            }),
        );
        const result = build(hits, 10000)!;
        expect(result.included).toBe(3);
        expect(result.text).toContain("explicit-1.md:2");
        expect(result.text).toContain("explicit-3.md:4");
        expect(result.text).not.toContain("explicit-4.md");
        expect(result.wikiSections).toEqual([]);
    });

    it("uses the exact native match casing for budget truncation", () => {
        const wiki = sectionWiki(1, {
            snippet: `needle ${"before ".repeat(300)} Needle ${"after ".repeat(300)}`,
            content: "needle",
            matchText: "Needle",
        });
        const result = buildTransientMaterial({
            db,
            sessionId: "ses-material",
            query: "Needle",
            results: [wiki],
            budgetTokens: 100,
        })!;
        expect(result.text).toContain("Needle");
        expect(result.text.slice(result.text.indexOf(" :: "))).not.toContain("needle ");
    });

    it("lets the total budget truncate a section around the query anchor", () => {
        const wiki = sectionWiki(1, {
            snippet: `${"before ".repeat(300)} sqlite ${"after ".repeat(300)}`,
            content: "sqlite",
        });
        const result = build([wiki], 100)!;
        expect(result.text).toContain("sqlite");
        expect(result.text).toContain("…");
        expect(priced(result.text)).toBeLessThanOrEqual(100);
    });

    it("reserves the fallback section's body before any other source's header", () => {
        const tail = "WIKI-BODY-MARKER";
        const section = sectionWiki(1, { snippet: `sqlite ${tail}` });
        // Allow a two-token rounding margin while keeping the budget too small
        // for another source's header alongside the complete section.
        const onlySectionBudget = priced(build([section], 10_000)!.text) + 2;
        const result = build([message(3), section], onlySectionBudget)!;
        expect(result.text).toContain(tail);
        expect(result.included).toBe(1);
        expect(priced(result.text)).toBeLessThanOrEqual(onlySectionBudget);
        expect(result.wikiSections).toEqual([
            { path: "guide-1.md", startLine: 10, endLine: 14, heading: "Section 1" },
        ]);
    });

    it("does not sacrifice a fallback section body for an omission notice", () => {
        const section = sectionWiki(1, { snippet: "sqlite WIKI-BODY-MARKER" });
        const sectionCost = priced(build([section], 10_000)!.text);
        const messageHeader = "[message] ord=3 range=1-6 time=? role=user";
        const budget = sectionCost + priced(messageHeader) + 2;
        const result = build([message(3), section, message(4)], budget)!;

        expect(result.text).toContain("WIKI-BODY-MARKER");
        expect(result.text).toContain(messageHeader);
        expect(result.text).not.toContain("另有");
        expect(result.truncated).toBe(true);
        expect(priced(result.text)).toBeLessThanOrEqual(budget);
    });

    it("keeps the fallback section's body ahead of git under relative-date ordering", () => {
        const tail = "WIKI-BODY-MARKER";
        const section = sectionWiki(1, { snippet: `sqlite ${tail}` });
        db.prepare("INSERT INTO git_commits VALUES (?, ?)").run(
            "sha1",
            `${"commit ".repeat(120)} GIT-BODY-TAIL`,
        );
        const dateQuery = "昨天 sqlite";
        const onlySectionBudget =
            priced(
                buildTransientMaterial({
                    db,
                    sessionId,
                    query: dateQuery,
                    results: [section],
                    budgetTokens: 10_000,
                })!.text,
            ) + 2;
        const result = buildTransientMaterial({
            db,
            sessionId,
            query: dateQuery,
            results: [section, { ...git(1), matchType: "semantic" }],
            budgetTokens: onlySectionBudget,
        })!;
        // Date intent would hoist the commit ahead of the section; the section's
        // header and body are reserved together, so the commit loses its slot.
        expect(result.text.split("\n")[0]).toContain("[wiki]");
        expect(result.text).toContain(tail);
        expect(result.text).not.toContain("[git_commit]");
        expect(priced(result.text)).toBeLessThanOrEqual(onlySectionBudget);
    });

    it("keeps ordinary allocation for an explicit non-section wiki hit", () => {
        const tail = "WIKI-SNIPPET-TAIL";
        const wiki = sectionWiki(1, {
            heading: "explicit heading",
            sectionStartLine: undefined,
            sectionEndLine: undefined,
            snippet: `${"before ".repeat(150)} sqlite ${"after ".repeat(150)} ${tail}`,
        });
        const budget =
            priced("[wiki] path=guide-1.md:2") +
            priced("[message] ord=3 range=1-6 time=? role=user") +
            4;
        const result = build([message(3), wiki], budget)!;
        // An explicit hit without sectionStartLine keeps ordinary allocation, even
        // if it has a heading: its header is
        // reserved with every other source's first, and the body takes what is
        // left — unchanged behaviour, no body guarantee.
        expect(result.included).toBe(2);
        expect(result.text).toContain("[message]");
        expect(result.text).toContain("[wiki] path=guide-1.md:2");
        expect(result.text).not.toContain(tail);
        expect(result.wikiSections).toEqual([]);
        expect(priced(result.text)).toBeLessThanOrEqual(budget);
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

        expect(buildReservedHits(db, "sqlite", undefined)).toEqual({
            messages: [],
            gitCommits: [],
        });
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
        expect(appendix).toContain(`- [message] ses-rese 2026-01-01T00:00:00.000Z reserved body 7`);
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
        expect(withReservedAppendix("text", { messages: [], gitCommits: [] }, "sqlite")).toBe(
            "text",
        );
        expect(withReservedAppendix("text", { messages: [], gitCommits: [] }, "sqlite", [])).toBe(
            "text",
        );
    });

    it("renders selected wiki section citations after message and git hits", () => {
        const reserved = buildReservedHits(
            db,
            "sqlite",
            candidatesOf({
                messages: [reservedMessage(7, "ses-wiki-section")],
                gitCommits: [reservedGit(1)],
            }),
        );
        const appendix = renderReservedAppendix(reserved, {
            wikiSections: [
                { path: "guides/\nsetup.md", startLine: 12, endLine: 40, heading: "Setup\nGuide" },
            ],
        });
        expect(appendix).toContain(
            'Wiki 小节：\n- [wiki] "guides/\\nsetup.md":12-40 《Setup Guide》',
        );
        const spaced = renderReservedAppendix(reserved, {
            wikiSections: [
                { path: "guides/  setup.md", startLine: 1, endLine: 2, heading: "Setup" },
            ],
        });
        expect(spaced).toContain('[wiki] "guides/  setup.md":1-2');
        expect(appendix.indexOf("- [git_commit]")).toBeLessThan(appendix.indexOf("Wiki 小节："));
        expect(renderReservedAppendix(reserved, { wikiSections: [] })).not.toContain("Wiki 小节：");
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
            "昨天 改了什么",
            "今晚的构建",
            "上周的提交",
            "前天",
            "本周",
            "这周",
            "what broke yesterday",
            "today's build",
            "tonight",
            "last night",
            "last week",
            "this week",
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
        db.prepare(
            "INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (1, 'ses-alpha', 1, 'dup', 'alpha own needle text')",
        ).run();
        db.prepare(
            "INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (2, 'ses-beta', 1, 'dup', 'beta own needle text')",
        ).run();
        db.prepare("INSERT INTO message_fts_rowid_map VALUES ('ses-alpha', 1, 1, ?)").run(
            alphaTime,
        );
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
        db.prepare(
            "INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, content) VALUES (1, 'ses-beta', 1, 'dup', 'beta secret needle text')",
        ).run();
        db.prepare(
            "INSERT INTO message_fts_rowid_map VALUES ('ses-alpha', 1, 1, 1767225600000)",
        ).run();
        const hit = reservedMessage(1, "ses-alpha", 1767225600000, "alpha preview", "dup");
        const reserved = buildReservedHits(db, "needle", candidatesOf({ messages: [hit] }));
        expect(reserved.messages[0]?.snippet).not.toContain("beta secret");
        expect(reserved.messages[0]?.snippet).toContain("alpha preview");
        const appendix = renderReservedAppendix(reserved);
        expect(appendix).not.toContain("beta secret");
        expect(appendix).toContain("alpha preview");
    });
});
