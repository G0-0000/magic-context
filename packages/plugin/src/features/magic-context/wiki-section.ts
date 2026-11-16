import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { byteOffsetToCodePointIndex, type WikiMatchRange } from "./wiki-search";

/** A native wiki match that may be expanded to its enclosing Markdown section. */
export interface WikiSectionRequest {
    path: string;
    /** 1-based matched line. */
    line: number;
    /** Native byte column in the original full line and the match's byte length. */
    matchByteColumn?: number;
    matchByteLength?: number;
    /** Matched text; on a fallback hit it is a term verified in the displayed line. */
    matchText?: string;
    /**
     * Fallback hits only: the bounded searched-term set, so a truncated native
     * fragment can be re-anchored on the full original line.
     */
    matchTerms?: readonly string[];
}

export interface WikiSectionBounds {
    headingLine: number | null;
    headingLevel: number | null;
    /** 1-based, inclusive. */
    startLine: number;
    /** 1-based, inclusive. */
    endLine: number;
}

export interface WikiSection {
    path: string;
    heading: string | null;
    headingLevel: number | null;
    startLine: number;
    endLine: number;
    /** Section text, bounded around the matched line only when the safety cap requires it. */
    excerpt: string;
}

export interface ResolvedWikiSection extends WikiSection {
    /** First native match line that selected this section. */
    firstLine: number;
}

export interface WikiSectionHitResolution {
    request: WikiSectionRequest;
    /** Selected hits become one material line; duplicates and hits beyond the cap are omitted. */
    status: "selected" | "duplicate" | "skipped";
    /** Null on a selected read/parse failure: the caller must reuse the original snippet. */
    section: ResolvedWikiSection | null;
    /**
     * Full-line recovery of the actual anchor, present whenever the bounded read
     * could place one — for every examined request, duplicates included, so a
     * caller can re-anchor a native fragment that the SDK truncated.
     */
    recovery?: WikiSectionRecovery;
}

/** The actual matched span recovered from the full original line. */
export interface WikiSectionRecovery {
    /** Matched text as it appears in the file, not the possibly truncated fragment. */
    matchText: string;
    /** Single-line preview centered on the recovered range, capped at 220 characters. */
    matchPreview: string;
    /** Snippet centered on the recovered range, capped at 700 characters. */
    matchSnippet: string;
}

export const WIKI_SECTION_MAX_FILE_BYTES = 512 * 1024;
export const WIKI_SECTION_MAX_CHARS = 16_000;
/** Recovered preview cap, the same single-line rule search.ts applies to `content`. */
const RECOVERED_PREVIEW_CHARS = 220;
/** Recovered snippet cap, matching the native snippet cap. */
const RECOVERED_SNIPPET_CHARS = 700;
const FRONTMATTER_MAX_LINES = 40;

interface MarkdownHeading {
    line: number;
    level: number;
    text: string;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new Error("wiki section extraction aborted by caller");
}

function pathIsInside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve a native relative path without allowing absolute paths or lexical traversal. */
export function resolveCorpusPath(root: string, relativePath: string): string | null {
    if (
        relativePath.length === 0 ||
        relativePath.includes("\0") ||
        isAbsolute(relativePath) ||
        win32.isAbsolute(relativePath)
    ) {
        return null;
    }
    const absoluteRoot = resolve(root);
    const candidate = resolve(absoluteRoot, relativePath);
    return pathIsInside(absoluteRoot, candidate) && candidate !== absoluteRoot ? candidate : null;
}

function frontmatterContentStart(lines: readonly string[]): number {
    const first = lines[0]?.replace(/^\uFEFF/, "");
    if (first !== "---") return 0;
    const end = Math.min(lines.length, FRONTMATTER_MAX_LINES);
    for (let index = 1; index < end; index++) {
        if (lines[index]?.trim() === "---") return index + 1;
    }
    return 0;
}

