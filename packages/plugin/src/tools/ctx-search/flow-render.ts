/**
 * The memory-change ledger (the "status document") of one Strata cache slot:
 * where it lives, how it is read, and how its rows render.
 *
 * The write side records every `ctx_memory` change the archived copy does not
 * carry yet as one JSONL row in `pending-changes.<slot>.jsonl`, beside
 * `prefix_path`. The query side renders those rows into the query turn, so the
 * cache can answer about memories it has not been rewritten with: one query
 * carries the status document, the transient materials and the question.
 *
 * A rendered row uses the archive's own change-log shapes (增 / 正 / 讣), so the
 * block reads exactly like the 【变更流水】 section it stands in for. Those line
 * shapes are machine contracts the write side's snapshot arithmetic depends on,
 * which is why they stay in code while the block's prose lives in
 * strata-prompts.json.
 *
 * This module imports neither strata-ask.ts nor strata-cache.ts: both depend on
 * it, and a static import either way would close a cycle between them.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** One ledger row: the same shape the write side appends and parses. */
export interface StatusChange {
    op: "add" | "update" | "remove";
    id: number;
    kind?: "archive" | "delete" | "superseded";
    ts: string;
}

/** The memory facts a status row needs; a stored `Memory` satisfies it as is. */
export interface StatusMemoryView {
    id: number;
    category: string;
    content: string;
    updatedAt: number;
}

/**
 * A slot's basename is one path component, but not necessarily a filename.
 * Sanitize it, and append a digest whenever sanitizing changed it, so two slots
 * can never collide on one ledger file.
 */
function slotKeyOf(slotFile: string): string {
    const name = basename(slotFile);
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
    if (safe === name && safe.length > 0 && safe !== "." && safe !== "..") return safe;
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
    return `${safe.replace(/^\.+/, "") || "slot"}-${digest}`;
}

/**
 * The status document of one slot, beside its prefix file; slots sharing a
 * directory never mix. Names exactly the file the write side appends to
 * (strata-cache.ts `pendingChangesPathFor`), which is the whole point: the query
 * reads what the write side has not folded into the archive yet.
 */
export function statusChangesPathFor(prefixPath: string, slotFile: string): string {
    return join(dirname(prefixPath), `pending-changes.${slotKeyOf(slotFile)}.jsonl`);
}

/**
 * Extract the same valid rows as the write side's `parseChanges`. The query
 * side also compares the row count with the number of non-empty lines: any
 * skipped line makes the status unavailable rather than hiding a change.
 * The write side keeps its own parser and counts skipped lines separately.
 */
export function parseStatusChanges(raw: string): StatusChange[] {
    const changes: StatusChange[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const event = value as Record<string, unknown>;
        if (
            !Number.isSafeInteger(event.id) ||
            (event.id as number) < 1 ||
            typeof event.ts !== "string" ||
            !Number.isFinite(Date.parse(event.ts))
        ) {
            continue;
        }
        const id = event.id as number;
        const ts = new Date(event.ts).toISOString();
        if (event.op === "add" || event.op === "update") {
            changes.push({ op: event.op, id, ts });
        } else if (
            event.op === "remove" &&
            (event.kind === "archive" || event.kind === "delete" || event.kind === "superseded")
        ) {
            changes.push({ op: "remove", id, kind: event.kind, ts });
        }
    }
    return changes;
}

/**
 * One row, in the archive's own change-log shapes — or null when the row has
 * nothing to say to the current database. The selection rule is shared with the
 * write side (strata-cache.ts `renderChanges`), and the read and write budget
 * measures must never disagree on it:
 *
 * - `add` with a live memory renders 增. A vanished `add` (its memory is gone
 *   before the archive ever carried it) is skipped entirely — never a 讣,
 *   never priced — exactly like the write side.
 * - `update` with a live memory renders 正; with the memory gone, the old text
 *   is void and the row renders a 讣.
 * - `remove` renders a 讣 only when the memory is currently archived or
 *   deleted. A live memory renders nothing here, matching the write-side
 *   selection rule. Before sending a query, the reader must instead reject
 *   the whole status: a restore may have also edited text without a ledger
 *   row, so the slot's version cannot be trusted or voided with a 讣.
 */
export function renderStatusRow(
    change: StatusChange,
    memory: StatusMemoryView | null,
): string | null {
    if (change.op === "add") {
        if (!memory) return null;
        const seen = new Date(memory.updatedAt).toISOString();
        return `〔${change.ts}〕增：\n#${memory.id} [${memory.category}] 〔${seen}〕：\n${memory.content}`;
    }
    if (change.op === "update") {
        if (!memory) return `〔${change.ts}〕讣：#${change.id} 已删除/已归档，上文同号条目作废`;
        return `〔${change.ts}〕正：#${change.id} 已修改为：「${memory.content}」，上文旧文作废`;
    }
    if (memory) return null;
    return `〔${change.ts}〕讣：#${change.id} 已删除/已归档，上文同号条目作废`;
}
