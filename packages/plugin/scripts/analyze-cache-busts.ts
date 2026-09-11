#!/usr/bin/env bun
/**
 * analyze-cache-busts.ts — walk a session's authentication-plugin request
 * dumps and attribute prompt changes using the provider's usage meter.
 *
 * anthropic-auth bodies use `system` + `messages[]` and explicit cache-control
 * breakpoints. openai-auth bodies are OpenAI Responses requests: `instructions`
 * + `input[]`, where message, function-call, and function-output items share an
 * implicit prefix cache. WebSocket openai-auth captures may omit response files.
 * Both shapes are normalized to role + part type/length/text-prefix messages so
 * attribution and --show-diff have the same output on either lane.
 *
 * Usage:
 *   bun scripts/analyze-cache-busts.ts <sessionIdPrefix> [options]
 *   bun scripts/analyze-cache-busts.ts --session <sessionIdPrefix> [options]
 * Options:
 *   --session <id>   session id or prefix (positional form is also supported)
 *   --dir <path>     inspect only one explicit dump dir (legacy override)
 *   --anthropic-dir  anthropic-auth dir (env: OPENCODE_ANTHROPIC_AUTH_DUMP_DIR)
 *   --openai-dir     openai-auth dir (env: OPENCODE_OPENAI_AUTH_DUMP_DIR)
 *   --since <time>   created at/after ISO time or duration ago (for example 30m)
 *   --until <time>   created at/before ISO time or duration ago
 *   --limit <N>      only the last N requests in range
 *   --show-diff      print before/after snippet of the first-diverging segment
 *   --all-busts      list every diverging segment, not just the first
 *   --all-rows       also print STABLE and UNMETERED rows
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type BodyProvider,
    describeNormalizedMessage,
    type NormalizedMessage,
    normalizeRequestBody,
} from "./cache-bust-body-sources";

type Json = Record<string, unknown>;
type ByteVerdict = "BUST" | "STABLE";
type MeterVerdict = ByteVerdict | "LATENCY" | "UNMETERED";
type MeterVsBytes = "AGREE" | "BYTES-ONLY" | "LATENCY" | "UNMETERED";

interface Segment extends NormalizedMessage {
    id: string;
}

interface DumpSource {
    provider: BodyProvider;
    dir: string;
    label: string;
}

interface Args {
    sessionPrefix: string;
    sources: DumpSource[];
    since?: string;
    until?: string;
    limit?: number;
    showDiff: boolean;
    allBusts: boolean;
    allRows: boolean;
    help: boolean;
}

interface MeterUsage {
    cacheRead: number;
    cacheCreation: number;
    input: number;
    total: number;
    source: string;
    provider: BodyProvider;
    rule: string;
}

interface Snapshot {
    file: string;
    bodyPath: string;
    bodyBytes: number;
    createdAt: string;
    session: string;
    messagesCount: number;
    provider: BodyProvider;
    sourceDir: string;
    segments: Segment[];
    usage?: MeterUsage;
    orderCreatedAt: string;
    sequence: number;
}

interface AnalysisRow {
    current: Snapshot;
    previous?: Snapshot;
    divergenceIndex: number;
    byteVerdict?: ByteVerdict;
    verdict: MeterVerdict | "BASE";
    meterVsBytes?: MeterVsBytes;
    prevTotal?: number;
    epsilon?: number;
    meterFloor?: number;
    comparableRead?: number;
    shortRead?: boolean;
    rewrittenTokens?: number;
}

interface DumpCandidate {
    source: DumpSource;
    session: string;
    latestMtimeMs: number;
    totalBytes: number;
    dumpCount: number;
}

interface SnapshotSelection {
    snapshots: Snapshot[];
    selected?: DumpCandidate;
    candidates: DumpCandidate[];
}

function parseArgs(argv: string[]): Args {
    const args = argv.slice(2);
    const getOpt = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const valueOptions = new Set([
        "--session",
        "--dir",
        "--anthropic-dir",
        "--openai-dir",
        "--since",
        "--until",
        "--limit",
    ]);
    let positionalSession = "";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (valueOptions.has(arg)) {
            index += 1;
            continue;
        }
        if (!arg.startsWith("--")) {
            positionalSession = arg;
            break;
        }
    }
    const limitRaw = getOpt("--limit");
    const singleDir = getOpt("--dir");
    const sources: DumpSource[] = singleDir
        ? [{ provider: "anthropic", dir: singleDir, label: "explicit --dir" }]
        : [
              {
                  provider: "anthropic",
                  dir:
                      getOpt("--anthropic-dir") ??
                      process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR ??
                      join(tmpdir(), "opencode-anthropic-auth-dumps"),
                  label: "anthropic-auth",
              },
              {
                  provider: "openai",
                  dir:
                      getOpt("--openai-dir") ??
                      process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR ??
                      join(tmpdir(), "opencode-openai-auth-dumps"),
                  label: "openai-auth",
              },
          ];
    return {
        sessionPrefix: getOpt("--session") ?? positionalSession,
        sources,
        since: getOpt("--since"),
        until: getOpt("--until"),
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        showDiff: args.includes("--show-diff"),
        allBusts: args.includes("--all-busts"),
        allRows: args.includes("--all-rows"),
        help: args.includes("--help") || args.includes("-h"),
    };
}

function resolveTimeBound(value: string | undefined, nowMs = Date.now()): string | undefined {
    if (!value) return undefined;
    const duration = /^(\d+)(ms|s|m|h|d)$/.exec(value);
    if (duration) {
        const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
            duration[2] as "ms" | "s" | "m" | "h" | "d"
        ];
        return new Date(nowMs - Number.parseInt(duration[1], 10) * unitMs).toISOString();
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid time bound: ${value}`);
    return new Date(parsed).toISOString();
}

function parseDumpFilename(file: string): {
    createdAt: string;
    sequence: number;
    session: string;
} | null {
    const timestamp = /(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
    const session = /(?:^|-)(ses_[A-Za-z0-9]+)(?=-|\.meta\.json$)/.exec(file);
    if (!timestamp || !session) return null;
    const rest = file.slice(timestamp.index + timestamp[0].length);
    const sequence = /-(\d+)(?=-ses_)/.exec(rest);
    return {
        createdAt: `${timestamp[1]}:${timestamp[2]}:${timestamp[3]}.${timestamp[4]}Z`,
        sequence: sequence ? Number.parseInt(sequence[1], 10) : 0,
        session: session[1],
    };
}

function sessionMatches(candidate: string, prefix: string): boolean {
    const visibleHead = candidate.replace(/[….]+$/, "");
    return candidate.startsWith(prefix) || prefix.startsWith(visibleHead);
}

function buildSegments(body: Json, provider?: BodyProvider): { provider: BodyProvider; segments: Segment[] } {
    const normalized = normalizeRequestBody(body, provider);
    return {
        provider: normalized.provider,
        segments: normalized.messages.map((message, index) => ({
            ...message,
            id: `message[${index}] ${describeNormalizedMessage(message)}`,
        })),
    };
}

function asJson(value: unknown): Json | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function meterUsage(value: unknown, source: string, provider: BodyProvider): MeterUsage | undefined {
    const usage = asJson(value);
    if (!usage) return undefined;
    if (provider === "openai") {
        const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
        const details = asJson(usage.prompt_tokens_details) ?? asJson(usage.input_tokens_details);
        const cachedTokens = details?.cached_tokens ?? 0;
        if (
            typeof promptTokens !== "number" ||
            !Number.isFinite(promptTokens) ||
            typeof cachedTokens !== "number" ||
            !Number.isFinite(cachedTokens)
        ) {
            return undefined;
        }
        return {
            cacheRead: cachedTokens,
            cacheCreation: 0,
            input: Math.max(0, promptTokens - cachedTokens),
            total: promptTokens,
            source,
            provider,
            rule: "OpenAI implicit-prefix cache: prompt_tokens_details.cached_tokens; no write premium",
        };
    }
    if (typeof usage.input_tokens !== "number" || !Number.isFinite(usage.input_tokens)) {
        return undefined;
    }
    const cacheRead = usage.cache_read_input_tokens;
    const cacheCreation = usage.cache_creation_input_tokens;
    if (
        (cacheRead !== undefined && (typeof cacheRead !== "number" || !Number.isFinite(cacheRead))) ||
        (cacheCreation !== undefined &&
            (typeof cacheCreation !== "number" || !Number.isFinite(cacheCreation)))
    ) {
        return undefined;
    }
    return {
        cacheRead: cacheRead ?? 0,
        cacheCreation: cacheCreation ?? 0,
        input: usage.input_tokens,
        total: (cacheRead ?? 0) + (cacheCreation ?? 0) + usage.input_tokens,
        source,
        provider,
        rule: "Anthropic explicit cache: cache_read_input_tokens + direct input versus prior read/write/input total",
    };
}

/** Collect usage from completed JSON responses and from message_start/message_delta stream events. */
function collectUsageCandidates(
    value: unknown,
    source: string,
    provider: BodyProvider,
    candidates: MeterUsage[],
): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            collectUsageCandidates(entry, `${source}[${index}]`, provider, candidates);
        });
        return;
    }
    const object = asJson(value);
    if (!object) return;

    const eventType = typeof object.type === "string" ? object.type : source;
    const direct = meterUsage(object.usage, `${eventType}.usage`, provider);
    if (direct) candidates.push(direct);
    const message = asJson(object.message);
    const messageUsage = meterUsage(message?.usage, `${eventType}.message.usage`, provider);
    if (messageUsage) candidates.push(messageUsage);

    for (const [key, child] of Object.entries(object)) {
        if (key === "usage" || key === "message") continue;
        if (typeof child === "string" && key === "data") {
            try {
                collectUsageCandidates(JSON.parse(child), `${source}.data`, provider, candidates);
            } catch {
                // A non-JSON SSE data line cannot contain the usage meter.
            }
        } else if (child && typeof child === "object") {
            collectUsageCandidates(child, `${source}.${key}`, provider, candidates);
        }
    }
}

