/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { buildTransientMaterial } from "../../tools/ctx-search/transient-material";
import {
    chunkCanonicalText,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import { appendCompartments, getCompartments } from "./compartment-storage";
import { saveCommitEmbedding } from "./git-commits/storage-git-commit-embeddings";
import { upsertCommits } from "./git-commits/storage-git-commits";
import { insertMemory, resetEmbeddingCacheForTests, saveEmbedding } from "./memory";
import { recordMessageFtsRowid } from "./message-fts-rowid-map";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import {
    _resetProjectEmbeddingRegistryForTests,
    registerProjectEmbedding,
} from "./project-embedding-registry";
import {
    createUnifiedSearchDiagnostics,
    formatSearchResults,
    type UnifiedSearchResult,
    unifiedSearch,
} from "./search";
import type { SearchLanes } from "./search-rerank";
import { initializeDatabase } from "./storage-db";
import { addNote } from "./storage-notes";
import { createPrimer } from "./storage-primers";
import * as wikiSearchModule from "./wiki-search";
import { type WikiCorpusHit, type WikiFffModule, WikiSearchError } from "./wiki-search";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A global corpus hit; mtimes are epoch milliseconds from the native match time. */
function hit(overrides: Partial<WikiCorpusHit> & { path: string; line: number }): WikiCorpusHit {
    return {
        snippet: `context line\n${overrides.path}:${overrides.line}\nnext line`,
        preview: `line ${overrides.line} of ${overrides.path}`,
        modifiedAtMs: Date.parse("2026-01-15T00:00:00.000Z"),
        ...overrides,
    };
}

const WIKI_ENABLED = { enabled: true, source_root: "/tmp/global-wiki" } as const;
const WIKI_DISABLED = { enabled: false, source_root: "/tmp/global-wiki" } as const;

function insertLiveMessage(
    db: Database,
    sessionId: string,
    content: string,
    timeMs: number,
    role: "user" | "assistant" = "assistant",
    ordinal = 2,
): void {
    const result = db
        .prepare(
            `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, ordinal, `live-${ordinal}`, role, content);
    recordMessageFtsRowid(db, sessionId, ordinal, result.lastInsertRowid, timeMs);
}

/** Raw conversation fixture for the message index and the history-chunk lane. */
const rawMessagesBySession = new Map<
    string,
    Array<{ ordinal: number; id: string; role: string; parts: unknown[] }>
>();
const readMessages = (sessionId: string) => rawMessagesBySession.get(sessionId) ?? [];
const embedChunkQuery = async () => new Float32Array([0, 1]);

function registerEmbeddingProject(db: Database, projectPath: string) {
    return registerProjectEmbedding(
        db,
        projectPath,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: true },
        projectPath,
    );
}

/** Seed one history compartment and its window embedding so the semantic lane
 *  can return it for a query the raw messages never match lexically. */
function seedCompartmentChunk(
    db: Database,
    sessionId: string,
    projectPath: string,
    vector: Float32Array,
    modelId: string,
): number {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "u1",
            endMessageId: "a2",
            title: "Queue saturation design",
            content: "P1 content",
            p1: "P1 content",
        },
    ]);
    const compartment = getCompartments(db, sessionId)[0];
    const windows = chunkCanonicalText(
        "[1] U: queue saturation problem\n[2] A: bounded drains with backpressure",
        1,
        2,
        10_000,
    );
    replaceCompartmentChunkEmbeddings(
        db,
        windows.map((window) => ({
            compartmentId: compartment.id,
            sessionId,
            projectPath,
            window,
            modelId,
            vector,
        })),
    );
    return compartment.id;
}

function seedCompartmentSession(db: Database, sessionId: string, projectPath: string): void {
    rawMessagesBySession.set(sessionId, [
        {
            ordinal: 1,
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "queue saturation problem" }],
        },
        {
            ordinal: 2,
            id: "a2",
            role: "assistant",
            parts: [{ type: "text", text: "bounded drains with backpressure" }],
        },
    ]);
    ensureMessagesIndexed(db, sessionId, readMessages);
    const snapshot = registerEmbeddingProject(db, projectPath);
    seedCompartmentChunk(
        db,
        sessionId,
        projectPath,
        new Float32Array([0, 1]),
        snapshot.chunkModelId,
    );
}

describe("unifiedSearch — wiki source", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        wikiSearchModule.__resetWikiFinderForTests();
        closeQuietly(db);
    });

    it("maps global corpus matches with decayed scores and renders path and line", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [
                hit({ path: "guides/architecture.md", line: 12 }),
                hit({ path: "notes/historian.md", line: 40 }),
            ],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-wiki",
                "/repo/project",
                "historian lease",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                },
            );

            // The default source set includes wiki only because user config enabled it.
            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy.mock.calls[0]?.[0]).toMatchObject({
                root: WIKI_ENABLED.source_root,
                query: "historian lease",
            });
            const wiki = results.filter((result) => result.source === "wiki");
            expect(wiki).toHaveLength(2);
            expect(wiki[0]).toMatchObject({
                source: "wiki",
                path: "guides/architecture.md",
                line: 12,
                score: 1,
                modifiedAtMs: Date.parse("2026-01-15T00:00:00.000Z"),
            });
            expect(wiki[1]?.score).toBe(0.5);
            expect(formatSearchResults("historian lease", wiki, "ses-wiki")).toContain(
                "[wiki] score=1.00 path=guides/architecture.md:12",
            );
        } finally {
            spy.mockRestore();
        }
    });

    it("never runs for a disabled corpus, an explicit non-wiki source list, or an empty query", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [],
            partial: false,
        });
        try {
            const disabled = await unifiedSearch(db, "ses-wiki", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_DISABLED,
                sources: ["wiki"],
            });
            expect(disabled).toEqual([]);
            expect(spy).not.toHaveBeenCalled();

            await unifiedSearch(db, "ses-wiki", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["note"],
            });
            expect(spy).not.toHaveBeenCalled();

            // An explicit empty list selects nothing, wiki included.
            await unifiedSearch(db, "ses-wiki", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: [],
            });
            expect(spy).not.toHaveBeenCalled();

            await unifiedSearch(db, "ses-wiki", "/repo/project", "   ", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
            });
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it("applies the inclusive from/to filter to the file mtime", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [
                hit({
                    path: "old.md",
                    line: 1,
                    modifiedAtMs: Date.parse("2025-12-31T23:59:59.000Z"),
                }),
                hit({
                    path: "first-day.md",
                    line: 2,
                    modifiedAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
                }),
                hit({
                    path: "last-day.md",
                    line: 3,
                    modifiedAtMs: Date.parse("2026-01-31T23:59:59.999Z"),
                }),
                hit({
                    path: "new.md",
                    line: 4,
                    modifiedAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
                }),
            ],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-wiki", "/repo/project", "lease", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                from: Date.parse("2026-01-01T00:00:00.000Z"),
                to: Date.parse("2026-01-31T23:59:59.999Z"),
                sources: ["wiki"],
            });
            expect(results.map((result) => (result.source === "wiki" ? result.path : ""))).toEqual([
                "first-day.md",
                "last-day.md",
            ]);
        } finally {
            spy.mockRestore();
        }
    });

    it("filters the full native page by date before slicing to the lane limit", async () => {
        const oldHits = Array.from({ length: 9 }, (_, index) =>
            hit({
                path: `old-${index}.md`,
                line: index + 1,
                modifiedAtMs: Date.parse("2025-12-31T23:59:59.000Z"),
            }),
        );
        const inRange = [
            hit({ path: "in-range-1.md", line: 10 }),
            hit({ path: "in-range-2.md", line: 11 }),
        ];
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [...oldHits, ...inRange],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-wiki", "/repo/project", "lease", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
                from: Date.parse("2026-01-01T00:00:00.000Z"),
                limit: 1,
            });

            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({ source: "wiki", path: "in-range-1.md" });
        } finally {
            spy.mockRestore();
        }
    });

    it("reports possible remaining native results even when date filtering removes the page", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [
                hit({
                    path: "outside-date.md",
                    line: 1,
                    modifiedAtMs: Date.parse("2025-12-31T23:59:59.000Z"),
                }),
            ],
            partial: true,
        });
        try {
            const diagnostics = createUnifiedSearchDiagnostics();
            const results = await unifiedSearch(db, "ses-wiki", "/repo/project", "lease", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
                from: Date.parse("2026-01-01T00:00:00.000Z"),
                diagnostics,
            });

            expect(results).toEqual([]);
            expect(diagnostics.wikiPartial).toBe(true);
            expect(diagnostics.wikiUnavailable).toBeNull();
            const output = formatSearchResults("lease", results, "ses-wiki", diagnostics);
            expect(output).toContain("Wiki: more matches may exist beyond the bounded first page");
            expect(output).not.toContain("source unavailable");
        } finally {
            spy.mockRestore();
        }
    });

    it("isolates a corpus failure to its lane and reports one fixed diagnostic token", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockRejectedValue(
            new WikiSearchError("scan_timeout", "initial scan did not finish within 15000ms"),
        );
        try {
            const diagnostics = createUnifiedSearchDiagnostics();
            const results = await unifiedSearch(db, "ses-wiki", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
                diagnostics,
            });
            expect(results).toEqual([]);
            expect(diagnostics.wikiUnavailable).toBe("scan_timeout");
            // The rendered line carries the fixed token, never the underlying message.
            const rendered = formatSearchResults("historian", results, "ses-wiki", diagnostics);
            expect(rendered).toContain("Wiki: source unavailable (scan_timeout).");
            expect(rendered).not.toContain("15000ms");
        } finally {
            spy.mockRestore();
        }
    });

    it("stays silent when the caller aborted the search", async () => {
        const controller = new AbortController();
        controller.abort();
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockRejectedValue(
            new WikiSearchError("aborted", "wiki search aborted by caller"),
        );
        try {
            const diagnostics = createUnifiedSearchDiagnostics();
            await unifiedSearch(db, "ses-wiki", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
                diagnostics,
                signal: controller.signal,
            });
            expect(diagnostics.wikiUnavailable).toBeNull();
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it("captures wiki hits for the rerank lane pool", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "guides/architecture.md", line: 12 })],
            partial: false,
        });
        let lanes: SearchLanes | undefined;
        try {
            const results: UnifiedSearchResult[] = await unifiedSearch(
                db,
                "ses-wiki",
                "/repo/project",
                "historian",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    sources: ["wiki"],
                    captureRerankLanes: (captured) => {
                        lanes = captured;
                    },
                },
            );
            expect(results).toHaveLength(1);
            expect(lanes?.wiki).toHaveLength(1);
            expect(lanes?.wiki[0]).toMatchObject({
                source: "wiki",
                path: "guides/architecture.md",
            });
        } finally {
            spy.mockRestore();
        }
    });

    it("searches the same user-level root for every project identity", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [],
            partial: false,
        });
        try {
            await unifiedSearch(db, "ses-wiki", "git:project-a", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
            });
            await unifiedSearch(db, "ses-wiki", "git:project-b", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
            });
            // The corpus is process-global: projectPath never reaches the root.
            expect(spy.mock.calls.map((call) => call[0]?.root)).toEqual([
                WIKI_ENABLED.source_root,
                WIKI_ENABLED.source_root,
            ]);
            expect(spy.mock.calls.map((call) => call[0]?.query)).toEqual([
                "historian",
                "historian",
            ]);
        } finally {
            spy.mockRestore();
        }
    });

    it("keeps the global result cap: an oversized wiki request still returns at most 25 hits", async () => {
        const spy = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: Array.from({ length: 30 }, (_, index) =>
                hit({ path: `corpus/page-${index}.md`, line: index + 1 }),
            ),
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-wiki", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                sources: ["wiki"],
                limit: 40,
            });
            // The native page may be larger than the unified cap; the final
            // slice is the same limit every other source obeys — no wiki paging.
            expect(results).toHaveLength(25);
            expect(results.every((result) => result.source === "wiki")).toBe(true);
            // The adapter always fetches the native cap; date filtering then
            // precedes the lane's requested result slice.
            expect(spy.mock.calls[0]?.[0]).toMatchObject({ root: WIKI_ENABLED.source_root });
        } finally {
            spy.mockRestore();
        }
    });
});

describe("unifiedSearch — wiki fallback", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        wikiSearchModule.__resetWikiFinderForTests();
        _resetProjectEmbeddingRegistryForTests();
        resetEmbeddingCacheForTests();
        rawMessagesBySession.clear();
        closeQuietly(db);
    });

    it("lets ordinary and already-visible memory hits close the default internal gate", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "historian lease internal memory",
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const visibleResult = await unifiedSearch(
                db,
                "ses-wiki-gate",
                "/repo/project",
                "historian lease",
                {
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                },
            );
            expect(visibleResult.some((result) => result.source === "memory")).toBe(true);

            const diagnostics = createUnifiedSearchDiagnostics();
            const suppressed = await unifiedSearch(
                db,
                "ses-wiki-gate",
                "/repo/project",
                "historian lease",
                {
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    visibleMemoryIds: new Set([memory.id]),
                    diagnostics,
                },
            );
            expect(suppressed).toEqual([]);
            expect(
                formatSearchResults("historian lease", suppressed, "ses-wiki-gate", diagnostics),
            ).toContain("all already visible in your project-memory block");
            expect(diagnostics.wikiUnavailable).toBeNull();
            expect(diagnostics.wikiPartial).toBe(false);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("lets returned and visible-suppressed relaxed-only memories fall through to wiki", async () => {
        const ids = Array.from(
            { length: 15 },
            (_, index) =>
                insertMemory(db, {
                    projectPath: "/repo/project",
                    category: "RESEARCH",
                    content: `alpha unrelated memory ${index}`,
                }).id,
        );
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "fallback.md", line: 1 })],
            partial: false,
        });
        const options = {
            limit: 25,
            memoryEnabled: true,
            embeddingEnabled: false,
            countRetrievals: false,
            measurementDisabled: true,
        };
        try {
            const ordinary = await unifiedSearch(
                db,
                "ses-relaxed-memory",
                "/repo/project",
                "alpha beta",
                {
                    ...options,
                    sources: ["memory"],
                },
            );
            expect(ordinary).toHaveLength(ids.length);
            expect(
                ordinary.every(
                    (result) => result.source === "memory" && result.matchType === "fts",
                ),
            ).toBe(true);

            const returned = await unifiedSearch(
                db,
                "ses-relaxed-memory",
                "/repo/project",
                "alpha beta",
                {
                    ...options,
                    sources: ["memory", "wiki"],
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                },
            );
            expect(returned.filter((result) => result.source === "memory")).toEqual(ordinary);
            expect(returned.some((result) => result.source === "wiki")).toBe(true);

            const diagnostics = createUnifiedSearchDiagnostics();
            const suppressed = await unifiedSearch(
                db,
                "ses-relaxed-memory",
                "/repo/project",
                "alpha beta",
                {
                    ...options,
                    sources: ["memory", "wiki"],
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    visibleMemoryIds: new Set(ids),
                    diagnostics,
                },
            );
            expect(suppressed.some((result) => result.source === "memory")).toBe(false);
            expect(suppressed.some((result) => result.source === "wiki")).toBe(true);
            expect(diagnostics.suppressedVisibleMemoryIds).toEqual(ids);
            expect(wiki).toHaveBeenCalledTimes(2);
        } finally {
            wiki.mockRestore();
        }
    });

    it("checks strict memory evidence against workspace sharing and dates", async () => {
        db.exec(`
            INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
            VALUES (1, 'ws', '["OPS_RULES"]', 1, 1);
            INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
            VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
        `);
        const partial = insertMemory(db, {
            projectPath: "git:own",
            category: "ENV_STATE",
            content: "alpha partial own memory",
        });
        const hidden = insertMemory(db, {
            projectPath: "git:foreign",
            category: "CONFIG_VALUES",
            content: "alpha beta hidden memory",
        });
        const old = insertMemory(db, {
            projectPath: "git:foreign",
            category: "OPS_RULES",
            content: "alpha beta old memory",
        });
        const inRange = Date.parse("2026-01-20T00:00:00.000Z");
        for (const id of [partial.id, hidden.id]) {
            db.prepare("UPDATE memories SET created_at = ?, shareable = 1 WHERE id = ?").run(
                inRange,
                id,
            );
        }
        db.prepare("UPDATE memories SET created_at = ?, shareable = 1 WHERE id = ?").run(
            Date.parse("2024-01-01T00:00:00.000Z"),
            old.id,
        );
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "fallback.md", line: 1 })],
            partial: false,
        });
        const options = {
            sources: ["memory", "wiki"] as Array<"memory" | "wiki">,
            memoryEnabled: true,
            embeddingEnabled: false,
            wiki: WIKI_ENABLED,
            wikiFallback: true,
            from: Date.parse("2026-01-01T00:00:00.000Z"),
            to: Date.parse("2026-01-31T23:59:59.999Z"),
            countRetrievals: false,
            measurementDisabled: true,
        };
        try {
            const first = await unifiedSearch(
                db,
                "ses-memory-workspace",
                "git:own",
                "alpha beta",
                options,
            );
            expect(
                first.some(
                    (result) => result.source === "memory" && result.memoryId === partial.id,
                ),
            ).toBe(true);
            expect(first.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);

            const shared = insertMemory(db, {
                projectPath: "git:foreign",
                category: "OPS_RULES",
                content: "alpha beta shared memory",
            });
            db.prepare("UPDATE memories SET created_at = ?, shareable = 1 WHERE id = ?").run(
                inRange,
                shared.id,
            );
            const diagnostics = createUnifiedSearchDiagnostics();
            const second = await unifiedSearch(
                db,
                "ses-memory-workspace",
                "git:own",
                "alpha beta",
                {
                    ...options,
                    visibleMemoryIds: new Set([shared.id]),
                    diagnostics,
                },
            );
            expect(second.some((result) => result.source === "wiki")).toBe(false);
            expect(diagnostics.suppressedVisibleMemoryIds).toContain(shared.id);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("lets returned and already-visible semantic-only memories fall through to wiki", async () => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "unrelated networking configuration",
        });
        saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock-model");
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "tailscale.md", line: 1 })],
            partial: false,
        });
        const options = {
            sources: ["memory", "wiki"] as const,
            memoryEnabled: true,
            embeddingEnabled: true,
            embedQuery: async () => new Float32Array([1, 0]),
            isEmbeddingRuntimeEnabled: () => true,
            embeddingModelIdOverride: "mock-model",
            backfillMemoryEmbeddings: false,
            wiki: WIKI_ENABLED,
            wikiFallback: true,
            countRetrievals: false,
            measurementDisabled: true,
        };
        try {
            const returned = await unifiedSearch(
                db,
                "ses-memory-semantic",
                "/repo/project",
                "Tailscale",
                { ...options, sources: [...options.sources] },
            );
            expect(
                returned.some(
                    (result) => result.source === "memory" && result.matchType === "semantic",
                ),
            ).toBe(true);
            expect(returned.some((result) => result.source === "wiki")).toBe(true);

            const diagnostics = createUnifiedSearchDiagnostics();
            const suppressed = await unifiedSearch(
                db,
                "ses-memory-semantic",
                "/repo/project",
                "Tailscale",
                {
                    ...options,
                    sources: [...options.sources],
                    visibleMemoryIds: new Set([memory.id]),
                    diagnostics,
                },
            );
            expect(suppressed.some((result) => result.source === "memory")).toBe(false);
            expect(suppressed.some((result) => result.source === "wiki")).toBe(true);
            expect(diagnostics.suppressedVisibleMemoryIds).toEqual([memory.id]);
            expect(wiki).toHaveBeenCalledTimes(2);
        } finally {
            wiki.mockRestore();
        }
    });

    it.each([
        "fts",
        "hybrid",
    ] as const)("lets %s memory evidence block wiki before visible suppression", async (matchType) => {
        const memory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "Tailscale network configuration",
        });
        if (matchType === "hybrid") {
            saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock-model");
        }
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        const options = {
            sources: ["memory", "wiki"] as const,
            memoryEnabled: true,
            embeddingEnabled: true,
            embedQuery: async () => new Float32Array([1, 0]),
            isEmbeddingRuntimeEnabled: () => true,
            embeddingModelIdOverride: "mock-model",
            backfillMemoryEmbeddings: false,
            wiki: WIKI_ENABLED,
            wikiFallback: true,
            countRetrievals: false,
            measurementDisabled: true,
        };
        try {
            const returned = await unifiedSearch(
                db,
                "ses-memory-lexical",
                "/repo/project",
                "Tailscale",
                {
                    ...options,
                    sources: [...options.sources],
                },
            );
            expect(
                returned.some(
                    (result) => result.source === "memory" && result.matchType === matchType,
                ),
            ).toBe(true);
            const diagnostics = createUnifiedSearchDiagnostics();
            const suppressed = await unifiedSearch(
                db,
                "ses-memory-lexical",
                "/repo/project",
                "Tailscale",
                {
                    ...options,
                    sources: [...options.sources],
                    visibleMemoryIds: new Set([memory.id]),
                    diagnostics,
                },
            );
            expect(suppressed).toEqual([]);
            expect(diagnostics.suppressedVisibleMemoryIds).toEqual([memory.id]);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps lexical memory evidence when semantic candidates fill the memory limit", async () => {
        for (let index = 0; index < 10; index++) {
            const memory = insertMemory(db, {
                projectPath: "/repo/project",
                category: "RESEARCH",
                content: `unrelated networking item ${index}`,
            });
            saveEmbedding(db, memory.id, new Float32Array([1, 0]), "mock-model");
        }
        const lexical = insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "Tailscale subnet lexical evidence",
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-memory-limit",
                "/repo/project",
                "Tailscale subnet",
                {
                    sources: ["memory", "wiki"],
                    limit: 1,
                    memoryEnabled: true,
                    embeddingEnabled: true,
                    embedQuery: async () => new Float32Array([1, 0]),
                    isEmbeddingRuntimeEnabled: () => true,
                    embeddingModelIdOverride: "mock-model",
                    backfillMemoryEmbeddings: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(
                results.some(
                    (result) => result.source === "memory" && result.matchType === "semantic",
                ),
            ).toBe(true);
            expect(
                results.some(
                    (result) => result.source === "memory" && result.memoryId === lexical.id,
                ),
            ).toBe(false);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("ignores lexical memories outside the project or requested dates", async () => {
        const oldMemory = insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "Tailscale old project memory",
        });
        db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
            Date.parse("2024-01-01T00:00:00.000Z"),
            oldMemory.id,
        );
        insertMemory(db, {
            projectPath: "/repo/foreign",
            category: "RESEARCH",
            content: "Tailscale foreign project memory",
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "tailscale.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-memory-eligibility",
                "/repo/project",
                "Tailscale",
                {
                    sources: ["memory", "wiki"],
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    from: Date.parse("2026-01-01T00:00:00.000Z"),
                    to: Date.parse("2026-01-31T23:59:59.999Z"),
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results.some((result) => result.source === "memory")).toBe(false);
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it.each([
        "semantic",
        "fts",
        "hybrid",
    ] as const)("uses %s primer evidence for the wiki gate", async (matchType) => {
        createPrimer(db, {
            projectPath: "/repo/project",
            question:
                matchType === "semantic"
                    ? "unrelated networking configuration"
                    : "Tailscale configuration",
            questionEmbedding: matchType === "fts" ? null : new Float32Array([1, 0]),
            questionEmbeddingModelId: "mock-model",
            totalSupport: 1,
            lastObservedAt: Date.now(),
            sourceCandidateIds: [],
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "tailscale.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-primer-gate",
                "/repo/project",
                "Tailscale",
                {
                    sources: ["primer", "wiki"],
                    memoryEnabled: true,
                    embeddingEnabled: true,
                    embedQuery: async () => new Float32Array([1, 0]),
                    isEmbeddingRuntimeEnabled: () => true,
                    embeddingModelIdOverride: "mock-model",
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(
                results.some(
                    (result) => result.source === "primer" && result.matchType === matchType,
                ),
            ).toBe(true);
            expect(results.some((result) => result.source === "wiki")).toBe(
                matchType === "semantic",
            );
            expect(wiki).toHaveBeenCalledTimes(matchType === "semantic" ? 1 : 0);
        } finally {
            wiki.mockRestore();
        }
    });

    it("blocks wiki when semantic primers crowd lexical evidence out of the lane limit", async () => {
        for (let index = 0; index < 10; index++) {
            createPrimer(db, {
                projectPath: "/repo/project",
                question: `unrelated networking question ${index}`,
                questionEmbedding: new Float32Array([1, 0]),
                questionEmbeddingModelId: "mock-model",
                totalSupport: 10,
                lastObservedAt: Date.now(),
                sourceCandidateIds: [],
            });
        }
        const lexicalId = createPrimer(db, {
            projectPath: "/repo/project",
            question: "Tailscale configuration",
            totalSupport: 1,
            lastObservedAt: Date.now(),
            sourceCandidateIds: [],
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        const options = {
            memoryEnabled: true,
            embeddingEnabled: true,
            embedQuery: async () => new Float32Array([1, 0]),
            isEmbeddingRuntimeEnabled: () => true,
            embeddingModelIdOverride: "mock-model",
            countRetrievals: false,
            measurementDisabled: true,
        };
        try {
            const ordinary = await unifiedSearch(
                db,
                "ses-primer-limit",
                "/repo/project",
                "Tailscale",
                { ...options, sources: ["primer"], limit: 10 },
            );
            expect(ordinary).toHaveLength(10);
            expect(
                ordinary.every(
                    (result) => result.source === "primer" && result.matchType === "semantic",
                ),
            ).toBe(true);
            expect(
                ordinary.some(
                    (result) => result.source === "primer" && result.primerId === lexicalId,
                ),
            ).toBe(false);

            const results = await unifiedSearch(
                db,
                "ses-primer-limit",
                "/repo/project",
                "Tailscale",
                {
                    ...options,
                    sources: ["primer", "wiki"],
                    limit: 1,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                },
            );
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({ source: "primer", matchType: "semantic" });
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("excludes the current user and assistant call without changing diagnostics", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        insertLiveMessage(db, "ses-current-prompt", "dnsmasq current prompt", now, "user", 2);
        insertLiveMessage(db, "ses-current-prompt", '{"query":"dnsmasq"}', now, "assistant", 3);
        const diagnostics = createUnifiedSearchDiagnostics();
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "dnsmasq.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-current-prompt",
                "/repo/project",
                "dnsmasq",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["live-2", "live-3"],
                    diagnostics,
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
            expect(diagnostics.suppressedLiveMessageMatches).toBe(2);
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps earlier live user and assistant matches as wiki evidence", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            for (const role of ["user", "assistant"] as const) {
                const sessionId = `ses-earlier-${role}`;
                insertLiveMessage(db, sessionId, `dnsmasq earlier ${role}`, now, role, 2);
                insertLiveMessage(db, sessionId, "dnsmasq current prompt", now, "user", 3);
                insertLiveMessage(db, sessionId, '{"query":"dnsmasq"}', now, "assistant", 4);
                const results = await unifiedSearch(db, sessionId, "/repo/project", "dnsmasq", {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["live-3", "live-4"],
                    countRetrievals: false,
                    measurementDisabled: true,
                });
                expect(results).toEqual([]);
            }
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("excludes only the user when the current assistant id is unavailable", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        insertLiveMessage(db, "ses-no-current-assistant", "dnsmasq earlier", now, "assistant", 2);
        insertLiveMessage(db, "ses-no-current-assistant", "dnsmasq current", now, "user", 3);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "must-not-run.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-no-current-assistant",
                "/repo/project",
                "dnsmasq",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["live-3"],
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results).toEqual([]);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps an intervening tool-result message as wiki evidence", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        insertLiveMessage(db, "ses-tool-result", "dnsmasq current", now, "user", 2);
        insertLiveMessage(db, "ses-tool-result", "dnsmasq tool result", now, "user", 3);
        insertLiveMessage(db, "ses-tool-result", '{"query":"dnsmasq"}', now, "assistant", 4);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "must-not-run.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-tool-result", "/repo/project", "dnsmasq", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                maxMessageOrdinal: 1,
                currentQueryMessageIds: ["live-2", "live-4"],
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(results).toEqual([]);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("does not exclude the same message ids in another session", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        const current = db
            .prepare(
                `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                 VALUES ('ses-current-shared-id', 2, 'shared-id', 'user', 'dnsmasq current')`,
            )
            .run();
        recordMessageFtsRowid(db, "ses-current-shared-id", 2, current.lastInsertRowid, now);
        const currentAssistant = db
            .prepare(
                `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                 VALUES ('ses-current-shared-id', 3, 'shared-assistant', 'assistant', 'dnsmasq current call')`,
            )
            .run();
        recordMessageFtsRowid(
            db,
            "ses-current-shared-id",
            3,
            currentAssistant.lastInsertRowid,
            now,
        );
        const other = db
            .prepare(
                `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                 VALUES ('ses-other-shared-id', 1, 'shared-id', 'user', 'dnsmasq other session')`,
            )
            .run();
        recordMessageFtsRowid(db, "ses-other-shared-id", 1, other.lastInsertRowid, now);
        const otherAssistant = db
            .prepare(
                `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                 VALUES ('ses-other-shared-id', 2, 'shared-assistant', 'assistant', 'dnsmasq other call')`,
            )
            .run();
        recordMessageFtsRowid(db, "ses-other-shared-id", 2, otherAssistant.lastInsertRowid, now);
        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES ('ses-other-shared-id', 'opencode', '/repo/project', ?)`,
        ).run(now - 1000);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "must-not-run.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-current-shared-id",
                "/repo/project",
                "dnsmasq",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["shared-id", "shared-assistant"],
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(
                results.some(
                    (result) =>
                        result.source === "message" &&
                        result.sessionId === "ses-other-shared-id" &&
                        result.messageId === "shared-id",
                ),
            ).toBe(true);
            expect(
                results.some(
                    (result) =>
                        result.source === "message" &&
                        result.sessionId === "ses-other-shared-id" &&
                        result.messageId === "shared-assistant",
                ),
            ).toBe(true);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps earlier user evidence when the current real user has no FTS row", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        insertLiveMessage(db, "ses-image-current", "dnsmasq earlier user", now, "user", 2);
        // The stable host id is deliberately absent from FTS.
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-image-current",
                "/repo/project",
                "dnsmasq",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["current-no-fts"],
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results).toEqual([]);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("runs wiki when a no-FTS current user has no earlier evidence", async () => {
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "dnsmasq.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-image-only-current",
                "/repo/project",
                "dnsmasq",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["current-no-fts"],
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("blocks on an earlier lexical row when the host id is unavailable", async () => {
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        insertLiveMessage(db, "ses-no-raw-reader", "dnsmasq earlier user", now, "user", 2);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-no-raw-reader",
                "/repo/project",
                "dnsmasq",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 1,
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results).toEqual([]);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("lets semantic-only git candidates fall through to wiki without dropping them", async () => {
        const sha = "1".repeat(40);
        insertLiveMessage(
            db,
            "ses-git-semantic",
            "Tailscale current prompt",
            Date.parse("2026-01-15T00:00:00.000Z"),
            "user",
            2,
        );
        upsertCommits(db, "/repo/project", [
            {
                sha,
                shortSha: "semantic",
                message: "unrelated networking cleanup",
                author: null,
                committedAtMs: 1_767_225_600_000,
            },
        ]);
        saveCommitEmbedding(db, sha, new Float32Array([1, 0]), "mock-model");
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "tailscale.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-git-semantic",
                "/repo/project",
                "Tailscale",
                {
                    memoryEnabled: false,
                    embeddingEnabled: true,
                    embedQuery: async () => new Float32Array([1, 0]),
                    isEmbeddingRuntimeEnabled: () => true,
                    embeddingModelIdOverride: "mock-model",
                    chunkModelIdOverride: "off",
                    gitCommitsEnabled: true,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    maxMessageOrdinal: 1,
                    currentQueryMessageIds: ["live-2"],
                    measurementDisabled: true,
                    countRetrievals: false,
                },
            );
            expect(
                results.some(
                    (result) => result.source === "git_commit" && result.matchType === "semantic",
                ),
            ).toBe(true);
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps fts and hybrid git candidates authoritative for the wiki gate", async () => {
        const ftsSha = "2".repeat(40);
        const hybridSha = "3".repeat(40);
        upsertCommits(db, "/repo/project", [
            {
                sha: ftsSha,
                shortSha: "fts",
                message: "Tailscale lexical configuration",
                author: null,
                committedAtMs: 1_767_225_600_000,
            },
            {
                sha: hybridSha,
                shortSha: "hybrid",
                message: "Tailscale hybrid configuration",
                author: null,
                committedAtMs: 1_767_225_600_001,
            },
        ]);
        saveCommitEmbedding(db, hybridSha, new Float32Array([1, 0]), "mock-model");
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-git-lexical",
                "/repo/project",
                "Tailscale",
                {
                    memoryEnabled: false,
                    embeddingEnabled: true,
                    embedQuery: async () => new Float32Array([1, 0]),
                    isEmbeddingRuntimeEnabled: () => true,
                    embeddingModelIdOverride: "mock-model",
                    chunkModelIdOverride: "off",
                    gitCommitsEnabled: true,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    measurementDisabled: true,
                    countRetrievals: false,
                },
            );
            const matchTypes = results.flatMap((result) =>
                result.source === "git_commit" ? [result.matchType] : [],
            );
            expect(matchTypes.sort()).toEqual(["fts", "hybrid"]);
            expect(results.some((result) => result.source === "wiki")).toBe(false);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("captures older lexical git evidence before newer semantic ties consume the limit", async () => {
        const olderSha = "a".repeat(40);
        const semanticShas = Array.from({ length: 10 }, (_, index) =>
            (index + 1).toString(16).padStart(40, "0"),
        );
        upsertCommits(db, "/repo/project", [
            {
                sha: olderSha,
                shortSha: "older-ft",
                message: "Tailscale lexical evidence",
                author: null,
                committedAtMs: 1_767_225_600_000,
            },
            ...semanticShas.map((sha, index) => ({
                sha,
                shortSha: `semantic-${index}`,
                message: `unrelated semantic change ${index}`,
                author: null,
                committedAtMs: 1_767_225_600_001 + index,
            })),
        ]);
        for (const sha of semanticShas) {
            saveCommitEmbedding(db, sha, new Float32Array([1, 0]), "mock-model");
        }
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-git-pre-limit",
                "/repo/project",
                "Tailscale",
                {
                    // Final limit 1 leaves the internal git lane limit at 10.
                    limit: 1,
                    memoryEnabled: false,
                    embeddingEnabled: true,
                    embedQuery: async () => new Float32Array([1, 0]),
                    isEmbeddingRuntimeEnabled: () => true,
                    embeddingModelIdOverride: "mock-model",
                    chunkModelIdOverride: "off",
                    gitCommitsEnabled: true,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    measurementDisabled: true,
                    countRetrievals: false,
                },
            );
            expect(results).toHaveLength(1);
            expect(
                results.every(
                    (result) => result.source === "git_commit" && result.matchType === "semantic",
                ),
            ).toBe(true);
            expect(
                results.some((result) => result.source === "git_commit" && result.sha === olderSha),
            ).toBe(false);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps a suppressed live-message count out of the gate", async () => {
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "fallback.md", line: 1 })],
            partial: false,
        });
        try {
            // The lane's live-tail diagnostic is display-only: the gate reads a raw
            // lexical row that exists in the index, never a reported count.
            const results = await unifiedSearch(
                db,
                "ses-live-gate",
                "/repo/project",
                "live message needle",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    searchMessageHistory: async (request) => {
                        expect(request.collectDiagnostics).toBe(false);
                        return { results: [], suppressedLiveMessageMatches: 2 };
                    },
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("skips the strict existence probe when the wiki source is off or unselected", async () => {
        const sessionId = "ses-gate-probe";
        const now = Date.parse("2026-01-15T00:00:00.000Z");
        insertLiveMessage(db, sessionId, "dnsmasq gate probe", now, "user", 2);
        const prepare = db.prepare.bind(db);
        const sql: string[] = [];
        const spy = spyOn(db, "prepare").mockImplementation((query: string) => {
            sql.push(query);
            return prepare(query);
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [],
            partial: false,
        });
        // The gate probe is the only statement introduced for the gate itself.
        const probeCount = (): number =>
            sql.filter((query) => query.includes("SELECT 1 AS hit")).length;
        try {
            // Wiki disabled: the fallback can never run, so its probe must not run.
            sql.length = 0;
            await unifiedSearch(db, sessionId, "/repo/project", "dnsmasq", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_DISABLED,
                wikiFallback: true,
                explicitSearch: true,
                maxMessageOrdinal: 1,
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(probeCount()).toBe(0);
            expect(wiki).not.toHaveBeenCalled();

            // Wiki enabled but outside the selected sources: same.
            sql.length = 0;
            await unifiedSearch(db, sessionId, "/repo/project", "dnsmasq", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                sources: ["message"],
                maxMessageOrdinal: 1,
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(probeCount()).toBe(0);
            expect(wiki).not.toHaveBeenCalled();

            // Enabled and selected: one bounded probe, whose only matching row is
            // the current prompt, so the gate stays open.
            sql.length = 0;
            await unifiedSearch(db, sessionId, "/repo/project", "dnsmasq", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                maxMessageOrdinal: 1,
                currentQueryMessageIds: ["live-2"],
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(probeCount()).toBe(1);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
            wiki.mockRestore();
        }
    });

    it("blocks on a strict probe or full-query row the date filter keeps", async () => {
        const from = Date.parse("2026-01-01T00:00:00.000Z");
        const to = Date.parse("2026-01-31T23:59:59.999Z");
        const within = Date.parse("2026-01-15T00:00:00.000Z");
        // Live-tail rows matched only by a literal probe ("ctx-status").
        insertLiveMessage(db, "ses-probe-live", "alpha ctx-status", within);
        // A live-tail row matched by the full AND query inside the date range.
        insertLiveMessage(db, "ses-strict-live", "alpha beta", within);
        // The same full AND hit, but outside the caller's date range.
        insertLiveMessage(db, "ses-date-live", "alpha beta", from - 1);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "date-fallback.md", line: 1 })],
            partial: false,
        });
        const options = {
            memoryEnabled: false,
            embeddingEnabled: false,
            wiki: WIKI_ENABLED,
            wikiFallback: true,
            explicitSearch: true,
            maxMessageOrdinal: 1,
            from,
            to,
            countRetrievals: false,
            measurementDisabled: true,
        } as const;
        try {
            // The gate reads raw lexical existence: the row above the cutoff still
            // closes it, and the lane's own results stay limited as before.
            expect(
                await unifiedSearch(db, "ses-strict-live", "/repo/project", "alpha beta", options),
            ).toEqual([]);
            expect(
                await unifiedSearch(
                    db,
                    "ses-probe-live",
                    "/repo/project",
                    "alpha beta ctx-status",
                    options,
                ),
            ).toEqual([]);
            expect(wiki).not.toHaveBeenCalled();

            const outsideDateRange = await unifiedSearch(
                db,
                "ses-date-live",
                "/repo/project",
                "alpha beta",
                options,
            );
            expect(outsideDateRange.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("lets relaxed-only live hits fall through to wiki while relaxed recall stays ordinary", async () => {
        const within = Date.parse("2026-01-15T00:00:00.000Z");
        // Visible history: a relaxed-OR-only row the agent must still receive.
        insertLiveMessage(db, "ses-relaxed-live", "alpha only", within, "assistant", 3);
        // Many more relaxed-only rows in the live tail, above the cutoff.
        for (let ordinal = 6; ordinal <= 20; ordinal += 1) {
            insertLiveMessage(db, "ses-relaxed-live", "alpha only", within, "assistant", ordinal);
        }
        const diagnostics = createUnifiedSearchDiagnostics();
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "dns.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-relaxed-live",
                "/repo/project",
                "alpha beta",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    maxMessageOrdinal: 5,
                    currentQueryMessageIds: ["live-20"],
                    diagnostics,
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            // Ordinary relaxed recall is untouched: the visible row still returns.
            expect(
                results.some(
                    (result) => result.source === "message" && result.messageOrdinal === 3,
                ),
            ).toBe(true);
            // The relaxed live tail is no gate evidence: wiki runs.
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
            // The displayed diagnostic still counts the relaxed live tail.
            expect(diagnostics.suppressedLiveMessageMatches).toBe(15);
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps the wiki fallback in the final result at limit one", async () => {
        const sessionId = "ses-wiki-representation";
        const within = Date.parse("2026-01-15T00:00:00.000Z");
        // Relaxed-only row: it outranks the neutral wiki hit, so a plain limit
        // slice would evict the fallback result the search just paid for.
        insertLiveMessage(db, sessionId, "alpha only", within);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "representation.md", line: 1, snippet: "best fallback section" })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, sessionId, "/repo/project", "alpha beta", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                limit: 1,
                maxMessageOrdinal: 5,
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(results).toHaveLength(1);
            expect(results[0]?.source).toBe("wiki");
            const material = buildTransientMaterial({
                db,
                sessionId,
                query: "alpha beta",
                results,
                budgetTokens: 1000,
            });
            expect(material?.text).toContain("representation.md");

            // The ordinary non-wiki path keeps its own ranking untouched.
            const plain = await unifiedSearch(db, sessionId, "/repo/project", "alpha beta", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_DISABLED,
                wikiFallback: false,
                explicitSearch: true,
                limit: 1,
                maxMessageOrdinal: 5,
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(plain).toHaveLength(1);
            expect(plain[0]?.source).toBe("message");
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps the fallback representation through the rerank path", async () => {
        const sessionId = "ses-wiki-representation-rerank";
        insertLiveMessage(db, sessionId, "alpha only", Date.parse("2026-01-15T00:00:00.000Z"));
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "rerank-representation.md", line: 3 })],
            partial: false,
        });
        try {
            // A failing hosted reranker returns the pre-rerank baseline, which the
            // plain limit slice already emptied of the fallback hit.
            const results = await unifiedSearch(
                db,
                sessionId,
                "/repo/project",
                "alpha beta gamma delta",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    limit: 1,
                    maxMessageOrdinal: 5,
                    rerankConfig: {
                        provider: "remote",
                        endpoint: "not-a-url",
                        model: "mock",
                        timeout_ms: 1500,
                        top_n: 20,
                    },
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results).toHaveLength(1);
            expect(results[0]?.source).toBe("wiki");
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("leads the fallback material with the wiki section under a small budget", async () => {
        const sessionId = "ses-wiki-material-order";
        const within = Date.parse("2026-01-15T00:00:00.000Z");
        // A long relaxed-only row: it outranks the neutral wiki hit and its body
        // would eat the whole material budget if it came first.
        insertLiveMessage(
            db,
            sessionId,
            `alpha only ${"padding ".repeat(120)}MESSAGE-TAIL-MARKER`,
            within,
        );
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [
                hit({ path: "material-order.md", line: 5, snippet: "WIKI-SECTION-BODY-MARKER" }),
            ],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, sessionId, "/repo/project", "alpha beta", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                limit: 2,
                maxMessageOrdinal: 5,
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(results.map((result) => result.source)).toEqual(["wiki", "message"]);
            // Enough for both headers plus the short section body, far short of the
            // 300-character message body. Only the section may spend that budget.
            const material = buildTransientMaterial({
                db,
                sessionId,
                query: "alpha beta",
                results,
                budgetTokens: 80,
            });
            expect(material?.text.split("\n")[0]).toContain("[wiki]");
            expect(material?.text).toContain("WIKI-SECTION-BODY-MARKER");
            expect(material?.text).not.toContain("MESSAGE-TAIL-MARKER");
        } finally {
            wiki.mockRestore();
        }
    });

    it("lets a semantic-only history compartment fall through to wiki", async () => {
        const sessionId = "ses-wiki-semantic-compartment";
        const projectPath = "/repo/compartment-wiki";
        seedCompartmentSession(db, sessionId, projectPath);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "queueing.md", line: 1 })],
            partial: false,
        });
        try {
            // No message row matches lexically; only the compartment's vector does.
            const results = await unifiedSearch(db, sessionId, projectPath, "hydraulic flow", {
                memoryEnabled: false,
                embeddingEnabled: true,
                embedQuery: embedChunkQuery,
                isEmbeddingRuntimeEnabled: () => true,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                maxMessageOrdinal: 2,
                currentQueryMessageIds: ["u1", "a2"],
                countRetrievals: false,
                measurementDisabled: true,
            });
            expect(
                results.some(
                    (result) => result.source === "compartment" && result.matchType === "semantic",
                ),
            ).toBe(true);
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps a strict message inside its history compartment authoritative", async () => {
        const sessionId = "ses-wiki-hybrid-compartment";
        const projectPath = "/repo/compartment-wiki";
        seedCompartmentSession(db, sessionId, projectPath);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "must-not-run.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, sessionId, projectPath, "bounded drains", {
                memoryEnabled: false,
                embeddingEnabled: true,
                embedQuery: embedChunkQuery,
                isEmbeddingRuntimeEnabled: () => true,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
                explicitSearch: true,
                maxMessageOrdinal: 2,
                countRetrievals: false,
                measurementDisabled: true,
            });
            // The strict message merges into its compartment and still closes the gate.
            expect(
                results.some(
                    (result) => result.source === "compartment" && result.matchType === "hybrid",
                ),
            ).toBe(true);
            expect(results.some((result) => result.source === "wiki")).toBe(false);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("blocks on a valid same-project row behind a full page of pre-migration hits", async () => {
        const movedAt = Date.parse("2026-02-01T00:00:00.000Z");
        const movedSession = "ses-pre-move";
        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?, 'opencode', '/repo/project', ?)`,
        ).run(movedSession, movedAt);
        // More pre-move rows than the lane fetches for limit 1 (tierLimit = 10),
        // and they rank ahead of the valid row: they fill the page that the
        // ownership filter then empties.
        for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
            insertLiveMessage(db, movedSession, "alpha beta", movedAt - 1, "user", ordinal);
        }
        // One valid row, matching the same query but longer, so bm25 ranks it
        // behind the whole pre-move page the lane fetches.
        insertLiveMessage(
            db,
            "ses-move-target",
            "alpha beta and a trailing description long enough to lose the length score",
            movedAt - 2,
            "assistant",
            13,
        );
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "must-not-run.md", line: 1 })],
            partial: false,
        });
        const options = {
            memoryEnabled: false,
            embeddingEnabled: false,
            wiki: WIKI_ENABLED,
            wikiFallback: true,
            explicitSearch: true,
            limit: 1,
            countRetrievals: false,
            measurementDisabled: true,
        } as const;
        try {
            const results = await unifiedSearch(
                db,
                "ses-move-target",
                "/repo/project",
                "alpha beta",
                options,
            );
            // The valid row exists in the index even though pre-migration rows
            // own the lane's whole returned page.
            expect(results.some((result) => result.source === "wiki")).toBe(false);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("declines pre-migration strict rows and relaxed noise, keeping wiki open", async () => {
        const movedAt = Date.parse("2026-02-01T00:00:00.000Z");
        const movedSession = "ses-pre-move-only";
        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?, 'opencode', '/repo/project', ?)`,
        ).run(movedSession, movedAt);
        for (let ordinal = 1; ordinal <= 12; ordinal += 1) {
            insertLiveMessage(db, movedSession, "alpha beta", movedAt - 1, "user", ordinal);
        }
        // Relaxed-only row in the current session: the OR fills the lane, the
        // strict AND matches nothing that belongs to this project.
        insertLiveMessage(db, "ses-move-target-only", "alpha only", movedAt, "assistant", 2);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "pre-move-fallback.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-move-target-only",
                "/repo/project",
                "alpha beta",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    explicitSearch: true,
                    limit: 1,
                    countRetrievals: false,
                    measurementDisabled: true,
                },
            );
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("does not let a foreign pre-migration row or a relaxed live hit suppress wiki", async () => {
        const movedAt = Date.parse("2026-02-01T00:00:00.000Z");
        insertLiveMessage(db, "ses-current-migration", "alpha only", movedAt);
        const foreign = db
            .prepare(
                `INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content)
                 VALUES ('ses-foreign-migration', 1, 'foreign-old', 'user', 'alpha beta')`,
            )
            .run();
        recordMessageFtsRowid(db, "ses-foreign-migration", 1, foreign.lastInsertRowid, movedAt - 1);
        db.prepare(
            `INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES ('ses-foreign-migration', 'opencode', '/repo/project', ?)`,
        ).run(movedAt);
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "domains.md", line: 1 })],
            partial: false,
        });
        const options = {
            memoryEnabled: false,
            embeddingEnabled: false,
            wiki: WIKI_ENABLED,
            wikiFallback: true,
            explicitSearch: true,
            maxMessageOrdinal: 1,
            countRetrievals: false,
            measurementDisabled: true,
        } as const;
        try {
            const results = await unifiedSearch(
                db,
                "ses-current-migration",
                "/repo/project",
                "alpha beta",
                options,
            );
            // The only strict-looking row belongs to the foreign session's previous
            // project, and the current session only has a relaxed live row: neither
            // is gate evidence, and the ownership filter keeps the foreign hit out.
            expect(results.some((result) => result.source === "wiki")).toBe(true);
            expect(wiki).toHaveBeenCalledTimes(1);
            expect(
                results.some(
                    (result) =>
                        result.source === "message" && result.sessionId === "ses-foreign-migration",
                ),
            ).toBe(false);

            // A strict live hit in the current session still closes the gate.
            insertLiveMessage(db, "ses-current-migration", "alpha beta", movedAt, "assistant", 3);
            const blocked = await unifiedSearch(
                db,
                "ses-current-migration",
                "/repo/project",
                "alpha beta",
                options,
            );
            expect(blocked).toEqual([]);
            expect(wiki).toHaveBeenCalledTimes(1);
        } finally {
            wiki.mockRestore();
        }
    });

    it("keeps memory gate-only hits out of the limit while retaining a note", async () => {
        insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "gate limit needle memory",
        });
        addNote(db, "session", {
            sessionId: "ses-memory-limit",
            content: "gate limit needle note",
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-memory-limit",
                "/repo/project",
                "gate limit needle",
                {
                    memoryEnabled: true,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    memoryGateOnly: true,
                    limit: 1,
                    measurementDisabled: true,
                    countRetrievals: false,
                },
            );
            expect(results).toHaveLength(1);
            expect(results[0]?.source).toBe("note");
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("lets a note hit close the internal gate", async () => {
        addNote(db, "session", {
            sessionId: "ses-note-gate",
            content: "historian note gate needle",
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(
                db,
                "ses-note-gate",
                "/repo/project",
                "historian note gate",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                },
            );
            expect(results.some((result) => result.source === "note")).toBe(true);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });

    it("reads at most three distinct sections after a complete internal miss", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-search-wiki-sections-"));
        writeFileSync(
            join(root, "guide.md"),
            [
                "# One",
                "intro",
                "historian first",
                "historian duplicate",
                "# Two",
                "historian second",
                "# Three",
                "historian third",
                "# Four",
                "historian beyond cap",
            ].join("\n"),
        );
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [3, 4, 6, 8, 10].map((line) => hit({ path: "guide.md", line })),
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-sections", "/repo/project", "historian", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: { enabled: true, source_root: root },
                wikiFallback: true,
            });
            const hits = results.filter((result) => result.source === "wiki");
            expect(hits).toHaveLength(3);
            expect(hits.map((result) => result.heading)).toEqual(["One", "Two", "Three"]);
            expect(hits[0]).toMatchObject({
                line: 3,
                sectionStartLine: 1,
                sectionEndLine: 4,
            });
            expect(hits[0]?.snippet).toContain("historian duplicate");
            expect(results.some((result) => result.source === "wiki" && result.line === 10)).toBe(
                false,
            );
            expect(formatSearchResults("historian", hits, "ses-sections")).toContain(
                "path=guide.md:1-4 heading=One",
            );
        } finally {
            wiki.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("deduplicates the bounded page before the limit and keeps all sections for rerank", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-search-wiki-page-dedup-"));
        writeFileSync(
            join(root, "guide.md"),
            ["# One", "needle", "## Two", "needle", "## Three", "needle"].join("\n"),
        );
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [
                ...Array.from({ length: 10 }, () => hit({ path: "guide.md", line: 2 })),
                hit({ path: "guide.md", line: 4 }),
                hit({ path: "guide.md", line: 6 }),
            ],
            partial: false,
        });
        let lanes: SearchLanes | undefined;
        try {
            const results = await unifiedSearch(db, "ses-page-dedup", "/repo/project", "needle", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: { enabled: true, source_root: root },
                wikiFallback: true,
                limit: 2,
                captureRerankLanes: (captured) => {
                    lanes = captured;
                },
                measurementDisabled: true,
            });
            expect(results.map((result) => result.source === "wiki" && result.heading)).toEqual([
                "One",
                "Two",
            ]);
            expect(lanes?.wiki.map((result) => result.heading)).toEqual(["One", "Two", "Three"]);
        } finally {
            wiki.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("uses the original-line byte column for a truncated multibyte FFF fragment", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-search-wiki-truncated-line-"));
        const needle = "Needle🚀";
        const prefix = "前文🙂".repeat(6000);
        const fullLine = `${prefix}${needle}`;
        writeFileSync(join(root, "guide.md"), ["# Long", fullLine, "# Next", "outside"].join("\n"));
        const lineContent = fullLine.slice(-40);
        const fragmentMatch = lineContent.indexOf(needle);
        const fragmentByteStart = Buffer.byteLength(lineContent.slice(0, fragmentMatch), "utf8");
        const matchByteColumn = Buffer.byteLength(prefix, "utf8");
        const matchByteLength = Buffer.byteLength(needle, "utf8");
        const fff: WikiFffModule = {
            FileFinder: {
                create() {
                    return {
                        ok: true,
                        value: {
                            multiGrep() {
                                return {
                                    ok: true,
                                    value: {
                                        items: [
                                            {
                                                relativePath: "guide.md",
                                                lineNumber: 2,
                                                lineContent,
                                                col: matchByteColumn,
                                                matchRanges: [
                                                    [
                                                        fragmentByteStart,
                                                        fragmentByteStart + matchByteLength,
                                                    ],
                                                ],
                                                modified: 1_767_225_600,
                                            },
                                        ],
                                        totalMatched: 1,
                                        nextCursor: null,
                                    },
                                };
                            },
                            async waitForScan() {
                                return { ok: true, value: true };
                            },
                            destroy() {},
                        },
                    };
                },
            },
        };
        wikiSearchModule.__setWikiFffModuleForTests(fff);
        try {
            const results = await unifiedSearch(db, "ses-truncated-line", "/repo/project", needle, {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: { enabled: true, source_root: root },
                wikiFallback: true,
                measurementDisabled: true,
                countRetrievals: false,
            });
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                source: "wiki",
                heading: "Long",
                matchText: needle,
            });
            expect(results[0]?.source === "wiki" && results[0].snippet).toContain(needle);
            expect(
                results[0]?.source === "wiki" && Array.from(results[0].snippet).length,
            ).toBeLessThanOrEqual(16_000);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps a truncated long-line term in explicit output and material", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-search-wiki-long-line-"));
        const question = "why is bandwidth estimated before the free-tier question?";
        const marker = "line-start-marker";
        const line = `${marker} ${"a ".repeat(9000)}bandwidth`;
        writeFileSync(join(root, "long-line.md"), ["# Long line", line].join("\n"));
        try {
            // Explicit/classic lane: no section is injected, the result count is
            // the caller's limit, and ordinary hits still need no file read.
            const results = await unifiedSearch(db, "ses-long-line", "/repo/project", question, {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: { enabled: true, source_root: root },
                sources: ["wiki"],
                measurementDisabled: true,
                countRetrievals: false,
            });
            expect(results).toHaveLength(1);
            const wiki = results[0]!;
            expect(wiki).toMatchObject({ source: "wiki", path: "long-line.md", line: 2 });
            if (wiki.source !== "wiki") throw new Error("expected a wiki hit");
            expect(wiki.content).toContain("bandwidth");
            expect(wiki.content).not.toContain(marker);
            expect(wiki.snippet).toContain("bandwidth");
            expect(wiki.snippet).not.toContain(marker);
            expect(wiki.matchText).toBe("bandwidth");
            expect(wiki.heading).toBeUndefined();
            expect(wiki.sectionStartLine).toBeUndefined();

            // A small budget fits the recovered term but never the long prefix.
            const material = buildTransientMaterial({
                db,
                sessionId: "ses-long-line",
                query: question,
                results,
                budgetTokens: 100,
            });
            expect(material?.included).toBe(1);
            expect(material?.text).toContain("bandwidth");
            expect(material?.text).not.toContain(marker);
            expect(material?.wikiSections).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the native snippet on read failure without marking the corpus unavailable", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-search-wiki-missing-"));
        const snippet = `original native snippet ${"details ".repeat(50)}`.trim();
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [
                hit({
                    path: "missing.md",
                    line: 7,
                    snippet,
                    preview: "native preview",
                }),
            ],
            partial: false,
        });
        try {
            const diagnostics = createUnifiedSearchDiagnostics();
            const query = "昨天 historian";
            const results = await unifiedSearch(db, "ses-missing", "/repo/project", query, {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: { enabled: true, source_root: root },
                wikiFallback: true,
                diagnostics,
            });
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                source: "wiki",
                snippet,
                content: "native preview",
            });
            expect(results[0]?.source === "wiki" && results[0].sectionStartLine).toBeUndefined();
            expect(diagnostics.wikiUnavailable).toBeNull();

            const sectionOnly = buildTransientMaterial({
                db,
                sessionId: "ses-missing",
                query,
                results,
                budgetTokens: 1000,
                prioritizeWikiFallback: true,
            })!;
            const budget = estimateTokens(sectionOnly.text) + 1 + 2;
            const semanticGit: UnifiedSearchResult = {
                source: "git_commit",
                content: "semantic commit preview",
                score: 1,
                sha: "missing-fallback-semantic-commit",
                shortSha: "semantic",
                author: null,
                committedAtMs: 1767225600000,
                matchType: "semantic",
            };
            const materialArgs = {
                db,
                sessionId: "ses-missing",
                query,
                results: [...results, semanticGit],
                budgetTokens: budget,
            };
            const material = buildTransientMaterial({
                ...materialArgs,
                prioritizeWikiFallback: true,
            })!;
            expect(material.text).toContain("original native snippet");
            expect(material.text).not.toContain("[git_commit]");
            expect(material.wikiSections).toEqual([]);
            expect(estimateTokens(material.text) + 1).toBeLessThanOrEqual(budget);
            expect(buildTransientMaterial(materialArgs)!.text).toContain("[git_commit]");
        } finally {
            wiki.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("preserves direct behavior when fallback is not requested", async () => {
        insertMemory(db, {
            projectPath: "/repo/project",
            category: "RESEARCH",
            content: "historian internal memory",
        });
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "direct.md", line: 9 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-direct", "/repo/project", "historian", {
                memoryEnabled: true,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
            });
            expect(wiki).toHaveBeenCalledTimes(1);
            const hitResult = results.find((result) => result.source === "wiki");
            expect(hitResult?.source === "wiki" && hitResult.sectionStartLine).toBeUndefined();
        } finally {
            wiki.mockRestore();
        }
    });

    it("reports a real fallback scan failure without confusing it with a gate skip", async () => {
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockRejectedValue(
            new WikiSearchError("scan_timeout", "bounded native scan timed out"),
        );
        try {
            const diagnostics = createUnifiedSearchDiagnostics();
            const results = await unifiedSearch(
                db,
                "ses-scan-error",
                "/repo/project",
                "historian",
                {
                    memoryEnabled: false,
                    embeddingEnabled: false,
                    wiki: WIKI_ENABLED,
                    wikiFallback: true,
                    diagnostics,
                },
            );
            expect(results).toEqual([]);
            expect(wiki).toHaveBeenCalledTimes(1);
            expect(diagnostics.wikiUnavailable).toBe("scan_timeout");
            expect(diagnostics.wikiPartial).toBe(false);
        } finally {
            wiki.mockRestore();
        }
    });

    it("skips wiki for an ID-shaped fallback query", async () => {
        const wiki = spyOn(wikiSearchModule, "searchWikiCorpus").mockResolvedValue({
            hits: [hit({ path: "unused.md", line: 1 })],
            partial: false,
        });
        try {
            const results = await unifiedSearch(db, "ses-id", "/repo/project", "#999", {
                memoryEnabled: false,
                embeddingEnabled: false,
                wiki: WIKI_ENABLED,
                wikiFallback: true,
            });
            expect(results).toEqual([]);
            expect(wiki).not.toHaveBeenCalled();
        } finally {
            wiki.mockRestore();
        }
    });
});
