import { expect, it, spyOn } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	clearPiUpperReclaimSession,
	piFitOverflowPossible,
	piUpperReclaimCursor,
	recordPiUpperEstimateReclaim,
	shouldReclaimPiUpperEstimate,
} from "./pi-fit-reclaim";
import * as lkg from "./pi-lkg";
import * as fit from "./pi-raw-fallback";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

it("upper-estimate reclaim is durable and rearms only for new content, model or overflow", () => {
	const db = createTestDb();
	const sessionId = "fit-reclaim-cursor";
	const cursor = (count = 1, modelKey = "mock/mock") =>
		piUpperReclaimCursor({
			sessionId,
			modelKey,
			messageCount: count,
			input: [userMessage("unchanged", 1)],
		});
	try {
		const first = cursor();
		if (!first) throw new Error("fixture cursor missing");
		expect(shouldReclaimPiUpperEstimate(db, first)).toBe(true);
		recordPiUpperEstimateReclaim(db, first);
		expect(shouldReclaimPiUpperEstimate(db, cursor())).toBe(false);
		clearPiUpperReclaimSession(sessionId);
		expect(shouldReclaimPiUpperEstimate(db, cursor())).toBe(false);
		expect(shouldReclaimPiUpperEstimate(db, cursor(2))).toBe(true);
		expect(shouldReclaimPiUpperEstimate(db, cursor(1, "mock/other"))).toBe(
			true,
		);
		recordOverflowDetected(db, sessionId, undefined, "mock/mock");
		expect(shouldReclaimPiUpperEstimate(db, cursor())).toBe(true);
	} finally {
		clearPiUpperReclaimSession(sessionId);
		db.close();
	}
});