function parseResponsePayloads(raw: string): unknown[] {
    try {
        return [JSON.parse(raw)];
    } catch {
        const payloads: unknown[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const data = line.startsWith("data:") ? line.slice("data:".length).trim() : line.trim();
            if (!data || data === "[DONE]") continue;
            try {
                payloads.push(JSON.parse(data));
            } catch {
                // Ignore SSE event labels and incomplete/non-JSON lines.
            }
        }
        return payloads;
    }
}

function loadMeterUsage(
    responsePath: string | undefined,
    provider: BodyProvider = "anthropic",
): MeterUsage | undefined {
    if (!responsePath || !existsSync(responsePath)) return undefined;
    try {
        const candidates: MeterUsage[] = [];
        for (const payload of parseResponsePayloads(readFileSync(responsePath, "utf8"))) {
            collectUsageCandidates(payload, "response", provider, candidates);
        }
        return candidates.at(-1);
    } catch {
        return undefined;
    }
}

function artifactPaths(source: DumpSource, metaFile: string, meta: Json): {
    bodyPath?: string;
    responsePath?: string;
} {
    const files = asJson(meta.files);
    const referencedBodyPath = typeof files?.body === "string" ? files.body : undefined;
    const adjacentBodyPath = join(source.dir, metaFile.replace(/\.meta\.json$/, ".body.json"));
    const bodyPath =
        referencedBodyPath && existsSync(referencedBodyPath)
            ? referencedBodyPath
            : existsSync(adjacentBodyPath)
              ? adjacentBodyPath
              : undefined;
    const referencedResponsePath = typeof files?.response === "string" ? files.response : undefined;
    const adjacentResponsePath = join(source.dir, metaFile.replace(/\.meta\.json$/, ".response.json"));
    const responsePath =
        referencedResponsePath && existsSync(referencedResponsePath)
            ? referencedResponsePath
            : existsSync(adjacentResponsePath)
              ? adjacentResponsePath
              : undefined;
    return { bodyPath, responsePath };
}

