import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { scheduleClearAndReindex, __resetMessageIndexAsyncForTests } from "./message-index-async";
import { runMigrations } from "./migrations";
import { resetEmbeddingCacheForTests } from "./memory";
import { __resetLocalEmbeddingPoolingForTests } from "./memory/local-embedding-pooling";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { searchMessageHistoryOffThread } from "../../hooks/magic-context/auto-search-worker-client";
import { ensureMessagesIndexed } from "./message-index";
import {
    createUnifiedSearchDiagnostics,
    formatSearchResults,
    type MessageSearchResult,
    type ReservedSearchCandidates,
    searchMessageHistory,
    unifiedSearch,
    type UnifiedSearchOptions,
    type UnifiedSearchResult,
} from "./search";
import { appendCompartments, getCompartments } from "./compartment-storage";
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import {
    registerProjectEmbedding,
    _resetProjectEmbeddingRegistryForTests,
} from "./project-embedding-registry";
import { RERANK_MODEL } from "./search-rerank";
import type { SynapseClientLike } from "./memory/embedding-synapse";
import { initializeDatabase as initializeStore } from "./storage-db";

const PROJECT = "git:proj-wide";
const FOREIGN_PROJECT = "git:proj-foreign";

const searchOptions = (extra: Partial<UnifiedSearchOptions> = {}): UnifiedSearchOptions => ({
    sources: ["message"],
    limit: 25,
    embeddingEnabled: false,
    isEmbeddingRuntimeEnabled: () => false,
    explicitSearch: true,
    countRetrievals: false,
    measurementDisabled: true,
    ...extra,
});

const messageHitsOf = (results: UnifiedSearchResult[]): MessageSearchResult[] =>
    results.filter((result): result is MessageSearchResult => result.source === "message");

function createTestDb(): Database {
    // Same construction as search.test.ts: storage pragmas plus the v4+ schema.
    const db = new Database(":memory:");
    initializeStore(db);
    runMigrations(db);
    return db;
}

function mapSessionToProject(
    db: Database,
    sessionId: string,
    projectPath: string,
    harness: string,
    // Tests default the binding change to "before everything": seeded
    // messages are always attributed to this project unless a test passes an
    // explicit moment to exercise the session-moved-projects rule.
    updatedAt = 0,
): void {
    db.prepare(
        `INSERT OR IGNORE INTO session_projects (session_id, harness, project_path, updated_at)
         VALUES (?, ?, ?, ?)`,
    ).run(sessionId, harness, projectPath, updatedAt);
}

function seedSession(
    db: Database,
    sessionId: string,
    messages: Array<{
        ordinal: number;
        id: string;
        role: string;
        text: string;
        createdAt?: number;
    }>,
): void {
    // The indexer derives its watermark from `messages.length` and only indexes
    // the contiguous prefix 1..length, exactly like production history. Sparse
    // ordinals (a lone message at ordinal 20) would silently never index, so
    // pad the gaps with non-matching filler messages. Filler text deliberately
    // contains none of the tests' query terms, so match counts stay exact.
    const byOrdinal = new Map(messages.map((message) => [message.ordinal, message]));
    const maxOrdinal = Math.max(...messages.map((message) => message.ordinal));
    const raw: RawMessage[] = [];
    for (let ordinal = 1; ordinal <= maxOrdinal; ordinal++) {
        const message = byOrdinal.get(ordinal);
        raw.push(
            message
                ? {
                      ordinal,
                      id: message.id,
                      role: message.role,
                      parts: [{ type: "text", text: message.text }],
                      createdAt: message.createdAt,
                  }
                : {
                      ordinal,
                      id: `pad-${sessionId}-${ordinal}`,
                      role: "assistant",
                      parts: [{ type: "text", text: `pad note ${ordinal}` }],
                  },
        );
    }
    ensureMessagesIndexed(db, sessionId, () => raw);
}

