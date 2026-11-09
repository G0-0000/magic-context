import type {
    ReservedSearchCandidates,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { truncateUtf8 } from "../../features/magic-context/search-rerank";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { matchedSearchSnippet } from "../../shared/search-text";
import type { Database } from "../../shared/sqlite";

/** One reserved message hit, carrying its own identity for the appendix. */
export interface ReservedMessageHit {
    /** Owning session — the appendix expands THIS session, not the caller's. */
    sessionId: string;
    messageOrdinal: number;
    /** Persisted sidecar time of the hit's own row; null when absent, never
     *  fabricated. */
    messageTimeMs: number | null;
    snippet: string;
}

/** One reserved git-commit hit. */
export interface ReservedGitHit {
    shortSha: string;
    committedAtMs: number;
    subject: string;
}

/**
 * Guaranteed-revealed reserved hits. Populated only on the explicit fusion
 * route; the single source of truth for the deterministic appendix appended
 * after the model answer. Never enters the model input (`text`).
 */
export interface ReservedHits {
    messages: ReservedMessageHit[];
    gitCommits: ReservedGitHit[];
}

export interface TransientMaterial {
    text: string;
    included: number;
    truncated: boolean;
    /** Reserved hits kept out of the model input; the post-model appendix
     *  renders from these alone, so a guaranteed hit never depends on the
     *  model citing it. */
    reserved: ReservedHits;
}

type NonMemoryResult = Exclude<UnifiedSearchResult, { source: "memory" }>;
type MessageResult = Extract<NonMemoryResult, { source: "message" }>;
type MaterialLine = { header: string; body: string; clipped: boolean };

const MAX_ITEMS = 8;
const FULL_TEXT_CHARS = 700;
const FULL_TEXT_BYTES = 1024;
const MESSAGE_CHARS = 300;
const RESERVED_MESSAGE_LIMIT = 3;
const RESERVED_GIT_LIMIT = 3;
const RESERVED_SNIPPET_CHARS = 200;
const RESERVED_SUBJECT_CHARS = 120;
const SESSION_ID_PREFIX_CHARS = 8;

const RESERVED_APPENDIX_HEADER = "保留命中：";

/**
 * zh/en relative-date words. Detection prioritises git history in material
 * inclusion and leads the reserved appendix with git hits; it is NOT a parsed
 * calendar range (date-range.ts owns explicit from/to filtering).
 */
const DATE_INTENT_PATTERN =
    /\b(?:yesterday|today|tonight|last night|last week|this week)\b|昨天|今天|今晚|昨晚|前天|上周|本周|这周/i;

export function detectDateIntent(query: string): boolean {
    return DATE_INTENT_PATTERN.test(query);
}

function singleLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function capped(text: string, chars: number, bytes?: number): { text: string; clipped: boolean } {
    const points = Array.from(singleLine(text));
    let clipped = points.length > chars;
    let result = clipped
        ? `${points.slice(0, Math.max(0, chars - 1)).join("")}…`
        : points.join("");
    if (bytes !== undefined && Buffer.byteLength(result, "utf8") > bytes) {
        result = `${truncateUtf8(result, bytes - Buffer.byteLength("…"))}…`;
        clipped = true;
    }
    return { text: result, clipped };
}

function date(ms: number | null | undefined): string {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
    const value = new Date(ms);
    return Number.isNaN(value.getTime()) ? "?" : value.toISOString();
}

function messageTimes(
    db: Database,
    sessionId: string,
    results: readonly NonMemoryResult[],
): Map<number, number | null> {
    const ordinals = [
        ...new Set(
            results.flatMap((hit) => (hit.source === "message" ? [hit.messageOrdinal] : [])),
        ),
    ];
    if (ordinals.length === 0) return new Map();
    const placeholders = ordinals.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT message_ordinal, message_time_ms FROM message_fts_rowid_map WHERE session_id=? AND message_ordinal IN (${placeholders})`,
        )
        .all(sessionId, ...ordinals) as Array<{
        message_ordinal: number;
        message_time_ms: number | null;
    }>;
    return new Map(rows.map((row) => [row.message_ordinal, row.message_time_ms]));
}

function fullTextLine(header: string, text: string): MaterialLine {
    // Like candidateText, the complete document (metadata and body) is capped
    // at 1 KiB. The 700-character source cap still applies independently.
    const bodyBytes = Math.max(3, FULL_TEXT_BYTES - Buffer.byteLength(header) - 4);
    const body = capped(text, FULL_TEXT_CHARS, bodyBytes);
    return { header, body: body.text, clipped: body.clipped };
}

/**
 * The message body lookup shared by the material line and the reserved
 * appendix, following candidateTexts' source lookups. Both predicates pin
 * the OWNING session: the map row must belong to `sessionId` AND the joined
 * FTS row must carry that same session — a stale rowid-map entry must miss,
 * never leak another session's content. Reserved callers pass the hit's own
 * `hit.sessionId`, never the caller's session. `stored` is the full indexed
 * content when a row exists (for clipped accounting); missing rows can
 * result from concurrent deletion, and the hit's preview text answers.
 */
function messageExcerpt(
    db: Database,
    sessionId: string,
    query: string,
    hit: MessageResult,
): { excerpt: string; stored: string | null } {
    const mapped = db
        .prepare(`SELECT f.content FROM message_fts_rowid_map m
                JOIN message_history_fts f ON f.rowid=m.fts_rowid
                WHERE m.session_id=? AND m.message_ordinal=? AND f.message_id=? AND f.session_id=?`)
        .get(sessionId, hit.messageOrdinal, hit.messageId, sessionId) as
        | { content: string }
        | undefined;
    const row =
        mapped ??
        (db
            .prepare(
                "SELECT content FROM message_history_fts WHERE session_id=? AND message_id=? ORDER BY CAST(message_ordinal AS INTEGER) LIMIT 1",
            )
            .get(sessionId, hit.messageId) as { content: string } | undefined);
    if (!row) return { excerpt: hit.content, stored: null };
    return {
        excerpt: matchedSearchSnippet(row.content, query, MESSAGE_CHARS) || hit.content,
        stored: singleLine(row.content),
    };
}

// Follow candidateTexts' source lookups without its reranker-specific document layout.
// Missing rows can result from concurrent deletion; the search preview remains usable.
function materialLine(
    db: Database,
    sessionId: string,
    query: string,
    hit: NonMemoryResult,
    times: Map<number, number | null>,
): MaterialLine {
    switch (hit.source) {
        case "git_commit": {
            const row = db.prepare("SELECT message FROM git_commits WHERE sha=?").get(hit.sha) as
                | { message: string }
                | undefined;
            return fullTextLine(
                `[git_commit] ${hit.shortSha} time=${date(hit.committedAtMs)}`,
                row?.message ?? hit.content,
            );
        }
        case "primer": {
            const row = db
                .prepare("SELECT question, answer FROM primers WHERE id=?")
                .get(hit.primerId) as { question: string; answer: string } | undefined;
            return fullTextLine(
                `[primer] #${hit.primerId} observed=${date(hit.lastObservedAt)}`,
                row ? `Q: ${row.question}\nA: ${row.answer}` : hit.content,
            );
        }
        case "note": {
            const row = db
                .prepare("SELECT content, ready_reason AS reason FROM notes WHERE id=?")
                .get(hit.noteId) as { content: string; reason: string | null } | undefined;
            return fullTextLine(
                `[note] #${hit.noteId} status=${hit.status} time=${date(hit.createdAt)}`,
                row ? `${row.content}${row.reason ? `\nReason: ${row.reason}` : ""}` : hit.content,
            );
        }
        case "message": {
            const { excerpt, stored } = messageExcerpt(db, sessionId, query, hit);
            const body = capped(excerpt, MESSAGE_CHARS);
            return {
                header: `[message] ord=${hit.messageOrdinal} range=${Math.max(1, hit.messageOrdinal - 3)}-${hit.messageOrdinal + 3} time=${date(times.get(hit.messageOrdinal))} role=${singleLine(hit.role)}`,
                body: body.text,
                clipped: body.clipped || (stored !== null && stored !== body.text),
            };
        }
        case "compartment":
            return {
                header: `[compartment] #${hit.compartmentId} range=${hit.startOrdinal}-${hit.endOrdinal} title=${singleLine(hit.title)}`,
                body: "",
                clipped: false,
            };
    }
}

