/**
 * Keep the last row per memory id after ordering its add before other changes,
 * without discarding rows the caller cannot parse. An add can be recorded late
 * by a different process, but the insertion itself precedes any update or
 * removal. The slot may already contain that insertion, so retain the later
 * correction or obituary even when its ledger row physically precedes the add.
 */
export function reduceLedgerRows<T>(
    rows: readonly T[],
    changeOf: (row: T) => { id: number; op: "add" | "update" | "remove" } | null,
): T[] {
    const survivors = new Map<number, { index: number; op: "add" | "update" | "remove" }>();
    const removed = new Set<number>();
    for (const [index, row] of rows.entries()) {
        const change = changeOf(row);
        if (!change) continue;
        const previous = survivors.get(change.id);
        if (previous && change.op === "add" && previous.op !== "add") {
            removed.add(index);
            continue;
        }
        if (previous) removed.add(previous.index);
        survivors.set(change.id, { index, op: change.op });
    }
    return rows.filter((_, index) => !removed.has(index));
}