/** Register a local mock embedding project, mirroring search.test.ts. */
function registerEmbeddingProject(db: Database, projectPath: string) {
    return registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: true },
        projectPath,
    );
}

function seedProjectSessions(db: Database): void {
    seedSession(db, "ses-a", [
        { ordinal: 1, id: "a-needle", role: "user", text: "needle first hit" },
    ]);
    seedSession(db, "ses-b", [
        { ordinal: 1, id: "b-needle", role: "user", text: "needle elsewhere" },
    ]);
    mapSessionToProject(db, "ses-a", PROJECT, "opencode");
    mapSessionToProject(db, "ses-b", PROJECT, "opencode");
}

/** Two same-project sessions whose literal probes match very different shares
 *  of messages — the multi-probe lane, exercised across the session set. */
function seedWorkerSessions(db: Database): void {
    for (const sessionId of ["ses-a", "ses-b"]) {
        const messages = Array.from({ length: 60 }, (_, index) => ({
            ordinal: index + 1,
            id: `${sessionId}-m-${index}`,
            role: index % 2 ? "assistant" : "user",
            parts: [
                {
                    type: "text",
                    text: [
                        index % 3 === 0 ? "tok_x" : "retry budget",
                        index % 5 === 0 ? "src/config.json" : "notes.md",
                        index % 7 === 0 ? "worker pool drains" : "queue backlog",
                        `step ${index}`,
                    ].join(" "),
                },
            ],
        }));
        ensureMessagesIndexed(db, sessionId, () => messages);
        mapSessionToProject(db, sessionId, PROJECT, "opencode");
    }
}

