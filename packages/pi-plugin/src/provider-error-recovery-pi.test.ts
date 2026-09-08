import { afterEach, describe, expect, it } from "bun:test";
import {
	clearThinkingBindingRecoveryIf,
	getMergedReasoningStrippedIds,
	getOverflowState,
	getThinkingBindingRecoveryTarget,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { resolvePiUsableContextLimit } from "./pi-context-limit";
import {
	applyPiThinkingBindingRecovery,
	handlePiProviderFailure,
} from "./provider-error-recovery-pi";
import { createTestDb } from "./test-utils.test";

const databases: ReturnType<typeof createTestDb>[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) closeQuietly(db);
	resetEmergencyRecoveryRegistryForTest();
});

function db() {
	const value = createTestDb();
	databases.push(value);
	return value;
}

function fableMessages() {
	return [
		{ role: "user", content: "question", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "bound bytes", thinkingSignature: "sig" },
				{ type: "text", text: "answer" },
			],
			provider: "anthropic",
			model: "claude-fable-5-1",
			timestamp: 2,
		},
		{ role: "user", content: "retry", timestamp: 3 },
	];
}

describe("Pi provider failure recovery", () => {
	it("arms message_end binding recovery and re-serves stripped bytes after restart", () => {
		const database = db();
		const sessionId = "pi-fable-binding-recovery";
		const diagnostics: string[] = [];
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5-1",
				errorMessage:
					"400 invalid_request_error: thinking block is bound to a different conversation",
			},
			report: (message) => diagnostics.push(message),
		});
		expect(event).toEqual({ kind: "thinking_binding", armed: true });
		expect(getThinkingBindingRecoveryTarget(database, sessionId)).toBe(
			"newest_reasoning_bearing_assistant",
		);

		const first = fableMessages();
		const applied = applyPiThinkingBindingRecovery({
			db: database,
			sessionId,
			messages: first,
			entryIds: ["entry-u1", "entry-a1", "entry-u2"],
			provider: "anthropic",
			model: "claude-fable-5-1",
			report: (message) => diagnostics.push(message),
		});
		expect(applied).toEqual({
			flagTarget: "newest_reasoning_bearing_assistant",
			entryId: "entry-a1",
		});
		expect(JSON.stringify(first)).not.toContain("bound bytes");
		expect(diagnostics).toEqual([
			"Fable thinking-binding recovery armed from message_end target=newest_reasoning_bearing_assistant",
			"Fable thinking-binding recovery consumed on context pass target=newest_reasoning_bearing_assistant entry=entry-a1",
		]);
		expect(diagnostics[0]).not.toBe(diagnostics[1]);
		expect(getMergedReasoningStrippedIds(database, sessionId)).toContain(
			"binding_mismatch:entry-a1",
		);
		if (!applied) throw new Error("binding recovery was not applied");
		expect(
			clearThinkingBindingRecoveryIf(database, sessionId, applied.flagTarget),
		).toBe(true);

		const restarted = fableMessages();
		expect(
			applyPiThinkingBindingRecovery({
				db: database,
				sessionId,
				messages: restarted,
				entryIds: ["entry-u1", "entry-a1", "entry-u2"],
				provider: "anthropic",
				model: "claude-fable-5-1",
			}),
		).toBeNull();
		expect(JSON.stringify(restarted)).toBe(JSON.stringify(first));
	});

	it("arms the same recovery from OMP's wrapped message_end error text", () => {
		const database = db();
		const sessionId = "omp-fable-binding-recovery";
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5-1",
				stopReason: "error",
				errorStatus: 400,
				errorMessage:
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking block is bound to a different conversation"}}\nraw-http-request=/tmp/http-400-requests/request.json',
			},
		});

		expect(event).toEqual({ kind: "thinking_binding", armed: true });
		expect(getThinkingBindingRecoveryTarget(database, sessionId)).toBe(
			"newest_reasoning_bearing_assistant",
		);
	});

	it("persists a provider overflow limit that the next Pi pass consumes", () => {
		const database = db();
		const sessionId = "pi-provider-overflow-limit";
		const event = handlePiProviderFailure({
			db: database,
			sessionId,
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude-fable-5-1",
				errorMessage:
					"prompt is too long: 70000 tokens > 64000 maximum context length",
			},
		});
		expect(event).toMatchObject({ kind: "overflow", reportedLimit: 64_000 });
		const overflow = getOverflowState(
			database,
			sessionId,
			"anthropic/claude-fable-5-1",
		);
		expect(overflow.detectedContextLimitModelKey).toBe(
			"anthropic/claude-fable-5-1",
		);
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 200_000,
				detectedContextLimit: overflow.detectedContextLimit,
			}),
		).toBe(64_000);
	});
});
