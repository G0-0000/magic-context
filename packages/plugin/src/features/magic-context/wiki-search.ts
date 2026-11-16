/**
 * The `wiki` source of `ctx_search`: literal content search over one
 * user-configured, process-global, read-only Markdown corpus.
 *
 * One `FileFinder` per process, created lazily on the first enabled search —
 * a disabled or absent wiki config never loads the native SDK. The corpus
 * root comes from user-level config only (`wiki.source_root`); a project
 * identity never reaches this module, so every project searches the same
 * corpus.
 *
 * The SDK is reached through a dynamic import of its two runtime packages
 * (Bun's FFI build first when the runtime has FFI, then the Node build). The
 * specifiers stay literal so host bundlers can list them as externals; nothing
 * here imports `@ff-labs/pi-fff` or any Pi tool state.
 *
 * `multiGrep` is the search primitive: the whole query is ONE literal pattern
 * and the Markdown filter is an independent constraint, so a natural-language
 * question is never parsed as grep constraint syntax. This is literal content
 * matching, not semantic search: a query whose words never appear verbatim
 * legitimately returns nothing. A question that matches nothing and carries
 * separators gets one bounded literal retry: the word-like terms it is built
 * from are tried as OR patterns (see `recallTerms`), and fallback hits are
 * ranked by how many of those terms their path, line and native context carry.
 * A fallback hit is anchored only on a term verified to be present: FFF
 * truncates displayed lines, so its native column is never trusted on its own,
 * and the hit carries the searched terms so the section reader can re-anchor on
 * the full original line. An unbroken one-word query is never retried — it is
 * already the smallest useful pattern, and retrying it could only split a word
 * into fragments. The exact pass is never rewritten and still decides on its own
 * whenever it finds anything. The native time budget bounds each call;
 * `multiGrep` is synchronous
 * and has no `AbortSignal`, so cancellation is only checked before and after
 * the call.
 */

import { isAbsolute } from "node:path";
import { log } from "../../shared/logger";

/** How long the first scan may take before the search fails for every waiter. */
const WIKI_SCAN_TIMEOUT_MS = 15_000;
/** Native wall-clock budget of one `multiGrep`. Without it a zero-match query scans the whole corpus. */
const WIKI_GREP_TIME_BUDGET_MS = 2_000;
/** Native cap on matching lines collected from one file. */
const WIKI_MAX_MATCHES_PER_FILE = 20;
/** Native cap on matches returned in one page; the unified search clamps the final result count. */
const WIKI_GREP_PAGE_SIZE = 50;
/** Snippet cap: the matched line plus one line of context on each side. */
const WIKI_SNIPPET_CHARS = 700;
/** Preview cap, the same rule search.ts applies to every `content` field. */
const WIKI_PREVIEW_CHARS = 220;
/** Most literal terms one natural-language fallback may try. */
const WIKI_RECALL_TERM_LIMIT = 6;
/** A recall term shorter than this carries no search value ("的", "我", "a"). */
const WIKI_RECALL_MIN_CHARS = 2;

/**
 * Fixed generic question/function words, filtered from the fallback term set
 * only. Keep it language-level: a word that can name a topic (工作, 负载, 带宽,
 * historian, symlink) must never appear here.
 */
