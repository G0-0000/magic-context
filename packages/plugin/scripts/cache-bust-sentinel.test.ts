import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type AnalyzedCacheRequest,
    CACHE_BUST_RULE_TABLE,
    type CacheBustAttributionInput,
    type CacheBustDecisionAttribution,
    type CacheBustDivergenceClass,
    classifyCacheBust,
    isUnaccountedCacheBustClass,
    nearestCacheBustDecision,
} from "./cache-bust-attribution";
import {
    __test,
    type ActiveCacheBustSession,
    type CacheBustEvent,
    CacheBustSentinelInputError,
    type CacheBustSentinelOptions,
    cacheBustWindowId,
    eventForWindow,
    groupBustWindows,
    loadSentinelState,
    loadSessionDecisions,
    parseWakeEventRecordReply,
    runSentinelOnce,
    type WakeEventRecordReply,
} from "./cache-bust-sentinel";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), label));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function request(
    timestampMs: number,
    verdict: AnalyzedCacheRequest["verdict"] = "BUST",
    divergenceClass = "unaccounted_rewrite",
): AnalyzedCacheRequest {
    return {
        session: "ses_sentinel",
        at: new Date(timestampMs).toISOString(),
        timestampMs,
        verdict,
        rewrittenTokens: verdict === "BUST" ? 123 : undefined,
        divergenceClass: verdict === "BUST" ? (divergenceClass as never) : undefined,
        firstDivergence: "message[4] role=assistant",
        analyzerCmd:
            "cd packages/plugin && bun scripts/analyze-cache-busts.ts --session ses_sentinel",
    };
}

function options(stateFile: string): CacheBustSentinelOptions {
    return {
        once: true,
        send: false,
        intervalMs: 60_000,
        lookbackMs: 500,
        stateFile,
        databasePath: join(stateFile, "missing-context.db"),
        rustStorePath: join(stateFile, "missing-store.db"),
        connectionFile: join(stateFile, "missing-subc.json"),
        wakeModuleId: "prefrontal",
    };
}

const activeSession: ActiveCacheBustSession = {
    sessionId: "ses_sentinel",
    harness: "opencode",
    projectPath: "dir:test-project",
    activityMs: 1_000,
    directory: "/tmp/sentinel-project",
};

function decision(partial: Partial<CacheBustDecisionAttribution>): CacheBustDecisionAttribution {
    return {
        timestampMs: 1,
        decision: "execute",
        materialized: false,
        materializeReason: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 10_000,
        flush: false,
        source: "fixture",
        ...partial,
    };
}

describe("cache-bust attribution contract", () => {
    test("joins one fixture decision row for every accounted and unaccounted class", () => {
        const fixture = JSON.parse(
            readFileSync(
                join(import.meta.dir, "test-fixtures", "cache-bust-sentinel", "classifier.json"),
                "utf8",
            ),
        ) as Array<{
            class: CacheBustDivergenceClass;
            decisionTimestampOffsetMs?: number;
            decision: Partial<CacheBustDecisionAttribution>;
            input: Omit<Partial<CacheBustAttributionInput>, "decision">;
        }>;
        expect(fixture.map((row) => row.class)).toEqual(
            CACHE_BUST_RULE_TABLE.map((row) => row.divergenceClass),
        );

        for (const row of fixture) {
            const passTimestampMs = 10_000;
            const joinedDecision = nearestCacheBustDecision(
                [
                    decision({
                        ...row.decision,
                        timestampMs: passTimestampMs + (row.decisionTimestampOffsetMs ?? 0),
                    }),
                ],
                passTimestampMs,
            );
            const input: CacheBustAttributionInput = {
                ...row.input,
                divergenceIndex: row.input.divergenceIndex ?? 2,
                previousMessageCount: row.input.previousMessageCount ?? 10,
                decision: joinedDecision,
            };
            expect(classifyCacheBust(input)).toBe(row.class);
            expect(isUnaccountedCacheBustClass(row.class)).toBe(
                !CACHE_BUST_RULE_TABLE.find((rule) => rule.divergenceClass === row.class)
                    ?.accounted,
            );
        }
    });

    test("keeps a tiny mid-history first_render seam unaccounted on a defer pass", () => {
        expect(
            classifyCacheBust({
                divergenceIndex: 268,
                previousMessageCount: 2_400,
                firstDivergenceRole: "user",
                firstDivergenceSize: 24,
                rewrittenTokens: 239_000,
                promptTokens: 256_000,
                decision: decision({
                    decision: "defer",
                    materialized: true,
                    materializeReason: "first_render",
                }),
            }),
        ).toBe("unaccounted_defer_pass");
    });

    test("uses a matched MC pass to distinguish a restart-sized system rewrite from effort-row noise", () => {
        const matchedDefer = decision({ decision: "defer", timestampMs: 10_000 });
        expect(
            classifyCacheBust({
                divergenceIndex: 0,
                previousMessageCount: 100,
                firstDivergenceRole: "system",
                rewrittenTokens: 536_000,
                promptTokens: 350_000,
                decision: nearestCacheBustDecision([matchedDefer], 10_100),
            }),
        ).toBe("accounted_hard_system_hash");
        expect(
            classifyCacheBust({
                divergenceIndex: 0,
                previousMessageCount: 100,
                firstDivergenceRole: "system",
                rewrittenTokens: 2_000,
                promptTokens: 350_000,
                decision: nearestCacheBustDecision([matchedDefer], 10_100),
            }),
        ).toBe("system_row_shift");
    });
});

