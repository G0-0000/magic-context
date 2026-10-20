import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as warmup from "../../hooks/magic-context/raw-ordinal-warmup";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import * as messageTime from "./message-time-backfill";
import { closeDatabase, openDatabase, openDatabaseAsync } from "./storage-db";

const originalDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
let dir: string | undefined;
let restoreWorker: (() => void) | undefined;
let restoreTime: (() => void) | undefined;

function useStore(): void {
    dir = createTestTempDirFromPath(join(tmpdir(), "storage-startup-lifecycle-"));
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
}

afterEach(async () => {
    await closeDatabase();
    restoreWorker?.();
    restoreTime?.();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (dir) rmSync(dir, { recursive: true, force: true });
});

test("closing before the startup turn cancels the queued FTS writer", async () => {
    useStore();
    const worker = spyOn(warmup, "runSessionWarmupWorker").mockResolvedValue({
        ftsRowidBackfill: true,
    });
    restoreWorker = () => worker.mockRestore();
    expect(openDatabase()).not.toBeNull();
    await closeDatabase();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(worker).not.toHaveBeenCalled();
});

test("closing joins the startup worker before reopening and cancels its continuation", async () => {
    useStore();
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    let release!: () => void;
    let aborted = false;
    const worker = spyOn(warmup, "runSessionWarmupWorker").mockImplementation(
        (_input, { signal }) =>
            new Promise((resolve) => {
                // Model a native connection that outlives the abort request.
                release = () => resolve({ failure: "stopped", detail: "stopped" });
                signal?.addEventListener("abort", () => {
                    aborted = true;
                });
                started();
            }),
    );
    const time = spyOn(messageTime, "startMessageTimeBackfill").mockResolvedValue();
    restoreWorker = () => worker.mockRestore();
    restoreTime = () => time.mockRestore();
    expect(openDatabase()).not.toBeNull();
    await workerStarted;
    let closed = false;
    const closing = closeDatabase().then(() => {
        closed = true;
    });
    let opening: Promise<ReturnType<typeof openDatabase>> | undefined;
    try {
        expect(aborted).toBe(true);
        expect(closed).toBe(false);
        expect(openDatabase()).toBeNull();
        let reopened = false;
        opening = openDatabaseAsync().then((db) => {
            reopened = true;
            return db;
        });
        await Promise.resolve();
        expect(reopened).toBe(false);
    } finally {
        release();
    }
    await closing;
    expect(await opening).not.toBeNull();
    expect(closed).toBe(true);
    expect(time).not.toHaveBeenCalled();
});
