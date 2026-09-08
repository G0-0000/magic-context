import { isRecord } from "../../shared/record-type-guard";
import { droppedInputMarker } from "./dropped-input-guard";
import { applyEditMarkerToInput } from "./edit-marker";
import { stripTagPrefix } from "./tag-content-primitives";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";

export type ToolDropResult = "removed" | "truncated" | "absent" | "incomplete";

interface ToolCallObservation {
    callId: string;
    kind: "invocation" | "result";
}

export interface IndexedOccurrence {
    message: MessageLike;
    part: unknown;
    kind: "invocation" | "result";
}

export interface ToolCallIndexEntry {
    occurrences: IndexedOccurrence[];
    hasResult: boolean;
}

export type ToolCallIndex = Map<string, ToolCallIndexEntry>;

const DROP_PREFIX = "[dropped";
const IGNORE_PART_TYPES = new Set([
    "thinking",
    "reasoning",
    "redacted_thinking",
    "meta",
    "step-start",
    "step-finish",
]);

function isToolCallId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function getToolContent(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    if (part.type === "tool" && isRecord(part.state)) {
        return typeof part.state.output === "string" ? part.state.output : undefined;
    }
    if (part.type === "tool_result") {
        return typeof part.content === "string" ? part.content : undefined;
    }
    return undefined;
}

function setToolContent(part: unknown, content: string): void {
    if (!isRecord(part)) return;
    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = content;
        return;
    }
    if (part.type === "tool_result") {
        part.content = content;
    }
}

/**
 * Deep-copy a tool part so a clamp/drop can rewrite the copy without touching
 * the original object. The transform receives `args.messages` whose part
 * objects are the LIVE instances OpenCode still holds (it reads the same
 * objects back for the wire and, for a tool that is still executing, for the
 * execution itself). Rewriting one of those in place can corrupt a live run —
 * e.g. clamping a background task part's `input.prompt` while the child agent
 * is still spawning from it. Cloning first confines every byte change to the
 * wire copy that replaces the part in the message array. Parts are plain
 * JSON-serializable data, so structuredClone (with a JSON fallback for
 * runtimes/edge values that reject it) is sufficient.
 */
function clonePart(part: unknown): unknown {
    if (part === null || typeof part !== "object") return part;
    try {
        return structuredClone(part);
    } catch {
        try {
            return JSON.parse(JSON.stringify(part));
        } catch {
            // Non-serializable part: return it as-is rather than throw. The
            // clamp then mutates the original, which is the pre-existing
            // behavior; this branch is only reachable for exotic parts that
            // cannot be cloned or serialized at all.
            return part;
        }
    }
}

/**
 * Apply a clamp to a throwaway clone of the occurrence's part and swap the
 * clone into the message's parts array, leaving the original part object
 * byte-identical. This is the mutation-safety guarantee: the wire (the array
 * OpenCode reads back) carries the clamped copy, while the live object OpenCode
 * may still execute from is never touched. The swap is by reference identity
 * (`indexOf`), so it is a no-op if the part is no longer in the array.
 */
function clampCloneInPlace(occurrence: IndexedOccurrence, clamp: (part: unknown) => void): void {
    const clone = clonePart(occurrence.part);
    clamp(clone);
    const parts = occurrence.message.parts;
    const index = parts.indexOf(occurrence.part);
    if (index >= 0) parts[index] = clone;
}

function truncateToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;

    // Keep the call/result structure for provider pairing, but remove every
    // executable argument key. The marker is derived only from the durable tag,
    // so a frozen truncated drop replays byte-identically.
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    // OpenCode format: { type: "tool", state: { input: {...}, output: "..." } }
    if (part.type === "tool" && isRecord(part.state)) {
        const state = part.state;
        state.output = sentinel;

        state.input = droppedInputMarker(tagId);

        return;
    }

    // Anthropic format: { type: "tool_result", content: "..." }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }

    // OpenCode invocation format: { type: "tool-invocation", args: {...} }
    if (part.type === "tool-invocation") {
        part.args = droppedInputMarker(tagId);
        return;
    }

    // Anthropic invocation format: { type: "tool_use", input: {...} }
    if (part.type === "tool_use") {
        part.input = droppedInputMarker(tagId);
    }
}

