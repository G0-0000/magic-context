import type { ContextDatabase } from "../../features/magic-context/storage";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import {
    isSuccessfulProviderCompletion,
    providerResponseFailed,
} from "../../shared/provider-response-completion";
import type { LkgRequestIdentity } from "./lkg-measured-request";
import {
    clearPendingMaterialization,
    hasOnlySystemHashMaterialization,
} from "./pending-materialization";

interface PreparedSystemDelivery {
    request: LkgRequestIdentity;
    hash?: string;
    db?: ContextDatabase;
    held: boolean;
    ownsHistoryRefresh?: boolean;
    deferRefresh?: (ownsHistoryRefresh: boolean) => void;
}
const pending = new BoundedSessionMap<PreparedSystemDelivery>(1000);
const refreshOwners = new BoundedSessionMap<{ hash: string; ownsHistoryRefresh: boolean }>(1000);

export function recordSystemRefreshOwnership(
    sessionId: string,
    hash: string,
    ownsHistoryRefresh: boolean,
): void {
    refreshOwners.set(sessionId, { hash, ownsHistoryRefresh });
}

function preparation(sessionId: string, request: LkgRequestIdentity) {
    const previous = pending.get(sessionId);
    if (previous?.request === request) return previous;
    const next: PreparedSystemDelivery = { request, held: false };
    pending.set(sessionId, next);
    return next;
}

/** Save the producer's final hash, not a later session-wide observation. Either
 * hook order is supported by pairing it with the provider request identity. */
export function recordSystemPromptForRequest(
    sessionId: string,
    request: LkgRequestIdentity | undefined,
    hash: string,
    db: ContextDatabase,
    ownsHistoryRefresh?: boolean,
): void {
    if (!request || !hash) return;
    if (ownsHistoryRefresh !== undefined)
        recordSystemRefreshOwnership(sessionId, hash, ownsHistoryRefresh);
    const owner = refreshOwners.get(sessionId);
    Object.assign(preparation(sessionId, request), {
        hash,
        db,
        ownsHistoryRefresh: owner?.hash === hash && owner.ownsHistoryRefresh,
    });
}

export function recordHeldHeadForRequest(
    sessionId: string,
    request: LkgRequestIdentity | undefined,
    deferRefresh?: (ownsHistoryRefresh: boolean) => void,
): void {
    if (request) Object.assign(preparation(sessionId, request), { held: true, deferRefresh });
}

export function isHeldHeadForRequest(
    sessionId: string,
    request: LkgRequestIdentity | undefined,
): boolean {
    const saved = pending.get(sessionId);
    return saved?.request === request && saved?.held === true;
}

/** Signed thinking can require the synthetic m[0]/m[1] messages to stay unchanged
 * even when a request sends new system instructions. A successful response for
 * that exact request proves the provider received those instructions. Record
 * their hash so the next pass does not misread it as another cache eviction;
 * do not change the frozen messages or authorize pending edits to them. */
export function acknowledgeSystemPromptDelivery(args: {
    sessionId: string;
    request: LkgRequestIdentity | undefined;
    responseId?: string;
    modelKey?: string;
    completedAt?: number;
    finish?: string;
    error?: unknown;
    v2?: boolean;
    createdAt?: number;
}): void {
    const saved = pending.get(args.sessionId);
    if (!saved || saved.request !== args.request || !args.responseId) return;
    const request = saved.request;
    if (request.modelKey !== args.modelKey) return;
    if (request.kind === "v1") {
        if (args.v2 || request.responseId !== args.responseId) return;
    } else if (
        !args.v2 ||
        request.previousResponseId === args.responseId ||
        args.createdAt === undefined ||
        args.createdAt < request.startedAt
    )
        return;
    if (providerResponseFailed(args)) {
        pending.delete(args.sessionId);
        return;
    }
    if (!isSuccessfulProviderCompletion(args)) return;
    pending.delete(args.sessionId);
    if (saved.held && saved.hash && saved.db) {
        try {
            updateSessionMeta(saved.db, args.sessionId, { cachedM0SystemHash: saved.hash });
            saved.deferRefresh?.(saved.ownsHistoryRefresh === true);
            refreshOwners.delete(args.sessionId);
        } catch (error) {
            // A failed hash write must not fail the provider's accepted reply.
            // A later successful request with the same frozen messages can retry it.
            sessionLog(
                args.sessionId,
                "system delivery acknowledgement failed (keeping pending work):",
                error,
            );
        }
    }
}

/** Already-delivered system instructions do not authorize a second cache rewrite.
 * Keep the associated history/materialization work in deferred queues, which
 * run only when another cause permits rebuilding. Preserve explicit flushes
 * and refresh requests that were pending for other reasons. */
export function deferDeliveredSystemRefresh(
    deps: {
        historyRefreshSessions: Set<string>;
        pendingMaterializationSessions: Set<string>;
        deferredHistoryRefreshSessions?: Set<string>;
        deferredMaterializationSessions?: Set<string>;
    },
    sessionId: string,
    ownsHistoryRefresh: boolean,
): void {
    if (!hasOnlySystemHashMaterialization(deps.pendingMaterializationSessions, sessionId)) return;
    clearPendingMaterialization(deps.pendingMaterializationSessions, sessionId);
    (deps.deferredMaterializationSessions ??= new Set()).add(sessionId);
    if (ownsHistoryRefresh && deps.historyRefreshSessions.delete(sessionId)) {
        (deps.deferredHistoryRefreshSessions ??= new Set()).add(sessionId);
    }
}

export function clearSystemPromptDelivery(sessionId: string): void {
    pending.delete(sessionId);
    refreshOwners.delete(sessionId);
}