const WIKI_QUERY_STOPWORDS = new Set([
    // English question words, articles, auxiliaries, pronouns and prepositions.
    "a",
    "about",
    "after",
    "also",
    "am",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "before",
    "being",
    "between",
    "but",
    "by",
    "can",
    "could",
    "describe",
    "did",
    "do",
    "does",
    "done",
    "explain",
    "for",
    "from",
    "had",
    "has",
    "have",
    "having",
    "he",
    "her",
    "his",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "may",
    "me",
    "might",
    "must",
    "my",
    "no",
    "not",
    "of",
    "on",
    "onto",
    "or",
    "our",
    "over",
    "please",
    "shall",
    "she",
    "should",
    "so",
    "tell",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "to",
    "under",
    "us",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "whether",
    "which",
    "who",
    "whom",
    "whose",
    "why",
    "will",
    "with",
    "without",
    "would",
    "you",
    "your",
    // Chinese question words, pronouns, conjunctions and function words.
    "一下",
    "为什么",
    "为何",
    "之后",
    "之前",
    "什么",
    "如何",
    "他们",
    "她们",
    "它们",
    "但是",
    "你们",
    "关于",
    "可以",
    "与否",
    "哪些",
    "哪个",
    "哪里",
    "哪儿",
    "如果",
    "对于",
    "就是",
    "应该",
    "怎么办",
    "怎么样",
    "怎么",
    "怎样",
    "我们",
    "所以",
    "所有",
    "是否",
    "有关",
    "根据",
    "然后",
    "的话",
    "而已",
    "能否",
    "可否",
    "请问",
    "请教",
    "通过",
    "那么",
    "那些",
    "那里",
    "那个",
    "这个",
    "这些",
    "这样",
    "这里",
    "进行",
    "还是",
    "需要",
    "时候",
    "以及",
    "或者",
    "因为",
    "而且",
]) as ReadonlySet<string>;

/** Word segmentation for the fallback term set; ICU handles Chinese and English alike. */
const wikiWordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const GLOBAL_STATE_KEY = Symbol.for("@cortexkit/magic-context/wiki-fff");

/** Structural subset of the FFF SDK types this module uses. */
export type WikiFffResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface WikiFffMatch {
    relativePath: string;
    lineNumber: number;
    lineContent: string;
    /** 0-based byte column of the first match. */
    col?: number;
    /** Byte offset pairs [start, end] within lineContent for each match. */
    matchRanges?: Array<[number, number]>;
    contextBefore?: string[];
    contextAfter?: string[];
    /** Last modified timestamp in Unix seconds. */
    modified: number;
}

export interface WikiFffGrepResult {
    items: WikiFffMatch[];
    totalMatched: number;
    nextCursor: unknown;
}

export interface WikiFffMultiGrepOptions {
    patterns: string[];
    constraints?: string;
    maxMatchesPerFile?: number;
    pageSize?: number;
    smartCase?: boolean;
    cursor?: unknown;
    beforeContext?: number;
    afterContext?: number;
    timeBudgetMs?: number;
    enforceTimeBudget?: boolean;
}

export interface WikiFffFinder {
    multiGrep(options: WikiFffMultiGrepOptions): WikiFffResult<WikiFffGrepResult>;
    waitForScan(timeoutMs?: number): Promise<WikiFffResult<boolean>>;
    destroy(): void;
}

export interface WikiFffModule {
    FileFinder: {
        create(options: { basePath: string; aiMode?: boolean }): WikiFffResult<WikiFffFinder>;
    };
}

/** Internal failure reasons. `aborted` is silent and never reaches diagnostics. */
export type WikiSearchErrorReason =
    | "aborted"
    | "root_invalid"
    | "root_conflict"
    | "fff_unavailable"
    | "create_failed"
    | "scan_failed"
    | "scan_timeout"
    | "grep_failed";

/** Failure reasons a caller may surface; a fixed, locally generated token set. */
export type WikiDiagnosticReason = Exclude<WikiSearchErrorReason, "aborted"> | "search_failed";

export class WikiSearchError extends Error {
    constructor(
        readonly reason: WikiSearchErrorReason,
        message: string,
    ) {
        super(message);
        this.name = "WikiSearchError";
    }
}

/** One literal match mapped for the search lane. Scores are assigned by the caller. */
export interface WikiMatchRange {
    /** Zero-based Unicode-code-point offsets within the possibly truncated lineContent. */
    start: number;
    end: number;
}

export interface WikiCorpusHit {
    /** Path relative to the configured corpus root. */
    path: string;
    /** 1-based line number of the match. */
    line: number;
    /** Matched line with one line of context on each side, capped at 700 characters. */
    snippet: string;
    /** Single-line preview shown inside ordinary ctx_search output, capped at 220 characters. */
    preview: string;
    /** File mtime in epoch milliseconds, from the native match time (Unix seconds). */
    modifiedAtMs: number;
    /** Fragment-relative range for native snippet/preview clipping; never a full-file coordinate. */
    matchRange?: WikiMatchRange;
    /** Matched casing retained for transient-budget anchoring; on a fallback hit, a verified term. */
    matchText?: string;
    /** 0-based byte column in the ORIGINAL full line, plus the match's byte length. */
    matchByteColumn?: number;
    matchByteLength?: number;
    /** Fallback only: the bounded searched-term set, for re-anchoring on the full original line. */
    matchTerms?: readonly string[];
}

