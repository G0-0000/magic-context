import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type OpenCodeDbPathSource = "OPENCODE_DB" | "channel" | "default" | "discovered";

export interface OpenCodeDbPathResolution {
    path: string;
    source: OpenCodeDbPathSource;
    channel: string | null;
}

export interface OpenCodeDbReadFailure extends OpenCodeDbPathResolution {
    message: string;
}

interface CachedResolution {
    key: string;
    resolution: OpenCodeDbPathResolution;
    existed: boolean;
}

let cachedResolution: CachedResolution | null = null;
let lastReadFailure: OpenCodeDbReadFailure | null = null;
const claimedDiagnostics = new Set<string>();

function openCodeDataDir(): string {
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
}

function environmentKey(dataDir: string): string {
    return [
        dataDir,
        process.env.OPENCODE_DB ?? "",
        process.env.OPENCODE_DISABLE_CHANNEL_DB ?? "",
        process.env.OPENCODE_CHANNEL ?? "",
    ].join("\0");
}

function channelPath(dataDir: string, channel: string): string {
    return ["latest", "beta", "prod"].includes(channel)
        ? join(dataDir, "opencode.db")
        : join(dataDir, `opencode-${channel}.db`);
}

function discoveredCandidateNames(dataDir: string): string[] {
    const names = ["opencode.db", "opencode-local.db", "opencode-dev.db"];
    try {
        const discovered = readdirSync(dataDir, { withFileTypes: true })
            .filter((entry) => /^opencode-.+\.db$/.test(entry.name) && !names.includes(entry.name))
            .map((entry) => entry.name)
            .sort();
        names.push(...discovered);
    } catch {
        // A missing or unreadable data directory has no discovered candidates.
    }
    return names;
}

function discoverOpenCodeDb(dataDir: string): OpenCodeDbPathResolution {
    const candidates = discoveredCandidateNames(dataDir).map((name, order) => {
        const path = join(dataDir, name);
        try {
            const metadata = statSync(path);
            return metadata.isFile() ? { path, order, mtimeMs: metadata.mtimeMs } : null;
        } catch {
            return null;
        }
    });
    const existing = candidates
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .sort((left, right) => right.mtimeMs - left.mtimeMs || left.order - right.order)[0];

    if (!existing) {
        return { path: join(dataDir, "opencode.db"), source: "default", channel: null };
    }

    const name = existing.path.slice(dataDir.length + 1);
    const channel =
        name === "opencode.db" ? null : name.slice("opencode-".length, -".db".length) || null;
    return { path: existing.path, source: "discovered", channel };
}

function resolveFresh(dataDir: string): OpenCodeDbPathResolution {
    const explicit = process.env.OPENCODE_DB;
    if (explicit !== undefined && explicit.length > 0) {
        if (explicit === ":memory:") {
            return { path: explicit, source: "OPENCODE_DB", channel: null };
        }
        return {
            path: isAbsolute(explicit) ? explicit : join(dataDir, explicit),
            source: "OPENCODE_DB",
            channel: null,
        };
    }

    const disableChannelDb = process.env.OPENCODE_DISABLE_CHANNEL_DB;
    if (disableChannelDb === "1" || disableChannelDb === "true") {
        return { path: join(dataDir, "opencode.db"), source: "default", channel: null };
    }

    const channel = process.env.OPENCODE_CHANNEL;
    if (channel !== undefined && channel.length > 0) {
        return { path: channelPath(dataDir, channel), source: "channel", channel };
    }

    return discoverOpenCodeDb(dataDir);
}

/** Resolve an explicit DB override first, then channel paths; discover candidates when the compiled channel is unknown. */
export function resolveOpenCodeDbPath(): OpenCodeDbPathResolution {
    const dataDir = openCodeDataDir();
    const key = environmentKey(dataDir);
    if (
        cachedResolution?.key === key &&
        (!cachedResolution.existed || existsSync(cachedResolution.resolution.path))
    ) {
        if (cachedResolution.existed) return cachedResolution.resolution;
        // An absent result is re-probed so a DB created after plugin boot is detected.
    }

    const resolution = resolveFresh(dataDir);
    cachedResolution = {
        key,
        resolution,
        existed: resolution.path !== ":memory:" && existsSync(resolution.path),
    };
    return resolution;
}

export function openCodeDbPathExists(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): boolean {
    return resolution.path !== ":memory:" && existsSync(resolution.path);
}

export function getOpenCodeDbProbeDescriptions(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string[] {
    if (resolution.source === "OPENCODE_DB") return [resolution.path];
    if (
        resolution.source === "channel" ||
        process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
        process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
    ) {
        return [resolution.path];
    }
    const dataDir = openCodeDataDir();
    return [
        join(dataDir, "opencode.db"),
        join(dataDir, "opencode-local.db"),
        join(dataDir, "opencode-dev.db"),
        join(dataDir, "opencode-<channel>.db"),
    ];
}

function lookedForText(resolution: OpenCodeDbPathResolution): string {
    return getOpenCodeDbProbeDescriptions(resolution).join(", ");
}

export function formatOpenCodeDbMissingBanner(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string {
    return `Magic Context cannot find OpenCode's session database (looked for ${lookedForText(resolution)}). History compaction (historian) and the mid-turn valve are disabled until it is found; set OPENCODE_DB if OpenCode stores it elsewhere.`;
}

export function formatOpenCodeDbMissingStatusLine(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string {
    return `OpenCode DB: MISSING (looked for ${lookedForText(resolution)}). History compaction (historian) and the mid-turn valve are disabled; set OPENCODE_DB if OpenCode stores it elsewhere.`;
}

export function formatOpenCodeDbDoctorLine(
    resolution: OpenCodeDbPathResolution = resolveOpenCodeDbPath(),
): string {
    return `FAIL OpenCode session database: not found (looked for ${lookedForText(resolution)}); set OPENCODE_DB if OpenCode stores it elsewhere.`;
}

export function formatOpenCodeDbReadFailureStatusLine(failure: OpenCodeDbReadFailure): string {
    return `OpenCode DB: READ FAILED (path=${failure.path}, source=${failure.source}) — ${failure.message}`;
}

export function recordOpenCodeDbReadFailure(
    resolution: OpenCodeDbPathResolution,
    error: unknown,
): OpenCodeDbReadFailure {
    const message = error instanceof Error ? error.message : String(error);
    lastReadFailure = { ...resolution, message };
    return lastReadFailure;
}

export function clearOpenCodeDbReadFailure(path?: string): void {
    if (path === undefined || lastReadFailure?.path === path) lastReadFailure = null;
}

export function getOpenCodeDbReadFailure(): OpenCodeDbReadFailure | null {
    return lastReadFailure;
}

export function claimOpenCodeDbDiagnosticOnce(
    surface: string,
    resolution: OpenCodeDbPathResolution,
): boolean {
    const key = `${surface}\0${resolution.path}\0${resolution.source}`;
    if (claimedDiagnostics.has(key)) return false;
    claimedDiagnostics.add(key);
    return true;
}

/** Test-only reset for process memoization and once-only diagnostics. */
export function resetOpenCodeDbPathStateForTesting(): void {
    cachedResolution = null;
    lastReadFailure = null;
    claimedDiagnostics.clear();
}
