import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	clearCachedM0M1,
	getSourceContents,
	getTagsBySession,
	updateCavemanDepth,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

function digest(messages: unknown[]) {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

describe("Pi fold content replay", () => {
	it("does not discover a reminder strip on defer without a frozen decision", async () => {
		const db = createTestDb();
		const sessionId = "pi-reminder-no-ride";
		updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
			lastContextPercentage: 1,
			lastInputTokens: 100,
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const text =
			"<!-- +9h 30m -->\n<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>";
		const messages = [
			userMessage(text, 1),
			assistantMessage("ack", 2),
			userMessage("tail", 3),
		];
		try {
			const result = await handler(
				{ messages },
				fakeContext(
					sessionId,
					process.cwd(),
					["reminder", "ack", "tail"],
					structuredClone(messages) as never,
				),
			);
			expect(textOf(result.messages[0] as never)).toContain(text);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
	it("replays a partial reminder strip on the next defer with original source intact", async () => {
		const db = createTestDb();
		const sessionId = "pi-fold-reminder";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const original =
			"<system-reminder>\n[BACKGROUND BASH COMPLETED]\n- task bash-fixture (exit 0)\n</system-reminder>";
		const raw = [
			assistantMessage("prior turn", 1000),
			userMessage(original, 34201000),
			assistantMessage("acknowledged", 34202000),
			userMessage("first tail message", 34203000),
		];
		const ids = ["prior", "reminder", "ack", "tail"];
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				fakeContext(sessionId, process.cwd(), ids, messages as never),
			);
		};
		try {
			const fold = await pass();
			const reminder = fold.messages.find((m) =>
				textOf(m as never).includes("+9h 30m"),
			);
			expect(reminder).toBeDefined();
			expect(textOf(reminder as never)).toMatch(/^§\d+§ <!-- \+9h 30m -->$/);
			expect(textOf(reminder as never)).not.toContain("BACKGROUND BASH");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 100,
			});
			const next = await pass();
			expect(digest(next.messages)).toBe(digest(fold.messages));
			clearContextHandlerSession(sessionId);
			expect(digest((await pass()).messages)).toBe(digest(fold.messages));
			const tag = getTagsBySession(db, sessionId).find(
				(t) => t.messageId === "reminder:p0",
			);
			if (!tag) throw new Error("Missing reminder fixture tag");
			expect(
				getSourceContents(db, sessionId, [tag.tagNumber]).get(tag.tagNumber),
			).toContain(original);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("replays seam temporal removal after caveman with no next-pass late trim", async () => {
		const db = createTestDb();
		const sessionId = "pi-fold-temporal";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: { caveman: { enabled: true, minChars: 1 } },
			injection: { injectionBudgetTokens: 10000, temporalAwareness: true },
		});
		const handler = fake.handlers.get("context") as (
			e: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("old history", 1000),
			assistantMessage("previous end", 2000),
			userMessage(
				"Can you check this report: a retained user report",
				604802000,
			),
			assistantMessage("checking now", 604803000),
			userMessage("first tail message", 604804000),
		];
		const ids = ["old", "end", "seam", "ack", "tail"];
		const pass = async () => {
			const messages = structuredClone(raw);
			return handler(
				{ messages },
				fakeContext(sessionId, process.cwd(), ids, messages as never),
			);
		};
		try {
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old",
					endMessageId: "old",
					title: "old",
					content: "old history",
				},
			]);
			await pass();

			const seamTag = getTagsBySession(db, sessionId).find((t) =>
				t.messageId.startsWith("seam"),
			);
			if (!seamTag) throw new Error("Missing seam fixture tag");
			updateCavemanDepth(db, sessionId, seamTag.tagNumber, 1);
			appendCompartments(db, sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "end",
					endMessageId: "end",
					title: "fold",
					content: "previous end",
				},
			]);
			clearCachedM0M1(db, sessionId);
			const fold = await pass();
			expect(textOf(fold.messages[2] as never)).not.toContain("<!-- +");
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 1,
				lastInputTokens: 100,
			});
			const next = await pass();
			expect(digest(next.messages)).toBe(digest(fold.messages));
			clearContextHandlerSession(sessionId);
			expect(digest((await pass()).messages)).toBe(digest(fold.messages));
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