function discoverDumpCandidates(opts: Args): DumpCandidate[] {
    const candidates = new Map<string, DumpCandidate>();
    const since = resolveTimeBound(opts.since);
    const until = resolveTimeBound(opts.until);
    for (const source of opts.sources) {
        if (!existsSync(source.dir)) continue;
        for (const metaFile of readdirSync(source.dir).filter((file) => file.endsWith(".meta.json"))) {
            const parsedName = parseDumpFilename(metaFile);
            let meta: Json;
            try {
                meta = JSON.parse(readFileSync(join(source.dir, metaFile), "utf8")) as Json;
            } catch {
                continue;
            }
            const metadataSession = String(meta.session ?? "");
            const session = parsedName?.session ?? metadataSession;
            if (!session || !sessionMatches(session, opts.sessionPrefix)) continue;
            const createdAt = parsedName?.createdAt ?? String(meta.createdAt ?? "");
            if (since && createdAt < since) continue;
            if (until && createdAt > until) continue;
            const { bodyPath } = artifactPaths(source, metaFile, meta);
            if (!bodyPath) continue;
            let bodyStat: ReturnType<typeof statSync>;
            try {
                bodyStat = statSync(bodyPath);
            } catch {
                continue;
            }
            const key = `${source.dir}\0${session}`;
            const existing = candidates.get(key) ?? {
                source,
                session,
                latestMtimeMs: 0,
                totalBytes: 0,
                dumpCount: 0,
            };
            existing.latestMtimeMs = Math.max(existing.latestMtimeMs, bodyStat.mtimeMs);
            existing.totalBytes += bodyStat.size;
            existing.dumpCount += 1;
            candidates.set(key, existing);
        }
    }
    return [...candidates.values()].sort(
        (left, right) =>
            right.latestMtimeMs - left.latestMtimeMs ||
            right.totalBytes - left.totalBytes ||
            left.session.localeCompare(right.session),
    );
}

