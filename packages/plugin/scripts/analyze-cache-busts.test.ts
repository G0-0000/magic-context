import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "./analyze-cache-busts";
import { describeBodyPair, normalizeRequestBody } from "./cache-bust-body-sources";

type UsageFixture = {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    input_tokens: number;
};

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function responseUsage(usage: UsageFixture): unknown {
    return { status: 200, usage };
}

function streamedUsage(usage: UsageFixture): unknown {
    return {
        events: [
            { type: "message_start", message: { usage } },
            { type: "message_delta", usage },
        ],
    };
}

function writeDump(
    dir: string,
    stem: string,
    createdAt: string,
    session: string,
    body: unknown,
    response: unknown = responseUsage({ input_tokens: 1 }),
): void {
    const bodyPath = join(dir, `${stem}.body.json`);
    const responsePath = join(dir, `${stem}.response.json`);
    writeFileSync(bodyPath, JSON.stringify(body));
    writeFileSync(responsePath, JSON.stringify(response));
    writeFileSync(
        join(dir, `${stem}.meta.json`),
        JSON.stringify({
            createdAt,
            session: `${session.slice(0, 12)}…`,
            files: { body: bodyPath, response: responsePath },
            body: { messagesCount: Array.isArray((body as { messages?: unknown[] }).messages) ? (body as { messages: unknown[] }).messages.length : 0 },
        }),
    );
}

function bodyWithBreakpointMessage(text: string): unknown {
    return {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
            },
        ],
    };
}

function bodyWithTail(text: string, tailBreakpoint = false): unknown {
    const tail = { type: "text", text } as { type: string; text: string; cache_control?: unknown };
    if (tailBreakpoint) tail.cache_control = { type: "ephemeral" };
    return {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } }],
            },
            { role: "assistant", content: [tail] },
        ],
    };
}

function bodyWithTailCheckpoint(text: string): unknown {
    return {
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } }],
            },
            { role: "assistant", content: [{ type: "text", text }] },
            {
                role: "user",
                content: [{ type: "text", text: "current tail checkpoint", cache_control: { type: "ephemeral" } }],
            },
        ],
    };
}

function snapshotsFor(dir: string, session: string) {
    return __test.loadSnapshots(
        __test.parseArgs(["bun", "analyze-cache-busts.ts", "--session", session, "--dir", dir]),
    );
}

