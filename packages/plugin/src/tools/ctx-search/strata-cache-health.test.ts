import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLease, releaseLease } from "../../features/magic-context/dreamer/lease";
import { leaseKeyFor } from "../../features/magic-context/dreamer/task-registry";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { rememberGitIdentity } from "../../features/magic-context/memory/project-identity-cache";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    consolidateCache,
    lastRebuildStatePathFor,
    parseChanges,
    pendingChangesPathFor,
    readCacheWatermark,
    resolveContext,
    withCacheLock,
} from "./strata-cache";
import {
    __setStrataHealthDiscoveryRootsForTests,
    getStrataCacheHealth,
    rebuildStrataCache,
    StrataCacheRebuildError,
} from "./strata-cache-health";

const SLOT_FILE = "health.bin";
const PEER_SLOT_FILE = "health-peer.bin";
const UNBOUND_PROJECT = "git:0000000000000000000000000000000000000001";
const UNBOUND_CACHE_KEY = `identity:${UNBOUND_PROJECT}`;

type TestMessage = { role: string; content: string };

type HealthFixture = {
    root: string;
    directory: string;
    peerDirectory: string;
    prefixPath: string;
    pendingPath: string;
    peerPrefixPath: string;
    project: string;
    peerProject: string;
    db: NonNullable<ReturnType<typeof openDatabase>>;
    calls: string[];
    failSaves: (times?: number) => void;
    onNextSave: (callback: () => void) => void;
    onNextCheck: (callback: () => void) => void;
};

/**
 * Isolated strata stack: throwaway XDG homes, one mock slot server, a user
 * config with a main target, one bound peer target, and one declared-but-unbound
 * target (no local directory carries its identity), plus an isolated database.
 */
