/**
 * Contract tests for task-requested memory injection (`⟦mc-mem: …⟧` markers).
 * Matrix follows the oracle audit doc §8 (parsing/boundaries, read
 * eligibility, idempotency/lifecycle, CAS, coexistence/ordering).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as memoryStorage from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	insertMemory,
	updateMemoryStatus,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import * as storagePersisted from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	appendSubagentInjectDecision,
	getSubagentInjectDecisions,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	appendPayloadToMessage,
	buildInjectPayload,
	MAX_TASK_MEMORY_IDS,
	parseMarkerInner,
	runSubagentInjectForPi,
	scanTextPartForIds,
} from "./subagent-inject-pi";
import {
	assistantMessage,
	createTestDb,
	textOf,
	userMessage,
} from "./test-utils.test";

const PROJECT = "git:test";
const SES = "ses-inject";

const baseOptions = { enabled: true, projectPath: PROJECT };

let db = createTestDb();

function resetDb() {
	closeQuietly(db);
	db = createTestDb();
}

function seedMemory(content: string, overrides: Record<string, unknown> = {}) {
	return insertMemory(db, {
		projectPath: PROJECT,
		category: "PROJECT_RULES",
		content,
		sourceSessionId: "ses-seed",
		...(overrides as { expiresAt?: number | null }),
	});
}

async function run(
	messages: Parameters<typeof runSubagentInjectForPi>[0]["messages"],
	entryIds: (string | undefined)[],
) {
	return runSubagentInjectForPi({
		sessionId: SES,
		db,
		messages,
		entryIds,
		options: baseOptions,
		now: 1_700_000_000_000,
	});
}

afterEach(() => {
	resetDb();
});

describe("parseMarkerInner (strict token validation)", () => {
	it("accepts plain, #-prefixed, space/tab/comma-separated ids in order", () => {
		expect(parseMarkerInner("11")).toEqual([11]);
		expect(parseMarkerInner("#11")).toEqual([11]);
		expect(parseMarkerInner(" 11, 55 ,44\t#66 ")).toEqual([11, 55, 44, 66]);
	});

	it("rejects zero, negatives, decimals, exponents, unsafe integers, leading zeros", () => {
		expect(parseMarkerInner("0")).toBeNull();
		expect(parseMarkerInner("#0")).toBeNull();
		expect(parseMarkerInner("-1")).toBeNull();
		expect(parseMarkerInner("1.5")).toBeNull();
		expect(parseMarkerInner("1e3")).toBeNull();
		expect(parseMarkerInner("007")).toBeNull();
		expect(parseMarkerInner("9007199254740993")).toBeNull();
	});

	it("rejects glued tokens, comma runs, trailing commas, empty and full-width punctuation", () => {
		expect(parseMarkerInner("11#55")).toBeNull();
		expect(parseMarkerInner("11,,,55")).toBeNull();
		expect(parseMarkerInner("11,")).toBeNull();
		expect(parseMarkerInner(",11")).toBeNull();
		expect(parseMarkerInner("")).toBeNull();
		expect(parseMarkerInner("11，55")).toBeNull();
	});

	it("rejects newlines/CR inside the marker (single-line contract)", () => {
		expect(parseMarkerInner("11\n55")).toBeNull();
		expect(parseMarkerInner("11\r55")).toBeNull();
	});
});

describe("scanTextPartForIds (region exclusion + coarse locator)", () => {
	it("ignores markers in fenced code, inline code, and blockquotes", () => {
		const fenced = "task\n```\n⟦mc-mem: 11⟧\n```\ndo work";
		expect(scanTextPartForIds(fenced).ids).toEqual([]);
		expect(scanTextPartForIds("show `⟦mc-mem: 11⟧` literally").ids).toEqual([]);
		expect(scanTextPartForIds("> quote ⟦mc-mem: 11⟧\nnormal text").ids).toEqual(
			[],
		);
	});

	it("collects multiple markers in appearance order and dedupes", () => {
		const scanned = scanTextPartForIds(
			"⟦mc-mem: 11, 55⟧ then ⟦mc-mem: 55⟧ and ⟦mc-mem:#44⟧",
		);
		expect(scanned.ids).toEqual([11, 55, 44]);
	});

	it("flags malformed markers without partially parsing them", () => {
		const scanned = scanTextPartForIds("use ⟦mc-mem: 11#55⟧ please");
		expect(scanned.ids).toEqual([]);
		expect(scanned.sawMalformedMarker).toBe(true);
	});

	it("never matches across a line boundary and stays bounded on adversarial input", () => {
		expect(scanTextPartForIds("⟦mc-mem: 11,\n55⟧").ids).toEqual([]);
		const adversarial = `prefix ⟦mc-mem: ${"1".repeat(5000)}x⟧ suffix`;
		const start = performance.now();
		const scanned = scanTextPartForIds(adversarial);
		expect(performance.now() - start).toBeLessThan(200);
		expect(scanned.ids).toEqual([]);
	});
});

describe("runSubagentInjectForPi — fresh injection (§8.1/§8.2)", () => {
	it("injects full content of own active/permanent memories named by the marker", async () => {
		const m1 = seedMemory("use bun for builds");
		const m2 = seedMemory("never edit live config", { expiresAt: null });
		const messages = [
			userMessage(`please apply ⟦mc-mem: ${m1.id}, ${m2.id}⟧ now`, 1),
		];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text).toContain("<ctx-subagent-inject>");
		expect(text).toContain(
			`- [ID ${m1.id}] [PROJECT_RULES] use bun for builds`,
		);
		expect(text).toContain(
			`- [ID ${m2.id}] [PROJECT_RULES] never edit live config`,
		);
		expect(text).toContain("Task-requested memory snapshot");
		expect(text).toContain(String(m1.id));
		const decisions = getSubagentInjectDecisions(db, SES);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.decision).toBe("inject");
	});

	it("restores request order even though SQL IN does not guarantee it", async () => {
		const m1 = seedMemory("content-one");
		const m2 = seedMemory("content-two");
		const m3 = seedMemory("content-three");
		const messages = [userMessage(`⟦mc-mem: ${m3.id}, ${m1.id}, ${m2.id}⟧`, 1)];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text.indexOf("content-three")).toBeLessThan(
			text.indexOf("content-one"),
		);
		expect(text.indexOf("content-one")).toBeLessThan(
			text.indexOf("content-two"),
		);
	});

	it("reports archived/expired/missing IDs as unavailable without leaking content", async () => {
		const archived = seedMemory("secret-archived-body");
		updateMemoryStatus(db, archived.id, "archived");
		const expired = seedMemory("secret-expired-body", {
			// Relative to the frozen `now` the test runner passes.
			expiresAt: 1_700_000_000_000 - 60_000,
		});
		const foreign = insertMemory(db, {
			projectPath: "git:foreign",
			category: "PROJECT_RULES",
			content: "secret-foreign-body",
			sourceSessionId: "ses-seed",
		});
		const messages = [
			userMessage(
				`⟦mc-mem: ${archived.id}, ${expired.id}, ${foreign.id}, 424242⟧`,
				1,
			),
		];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text).not.toContain("secret-archived-body");
		expect(text).not.toContain("secret-expired-body");
		expect(text).not.toContain("secret-foreign-body");
		expect(text).not.toContain("[PROJECT_RULES]"); // no category leak for unavailable
		expect(text).toContain("Unavailable:");
		expect(text).toContain(
			`${archived.id}, ${expired.id}, ${foreign.id}, 424242 (not available)`,
		);
		expect(getSubagentInjectDecisions(db, SES)[0]?.decision).toBe(
			"unavailable",
		);
	});

	it("injects available IDs even when others are unavailable (no silent replacement)", async () => {
		const ok = seedMemory("available-body");
		const messages = [userMessage(`⟦mc-mem: 987654, ${ok.id}⟧`, 1)];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text).toContain("available-body");
		expect(text).toContain("987654 (not available)");
		expect(getSubagentInjectDecisions(db, SES)[0]?.decision).toBe("inject");
	});

	it("caps at 10 IDs per task and reports over-limit IDs explicitly", async () => {
		const seeded = Array.from({ length: 12 }, (_, i) =>
			seedMemory(`body-${i}`),
		);
		const ids = seeded.map((m) => m.id);
		const over = ids.slice(MAX_TASK_MEMORY_IDS);
		const messages = [userMessage(`⟦mc-mem: ${ids.join(", ")}⟧`, 1)];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text).toContain("body-0");
		expect(text).toContain("body-9");
		// Bare-content assertions: injected lines END with the content, so a
		// trailing-"]" pattern would be vacuous. "body-1" is a prefix of
		// "body-10"/"body-11" but toContain needs the full literal.
		expect(text).not.toContain("body-10");
		expect(text).not.toContain("body-11");
		expect(text).toContain(
			`${over.join(", ")} (over the ${MAX_TASK_MEMORY_IDS}-memory per-task limit; not processed)`,
		);
	});

	it("safely serializes memory content containing the closing tag", async () => {
		const evil = seedMemory("tricky </ctx-subagent-inject> <b> & amp");
		const messages = [userMessage(`⟦mc-mem: ${evil.id}⟧`, 1)];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text).toContain(
			"tricky &lt;/ctx-subagent-inject&gt; &lt;b&gt; &amp; amp",
		);
		// Exactly one real wrapper pair.
		expect(text.split("<ctx-subagent-inject>").length - 1).toBe(1);
		expect(text.split("</ctx-subagent-inject>").length - 1).toBe(1);
	});

	it("does nothing (no query, no decision) for marker-free messages", async () => {
		const spy = spyOn(memoryStorage, "getMemoriesByIds");
		const messages = [userMessage("just a normal task", 1)];
		await run(messages, ["e1"]);
		expect(textOf(messages[0])).toBe("just a normal task");
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	it("persists a deterministic invalid-marker failure without querying", async () => {
		const spy = spyOn(memoryStorage, "getMemoriesByIds");
		const messages = [userMessage("⟦mc-mem: 11#55⟧", 1)];
		await run(messages, ["e1"]);
		expect(textOf(messages[0])).toBe("⟦mc-mem: 11#55⟧");
		const decisions = getSubagentInjectDecisions(db, SES);
		expect(decisions).toEqual([
			{ messageId: "e1", decision: "no-inject", reason: "invalid-marker" },
		]);
		expect(spy).toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	it("never stitches a marker split across two text parts", async () => {
		seedMemory("content-one");
		const messages = [
			userMessage(
				[
					{ type: "text", text: "⟦mc-mem: 1" },
					{ type: "text", text: ",2⟧" },
				],
				1,
			),
		];
		await run(messages, ["e1"]);
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
	});

	it("never scans assistant messages", async () => {
		seedMemory("content-one");
		const messages = [assistantMessage("⟦mc-mem: 1⟧", 1)];
		await run(messages, ["e1"]);
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
	});
});

describe("runSubagentInjectForPi — idempotency, replay, lifecycle (§8.3)", () => {
	it("appends the payload exactly once across repeated passes on the same array", async () => {
		const m = seedMemory("stable-body");
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(messages, ["e1"]);
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text.split("<ctx-subagent-inject>").length - 1).toBe(1);
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);
	});

	it("replays A's snapshot after a marker-less task B (reconstructed wire, stateless runner)", async () => {
		const m = seedMemory("replay-body");
		const first = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(first, ["eA"]);
		expect(textOf(first[0])).toContain("replay-body");

		// Rebuild the wire from the original JSONL (task A text WITHOUT the
		// payload) plus a new marker-less task B; a fresh runner instance must
		// restore A's snapshot from persistence alone.
		const rebuilt = [
			userMessage(`⟦mc-mem: ${m.id}⟧`, 1),
			assistantMessage("answer", 2),
			userMessage("unrelated follow-up", 3),
		];
		await run(rebuilt, ["eA", "eB", "eC"]);
		expect(textOf(rebuilt[0])).toContain("replay-body");
		expect(textOf(rebuilt[2])).toBe("unrelated follow-up");
	});

	it("freezes the snapshot: archiving the memory later does not retract the old task", async () => {
		const m = seedMemory("frozen-body");
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(messages, ["e1"]);
		updateMemoryStatus(db, m.id, "archived");
		const pass2 = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(pass2, ["e1"]);
		expect(textOf(pass2[0])).toContain("frozen-body");
	});

	it("does not make fresh decisions for non-tail messages (no prefix rewrite)", async () => {
		const m = seedMemory("tail-body");
		const messages = [
			userMessage(`⟦mc-mem: ${m.id}⟧`, 1),
			assistantMessage("reply", 2),
		];
		await run(messages, ["e1", "e2"]);
		expect(textOf(messages[0])).not.toContain("tail-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
	});

	it("skips messages whose entry id cannot be resolved (never guesses position)", async () => {
		const m = seedMemory("unresolved-body");
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(messages, [undefined]);
		expect(textOf(messages[0])).not.toContain("unresolved-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
	});

	it("treats a DB failure as transient: persists nothing and retries cleanly", async () => {
		const m = seedMemory("retry-body");
		const spy = spyOn(memoryStorage, "getMemoriesByIds").mockImplementation(
			() => {
				throw new Error("db busy");
			},
		);
		const failing = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(failing, ["e1"]);
		spy.mockRestore();
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
		expect(textOf(failing[0])).not.toContain("retry-body");

		const retried = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(retried, ["e1"]);
		expect(textOf(retried[0])).toContain("retry-body");
	});

	it("capacity baseline counts images, thinking, and tool calls on the wire", async () => {
		const m = seedMemory("media-body");
		// Text alone is tiny; the base64 image dominates the wire. A guard that
		// only counted text would allow the payload — it must refuse. Use
		// deterministic high-entropy base64 (runs of one char tokenize too
		// efficiently and would defeat a real tokenizer).
		let state = 12345;
		const rand = () => {
			state = (state * 1103515245 + 12345) % 2147483648;
			return state / 2147483648;
		};
		const B64 =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const bigImage = Array.from(
			{ length: 20000 },
			() => B64[Math.floor(rand() * 64)],
		).join("");
		const messages = [
			userMessage(
				[
					{ type: "text", text: `⟦mc-mem: ${m.id}⟧` },
					{ type: "image", data: bigImage, mimeType: "image/png" },
				],
				1,
			),
		];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages,
			entryIds: ["e1"],
			options: baseOptions,
			capacity: { contextLimit: 5000 },
			now: 1_700_000_000_000,
		});
		expect(textOf(messages[0])).not.toContain("media-body");
		expect(getSubagentInjectDecisions(db, SES)).toEqual([
			{ messageId: "e1", decision: "no-inject", reason: "capacity-exceeded" },
		]);

		// Same wire, generous window: the payload fits and injects.
		resetDb();
		const m2 = seedMemory("media-body");
		const messages2 = [
			userMessage(
				[
					{ type: "text", text: `⟦mc-mem: ${m2.id}⟧` },
					{ type: "image", data: bigImage, mimeType: "image/png" },
				],
				1,
			),
		];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages: messages2,
			entryIds: ["e1"],
			options: baseOptions,
			capacity: { contextLimit: 50000 },
			now: 1_700_000_000_000,
		});
		expect(textOf(messages2[0])).toContain("media-body");
	});

	it("refuses oversized payloads explicitly (capacity-exceeded) instead of truncating", async () => {
		const m = seedMemory("capacity-body");
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages,
			entryIds: ["e1"],
			options: baseOptions,
			// The baseline is the outgoing wire, not a pre-transform reading —
			// a tiny window trips regardless of usage stats.
			capacity: { contextLimit: 10 },
			now: 1_700_000_000_000,
		});
		expect(textOf(messages[0])).not.toContain("capacity-body");
		expect(getSubagentInjectDecisions(db, SES)).toEqual([
			{ messageId: "e1", decision: "no-inject", reason: "capacity-exceeded" },
		]);
	});
});

describe("decision persistence — CAS / first-writer-wins (§8.3/§8.4)", () => {
	it("keeps the first committed decision for a message id", () => {
		const first = appendSubagentInjectDecision(db, SES, {
			messageId: "e1",
			decision: "inject",
			text: "payload-A",
			ids: [1],
			readAt: 100,
		});
		expect(first.ok).toBe(true);
		const second = appendSubagentInjectDecision(db, SES, {
			messageId: "e1",
			decision: "inject",
			text: "payload-B",
			ids: [2],
			readAt: 200,
		});
		expect(second.ok).toBe(true);
		expect(second.kind).toBe("already-present");
		if (second.ok) expect(second.decision).toMatchObject({ text: "payload-A" });
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);
	});

	it("replays the committed winner payload under contention, byte-identically", async () => {
		const m = seedMemory("winner-body");
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(messages, ["e1"]);
		const committed = getSubagentInjectDecisions(db, SES)[0];
		const pass2 = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(pass2, ["e1"]);
		expect(textOf(pass2[0])).toContain(
			(committed as { text: string }).text.trim(),
		);
	});
});

describe("append guard regression (§5.4)", () => {
	it("still injects when the task text discusses <ctx-subagent-inject> literally", async () => {
		const m = seedMemory("guard-body");
		const messages = [
			userMessage(
				`please document the <ctx-subagent-inject> block format. ⟦mc-mem: ${m.id}⟧`,
				1,
			),
		];
		await run(messages, ["e1"]);
		const text = textOf(messages[0]);
		expect(text).toContain("guard-body");
		// Exactly one real wrapper pair: the literal mention plus our block.
		expect(text.split("<ctx-subagent-inject>").length - 1).toBe(2);
		expect(getSubagentInjectDecisions(db, SES)[0]?.decision).toBe("inject");
	});

	it("a blocked append is not silent: no decision persisted, next pass retries", async () => {
		const m = seedMemory("blocked-body");
		// Craft the exact payload the runner will build (frozen `now`), plant it
		// in the task text, and add the marker. The exact-payload guard blocks
		// the append; the failure must leave NO persisted decision.
		const planted = buildInjectPayload({
			ids: [m.id],
			injected: [{ id: m.id, memory: m }],
			unavailableIds: [],
			overLimitIds: [],
			readAt: 1_700_000_000_000,
		});
		const messages = [
			userMessage(`earlier draft:\n${planted}\napply ⟦mc-mem: ${m.id}⟧`, 1),
		];
		await run(messages, ["e1"]);
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);

		// Next pass (fresh readAt → fresh payload bytes) injects and persists.
		const pass2 = [
			userMessage(`earlier draft:\n${planted}\napply ⟦mc-mem: ${m.id}⟧`, 1),
		];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages: pass2,
			entryIds: ["e1"],
			options: baseOptions,
			now: 1_700_000_000_500,
		});
		const text = textOf(pass2[0]);
		expect(text).toContain("blocked-body");
		expect(getSubagentInjectDecisions(db, SES)[0]?.decision).toBe("inject");
	});
});

describe("review regression — generated blocks, disable semantics, contention (§5.1/§5.3/§5.4)", () => {
	it("ignores a marker quoted inside an auto-search hint or instruction block", async () => {
		seedMemory("quoted-body");
		const withHint =
			"task\n\n<ctx-search-hint>\nYour memory may contain: ⟦mc-mem: 1⟧\n</ctx-search-hint>";
		const messages = [userMessage(withHint, 1)];
		await run(messages, ["e1"]);
		expect(textOf(messages[0])).not.toContain("quoted-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);

		const withInstruction =
			'task\n\n<instruction name="deferred_notes">see ⟦mc-mem: 1⟧</instruction>';
		const messages2 = [userMessage(withInstruction, 1)];
		await run(messages2, ["e2"]);
		expect(textOf(messages2[0])).not.toContain("quoted-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
	});

	it("honors a marker inside a user-authored instruction block", async () => {
		const m = seedMemory("user-authored-body");
		const withInstruction = `task\n\n<instruction name="custom_check">verify ⟦mc-mem: ${m.id}⟧</instruction>`;
		const messages = [userMessage(withInstruction, 1)];
		await run(messages, ["e1"]);
		expect(textOf(messages[0])).toContain("user-authored-body");
		expect(getSubagentInjectDecisions(db, SES)[0]?.decision).toBe("inject");
	});

	it("disabling stops NEW decisions but still replays persisted snapshots", async () => {
		const m = seedMemory("replay-when-disabled-body");
		const first = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(first, ["e1"]);
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);

		const disabled = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages: disabled,
			entryIds: ["e1"],
			options: { enabled: false, projectPath: PROJECT },
		});
		expect(textOf(disabled[0])).toContain("replay-when-disabled-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);

		// A NEW marker-bearing task while disabled: no decision, no injection.
		const fresh = [userMessage(`⟦mc-mem: ${m.id}⟧`, 2)];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages: fresh,
			entryIds: ["e2"],
			options: { enabled: false, projectPath: PROJECT },
		});
		expect(textOf(fresh[0])).not.toContain("replay-when-disabled-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);
	});

	it("an existing no-inject decision replays nothing to the wire", async () => {
		const m = seedMemory("contended-body");
		// A no-inject decision already persisted for e1: the fresh-decision
		// step early-returns and replay adds no bytes.
		appendSubagentInjectDecision(db, SES, {
			messageId: "e1",
			decision: "no-inject",
			reason: "capacity-exceeded",
		});
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(messages, ["e1"]);
		expect(textOf(messages[0])).not.toContain("contended-body");
		expect(textOf(messages[0])).not.toContain("<ctx-subagent-inject>");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);
	});

	it("strips the local snapshot when a concurrent no-inject decision wins CAS", async () => {
		const m = seedMemory("contended-body");
		const spy = spyOn(
			storagePersisted,
			"appendSubagentInjectDecision",
		).mockReturnValue({
			ok: true,
			kind: "already-present",
			decision: {
				messageId: "e1",
				decision: "no-inject",
				reason: "capacity-exceeded",
			},
		});
		// Hide the winner from the initial read so the runner builds and
		// appends a local snapshot first, then must realign to the CAS winner.
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages,
			entryIds: ["e1"],
			options: baseOptions,
			now: 1_700_000_000_000,
			decisions: [],
		});
		spy.mockRestore();
		expect(textOf(messages[0])).not.toContain("contended-body");
		expect(textOf(messages[0])).not.toContain("<ctx-subagent-inject>");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);
	});

	it("persistence failure rolls the wire back and retries cleanly next pass", async () => {
		const m = seedMemory("rollback-body");
		const spy = spyOn(
			storagePersisted,
			"appendSubagentInjectDecision",
		).mockImplementation(() => {
			throw new Error("db busy");
		});
		const failing = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(failing, ["e1"]);
		spy.mockRestore();
		expect(textOf(failing[0])).not.toContain("rollback-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(0);

		const retried = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await run(retried, ["e1"]);
		expect(textOf(retried[0])).toContain("rollback-body");
		expect(getSubagentInjectDecisions(db, SES)).toHaveLength(1);
	});
});

describe("message-shape coexistence (§8.4)", () => {
	it("appends to string content directly", async () => {
		const m = seedMemory("string-body");
		const messages = [userMessage(`task ⟦mc-mem: ${m.id}⟧`, 1)];
		await run(messages, ["e1"]);
		const content = (messages[0] as { content: unknown }).content;
		expect(typeof content).toBe("string");
		expect(content as string).toContain("string-body");
	});

	it("appends to the LAST text part, preserving image parts", async () => {
		const m = seedMemory("multipart-body");
		const messages = [
			userMessage(
				[
					{ type: "text", text: "task context" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: `apply ⟦mc-mem: ${m.id}⟧ tail` },
				],
				1,
			),
		];
		await run(messages, ["e1"]);
		const content = (
			messages[0] as { content: Array<{ type: string; text?: string }> }
		).content;
		expect(content[1]?.type).toBe("image");
		expect(content[2]?.text).toContain("multipart-body");
		expect(content[2]?.text ?? "").toContain("⟧ tail");
	});

	it("pushes a new trailing text part for image-only messages", async () => {
		const messages = [
			userMessage([{ type: "image", data: "AAAA", mimeType: "image/png" }], 1),
		];
		// Image-only messages carry no scannable text, so the marker cannot
		// live inside them; verify the append primitive itself instead.
		appendPayloadToMessage(
			messages[0] as Parameters<typeof appendPayloadToMessage>[0],
			"\n\n<ctx-subagent-inject>\nx\n</ctx-subagent-inject>",
		);
		const content = (
			messages[0] as { content: Array<{ type: string; text?: string }> }
		).content;
		expect(content[0]?.type).toBe("image");
		expect(content[1]?.type).toBe("text");
	});

	it("appendPayloadToMessage is idempotent against an existing inject block", () => {
		const message = userMessage("task", 1) as Parameters<
			typeof appendPayloadToMessage
		>[0];
		const payload = "\n\n<ctx-subagent-inject>\nx\n</ctx-subagent-inject>";
		expect(appendPayloadToMessage(message, payload)).toBe(true);
		expect(appendPayloadToMessage(message, payload)).toBe(false);
		expect(textOf(message as unknown as Parameters<typeof textOf>[0])).toBe(
			`task${payload}`,
		);
	});

	it("no-ops entirely when disabled", async () => {
		const m = seedMemory("disabled-body");
		const messages = [userMessage(`⟦mc-mem: ${m.id}⟧`, 1)];
		await runSubagentInjectForPi({
			sessionId: SES,
			db,
			messages,
			entryIds: ["e1"],
			options: { enabled: false, projectPath: PROJECT },
		});
		expect(textOf(messages[0])).toBe(`⟦mc-mem: ${m.id}⟧`);
	});
});