/**
 * Build the reserved-hit structure for the post-model appendix from the
 * explicit-fusion-only candidate channel. Message snippets reuse the
 * material's body lookup but cap at 200 characters, and each hit keeps its
 * own session identity and persisted time — a cross-session hit is never
 * resolved against the caller's session. Empty for any caller that is not an
 * explicit fusion search (candidates undefined).
 */
export function buildReservedHits(
    db: Database,
    query: string,
    candidates: ReservedSearchCandidates | undefined,
): ReservedHits {
    if (!candidates) return { messages: [], gitCommits: [] };
    const seenMessages = new Set<string>();
    const messages: ReservedMessageHit[] = [];
    for (const hit of [...candidates.messages, ...candidates.currentSessionMessages]) {
        const key = `${hit.sessionId}:${hit.messageOrdinal}`;
        if (seenMessages.has(key)) continue;
        seenMessages.add(key);
        // The body lookup runs under the HIT's own session identity — never
        // the caller's — and the time stamp travels with the hit itself.
        const { excerpt } = messageExcerpt(db, hit.sessionId, query, hit);
        messages.push({
            sessionId: hit.sessionId,
            messageOrdinal: hit.messageOrdinal,
            messageTimeMs: hit.messageTimeMs,
            snippet: capped(excerpt, RESERVED_SNIPPET_CHARS).text,
        });
        if (messages.length >= RESERVED_MESSAGE_LIMIT) break;
    }
    const seenCommits = new Set<string>();
    const gitCommits: ReservedGitHit[] = [];
    for (const hit of candidates.gitCommits) {
        if (seenCommits.has(hit.sha)) continue;
        seenCommits.add(hit.sha);
        const row = db.prepare("SELECT message FROM git_commits WHERE sha=?").get(hit.sha) as
            | { message: string }
            | undefined;
        const firstLine = singleLine((row?.message ?? hit.content).split("\n")[0] ?? "");
        gitCommits.push({
            shortSha: hit.shortSha,
            committedAtMs: hit.committedAtMs,
            subject: capped(firstLine || hit.content, RESERVED_SUBJECT_CHARS).text,
        });
        if (gitCommits.length >= RESERVED_GIT_LIMIT) break;
    }
    return { messages, gitCommits };
}

