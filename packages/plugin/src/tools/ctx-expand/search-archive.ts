import { withMessageFtsSessionFilter } from "../../features/magic-context/message-fts-session-filter";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { runSessionWarmupWorker } from "../../hooks/magic-context/raw-ordinal-warmup";
import {
    hasRawMessageProvider,
    rawMessageOffThreadRangeReader,
    rawMessageWorkerSource,
    readRawSessionMessageIdOrdinalsForRange,
} from "../../hooks/magic-context/read-session-chunk";
import { openCodeDbExists, withReadOnlySessionDb } from "../../hooks/magic-context/read-session-db";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { getSqliteDatabasePath } from "../../shared/sqlite";
import { readV2ArchiveOffThread } from "./v2-archive-reader";

interface ArchiveRow {
    ordinal: number;
    id: string;
    role: string;
    content: string;
}

let archiveReadsOnThisThread = 0;

/** @internal Counts every archive render so tests can detect accidental serving-thread reads. */
export function getArchiveReadsOnThisThreadForTest(): number {
    return archiveReadsOnThisThread;
}

/**
 * Recover indexed text when the host no longer holds the cited messages.
 *
 * `notBeforeMs` enforces project-move attribution: rows the sidecar knows
 * were indexed before the session changed project (message_time_ms earlier
 * than the cutoff) are dropped. Only the sidecar carries per-row times, so
 * a cutoff read always uses the map path; rows the map never recorded are
 * dropped rather than served without a known attribution time.
 */
export function renderSearchArchiveWithStatus(
    db: ContextDatabase,
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
    archiveOnly = false,
    readRawIds = () => readRawSessionMessageIdOrdinalsForRange(sessionId, start, end),
    notBeforeMs?: number,
): SearchArchiveRender | null {
    archiveReadsOnThisThread += 1;
    return withMessageFtsSessionFilter(db, sessionId, (provenSessionFirst) => {
        const sessionFirst = notBeforeMs !== undefined ? true : provenSessionFirst;
        let rawIds: Map<string, number> | undefined;
        // The sidecar bounds modern stores to this session and ordinal range. A
        // legacy store can still have unmapped FTS rows, so retain a direct read.
        const rows = db.prepare(
            notBeforeMs !== undefined
                ? `SELECT f.message_ordinal AS ordinal, f.message_id AS id, f.role, f.content
                   FROM message_fts_rowid_map AS m
                   JOIN message_history_fts AS f ON f.rowid = m.fts_rowid
                   WHERE m.session_id = ? AND m.message_ordinal BETWEEN ? AND ?
                     AND f.session_id = ? AND f.message_ordinal BETWEEN ? AND ?
                     AND (m.message_time_ms IS NULL OR m.message_time_ms >= ?)
                   ORDER BY m.message_ordinal`
                : sessionFirst
                  ? `SELECT f.message_ordinal AS ordinal, f.message_id AS id, f.role, f.content
                   FROM message_fts_rowid_map AS m
                   JOIN message_history_fts AS f ON f.rowid = m.fts_rowid
                   WHERE m.session_id = ? AND m.message_ordinal BETWEEN ? AND ?
                     AND f.session_id = ? AND f.message_ordinal BETWEEN ? AND ?
                   ORDER BY m.message_ordinal`
                : `SELECT message_ordinal AS ordinal, message_id AS id, role, content
                   FROM message_history_fts
                   WHERE session_id = ? AND message_ordinal BETWEEN ? AND ?
                   ORDER BY CAST(message_ordinal AS INTEGER)`,
        );
        const blocks: string[] = [];
        let tokens = 0;
        let lastOrdinal = start - 1;
        let truncated = false;
        const bindings: (string | number)[] = sessionFirst
            ? [sessionId, start, end, sessionId, start, end]
            : [sessionId, start, end];
        if (notBeforeMs !== undefined) bindings.push(notBeforeMs);
        for (const row of rows.iterate(...bindings) as Iterable<ArchiveRow>) {
            if (!row.content) continue;
            if (!archiveOnly) {
                rawIds ??= readRawIds();
                if (rawIds.get(row.id) === row.ordinal) continue;
            }
            const block = `[${row.ordinal}] ${row.role === "user" ? "U" : "A"}: ${row.content}`;
            const cost = estimateTokens(block);
            if (blocks.length > 0 && tokens + cost > tokenBudget) {
                truncated = true;
                break;
            }
            blocks.push(block);
            tokens += cost;
            lastOrdinal = row.ordinal;
        }
        if (blocks.length === 0) return null;
        const text = [SEARCH_ARCHIVE_HEADER, "", ...blocks];
        if (truncated) {
            text.push(
                "",
                `Truncated at message ${lastOrdinal} (budget: ~${tokenBudget} tokens). Call ctx_expand(start=${lastOrdinal + 1}, end=${end}) for more archived text.`,
            );
        }
        return { text: text.join("\n"), truncated };
    });
}

export interface SearchArchiveRender {
    text: string;
    /** The renderer's own truncation decision, threaded to callers: the
     *  trailing continuation-hint line exists iff this is true. Never
     *  string-match the hint — archive content can contain a byte-identical
     *  line. */
    truncated: boolean;
}

/** String-only view of renderSearchArchiveWithStatus for existing callers. */
export function renderSearchArchive(
    db: ContextDatabase,
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
    archiveOnly = false,
    readRawIds?: () => Map<string, number>,
    notBeforeMs?: number,
): string | null {
    return (
        renderSearchArchiveWithStatus(
            db,
            sessionId,
            start,
            end,
            tokenBudget,
            archiveOnly,
            readRawIds ?? (() => readRawSessionMessageIdOrdinalsForRange(sessionId, start, end)),
            notBeforeMs,
        )?.text ?? null
    );
}

