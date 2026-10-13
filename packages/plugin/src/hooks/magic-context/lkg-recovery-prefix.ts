import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { type LkgEntryProjection, resolveLkgModelKeys } from "./lkg-replay";
import { getSlot, type LkgEntryNote, lkgContentDigest } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

interface RecoveryPrefix {
    inputs: { id: string; digest: string }[];
    json: string;
    untaggedInputIds: ReadonlySet<string>;
    modelKey: string | null;
    providerKey: string | null;
}

// If the in-memory served-output record is lost, the stored last-good request
// may predate raw messages sent while SQLite's writer was unavailable. Refuse
// recovery until a successful transform explicitly rebuilds the request;
// those older stored bytes cannot prove what the provider has cached.
const sessions = new BoundedSessionMap<{ prefix?: RecoveryPrefix }>(1000);

export function clearLkgRecoveryPrefixes(): void {
    sessions.clear();
}

export function clearLkgRecoverySession(sessionId: string): void {
    sessions.delete(sessionId);
}

export function noteLkgCapturedPrefix(sessionId: string): void {
    if (!sessions.has(sessionId)) sessions.set(sessionId, {});
}

export function noteLkgRecoveryPrefix(args: {
    sessionId: string;
    entry: LkgEntryNote;
    messages: MessageLike[];
    modelKey: string | null;
    providerKey: string | null;
}): boolean {
    const digests = [
        ...args.entry.entryContentDigests,
        ...args.entry.pristineTail.map(lkgContentDigest),
    ];
    if (digests.length !== args.entry.entryInputIds.length || digests.some((value) => !value))
        return false;
    const ids = args.entry.entryInputIds;
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
    sessions.set(args.sessionId, {
        prefix: {
            inputs: ids.map((id, index) => ({ id, digest: digests[index] as string })),
            json: JSON.stringify(args.messages),
            untaggedInputIds: new Set([
                ...(sessions.get(args.sessionId)?.prefix?.untaggedInputIds ?? []),
                ...ids.slice(args.entry.anchorIndex + 1),
            ]),
            modelKey: args.modelKey,
            providerKey: args.providerKey,
        },
    });
    return true;
}

export function readLkgRecoveryPrefix(
    sessionId: string,
    inputs: Pick<LkgEntryProjection, "id" | "contentDigest">[],
    messages: MessageLike[],
): { prefix?: RecoveryPrefix; rebuildReason?: string } {
    const state = sessions.get(sessionId);
    if (!state) return getSlot(sessionId) ? { rebuildReason: "lkg_restart_rebuild" } : {};
    const prefix = state.prefix;
    if (!prefix) return {};
    const keys = resolveLkgModelKeys(messages);
    if (
        prefix.modelKey !== keys.modelKey ||
        prefix.providerKey !== keys.providerKey ||
        inputs.length < prefix.inputs.length ||
        prefix.inputs.some(
            (input, index) =>
                input.id !== inputs[index]?.id || input.digest !== inputs[index]?.contentDigest?.(),
        )
    )
        return { rebuildReason: "lkg_recovery_input_rebuild" };
    return { prefix };
}

/** Extend the immutable provider-output record only after saving the successful transformed request. */
export function noteLkgHealthyPrefix(
    sessionId: string,
    inputs: LkgEntryProjection[],
    messages: MessageLike[],
    release: boolean,
): void {
    const prefix = sessions.get(sessionId)?.prefix;
    sessions.set(sessionId, {
        prefix:
            prefix && !release
                ? {
                      ...prefix,
                      inputs: inputs.map((input) => ({
                          id: input.id ?? "",
                          digest: input.contentDigest?.() ?? "",
                      })),
                      json: JSON.stringify(messages),
                  }
                : undefined,
    });
}

export function lkgRecoveryReplayUnproven(sessionId: string): boolean {
    return !sessions.has(sessionId) && !!getSlot(sessionId);
}

export function lkgRecoveryEntryUnproven(
    sessionId: string,
    entry: LkgEntryNote,
    messages: MessageLike[],
): boolean {
    if (!sessions.get(sessionId)?.prefix) return false;
    const digests = [...entry.entryContentDigests, ...entry.pristineTail.map(lkgContentDigest)];
    const inputs = entry.entryInputIds.map((id, index) => ({
        id,
        contentDigest: () => digests[index] ?? null,
    }));
    return !!readLkgRecoveryPrefix(sessionId, inputs, messages).rebuildReason;
}
