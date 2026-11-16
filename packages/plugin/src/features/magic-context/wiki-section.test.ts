/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildSectionExcerpt,
    findSectionBounds,
    resolveCorpusPath,
    resolveWikiSectionHits,
    resolveWikiSections,
    WIKI_SECTION_MAX_FILE_BYTES,
} from "./wiki-section";

const tempDirs: string[] = [];

function tempDir(prefix = "mc-wiki-section-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("wiki Markdown sections", () => {
    it("ends a section at the next peer or ancestor heading, not at a child heading", () => {
        const lines = [
            "# Top",
            "intro",
            "## Alpha",
            "alpha",
            "### Child",
            "needle",
            "## Beta",
            "beta",
        ];
        expect(findSectionBounds(lines, 6)).toEqual({
            headingLine: 3,
            headingLevel: 2,
            startLine: 3,
            endLine: 6,
        });
        expect(findSectionBounds(lines, 8)).toEqual({
            headingLine: 7,
            headingLevel: 2,
            startLine: 7,
            endLine: 8,
        });
    });

    it("ignores headings in frontmatter and backtick/tilde fences", () => {
        const lines = [
            "---",
            "# metadata",
            "---",
            "# Real",
            "```md",
            "# backtick fence",
            "```",
            "~~~",
            "# tilde fence",
            "~~~",
            "## Next",
            "body",
        ];
        expect(findSectionBounds(lines, 2)).toEqual({
            headingLine: null,
            headingLevel: null,
            startLine: 1,
            endLine: 3,
        });
        for (const matchLine of [6, 9]) {
            expect(findSectionBounds(lines, matchLine)).toEqual({
                headingLine: 4,
                headingLevel: 1,
                startLine: 4,
                endLine: 10,
            });
        }
    });

    it("uses the preamble when no heading precedes the match", () => {
        const lines = ["intro", "needle", "# Later", "body"];
        expect(findSectionBounds(lines, 2)).toEqual({
            headingLine: null,
            headingLevel: null,
            startLine: 1,
            endLine: 2,
        });
    });

    it("dedupes hits in one section and selects at most three distinct sections", async () => {
        const root = tempDir();
        writeFileSync(
            join(root, "guide.md"),
            [
                "# One",
                "needle first",
                "needle duplicate",
                "# Two",
                "needle second",
                "# Three",
                "needle third",
                "# Four",
                "needle beyond cap",
            ].join("\n"),
        );
        const requests = [
            { path: "guide.md", line: 2 },
            { path: "guide.md", line: 3 },
            { path: "guide.md", line: 5 },
            { path: "guide.md", line: 7 },
            { path: "guide.md", line: 9 },
        ];
        const resolutions = await resolveWikiSectionHits({ root, requests, maxSections: 3 });
        expect(resolutions.map((resolution) => resolution.status)).toEqual([
            "selected",
            "duplicate",
            "selected",
            "selected",
            "skipped",
        ]);
        const sections = await resolveWikiSections({ root, requests, maxSections: 3 });
        expect(sections.map((section) => section.heading)).toEqual(["One", "Two", "Three"]);
        expect(sections[0]).toMatchObject({ startLine: 1, endLine: 3, firstLine: 2 });
        expect(sections[0]?.excerpt).toContain("needle first");
        expect(sections[0]?.excerpt).toContain("needle duplicate");
    });

    it("keeps section content beyond the old 700-character excerpt limit", () => {
        const lines = ["# Long", `${"before ".repeat(150)}needle${" after".repeat(175)}`];
        const bounds = findSectionBounds(lines, 2);
        const excerpt = buildSectionExcerpt(lines, bounds, 2);
        expect(excerpt).toBe(lines.join("\n"));
        expect(excerpt.length).toBeGreaterThan(700);
        expect(excerpt).toContain("needle");

        const capped = buildSectionExcerpt(lines, bounds, 2, 120);
        expect(Array.from(capped).length).toBeLessThanOrEqual(120);
        expect(capped.startsWith("# Long\n…\n")).toBe(true);
        expect(capped).toContain("needle");
    });

    it("clips long single-line sections around native matches at either end", () => {
        const needle = "Needle";
        const filler = "x".repeat(20_000);
        for (const line of [`${needle}${filler}`, `${filler}${needle}`]) {
            const lines = ["# Long", line];
            const start = line.indexOf(needle);
            const excerpt = buildSectionExcerpt(lines, findSectionBounds(lines, 2), 2, 16_000, {
                start,
                end: start + needle.length,
            });
            expect(excerpt).toContain(needle);
            expect(Array.from(excerpt).length).toBeLessThanOrEqual(16_000);
        }
    });

    it("rejects an unverified fallback column and anchors the searched term", async () => {
        const root = tempDir();
        const term = "bandwidth";
        const decoy = "line-start-noise";
        const line = `${decoy} ${"a ".repeat(9000)}${term}`;
        writeFileSync(join(root, "long-line.md"), ["# Long", line].join("\n"));
        const [resolution] = await resolveWikiSectionHits({
            root,
            requests: [
                {
                    path: "long-line.md",
                    line: 2,
                    // A truncated fragment's column: it decodes to the decoy, not to a term.
                    matchByteColumn: 0,
                    matchByteLength: Buffer.byteLength(decoy, "utf8"),
                    matchText: term,
                    matchTerms: [term],
                },
            ],
            maxSections: 1,
        });
        expect(resolution?.status).toBe("selected");
        const excerpt = resolution?.section?.excerpt ?? "";
        expect(excerpt).toContain(term);
        expect(excerpt).not.toContain(decoy);
    });

    it("trusts a fallback column that decodes to a searched term", async () => {
        const root = tempDir();
        const term = "bandwidth";
        const decoy = "line-start-noise";
        const prefix = `${decoy} ${"a ".repeat(9000)}`;
        const line = `${prefix}${term}`;
        writeFileSync(join(root, "long-line.md"), ["# Long", line].join("\n"));
        const [resolution] = await resolveWikiSectionHits({
            root,
            requests: [
                {
                    path: "long-line.md",
                    line: 2,
                    matchByteColumn: Buffer.byteLength(prefix, "utf8"),
                    matchByteLength: Buffer.byteLength(term, "utf8"),
                    matchText: term,
                    matchTerms: [term],
                },
            ],
            maxSections: 1,
        });
        expect(resolution?.status).toBe("selected");
        const excerpt = resolution?.section?.excerpt ?? "";
        expect(excerpt).toContain(term);
        expect(excerpt).not.toContain(decoy);
    });

    it("rejects absolute paths, traversal and symlink escapes", async () => {
        const root = tempDir();
        const outside = tempDir("mc-wiki-outside-");
        const outsideFile = join(outside, "secret.md");
        writeFileSync(outsideFile, "# Secret\nneedle");
        symlinkSync(outsideFile, join(root, "escape.md"));

        expect(resolveCorpusPath(root, "../secret.md")).toBeNull();
        expect(resolveCorpusPath(root, outsideFile)).toBeNull();
        const resolutions = await resolveWikiSectionHits({
            root,
            requests: [
                { path: "../secret.md", line: 2 },
                { path: outsideFile, line: 2 },
                { path: "escape.md", line: 2 },
            ],
            maxSections: 3,
        });
        expect(resolutions.every((resolution) => resolution.status === "selected")).toBe(true);
        expect(resolutions.every((resolution) => resolution.section === null)).toBe(true);
    });

    it("degrades missing, oversized and out-of-range reads without throwing", async () => {
        const root = tempDir();
        writeFileSync(join(root, "large.md"), "x".repeat(WIKI_SECTION_MAX_FILE_BYTES + 1));
        writeFileSync(join(root, "short.md"), "# Short\nbody");
        const sections = await resolveWikiSections({
            root,
            requests: [
                { path: "missing.md", line: 1 },
                { path: "large.md", line: 1 },
                { path: "short.md", line: 99 },
            ],
            maxSections: 3,
        });
        expect(sections).toEqual([]);
    });

    it("honors an already aborted signal before reading", async () => {
        const root = tempDir();
        writeFileSync(join(root, "guide.md"), "# Guide\nneedle");
        const controller = new AbortController();
        controller.abort();
        await expect(
            resolveWikiSectionHits({
                root,
                requests: [{ path: "guide.md", line: 2 }],
                maxSections: 3,
                signal: controller.signal,
            }),
        ).rejects.toThrow();
    });
});
