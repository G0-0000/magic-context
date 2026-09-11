import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
} from "../src/served-array-ledger";
import { __test } from "./analyze-pi-cache-busts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), label));
	temporaryDirectories.push(directory);
	return directory;
}

function assistant(
	id: string,
	timestamp: string,
	usage: { input: number; cacheRead: number; cacheWrite: number },
): Record<string, unknown> {
	return {
		type: "message",
		id,
		timestamp,
		message: {
			role: "assistant",
			timestamp,
			content: [{ type: "text", text: id }],
			usage: { ...usage, output: 10, totalTokens: 999_999 },
		},
	};
}

function writeJsonl(
	root: string,
	project: string,
	filename: string,
	entries: readonly unknown[],
): string {
	const directory = join(root, project);
	mkdirSync(directory, { recursive: true });
	const filePath = join(directory, filename);
	writeFileSync(
		filePath,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return filePath;
}

describe("Pi cache-bust analyzer discovery", () => {
	test("discovers Pi and OMP layouts and uses the session header id", async () => {
		const piRoot = temporaryDirectory("pi-cache-analyzer-pi-");
		const ompRoot = temporaryDirectory("pi-cache-analyzer-omp-");
		writeJsonl(piRoot, "--project--", "filename-is-not-id.jsonl", [
			{
				type: "session",
				id: "pi-header-id",
				timestamp: "2026-09-04T09:00:00Z",
			},
		]);
		writeJsonl(ompRoot, "project", "also-not-id.jsonl", [
			{ type: "title", title: "OMP title" },
			{
				type: "session",
				id: "omp-header-id",
				timestamp: "2026-09-04T09:00:00Z",
			},
		]);

		const sessions = await __test.discoverPiSessionFiles([piRoot, ompRoot]);

		expect(sessions.map((session) => session.sessionId).sort()).toEqual([
			"omp-header-id",
			"pi-header-id",
		]);
	});

	test("lists ambiguous cross-root candidates and selects the newest", () => {
		const piRoot = temporaryDirectory("pi-cache-ambiguous-pi-");
		const ompRoot = temporaryDirectory("pi-cache-ambiguous-omp-");
		const storageDir = temporaryDirectory("pi-cache-ambiguous-ledger-");
		const oldSession = "ambiguous-session-old";
		const newSession = "ambiguous-session-new";
		const oldPath = writeJsonl(piRoot, "--old--", "old.jsonl", [
			{ type: "session", id: oldSession },
		]);
		const newPath = writeJsonl(ompRoot, "--new--", "new.jsonl", [
			{ type: "session", id: newSession },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 0,
			}),
		]);
		utimesSync(oldPath, new Date(1_000), new Date(1_000));
		utimesSync(newPath, new Date(2_000), new Date(2_000));
		capturePiServedArray(newSession, [{ role: "user", content: "new" }], {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		flushPiServedArrayLedger();

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			"ambiguous-session-",
			"--pi-dir",
			piRoot,
			"--omp-dir",
			ompRoot,
			"--ledger-dir",
			storageDir,
			"--all-rows",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("Ambiguous session prefix");
		expect(output).toContain(`${oldSession} mtime=`);
		expect(output).toContain(`${newSession} mtime=`);
		expect(output).toContain("size=");
		expect(output).toContain(`Using newest candidate ${newPath}.`);
	});
});

describe("Pi cache-bust analyzer body attribution", () => {
	test("discovers pi-llm-debugging Responses bodies and prints the real message diff", () => {
		const sessionRoot = temporaryDirectory("pi-cache-body-session-");
		const ompRoot = temporaryDirectory("pi-cache-body-omp-");
		const storageDir = temporaryDirectory("pi-cache-body-ledger-");
		const sessionId = "pi-body-fixture";
		writeJsonl(sessionRoot, "--project--", "body.jsonl", [
			{ type: "session", id: sessionId, cwd: "/unused/by-override" },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 0,
			}),
			assistant("a2", "2026-09-04T10:00:02Z", {
				input: 20,
				cacheRead: 100,
				cacheWrite: 0,
			}),
		]);
		capturePiServedArray(sessionId, [{ role: "user", content: "before" }], {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, [{ role: "user", content: "after" }], {
			storageDir,
			now: new Date("2026-09-04T10:00:01Z"),
		});
		flushPiServedArrayLedger();
		const bodiesDir = join(
			import.meta.dir,
			"test-fixtures",
			"cache-bust-bodies",
			"pi-llm-debugging",
		);

		const run = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, "analyze-pi-cache-busts.ts"),
			"--session",
			sessionId,
			"--pi-dir",
			sessionRoot,
			"--omp-dir",
			ompRoot,
			"--ledger-dir",
			storageDir,
			"--bodies-dir",
			bodiesDir,
			"--all-rows",
			"--show-diff",
		]);

		expect(run.exitCode).toBe(0);
		const output = run.stdout.toString();
		expect(output).toContain("Bodies:  2");
		expect(output).toContain(
			'message[1] role=user parts=[input_text(13)] text="pi body after"',
		);
		expect(output).toContain(
			'prev: {"role":"user","content":[{"type":"input_text","text":"pi body [before]"}]}',
		);
		expect(output).toContain("Meter rule (Pi host)");
	});
});