function loadCandidateSnapshots(candidate: DumpCandidate, opts: Args): Snapshot[] {
    const since = resolveTimeBound(opts.since);
    const until = resolveTimeBound(opts.until);
    const snapshots: Snapshot[] = [];
    for (const metaFile of readdirSync(candidate.source.dir).filter((file) => file.endsWith(".meta.json"))) {
        const dumpName = parseDumpFilename(metaFile);
        if (dumpName && dumpName.session !== candidate.session) continue;
        let meta: Json;
        try {
            meta = JSON.parse(readFileSync(join(candidate.source.dir, metaFile), "utf8")) as Json;
        } catch {
            continue;
        }
        const metadataSession = String(meta.session ?? "");
        if (!dumpName && metadataSession !== candidate.session) continue;
        const createdAt = dumpName?.createdAt ?? String(meta.createdAt ?? "");
        if (since && createdAt < since) continue;
        if (until && createdAt > until) continue;
        const { bodyPath, responsePath } = artifactPaths(candidate.source, metaFile, meta);
        if (!bodyPath) continue;
        try {
            const rawBody = readFileSync(bodyPath);
            const body = JSON.parse(rawBody.toString("utf8")) as Json;
            const normalized = buildSegments(
                body,
                candidate.source.label === "explicit --dir" ? undefined : candidate.source.provider,
            );
            snapshots.push({
                file: metaFile,
                bodyPath,
                bodyBytes: rawBody.byteLength,
                createdAt,
                session: candidate.session,
                messagesCount: normalized.segments.length,
                provider: normalized.provider,
                sourceDir: candidate.source.dir,
                segments: normalized.segments,
                usage: loadMeterUsage(responsePath, normalized.provider),
                orderCreatedAt: dumpName?.createdAt ?? createdAt,
                sequence: dumpName?.sequence ?? 0,
            });
        } catch {
            // Ignore malformed or partially written request bodies.
        }
    }
    snapshots.sort(
        (left, right) =>
            left.orderCreatedAt.localeCompare(right.orderCreatedAt) ||
            left.sequence - right.sequence ||
            left.file.localeCompare(right.file),
    );
    return opts.limit && snapshots.length > opts.limit
        ? snapshots.slice(snapshots.length - opts.limit)
        : snapshots;
}

function loadSnapshotSelection(opts: Args): SnapshotSelection {
    const candidates = discoverDumpCandidates(opts);
    const selected = candidates[0];
    return {
        candidates,
        selected,
        snapshots: selected ? loadCandidateSnapshots(selected, opts) : [],
    };
}

function loadSnapshots(opts: Args): Snapshot[] {
    return loadSnapshotSelection(opts).snapshots;
}

/** First wire-order segment index where prev/cur diverge (added/removed/changed). */
function firstDivergence(prev: Segment[], cur: Segment[]): number {
    const n = Math.min(prev.length, cur.length);
    for (let index = 0; index < n; index += 1) {
        if (prev[index].hash !== cur[index].hash || prev[index].id !== cur[index].id) return index;
    }
    return prev.length === cur.length ? -1 : n;
}

/** Effective cached prefix = bytes up to the last breakpoint strictly before divergence. */
function cachedPrefixBytes(segs: Segment[], divergeIdx: number): { bytes: number; at: string } {
    let bytes = 0;
    let lastBreakpointBytes = 0;
    let lastBreakpointId = "(none)";
    const limit = divergeIdx < 0 ? segs.length : divergeIdx;
    for (let index = 0; index < segs.length; index += 1) {
        if (index < limit && segs[index].breakpoint) {
            lastBreakpointBytes = bytes + segs[index].bytes;
            lastBreakpointId = segs[index].id;
        }
        bytes += segs[index].bytes;
    }
    return { bytes: lastBreakpointBytes, at: lastBreakpointId };
}