describe("cache-bust windows and ids", () => {
    test("groups only consecutive BUST requests no more than 120 seconds apart", () => {
        const windows = groupBustWindows([
            request(1_000),
            request(121_000),
            request(121_001, "STABLE"),
            request(122_000),
            request(242_001),
        ]);

        expect(windows.map((window) => window.rows.map((row) => row.timestampMs))).toEqual([
            [1_000, 121_000],
            [122_000],
            [242_001],
        ]);
    });

    test("does not hide a later unaccounted BUST inside an accounted window", () => {
        const state = __test.defaultState();
        const [window] = groupBustWindows([
            request(50_000, "BUST", "accounted_hard_fold"),
            request(60_000, "BUST", "unaccounted_defer_pass"),
        ]);

        expect(eventForWindow(window, "/project", state)?.payload.divergence_class).toBe(
            "unaccounted_defer_pass",
        );
    });

    test("keeps the base id stable and never emits the same window id twice", () => {
        const state = __test.defaultState();
        const [window] = groupBustWindows([request(50_000)]);

        const first = eventForWindow(window, "/project", state);
        const rerun = eventForWindow(window, "/project", state);

        expect(first?.vendor_event_id).toBe(cacheBustWindowId("ses_sentinel", 50_000));
        expect(rerun).toBeNull();
    });

    test("uses a new id with supersedes when a re-analysis changes class", () => {
        const state = __test.defaultState();
        const [firstWindow] = groupBustWindows([
            request(50_000, "BUST", "unaccounted_tail_rewrite"),
        ]);
        const first = eventForWindow(firstWindow, "/project", state) as CacheBustEvent;
        const [changedWindow] = groupBustWindows([
            request(50_000, "BUST", "unaccounted_defer_pass"),
        ]);

        const changed = eventForWindow(changedWindow, "/project", state);

        expect(changed?.vendor_event_id).not.toBe(first.vendor_event_id);
        expect(changed?.supersedes).toBe(first.vendor_event_id);
    });
});

describe("MC decision store joins", () => {
    test("loads TS decision rows and rust scheduler-history mirrors read-only", () => {
        const directory = temporaryDirectory("cache-bust-sentinel-decisions-");
        const contextPath = join(directory, "context.db");
        const storePath = join(directory, "store.db");
        const context = new Database(contextPath);
        context.exec(`
            CREATE TABLE transform_decisions (
                session_id TEXT, harness TEXT, message_id TEXT, ts_ms INTEGER,
                decision TEXT, materialized INTEGER, materialize_reason TEXT,
                emergency INTEGER, dropped_tokens INTEGER, dropped_count INTEGER,
                input_tokens INTEGER
            );
            INSERT INTO transform_decisions VALUES
                ('ses_sentinel', 'opencode', 'msg-fold', 10000, 'defer', 1,
                 'system_hash', 0, 0, 4, 100000);
        `);
        context.close(false);
        const store = new Database(storePath);
        store.exec(`
            CREATE TABLE mc_pass_trace (
                session_id TEXT PRIMARY KEY,
                scheduler_history TEXT,
                scheduler_interesting_history TEXT
            );
        `);
        store.query("INSERT INTO mc_pass_trace VALUES (?, ?, ?)").run(
            "ses_sentinel",
            JSON.stringify([
                {
                    timestamp_ms: 20_200,
                    request_observed_at_ms: 20_100,
                    scheduler_decision: "Execute",
                    canonical_decision: "execute",
                    applied_drop_count: 2,
                },
            ]),
            "[]",
        );
        store.close(false);

        const loaded = loadSessionDecisions(activeSession, {
            ...options(join(directory, "state.json")),
            databasePath: contextPath,
            rustStorePath: storePath,
        });

        expect(nearestCacheBustDecision(loaded, 10_100)?.materializeReason).toBe("system_hash");
        expect(nearestCacheBustDecision(loaded, 20_100)).toMatchObject({
            canonicalDecision: "execute",
            droppedCount: 2,
        });
    });
});