function reservedMessageLine(hit: ReservedMessageHit): string {
    return [
        `- [message] ${hit.sessionId.slice(0, SESSION_ID_PREFIX_CHARS)} ${date(hit.messageTimeMs)} ${hit.snippet}`,
        `  ctx_expand(sessionId: "${hit.sessionId}", message: ${hit.messageOrdinal})`,
    ].join("\n");
}

function reservedGitLine(hit: ReservedGitHit): string {
    return `- [git_commit] ${hit.shortSha} ${date(hit.committedAtMs)} ${hit.subject}`;
}

/**
 * Deterministic markdown appendix for the reserved hits, appended after the
 * model answer on the strata-ask fusion routes (answered and miss alike). It
 * never depends on the model citing a source. At most 3 message hits and 3
 * git hits; under a detected date intent the git entries lead.
 */
export function renderReservedAppendix(
    reserved: ReservedHits,
    options?: { dateIntent?: boolean },
): string {
    const messageLines = reserved.messages
        .slice(0, RESERVED_MESSAGE_LIMIT)
        .map(reservedMessageLine);
    const gitLines = reserved.gitCommits.slice(0, RESERVED_GIT_LIMIT).map(reservedGitLine);
    const lines = options?.dateIntent
        ? [...gitLines, ...messageLines]
        : [...messageLines, ...gitLines];
    if (lines.length === 0) return "";
    return [RESERVED_APPENDIX_HEADER, ...lines].join("\n");
}

/**
 * Append the reserved-hits appendix to a strata-ask answer — the memory-cache
 * answer on success, or the fusion-route miss reusing the non-memory classic
 * result. Classic-fallback returns must NOT go through here: those already
 * list the classic results.
 */
export function withReservedAppendix(
    text: string,
    reserved: ReservedHits,
    query: string,
): string {
    const appendix = renderReservedAppendix(reserved, { dateIntent: detectDateIntent(query) });
    return appendix === "" ? text : `${text}\n\n${appendix}`;
}

function price(line: string): number {
    return estimateTokens(line) + 1;
}

function render(line: MaterialLine, chars: number): string {
    if (!line.body || chars <= 0) return line.header;
    const points = Array.from(line.body);
    const body =
        chars < points.length ? `${points.slice(0, Math.max(0, chars - 1)).join("")}…` : line.body;
    return `${line.header} :: ${body}`;
}