describe("Pi cache-bust analyzer meter", () => {
	test("flags session A's consecutive rewrite instead of forgiving the previous bust input", () => {
		const readings = [
			[254592, 1054],
			[16896, 173076],
			[16896, 173524],
			[190336, 493],
		];
		const passes = readings.map(([cacheRead, input], index) => ({
			ledger: {
				version: 1 as const,
				session_id: "A",
				pass_ts: new Date(index * 1000).toISOString(),
				sequence: index,
				message_count: 2,
				sha256: String(index),
				previous_sha256: null,
				first_divergence_message_index: 0,
				block_vector_start: 0,
				block_vectors: ["user:text(1)"],
			},
			usage: {
				timestamp: index * 1000,
				createdAt: new Date(index * 1000).toISOString(),
				line: index,
				ordinal: index,
				messageId: String(index),
				input,
				cacheRead,
				cacheWrite: 0,
				total: input + cacheRead,
			},
			intervening: [],
		}));
		const rows = __test.analyzeJoinedPasses(passes);
		expect(rows.map((row) => row.verdict)).toEqual([
			"BASE",
			"BUST",
			"BUST",
			"STABLE",
		]);
		expect(rows[2].rewrittenTokens).toBe(173524);
	});
	test("detector control reports a known post-compaction collapse as BUST at the seam", () => {
		const sessionRoot = temporaryDirectory("pi-cache-positive-session-");
		const storageDir = temporaryDirectory("pi-cache-positive-ledger-");
		const sessionId = "019e8905-post-compaction-control";
		const entries = [
			{ type: "session", id: sessionId, timestamp: "2026-09-04T09:59:00Z" },
			assistant("a-prev", "2026-09-04T10:00:00Z", {
				input: 1_924,
				cacheRead: 185_856,
				cacheWrite: 0,
			}),
			{
				type: "compaction",
				id: "compact-1",
				timestamp: "2026-09-04T10:00:01Z",
				firstKeptEntryId: "997b8008",
			},
			assistant("a-next", "2026-09-04T10:00:02Z", {
				input: 95_420,
				cacheRead: 16_896,
				cacheWrite: 0,
			}),
		];
		const filePath = writeJsonl(
			sessionRoot,
			"--project--",
			"positive.jsonl",
			entries,
		);
		const before = [
			{ role: "system", content: "system" },
			{ role: "user", content: [{ type: "text", text: "kept" }] },
			{ role: "assistant", content: [{ type: "text", text: "old history" }] },
		];
		const after = [
			before[0],
			before[1],
			{
				role: "assistant",
				content: [{ type: "text", text: "compacted history" }],
			},
		];
		capturePiServedArray(sessionId, before, {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, after, {
			storageDir,
			now: new Date("2026-09-04T10:00:01.500Z"),
		});
		flushPiServedArrayLedger();
		const session = __test.parsePiSessionFile(filePath);
		expect(session).toBeDefined();
		const ledger = __test.loadLedger(sessionId, storageDir);

		const rows = __test.analyzeJoinedPasses(
			__test.joinPasses(ledger, session as NonNullable<typeof session>),
		);

		expect(rows[1].verdict).toBe("BUST");
		expect(rows[1].current.ledger.first_divergence_message_index).toBe(2);
		expect(rows[1].attribution).toContain("message[2] (compaction seam)");
		expect(rows[1].rewrittenTokens).toBe(170_884);
	});

	test("uses input plus cache read and cache write as prior meter total", () => {
		const sessionRoot = temporaryDirectory("pi-cache-meter-session-");
		const storageDir = temporaryDirectory("pi-cache-meter-ledger-");
		const sessionId = "meter-total";
		const filePath = writeJsonl(sessionRoot, "project", "meter.jsonl", [
			{ type: "session", id: sessionId },
			assistant("a1", "2026-09-04T10:00:00Z", {
				input: 20,
				cacheRead: 10_000,
				cacheWrite: 500,
			}),
			assistant("a2", "2026-09-04T10:00:02Z", {
				input: 20,
				cacheRead: 10_450,
				cacheWrite: 50,
			}),
		]);
		const served = [{ role: "user", content: "same" }];
		capturePiServedArray(sessionId, served, {
			storageDir,
			now: new Date("2026-09-04T09:59:59Z"),
		});
		capturePiServedArray(sessionId, served, {
			storageDir,
			now: new Date("2026-09-04T10:00:01Z"),
		});
		flushPiServedArrayLedger();
		const session = __test.parsePiSessionFile(filePath);
		const rows = __test.analyzeJoinedPasses(
			__test.joinPasses(
				__test.loadLedger(sessionId, storageDir),
				session as NonNullable<typeof session>,
			),
		);

		expect(rows[1].prevTotal).toBe(10_520);
		expect(rows[1].comparableRead).toBe(10_470);
		expect(rows[1].verdict).toBe("STABLE");
		expect(rows[1].attribution).toBe("identical digest");
	});
});
