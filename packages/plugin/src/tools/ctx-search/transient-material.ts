import type { UnifiedSearchResult } from "../../features/magic-context/search";
import { truncateUtf8 } from "../../features/magic-context/search-rerank";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { matchedSearchSnippet } from "../../shared/search-text";
import type { Database } from "../../shared/sqlite";

export interface TransientMaterial {
    text: string;
    included: number;
    truncated: boolean;
}

type NonMemoryResult = Exclude<UnifiedSearchResult, { source: "memory" }>;
type MaterialLine = { header: string; body: string; clipped: boolean };

const MAX_ITEMS = 8;
const FULL_TEXT_CHARS = 700;
const FULL_TEXT_BYTES = 1024;
const MESSAGE_CHARS = 300;

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
            const mapped = db
                .prepare(`SELECT f.content FROM message_fts_rowid_map m
                JOIN message_history_fts f ON f.rowid=m.fts_rowid
                WHERE m.session_id=? AND m.message_ordinal=? AND f.message_id=?`)
                .get(sessionId, hit.messageOrdinal, hit.messageId) as
                | { content: string }
                | undefined;
            const row =
                mapped ??
                (db
                    .prepare(
                        "SELECT content FROM message_history_fts WHERE session_id=? AND message_id=? ORDER BY CAST(message_ordinal AS INTEGER) LIMIT 1",
                    )
                    .get(sessionId, hit.messageId) as { content: string } | undefined);
            const excerpt = row
                ? matchedSearchSnippet(row.content, query, MESSAGE_CHARS) || hit.content
                : hit.content;
            const body = capped(excerpt, MESSAGE_CHARS);
            return {
                header: `[message] ord=${hit.messageOrdinal} range=${Math.max(1, hit.messageOrdinal - 3)}-${hit.messageOrdinal + 3} time=${date(times.get(hit.messageOrdinal))} role=${singleLine(hit.role)}`,
                body: body.text,
                clipped: body.clipped || (row != null && singleLine(row.content) !== body.text),
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
}): TransientMaterial | null {
    const hits = args.results.filter((hit): hit is NonMemoryResult => hit.source !== "memory");
    if (hits.length === 0) return null;
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
    };
}