/** A material-only line block; the fused template supplies its header. */
export function buildTransientMaterial(args: {
    db: Database;
    sessionId: string;
    query: string;
    results: readonly UnifiedSearchResult[];
    budgetTokens: number;
    /** Explicit-fusion-only reserved candidates (search.ts channel). */
    reservedCandidates?: ReservedSearchCandidates;
}): TransientMaterial | null {
    let hits = args.results.filter((hit): hit is NonMemoryResult => hit.source !== "memory");
    if (hits.length === 0) return null;
    // A relative-date query ("昨天", "last week") asks about a point in time:
    // commits are the most date-anchored source, so they take the
    // first-inclusion slots ahead of the other sources.
    if (detectDateIntent(args.query)) {
        hits = [
            ...hits.filter((hit) => hit.source === "git_commit"),
            ...hits.filter((hit) => hit.source !== "git_commit"),
        ];
    }
    const reserved = buildReservedHits(args.db, args.query, args.reservedCandidates);
    const budget = Number.isFinite(args.budgetTokens)
        ? Math.max(0, Math.floor(args.budgetTokens))
        : 0;
    const times = messageTimes(args.db, args.sessionId, hits);
    const lines = hits.map((hit) => materialLine(args.db, args.sessionId, args.query, hit, times));
    const selected = new Map<number, { text: string; cost: number; clipped: boolean }>();
    const seen = new Set<NonMemoryResult["source"]>();
    let used = 0;

    // Reserve the first hit of each source before later hits. At normal budgets
    // (1000 tokens), each source has a floor; for tiny budgets the hard token
    // limit wins even if a minimal metadata line cannot fit.
    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]!;
        if (seen.has(hit.source)) continue;
        seen.add(hit.source);
        const text = lines[i]!.header;
        const cost = price(text);
        if (used + cost > budget) continue;
        selected.set(i, { text, cost, clipped: !!lines[i]!.body || lines[i]!.clipped });
        used += cost;
    }

    const fill = (index: number, availableBudget = budget): void => {
        const line = lines[index]!;
        const previous = selected.get(index)!;
        let low = 0;
        let high = Array.from(line.body).length;
        let best = previous.text;
        let bestCost = previous.cost;
        let bestChars = 0;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = render(line, middle);
            const cost = price(candidate);
            if (used - previous.cost + cost <= availableBudget) {
                best = candidate;
                bestCost = cost;
                bestChars = middle;
                low = middle + 1;
            } else high = middle - 1;
        }
        used += bestCost - previous.cost;
        selected.set(index, {
            text: best,
            cost: bestCost,
            clipped: line.clipped || bestChars < Array.from(line.body).length,
        });
    };

    for (const index of selected.keys()) fill(index);
    for (let i = 0; i < hits.length && selected.size < MAX_ITEMS; i++) {
        if (selected.has(i)) continue;
        // A first hit that could not fit must not be replaced by a later hit.
        const first = hits.findIndex((hit) => hit.source === hits[i]!.source);
        if (!selected.has(first)) continue;
        const text = lines[i]!.header;
        const cost = price(text);
        if (used + cost > budget) break;
        selected.set(i, { text, cost, clipped: !!lines[i]!.body || lines[i]!.clipped });
        used += cost;
        fill(i);
    }

    const omitted = hits.length - selected.size;
    let notice: string | undefined;
    if (omitted > 0) {
        const candidate = `另有 ${omitted} 条未纳入`;
        const noticeCost = price(candidate);
        const minimum = [...selected.keys()].reduce(
            (total, index) => total + price(lines[index]!.header),
            0,
        );
        if (minimum + noticeCost <= budget) {
            // Make room for the omission count without evicting a source's first hit.
            for (const index of [...selected.keys()].sort((a, b) => b - a)) {
                if (used + noticeCost <= budget) break;
                const previous = selected.get(index)!;
                const line = lines[index]!;
                const cost = price(line.header);
                used += cost - previous.cost;
                selected.set(index, { text: line.header, cost, clipped: !!line.body || line.clipped });
                if (used + noticeCost <= budget) fill(index, budget - noticeCost);
            }
            notice = candidate;
        }
    }
    const ordered = [...selected.entries()].sort(([a], [b]) => a - b);
    const output = ordered.map(([, line]) => line.text);
    if (notice) output.push(notice);
    return {
        text: output.join("\n"),
        included: ordered.length,
        truncated: omitted > 0 || ordered.some(([, line]) => line.clipped),
        reserved,
    };
}
