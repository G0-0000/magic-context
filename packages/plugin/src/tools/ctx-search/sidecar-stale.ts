/**
 * Sidecar-stale marker for the Strata session-file cache.
 *
 * The query path never saves, so it cannot rebuild the server-side token
 * sidecar itself. When a splice request cannot be served (the sidecar is
 * missing, stale or corrupt), the query falls back to classic retrieval and
 * this marker is left behind. The write side (strata-cache.ts) sees it on its
 * next maintenance run, rebuilds the slot — which rewrites the sidecar — and
 * clears it.
 *
 * One marker per prefix file (`<prefix_path>.sidecar-stale.json`), because two
 * slots of one project can share a directory. Every operation is best-effort: a
 * marker failure must never change a query's outcome. This module imports
 * nothing from strata-ask.ts or strata-cache.ts, so strata-cache can depend on
 * it without an import cycle.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SidecarStaleMarker {
    reason: string;
    at: string;
}

/** The marker lives beside the prefix file it belongs to. */
export function staleMarkerPathFor(prefixPath: string): string {
    return join(dirname(prefixPath), `${basename(prefixPath)}.sidecar-stale.json`);
}

export function markSidecarStale(prefixPath: string, reason: string): void {
    try {
        const path = staleMarkerPathFor(prefixPath);
        const temp = `${path}.${process.pid}.tmp`;
        const marker: SidecarStaleMarker = { reason, at: new Date().toISOString() };
        writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
        renameSync(temp, path);
    } catch {
        // best-effort: a marker failure never affects the caller
    }
}

export function readSidecarStale(prefixPath: string): SidecarStaleMarker | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(staleMarkerPathFor(prefixPath), "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const row = parsed as { reason?: unknown; at?: unknown };
        if (typeof row.reason !== "string" || typeof row.at !== "string") return null;
        return { reason: row.reason, at: row.at };
    } catch {
        return null;
    }
}

export function clearSidecarStale(prefixPath: string): void {
    try {
        rmSync(staleMarkerPathFor(prefixPath), { force: true });
    } catch {
        // best-effort
    }
}
