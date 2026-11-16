/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __resetWikiFinderForTests,
    __setWikiFffModuleForTests,
    ensureWikiFinder,
    searchWikiCorpus,
    type WikiCorpusHit,
    type WikiFffFinder,
    type WikiFffGrepResult,
    type WikiFffModule,
    type WikiFffMultiGrepOptions,
    type WikiFffResult,
    WikiSearchError,
} from "./wiki-search";
import { resolveWikiSectionHits } from "./wiki-section";

interface FakeOptions {
    createError?: string;
    scan?: WikiFffResult<boolean>;
    /**
     * One result replayed for every call, one per call (later calls get an empty
     * page), or a builder that sees the call's own options — the only way a fake
     * can fabricate a match for a pattern the caller really searched.
     */
    grep?:
        | WikiFffResult<WikiFffGrepResult>
        | Array<WikiFffResult<WikiFffGrepResult>>
        | ((options: WikiFffMultiGrepOptions, call: number) => WikiFffResult<WikiFffGrepResult>);
}

function emptyGrep(): WikiFffResult<WikiFffGrepResult> {
    return { ok: true, value: { items: [], totalMatched: 0, nextCursor: null } };
}

interface FakeHarness {
    module: WikiFffModule;
    creates: number;
    destroys: number;
    greps: unknown[];
    createsOptions: unknown[];
}

/** Builds an FFF-shaped fake so the adapter can be tested without the native SDK. */
function fakeFff(options: FakeOptions = {}): FakeHarness {
    const harness: FakeHarness = {
        creates: 0,
        destroys: 0,
        greps: [],
        createsOptions: [],
        module: undefined as unknown as WikiFffModule,
    };
    const finder: WikiFffFinder = {
        multiGrep(callOptions) {
            const call = harness.greps.length;
            harness.greps.push(callOptions);
            if (typeof options.grep === "function") return options.grep(callOptions, call);
            if (Array.isArray(options.grep)) return options.grep[call] ?? emptyGrep();
            return options.grep ?? emptyGrep();
        },
        async waitForScan() {
            return options.scan ?? { ok: true, value: true };
        },
        destroy() {
            harness.destroys++;
        },
    };
    harness.module = {
        FileFinder: {
            create(createOptions) {
                harness.creates++;
                harness.createsOptions.push(createOptions);
                if (options.createError !== undefined) {
                    return { ok: false, error: options.createError };
                }
                return { ok: true, value: finder };
            },
        },
    };
    return harness;
}

const MATCH = {
    relativePath: "guides/architecture.md",
    lineNumber: 12,
    lineContent: "###   The historian  lease   ",
    contextBefore: ["lead line"],
    contextAfter: ["body line"],
    modified: 1_767_225_600,
};

afterEach(() => {
    __resetWikiFinderForTests();
});

