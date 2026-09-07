/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    formatOpenCodeDbDoctorLine,
    formatOpenCodeDbMissingBanner,
    formatOpenCodeDbMissingStatusLine,
    openCodeDbPathExists,
    resetOpenCodeDbPathStateForTesting,
    resolveOpenCodeDbPath,
} from "./opencode-db-path";

const ORIGINAL_ENV = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    OPENCODE_DB: process.env.OPENCODE_DB,
    OPENCODE_DISABLE_CHANNEL_DB: process.env.OPENCODE_DISABLE_CHANNEL_DB,
    OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL,
};
const tempDirs: string[] = [];

function restore(name: keyof typeof ORIGINAL_ENV): void {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    restore("XDG_DATA_HOME");
    restore("OPENCODE_DB");
    restore("OPENCODE_DISABLE_CHANNEL_DB");
    restore("OPENCODE_CHANNEL");
    resetOpenCodeDbPathStateForTesting();
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function useDataHome(): { dataHome: string; openCodeDir: string } {
    const dataHome = mkdtempSync(join(tmpdir(), "opencode-db-path-"));
    const openCodeDir = join(dataHome, "opencode");
    mkdirSync(openCodeDir, { recursive: true });
    tempDirs.push(dataHome);
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.OPENCODE_DB;
    delete process.env.OPENCODE_DISABLE_CHANNEL_DB;
    delete process.env.OPENCODE_CHANNEL;
    resetOpenCodeDbPathStateForTesting();
    return { dataHome, openCodeDir };
}

function createCandidate(openCodeDir: string, name: string, mtimeMs: number): string {
    const path = join(openCodeDir, name);
    writeFileSync(path, "sqlite fixture");
    const time = new Date(mtimeMs);
    utimesSync(path, time, time);
    return path;
}

describe("resolveOpenCodeDbPath", () => {
    it("honors absolute and relative OPENCODE_DB overrides before every other source", () => {
        const { openCodeDir } = useDataHome();
        const absolute = join(openCodeDir, "elsewhere.db");
        process.env.OPENCODE_DB = absolute;
        process.env.OPENCODE_DISABLE_CHANNEL_DB = "true";
        process.env.OPENCODE_CHANNEL = "dev";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: absolute,
            source: "OPENCODE_DB",
            channel: null,
        });

        process.env.OPENCODE_DB = "relative.db";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "relative.db"),
            source: "OPENCODE_DB",
            channel: null,
        });
    });

    it("treats OPENCODE_DB=:memory: as an explicit but absent store", () => {
        useDataHome();
        process.env.OPENCODE_DB = ":memory:";
        const resolution = resolveOpenCodeDbPath();
        expect(resolution).toEqual({ path: ":memory:", source: "OPENCODE_DB", channel: null });
        expect(openCodeDbPathExists(resolution)).toBe(false);
    });

    it("uses the default DB when channel databases are disabled", () => {
        const { openCodeDir } = useDataHome();
        process.env.OPENCODE_DISABLE_CHANNEL_DB = "1";
        process.env.OPENCODE_CHANNEL = "dev";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "opencode.db"),
            source: "default",
            channel: null,
        });
    });

    it("honors an OPENCODE_CHANNEL visible to the plugin", () => {
        const { openCodeDir } = useDataHome();
        process.env.OPENCODE_CHANNEL = "dev";
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "opencode-dev.db"),
            source: "channel",
            channel: "dev",
        });
    });

    for (const selectedName of [
        "opencode.db",
        "opencode-local.db",
        "opencode-dev.db",
        "opencode-nightly.db",
    ]) {
        it(`discovers ${selectedName} when it is the newest existing candidate`, () => {
            const { openCodeDir } = useDataHome();
            const names = [
                "opencode.db",
                "opencode-local.db",
                "opencode-dev.db",
                "opencode-nightly.db",
            ];
            for (const [index, name] of names.entries()) {
                createCandidate(openCodeDir, name, name === selectedName ? 10_000 : 1_000 + index);
            }

            expect(resolveOpenCodeDbPath()).toEqual({
                path: join(openCodeDir, selectedName),
                source: "discovered",
                channel:
                    selectedName === "opencode.db"
                        ? null
                        : selectedName.slice("opencode-".length, -".db".length),
            });
        });
    }

    it("uses candidate order as the deterministic tie-breaker for equal mtimes", () => {
        const { openCodeDir } = useDataHome();
        for (const name of ["opencode-local.db", "opencode-dev.db", "opencode.db"]) {
            createCandidate(openCodeDir, name, 5_000);
        }
        expect(resolveOpenCodeDbPath()).toEqual({
            path: join(openCodeDir, "opencode.db"),
            source: "discovered",
            channel: null,
        });
    });

    it("returns the default path by value when no candidate exists", () => {
        const { openCodeDir } = useDataHome();
        const resolution = resolveOpenCodeDbPath();
        expect(resolution).toEqual({
            path: join(openCodeDir, "opencode.db"),
            source: "default",
            channel: null,
        });
        expect(openCodeDbPathExists(resolution)).toBe(false);
    });

    it("re-probes discovery when the memoized chosen file disappears", () => {
        const { openCodeDir } = useDataHome();
        const primary = createCandidate(openCodeDir, "opencode-local.db", 2_000);
        const fallback = createCandidate(openCodeDir, "opencode.db", 1_000);
        expect(resolveOpenCodeDbPath().path).toBe(primary);

        unlinkSync(primary);
        expect(resolveOpenCodeDbPath()).toEqual({
            path: fallback,
            source: "discovered",
            channel: null,
        });
    });

    it("formats the missing banner, status, and doctor lines by value", () => {
        const { openCodeDir } = useDataHome();
        const lookedFor = [
            join(openCodeDir, "opencode.db"),
            join(openCodeDir, "opencode-local.db"),
            join(openCodeDir, "opencode-dev.db"),
            join(openCodeDir, "opencode-<channel>.db"),
        ].join(", ");
        const resolution = resolveOpenCodeDbPath();

        expect(formatOpenCodeDbMissingBanner(resolution)).toBe(
            `Magic Context cannot find OpenCode's session database (looked for ${lookedFor}). History compaction (historian) and the mid-turn valve are disabled until it is found; set OPENCODE_DB if OpenCode stores it elsewhere.`,
        );
        expect(formatOpenCodeDbMissingStatusLine(resolution)).toBe(
            `OpenCode DB: MISSING (looked for ${lookedFor}). History compaction (historian) and the mid-turn valve are disabled; set OPENCODE_DB if OpenCode stores it elsewhere.`,
        );
        expect(formatOpenCodeDbDoctorLine(resolution)).toBe(
            `FAIL OpenCode session database: not found (looked for ${lookedFor}); set OPENCODE_DB if OpenCode stores it elsewhere.`,
        );
    });
});