/** Banner prefix every render starts with; cross-session expands relabel it with the source session. */
const SEARCH_ARCHIVE_BANNER_PREFIX = "From the search archive: ";

/** The full archive banner: relabeling swaps only the prefix, keeping the archive-only notice. */
export const SEARCH_ARCHIVE_HEADER = `${SEARCH_ARCHIVE_BANNER_PREFIX}indexed text only; no surrounding messages or tool output.`;

/**
 * Rewrite an archive render for a cross-session expand: the banner names the
 * source session and the continuation hint carries its sessionId so a
 * follow-up expand stays on target instead of silently reading the caller's
 * own session.
 */
/**
 * Rewrite an archive render for a cross-session expand: the banner names the
 * source session and the continuation hint carries its sessionId so a
 * follow-up expand stays on target instead of silently reading the caller's
 * own session. `truncated` is the renderer's own decision, threaded through
 * the off-thread read — string-matching the hint is unsafe because archive
 * content can contain a byte-identical line.
 */
export function relabelCrossSessionArchive(
    text: string,
    targetSessionId: string,
    truncated: boolean,
): string {
    const labeled = text.startsWith(SEARCH_ARCHIVE_BANNER_PREFIX)
        ? `From the search archive of session ${targetSessionId}: ${text.slice(SEARCH_ARCHIVE_BANNER_PREFIX.length)}`
        : text;
    // Structural, never string-matched: only the renderer's own truncation
    // decision — threaded here by the caller — authorizes touching the
    // trailing line. When no hint was appended (not truncated) this is a
    // no-op regardless of what the content's last line looks like.
    if (!truncated) return labeled;
    const lines = labeled.split("\n");
    lines[lines.length - 1] = lines[lines.length - 1].replace(
        "Call ctx_expand(start=",
        `Call ctx_expand(sessionId="${targetSessionId}", start=`,
    );
    return lines.join("\n");
}

/**
 * Cross-session expands read the search archive only, so an empty archive is
 * not "the message does not exist": the session may be unindexed, pruned, or
 * the range may lie outside its indexed history.
 */
export function crossSessionEmptyArchiveMessage(
    targetSessionId: string,
    start: number,
    end: number,
): string {
    return `No indexed text for session ${targetSessionId} in range ${start}-${end}. That session may be unindexed, its text may have been pruned from the index, or the range may lie outside its indexed history. Cross-session expand reads the search archive (indexed text) only, so this is not proof that the original message was never there.`;
}

/** File-backed archive and exact raw-ordinal scans must not run on the serving thread. */
export interface SearchArchiveOffThreadResult {
    text: string | null;
    /** Structural: true iff the render truncated and appended its trailing
     *  continuation-hint line. Message content can mimic the hint
     *  byte-for-byte, so relabeling consults this flag instead of
     *  string-matching. */
    truncated: boolean;
}

export async function renderSearchArchiveOffThread(
    db: ContextDatabase,
    sessionId: string,
    start: number,
    end: number,
    tokenBudget: number,
    archiveOnly = false,
): Promise<SearchArchiveOffThreadResult> {
    const path = getSqliteDatabasePath(db);
    const provider = hasRawMessageProvider(sessionId);
    const source = rawMessageWorkerSource(sessionId);
    const offThreadReader = rawMessageOffThreadRangeReader(sessionId);
    let rawIds: Map<string, number> | undefined;
    if (!archiveOnly && !source && offThreadReader) {
        try {
            rawIds = await offThreadReader(start, end);
        } catch (error) {
            throw new Error(`Search archive worker unavailable: ${String(error)}`);
        }
    }
    // Private in-memory archives cannot be reopened. Their archive rows are cheap
    // to read here, but a provider's raw store must still never be scanned here.
    if (!path) {
        const rendered = renderSearchArchiveWithStatus(
            db,
            sessionId,
            start,
            end,
            tokenBudget,
            archiveOnly,
            rawIds
                ? () => rawIds
                : provider
                  ? () => {
                        throw new Error(
                            "Search archive worker unavailable: private archive has no off-thread source",
                        );
                    }
                  : undefined,
        );
        return { text: rendered?.text ?? null, truncated: rendered?.truncated ?? false };
    }
    if (!archiveOnly && source) {
        return readV2ArchiveOffThread(path, source.path, sessionId, {
            kind: "archive",
            start,
            end,
            tokenBudget,
            archiveOnly,
        });
    }
    if (!archiveOnly && provider && !rawIds) {
        throw new Error(
            "Search archive worker unavailable: raw-message provider has no off-thread source",
        );
    }
    const rawPath =
        !archiveOnly && !provider && openCodeDbExists()
            ? withReadOnlySessionDb(getSqliteDatabasePath)
            : null;
    const result = await runSessionWarmupWorker(
        {
            path,
            sessionId,
            searchArchive: {
                start,
                end,
                tokenBudget,
                archiveOnly,
                rawPath,
                rawIds: rawIds ? [...rawIds] : undefined,
            },
        },
        {},
    );
    if ("searchArchive" in result) return result.searchArchive;
    // Falling back to a synchronous scan on worker failure recreates the stall.
    throw new Error(
        `Search archive worker unavailable: ${"failure" in result ? `${result.failure}: ${result.detail}` : "unexpected reply"}`,
    );
}