/**
 * Edit-marker variant of `truncateToolPart` for a superseded edit/write: keep
 * the tool_use call, output → `[dropped §N§]`, but preserve `filePath` verbatim
 * and clamp the diff to a region hint (instead of replacing every argument).
 * A SEPARATE path from `truncateToolPart`: it must never alter the existing
 * skeleton bytes. Deterministic + idempotent (see edit-marker.ts).
 */
function editMarkerToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = sentinel;
        if (isRecord(part.state.input)) applyEditMarkerToInput(part.state.input);
        return;
    }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) {
        applyEditMarkerToInput(part.args as Record<string, unknown>);
        return;
    }
    if (part.type === "tool_use" && isRecord(part.input)) {
        applyEditMarkerToInput(part.input as Record<string, unknown>);
    }
}

/**
 * Non-mutating read of a tool part's input object across the formats
 * `truncateToolPart` handles. Returns null when the part carries no input.
 * Used by supersession selection (read `ctx_note` action / edit `filePath`)
 * without touching the wire.
 */
function readToolPartInput(part: unknown): Record<string, unknown> | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
        return part.state.input;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) return part.args;
    if (part.type === "tool_use" && isRecord(part.input)) return part.input;
    return null;
}

export function hasMeaningfulPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    const type = part.type;
    if (type === "text") {
        if (typeof part.text !== "string") return false;
        return stripTagPrefix(part.text).trim().length > 0;
    }
    if (typeof type !== "string") return false;
    if (IGNORE_PART_TYPES.has(type)) return false;
    return true;
}

function clearThinkingParts(thinkingParts: ThinkingLikePart[]): void {
    for (const part of thinkingParts) {
        if (part.thinking !== undefined) part.thinking = "[cleared]";
        if (part.text !== undefined) part.text = "[cleared]";
    }
}

function messageHasNativeReasoning(message: MessageLike): boolean {
    return message.parts.some((part) => {
        if (!isRecord(part)) return false;
        return ["thinking", "reasoning", "redacted_thinking"].includes(String(part.type));
    });
}

/**
 * True when a tool part carries a COMPLETED result — i.e. the arc is closed and
 * OpenCode will not read its input again. This is the selection gate that keeps
 * open arcs (an invocation with no result yet) out of every drop/clamp selector.
 *
 * OpenCode's single-part `{ type: "tool" }` representation is classified as a
 * "result" observation by its TYPE even while the call is still pending/running
 * (no output written yet). The arc is closed in either of two arms: a completed
 * result (`state.output` is a string) OR an errored call (`state.status ===
 * "error"`, carrying `state.error`). OpenCode serializes an errored part as an
 * `output-error` block built from `state.error` and never reads its input again
 * (opencode message-v2.ts error arm), so it is just as safe to reclaim as a
 * completed one — excluding it would leak bulky inputs (e.g. a failed write with
 * a large content arg). Pending/running parts have neither an output nor an
 * error status and stay excluded. Anthropic's separate `tool_result` part only
 * exists after the call finished, so it always counts. Invocation-shaped parts
 * (`tool-invocation` / `tool_use`) never carry a result and are excluded here.
 */
export function partHasCompletedResult(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type === "tool") {
        if (!isRecord(part.state)) return false;
        return typeof part.state.output === "string" || part.state.status === "error";
    }
    return part.type === "tool_result";
}

export function extractToolCallObservation(part: unknown): ToolCallObservation | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "result" };
    }
    if (part.type === "tool-invocation" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "invocation" };
    }
    if (part.type === "tool_use" && isToolCallId(part.id)) {
        return { callId: part.id, kind: "invocation" };
    }
    if (part.type === "tool_result" && isToolCallId(part.tool_use_id)) {
        return { callId: part.tool_use_id, kind: "result" };
    }
    return null;
}

function isDropContent(content: string): boolean {
    return content.startsWith(DROP_PREFIX);
}

export class ToolMutationBatch {
    private partsToRemove = new Set<unknown>();
    private affectedMessages = new Set<MessageLike>();
    private messages: MessageLike[];

    constructor(messages: MessageLike[]) {
        this.messages = messages;
    }

