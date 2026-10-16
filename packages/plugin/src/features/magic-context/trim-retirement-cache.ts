import type { Database, Statement } from "../../shared/sqlite";

const MAX_RETAINED_IDS = 200_000;
interface RetiredIds {
    ids: Set<string>;
    folded: Map<string, Set<string>>;
    hasNul: boolean;
}
interface Connection {
    stamp: Statement;
    version: number;
    sessions: Map<string, RetiredIds>;
}
const connections = new WeakMap<Database, Connection>();
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

function inTransaction(db: Database): boolean {
    const native = db as unknown as { inTransaction?: boolean; isTransaction?: boolean };
    return native.inTransaction === true || native.isTransaction === true;
}

export function clearTrimRetirement(db: Database, sessionId: string): void {
    connections.get(db)?.sessions.delete(sessionId);
}

export function hasTrimRetirement(db: Database, sessionId: string): boolean {
    return connections.get(db)?.sessions.has(sessionId) ?? false;
}

/** An insert, rekey or restoration from compacted status can give a previously
 * checked source another tag to retire. Forget matching source IDs, not unrelated
 * tail history, so ordinary writes do not force the entire session to be scanned. */
export function invalidateTrimRetirement(
    db: Database,
    sessionId: string,
    ...identities: (string | null)[]
): void {
    const state = connections.get(db)?.sessions.get(sessionId);
    if (!state) return;
    if (state.hasNul || identities.some((id) => id?.includes("\0"))) {
        clearTrimRetirement(db, sessionId);
        return;
    }
    const forgetFolded = (key: string) => {
        for (const id of state.folded.get(key) ?? []) state.ids.delete(id);
        state.folded.delete(key);
    };
    for (const identity of identities) {
        if (identity === null) continue;
        // Forgetting spellings that differ only in ASCII case is conservative:
        // it can cause an extra scan, but cannot skip a tag that needs retirement.
        const value = asciiLower(identity);
        forgetFolded(value);
        for (let colon = value.indexOf(":"); colon >= 0; colon = value.indexOf(":", colon + 1)) {
            if (value[colon + 1] === "p" || value.slice(colon + 1, colon + 5) === "file")
                forgetFolded(value.slice(0, colon));
        }
    }
}

/** Remember source IDs only after their matching tags have been retired durably.
 * A restart, eviction or rollback forces a fresh scan. A commit from another
 * SQLite connection does too, because it may have added or restored those tags. */
export function retireTrimmedSources(
    db: Database,
    sessionId: string,
    messageIds: readonly string[],
    retire: (ids: readonly string[]) => number,
): number {
    if (messageIds.length === 0) return 0;
    if (inTransaction(db)) {
        clearTrimRetirement(db, sessionId);
        return retire(messageIds);
    }
    let connection = connections.get(db);
    if (!connection) {
        connection = {
            stamp: db.prepare("PRAGMA data_version"),
            version: -1,
            sessions: new Map(),
        };
        connections.set(db, connection);
    }
    const version = () => (connection.stamp.get() as { data_version: number }).data_version;
    const before = version();
    if (before !== connection.version) {
        connection.sessions.clear();
        connection.version = before;
    }
    const state = connection.sessions.get(sessionId) ?? {
        ids: new Set<string>(),
        folded: new Map<string, Set<string>>(),
        hasNul: false,
    };
    const pending = [...new Set(messageIds.filter((id) => !state.ids.has(id)))];
    const changed = pending.length > 0 ? retire(pending) : 0;
    // Another SQLite connection may add or rekey tags between retirement batches.
    // The earlier scan could have missed those rows, so do not remember these IDs.
    if (version() !== before) {
        connection.sessions.clear();
        return changed;
    }
    for (const id of pending) {
        state.ids.add(id);
        const folded = asciiLower(id);
        const siblings = state.folded.get(folded) ?? new Set<string>();
        siblings.add(id);
        state.folded.set(folded, siblings);
        if (id.includes("\0")) state.hasNul = true;
    }
    connection.sessions.delete(sessionId);
    connection.sessions.set(sessionId, state);
    let retained = 0;
    for (const entry of connection.sessions.values()) retained += entry.ids.size;
    for (const [id, entry] of connection.sessions) {
        if (retained <= MAX_RETAINED_IDS && connection.sessions.size <= 100) break;
        connection.sessions.delete(id);
        retained -= entry.ids.size;
    }
    return changed;
}