describe("wiki corpus adapter", () => {
    it("searches one literal pattern constrained to Markdown with a bounded native budget", async () => {
        const harness = fakeFff({
            grep: {
                ok: true,
                value: { items: [MATCH], totalMatched: 1, nextCursor: null },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const { hits }: { hits: WikiCorpusHit[] } = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "historian lease",
        });

        expect(harness.creates).toBe(1);
        expect(harness.createsOptions[0]).toEqual({ basePath: "/tmp/global-wiki", aiMode: true });
        expect(harness.greps[0]).toEqual({
            // The raw query is ONE literal pattern: natural language is never
            // parsed as grep constraint syntax.
            patterns: ["historian lease"],
            constraints: "*.{md,markdown}",
            maxMatchesPerFile: 20,
            pageSize: 50,
            smartCase: true,
            cursor: null,
            beforeContext: 1,
            afterContext: 1,
            timeBudgetMs: 2_000,
            enforceTimeBudget: true,
        });
        expect(hits).toHaveLength(1);
        const first = hits[0];
        expect(first).toBeDefined();
        expect(first?.path).toBe("guides/architecture.md");
        expect(first?.line).toBe(12);
        expect(first?.modifiedAtMs).toBe(1_767_225_600_000);
        expect(first?.snippet).toBe("lead line\n###   The historian  lease   \nbody line");
        expect(first?.preview).toBe("### The historian lease");
    });

    it("caps the page at 50 native matches and the preview at 220 characters", async () => {
        const harness = fakeFff({
            grep: {
                ok: true,
                value: {
                    items: [
                        { ...MATCH, lineContent: "x".repeat(400) },
                        ...Array.from({ length: 60 }, (_value, index) => ({
                            ...MATCH,
                            relativePath: `f${index}.md`,
                            lineNumber: index + 1,
                        })),
                    ],
                    totalMatched: 61,
                    nextCursor: null,
                },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const { hits } = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "x",
        });

        expect((harness.greps[0] as { pageSize: number }).pageSize).toBe(50);
        expect(hits).toHaveLength(50);
        const points = Array.from(hits[0]?.preview ?? "");
        expect(points).toHaveLength(220);
        expect(hits[0]?.preview.endsWith("…")).toBe(true);
    });

    it("keeps the matched line ahead of an oversized context line", async () => {
        const harness = fakeFff({
            grep: {
                ok: true,
                value: {
                    items: [
                        {
                            ...MATCH,
                            lineContent: "The actual matched line",
                            contextBefore: ["before ".repeat(150)],
                            contextAfter: ["after context"],
                        },
                    ],
                    totalMatched: 1,
                    nextCursor: null,
                },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const { hits } = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "matched line",
        });

        const snippet = hits[0]?.snippet ?? "";
        expect(snippet).toContain("The actual matched line");
        expect(snippet).toContain("before ".repeat(80));
        expect(snippet.endsWith("\nafter context")).toBe(true);
        expect(Array.from(snippet).length).toBe(700);
    });

    it("centers long matched lines around FFF byte match ranges", async () => {
        const query = "MATCH-RANGE-HIT";
        const prefix = "before ".repeat(180);
        const lineContent = `${prefix}${query}${" after".repeat(100)}`;
        const startByte = Buffer.byteLength(prefix, "utf8");
        const harness = fakeFff({
            grep: {
                ok: true,
                value: {
                    items: [
                        {
                            ...MATCH,
                            lineContent,
                            col: startByte,
                            matchRanges: [
                                [startByte, startByte + Buffer.byteLength(query, "utf8")],
                            ],
                        },
                    ],
                    totalMatched: 1,
                    nextCursor: null,
                },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const { hits } = await searchWikiCorpus({ root: "/tmp/global-wiki", query });

        expect(Array.from(hits[0]?.snippet ?? "").length).toBeLessThanOrEqual(700);
        expect(hits[0]?.snippet).toContain(query);
        expect(hits[0]?.preview).toContain(query);
        expect(hits[0]?.matchRange).toEqual({
            start: Array.from(prefix).length,
            end: Array.from(prefix).length + Array.from(query).length,
        });
        expect(hits[0]?.matchText).toBe(query);
        expect(hits[0]?.matchByteColumn).toBe(startByte);
        expect(hits[0]?.matchByteLength).toBe(Buffer.byteLength(query, "utf8"));
    });

    it("centers multibyte snippets without splitting Unicode or losing the hit", async () => {
        const query = "命中🚀";
        const prefix = "前文🙂".repeat(180);
        const lineContent = `${prefix}${query}${"后文🙂".repeat(100)}`;
        const startByte = Buffer.byteLength(prefix, "utf8");
        const harness = fakeFff({
            grep: {
                ok: true,
                value: {
                    items: [
                        {
                            ...MATCH,
                            lineContent,
                            col: startByte,
                            matchRanges: [
                                [startByte, startByte + Buffer.byteLength(query, "utf8")],
                            ],
                        },
                    ],
                    totalMatched: 1,
                    nextCursor: null,
                },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const { hits } = await searchWikiCorpus({ root: "/tmp/global-wiki", query });
        const snippet = hits[0]?.snippet ?? "";

        expect(snippet).toContain(query);
        expect(hits[0]?.preview).toContain(query);
        expect(snippet).not.toContain("�");
        expect(Array.from(snippet).length).toBeLessThanOrEqual(700);
    });

    it("returns a bounded partial page instead of failing when the native budget stops the scan", async () => {
        const harness = fakeFff({
            grep: {
                ok: true,
                value: { items: [MATCH], totalMatched: 1, nextCursor: "cursor-1" },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "historian",
        });
        expect(page.hits).toHaveLength(1);
        expect(page.partial).toBe(true);
    });

    it("preserves partial-page status when the native cursor accompanies an empty page", async () => {
        const harness = fakeFff({
            grep: {
                ok: true,
                value: { items: [], totalMatched: 0, nextCursor: "cursor-1" },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({ root: "/tmp/global-wiki", query: "missing" });

        expect(page.hits).toEqual([]);
        expect(page.partial).toBe(true);
    });

    it("does not treat a multiline query as OR patterns in a real temporary corpus", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-fff-wiki-multiline-"));
        writeFileSync(join(root, "alpha-only.md"), "alpha appears on this page\n", "utf8");
        writeFileSync(join(root, "beta-only.md"), "beta appears on this page\n", "utf8");
        const originalFiles = readdirSync(root).sort();
        try {
            const alpha = await searchWikiCorpus({ root, query: "alpha" });
            const beta = await searchWikiCorpus({ root, query: "beta" });
            const multiline = await searchWikiCorpus({ root, query: "alpha\nbeta" });

            expect(alpha.hits.map((hit) => hit.path)).toEqual(["alpha-only.md"]);
            expect(beta.hits.map((hit) => hit.path)).toEqual(["beta-only.md"]);
            expect(multiline.hits).toEqual([]);
            expect(multiline.partial).toBe(false);
            expect(readdirSync(root).sort()).toEqual(originalFiles);
            expect(readFileSync(join(root, "alpha-only.md"), "utf8")).toBe(
                "alpha appears on this page\n",
            );
            expect(readFileSync(join(root, "beta-only.md"), "utf8")).toBe(
                "beta appears on this page\n",
            );
        } finally {
            __resetWikiFinderForTests();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("marks a real file at the per-file match cap as potentially incomplete", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-fff-wiki-file-cap-"));
        const path = join(root, "many-matches.md");
        writeFileSync(
            path,
            Array.from({ length: 25 }, (_, index) => `needle match ${index}`).join("\n"),
            "utf8",
        );
        try {
            const page = await searchWikiCorpus({ root, query: "needle" });
            expect(page.hits.filter((hit) => hit.path === "many-matches.md")).toHaveLength(20);
            expect(page.partial).toBe(true);
        } finally {
            __resetWikiFinderForTests();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("shares one create-and-scan across concurrent callers", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);

        const [first, second] = await Promise.all([
            ensureWikiFinder("/tmp/global-wiki"),
            ensureWikiFinder("/tmp/global-wiki"),
        ]);

        expect(harness.creates).toBe(1);
        expect(first).toBe(second);
    });

    it("retries creation after a failed attempt instead of caching the rejection", async () => {
        const failing = fakeFff({ createError: "no native binary for this platform" });
        __setWikiFffModuleForTests(failing.module);

        await expect(ensureWikiFinder("/tmp/global-wiki")).rejects.toMatchObject({
            name: "WikiSearchError",
            reason: "create_failed",
        });

        const healthy = fakeFff();
        __setWikiFffModuleForTests(healthy.module);
        await expect(ensureWikiFinder("/tmp/global-wiki")).resolves.toBeDefined();
        expect(healthy.creates).toBe(1);
    });

    it("destroys the instance and reports a fixed reason when the initial scan does not finish", async () => {
        const harness = fakeFff({ scan: { ok: true, value: false } });
        __setWikiFffModuleForTests(harness.module);

        const error = await ensureWikiFinder("/tmp/global-wiki").catch((cause) => cause);
        expect(error).toBeInstanceOf(WikiSearchError);
        expect(error).toMatchObject({ reason: "scan_timeout" });
        expect(harness.destroys).toBe(1);
    });

    it("refuses a second root while a finder is live (one process-global corpus)", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);
        await ensureWikiFinder("/tmp/global-wiki");

        await expect(ensureWikiFinder("/tmp/other-corpus")).rejects.toMatchObject({
            reason: "root_conflict",
        });
        expect(harness.creates).toBe(1);
    });

    it("rejects a non-absolute root before touching the native SDK", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);

        await expect(ensureWikiFinder("relative/wiki")).rejects.toMatchObject({
            reason: "root_invalid",
        });
        expect(harness.creates).toBe(0);
    });

    it("surfaces a native grep failure as grep_failed", async () => {
        const harness = fakeFff({ grep: { ok: false, error: "pattern is invalid" } });
        __setWikiFffModuleForTests(harness.module);

        const error = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "historian",
        }).catch((cause) => cause);
        expect(error).toBeInstanceOf(WikiSearchError);
        expect(error).toMatchObject({ reason: "grep_failed" });
    });

    it("never touches the SDK for a blank query or an already-aborted caller", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);

        expect(await searchWikiCorpus({ root: "/tmp/global-wiki", query: "   " })).toEqual({
            hits: [],
            partial: false,
        });
        expect(harness.creates).toBe(0);
        for (const query of ["alpha\nbeta", "alpha\r", "\nalpha"]) {
            expect(await searchWikiCorpus({ root: "/tmp/global-wiki", query })).toEqual({
                hits: [],
                partial: false,
            });
        }
        expect(harness.creates).toBe(0);

        const controller = new AbortController();
        controller.abort();
        const aborted = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "historian",
            signal: controller.signal,
        }).catch((cause) => cause);
        expect(aborted).toBeInstanceOf(WikiSearchError);
        expect(aborted).toMatchObject({ reason: "aborted" });
        expect(harness.creates).toBe(0);
    });

    it("keeps the exact query pass authoritative and never re-ranks its hits", async () => {
        const harness = fakeFff({
            grep: {
                ok: true,
                value: {
                    items: [
                        { ...MATCH, relativePath: "first.md", lineNumber: 1 },
                        { ...MATCH, relativePath: "second.md", lineNumber: 2 },
                        { ...MATCH, relativePath: "third.md", lineNumber: 3 },
                    ],
                    totalMatched: 3,
                    nextCursor: null,
                },
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({ root: "/tmp/global-wiki", query: "historian lease" });

        expect(harness.greps).toHaveLength(1);
        const exactCall = harness.greps[0] as WikiFffMultiGrepOptions;
        expect(exactCall.patterns).toEqual(["historian lease"]);
        expect(page.hits.map((hit) => hit.path)).toEqual(["first.md", "second.md", "third.md"]);
        expect(page.partial).toBe(false);
    });

    it("retries a zero-result question once with bounded literal terms anchored on the matched term", async () => {
        const question = "为什么评估远程访问方案时，要先按真实工作负载估算带宽，再谈免费与否？";
        const prefix = "前文".repeat(220);
        const startByte = Buffer.byteLength(prefix, "utf8");
        // The native fragment must anchor one pattern THIS call was given: FFF
        // cannot report a match for a term it never searched, so the fake
        // derives the term from the fallback call's own pattern set.
        let term = "";
        const harness = fakeFff({
            grep: (callOptions, call) => {
                if (call === 0) return emptyGrep();
                term = callOptions.patterns[0] ?? "";
                const lineContent = `${prefix}${term}${"后文".repeat(120)}`;
                return {
                    ok: true,
                    value: {
                        items: [
                            {
                                ...MATCH,
                                relativePath: "remote-access.md",
                                lineNumber: 4,
                                lineContent,
                                col: startByte,
                                matchRanges: [
                                    [startByte, startByte + Buffer.byteLength(term, "utf8")],
                                ],
                            },
                        ],
                        totalMatched: 1,
                        nextCursor: "cursor-1",
                    },
                };
            },
        });
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({ root: "/tmp/global-wiki", query: question });

        expect(harness.greps).toHaveLength(2);
        const exactCall = harness.greps[0] as WikiFffMultiGrepOptions;
        const fallbackCall = harness.greps[1] as WikiFffMultiGrepOptions;
        expect(exactCall.patterns).toEqual([question]);
        expect(fallbackCall.patterns.length).toBeGreaterThan(0);
        expect(fallbackCall.patterns.length).toBeLessThanOrEqual(6);
        expect(fallbackCall.patterns).not.toContain(question);
        for (const fallbackTerm of fallbackCall.patterns) {
            expect(question.includes(fallbackTerm)).toBe(true);
        }
        // Same Markdown constraint and native bounds as the exact pass.
        expect({ ...fallbackCall, patterns: [] }).toEqual({ ...exactCall, patterns: [] });
        expect(page.partial).toBe(true);

        const hit = page.hits[0];
        expect(hit?.preview.startsWith("…")).toBe(true);
        expect(hit?.preview).toContain(term);
        expect(hit?.preview).not.toContain("为什么");
        expect(hit?.snippet).toContain(term);
        expect(hit?.matchText).toBe(term);
        expect(hit?.matchByteColumn).toBe(startByte);
        expect(hit?.matchByteLength).toBe(Buffer.byteLength(term, "utf8"));
        expect(hit?.matchRange).toEqual({
            start: Array.from(prefix).length,
            end: Array.from(prefix).length + Array.from(term).length,
        });
    });

    it("ranks fallback hits by how many question terms they carry and keeps native order among equals", async () => {
        const question = "为什么评估远程访问方案时，要先按真实工作负载估算带宽，再谈免费与否？";
        const targetLine = "评估远程访问方案时，先按真实工作负载估算带宽，再谈免费与否。";
        const noiseLine = "带宽是常见指标。";
        const harness = fakeFff({
            grep: [
                emptyGrep(),
                {
                    ok: true,
                    value: {
                        items: [
                            {
                                ...MATCH,
                                relativePath: "noise-a.md",
                                lineNumber: 2,
                                lineContent: noiseLine,
                            },
                            {
                                ...MATCH,
                                relativePath: "noise-b.md",
                                lineNumber: 2,
                                lineContent: noiseLine,
                            },
                            {
                                ...MATCH,
                                relativePath: "target.md",
                                lineNumber: 3,
                                lineContent: targetLine,
                            },
                        ],
                        totalMatched: 3,
                        nextCursor: null,
                    },
                },
            ],
        });
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({ root: "/tmp/global-wiki", query: question });

        expect(page.hits.map((hit) => hit.path)).toEqual(["target.md", "noise-a.md", "noise-b.md"]);
    });

    it("returns nothing when only generic question words remain", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({
            root: "/tmp/global-wiki",
            query: "why how 什么 为什么 如何 怎么",
        });

        expect(harness.greps).toHaveLength(1);
        expect(page.hits).toEqual([]);
        expect(page.partial).toBe(false);
    });

    it("never splits a one-term query into characters or n-grams", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);

        const page = await searchWikiCorpus({ root: "/tmp/global-wiki", query: "花生壳" });

        expect(harness.greps).toHaveLength(1);
        const exactCall = harness.greps[0] as WikiFffMultiGrepOptions;
        expect(exactCall.patterns).toEqual(["花生壳"]);
        expect(page.hits).toEqual([]);
    });

    it("keeps the term retry for a hyphenated identifier after an exact miss", async () => {
        const harness = fakeFff();
        __setWikiFffModuleForTests(harness.module);

        const query = "ctx-search";
        const page = await searchWikiCorpus({ root: "/tmp/global-wiki", query });

        expect(harness.greps).toHaveLength(2);
        const fallbackCall = harness.greps[1] as WikiFffMultiGrepOptions;
        expect(fallbackCall.patterns.length).toBeGreaterThan(0);
        expect(fallbackCall.patterns.length).toBeLessThanOrEqual(6);
        for (const fallbackTerm of fallbackCall.patterns) {
            expect(query.includes(fallbackTerm)).toBe(true);
        }
        expect(page.hits).toEqual([]);
    });

    it("re-anchors a truncated long-line fallback hit on the real term", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-fff-wiki-long-line-"));
        const question = "why is bandwidth estimated before the free-tier question?";
        const term = "bandwidth";
        const marker = "line-start-marker";
        const line = `${marker} ${"a ".repeat(9000)}${term}`;
        writeFileSync(join(root, "long-line.md"), ["# Long line", line].join("\n"), "utf8");
        try {
            const finder = await ensureWikiFinder(root);
            const exact = finder.multiGrep({
                patterns: [question],
                constraints: "*.{md,markdown}",
            });
            expect(exact.ok).toBe(true);
            expect(exact.ok ? exact.value.items : []).toEqual([]);

            const page = await searchWikiCorpus({ root, query: question });
            expect(page.hits.length).toBeGreaterThan(0);
            const hit = page.hits[0]!;
            expect(hit.path).toBe("long-line.md");
            expect(hit.line).toBe(2);
            expect(hit.matchTerms).toContain(term);
            // Raw FFF mapping never reads a file: the displayed line is possibly
            // truncated, so no verified anchor is fabricated here.

            const [resolution] = await resolveWikiSectionHits({
                root,
                requests: [
                    {
                        path: hit.path,
                        line: hit.line,
                        matchByteColumn: hit.matchByteColumn,
                        matchByteLength: hit.matchByteLength,
                        matchText: hit.matchText,
                        matchTerms: hit.matchTerms,
                    },
                ],
                maxSections: 1,
            });
            expect(resolution?.status).toBe("selected");
            // The bounded full-line read in the resolver is what recovers the term.
            expect(resolution?.recovery?.matchText).toBe(term);
            const excerpt = resolution?.section?.excerpt ?? "";
            expect(excerpt).toContain(term);
            expect(excerpt).not.toContain(marker);
            expect(Array.from(excerpt).length).toBeLessThanOrEqual(16_000);
        } finally {
            __resetWikiFinderForTests();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("recalls the intended section for a natural Chinese question the exact query misses", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-fff-wiki-recall-zh-"));
        const question = "为什么评估远程访问方案时，要先按真实工作负载估算带宽，再谈免费与否？";
        const targetLine = "评估远程访问方案时，先按真实工作负载估算带宽，再谈免费与否。";
        const path = "remote-access.md";
        writeFileSync(
            join(root, path),
            ["# 远景记录", "", "这里只是背景说明。", "", targetLine, "", "其他内容。"].join("\n"),
            "utf8",
        );
        try {
            const finder = await ensureWikiFinder(root);
            const exact = finder.multiGrep({
                patterns: [question],
                constraints: "*.{md,markdown}",
            });
            expect(exact.ok).toBe(true);
            expect(exact.ok ? exact.value.items : []).toEqual([]);

            const page = await searchWikiCorpus({ root, query: question });
            expect(page.hits.length).toBeGreaterThan(0);
            expect(page.hits[0]?.path).toBe(path);
            expect(page.hits[0]?.line).toBe(5);
            expect(page.hits[0]?.snippet).toContain(targetLine);
            expect(page.hits[0]?.preview).toContain("估算带宽");
        } finally {
            __resetWikiFinderForTests();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("recalls the intended section for a natural English question the exact query misses", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-fff-wiki-recall-en-"));
        const question = "why does the symlink resolver cache targets only once per scan?";
        const targetLine =
            "The resolver caches symlink targets once per scan, so a later lookup reuses the first result.";
        const path = "symlink-cache.md";
        writeFileSync(
            join(root, path),
            ["# Notes", "", targetLine, "", "Unrelated notes."].join("\n"),
            "utf8",
        );
        try {
            const finder = await ensureWikiFinder(root);
            const exact = finder.multiGrep({
                patterns: [question],
                constraints: "*.{md,markdown}",
            });
            expect(exact.ok).toBe(true);
            expect(exact.ok ? exact.value.items : []).toEqual([]);

            const page = await searchWikiCorpus({ root, query: question });
            expect(page.hits.length).toBeGreaterThan(0);
            expect(page.hits[0]?.path).toBe(path);
            expect(page.hits[0]?.line).toBe(3);
            expect(page.hits[0]?.preview).toContain("resolver caches symlink targets");
        } finally {
            __resetWikiFinderForTests();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