describe("analyze-cache-bust dump discovery", () => {
    test("does not forgive consecutive prefix rewrites at the same read floor", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-rebust-"));
        tempDirs.push(dir);
        const session = "ses_rebust";
        const readings = [[254592, 1054], [16896, 173076], [16896, 173524], [190336, 493]];
        readings.forEach(([cacheRead, input], index) => {
            writeDump(dir, `2026-09-11T07-56-0${index}-000Z-${session}`, `2026-09-11T07:56:0${index}Z`, session,
                bodyWithBreakpointMessage(String(index)), responseUsage({input_tokens: input!, cache_read_input_tokens: cacheRead!, cache_creation_input_tokens: 0}));
        });
        const rows = __test.analyzeSnapshots(snapshotsFor(dir, session));
        expect(rows.map(row => row.verdict)).toEqual(["BASE", "BUST", "BUST", "STABLE"]);
        expect(rows[2]!.rewrittenTokens).toBe(173524);
    });
    test("prints complete UTF-8 body bytes separately from reusable normalized prefix bytes", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-body-bytes-"));
        tempDirs.push(dir);
        const session = "ses_bodyBytes";
        const previous = bodyWithTailCheckpoint("old § tail");
        const current = bodyWithTailCheckpoint("new § tail with more bytes");
        const previousStem = `2026-09-02T08-41-00-000Z-${session}`;
        const currentStem = `2026-09-02T08-42-00-000Z-${session}`;
        writeDump(dir, previousStem, "2026-09-02T08:41:00Z", session, previous);
        writeDump(dir, currentStem, "2026-09-02T08:42:00Z", session, current);
        const prettyBody = `${JSON.stringify(current, null, 2)}\n`;
        writeFileSync(join(dir, `${currentStem}.body.json`), prettyBody);
        const expected = [Buffer.byteLength(JSON.stringify(previous)), Buffer.byteLength(prettyBody)];
        expect(snapshotsFor(dir, session).map((snapshot) => snapshot.bodyBytes)).toEqual(expected);
        const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "analyze-cache-busts.ts"), "--session", session, "--dir", dir, "--all-rows"]);
        expect(run.exitCode).toBe(0);
        const output = run.stdout.toString();
        expect(output).toContain("prevBodyBytes → curBodyBytes");
        expect(output).toContain("reusableNormalizedPrefix@breakpoint");
        expect(output).toContain(`${expected[0]!.toLocaleString()}B → ${expected[1]!.toLocaleString()}B`);
    });
    test("loads and orders legacy and sequence+routing filename layouts by timestamp and sequence", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-fixture-"));
        tempDirs.push(dir);
        const session = "ses_fixtureFull123";
        const legacy = `2026-09-02T08-41-39-474Z-${session}`;
        const currentEarly = `2026-09-02T08-46-03-306Z-000002-${session}-direct-sticky-yiyi`;
        const currentLate = `2026-09-02T08-46-03-306Z-000013-${session}-direct-sticky-yiyi`;
        writeDump(dir, currentLate, "2026-09-02T08:46:03.306Z", session, bodyWithTail("late"));
        writeDump(dir, legacy, "2026-09-02T08:41:39.474Z", session, bodyWithTail("legacy"));
        writeDump(dir, currentEarly, "2026-09-02T08:46:03.306Z", session, bodyWithTail("early"));

        const snapshots = snapshotsFor(dir, session);

        expect(snapshots.map((snapshot) => snapshot.file)).toEqual([
            `${legacy}.meta.json`,
            `${currentEarly}.meta.json`,
            `${currentLate}.meta.json`,
        ]);
        expect(snapshots.every((snapshot) => snapshot.session === session)).toBe(true);
    });

    test("records actual request bytes independently of cached-prefix attribution", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-wire-bytes-"));
        tempDirs.push(dir);
        const session = "ses_wireBytesFixture";
        const body = bodyWithTail("wire byte payload");
        writeDump(
            dir,
            `2026-09-02T08-46-03-306Z-000002-${session}`,
            "2026-09-02T08:46:03.306Z",
            session,
            body,
        );

        expect(snapshotsFor(dir, session)[0]?.bodyBytes).toBe(
            Buffer.byteLength(JSON.stringify(body)),
        );
    });

    test("lists ambiguous cross-provider candidates and selects the newest", () => {
        const anthropicDir = mkdtempSync(join(tmpdir(), "cache-bust-anthropic-candidate-"));
        const openaiDir = mkdtempSync(join(tmpdir(), "cache-bust-openai-candidate-"));
        tempDirs.push(anthropicDir, openaiDir);
        const oldSession = "ses_ambiguousOld";
        const newSession = "ses_ambiguousNew";
        const oldStem = `2026-09-02T08-41-00-000Z-000001-${oldSession}`;
        const newStem = `2026-09-02T08-42-00-000Z-000001-${newSession}`;
        writeDump(anthropicDir, oldStem, "2026-09-02T08:41:00Z", oldSession, bodyWithTail("old"));
        writeDump(openaiDir, newStem, "2026-09-02T08:42:00Z", newSession, {
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "new" }] }],
        });
        utimesSync(join(anthropicDir, `${oldStem}.body.json`), new Date(1_000), new Date(1_000));
        utimesSync(join(openaiDir, `${newStem}.body.json`), new Date(2_000), new Date(2_000));

        const run = Bun.spawnSync(
            [process.execPath, join(import.meta.dir, "analyze-cache-busts.ts"), "--session", "ses_ambiguous", "--all-rows"],
            {
                env: {
                    ...process.env,
                    OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: anthropicDir,
                    OPENCODE_OPENAI_AUTH_DUMP_DIR: openaiDir,
                },
            },
        );

        expect(run.exitCode).toBe(0);
        const output = run.stdout.toString();
        expect(output).toContain("Ambiguous session prefix");
        expect(output).toContain(`${oldSession} provider=anthropic mtime=`);
        expect(output).toContain(`${newSession} provider=openai mtime=`);
        expect(output).toContain("size=");
        expect(output).toContain(`Using newest candidate ${newSession} from ${openaiDir}.`);
    });

    test("resolves relative --since durations", () => {
        expect(__test.resolveTimeBound("30m", 1_800_000)).toBe("1970-01-01T00:00:00.000Z");
        expect(__test.resolveTimeBound("2026-09-02T08:30:00Z", 0)).toBe(
            "2026-09-02T08:30:00.000Z",
        );
    });
});