async function withHealthFixture(
    run: (fixture: HealthFixture) => Promise<void>,
    docs: string[] = [],
): Promise<void> {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-strata-health-"));
    const directory = join(root, "project");
    const peerDirectory = join(root, "peer");
    const configHome = join(root, "config");
    const dataHome = join(root, "data");
    const prefixPath = join(root, "slot", "prefix.json");
    const slotDirectory = dirname(prefixPath);
    const pendingPath = pendingChangesPathFor(prefixPath, SLOT_FILE);
    const peerPrefixPath = join(slotDirectory, "peer.json");
    mkdirSync(directory, { recursive: true });
    mkdirSync(peerDirectory, { recursive: true });
    mkdirSync(join(configHome, "cortexkit"), { recursive: true });
    mkdirSync(slotDirectory, { recursive: true });
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    // rebuildStrataCache only accepts keys the zero-arg discovery binds, so the
    // fixture's discovery roots cover the whole temp tree for every test.
    __setStrataHealthDiscoveryRootsForTests([root]);
    let saveFailures = 0;
    let nextSave: (() => void) | undefined;
    let nextCheck: (() => void) | undefined;
    const slots = new Map<string, TestMessage[]>();
    const sidecars = new Map<string, TestMessage[]>();
    const calls: string[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/slots/0") return Response.json({ n_restored: 1 });
            const body = (await request.json()) as {
                messages: TestMessage[];
                strata_session?: { restore?: string; save?: string; splice?: boolean };
            };
            const session = body.strata_session ?? {};
            if (session.save) {
                calls.push("save");
                const callback = nextSave;
                nextSave = undefined;
                callback?.();
                if (saveFailures > 0) {
                    saveFailures--;
                    return Response.json({
                        choices: [{ message: { content: "已加载" } }],
                        session: { save_error: { kind: "storage", reason: "disk full" } },
                    });
                }
                slots.set(session.save, [
                    ...(session.splice ? (slots.get(session.restore ?? "") ?? []) : []),
                    ...body.messages,
                    { role: "assistant", content: "已加载" },
                ]);
                sidecars.set(session.save, [...slots.get(session.save)!]);
                return Response.json({
                    choices: [{ message: { content: "已加载" } }],
                    session: { saved: { tokens: 3, bytes: 1024, ms: 1 } },
                });
            }
            calls.push("check");
            const callback = nextCheck;
            nextCheck = undefined;
            callback?.();
            const sidecar = sidecars.get(session.restore ?? "");
            if (!sidecar) {
                return Response.json({ error: { type: "splice_stale" } }, { status: 409 });
            }
            const line = sidecar
                .filter((message) => message.role === "user")
                .at(-1)!
                .content.split("\n")
                .at(-1)!;
            const count = Number(/^本库共 (\d+) 条/.exec(line)![1]);
            return Response.json({ choices: [{ message: { content: String(count) } }] });
        },
    });
    try {
        const project = resolveProjectIdentityForSession(directory)!;
        const peerProject = resolveProjectIdentityForSession(peerDirectory)!;
        writeFileSync(
            join(configHome, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: true,
                        base_url: String(server.url).replace(/\/$/, ""),
                        api_key: "test-key",
                        model: "test-model",
                        project,
                        slot_file: SLOT_FILE,
                        prefix_path: prefixPath,
                        context_docs: docs,
                        targets: [
                            {
                                project: peerProject,
                                slot_file: PEER_SLOT_FILE,
                                prefix_path: peerPrefixPath,
                            },
                            {
                                // Same identity as the peer directory but a
                                // different slot: must never bind, because the
                                // slot/prefix validation rejects it.
                                project: peerProject,
                                slot_file: "health-peer-decoy.bin",
                                prefix_path: join(slotDirectory, "peer-decoy.json"),
                            },
                            {
                                project: UNBOUND_PROJECT,
                                slot_file: "health-third.bin",
                                prefix_path: join(slotDirectory, "third.json"),
                            },
                        ],
                    },
                },
            }),
        );
        const db = openDatabase();
        if (!db) throw new Error("isolated test database unavailable");
        await run({
            root,
            directory,
            peerDirectory,
            prefixPath,
            pendingPath,
            peerPrefixPath,
            project,
            peerProject,
            db,
            calls,
            failSaves: (times = 1) => {
                saveFailures = times;
            },
            onNextSave: (callback) => {
                nextSave = callback;
            },
            onNextCheck: (callback) => {
                nextCheck = callback;
            },
        });
    } finally {
        __setStrataHealthDiscoveryRootsForTests(null);
        server.stop(true);
        await closeDatabase();
        if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfig;
        if (previousData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousData;
        rmSync(root, { recursive: true, force: true });
    }
}

function writeLedgerRows(path: string, rows: Array<object | string>): void {
    writeFileSync(
        path,
        rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n",
    );
}

