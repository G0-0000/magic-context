import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createTestTempDir } from "./test-temp-dir";
import { createWorkerShutdown, getWorkerShutdownStats } from "./worker-shutdown";

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});

async function start(mode: "cooperative" | "deaf") {
    const { dir, cleanup } = createTestTempDir("mc-worker-shutdown-");
    cleanups.push(cleanup);
    const path = join(dir, "store.db");
    const owner = new Database(path);
    owner.exec("PRAGMA journal_mode=WAL");
    cleanups.unshift(() => owner.close());
    const worker = new Worker(new URL("./worker-shutdown.fixture.ts", import.meta.url), {
        workerData: { path, mode },
    });
    const exitCode = new Promise<number>((resolve) => worker.once("exit", resolve));
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));
    return { owner, worker, exitCode };
}

function counts(site: string) {
    return { ...(getWorkerShutdownStats().get(site) ?? { graceful: 0, forced: 0 }) };
}

test("a worker asked to close shuts its connection and exits by itself", async () => {
    const site = "test-cooperative";
    const { owner, worker, exitCode } = await start("cooperative");
    const before = counts(site);
    const shutdown = createWorkerShutdown(worker, site, 10_000);
    const started = performance.now();
    await shutdown.close();
    // Well inside the deadline: the worker exited on its own, it was not terminated.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await exitCode).toBe(0);
    expect(counts(site)).toEqual({ graceful: before.graceful + 1, forced: before.forced });
    owner.exec("PRAGMA busy_timeout=0");
    owner.exec("BEGIN IMMEDIATE");
    owner.exec("ROLLBACK");
});

test("a worker that does not exit is terminated at the deadline", async () => {
    const site = "test-deaf";
    const { worker, exitCode } = await start("deaf");
    const before = counts(site);
    const shutdown = createWorkerShutdown(worker, site, 100);
    const started = performance.now();
    await shutdown.close();
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
    await exitCode;
    expect(counts(site)).toEqual({ graceful: before.graceful, forced: before.forced + 1 });
});

test("closing twice shares one shutdown, and closing an exited worker is a no-op", async () => {
    const site = "test-repeat";
    const { worker, exitCode } = await start("cooperative");
    const before = counts(site);
    const shutdown = createWorkerShutdown(worker, site, 10_000);
    const first = shutdown.close();
    expect(shutdown.close()).toBe(first);
    await first;
    await exitCode;
    expect(counts(site)).toEqual({ graceful: before.graceful + 1, forced: before.forced });

    const exited = await start("deaf");
    const late = createWorkerShutdown(exited.worker, site, 10_000);
    await exited.worker.terminate();
    await exited.exitCode;
    await late.close();
    expect(counts(site)).toEqual({ graceful: before.graceful + 1, forced: before.forced });
});
