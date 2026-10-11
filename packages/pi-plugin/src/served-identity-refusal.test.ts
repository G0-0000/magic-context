import { expect, spyOn, test } from "bun:test";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { PiStorageBusyError } from "./pi-raw-fallback";
import { readPiCommittedServedNumbers } from "./pi-served-identities";
import * as ledger from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("identity mirror failure refuses without discarding the committed LKG pair", async () => {
	const db = createTestDb();
	const sessionId = "served-identity-persistence-refusal";
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => [
			{
				name: "ctx_reduce",
				description: "reduce context",
				parameters: { type: "object" },
			},
		],
		getActiveTools: () => ["ctx_reduce"],
	});
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as (
		event: { messages: ReturnType<typeof userMessage>[] },
		ctx: ReturnType<typeof fakeContext>,
	) => Promise<{ messages: unknown[] }>;
	const context = (raw: ReturnType<typeof userMessage>[]) =>
		Object.assign(
			fakeContext(
				sessionId,
				process.cwd(),
				raw.map((_, index) => `u${index}`),
				raw,
			),
			{
				getSystemPrompt: () => "You are a coding assistant.",
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4-20250514",
					api: "anthropic-messages",
					contextWindow: 100000,
					maxTokens: 8192,
				},
			},
		);
	let capture: ReturnType<typeof spyOn> | undefined;
	try {
		const first = [userMessage("already served", 1)];
		await handler({ messages: structuredClone(first) }, context(first));
		await Bun.sleep(50);
		expect(getSlot(sessionId)).toBeDefined();
		const record = ledger.capturePiServedArray;
		let calls = 0;
		capture = spyOn(ledger, "capturePiServedArray").mockImplementation(
			(...args) => {
				if (++calls === 1)
					throw new ledger.PiServedIdentityError(
						new Error("identity disk unavailable"),
					);
				return record(...args);
			},
		);
		const raw = [...first, userMessage("never served", 2)];
		await expect(
			handler({ messages: structuredClone(raw) }, context(raw)),
		).rejects.toBeInstanceOf(PiStorageBusyError);
		expect(capture).toHaveBeenCalledTimes(1);
		await Bun.sleep(50);
		// The compatibility mirror failed after the authoritative SQLite pair committed.
		// Refusing dispatch must not discard that request while retaining its identities.
		expect(getSlot(sessionId)?.jsonPrefix).toContain("never served");
		expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1, 2]);
		expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual([1]);
	} finally {
		capture?.mockRestore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});