describe("analyze-cache-bust normalized provider fixtures", () => {
    const fixtureRoot = join(import.meta.dir, "test-fixtures", "cache-bust-bodies");
    const fixtureJson = (source: string, file: string): Record<string, unknown> =>
        JSON.parse(readFileSync(join(fixtureRoot, source, file), "utf8")) as Record<string, unknown>;

    for (const source of ["anthropic", "openai-auth"] as const) {
        test(`${source} names the normalized first-diverging message`, () => {
            const provider = source === "anthropic" ? "anthropic" : "openai";
            const previous = normalizeRequestBody(fixtureJson(source, "001-request.json"), provider);
            const current = normalizeRequestBody(fixtureJson(source, "002-request.json"), provider);

            const divergence = describeBodyPair(previous.messages, current.messages);

            expect(divergence?.description).toBe(
                `message[1] role=user parts=[${provider === "anthropic" ? "text" : "input_text"}(19)] text="cached prefix after"`,
            );
        });

        test(`${source} applies its provider meter rule`, () => {
            const dir = mkdtempSync(join(tmpdir(), `cache-bust-${source}-fixture-`));
            tempDirs.push(dir);
            const session = `ses_${source.replace("-", "")}`;
            for (const [index, timestamp] of [
                [1, "2026-09-02T08:41:00.000Z"],
                [2, "2026-09-02T08:42:00.000Z"],
            ] as const) {
                writeDump(
                    dir,
                    `2026-09-02T08-${index === 1 ? "41" : "42"}-00-000Z-00000${index}-${session}`,
                    timestamp,
                    session,
                    fixtureJson(source, `00${index}-request.json`),
                    fixtureJson(source, `00${index}-response.json`),
                );
            }

            const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

            expect(row.verdict).toBe("BUST");
            expect(row.current.provider).toBe(source === "anthropic" ? "anthropic" : "openai");
            expect(row.current.usage?.rule).toContain(
                source === "anthropic" ? "Anthropic explicit cache" : "OpenAI implicit-prefix cache",
            );
        });
    }
});