function headingAt(line: string): { level: number; text: string } | null {
    const match = /^\s{0,3}(#{1,6})[\t ]+(.*)$/.exec(line);
    if (!match) return null;
    return {
        level: match[1]!.length,
        text: (match[2] ?? "").replace(/[\t ]+#+[\t ]*$/, "").trim(),
    };
}

function markdownHeadings(lines: readonly string[]): MarkdownHeading[] {
    const headings: MarkdownHeading[] = [];
    let fence: { char: "`" | "~"; length: number } | null = null;
    for (let index = frontmatterContentStart(lines); index < lines.length; index++) {
        const line = lines[index]!;
        if (fence) {
            const closing = /^\s{0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
            if (closing && closing[0] === fence.char && closing.length >= fence.length) {
                fence = null;
            }
            continue;
        }
        const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (opening) {
            fence = { char: opening[0] as "`" | "~", length: opening.length };
            continue;
        }
        const heading = headingAt(line);
        if (heading) headings.push({ line: index + 1, ...heading });
    }
    return headings;
}

/** Find the ATX-heading section containing a 1-based line, ignoring fences and YAML frontmatter. */
export function findSectionBounds(lines: readonly string[], matchLine: number): WikiSectionBounds {
    if (!Number.isInteger(matchLine) || matchLine < 1 || matchLine > lines.length) {
        throw new RangeError("wiki match line is outside the readable file prefix");
    }
    const allHeadings = markdownHeadings(lines);
    // With H2 sections, H1 is the document/title boundary and H3+ stays inside
    // its enclosing section. Documents using only deeper headings retain the
    // original nearest-heading hierarchy instead of becoming one large preamble.
    const hasH2Sections = allHeadings.some((heading) => heading.level === 2);
    const headings = hasH2Sections
        ? allHeadings.filter((heading) => heading.level <= 2)
        : allHeadings;
    let owning: MarkdownHeading | null = null;
    for (const heading of headings) {
        if (heading.line > matchLine) break;
        owning = heading;
    }
    if (!owning) {
        const firstHeading = headings[0];
        return {
            headingLine: null,
            headingLevel: null,
            startLine: 1,
            endLine: firstHeading ? firstHeading.line - 1 : lines.length,
        };
    }
    const nextPeer = headings.find(
        (heading) => heading.line > matchLine && (hasH2Sections || heading.level <= owning.level),
    );
    return {
        headingLine: owning.line,
        headingLevel: owning.level,
        startLine: owning.line,
        endLine: nextPeer ? nextPeer.line - 1 : lines.length,
    };
}

function pointCount(text: string): number {
    return Array.from(text).length;
}

function clipAroundRange(
    text: string,
    rangeStart: number,
    rangeEnd: number,
    maxChars: number,
): string {
    const points = Array.from(text);
    if (points.length <= maxChars) return text;
    if (maxChars <= 0) return "";
    if (maxChars === 1) return "…";
    const contentLimit = Math.max(1, maxChars - 2);
    const safeStart = Math.max(0, Math.min(points.length, rangeStart));
    const safeEnd = Math.max(safeStart, Math.min(points.length, rangeEnd));
    const rangeLength = safeEnd - safeStart;
    let start =
        rangeLength >= contentLimit
            ? safeStart + Math.floor(rangeLength / 2) - Math.floor(contentLimit / 2)
            : safeStart - Math.floor((contentLimit - rangeLength) / 2);
    start = Math.max(0, Math.min(points.length - contentLimit, start));
    const end = Math.min(points.length, start + contentLimit);
    return `${start > 0 ? "…" : ""}${points.slice(start, end).join("")}${end < points.length ? "…" : ""}`;
}

function matchOffsets(
    lines: readonly string[],
    relativeMatchIndex: number,
    matchRange?: WikiMatchRange,
): [number, number] {
    let lineStart = 0;
    for (let index = 0; index < relativeMatchIndex; index++) {
        lineStart += pointCount(lines[index] ?? "") + 1;
    }
    const lineLength = pointCount(lines[relativeMatchIndex] ?? "");
    const start = Math.max(0, Math.min(lineLength, matchRange?.start ?? 0));
    const end = Math.max(start, Math.min(lineLength, matchRange?.end ?? lineLength));
    return [lineStart + start, lineStart + end];
}

/** The carried match text plus every searched term, as one candidate set. */
function anchorCandidates(request: WikiSectionRequest): string[] {
    const candidates = new Set<string>();
    if (request.matchText) candidates.add(request.matchText);
    for (const term of request.matchTerms ?? []) {
        if (term.length > 0) candidates.add(term);
    }
    return [...candidates];
}

function isAcceptedAnchor(text: string, request: WikiSectionRequest): boolean {
    const value = text.toLowerCase();
    return anchorCandidates(request).some((candidate) => candidate.toLowerCase() === value);
}

/**
 * The carried native byte span: trusted as-is for an exact hit, but for a
 * fallback hit only when it decodes to an accepted anchor, because a truncated
 * native fragment can report a column (often 0) that points at the fragment
 * start instead of at the term the line actually matched.
 */
function verifiedNativeSpan(line: string, request: WikiSectionRequest): WikiMatchRange | undefined {
    const column = request.matchByteColumn;
    const length = request.matchByteLength;
    if (typeof column !== "number" || !Number.isInteger(column) || column < 0) return undefined;
    if (typeof length !== "number" || !Number.isInteger(length) || length <= 0) return undefined;
    const start = byteOffsetToCodePointIndex(line, column);
    const end = byteOffsetToCodePointIndex(line, column + length);
    if (end <= start) return undefined;
    if (request.matchTerms?.length) {
        const points = Array.from(line);
        const text = points.slice(start, end).join("");
        if (!isAcceptedAnchor(text, request)) return undefined;
    }
    return { start, end };
}

/**
 * The earliest full-line occurrence of a searched term or the carried match text
 * (case-insensitive, longest on a tie): the verified anchor a truncated native
 * fragment failed to report.
 */
function searchedAnchorRange(
    line: string,
    request: WikiSectionRequest,
): WikiMatchRange | undefined {
    const lowerLine = line.toLowerCase();
    let best: { index: number; length: number } | null = null;
    for (const candidate of anchorCandidates(request)) {
        const index = lowerLine.indexOf(candidate.toLowerCase());
        if (index < 0) continue;
        if (
            !best ||
            index < best.index ||
            (index === best.index && candidate.length > best.length)
        ) {
            best = { index, length: candidate.length };
        }
    }
    if (!best) return undefined;
    return {
        start: pointCount(line.slice(0, best.index)),
        end: pointCount(line.slice(0, best.index + best.length)),
    };
}

function fullLineMatchRange(line: string, request: WikiSectionRequest): WikiMatchRange | undefined {
    const verified = verifiedNativeSpan(line, request);
    if (verified) return verified;
    if (request.matchTerms?.length) {
        const searched = searchedAnchorRange(line, request);
        if (searched) return searched;
    }
    if (request.matchText) {
        const index = line.indexOf(request.matchText);
        if (index >= 0) {
            return {
                start: pointCount(line.slice(0, index)),
                end: pointCount(line.slice(0, index + request.matchText.length)),
            };
        }
    }
    return undefined;
}

/**
 * Return the complete section whenever it fits the fixed safety cap. For a very
 * large section, retain its heading and a window containing the matched line;
 * the downstream transient token budget performs the final, usually smaller,
 * allocation around the actual query anchor.
 */
export function buildSectionExcerpt(
    lines: readonly string[],
    bounds: WikiSectionBounds,
    matchLine: number,
    maxChars = WIKI_SECTION_MAX_CHARS,
    matchRange?: WikiMatchRange,
): string {
    const sectionLines = lines.slice(bounds.startLine - 1, bounds.endLine);
    const full = sectionLines.join("\n");
    if (pointCount(full) <= maxChars) return full;
    const relativeMatch = matchLine - bounds.startLine;
    const headingLine = bounds.headingLine;
    if (headingLine !== null && matchLine !== headingLine) {
        const heading = lines[headingLine - 1] ?? "";
        const prefix = `${heading}\n…\n`;
        // Tiny test/degraded budgets keep the match window rather than pinning
        // a heading that would consume nearly the whole excerpt.
        if (pointCount(prefix) < Math.floor(maxChars / 2)) {
            const bodyStartLine = headingLine + 1;
            const bodyLines = lines.slice(bodyStartLine - 1, bounds.endLine);
            const [start, end] = matchOffsets(bodyLines, matchLine - bodyStartLine, matchRange);
            return `${prefix}${clipAroundRange(
                bodyLines.join("\n"),
                start,
                end,
                maxChars - pointCount(prefix),
            )}`;
        }
    }
    const [start, end] = matchOffsets(sectionLines, relativeMatch, matchRange);
    return clipAroundRange(full, start, end, maxChars);
}

async function readBoundedLines(
    root: string,
    candidate: string,
    signal: AbortSignal | undefined,
): Promise<readonly string[] | null> {
    throwIfAborted(signal);
    try {
        // Lexical containment is not enough for a symlink inside the corpus.
        const [actualRoot, actualCandidate] = await Promise.all([
            realpath(root),
            realpath(candidate),
        ]);
        if (!pathIsInside(actualRoot, actualCandidate)) return null;
        const handle = await open(actualCandidate, "r");
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > WIKI_SECTION_MAX_FILE_BYTES) return null;
            const buffer = Buffer.alloc(WIKI_SECTION_MAX_FILE_BYTES + 1);
            let offset = 0;
            while (offset <= WIKI_SECTION_MAX_FILE_BYTES) {
                const { bytesRead } = await handle.read(
                    buffer,
                    offset,
                    WIKI_SECTION_MAX_FILE_BYTES + 1 - offset,
                    offset,
                );
                if (bytesRead === 0) break;
                offset += bytesRead;
            }
            if (offset > WIKI_SECTION_MAX_FILE_BYTES) return null;
            throwIfAborted(signal);
            return buffer
                .subarray(0, offset)
                .toString("utf8")
                .split(/\r\n?|\n/);
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

/**
 * Recover the actual anchor of one request from its full original line: the
 * verified range (a native span accepted for this request, else the searched
 * term or carried match text located on the full line) plus a preview and a
 * snippet centered on it. Undefined when the line carries no anchor.
 */
function recoverFullLineMatch(
    lines: readonly string[],
    request: WikiSectionRequest,
): WikiSectionRecovery | undefined {
    if (!Number.isInteger(request.line) || request.line < 1 || request.line > lines.length) {
        return undefined;
    }
    const line = lines[request.line - 1] ?? "";
    const range = fullLineMatchRange(line, request);
    if (!range) return undefined;
    const points = Array.from(line);
    const text = points.slice(range.start, range.end).join("");
    if (text.length === 0) return undefined;
    return {
        matchText: text,
        matchPreview: clipAroundRange(line, range.start, range.end, RECOVERED_PREVIEW_CHARS)
            .replace(/\s+/g, " ")
            .trim(),
        matchSnippet: clipAroundRange(line, range.start, range.end, RECOVERED_SNIPPET_CHARS),
    };
}

/**
 * Resolve hits in rank order. At most maxSections selected lines are produced;
 * hits in an already selected section are duplicates. A file/line read failure
 * selects a null section so the search lane can retain its original snippet
 * without reporting that the corpus itself is unavailable.
 */
export async function resolveWikiSectionHits(args: {
    root: string;
    requests: readonly WikiSectionRequest[];
    maxSections: number;
    signal?: AbortSignal;
}): Promise<WikiSectionHitResolution[]> {
    const limit = Math.max(0, Math.floor(args.maxSections));
    const fileCache = new Map<string, readonly string[] | null>();
    const selectedSectionKeys = new Set<string>();
    const selectedFallbackKeys = new Set<string>();
    const resolutions: WikiSectionHitResolution[] = [];
    let selected = 0;
    // Every examined request carries its recovery, duplicates included, so a
    // caller can re-anchor a truncated native fragment even when its section
    // was already selected by an earlier hit.
    let recovery: WikiSectionRecovery | undefined;
    const push = (resolution: WikiSectionHitResolution): void => {
        resolutions.push(recovery ? { ...resolution, recovery } : resolution);
    };

    for (const request of args.requests) {
        throwIfAborted(args.signal);
        recovery = undefined;
        const candidate = resolveCorpusPath(args.root, request.path);
        const cacheKey = candidate ?? `invalid:${request.path}`;
        const cached = fileCache.get(cacheKey);
        if (selected >= limit && cached === undefined) {
            push({ request, status: "skipped", section: null });
            continue;
        }

        let lines = cached;
        if (lines === undefined) {
            lines =
                candidate && Number.isInteger(request.line) && request.line >= 1
                    ? await readBoundedLines(args.root, candidate, args.signal)
                    : null;
            fileCache.set(cacheKey, lines);
        }
        recovery = lines ? recoverFullLineMatch(lines, request) : undefined;
        let bounds: WikiSectionBounds | null = null;
        if (lines) {
            try {
                bounds = findSectionBounds(lines, request.line);
            } catch {
                bounds = null;
            }
        }
        if (!candidate || !lines || !bounds) {
            const fallbackKey = `${cacheKey}:${request.line}`;
            if (selectedFallbackKeys.has(fallbackKey)) {
                push({ request, status: "duplicate", section: null });
            } else if (selected >= limit) {
                push({ request, status: "skipped", section: null });
            } else {
                selectedFallbackKeys.add(fallbackKey);
                selected++;
                push({ request, status: "selected", section: null });
            }
            continue;
        }

        const sectionKey = `${cacheKey}:${bounds.startLine}`;
        if (selectedSectionKeys.has(sectionKey)) {
            push({ request, status: "duplicate", section: null });
            continue;
        }
        if (selected >= limit) {
            push({ request, status: "skipped", section: null });
            continue;
        }
        selectedSectionKeys.add(sectionKey);
        selected++;
        const heading =
            bounds.headingLine === null
                ? null
                : (headingAt(lines[bounds.headingLine - 1]!)?.text ?? null);
        // matchRanges from FFF belong to a possibly truncated fragment. Only
        // the original-line byte column may anchor the full file line here.
        const matchRange = fullLineMatchRange(lines[request.line - 1] ?? "", request);
        push({
            request,
            status: "selected",
            section: {
                path: request.path,
                heading,
                headingLevel: bounds.headingLevel,
                startLine: bounds.startLine,
                endLine: bounds.endLine,
                excerpt: buildSectionExcerpt(
                    lines,
                    bounds,
                    request.line,
                    WIKI_SECTION_MAX_CHARS,
                    matchRange,
                ),
                firstLine: request.line,
            },
        });
    }
    throwIfAborted(args.signal);
    return resolutions;
}

/** Unique, successfully read sections; useful to callers that do not need snippet fallback states. */
export async function resolveWikiSections(args: {
    root: string;
    requests: readonly WikiSectionRequest[];
    maxSections: number;
    signal?: AbortSignal;
}): Promise<ResolvedWikiSection[]> {
    const resolutions = await resolveWikiSectionHits(args);
    return resolutions.flatMap((resolution) =>
        resolution.status === "selected" && resolution.section ? [resolution.section] : [],
    );
}