describe("project-wide explicit message search", () => {
    // All project paths below are already-resolved git: identities, which
    // normalizeStoredProjectPath returns byte-for-byte — no git probing.
    afterEach(() => {
        __resetMessageIndexAsyncForTests();
        __resetLocalEmbeddingPoolingForTests();
        _resetProjectEmbeddingRegistryForTests();
        resetEmbeddingCacheForTests();
    });

    test("returns same-project other-session hits with session identity and persisted time", async () => {
        const db = createTestDb();
        const timeA = 1_700_000_000_000;
        const timeB = 1_700_000_500_000;
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "a-needle", role: "user", text: "needle first hit", createdAt: timeA },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "b-needle", role: "user", text: "needle elsewhere", createdAt: timeB },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions());

        const hits = messageHitsOf(results);
        expect(hits).toHaveLength(2);
        const hitB = hits.find((hit) => hit.sessionId === "ses-b");
        expect(hitB).toBeDefined();
        expect(hitB?.messageId).toBe("b-needle");
        expect(hitB?.messageOrdinal).toBe(1);
        expect(hitB?.messageTimeMs).toBe(timeB);
        const hitA = hits.find((hit) => hit.sessionId === "ses-a");
        expect(hitA?.messageTimeMs).toBe(timeA);
        // The formatter threads the foreign-session identity through.
        expect(formatSearchResults("needle", hits, "ses-a")).toContain("session=ses-b");
    });

    test("excludes foreign-project, unmapped and conflicted-mapping sessions", async () => {
        const db = createTestDb();
        seedProjectSessions(db);
        seedSession(db, "ses-c", [
            { ordinal: 1, id: "c-needle", role: "user", text: "needle foreign" },
        ]);
        mapSessionToProject(db, "ses-c", FOREIGN_PROJECT, "opencode");
        seedSession(db, "ses-d", [
            { ordinal: 1, id: "d-needle", role: "user", text: "needle unmapped" },
        ]);
        seedSession(db, "ses-e", [
            { ordinal: 1, id: "e-needle", role: "user", text: "needle conflicted" },
        ]);
        // One session mapped to two different identities across harnesses: refused, not guessed.
        mapSessionToProject(db, "ses-e", PROJECT, "opencode");
        mapSessionToProject(db, "ses-e", FOREIGN_PROJECT, "pi");

        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions());

        const sessionIds = messageHitsOf(results)
            .map((hit) => hit.sessionId)
            .sort();
        expect(sessionIds).toEqual(["ses-a", "ses-b"]);
    });

    test("applies the ordinal cutoff only to the current session", async () => {
        const db = createTestDb();
        seedSession(db, "ses-a", [
            { ordinal: 3, id: "a-young", role: "user", text: "needle young" },
            { ordinal: 10, id: "a-old", role: "user", text: "needle old" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 20, id: "b-far", role: "user", text: "needle far future" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        const diagnostics = createUnifiedSearchDiagnostics();
        const results = await unifiedSearch(
            db,
            "ses-a",
            PROJECT,
            "needle",
            searchOptions({ maxMessageOrdinal: 5, diagnostics }),
        );

        const sessionOrdinals = messageHitsOf(results)
            .map((hit) => `${hit.sessionId}@${hit.messageOrdinal}`)
            .sort();
        expect(sessionOrdinals).toEqual(["ses-a@3", "ses-b@20"]);
        // The suppressed-live-tail count belongs to the current session only:
        // ses-a@10 matches but is past the cutoff; ses-b@20 is uncapped.
        expect(diagnostics.suppressedLiveMessageMatches).toBe(1);
    });

    test("keeps null map time null instead of fabricating", async () => {
        const db = createTestDb();
        const timeB = 1_700_001_000_000;
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "a-needle", role: "user", text: "needle no time" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "b-needle", role: "user", text: "needle timed", createdAt: timeB },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions());
        const hits = messageHitsOf(results);

        expect(hits.find((hit) => hit.sessionId === "ses-a")?.messageTimeMs).toBeNull();
        expect(hits.find((hit) => hit.sessionId === "ses-b")?.messageTimeMs).toBe(timeB);
    });

    test("never merges another session's message into this session's compartment at the same ordinal", async () => {
        const db = createTestDb();
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "a-u", role: "user", text: "queue saturation problem" },
            { ordinal: 2, id: "a-a", role: "assistant", text: "bounded drains with backpressure" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 2, id: "b-u", role: "user", text: "queue saturation elsewhere" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");
        const snapshot = registerEmbeddingProject(db, PROJECT);
        appendCompartments(db, "ses-a", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "a-u",
                endMessageId: "a-a",
                title: "queue saturation",
                content: "queue saturation work",
                p1: "queue saturation work",
            },
        ]);
        const compartment = getCompartments(db, "ses-a")[0];
        const windows = chunkCanonicalText("[1] U: queue saturation problem\n[2] A: bounded drains with backpressure", 1, 10, 10000);
        replaceCompartmentChunkEmbeddings(
            db,
            windows.map((window) => ({
                compartmentId: compartment.id,
                sessionId: "ses-a",
                projectPath: PROJECT,
                window,
                modelId: snapshot.chunkModelId,
                vector: new Float32Array([1, 0]),
            })),
        );
        const embedQuery = async () => new Float32Array([1, 0]);

        const results = await unifiedSearch(
            db,
            "ses-a",
            PROJECT,
            "queue saturation",
            searchOptions({
                embeddingEnabled: true,
                isEmbeddingRuntimeEnabled: () => true,
                embedQuery,
            }),
        );

        // The other session's same-ordinal message survives as its own hit.
        const foreignHit = messageHitsOf(results).find((hit) => hit.sessionId === "ses-b");
        expect(foreignHit).toBeDefined();
        expect(foreignHit?.messageOrdinal).toBe(2);
        expect(foreignHit?.content).toContain("elsewhere");
        // The compartment is still retrieved, and its hybrid snippet — if the
        // own-session message donated one — can never come from the other session.
        const compartmentHit = results.find((result) => result.source === "compartment");
        expect(compartmentHit).toBeDefined();
        if (compartmentHit?.source === "compartment" && compartmentHit.snippet) {
            expect(compartmentHit.snippet).not.toContain("elsewhere");
        }
    });

    test("drops only the invalidated session's hits, keeping the other project sessions", async () => {
        const db = createTestDb();
        seedProjectSessions(db);

        const both = messageHitsOf(await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions()));
        expect(both.map((hit) => hit.sessionId).sort()).toEqual(["ses-a", "ses-b"]);

        scheduleClearAndReindex(db, "ses-b", () => []);
        const withoutB = messageHitsOf(
            await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions()),
        );
        expect(withoutB.map((hit) => hit.sessionId)).toEqual(["ses-a"]);

        // The current session rebuilding no longer blanks the lane: the other
        // project session still returns its history.
        __resetMessageIndexAsyncForTests();
        scheduleClearAndReindex(db, "ses-a", () => []);
        const withoutA = messageHitsOf(
            await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions()),
        );
        expect(withoutA.map((hit) => hit.sessionId)).toEqual(["ses-b"]);
    });

    test("scopes excludeMessageId to the current session", async () => {
        const db = createTestDb();
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "dup-needle", role: "user", text: "needle here" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "dup-needle", role: "user", text: "needle twin" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        const results = await unifiedSearch(
            db,
            "ses-a",
            PROJECT,
            "needle",
            searchOptions({ excludeMessageId: "dup-needle" }),
        );

        const sessionIds = messageHitsOf(results).map((hit) => hit.sessionId);
        expect(sessionIds).toEqual(["ses-b"]);
    });

    test("recalls literal probes across the session set with per-session identity", async () => {
        const db = createTestDb();
        seedSession(db, "ses-a", [
            {
                ordinal: 1,
                id: "a-u",
                role: "user",
                text: "where does tok_x in src/config.json reach the worker pool",
            },
        ]);
        seedSession(db, "ses-b", [
            {
                ordinal: 1,
                id: "b-u",
                role: "user",
                text: "tok_x flows from src/config.json into the worker pool",
            },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        // Direct lane call: exercises the batched project-wide probe statements
        // and the whole-table IDF-lite corpus.
        const outcome = searchMessageHistory(db, {
            sessionId: "ses-a",
            query: "where does tok_x in src/config.json reach the worker pool",
            limit: 25,
            probes: ["tok_x", "src/config.json"],
            relaxedRecall: true,
            collectDiagnostics: true,
            dateRange: null,
            projectSessionIds: ["ses-a", "ses-b"],
        });

        const sessionIds = outcome.results.map((hit) => hit.sessionId).sort();
        expect(sessionIds).toEqual(["ses-a", "ses-b"]);
        const keys = new Set(outcome.results.map((hit) => `${hit.sessionId}:${hit.messageId}`));
        expect(keys.size).toBe(outcome.results.length);
        for (const hit of outcome.results) {
            expect(hit.messageTimeMs).toBeNull();
        }
    });

    test("falls back to global MATCH plus the session guard when a candidate's map coverage is incomplete", async () => {
        const db = createTestDb();
        seedProjectSessions(db);
        // A legacy row with no rowid-map entry makes ses-b's coverage
        // incomplete → the set drops the rowid prefilter, still guarded by the
        // session predicate; the unmapped row is then reachable again.
        db.prepare(
            `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
             VALUES ('ses-b', 50, 'b-legacy', 'user', 'needle legacy')`,
        ).run();

        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions());
        const hits = messageHitsOf(results);

        expect(
            hits.some((hit) => hit.sessionId === "ses-b" && hit.messageId === "b-legacy"),
        ).toBe(true);
        expect(hits.some((hit) => hit.sessionId === "ses-a")).toBe(true);
    });

    test("reserved-candidate channel reports pre-truncation hits for explicit fusion only", async () => {
        const db = createTestDb();
        const seeded = Array.from({ length: 6 }, (_, index) => ({
            ordinal: index + 1,
            id: `a-${index + 1}`,
            role: "user",
            text: `needle seed ${index + 1}`,
        }));
        seedSession(db, "ses-a", seeded);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "b-1", role: "user", text: "needle other" },
            { ordinal: 2, id: "b-2", role: "user", text: "needle other two" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");
        db.prepare(
            `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
             VALUES ('needle-sha', ?, 'needle-s', 'needle commit', NULL, ?, ?)`,
        ).run(PROJECT, Date.now() - 60_000, Date.now());

        const collected: ReservedSearchCandidates[] = [];
        const results = await unifiedSearch(
            db,
            "ses-a",
            PROJECT,
            "needle",
            searchOptions({
                sources: ["message", "git_commit"],
                gitCommitsEnabled: true,
                limit: 2,
                collectReservedCandidates: (candidates) => {
                    collected.push(candidates);
                },
            }),
        );

        // The primary result is truncated by the global limit while the
        // reserved channel keeps the raw pre-truncation hits.
        expect(results.length).toBeLessThanOrEqual(2);
        expect(collected).toHaveLength(1);
        const reserved = collected[0];
        expect(reserved.messages.length).toBe(5);
        expect(reserved.messages.every((hit) => hit.source === "message")).toBe(true);
        expect(reserved.messages.some((hit) => hit.sessionId === "ses-b")).toBe(true);
        expect(reserved.currentSessionMessages.length).toBe(5);
        expect(reserved.currentSessionMessages.every((hit) => hit.sessionId === "ses-a")).toBe(
            true,
        );
        expect(reserved.gitCommits.map((hit) => hit.sha)).toEqual(["needle-sha"]);

        // Auto-search and plain explicit search never collect.
        const autoCollected: ReservedSearchCandidates[] = [];
        await unifiedSearch(
            db,
            "ses-a",
            PROJECT,
            "needle",
            searchOptions({
                explicitSearch: false,
                collectReservedCandidates: (candidates) => {
                    autoCollected.push(candidates);
                },
            }),
        );
        expect(autoCollected).toHaveLength(0);
        const plainCollected: ReservedSearchCandidates[] = [];
        await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions());
        expect(plainCollected).toHaveLength(0);
    });
});

