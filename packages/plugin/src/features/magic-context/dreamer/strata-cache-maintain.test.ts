/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import * as strataAsk from "../../../tools/ctx-search/strata-ask";
import * as strataCache from "../../../tools/ctx-search/strata-cache";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { createPrimer } from "../storage-primers";
import { IDLE_SCHEDULE_PRUNE_AT_KEY } from "./idle-schedule-prune";
import { getDreamRuns } from "./storage-dream-runs";
import { setDreamState } from "./storage-dream-state";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import { createDreamTaskExecutor } from "./task-executor";
import { evaluateTaskGate, getDreamTaskBacklog, taskHasSchedulableInput } from "./task-gates";
import {
    type DreamTaskRuntimeConfig,
    runDueTasksForProject,
    runManualDream,
    type TaskExecutor,
} from "./task-scheduler";

const PROJECT = "git:strata-test";
const DIRECTORY = "/checkout/strata-test";
const NOW = Date.UTC(2026, 9, 29, 8, 31);
const TASK: DreamTaskRuntimeConfig = {
    task: "strata-cache-maintain",
    schedule: "30 8 * * *",
    timeoutMinutes: 20,
};
const CONNECTION: strataAsk.StrataAskConnection = {
    baseUrl: "http://127.0.0.1:8080",
    apiKey: "test-key",
    apiKeyEnv: null,
    model: "test-model",
    slotFile: "test.bin",
    prefixPath: "/tmp/test-prefix.json",
    project: PROJECT,
    maxTokens: 2048,
    timeoutMs: 60000,
};

