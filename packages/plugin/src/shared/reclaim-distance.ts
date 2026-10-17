export const RECLAIM_DISTANCE_USER_TURNS = 3;
export const RECLAIM_DISTANCE_WINDOW_FRACTION = 0.25;

export interface ReclaimDistanceEntry {
    /** Local content tokens, excluding Magic Context's history and reduction/note reminders. */
    tokens: number;
    /** One event per authored user-role message, after any folded tool results. */
    userTurn?: boolean;
    /** Durable identifier of the tool invocation whose result ends at this entry. */
    toolOutputTag?: number;
}

/** Magic Context's reminders do not start a task; host wake notices still advance it. */
export function isReclaimUserTurn(args: {
    role?: string;
    syntheticHead?: boolean;
    parts: readonly { kind: string; text?: string }[];
}): boolean {
    return (
        args.role === "user" &&
        !args.syntheticHead &&
        args.parts.some((part) => {
            if (part.kind !== "text" && part.kind !== "image" && part.kind !== "file") return false;
            if (part.kind !== "text") return true;
            return stripReclaimMcText(part.text ?? "").trim().length > 0;
        })
    );
}

/** Remove Magic Context's reduction/note reminders, not generic host wake notices. */
export function stripReclaimMcText(text: string): string {
    return text
        .replace(/^§\d+§\s*/, "")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, (reminder) =>
            /^(?:Your next step: call ctx_reduce on the outputs you've already used|Still unstamped:|Housekeeping: .* are reclaimable\. Stamp each output with ctx_reduce|.* are reclaimable\. Make a ctx_reduce pass now|.* are still unstamped\. Call ctx_reduce now)/.test(
                reminder.slice("<system-reminder>".length).trimStart(),
            )
                ? ""
                : reminder,
        )
        .replace(/<instruction name="deferred_notes">[\s\S]*?<\/instruction>/g, "");
}

/**
 * A free cache rebuild is not evidence that the model has moved on. An output
 * is far behind only after three newer user turns or a quarter-window of newer
 * content. Return the newest such output; callers drop against the PREVIOUS
 * durable bookmark before advancing it, so distance must survive two rebuilds.
 */
export function farBehindToolBookmark(
    entries: readonly ReclaimDistanceEntry[],
    usableWindow: number,
): number {
    let newerTurns = 0;
    let newerTokens = 0;
    let bookmark = 0;
    const seenOutputs = new Set<number>();
    const tokenDistance =
        usableWindow > 0 && Number.isFinite(usableWindow)
            ? usableWindow * RECLAIM_DISTANCE_WINDOW_FRACTION
            : Infinity;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry) continue;
        const tag = entry.toolOutputTag;
        // Multi-part outputs are positioned at their last result, not their call
        // or first chunk: an output must never count its own remaining payload.
        if (tag !== undefined && !seenOutputs.has(tag)) {
            seenOutputs.add(tag);
            if (newerTurns >= RECLAIM_DISTANCE_USER_TURNS || newerTokens >= tokenDistance) {
                bookmark = Math.max(bookmark, tag);
            }
        }
        if (entry.userTurn) newerTurns++;
        if (Number.isFinite(entry.tokens) && entry.tokens > 0) newerTokens += entry.tokens;
    }
    return bookmark;
}