describe("wake.event_record reply contract", () => {
    test("rejects malformed replies as typed input errors", () => {
        expect(() => parseWakeEventRecordReply({ accepted: false, reason: "retry" })).toThrow(
            CacheBustSentinelInputError,
        );
    });
});

describe("cache-bust sentinel runs", () => {
    test("persists and reuses the per-session request high-water mark", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-watermark-");
        const stateFile = join(directory, "state.json");
        const seenSince: number[] = [];
        const runOptions = options(stateFile);
        const deps = {
            now: () => 1_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async (_session: ActiveCacheBustSession, sinceExclusiveMs: number) => {
                seenSince.push(sinceExclusiveMs);
                const requests = sinceExclusiveMs < 900 ? [request(900, "STABLE")] : [];
                return {
                    requests,
                    highWaterMarkMs: requests.at(-1)?.timestampMs ?? null,
                };
            },
            stdout: () => {},
            stderr: () => {},
        };

        await runSentinelOnce(runOptions, deps);
        await runSentinelOnce(runOptions, deps);

        expect(seenSince).toEqual([500, 900]);
        expect(loadSentinelState(stateFile).sessions.ses_sentinel).toEqual({
            lastAnalyzedRequestTimestampMs: 900,
        });
    });

    test("loads the Pi analyzer library surface without mutating empty input roots", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-pi-library-");
        const runOptions = {
            ...options(join(directory, "state.json")),
            piDir: join(directory, "pi-sessions"),
            ompDir: join(directory, "omp-sessions"),
            ledgerDir: join(directory, "mc-data"),
        };

        const counters = await runSentinelOnce(runOptions, {
            now: () => 1_000,
            listActiveSessions: () => [{ ...activeSession, harness: "pi" }],
            loadDecisions: () => [],
            stdout: () => {},
            stderr: () => {},
        });

        expect(counters).toMatchObject({ sessions: 1, requests: 0, bustWindows: 0 });
    });

    test("prints one exact contract-shaped JSON line in dry-run mode", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-dry-run-");
        const output: string[] = [];
        const runOptions = options(join(directory, "state.json"));

        const counters = await runSentinelOnce(runOptions, {
            now: () => 1_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async () => ({
                requests: [request(900)],
                highWaterMarkMs: 900,
                directory: "/tmp/sentinel-project",
            }),
            stdout: (line) => output.push(line),
            stderr: () => {},
        });

        expect(counters.dryRun).toBe(1);
        expect(output).toHaveLength(1);
        expect(JSON.parse(output[0])).toEqual({
            source_module: "magic-context",
            kind: "cache_bust",
            vendor_event_id: cacheBustWindowId("ses_sentinel", 900),
            session_id: "ses_sentinel",
            directory: "/tmp/sentinel-project",
            occurred_at_ms: 900,
            payload: {
                session: "ses_sentinel",
                at: new Date(900).toISOString(),
                rewritten_tokens: 123,
                divergence_class: "unaccounted_rewrite",
                first_divergence: "message[4] role=assistant",
                analyzer_cmd:
                    "cd packages/plugin && bun scripts/analyze-cache-busts.ts --session ses_sentinel",
            },
        });
    });

    test("calls the transport once per window and counts every disposition", async () => {
        const directory = temporaryDirectory("cache-bust-sentinel-send-");
        const runOptions = {
            ...options(join(directory, "state.json")),
            send: true,
            lookbackMs: 1_000_000,
        };
        const calls: CacheBustEvent[] = [];
        const replies: WakeEventRecordReply[] = [
            { accepted: true, fire_id: "fire-1" },
            { accepted: false, reason: "unowned_session" },
            { accepted: false, reason: "dedup" },
            { accepted: false, reason: "superseded" },
        ];

        const counters = await runSentinelOnce(runOptions, {
            now: () => 800_000,
            listActiveSessions: () => [activeSession],
            loadDecisions: () => [],
            analyzeSession: async () => ({
                requests: [request(100_000), request(300_001), request(500_002), request(700_003)],
                highWaterMarkMs: 700_003,
                directory: "/tmp/sentinel-project",
            }),
            transport: {
                async record(event) {
                    calls.push(event);
                    return replies[calls.length - 1];
                },
            },
            stdout: () => {},
            stderr: () => {},
        });

        expect(calls).toHaveLength(4);
        expect(counters).toMatchObject({
            bustWindows: 4,
            unaccountedWindows: 4,
            accepted: 1,
            unownedSession: 1,
            dedup: 1,
            superseded: 1,
        });
    });
});
