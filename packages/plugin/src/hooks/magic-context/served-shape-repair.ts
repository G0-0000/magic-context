import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import type { Database } from "../../shared/sqlite";
import { stripPersistedAssistantText } from "./tag-content-primitives";
import type { MessageLike } from "./tag-messages";

type TextDecision = { index: number; text: string };
type Decisions = Record<string, TextDecision[]>;
const sources = new WeakMap<MessageLike["info"], TextDecision[]>();

/** Remember provenance before tagging can replace the copied prefix. */
export function markServedShapeRepair(info: MessageLike["info"], parts: TextDecision[]): void {
    if (parts.length) sources.set(info, parts);
}

function parseDecisions(value: unknown): Decisions {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid served-shape replay decisions");
    for (const entries of Object.values(value)) {
        if (
            !Array.isArray(entries) ||
            entries.some(
                (entry) =>
                    !entry ||
                    !Number.isSafeInteger(entry.index) ||
                    entry.index < 0 ||
                    typeof entry.text !== "string" ||
                    !entry.text.trim(),
            )
        )
            throw new Error("Invalid served-shape text decision");
    }
    return value as Decisions;
}

function readDecisions(db: Database, sessionID: string): Decisions {
    return parseDecisions(readReplayEnvelope(db, sessionID).servedShapeRepair);
}

/** Only previously undecided copied-tag parts originate a repair rebuild. */
export function prepareServedShapeRepair(
    db: Database,
    sessionID: string,
    messages: MessageLike[],
    readPreviouslyServed?: () => readonly unknown[] | null,
    snapshot?: { servedShapeRepair?: unknown },
) {
    let decisions = snapshot
        ? parseDecisions(snapshot.servedShapeRepair)
        : readDecisions(db, sessionID);
    const pending: Decisions = {};
    for (const message of messages) {
        const id = message.info.id;
        if (typeof id !== "string") continue;
        const candidates = sources.get(message.info);
        if (candidates && !Object.hasOwn(decisions, id)) pending[id] = candidates;
    }
    // An unseen suffix gets its first representation without invalidating a
    // prefix. Only an old empty slot (or missing replay evidence) needs a bust.
    const previouslyServed = Object.keys(pending).length ? readPreviouslyServed?.() : null;
    const needsRebuild = Object.keys(pending).some((id) => {
        if (!previouslyServed) return true;
        const previous = previouslyServed.find((value): value is MessageLike => {
            if (!value || typeof value !== "object") return false;
            const message = value as Partial<MessageLike>;
            return message.info?.id === id && Array.isArray(message.parts);
        });
        return (
            previous !== undefined &&
            pending[id].some(({ index }) => {
                const part = previous.parts[index] as { type?: string; text?: string } | undefined;
                return part?.type === "text" && typeof part.text === "string" && !part.text.trim();
            })
        );
    });
    return {
        pending: Object.keys(pending).length > 0,
        needsRebuild,
        messageIDs: new Set([...Object.keys(decisions), ...Object.keys(pending)]),
        apply(allowed: boolean): number {
            if (Object.keys(pending).length && (allowed || !needsRebuild)) {
                if (
                    !updateReplayDocument(db, sessionID, (doc) => {
                        doc.version = 2;
                        doc.servedShapeRepair = {
                            ...pending,
                            ...parseDecisions(doc.servedShapeRepair),
                        };
                        return true;
                    })
                )
                    throw new Error("Could not persist served-shape repair");
                // Replay the CAS winner, never an uncommitted local choice.
                decisions = readDecisions(db, sessionID);
            }
            let changed = 0;
            for (const message of messages) {
                const id = message.info.id;
                if (typeof id !== "string") continue;
                for (const decision of decisions[id] ?? []) {
                    const part = message.parts[decision.index] as
                        | { type?: string; text?: string }
                        | undefined;
                    if (part?.type !== "text") continue;
                    // An intentional drop/compression wins over a copied-tag repair.
                    if (
                        typeof part.text !== "string" ||
                        stripPersistedAssistantText(part.text).trim()
                    )
                        continue;
                    if (part.text !== decision.text) {
                        part.text = decision.text;
                        changed++;
                    }
                }
            }
            return changed;
        },
    };
}