describe("getStrataCacheHealth", () => {
    it("returns an empty list for explicit empty candidates or a scan with no targets", async () => {
        expect(await getStrataCacheHealth({ projectRoots: [] })).toEqual({ caches: [] });
        const empty = createTestTempDirFromPath(join(tmpdir(), "mc-strata-health-empty-"));
        const configHome = join(empty, "config");
        mkdirSync(join(configHome, "cortexkit"), { recursive: true });
        const previousConfig = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = configHome;
        __setStrataHealthDiscoveryRootsForTests([empty]);
        try {
            expect(await getStrataCacheHealth()).toEqual({ caches: [] });
        } finally {
            __setStrataHealthDiscoveryRootsForTests(null);
            if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousConfig;
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it("zero-arg enumerates real configured targets and binds them to their directories", async () => {
        await withHealthFixture(async ({ directory, peerDirectory, peerProject, root }) => {
            const decoy = join(root, "decoy");
            mkdirSync(decoy, { recursive: true });
            __setStrataHealthDiscoveryRootsForTests([root]);
            try {
                const { caches } = await getStrataCacheHealth();
                const keys = caches.map((cache) => cache.cacheKey);
                expect(keys).toContain(directory);
                expect(keys).toContain(peerDirectory);
                expect(keys).toContain(UNBOUND_CACHE_KEY);
                // The decoy target shares the peer's identity but declares a
                // different slot: it can never bind and must stay unconfigured.
                expect(keys).toContain(`identity:${peerProject}`);
                // A scanned directory that configures no strata target is not
                // a configured target and must not appear.
                expect(keys).not.toContain(decoy);
                expect(keys).toHaveLength(4);

                const unbound = caches.find((cache) => cache.cacheKey === UNBOUND_CACHE_KEY);
                expect(unbound).toMatchObject({
                    projectRoot: "",
                    filename: "health-third.bin",
                    status: "unconfigured",
                    pendingActionCount: null,
                    ledgerMissing: false,
                    rebuilding: false,
                });
                expect(unbound?.error).toContain("no verifiable local directory");

                const mismatched = caches.find((cache) => cache.cacheKey === `identity:${peerProject}`);
                expect(mismatched).toMatchObject({
                    projectRoot: "",
                    filename: "health-peer-decoy.bin",
                    status: "unconfigured",
                });
                expect(mismatched?.error).toContain("no verifiable local directory");

                // The peer directory bound to its real target, not the decoy.
                const peer = caches.find((cache) => cache.cacheKey === peerDirectory);
                expect(peer?.projectRoot).toBe(peerDirectory);
                expect(peer?.filename).toBe(PEER_SLOT_FILE);
            } finally {
                __setStrataHealthDiscoveryRootsForTests(null);
            }
        });
    });

    it("zero-arg dedupes duplicate spellings of one directory", async () => {
        await withHealthFixture(async ({ directory, root }) => {
            __setStrataHealthDiscoveryRootsForTests([root, join(root, "project", ".")]);
            try {
                const { caches } = await getStrataCacheHealth();
                expect(caches.filter((cache) => cache.cacheKey === directory)).toHaveLength(1);
            } finally {
                __setStrataHealthDiscoveryRootsForTests(null);
            }
        });
    });

    it("enumerates explicit configured targets, marks missing state, and rejects unconfigured roots", async () => {
        await withHealthFixture(async ({ directory, peerDirectory, root }) => {
            const other = join(root, "elsewhere");
            mkdirSync(other, { recursive: true });
            const { caches } = await getStrataCacheHealth({
                projectRoots: [directory, peerDirectory, other, ""],
            });
            expect(caches).toHaveLength(3);

            const main = caches.find((cache) => cache.cacheKey === directory);
            expect(main).toMatchObject({
                projectRoot: directory,
                filename: SLOT_FILE,
                status: "missing",
                lastSuccessfulRebuildAt: null,
                pendingActionCount: 0,
                malformedActionCount: 0,
                ledgerMissing: true,
                rebuilding: false,
            });

            const peer = caches.find((cache) => cache.cacheKey === peerDirectory);
            expect(peer).toMatchObject({
                filename: PEER_SLOT_FILE,
                status: "missing",
                ledgerMissing: true,
                pendingActionCount: 0,
            });

            const rejected = caches.find((cache) => cache.cacheKey === other);
            expect(rejected).toMatchObject({
                status: "unconfigured",
                pendingActionCount: null,
                lastSuccessfulRebuildAt: null,
            });
            expect(rejected?.error).toBeTruthy();
        });
    });

    it("counts valid rows without dedupe and reports malformed rows", async () => {
        await withHealthFixture(async ({ directory, pendingPath }) => {
            const row = { op: "add", id: 7, ts: "2026-10-30T00:00:00.000Z" };
            writeLedgerRows(pendingPath, [row, { ...row }, '{"op":"add","id":']);
            const { caches } = await getStrataCacheHealth({ projectRoots: [directory] });
            expect(caches[0]).toMatchObject({
                status: "missing",
                pendingActionCount: 2,
                malformedActionCount: 1,
                ledgerMissing: false,
            });
        });
    });

    it("reports an unreadable ledger as an error state, never as zero", async () => {
        await withHealthFixture(async ({ directory, pendingPath }) => {
            rmSync(pendingPath, { force: true });
            mkdirSync(pendingPath);
            const { caches } = await getStrataCacheHealth({ projectRoots: [directory] });
            expect(caches[0]).toMatchObject({
                status: "error",
                pendingActionCount: null,
                ledgerMissing: false,
            });
            expect(caches[0]?.error).toContain("unreadable");
        });
    });

    it("shows the completion timestamp after a successful rebuild, 暂无记录 before it", async () => {
        await withHealthFixture(async ({ directory }) => {
            const before = await getStrataCacheHealth({ projectRoots: [directory] });
            expect(before.caches[0]?.lastSuccessfulRebuildAt).toBeNull();

            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });

            const after = await getStrataCacheHealth({ projectRoots: [directory] });
            const stamped = after.caches[0]?.lastSuccessfulRebuildAt;
            expect(stamped).not.toBeNull();
            expect(Number.isFinite(Date.parse(stamped as string))).toBe(true);
        });
    });

    it("keeps the completion timestamp across appends and failed rebuilds, and treats a leftover marker as recovery, not rebuilding", async () => {
        await withHealthFixture(
            async ({ directory, pendingPath, prefixPath, project, db, failSaves }) => {
                await expect(rebuildStrataCache(directory)).resolves.toEqual({
                    cacheKey: directory,
                });
                const stamped = (
                    await getStrataCacheHealth({ projectRoots: [directory] })
                ).caches[0]?.lastSuccessfulRebuildAt;
                expect(stamped).not.toBeNull();

                // A pure-append consolidation must not move the full-rebuild stamp.
                const large = insertMemory(db, {
                    projectPath: project,
                    category: "OPS_RULES",
                    content: `large: ${"memory content ".repeat(2000)}`,
                });
                writeLedgerRows(pendingPath, [
                    { op: "add", id: large.id, ts: "2026-10-30T00:00:00.000Z" },
                ]);
                expect((await consolidateCache(directory)).action).toBe("appended");
                let health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
                expect(health?.lastSuccessfulRebuildAt).toBe(stamped);
                expect(health?.pendingActionCount).toBe(0);

                // A failed manual rebuild keeps the previous completion; the
                // leftover marker is an interrupted write awaiting recovery —
                // explicitly NOT "rebuilding", so the rebuild stays allowed.
                // The ledger row written before the attempt is deleted at
                // rebuild START (the change renders from the DB next time).
                writeLedgerRows(pendingPath, [
                    { op: "add", id: large.id, ts: "2026-10-30T00:00:00.000Z" },
                ]);
                failSaves();
                await expect(rebuildStrataCache(directory)).rejects.toThrow();
                health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
                expect(health?.lastSuccessfulRebuildAt).toBe(stamped);
                expect(health?.rebuilding).toBe(false);
                expect(health?.status).toBe("error");
                expect(health?.error).toContain("pending recovery");
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(true);
                expect(existsSync(pendingPath)).toBe(false);

                // Recovery: with no operation running, a confirmed rebuild
                // succeeds and clears the interrupted-write state.
                await expect(rebuildStrataCache(directory)).resolves.toEqual({
                    cacheKey: directory,
                });
                health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
                expect(health?.status).toBe("ready");
                expect(health?.rebuilding).toBe(false);
                expect(existsSync(`${prefixPath}.pending-write.json`)).toBe(false);
            },
        );
    });

    it("reports a corrupt completion record as an error instead of 暂无记录", async () => {
        await withHealthFixture(async ({ directory, prefixPath }) => {
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
            writeFileSync(lastRebuildStatePathFor(prefixPath, SLOT_FILE), "not json\n");
            const { caches } = await getStrataCacheHealth({ projectRoots: [directory] });
            expect(caches[0]?.status).toBe("error");
            expect(caches[0]?.error).toContain("rebuild record unreadable");
        });
    });

    it("flags a stale completion record instead of presenting it as current", async () => {
        await withHealthFixture(async ({ directory, prefixPath }) => {
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
            // Wind the recorded completion back before the mirror's rebuild
            // mark: the newest rebuild published without a completion record.
            const watermark = readCacheWatermark(resolveContext(directory)!.connection)!;
            writeFileSync(
                lastRebuildStatePathFor(prefixPath, SLOT_FILE),
                `${JSON.stringify({
                    rebuiltAt: new Date(Date.parse(watermark.rebuiltAt) - 60_000).toISOString(),
                })}\n`,
            );
            const health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
            expect(health?.status).toBe("error");
            expect(health?.error).toContain("completion record stale");
            // The old recorded time stays visible, but flagged — not claimed
            // as the completion of the current mirror.
            expect(health?.lastSuccessfulRebuildAt).not.toBeNull();
        });
    });

    it("shows 暂无记录 without a false anomaly when no record exists at all", async () => {
        await withHealthFixture(async ({ directory, prefixPath }) => {
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
            rmSync(lastRebuildStatePathFor(prefixPath, SLOT_FILE), { force: true });
            const health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
            expect(health?.lastSuccessfulRebuildAt).toBeNull();
            expect(health?.status).toBe("ready");
        });
    });

    it("is strictly read-only: no model call and no file changes", async () => {
        await withHealthFixture(async ({ directory, pendingPath, prefixPath, calls }) => {
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
            writeLedgerRows(pendingPath, [{ op: "add", id: 3, ts: "2026-10-30T00:00:00.000Z" }]);
            const ledgerBefore = readFileSync(pendingPath, "utf8");
            const prefixBefore = readFileSync(prefixPath, "utf8");
            const callsBefore = calls.length;

            await getStrataCacheHealth({ projectRoots: [directory] });

            expect(calls.length).toBe(callsBefore);
            expect(readFileSync(pendingPath, "utf8")).toBe(ledgerBefore);
            expect(readFileSync(prefixPath, "utf8")).toBe(prefixBefore);
            const health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
            expect(health?.pendingActionCount).toBe(1);
        });
    });
});

describe("rebuildStrataCache", () => {
    it("throws UNKNOWN_CACHE for cacheKeys that are not configured targets", async () => {
        await withHealthFixture(async ({ root }) => {
            const unknown = rebuildStrataCache(join(root, "not-a-project"));
            await expect(unknown).rejects.toBeInstanceOf(StrataCacheRebuildError);
            await expect(unknown).rejects.toMatchObject({ code: "UNKNOWN_CACHE" });
            await expect(rebuildStrataCache("")).rejects.toMatchObject({
                code: "UNKNOWN_CACHE",
            });
            // Identity-shaped keys from the health list are not rebuildable.
            await expect(rebuildStrataCache(UNBOUND_CACHE_KEY)).rejects.toMatchObject({
                code: "UNKNOWN_CACHE",
            });
        });
    });

    it("rejects resolvable directories the discovery did not bind, and accepts them once bound", async () => {
        await withHealthFixture(async ({ directory, root }) => {
            const elsewhere = join(root, "elsewhere");
            mkdirSync(elsewhere, { recursive: true });
            // Discovery binds nothing here, so even a perfectly resolvable key
            // is rejected: only discovered, bound targets may be rebuilt.
            __setStrataHealthDiscoveryRootsForTests([elsewhere]);
            try {
                await expect(rebuildStrataCache(directory)).rejects.toMatchObject({
                    code: "UNKNOWN_CACHE",
                });
            } finally {
                __setStrataHealthDiscoveryRootsForTests([root]);
            }
            // With discovery covering it again, the same key rebuilds through
            // its bound project root.
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
        });
    });

    it("throws BUSY while the project memory lease is held and succeeds after release", async () => {
        await withHealthFixture(async ({ directory, project, db }) => {
            const leaseKey = leaseKeyFor("strata-cache-maintain", project);
            expect(acquireLease(db, "foreign-holder", leaseKey)).toBe(true);
            try {
                await expect(rebuildStrataCache(directory)).rejects.toMatchObject({
                    code: "BUSY",
                });
            } finally {
                releaseLease(db, "foreign-holder", leaseKey);
            }
            await expect(rebuildStrataCache(directory)).resolves.toEqual({
                cacheKey: directory,
            });
        });
    });

    it("throws BUSY while another process holds the cache lock and succeeds after release", async () => {
        await withHealthFixture(async ({ directory, prefixPath }) => {
            await withCacheLock({ prefixPath }, async () => {
                await expect(rebuildStrataCache(directory)).rejects.toMatchObject({
                    code: "BUSY",
                });
            });
            await expect(rebuildStrataCache(directory)).resolves.toEqual({
                cacheKey: directory,
            });
        });
    });
});


function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
    const config = join(root, "gitconfig");
    writeFileSync(config, "");
    return {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
}

function committedGitRepository(
    parent: string,
    name: string,
): { directory: string; identity: string } {
    const directory = join(parent, name);
    mkdirSync(directory, { recursive: true });
    // The git config lives beside the repo tree so the machine's git defaults
    // (e.g. reftable storage) cannot change the fixture.
    const configHome = join(parent, ".gitconfig-home");
    mkdirSync(configHome, { recursive: true });
    const gitEnv = isolatedGitEnv(configHome);
    execFileSync("git", ["init", "-q"], { cwd: directory, env: gitEnv, encoding: "utf8", windowsHide: true });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "first"], {
        cwd: directory,
        env: gitEnv,
        encoding: "utf8",
        windowsHide: true,
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        env: gitEnv,
        encoding: "utf8",
        windowsHide: true,
    }).trim();
    return { directory, identity: `git:${head}` };
}