describe("project-wide review regressions", () => {
    afterEach(() => {
        __resetMessageIndexAsyncForTests();
        __resetLocalEmbeddingPoolingForTests();
        _resetProjectEmbeddingRegistryForTests();
        resetEmbeddingCacheForTests();
    });

    test("a session invalidated mid-search frees its slot before truncation", async () => {
        const db = createTestDb();
        seedProjectSessions(db);

        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", {
            ...searchOptions({ limit: 1 }),
            searchMessageHistory: async (request) => {
                // The lane already holds ses-a's hits; kill its index before the
                // owner post-processes. Pre-truncation validation must drop it
                // so ses-b fills the single slot (post-slice filtering would
                // have returned an empty result).
                const outcome = searchMessageHistory(db, request);
                scheduleClearAndReindex(db, "ses-a", () => []);
                return outcome;
            },
        });

        const hits = messageHitsOf(results);
        expect(hits).toHaveLength(1);
        expect(hits[0]?.sessionId).toBe("ses-b");
    });

    test("reserved candidates are re-validated when the search returns", async () => {
        const db = createTestDb();
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "a-why", role: "user", text: "why is the needle here alpha" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "b-why", role: "user", text: "why is the needle here beta" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        const fingerprint = "a".repeat(64);
        const catalog = {
            models: [{ model_id: RERANK_MODEL, certified: true, fingerprints: [fingerprint] }],
            table_epoch: 2,
        };
        const rerankClient: SynapseClientLike = {
            call: async <T>(_module: string, method: string): Promise<T> => {
                if (method === "models.list") return catalog as T;
                // ses-b's index dies mid-rerank — after the reserved channel
                // snapshotted both hits. The return-time re-validation must
                // drop ses-b from what the caller reads.
                scheduleClearAndReindex(db, "ses-b", () => []);
                return { fingerprint, table_epoch: 2, scores: [1, 1] } as T;
            },
            close() {},
        };

        const collected: ReservedSearchCandidates[] = [];
        await unifiedSearch(db, "ses-a", PROJECT, "why is the needle here", {
            ...searchOptions(),
            rerankClient,
            captureRerankLanes: () => {},
            collectReservedCandidates: (candidates) => collected.push(candidates),
        });

        expect(collected).toHaveLength(1);
        expect(collected[0].messages.length).toBeGreaterThan(0);
        expect(collected[0].messages.every((hit) => hit.sessionId === "ses-a")).toBe(true);
        expect(
            collected[0].currentSessionMessages.every((hit) => hit.sessionId === "ses-a"),
        ).toBe(true);
    });

    test("single-session lane reads the persisted message time", async () => {
        const db = createTestDb();
        const time = 1_700_000_000_000;
        // No session_projects rows: the lane stays single-session.
        seedSession(db, "ses-solo", [
            { ordinal: 1, id: "solo-1", role: "user", text: "needle solo", createdAt: time },
        ]);

        const results = await unifiedSearch(db, "ses-solo", PROJECT, "needle", searchOptions());

        const hit = messageHitsOf(results)[0];
        expect(hit?.sessionId).toBe("ses-solo");
        expect(hit?.messageTimeMs).toBe(time);
    });

    test("formatted foreign hits expand against their owning session", async () => {
        const db = createTestDb();
        seedProjectSessions(db);

        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", searchOptions());
        const formatted = formatSearchResults("needle", results, "ses-a");
        expect(formatted).toContain('ctx_expand(sessionId: "ses-b"');

        // Current-session-only results keep the historical hint untouched.
        const ownOnly = messageHitsOf(results).filter((hit) => hit.sessionId === "ses-a");
        const ownFormatted = formatSearchResults("needle", ownOnly, "ses-a");
        expect(ownFormatted).not.toContain("sessionId:");
    });

    test("caps the session-set bind parameters under the SQLite variable limit", () => {
        const db = createTestDb();
        seedProjectSessions(db);
        // 800 ghost ids after the real ones: binding every id twice (rowid
        // prefilter + integrity guard) would exceed SQLITE_MAX_VARIABLE_NUMBER
        // (999); the cap keeps the statement runnable and the head sessions
        // searchable.
        const ids = [
            "ses-a",
            "ses-b",
            ...Array.from({ length: 800 }, (_, index) => `ghost-${index}`),
        ];
        const outcome = searchMessageHistory(db, {
            sessionId: "ses-a",
            query: "needle",
            limit: 10,
            dateRange: null,
            projectSessionIds: ids,
        });
        expect(outcome.results.map((hit) => hit.sessionId).sort()).toEqual([
            "ses-a",
            "ses-b",
        ]);
    });

    test("session-moved-projects: pre-move hits stay out; NULL-time rows remain", async () => {
        const db = createTestDb();
        const beforeMove = 1_000_000;
        const movedAt = 2_000_000;
        const afterMove = 3_000_000;
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "a-needle", role: "user", text: "needle home" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "b-old", role: "user", text: "needle old project", createdAt: beforeMove },
            { ordinal: 2, id: "b-new", role: "user", text: "needle new project", createdAt: afterMove },
        ]);
        seedSession(db, "ses-c", [
            { ordinal: 1, id: "c-legacy", role: "user", text: "needle legacy" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode", movedAt);
        mapSessionToProject(db, "ses-c", PROJECT, "opencode", movedAt);

        const collected: ReservedSearchCandidates[] = [];
        const results = await unifiedSearch(db, "ses-a", PROJECT, "needle", {
            ...searchOptions(),
            collectReservedCandidates: (candidates) => collected.push(candidates),
        });

        const byId = new Map(messageHitsOf(results).map((hit) => [hit.messageId, hit]));
        // Indexed before the binding changed: belongs to the previous project.
        expect(byId.has("b-old")).toBe(false);
        // Indexed after the move: exposed.
        expect(byId.get("b-new")?.sessionId).toBe("ses-b");
        // Legacy shortcut: no index time — attributed to the current project.
        expect(byId.get("c-legacy")?.sessionId).toBe("ses-c");

        // The reserved channel inherits the same attribution filter.
        expect(collected).toHaveLength(1);
        expect(
            collected[0].messages.every((hit) => hit.messageId !== "b-old"),
        ).toBe(true);
    });
    test("normal message results are re-validated after the rerank await", async () => {
        const db = createTestDb();
        seedSession(db, "ses-a", [
            { ordinal: 1, id: "a-why", role: "user", text: "why is the needle here alpha" },
        ]);
        seedSession(db, "ses-b", [
            { ordinal: 1, id: "b-why", role: "user", text: "why is the needle here beta" },
        ]);
        mapSessionToProject(db, "ses-a", PROJECT, "opencode");
        mapSessionToProject(db, "ses-b", PROJECT, "opencode");

        const fingerprint = "a".repeat(64);
        const catalog = {
            models: [{ model_id: RERANK_MODEL, certified: true, fingerprints: [fingerprint] }],
            table_epoch: 2,
        };
        const rerankClient: SynapseClientLike = {
            call: async <T>(_module: string, method: string): Promise<T> => {
                if (method === "models.list") return catalog as T;
                // ses-b's index dies mid-rerank: both sessions' hits were valid
                // at the pre-truncation pass, so only a return-point
                // re-validation can keep ses-b's hits from shipping.
                scheduleClearAndReindex(db, "ses-b", () => []);
                return { fingerprint, table_epoch: 2, scores: [1, 1] } as T;
            },
            close() {},
        };

        const results = await unifiedSearch(db, "ses-a", PROJECT, "why is the needle here", {
            ...searchOptions(),
            rerankClient,
        });

        const hits = messageHitsOf(results);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((hit) => hit.sessionId === "ses-a")).toBe(true);
    });
});