describe("analyze-cache-bust provider meter verdicts", () => {
    test("discriminates one metered bust from one latency row", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-discrimination-"));
        tempDirs.push(dir);
        const bustSession = "ses_bustDiscrimination";
        const latencySession = "ses_latencyDiscrimination";

        writeDump(
            dir,
            `2026-09-02T04-47-20-000Z-000001-${bustSession}`,
            "2026-09-02T04:47:20.000Z",
            bustSession,
            bodyWithBreakpointMessage("stable predecessor"),
            responseUsage({ cache_read_input_tokens: 387_595, input_tokens: 4 }),
        );
        writeDump(
            dir,
            `2026-09-02T04-47-29-000Z-000002-${bustSession}`,
            "2026-09-02T04:47:29.000Z",
            bustSession,
            bodyWithBreakpointMessage("rewritten breakpoint"),
            responseUsage({
                cache_read_input_tokens: 267_383,
                cache_creation_input_tokens: 120_212,
                input_tokens: 4,
            }),
        );

        const unchangedBody = bodyWithTailCheckpoint("unchanged tail");
        writeDump(
            dir,
            `2026-09-02T04-48-00-000Z-000001-${latencySession}`,
            "2026-09-02T04:48:00.000Z",
            latencySession,
            unchangedBody,
            responseUsage({ cache_creation_input_tokens: 300_000, input_tokens: 2 }),
        );
        writeDump(
            dir,
            `2026-09-02T04-48-01-000Z-000002-${latencySession}`,
            "2026-09-02T04:48:01.000Z",
            latencySession,
            unchangedBody,
            responseUsage({ cache_read_input_tokens: 100_000, input_tokens: 2 }),
        );

        const bust = __test.analyzeSnapshots(snapshotsFor(dir, bustSession))[1];
        const latency = __test.analyzeSnapshots(snapshotsFor(dir, latencySession))[1];

        expect([bust.verdict, latency.verdict]).toEqual(["BUST", "LATENCY"]);
        expect(bust.byteVerdict).toBe("BUST");
        expect(latency.byteVerdict).toBe("STABLE");
        expect(bust.rewrittenTokens).not.toBe(latency.rewrittenTokens);
    });

    test("classifies a breakpoint rewrite as a metered bust", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_realBustFixture";
        writeDump(
            dir,
            `2026-09-02T08-45-00-000Z-000001-${session}`,
            "2026-09-02T08:45:00.000Z",
            session,
            bodyWithBreakpointMessage("old prompt section"),
            responseUsage({ cache_read_input_tokens: 387_595, input_tokens: 4 }),
        );
        writeDump(
            dir,
            `2026-09-02T08-46-03-000Z-000002-${session}`,
            "2026-09-02T08:46:03.000Z",
            session,
            bodyWithBreakpointMessage("rewritten prompt section"),
            responseUsage({
                cache_read_input_tokens: 267_383,
                cache_creation_input_tokens: 120_212,
                input_tokens: 4,
            }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("BUST");
        expect(row.byteVerdict).toBe("BUST");
        expect(row.meterVsBytes).toBe("AGREE");
        expect(row.rewrittenTokens).toBe(120_216);
    });

    test("forgives a tail divergence when the streamed usage meter reports a hit", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_falsePositiveFixture";
        const priorUsage = {
            cache_read_input_tokens: 411_287,
            input_tokens: 4,
        };
        writeDump(
            dir,
            `2026-09-02T09-17-40-000Z-000001-${session}`,
            "2026-09-02T09:17:40.000Z",
            session,
            bodyWithTail("older tail payload", true),
            responseUsage(priorUsage),
        );
        writeDump(
            dir,
            `2026-09-02T09-17-52-000Z-000002-${session}`,
            "2026-09-02T09:17:52.000Z",
            session,
            bodyWithTailCheckpoint("new tail payload"),
            streamedUsage({
                cache_read_input_tokens: 411_287,
                cache_creation_input_tokens: 1_771,
                input_tokens: 4,
            }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        // The provider meter remains authoritative when a changed segment is within
        // the current tail breakpoint but the read is not materially short.
        expect(row.verdict).toBe("STABLE");
        expect(row.byteVerdict).toBe("BUST");
        expect(row.meterVsBytes).toBe("BYTES-ONLY");
        expect(row.meterFloor).toBe(411_227);
        expect(row.comparableRead).toBe(411_291);
        expect(row.current.usage?.source).toBe("message_delta.usage");
    });

    test("classifies the CKIOS cold-write follow-up as a metered bust", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_ckiosFixture";
        writeDump(
            dir,
            `2026-09-02T10-00-24-000Z-000001-${session}`,
            "2026-09-02T10:00:24.000Z",
            session,
            bodyWithTailCheckpoint("before cold write"),
            responseUsage({ cache_creation_input_tokens: 312_913, input_tokens: 4 }),
        );
        writeDump(
            dir,
            `2026-09-02T10-01-43-000Z-000002-${session}`,
            "2026-09-02T10:01:43.000Z",
            session,
            bodyWithTailCheckpoint("rewritten after cold write"),
            responseUsage({
                cache_read_input_tokens: 224_224,
                cache_creation_input_tokens: 91_447,
                input_tokens: 2,
            }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("BUST");
        expect(row.shortRead).toBe(true);
        expect(row.byteVerdict).toBe("BUST");
        expect(row.rewrittenTokens).toBe(88_693);
    });

    test("labels a short read without reusable-prefix byte divergence as latency", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_latencyFixture";
        const unchangedBody = bodyWithTailCheckpoint("unchanged tail");
        writeDump(
            dir,
            `2026-09-02T10-10-00-000Z-000001-${session}`,
            "2026-09-02T10:10:00.000Z",
            session,
            unchangedBody,
            responseUsage({ cache_creation_input_tokens: 300_000, input_tokens: 2 }),
        );
        writeDump(
            dir,
            `2026-09-02T10-10-01-000Z-000002-${session}`,
            "2026-09-02T10:10:01.000Z",
            session,
            unchangedBody,
            responseUsage({ cache_read_input_tokens: 100_000, input_tokens: 2 }),
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.shortRead).toBe(true);
        expect(row.verdict).toBe("LATENCY");
        expect(row.byteVerdict).toBe("STABLE");
        expect(row.meterVsBytes).toBe("LATENCY");
        expect(row.rewrittenTokens).toBe(200_002);
    });

    test("reports an unmetered byte-attributed candidate when a response has no usage", () => {
        const dir = mkdtempSync(join(tmpdir(), "cache-bust-meter-"));
        tempDirs.push(dir);
        const session = "ses_unmeteredFixture";
        writeDump(
            dir,
            `2026-09-02T09-20-00-000Z-000001-${session}`,
            "2026-09-02T09:20:00.000Z",
            session,
            bodyWithBreakpointMessage("before"),
            responseUsage({ cache_read_input_tokens: 10, input_tokens: 1 }),
        );
        writeDump(
            dir,
            `2026-09-02T09-20-01-000Z-000002-${session}`,
            "2026-09-02T09:20:01.000Z",
            session,
            bodyWithBreakpointMessage("after"),
            { status: 200, stream_complete: false },
        );

        const row = __test.analyzeSnapshots(snapshotsFor(dir, session))[1];

        expect(row.verdict).toBe("UNMETERED");
        expect(row.byteVerdict).toBe("BUST");
        expect(row.meterVsBytes).toBe("UNMETERED");
    });
});