function sidecarFiles(): string[] {
    try {
        return readdirSync(join(getMagicContextStorageDir(), "project-identities"));
    } catch {
        return [];
    }
}

type StandaloneHealthEnv = {
    root: string;
    directory: string;
    configHome: string;
    writeUserConfig: (config: unknown) => void;
};

/** Isolated XDG homes (no database, no slot server) for read-only diagnostics tests. */
function withStandaloneHealthEnv(run: (env: StandaloneHealthEnv) => Promise<void>): Promise<void> {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-strata-health-standalone-"));
    const directory = join(root, "repo");
    const configHome = join(root, "config");
    const dataHome = join(root, "data");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(configHome, "cortexkit"), { recursive: true });
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = dataHome;
    return (async () => {
        try {
            await run({
                root,
                directory,
                configHome,
                writeUserConfig: (config) =>
                    writeFileSync(
                        join(configHome, "cortexkit", "magic-context.jsonc"),
                        JSON.stringify(config),
                    ),
            });
        } finally {
            if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousConfig;
            if (previousData === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousData;
            rmSync(root, { recursive: true, force: true });
        }
    })();
}

function standaloneStrataAskConfig(identity: string, root: string): Record<string, unknown> {
    return {
        memory: {
            strata_ask: {
                enabled: true,
                base_url: "http://127.0.0.1:1",
                api_key: "test-key",
                model: "test-model",
                project: identity,
                slot_file: SLOT_FILE,
                prefix_path: join(root, "slot", "prefix.json"),
            },
        },
    };
}