export interface WikiCorpusSearchOptions {
    /** Absolute corpus root. */
    root: string;
    query: string;
    signal?: AbortSignal;
}

export interface WikiCorpusSearchPage {
    hits: WikiCorpusHit[];
    /** Native cursor says more matches may remain beyond the bounded first page. */
    partial: boolean;
}

/** Errors never leak provider or filesystem text: only these fixed tokens do. */
export function wikiDiagnosticReason(error: unknown): WikiDiagnosticReason | null {
    if (error instanceof WikiSearchError) {
        return error.reason === "aborted" ? null : error.reason;
    }
    return "search_failed";
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new WikiSearchError("aborted", "wiki search aborted by caller");
}

function boundedChars(text: string, limit: number): string {
    const points = Array.from(text);
    if (points.length <= limit) return text;
    return `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function byteOffsetToCodePointIndex(text: string, byteOffset: number): number {
    const target = Math.max(0, byteOffset);
    let bytes = 0;
    let index = 0;
    for (const point of text) {
        const nextBytes = bytes + Buffer.byteLength(point, "utf8");
        if (nextBytes > target) return index;
        bytes = nextBytes;
        index++;
    }
    return index;
}

/**
 * True when the query has no whitespace, punctuation or symbol separators: it
 * is already one literal pattern, and retrying it as smaller terms could only
 * split a word into dictionary fragments or characters. A hyphen is
 * punctuation, so a hyphenated identifier (`ctx-search`) is not unbroken and
 * keeps the term retry.
 */
function isUnbrokenLiteral(query: string): boolean {
    return !/[\s\p{P}\p{S}]/u.test(query);
}

/**
 * The bounded fallback term set of a natural-language query: word-like
 * Intl.Segmenter tokens without a fixed set of generic question/function words,
 * deduplicated case-insensitively, longest first, at most
 * WIKI_RECALL_TERM_LIMIT. An unbroken literal query never reaches this (see
 * `isUnbrokenLiteral`), so one word is never split into characters or n-grams.
 */
function recallTerms(query: string): string[] {
    const seen = new Set<string>();
    const candidates: Array<{ term: string; chars: number; index: number }> = [];
    for (const segment of wikiWordSegmenter.segment(query)) {
        if (!segment.isWordLike) continue;
        const term = segment.segment.trim();
        if (!/[\p{L}\p{N}]/u.test(term) || /[\r\n]/.test(term)) continue;
        const chars = Array.from(term).length;
        if (chars < WIKI_RECALL_MIN_CHARS) continue;
        const key = term.toLowerCase();
        if (seen.has(key) || WIKI_QUERY_STOPWORDS.has(key)) continue;
        seen.add(key);
        candidates.push({ term, chars, index: candidates.length });
    }
    candidates.sort((a, b) => b.chars - a.chars || a.index - b.index);
    return candidates.slice(0, WIKI_RECALL_TERM_LIMIT).map((candidate) => candidate.term);
}

/** Text of one native byte range, or null when the range covers no character. */
function lineTextOfRange(line: string, startByte: number, endByte: number): string | null {
    const points = Array.from(line);
    const start = byteOffsetToCodePointIndex(line, Math.max(0, startByte));
    const end = byteOffsetToCodePointIndex(line, Math.max(startByte, endByte));
    if (end <= start) return null;
    return points.slice(start, end).join("");
}

/**
 * How one hit is anchored. The exact pass anchors on the whole query; the
 * fallback pass anchors only on a searched term verified to be present, because
 * FFF truncates displayed lines and can report an empty range with `col: 0`
 * while the real term sits far past the truncation point.
 */
interface MatchAnchor {
    /** Anchor text; empty when the displayed line carries no verified anchor. */
    text: string;
    /** Verified fragment-relative code-point range, or null when nothing was verified. */
    range: [number, number] | null;
    /**
     * Verified byte span of the anchor in the displayed line. `null` suppresses
     * the native `col` — a fallback with no verified anchor must never anchor
     * at the displayed line start; undefined keeps the exact pass's native rules.
     */
    byteColumn?: number | null;
    byteLength?: number;
}

/**
 * The verified fallback anchor of one match, or null when nothing can be
 * trusted. A native range counts only when it decodes to one of the searched
 * terms; failing that, only a term literally present in the displayed line
 * anchors it. The native `col` is never trusted on its own.
 */
function verifyFallbackAnchor(match: WikiFffMatch, terms: readonly string[]): MatchAnchor | null {
    const line = match.lineContent ?? "";
    for (const [start, end] of match.matchRanges ?? []) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
            continue;
        }
        const text = lineTextOfRange(line, start, end);
        if (text === null) continue;
        const decoded = text.toLowerCase();
        const term = terms.find((candidate) => candidate.toLowerCase() === decoded);
        if (term === undefined) continue;
        return {
            text: term,
            range: [byteOffsetToCodePointIndex(line, start), byteOffsetToCodePointIndex(line, end)],
            byteColumn: start,
            byteLength: end - start,
        };
    }
    const lowerLine = line.toLowerCase();
    let anchor: { term: string; index: number } | null = null;
    for (const term of terms) {
        const index = lowerLine.indexOf(term.toLowerCase());
        if (index < 0) continue;
        if (
            !anchor ||
            index < anchor.index ||
            (index === anchor.index && term.length > anchor.term.length)
        ) {
            anchor = { term, index };
        }
    }
    if (!anchor) return null;
    const startByte = Buffer.byteLength(line.slice(0, anchor.index), "utf8");
    const endByte = Buffer.byteLength(line.slice(0, anchor.index + anchor.term.length), "utf8");
    if (endByte <= startByte) return null;
    return {
        text: anchor.term,
        range: [
            byteOffsetToCodePointIndex(line, startByte),
            byteOffsetToCodePointIndex(line, endByte),
        ],
        byteColumn: startByte,
        byteLength: endByte - startByte,
    };
}

/** Distinct searched terms present in the match's path, line and native context. */
function fallbackCoverage(match: WikiFffMatch, terms: readonly string[]): number {
    const haystack = [
        typeof match.relativePath === "string" ? match.relativePath : "",
        match.lineContent ?? "",
        ...(match.contextBefore ?? []),
        ...(match.contextAfter ?? []),
    ]
        .join("\n")
        .toLowerCase();
    let coverage = 0;
    for (const term of terms) {
        if (haystack.includes(term.toLowerCase())) coverage++;
    }
    return coverage;
}

/**
 * Fallback page order: a section carrying several of the question's terms
 * outranks one-term noise; equal coverage keeps the native result order so the
 * native ranking still decides among equally specific hits.
 */
function rankFallbackMatches(
    items: readonly WikiFffMatch[],
    terms: readonly string[],
): WikiFffMatch[] {
    return items
        .map((match, index) => ({ match, index, coverage: fallbackCoverage(match, terms) }))
        .sort((a, b) => b.coverage - a.coverage || a.index - b.index)
        .map((entry) => entry.match);
}

/**
 * The exact pass's anchor range: the native match range when FFF reports one, else
 * the native column, else a literal query occurrence the line still carries.
 */
function matchedRange(match: WikiFffMatch, anchor: string): [number, number] | null {
    const firstRange = match.matchRanges?.find(
        ([start, end]) =>
            Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start,
    );
    let startByte = firstRange?.[0];
    let endByte = firstRange?.[1];
    const col = match.col;
    if (startByte === undefined && typeof col === "number" && Number.isInteger(col) && col >= 0) {
        startByte = col;
        endByte = col + Buffer.byteLength(anchor, "utf8");
    }
    if (startByte === undefined) {
        // Match FFF smartCase when a native range is unavailable: an uppercase
        // anchor is exact; a lowercase anchor may recover its exact surface
        // casing from the line instead of guessing a midpoint later.
        const caseSensitive = anchor !== anchor.toLowerCase();
        const anchorIndex = caseSensitive
            ? match.lineContent.indexOf(anchor)
            : match.lineContent.toLowerCase().indexOf(anchor.toLowerCase());
        if (anchorIndex < 0) return null;
        startByte = Buffer.byteLength(match.lineContent.slice(0, anchorIndex), "utf8");
        endByte = Buffer.byteLength(
            match.lineContent.slice(0, anchorIndex + anchor.length),
            "utf8",
        );
    }
    return [
        byteOffsetToCodePointIndex(match.lineContent, startByte),
        byteOffsetToCodePointIndex(match.lineContent, endByte ?? startByte),
    ];
}

function windowAroundMatch(line: string, range: [number, number] | null, limit: number): string {
    const points = Array.from(line);
    if (points.length <= limit) return line;
    const hitStart = range?.[0] ?? 0;
    const hitEnd = range?.[1] ?? hitStart + 1;
    const hitLength = Math.max(1, hitEnd - hitStart);
    const findWindow = (contentLimit: number): [number, number] => {
        let start = range
            ? Math.max(0, hitStart - Math.floor(Math.max(0, contentLimit - hitLength) / 2))
            : 0;
        let end = Math.min(points.length, start + contentLimit);
        if (end < hitEnd) {
            end = Math.min(points.length, hitEnd);
            start = Math.max(0, end - contentLimit);
        }
        if (start > hitStart) start = hitStart;
        if (end - start > contentLimit) end = start + contentLimit;
        return [start, end];
    };
    let [start, end] = findWindow(Math.max(1, limit - 1));
    const markerCount = Number(start > 0) + Number(end < points.length);
    const finalContentLimit = Math.max(1, limit - markerCount);
    if (end - start > finalContentLimit) [start, end] = findWindow(finalContentLimit);
    const clipped = points.slice(start, end).join("");
    return `${start > 0 ? "…" : ""}${clipped}${end < points.length ? "…" : ""}`;
}

function clipContextLine(text: string, limit: number, fromEnd: boolean): string {
    if (limit <= 0) return "";
    const points = Array.from(text);
    if (points.length <= limit) return text;
    if (limit === 1) return "…";
    const content = points.slice(
        fromEnd ? points.length - limit + 1 : 0,
        fromEnd ? undefined : limit - 1,
    );
    return fromEnd ? `…${content.join("")}` : `${content.join("")}…`;
}

function previewLine(line: string, range: [number, number] | null): string {
    const window = windowAroundMatch(line, range, WIKI_PREVIEW_CHARS);
    const normalized = window.replace(/\s+/g, " ").trim();
    return boundedChars(normalized, WIKI_PREVIEW_CHARS);
}

function snippetOf(match: WikiFffMatch, range: [number, number] | null): string {
    const matchedLine = windowAroundMatch(match.lineContent, range, WIKI_SNIPPET_CHARS);
    const matchedLength = Array.from(matchedLine).length;
    const before = (match.contextBefore ?? []).join("\n");
    const after = (match.contextAfter ?? []).join("\n");
    const separators = Number(before.length > 0) + Number(after.length > 0);
    const remaining = Math.max(0, WIKI_SNIPPET_CHARS - matchedLength - separators);
    const beforeBudget = before && after ? Math.ceil(remaining / 2) : before ? remaining : 0;
    const afterBudget = after && before ? Math.floor(remaining / 2) : after ? remaining : 0;
    let clippedBefore = beforeBudget > 0 ? clipContextLine(before, beforeBudget, true) : "";
    let clippedAfter = afterBudget > 0 ? clipContextLine(after, afterBudget, false) : "";
    let unused = Math.max(
        0,
        remaining - Array.from(clippedBefore).length - Array.from(clippedAfter).length,
    );
    if (unused > 0 && before) {
        const beforeLength = Array.from(before).length;
        const beforeUsed = Array.from(clippedBefore).length;
        const extra = Math.min(unused, Math.max(0, beforeLength - beforeUsed));
        if (extra > 0) {
            clippedBefore = clipContextLine(before, beforeUsed + extra, true);
            unused -= extra;
        }
    }
    if (unused > 0 && after) {
        const afterLength = Array.from(after).length;
        const afterUsed = Array.from(clippedAfter).length;
        const extra = Math.min(unused, Math.max(0, afterLength - afterUsed));
        if (extra > 0) clippedAfter = clipContextLine(after, afterUsed + extra, false);
    }
    const lines = [
        ...(clippedBefore ? [clippedBefore] : []),
        matchedLine,
        ...(clippedAfter ? [clippedAfter] : []),
    ];
    return boundedChars(lines.join("\n"), WIKI_SNIPPET_CHARS);
}

interface WikiFinderGlobalState {
    /** Corpus root claimed by the live finder or in-flight creation. Null before the first search. */
    root: string | null;
    finder: WikiFffFinder | null;
    /** Creation + initial scan. Cleared on success or failure so a failure can be retried. */
    readiness: Promise<WikiFffFinder> | null;
}

function globalState(): WikiFinderGlobalState {
    const store = globalThis as unknown as Record<symbol, WikiFinderGlobalState | undefined>;
    let state = store[GLOBAL_STATE_KEY];
    if (!state) {
        state = { root: null, finder: null, readiness: null };
        store[GLOBAL_STATE_KEY] = state;
    }
    return state;
}

/** Test-only injection point for failure paths; null restores the real SDK loader. */
let injectedFffModule: WikiFffModule | null = null;

function bunSupportsFfi(): boolean {
    const runtime = (globalThis as { Bun?: { ffi?: unknown } }).Bun;
    return typeof runtime?.ffi === "object" && runtime.ffi !== null;
}

async function loadFffModule(): Promise<WikiFffModule> {
    if (injectedFffModule) return injectedFffModule;
    const failures: string[] = [];
    if (bunSupportsFfi()) {
        try {
            return (await import("@ff-labs/fff-bun")) as unknown as WikiFffModule;
        } catch (error) {
            // Bun present but its FFI build failed to load: keep trying the Node
            // build rather than reporting the package as missing.
            failures.push(`fff-bun: ${messageOf(error)}`);
        }
    }
    try {
        return (await import("@ff-labs/fff-node")) as unknown as WikiFffModule;
    } catch (error) {
        failures.push(`fff-node: ${messageOf(error)}`);
    }
    throw new WikiSearchError("fff_unavailable", `no usable FFF runtime (${failures.join("; ")})`);
}

let exitCleanupRegistered = false;

function registerExitCleanup(): void {
    if (exitCleanupRegistered) return;
    exitCleanupRegistered = true;
    process.once("exit", () => {
        const state = globalState();
        try {
            state.finder?.destroy();
        } catch {
            // Best effort at process exit.
        }
        state.finder = null;
    });
}

async function openFinder(root: string): Promise<WikiFffFinder> {
    const module = await loadFffModule();
    // No frecency/history DB paths: those are SDK-owned persistent stores and
    // this corpus is read-only. The watcher stays enabled (SDK default).
    const created = module.FileFinder.create({ basePath: root, aiMode: true });
    if (!created.ok) {
        throw new WikiSearchError("create_failed", `FileFinder.create failed: ${created.error}`);
    }
    const finder = created.value;
    try {
        const scanned = await finder.waitForScan(WIKI_SCAN_TIMEOUT_MS);
        if (!scanned.ok) {
            throw new WikiSearchError("scan_failed", `initial scan failed: ${scanned.error}`);
        }
        if (!scanned.value) {
            throw new WikiSearchError(
                "scan_timeout",
                `initial scan did not finish within ${WIKI_SCAN_TIMEOUT_MS}ms`,
            );
        }
    } catch (error) {
        try {
            finder.destroy();
        } catch {
            // The instance never became usable; a failed destroy changes nothing.
        }
        throw error;
    }
    return finder;
}

/**
 * The process-global finder for one root. Concurrent callers share one
 * creation+scan promise, and a failed attempt clears its state so the next call
 * retries instead of reusing a permanently rejected promise. A different root
 * while a finder is live is a configuration conflict, never a silent swap.
 */
export async function ensureWikiFinder(root: string, signal?: AbortSignal): Promise<WikiFffFinder> {
    throwIfAborted(signal);
    if (!isAbsolute(root)) {
        throw new WikiSearchError("root_invalid", "wiki.source_root must be an absolute path");
    }
    const state = globalState();
    if (state.root !== null && state.root !== root) {
        throw new WikiSearchError(
            "root_conflict",
            `wiki.source_root changed within one process (${state.root} -> ${root}); restart the host to switch corpora`,
        );
    }
    if (state.finder) return state.finder;
    state.root = root;
    if (!state.readiness) {
        const attempt = openFinder(root);
        state.readiness = attempt;
        void attempt.then(
            (finder) => {
                if (state.readiness !== attempt) return;
                state.finder = finder;
                state.readiness = null;
                registerExitCleanup();
            },
            () => {
                if (state.readiness !== attempt) return;
                state.root = null;
                state.readiness = null;
            },
        );
    }
    throwIfAborted(signal);
    const finder = await state.readiness;
    throwIfAborted(signal);
    return finder;
}

/** One bounded native pass with the given literal patterns. */
function runWikiGrep(
    finder: WikiFffFinder,
    patterns: string[],
    signal?: AbortSignal,
): WikiFffGrepResult {
    const result = finder.multiGrep({
        patterns,
        constraints: "*.{md,markdown}",
        maxMatchesPerFile: WIKI_MAX_MATCHES_PER_FILE,
        pageSize: WIKI_GREP_PAGE_SIZE,
        smartCase: true,
        cursor: null,
        beforeContext: 1,
        afterContext: 1,
        timeBudgetMs: WIKI_GREP_TIME_BUDGET_MS,
        enforceTimeBudget: true,
    });
    throwIfAborted(signal);
    if (!result.ok) {
        throw new WikiSearchError("grep_failed", `multiGrep failed: ${result.error}`);
    }
    return result.value;
}

/** A per-file cap or an unconsumed native cursor means the page may be incomplete. */
function pageIsPartial(value: WikiFffGrepResult): boolean {
    const matchesByPath = new Map<string, number>();
    let reachedPerFileCap = false;
    for (const match of value.items.slice(0, WIKI_GREP_PAGE_SIZE)) {
        if (typeof match.relativePath !== "string" || !Number.isFinite(match.lineNumber)) continue;
        const fileMatches = (matchesByPath.get(match.relativePath) ?? 0) + 1;
        matchesByPath.set(match.relativePath, fileMatches);
        if (fileMatches >= WIKI_MAX_MATCHES_PER_FILE) reachedPerFileCap = true;
    }
    return reachedPerFileCap || (value.nextCursor !== null && value.nextCursor !== undefined);
}

/** The native match column, when FFF reports one. */
function nativeColumn(match: WikiFffMatch): number | undefined {
    return typeof match.col === "number" && Number.isInteger(match.col) && match.col >= 0
        ? match.col
        : undefined;
}

/**
 * Map native matches to search hits, bounding the page. Every snippet, preview
 * and byte range is anchored on `anchorOf(match)`: the exact query on the exact
 * pass, a verified fallback term on the fallback pass. `matchTerms` is emitted
 * only on the fallback pass, so a caller holding the full original line can
 * re-anchor a truncated native fragment there.
 */
function hitsOfMatches(
    items: readonly WikiFffMatch[],
    anchorOf: (match: WikiFffMatch) => MatchAnchor,
    matchTerms?: readonly string[],
): WikiCorpusHit[] {
    const hits: WikiCorpusHit[] = [];
    for (const match of items.slice(0, WIKI_GREP_PAGE_SIZE)) {
        if (typeof match.relativePath !== "string" || !Number.isFinite(match.lineNumber)) continue;
        const anchor = anchorOf(match);
        const matchRange = anchor.range;
        const linePoints = Array.from(match.lineContent ?? "");
        const matchText =
            anchor.text && matchRange && matchRange[1] > matchRange[0]
                ? linePoints.slice(matchRange[0], matchRange[1]).join("")
                : undefined;
        const nativeRange = match.matchRanges?.find(
            ([start, end]) =>
                Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start,
        );
        const matchByteLength =
            anchor.byteLength ??
            (nativeRange
                ? nativeRange[1] - nativeRange[0]
                : Buffer.byteLength(matchText ?? anchor.text, "utf8"));
        const nativeCol = nativeColumn(match);
        // An explicit null suppresses the native column: a fallback match with
        // no verified anchor must not be anchored at the displayed line start.
        const matchByteColumn =
            anchor.byteColumn === null ? undefined : (anchor.byteColumn ?? nativeCol);
        hits.push({
            path: match.relativePath,
            line: Math.max(1, Math.floor(match.lineNumber)),
            snippet: snippetOf(match, matchRange),
            preview: previewLine(match.lineContent ?? "", matchRange),
            modifiedAtMs: Math.round(match.modified * 1000),
            ...(matchRange && matchText
                ? {
                      matchRange: { start: matchRange[0], end: matchRange[1] },
                      matchText,
                  }
                : {}),
            ...(matchTerms && matchTerms.length > 0 ? { matchTerms: [...matchTerms] } : {}),
            ...(matchByteColumn !== undefined && matchByteLength > 0
                ? { matchByteColumn, matchByteLength }
                : {}),
        });
    }
    return hits;
}

function logPartialPage(queryLength: number): void {
    log(`[ctx_search] wiki search returned a bounded partial page for ${queryLength} chars`);
}

/**
 * Literal Markdown search: the whole query first, then — only when that finds
 * nothing — one bounded pass of literal recall terms ranked by term coverage.
 */
export async function searchWikiCorpus(
    options: WikiCorpusSearchOptions,
): Promise<WikiCorpusSearchPage> {
    // FFF joins multiGrep patterns with newlines, so CR/LF cannot be passed as
    // part of a literal pattern. Reject before trimming to catch edges.
    if (/[\r\n]/.test(options.query)) return { hits: [], partial: false };
    const query = options.query.trim();
    if (query.length === 0) return { hits: [], partial: false };
    throwIfAborted(options.signal);
    const finder = await ensureWikiFinder(options.root, options.signal);
    throwIfAborted(options.signal);
    // The whole query is the primary pass: one literal pattern, native order,
    // snippets and byte ranges anchored on the query itself.
    const exactPage = runWikiGrep(finder, [query], options.signal);
    const exactHits = hitsOfMatches(exactPage.items, (match) => ({
        text: query,
        range: matchedRange(match, query),
    }));
    const exactPartial = pageIsPartial(exactPage);
    if (exactHits.length > 0) {
        if (exactPartial) logPartialPage(query.length);
        return { hits: exactHits, partial: exactPartial };
    }
    // Zero exact hits only: retry with a bounded literal OR set instead of the
    // whole question, which no single line contains verbatim. One unbroken
    // literal is already the smallest useful pattern and is never split.
    const terms = recallTerms(query);
    if (isUnbrokenLiteral(query) || terms.length === 0) {
        if (exactPartial) logPartialPage(query.length);
        return { hits: [], partial: exactPartial };
    }
    throwIfAborted(options.signal);
    const fallbackPage = runWikiGrep(finder, terms, options.signal);
    const ranked = rankFallbackMatches(fallbackPage.items, terms);
    // Only a term verified in the displayed line anchors a fallback hit; an
    // unverified one suppresses the native col instead of anchoring at line 0.
    const anchorOf = (match: WikiFffMatch): MatchAnchor =>
        verifyFallbackAnchor(match, terms) ?? { text: "", range: null, byteColumn: null };
    const hits = hitsOfMatches(ranked, anchorOf, terms);
    // Both passes ran under the same native bounds, so either stopping early
    // leaves matches unseen.
    const partial = exactPartial || pageIsPartial(fallbackPage);
    if (partial) logPartialPage(query.length);
    return { hits, partial };
}

/** Destroy the process-global finder and clear every failure/root claim. Tests only. */
export function __resetWikiFinderForTests(): void {
    const state = globalState();
    try {
        state.finder?.destroy();
    } catch {
        // A destroyed or half-initialized instance may fail here; the reset still completes.
    }
    state.finder = null;
    state.readiness = null;
    state.root = null;
    injectedFffModule = null;
}

/** Inject a fake SDK module for adapter failure-path tests; null restores the real loader. */
export function __setWikiFffModuleForTests(module: WikiFffModule | null): void {
    injectedFffModule = module;
}
