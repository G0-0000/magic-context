import type { ContextDatabase } from "../../features/magic-context/storage";
import { getTagsBySession } from "../../features/magic-context/storage";
import { makeToolCompositeKey } from "../../features/magic-context/tagger";
import { applyFlushedStatuses } from "./apply-operations";
import { neutralizeDroppedReasoningPart } from "./sentinel";
import { isThinkingPart } from "./tag-content-primitives";
import type { MessageLike, TagTarget, ThinkingLikePart } from "./tag-messages";
import { isTextPart } from "./tag-part-guards";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";

/** Replay durable decisions on an LKG candidate without allocating tags or retrying writes. */
export function replayCommittedDrops(
    db: ContextDatabase,
    sessionId: string,
    messages: MessageLike[],
): void {
    const tags = getTagsBySession(db, sessionId).filter((tag) => tag.status === "dropped");
    const toolTags = new Map(
        tags
            .filter((tag) => tag.type === "tool")
            .map((tag) => [makeToolCompositeKey(tag.toolOwnerMessageId ?? "", tag.messageId), tag]),
    );
    const textTags = new Map(
        tags.filter((tag) => tag.type !== "tool").map((tag) => [tag.messageId, tag]),
    );
    const byNumber = new Map(tags.map((tag) => [tag.tagNumber, tag]));
    const index: ToolCallIndex = new Map();
    const owners = new Map<string, string[]>();
    const targets = new Map<number, TagTarget>();
    let precedingThinking: ThinkingLikePart[] = [];
    const toolThinking = new Map<string, ThinkingLikePart[]>();
    const batch = new ToolMutationBatch(messages);
    for (const message of messages) {
        if (message.info.role === "user") precedingThinking = [];
        const thinking = message.parts.filter(isThinkingPart);
        for (let p = 0; p < message.parts.length; p++) {
            const part = message.parts[p];
            const observation = extractToolCallObservation(part);
            if (observation) {
                const { callId, kind } = observation;
                const pending = owners.get(callId) ?? [];
                const hostingKey = makeToolCompositeKey(message.info.id ?? "", callId);
                const owner =
                    kind === "invocation" || toolTags.has(hostingKey)
                        ? (message.info.id ?? "")
                        : (pending.shift() ?? message.info.id ?? "");
                if (kind === "invocation") pending.push(owner);
                owners.set(callId, pending);
                const key = makeToolCompositeKey(owner, callId);
                if (message.info.role === "tool" && !toolThinking.has(key))
                    toolThinking.set(key, precedingThinking);
                const entry = index.get(key) ?? { occurrences: [], hasResult: false };
                entry.occurrences.push({ message, part, kind });
                entry.hasResult ||= kind === "result" && partHasCompletedResult(part);
                index.set(key, entry);
            } else {
                const prefix = isTextPart(part) ? /^§(\d+)§\s/.exec(part.text) : null;
                const tag =
                    (prefix ? byNumber.get(Number(prefix[1])) : undefined) ??
                    textTags.get(`${message.info.id}:p${p}`) ??
                    textTags.get(`${message.info.id}:file${p}`);
                if (tag && tag.type !== "tool")
                    targets.set(tag.tagNumber, {
                        message,
                        setContent(content) {
                            if (isTextPart(part)) {
                                if (part.text === content) return false;
                                part.text = content;
                                for (const block of thinking) neutralizeDroppedReasoningPart(block);
                            } else message.parts[p] = { type: "text", text: content };
                            return true;
                        },
                    });
            }
        }
        if (message.info.role === "assistant" && !message.parts.some(isTextPart))
            precedingThinking = thinking;
    }
    for (const [key, entry] of index) {
        const tag =
            toolTags.get(key) ??
            toolTags.get(
                makeToolCompositeKey(
                    "",
                    extractToolCallObservation(entry.occurrences[0]?.part)?.callId ?? "",
                ),
            );
        if (tag)
            targets.set(
                tag.tagNumber,
                createToolDropTarget(key, toolThinking.get(key) ?? [], index, batch, tag.tagNumber),
            );
    }
    applyFlushedStatuses(sessionId, db, targets, tags);
    batch.finalize();
}