describe("read-only diagnostics", () => {
    it("never writes identity sidecars during a health read", async () => {
        await withStandaloneHealthEnv(async ({ root, writeUserConfig }) => {
            const repo = committedGitRepository(root, "repo");
            writeUserConfig(standaloneStrataAskConfig(repo.identity, root));
            expect(sidecarFiles()).toEqual([]);
            const { caches, error } = await getStrataCacheHealth({ projectRoots: [repo.directory] });
            expect(error).toBeUndefined();
            expect(caches).toHaveLength(1);
            expect(caches[0]).toMatchObject({
                cacheKey: repo.directory,
                projectRoot: repo.directory,
                status: "missing",
            });
            // The git identity was probed fresh and nothing durable was written.
            expect(sidecarFiles()).toEqual([]);
        });
    }, 30_000);

    it("binds a declared target through its recorded identity sidecar, not the shallow scan", async () => {
        await withStandaloneHealthEnv(async ({ root, writeUserConfig }) => {
            // Two levels deep: the one-level home scan cannot see this repo.
            const repo = committedGitRepository(join(root, "nested"), "deep");
            writeUserConfig(standaloneStrataAskConfig(repo.identity, root));
            // Record the directory in the identity sidecar, as a past session would have.
            rememberGitIdentity(repo.directory, repo.identity);
            expect(sidecarFiles()).toHaveLength(1);
            __setStrataHealthDiscoveryRootsForTests([root]);
            try {
                const { caches } = await getStrataCacheHealth();
                const bound = caches.find((cache) => cache.cacheKey === repo.directory);
                expect(bound).toMatchObject({ projectRoot: repo.directory, status: "missing" });
            } finally {
                __setStrataHealthDiscoveryRootsForTests(null);
            }
        });
    }, 30_000);

    it("surfaces an unreadable user config as a diagnostic error, not as 'no targets'", async () => {
        await withStandaloneHealthEnv(async ({ root, configHome, writeUserConfig }) => {
            const repo = committedGitRepository(root, "repo");
            writeUserConfig(standaloneStrataAskConfig(repo.identity, root));
            writeFileSync(join(configHome, "cortexkit", "magic-context.jsonc"), "{ not json\n");
            __setStrataHealthDiscoveryRootsForTests([root]);
            try {
                const snapshot = await getStrataCacheHealth();
                expect(snapshot.caches).toEqual([]);
                expect(snapshot.error).toContain("user config unreadable");
            } finally {
                __setStrataHealthDiscoveryRootsForTests(null);
            }
        });
    }, 30_000);

    it("reports a corrupt or structurally invalid mirror as an error instead of ready", async () => {
        await withHealthFixture(async ({ directory, prefixPath }) => {
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
            writeFileSync(prefixPath, "not json\n");
            let health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
            expect(health?.status).toBe("error");
            expect(health?.error).toContain("prefix mirror invalid");

            // Empty array: parses fine, but no cache has this shape.
            writeFileSync(prefixPath, "[]\n");
            health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
            expect(health?.status).toBe("error");
            expect(health?.error).toContain("prefix mirror invalid");

            // Wrong message structure (bad roles, missing content).
            writeFileSync(
                prefixPath,
                `${JSON.stringify([{ role: "user", content: "x" }])}\n`,
            );
            health = (await getStrataCacheHealth({ projectRoots: [directory] })).caches[0];
            expect(health?.status).toBe("error");
            expect(health?.error).toContain("prefix mirror invalid");
        });
    });
});