let db: Database | null = null;
afterEach(() => {
    mock.restore();
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    setDreamState(database, IDLE_SCHEDULE_PRUNE_AT_KEY, String(NOW));
    return database;
}

function arm(database: Database): void {
    writeTaskScheduleState(database, {
        projectPath: PROJECT,
        task: TASK.task,
        lastRunAt: null,
        nextDueAt: NOW - 60_000,
        schedule: TASK.schedule,
        lastStatus: null,
        lastError: null,
        retryCount: 0,
    });
}

describe("strata-cache-maintain dream task", () => {
    test("seeding and gate depend on eligibility, not on a live memory pool", () => {
        db = freshDb();
        expect(taskHasSchedulableInput(TASK.task, db, PROJECT, NOW)).toBe(false);
        expect(taskHasSchedulableInput(TASK.task, db, PROJECT, NOW, true)).toBe(true);
        const gate = { db, projectIdentity: PROJECT, lastRunAt: null, promotionThreshold: 2 };
        expect(evaluateTaskGate(TASK.task, gate)).toBe(false);
        expect(evaluateTaskGate(TASK.task, { ...gate, strataCacheEnabled: true })).toBe(true);
        expect(getDreamTaskBacklog(db, PROJECT, TASK.task)).toEqual({ pending: 0, total: 0 });
    });

    test("the probe re-reads trust-filtered project config without contacting Strata", () => {
        const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-strata-dream-xdg-"));
        const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-strata-dream-project-"));
        mkdirSync(join(xdg, "cortexkit"), { recursive: true });
        mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
        const userConfig = join(xdg, "cortexkit", "magic-context.jsonc");
        const projectConfig = join(projectDir, ".cortexkit", "magic-context.jsonc");
        writeFileSync(
            userConfig,
            JSON.stringify({
                memory: {
                    strata_ask: {
                        enabled: false,
                        base_url: CONNECTION.baseUrl,
                        api_key: CONNECTION.apiKey,
                        model: CONNECTION.model,
                        slot_file: CONNECTION.slotFile,
                        prefix_path: CONNECTION.prefixPath,
                        project: PROJECT,
                    },
                },
            }),
        );
        const setProject = (enabled: boolean) =>
            writeFileSync(
                projectConfig,
                JSON.stringify({
                    memory: { strata_ask: { enabled, project: "git:untrusted" } },
                }),
            );
        const previous = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = xdg;
        try {
            const executor = createDreamTaskExecutor({
                sessionDirectory: projectDir,
                openOpenCodeDb: () => null,
            });
            setProject(true);
            expect(executor.strataCacheEnabled?.(PROJECT)).toBe(true);
            expect(executor.strataCacheEnabled?.("git:untrusted")).toBe(false);
            setProject(false);
            expect(executor.strataCacheEnabled?.(PROJECT)).toBe(false);
            setProject(true);
            expect(executor.strataCacheEnabled?.(PROJECT)).toBe(true);
            writeFileSync(projectConfig, "{ invalid json");
            expect(executor.strataCacheEnabled?.(PROJECT)).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous;
            rmSync(xdg, { recursive: true, force: true });
            rmSync(projectDir, { recursive: true, force: true });
        }
    });

    test("the first enabled pass seeds an 08:30 schedule even with no memories", async () => {
        db = freshDb();
        const run = mock(async () => ({ status: "completed" as const }));
        const executor: TaskExecutor = run;
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [TASK],
            executor,
            now: NOW,
        });
        expect(getTaskScheduleState(db, PROJECT, TASK.task)).toBeNull();
        executor.strataCacheEnabled = (project) => project === PROJECT;
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [TASK],
            executor,
            now: NOW,
        });
        expect(getTaskScheduleState(db, PROJECT, TASK.task)).toMatchObject({
            schedule: "30 8 * * *",
            lastStatus: null,
        });
        expect(getTaskScheduleState(db, PROJECT, TASK.task)?.nextDueAt).toBeGreaterThan(NOW);
        expect(run).not.toHaveBeenCalled();
    });

    test("an absent probe fails closed and cannot advance another checkout's due slot", async () => {
        db = freshDb();
        arm(db);
        const run = mock(async () => ({ status: "completed" as const }));
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [TASK],
            executor: run,
            now: NOW,
        });
        expect(run).not.toHaveBeenCalled();
        expect(getTaskScheduleState(db, PROJECT, TASK.task)).toMatchObject({
            nextDueAt: NOW - 60_000,
            lastStatus: null,
        });

        const enabled: TaskExecutor = run;
        enabled.strataCacheEnabled = (project) => project === PROJECT;
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [TASK],
            executor: enabled,
            now: NOW,
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(getTaskScheduleState(db, PROJECT, TASK.task)?.lastStatus).toBe("completed");
    });

    test("overdue primer refresh and cache maintenance serialize in canonical memory-lease order", async () => {
        db = freshDb();
        arm(db);
        createPrimer(db, {
            projectPath: PROJECT,
            question: "What changed?",
            totalSupport: 2,
            lastObservedAt: NOW,
            sourceCandidateIds: [],
        });
        writeTaskScheduleState(db, {
            projectPath: PROJECT,
            task: "refresh-primers",
            lastRunAt: null,
            nextDueAt: NOW - 11 * 60_000,
            schedule: "20 8 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const calls: string[] = [];
        const executor: TaskExecutor = async (config, context) => {
            calls.push(`${config.task}:${context.leaseKey}`);
            return { status: "completed" };
        };
        executor.strataCacheEnabled = (project) => project === PROJECT;
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [
                TASK,
                { task: "refresh-primers", schedule: "20 8 * * *", timeoutMinutes: 20 },
            ],
            executor,
            now: NOW,
        });
        expect(calls).toEqual([
            `refresh-primers:memory:${PROJECT}`,
            `strata-cache-maintain:memory:${PROJECT}`,
        ]);
    });

    test("a config change at either gate leaves the shared due slot unconsumed", async () => {
        for (const disableOnCall of [3, 4]) {
            const database = freshDb();
            try {
                arm(database);
                const run = mock(async () => ({ status: "completed" as const }));
                const executor: TaskExecutor = run;
                let checks = 0;
                executor.strataCacheEnabled = () => ++checks < disableOnCall;
                await runDueTasksForProject({
                    db: database,
                    projectIdentity: PROJECT,
                    tasks: [TASK],
                    executor,
                    now: NOW,
                });
                expect(checks).toBe(disableOnCall);
                expect(run).not.toHaveBeenCalled();
                expect(getTaskScheduleState(database, PROJECT, TASK.task)).toMatchObject({
                    nextDueAt: NOW - 60_000,
                    lastStatus: null,
                });
            } finally {
                database.close();
            }
        }
    });

    test("executor re-resolves checkout config, binds identity and runs host-only without a parent or model", async () => {
        db = freshDb();
        let connection: strataAsk.StrataAskConnection | null = CONNECTION;
        const resolve = spyOn(strataAsk, "resolveOpenCodeStrataAsk").mockImplementation(
            () => connection,
        );
        const maintain = spyOn(strataCache, "maintainCache").mockResolvedValue({
            action: "rebuilt",
            detail: "daily-compaction",
        });
        const findParent = mock(async () => undefined);
        const executor = createDreamTaskExecutor({
            sessionDirectory: DIRECTORY,
            openOpenCodeDb: () => null,
            findParentSessionId: findParent,
        });
        expect(executor.strataCacheEnabled?.("git:other")).toBe(false);
        connection = null;
        expect(executor.strataCacheEnabled?.(PROJECT)).toBe(false);
        connection = { ...CONNECTION, apiKey: null, apiKeyEnv: "MC_STRATA_DREAM_MISSING_KEY" };
        const previousKey = process.env.MC_STRATA_DREAM_MISSING_KEY;
        try {
            delete process.env.MC_STRATA_DREAM_MISSING_KEY;
            expect(executor.strataCacheEnabled?.(PROJECT)).toBe(false);
        } finally {
            if (previousKey === undefined) delete process.env.MC_STRATA_DREAM_MISSING_KEY;
            else process.env.MC_STRATA_DREAM_MISSING_KEY = previousKey;
        }
        connection = CONNECTION;
        expect(executor.strataCacheEnabled?.(PROJECT)).toBe(true);
        const outcome = await runManualDream({
            db,
            projectIdentity: PROJECT,
            tasks: [{ ...TASK, modelChainUnavailable: true }],
            executor,
            task: TASK.task,
        });
        expect(outcome.ran).toEqual([TASK.task]);
        expect(maintain).toHaveBeenCalledTimes(1);
        expect(maintain).toHaveBeenCalledWith(DIRECTORY);
        expect(findParent).not.toHaveBeenCalled();
        expect(resolve.mock.calls.every(([directory]) => directory === DIRECTORY)).toBe(true);
        expect(resolve.mock.calls.length).toBeGreaterThan(3);
        expect(getDreamRuns(db, PROJECT)[0]?.tasks_json).toContain("daily-compaction");
    });

    test("the executor rechecks eligibility before the call and preserves an opted-out due slot", async () => {
        db = freshDb();
        arm(db);
        let checks = 0;
        spyOn(strataAsk, "resolveOpenCodeStrataAsk").mockImplementation(() =>
            ++checks <= 4 ? CONNECTION : null,
        );
        const maintain = spyOn(strataCache, "maintainCache").mockResolvedValue({
            action: "rebuilt",
            detail: "unused",
        });
        const executor = createDreamTaskExecutor({
            sessionDirectory: DIRECTORY,
            openOpenCodeDb: () => null,
        });
        await runDueTasksForProject({
            db,
            projectIdentity: PROJECT,
            tasks: [TASK],
            executor,
            now: NOW,
        });
        expect(checks).toBe(5);
        expect(maintain).not.toHaveBeenCalled();
        expect(getTaskScheduleState(db, PROJECT, TASK.task)).toMatchObject({
            nextDueAt: NOW - 60_000,
            lastStatus: null,
        });
    });

    test("an error retries; a disabled result preserves the due slot", async () => {
        for (const action of ["error", "disabled"] as const) {
            const database = freshDb();
            try {
                arm(database);
                const resolve = spyOn(strataAsk, "resolveOpenCodeStrataAsk").mockReturnValue(
                    CONNECTION,
                );
                const maintain = spyOn(strataCache, "maintainCache").mockResolvedValue({
                    action,
                    detail: "test",
                });
                const executor = createDreamTaskExecutor({
                    sessionDirectory: DIRECTORY,
                    openOpenCodeDb: () => null,
                });
                await runDueTasksForProject({
                    db: database,
                    projectIdentity: PROJECT,
                    tasks: [TASK],
                    executor,
                    now: NOW,
                });
                const state = getTaskScheduleState(database, PROJECT, TASK.task);
                expect(maintain).toHaveBeenCalledTimes(1);
                if (action === "error") {
                    expect(state?.lastStatus).toBe("failed");
                    expect(state?.retryCount).toBe(1);
                } else {
                    expect(state?.nextDueAt).toBe(NOW - 60_000);
                    expect(state?.lastStatus).toBeNull();
                }
                resolve.mockRestore();
                maintain.mockRestore();
            } finally {
                database.close();
            }
        }
    });
});