it("three unchanged metadata over-count passes force at most one rebuild and keep served bytes", async () => {
	const db = createTestDb();
	const sessionId = "fit-reclaim-once";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	const lines: string[] = [];
	const log = spyOn(logger, "sessionLog").mockImplementation(
		(_id, ...parts) => {
			lines.push(parts.join(" "));
		},
	);
	const source = [
		{
			role: "custom",
			customType: "notice",
			timestamp: 1,
			content: [
				{ type: "text", text: "small visible notice" },
				{ type: "extension-metadata", details: "x".repeat(1000000) },
			],
		},
		userMessage("continue", 2),
	];
	const install = () => {
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: {
				injectionBudgetTokens: 10000,
				injectDocs: false,
				memoryEnabled: false,
			},
		});
		return fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
	};
	let handler = install();
	const pass = async () => {
		const input = structuredClone(source);
		const base = fakeContext(
			sessionId,
			process.cwd(),
			["notice", "user"],
			input as never[],
		);
		const result = await handler({ messages: input as never[] }, {
			...base,
			hasUI: false,
			getSystemPrompt: () => "You are helpful.",
			model: { provider: "mock", id: "mock", contextWindow: 50000 },
			getContextUsage: () => ({
				tokens: 0,
				percent: 0,
				contextWindow: 50000,
			}),
		} as never);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastInputTokens: 0,
			lastContextPercentage: 0,
		});
		return JSON.stringify(result.messages);
	};
	try {
		const first = await pass();
		expect(await pass()).toBe(first);
		expect(await pass()).toBe(first);
		expect(
			lines.filter((line) =>
				line.includes("upper-estimate-pressure; attempting emergency reclaim"),
			),
		).toHaveLength(1);
		clearContextHandlerSession(sessionId);
		handler = install();
		expect(await pass()).toBe(first);
		expect(
			lines.filter((line) =>
				line.includes("upper-estimate-pressure; attempting emergency reclaim"),
			),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("ordinary native defer does not clone the full input or enter the final fit block", async () => {
	const db = createTestDb();
	const sessionId = "fit-defer-hot-path";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: {
			injectionBudgetTokens: 10000,
			injectDocs: false,
			memoryEnabled: false,
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	const source = Array.from({ length: 100 }, (_, index) =>
		userMessage(`small ${index}`, index),
	);
	const prepare = () => {
		const input = structuredClone(source);
		return {
			event: { messages: input as never[] },
			ctx: {
				...fakeContext(
					sessionId,
					process.cwd(),
					source.map((_, i) => `entry-${i}`),
					input,
				),
				model: {
					provider: "anthropic",
					id: "claude-fable-5-1",
					contextWindow: 272000,
				},
				getSystemPrompt: () => "You are helpful.",
				getContextUsage: () => ({
					tokens: 1000,
					percent: 0.4,
					contextWindow: 272000,
				}),
			},
		};
	};
	try {
		const warm = prepare();
		await handler(warm.event, warm.ctx as never);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastInputTokens: 1000,
			lastContextPercentage: 0.4,
		});
		const { event, ctx } = prepare();
		let fullClones = 0;
		const originalClone = globalThis.structuredClone;
		const clones = spyOn(globalThis, "structuredClone").mockImplementation(((
			value: unknown,
			options?: StructuredSerializeOptions,
		) => {
			if (Array.isArray(value) && value.length >= source.length) fullClones++;
			return originalClone(value, options);
		}) as typeof structuredClone);
		const estimate = spyOn(fit, "estimatePiOutgoingInputTokens");
		const restore = spyOn(lkg, "restorePiLkgInputForFit");
		try {
			await handler(event, ctx as never);
			expect(fullClones).toBe(0);
			expect(estimate).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
		} finally {
			restore.mockRestore();
			estimate.mockRestore();
			clones.mockRestore();
		}
		expect(
			piFitOverflowPossible({
				hasUI: false,
				inputTokens: 1000,
				recoveryArmed: false,
				forceMaterialization: false,
				imported: false,
				coldInjection: false,
				cacheBusting: false,
				sessionId,
			}),
		).toBe(false);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("a locally refused native request remains fit-checked on an unmeasured retry", async () => {
	const db = createTestDb();
	const sessionId = "fit-refusal-retry";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		injection: {
			injectionBudgetTokens: 10000,
			injectDocs: false,
			memoryEnabled: false,
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const input = [
				userMessage("word ".repeat(100000), 1),
				userMessage(`attempt ${attempt}`, 2),
			];
			await expect(
				handler({ messages: input as never[] }, {
					...fakeContext(sessionId, process.cwd(), ["large", "latest"], input),
					getSystemPrompt: () => "You are helpful.",
					model: { provider: "mock", id: "mock", contextWindow: 50000 },
				} as never),
			).rejects.toThrow("this turn was not sent");
		}
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("provider overflow clears upper-only suppression across a process restart", () => {
	const db = createTestDb();
	const sessionId = "fit-provider-error-restart";
	const make = () =>
		piUpperReclaimCursor({
			sessionId,
			modelKey: "mock/mock",
			messageCount: 1,
			input: [userMessage("same content", 1)],
		});
	try {
		const cursor = make();
		if (!cursor) throw new Error("fixture cursor missing");
		recordPiUpperEstimateReclaim(db, cursor);
		expect(
			handlePiProviderFailure({
				db,
				sessionId,
				message: {
					role: "assistant",
					provider: "mock",
					model: "mock",
					errorMessage: "Your input exceeds the context window of this model.",
				},
			}).kind,
		).toBe("overflow");
		clearPiUpperReclaimSession(sessionId);
		resetEmergencyRecoveryRegistryForTest();
		expect(shouldReclaimPiUpperEstimate(db, make())).toBe(true);
	} finally {
		clearPiUpperReclaimSession(sessionId);
		db.close();
	}
});

it("lazy fit input requires every unchanged canonical entry and rejects extension-only frames", () => {
	const db = createTestDb();
	const sessionId = "fit-canonical-restore";
	const source = [
		userMessage("original first", 1),
		userMessage("original second", 2),
	];
	const entries = source.map((message, index) => ({
		type: "message",
		id: `m${index}`,
		message,
	}));
	const coordinator = lkg.createPiLkgCoordinator(db);
	const begin = (messages: unknown[], ids: (string | undefined)[]) =>
		coordinator.beginPass({
			sessionId,
			messages,
			entryIds: ids,
			modelKey: "mock/mock",
			providerKey: "mock",
			apiKey: "anthropic-messages",
		});
	try {
		const snapshot = begin(source, ["m0", "m1"]);
		const restored = lkg.restorePiLkgInputForFit(snapshot, entries);
		expect(restored).toEqual(source);
		expect(restored?.[0]).not.toBe(source[0]);
		expect(
			lkg.restorePiLkgInputForFit(snapshot, [...entries, entries[0]]),
		).toBeUndefined();
		const extended = begin(
			[...source, userMessage("extension frame", 3)],
			["m0", "m1", undefined],
		);
		expect(lkg.restorePiLkgInputForFit(extended, entries)).toBeUndefined();
		let getterReads = 0;
		const accessor = {
			...source[0],
			get content() {
				getterReads++;
				return [];
			},
		};
		expect(
			lkg.restorePiLkgInputForFit(snapshot, [
				{ ...entries[0], message: accessor },
				entries[1],
			]),
		).toBeUndefined();
		expect(getterReads).toBe(0);
		source[0].content = [{ type: "text", text: "edited after snapshot" }];
		expect(lkg.restorePiLkgInputForFit(snapshot, entries)).toBeUndefined();
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
