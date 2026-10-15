import {
    type ReplayDocument,
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import type { Database } from "../../shared/sqlite";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import { encodeOpenCodeMessagesToCk } from "./module-wire";
import type { MessageLike } from "./transform-operations";

interface ServedRawPart {
    messageId: string;
    index: number;
    blockIds: string[];
    part: Record<string, unknown>;
}

function records(doc: ReplayDocument): ServedRawPart[] {
    if (doc.rustServedRaw === undefined) return [];
    if (!Array.isArray(doc.rustServedRaw))
        throw new EmergencyFailClosedError("Invalid Rust served-raw evidence");
    for (const row of doc.rustServedRaw) {
        if (
            !row ||
            typeof row.messageId !== "string" ||
            !Number.isSafeInteger(row.index) ||
            row.index < 0 ||
            !Array.isArray(row.blockIds) ||
            !row.blockIds.every((id: unknown) => typeof id === "string") ||
            !row.part ||
            typeof row.part !== "object"
        )
            throw new EmergencyFailClosedError("Invalid Rust served-raw part");
    }
    return doc.rustServedRaw;
}

export function servedRawBlockIds(db: Database, sessionId: string): string[] {
    return records(readReplayEnvelope(db, sessionId)).flatMap((row) => row.blockIds);
}

/** Save raw parts before returning a replay, including messages appended since the last replay. */
export function noteRustServedRaw(
    db: Database,
    sessionId: string,
    input: MessageLike[],
    served: MessageLike[],
): void {
    const additions: ServedRawPart[] = [];
    const byId = new Map(
        served
            .filter((message) => typeof message?.info?.id === "string")
            .map((message) => [message.info.id, message]),
    );
    for (const message of input) {
        const visible = byId.get(message.info.id);
        if (!visible) continue;
        let offset = 0;
        for (const [index, value] of message.parts.entries()) {
            if (!value || typeof value !== "object") continue;
            const part = value as Record<string, unknown>;
            const count = (
                encodeOpenCodeMessagesToCk([{ ...message, parts: [part] }])[0].ck
                    .content as unknown[]
            ).length;
            const actual =
                typeof part.id === "string"
                    ? visible.parts.find(
                          (candidate) => (candidate as Record<string, unknown>).id === part.id,
                      )
                    : visible.parts[index];
            const status = (part.state as { status?: string } | undefined)?.status;
            const reachesProvider =
                !(part.type === "text" && part.ignored === true) &&
                ![
                    "compaction",
                    "step-start",
                    "step-finish",
                    "snapshot",
                    "patch",
                    "agent",
                    "retry",
                ].includes(String(part.type)) &&
                (part.type !== "tool" || status === "completed" || status === "error");
            // An unfinished native tool is not yet a provider call/result. Holding
            // its running state would hide its eventual completion from the provider.
            if (reachesProvider && count > 0 && JSON.stringify(actual) === JSON.stringify(part)) {
                additions.push({
                    messageId: message.info.id as string,
                    index,
                    blockIds: Array.from(
                        { length: count },
                        (_, i) => `${message.info.id}#${offset + i}`,
                    ),
                    part,
                });
            }
            offset += count;
        }
    }
    if (!additions.length) return;
    if (
        !updateReplayDocument(db, sessionId, (doc) => {
            const rows = records(doc);
            const key = (row: ServedRawPart) => `${row.messageId}:${row.part.id ?? row.index}`;
            const merged = new Map(rows.map((row) => [key(row), row]));
            for (const row of additions) merged.set(key(row), row);
            const next = [...merged.values()];
            if (JSON.stringify(rows) === JSON.stringify(next)) return false;
            doc.version = 2;
            doc.rustServedRaw = next;
            return true;
        })
    )
        throw new EmergencyFailClosedError("Cannot persist Rust served-raw evidence");
}

/** Rejecting a saved replay must not add tags or strip thinking from parts already sent raw. */
export function preserveRustServedRaw(
    db: Database,
    sessionId: string,
    output: MessageLike[],
): void {
    const rows = records(readReplayEnvelope(db, sessionId));
    if (!rows.length) return;
    const byId = new Map(output.map((message) => [message.info.id, message]));
    for (const row of rows) {
        const message = byId.get(row.messageId);
        if (!message)
            throw new EmergencyFailClosedError(
                `Rust served-raw message disappeared: ${row.messageId}`,
            );
        const parts = message.parts as Record<string, unknown>[];
        if (typeof row.part.id !== "string") {
            // Without a native ID, accept only an unchanged part or an exact,
            // reversible tag-only change at the original position; never guess by type.
            const candidate = parts[row.index];
            if (JSON.stringify(candidate) === JSON.stringify(row.part)) continue;
            const taggedText =
                row.part.type === "text" &&
                typeof row.part.text === "string" &&
                typeof candidate?.text === "string" &&
                /^§\d+§ /.test(candidate.text) &&
                candidate.text.replace(/^§\d+§ /, "") === row.part.text;
            if (
                taggedText &&
                JSON.stringify({ ...candidate, text: row.part.text }) === JSON.stringify(row.part)
            ) {
                parts[row.index] = structuredClone(row.part);
            } else {
                throw new EmergencyFailClosedError(
                    `Ambiguous Rust served-raw part: ${row.messageId}#${row.index}`,
                );
            }
            continue;
        }
        const matches = parts.flatMap((part, i) => (part.id === row.part.id ? [i] : []));
        if (matches.length > 1)
            throw new EmergencyFailClosedError("Duplicate Rust served-raw part ID");
        const index = matches[0] ?? -1;
        if (index >= 0) parts[index] = structuredClone(row.part);
        else if (["reasoning", "thinking", "redacted_thinking"].includes(String(row.part.type))) {
            parts.splice(row.index, 0, structuredClone(row.part));
        } else
            throw new EmergencyFailClosedError(`Rust served-raw part disappeared: ${row.part.id}`);
    }
}

/** After a successful prefix_bust_permitted pass, forget only the raw parts its output replaced. */
export function releaseRustServedRaw(db: Database, sessionId: string, output: MessageLike[]): void {
    if (!records(readReplayEnvelope(db, sessionId)).length) return;
    const byId = new Map(output.map((message) => [message.info.id, message]));
    if (
        !updateReplayDocument(db, sessionId, (doc) => {
            const rows = records(doc);
            const kept = rows.filter((row) => {
                const parts = byId.get(row.messageId)?.parts;
                const part =
                    typeof row.part.id === "string"
                        ? parts?.find(
                              (value) => (value as Record<string, unknown>).id === row.part.id,
                          )
                        : parts?.[row.index];
                return JSON.stringify(part) === JSON.stringify(row.part);
            });
            if (kept.length === rows.length) return false;
            doc.version = 2;
            doc.rustServedRaw = kept;
            return true;
        })
    )
        throw new EmergencyFailClosedError("Cannot release Rust served-raw evidence");
}