function lastBreakpointIndex(segs: Segment[]): number {
    let last = -1;
    for (let index = 0; index < segs.length; index += 1) {
        if (segs[index].breakpoint) last = index;
    }
    return last;
}

function analyzeSnapshots(snaps: Snapshot[]): AnalysisRow[] {
    let previousShortRead = false;
    return snaps.map((current, index) => {
        if (index === 0) return { current, divergenceIndex: -1, verdict: "BASE" };
        const previous = snaps[index - 1];
        const divergenceIndex = firstDivergence(previous.segments, current.segments);
        // Anthropic exposes explicit breakpoints. OpenAI's cache is an implicit prefix,
        // so an in-place change/removal busts while ordinary appended input does not.
        const byteBust =
            current.provider === "openai"
                ? divergenceIndex >= 0 && divergenceIndex < previous.segments.length
                : divergenceIndex !== -1 && divergenceIndex <= lastBreakpointIndex(current.segments);
        const byteVerdict: ByteVerdict = byteBust ? "BUST" : "STABLE";
        if (!current.usage || !previous.usage) {
            previousShortRead = false;
            return {
                current,
                previous,
                divergenceIndex,
                byteVerdict,
                verdict: "UNMETERED",
                meterVsBytes: "UNMETERED",
            };
        }
        const prevTotal = previous.usage.total;
        const epsilon = Math.max(64, previous.usage.input);
        const meterFloor = prevTotal - epsilon;
        // Anthropic separates direct input from cache writes, so it belongs in the
        // comparable read. OpenAI's uncached prompt tokens include rewritten prefix
        // tokens; adding them back would make every prompt look fully cached.
        const comparableRead =
            current.provider === "openai"
                ? current.usage.cacheRead
                : current.usage.cacheRead + current.usage.input;
        // A rewrite cannot use the prior rewrite's direct input as forgiveness
        // while cacheRead remains at the same floor.
        const rebust = previousShortRead && current.usage.cacheRead <= previous.usage.cacheRead;
        const shortRead = rebust || comparableRead < meterFloor;
        previousShortRead = shortRead;
        const verdict: MeterVerdict = shortRead
            ? byteVerdict === "BUST"
                ? "BUST"
                : "LATENCY"
            : "STABLE";
        const meterVsBytes: MeterVsBytes =
            verdict === "LATENCY"
                ? "LATENCY"
                : verdict === "STABLE" && byteVerdict === "BUST"
                  ? "BYTES-ONLY"
                  : "AGREE";
        return {
            current,
            previous,
            divergenceIndex,
            byteVerdict,
            verdict,
            meterVsBytes,
            prevTotal,
            epsilon,
            meterFloor,
            comparableRead,
            shortRead,
            rewrittenTokens:
                verdict === "BUST" || verdict === "LATENCY"
                    ? rebust ? current.usage.input : prevTotal - current.usage.cacheRead
                    : undefined,
        };
    });
}

function fmtTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mi = String(date.getUTCMinutes()).padStart(2, "0");
    const ss = String(date.getUTCSeconds()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

function segmentText(snapshot: Snapshot, index: number): string | undefined {
    return index < 0 ? undefined : snapshot.segments[index]?.canonical;
}

function clippedDiff(text: string, start: number, end: number): string {
    const before = text.slice(Math.max(0, start - 120), start);
    const changed = text.slice(start, Math.min(end, start + 240));
    const after = text.slice(end, end + 120);
    return `${start > 120 ? "…" : ""}${before}[${changed}${end - start > 240 ? "…" : ""}]${after}${end + 120 < text.length ? "…" : ""}`;
}

function printSegmentDiff(previous: Snapshot, current: Snapshot, index: number): void {
    const prevText = segmentText(previous, index) ?? "(segment absent)";
    const curText = segmentText(current, index) ?? "(segment absent)";
    let start = 0;
    while (start < prevText.length && start < curText.length && prevText[start] === curText[start]) start += 1;
    let prevEnd = prevText.length;
    let curEnd = curText.length;
    while (prevEnd > start && curEnd > start && prevText[prevEnd - 1] === curText[curEnd - 1]) {
        prevEnd -= 1;
        curEnd -= 1;
    }
    console.log(`          └─ segment diff @char ${start}:`);
    console.log(`             prev: ${clippedDiff(prevText, start, prevEnd)}`);
    console.log(`             cur:  ${clippedDiff(curText, start, curEnd)}`);
}

function meterCell(row: AnalysisRow): string {
    if (row.verdict === "UNMETERED") return `unavailable; bytes=${row.byteVerdict}`;
    const read = row.current.usage?.cacheRead ?? 0;
    const rewritten = row.rewrittenTokens === undefined ? "" : `; rewritten≈${row.rewrittenTokens.toLocaleString()}`;
    const directInput = row.current.usage?.input ?? 0;
    const comparable =
        row.current.provider === "openai"
            ? `cached=${read.toLocaleString()}`
            : `read=${read.toLocaleString()} + input=${directInput.toLocaleString()} = ${row.comparableRead?.toLocaleString()}`;
    return `${comparable}; floor=${row.meterFloor?.toLocaleString()} (prevTotal=${row.prevTotal?.toLocaleString()}, ε=${row.epsilon?.toLocaleString()})${rewritten}`;
}

const HELP = `usage: bun scripts/analyze-cache-busts.ts --session <prefix> [options]

Sources (both searched by default):
  Anthropic: <tmp>/opencode-anthropic-auth-dumps (OPENCODE_ANTHROPIC_AUTH_DUMP_DIR)
             system + messages[] bodies; explicit read/write cache meters.
  OpenAI:    <tmp>/opencode-openai-auth-dumps (OPENCODE_OPENAI_AUTH_DUMP_DIR)
             Responses instructions + input[] bodies; implicit prefix cache,
             prompt_tokens_details.cached_tokens, and no write premium.
             WebSocket captures can have no response file and are UNMETERED.

Options:
  --dir <path>          inspect one explicit directory (legacy override)
  --anthropic-dir <p>   override the Anthropic source
  --openai-dir <path>   override the OpenAI source
  --since/--until <t>   ISO timestamp or duration ago (for example 2h)
  --limit <N>           keep the last N requests in range
  --show-diff           print both versions of the first-diverging message
  --all-busts           list every diverging message
  --all-rows            also print STABLE and UNMETERED rows`;

function main(): void {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(HELP);
        return;
    }
    if (!opts.sessionPrefix) {
        console.error(HELP);
        process.exit(1);
    }
    const selection = loadSnapshotSelection(opts);
    const snaps = selection.snapshots;
    if (snaps.length === 0) {
        const searched = opts.sources.map((source) => source.dir).join(", ");
        console.error(`No dumps found for session prefix "${opts.sessionPrefix}" in ${searched}`);
        process.exit(1);
    }
    if (selection.candidates.length > 1) {
        console.log(`Ambiguous session prefix "${opts.sessionPrefix}"; candidates:`);
        for (const candidate of selection.candidates) {
            console.log(
                `  ${candidate.session} provider=${candidate.source.provider} mtime=${new Date(candidate.latestMtimeMs).toISOString()} size=${candidate.totalBytes.toLocaleString()}B dumps=${candidate.dumpCount} dir=${candidate.source.dir}`,
            );
        }
        console.log(
            `Using newest candidate ${selection.selected?.session} from ${selection.selected?.source.dir}.`,
        );
        console.log("");
    }
    const rows = analyzeSnapshots(snaps);
    const provider = snaps[0].provider;
    const meterRule =
        snaps.find((snapshot) => snapshot.usage)?.usage?.rule ??
        (provider === "openai"
            ? "OpenAI implicit-prefix cache: prompt_tokens_details.cached_tokens; no write premium"
            : "Anthropic explicit cache: cache_read_input_tokens/cache_creation_input_tokens");
    console.log(`Session:  ${snaps[0].session}`);
    console.log(`Provider: ${provider} (${selection.selected?.source.label})`);
    console.log(`Dumps:    ${snaps.length}  (dir: ${snaps[0].sourceDir})`);
    console.log("");
    console.log("Dashboard times are local (UTC+2); table times are UTC.");
    console.log(
        `Meter rule (${provider}): ${meterRule}. Short when the provider-comparable read < prevTotal - ε, ε=max(64, previous direct/uncached input); bytes distinguish BUST from LATENCY.`,
    );
    console.log(
        "time(UTC)          | segs | verdict          | meter                                                  | meterVsBytes | first-divergence                | prevBodyBytes → curBodyBytes | reusableNormalizedPrefix@breakpoint",
    );
    console.log(
        "-------------------|------|------------------|--------------------------------------------------------|--------------|---------------------------------|-----------------------------|------------------------",
    );

    let bustCount = 0;
    let latencyCount = 0;
    let unmeteredBustCount = 0;
    for (const row of rows) {
        if (row.verdict === "BASE") {
            if (opts.allRows) {
                console.log(`${fmtTime(row.current.createdAt)} | ${String(row.current.segments.length).padStart(4)} | BASE             |                                                        |              | (first request)                 |                             |`);
            }
            continue;
        }
        const shouldPrint =
            opts.allRows ||
            row.verdict === "BUST" ||
            row.verdict === "LATENCY" ||
            (row.verdict === "UNMETERED" && row.byteVerdict === "BUST");
        if (!shouldPrint) continue;
        if (row.verdict === "BUST") bustCount += 1;
        if (row.verdict === "LATENCY") latencyCount += 1;
        if (row.verdict === "UNMETERED" && row.byteVerdict === "BUST") unmeteredBustCount += 1;

        const previous = row.previous as Snapshot;
        const index = row.divergenceIndex;
        const segment = index < 0 ? undefined : row.current.segments[index] ?? previous.segments[index];
        const attribution = segment
            ? `${segment.id} (bytes ${row.byteVerdict})`
            : `(identical; bytes ${row.byteVerdict})`;
        const currentPrefix = cachedPrefixBytes(row.current.segments, index);
        const byteDelta = `${previous.bodyBytes.toLocaleString()}B → ${row.current.bodyBytes.toLocaleString()}B`;
        const verdictLabel =
            row.verdict === "UNMETERED"
                ? `UNMETERED (bytes ${row.byteVerdict})`
                : `${row.verdict} (meter)`;
        console.log(
            `${fmtTime(row.current.createdAt)} | ${String(row.current.segments.length).padStart(4)} | ${verdictLabel.padEnd(16)} | ${meterCell(row).padEnd(54)} | ${(row.meterVsBytes ?? "").padEnd(12)} | ${attribution.padEnd(31)} | ${byteDelta.padEnd(27)} | ${currentPrefix.at} (${currentPrefix.bytes.toLocaleString()}B)`,
        );

        if (
            (opts.showDiff || opts.allBusts) &&
            index >= 0 &&
            (row.byteVerdict === "BUST" || opts.allRows)
        ) {
            if (opts.allBusts) {
                const diffs: number[] = [];
                const count = Math.max(previous.segments.length, row.current.segments.length);
                for (let diffIndex = index; diffIndex < count; diffIndex += 1) {
                    if (
                        previous.segments[diffIndex]?.hash !== row.current.segments[diffIndex]?.hash ||
                        previous.segments[diffIndex]?.id !== row.current.segments[diffIndex]?.id
                    ) {
                        diffs.push(diffIndex);
                    }
                }
                for (const diffIndex of diffs) {
                    console.log(`          └─ diverge @${diffIndex}: prev=${previous.segments[diffIndex]?.id ?? "—"}/${previous.segments[diffIndex]?.hash ?? "—"}  cur=${row.current.segments[diffIndex]?.id ?? "—"}/${row.current.segments[diffIndex]?.hash ?? "—"}`);
                }
            }
            if (opts.showDiff) printSegmentDiff(previous, row.current, index);
        }
    }

    console.log("");
    if (bustCount === 0) {
        console.log(`No metered busts across ${snaps.length} request(s).`);
    } else {
        console.log(`${bustCount} metered bust(s) across ${snaps.length} request(s).${opts.allRows ? "" : " (STABLE rows hidden; pass --all-rows to show them.)"}`);
    }
    if (latencyCount > 0) {
        console.log(`${latencyCount} latency-only short read(s) had no reusable-prefix byte divergence.`);
    }
    if (unmeteredBustCount > 0) {
        console.log(`${unmeteredBustCount} unmetered byte-attributed bust candidate(s); response usage was unavailable.`);
    }
}

export const __test = {
    analyzeSnapshots,
    loadMeterUsage,
    loadSnapshots,
    parseArgs,
    parseDumpFilename,
    resolveTimeBound,
};

if (import.meta.main) main();