describe("project-wide worker parity", () => {
    test("worker and local lanes return identical project-wide results", async () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-proj-wide-worker-");
        const db = new Database(join(directory, "context.db"));
        try {
            initializeStore(db);
            seedWorkerSessions(db);

            const query = "where does tok_x in src/config.json reach the worker pool";
            const inProcessDiagnostics = createUnifiedSearchDiagnostics();
            const local = await unifiedSearch(
                db,
                "ses-a",
                PROJECT,
                query,
                searchOptions({ diagnostics: inProcessDiagnostics }),
            );
            let delegatedCalls = 0;
            const workerDiagnostics = createUnifiedSearchDiagnostics();
            const worker = await unifiedSearch(db, "ses-a", PROJECT, query, {
                ...searchOptions({ diagnostics: workerDiagnostics }),
                searchMessageHistory: async (request) => {
                    const outcome = await searchMessageHistoryOffThread(db, request);
                    if (outcome) delegatedCalls += 1;
                    return outcome;
                },
            });

            expect(delegatedCalls).toBe(1);
            expect(worker).toEqual(local);
            expect(workerDiagnostics).toEqual(inProcessDiagnostics);
            // The delegated lane really crossed sessions on the worker (more
            // than three hits total, both sessions represented).
            const workerSessions = [
                ...new Set(messageHitsOf(worker).map((hit) => hit.sessionId)),
            ].sort();
            expect(workerSessions).toEqual(["ses-a", "ses-b"]);
            expect(messageHitsOf(worker).length).toBeGreaterThan(3);
        } finally {
            __resetMessageIndexAsyncForTests();
            db.close();
            cleanup();
        }
    }, 60_000);
});