    markForRemoval(occurrence: IndexedOccurrence): void {
        this.partsToRemove.add(occurrence.part);
        this.affectedMessages.add(occurrence.message);
    }

    finalize(): void {
        if (this.partsToRemove.size === 0) return;

        for (const message of this.affectedMessages) {
            message.parts = message.parts.filter((p) => !this.partsToRemove.has(p));
        }

        for (let i = this.messages.length - 1; i >= 0; i -= 1) {
            if (!this.messages[i].parts.some(hasMeaningfulPart)) {
                this.messages.splice(i, 1);
            }
        }

        this.partsToRemove.clear();
        this.affectedMessages.clear();
    }
}

/**
 * Build a TagTarget for a single tool composite key
 * (`<ownerMsgId>\x00<callId>`).
 *
 * v3.3.1 Layer C: pre-fix this took a bare `callId`. Two assistant turns
 * reusing the same callId produced two TagTargets that both pointed at
 * the same `index.get(callId)` entry — last-write-wins on `targets.set`
 * silently merged them into one drop target, and a queued drop on the
 * older tag would mutate the newer turn's content. Composite keys
 * guarantee one TagTarget per (owner, callId) pair, so each turn's tag
 * gets its own independent drop scope.
 *
 * The `index` map is keyed by composite key as well — see
 * `tag-messages.ts` for the matching producer.
 */
export function createToolDropTarget(
    compositeKey: string,
    thinkingParts: ThinkingLikePart[],
    index: ToolCallIndex,
    batch: ToolMutationBatch,
    tagId: number,
): {
    setContent: (content: string) => boolean;
    drop: () => ToolDropResult;
    truncate: () => ToolDropResult;
    editMarker: () => ToolDropResult;
    /**
     * Non-mutating predicate: would drop()/truncate() actually remove bytes?
     * False for an absent (compacted-away) or incomplete (invocation present,
     * no result part) entry — both return early without reclaiming anything.
     * The tiered emergency planner must filter on this, not on the mere
     * presence of a drop() function: counting a no-reclaim tag as droppable
     * makes the plan stop early and under-evict below the ceiling.
     */
    canDrop: () => boolean;
    requiresToolArcSkeleton: boolean;
    readInput: () => Record<string, unknown> | null;
} {
    const drop = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            batch.markForRemoval(occurrence);
        }
        clearThinkingParts(thinkingParts);
        index.delete(compositeKey);
        return "removed";
    };

    const truncate = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            // Drop result bytes and replace invocation arguments with a
            // non-executable marker. Rewrite a CLONE so the live part object
            // OpenCode may still execute from stays byte-identical.
            clampCloneInPlace(occurrence, (part) => truncateToolPart(part, tagId));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    const editMarker = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            // Same mutation-safety guarantee as truncate(): clamp a clone, never
            // the live part object.
            clampCloneInPlace(occurrence, (part) => editMarkerToolPart(part, tagId));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    return {
        setContent: (content: string): boolean => {
            if (isDropContent(content)) {
                drop();
                return true;
            }

            const entry = index.get(compositeKey);
            if (!entry) return false;

            let changed = false;
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "result") continue;
                const prevContent = getToolContent(occurrence.part);
                if (prevContent !== content) {
                    setToolContent(occurrence.part, content);
                    changed = true;
                }
            }
            return changed;
        },
        drop,
        truncate,
        editMarker,
        canDrop: (): boolean => {
            const entry = index.get(compositeKey);
            return !!entry && entry.occurrences.length > 0 && entry.hasResult;
        },
        requiresToolArcSkeleton:
            thinkingParts.length > 0 ||
            (index
                .get(compositeKey)
                ?.occurrences.some((occurrence) => messageHasNativeReasoning(occurrence.message)) ??
                false),
        readInput: (): Record<string, unknown> | null => {
            const entry = index.get(compositeKey);
            if (!entry) return null;
            // Prefer an invocation occurrence's input, but fall back to ANY
            // occurrence carrying readable input: a COMPLETED OpenCode tool part
            // is `{ type:"tool", state:{ input, output } }`, classified as a
            // "result" occurrence, yet it still holds the call's input, which is
            // where an edit/write's filePath lives once the call finished.
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "invocation") continue;
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            for (const occurrence of entry.occurrences) {
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            return null;
        },
    };
}
