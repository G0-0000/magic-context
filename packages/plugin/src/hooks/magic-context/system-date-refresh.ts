type Channel = {
    permitted: Map<string, boolean>;
    waiting: Map<string, (permitted: boolean) => void>;
};
const channels = new WeakMap<Set<string>, Channel>();
const outputUpdates = new WeakMap<string[], () => void>();

/** Reapply deferred host dates after the host copied the system prompt strings. */
export function bindSystemDateOutput(system: string[], update: () => void): void {
    outputUpdates.set(system, update);
}

export function publishSystemDateOutput(system: string[]): void {
    outputUpdates.get(system)?.();
    outputUpdates.delete(system);
}

/** Share whether the messages hook actually rebuilt the cached prefix, so dates
 * advance on that request whether the system hook runs before or after it. */
export function registerSystemDateRefresh(historyRefreshSessions: Set<string>): void {
    if (!channels.has(historyRefreshSessions))
        channels.set(historyRefreshSessions, { permitted: new Map(), waiting: new Map() });
}

export function systemDateRefreshPermission(
    historyRefreshSessions: Set<string>,
    sessionId: string,
): boolean | undefined {
    return channels.get(historyRefreshSessions)?.permitted.get(sessionId);
}

export function waitForSystemDateRefresh(
    historyRefreshSessions: Set<string>,
    sessionId: string,
    apply: (permitted: boolean) => void,
): boolean {
    const channel = channels.get(historyRefreshSessions);
    if (!channel) return false;
    channel.waiting.set(sessionId, apply);
    return true;
}

export function finishSystemDateRefresh(
    historyRefreshSessions: Set<string>,
    sessionId: string,
    permitted: boolean,
): void {
    const channel = channels.get(historyRefreshSessions);
    if (!channel) return;
    channel.permitted.set(sessionId, permitted);
    const apply = channel.waiting.get(sessionId);
    channel.waiting.delete(sessionId);
    apply?.(permitted);
}

export function clearSystemDateRefresh(
    historyRefreshSessions: Set<string>,
    sessionId: string,
): void {
    const channel = channels.get(historyRefreshSessions);
    channel?.permitted.delete(sessionId);
    channel?.waiting.delete(sessionId);
}