describe("per-slot ledger isolation on rebuild", () => {
    it("a full rebuild deletes only its own slot's ledger", async () => {
        await withHealthFixture(async ({ directory, prefixPath, peerPrefixPath }) => {
            const mainPending = pendingChangesPathFor(prefixPath, SLOT_FILE);
            const peerPending = pendingChangesPathFor(peerPrefixPath, PEER_SLOT_FILE);
            writeLedgerRows(mainPending, [{ op: "add", id: 6, ts: "2026-10-30T00:00:00.000Z" }]);
            writeLedgerRows(peerPending, [{ op: "add", id: 5, ts: "2026-10-30T00:00:00.000Z" }]);
            await expect(rebuildStrataCache(directory)).resolves.toEqual({ cacheKey: directory });
            expect(existsSync(mainPending)).toBe(false);
            expect(parseChanges(readFileSync(peerPending, "utf8")).changes.map((row) => row.id)).toEqual([5]);
        });
    });

    it("returns partial caches plus the scan error when a scan root is unreadable", async () => {
        await withHealthFixture(async ({ directory, root }) => {
            const fileRoot = join(root, "not-a-directory");
            writeFileSync(fileRoot, "plain file\n");
            __setStrataHealthDiscoveryRootsForTests([root, fileRoot]);
            try {
                const snapshot = await getStrataCacheHealth();
                // The bound target still shows up...
                expect(snapshot.caches.map((cache) => cache.cacheKey)).toContain(directory);
                // ...and the failed root is surfaced, not swallowed.
                expect(snapshot.error).toContain("directory scan partially failed");
                expect(snapshot.error).toContain("not-a-directory");
            } finally {
                __setStrataHealthDiscoveryRootsForTests([root]);
            }
        });
    });
});
