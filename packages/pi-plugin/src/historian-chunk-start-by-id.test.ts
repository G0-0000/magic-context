import { expect, test } from "bun:test";
import {
	readSessionChunk,
	resolveHistorianChunkStart,
	withRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { convertEntriesToRawMessages } from "./read-session-pi";

/**
 * The next historian chunk continues after the last summarized message id,
 * resolved through the Pi branch walk — not at the stored `end_message + 1`.
 * The companion plugin test covers the same contract on OpenCode 1 (canonical
 * read) and OpenCode 2 (seq-based SQL read).
 */
function branchEntries(): unknown[] {
	return [
		{
			type: "message",
			id: "u1",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "First question with enough substance." },
				],
			},
		},
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "read",
						arguments: { path: "src/flow.ts" },
					},
				],
			},
		},
		{
			type: "message",
			id: "r1",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "flow contents" }],
			},
		},
		{
			type: "message",
			id: "u2",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "Second question with enough substance." },
				],
			},
		},
		{
			type: "message",
			id: "a2",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Second answer with enough substance." },
				],
			},
		},
	];
}

// The branch walk numbers u1=1, a1=2, u2=3 (carrying the folded r1 result),
// a2=4. The tool result itself takes no ordinal.
function branchMessages(): RawMessage[] {
	const messages = convertEntriesToRawMessages(branchEntries());
	expect(messages.map((message) => [message.id, message.ordinal])).toEqual([
		["u1", 1],
		["a1", 2],
		["u2", 3],
		["a2", 4],
	]);
	return messages;
}

function withBranchProvider<T>(sessionId: string, fn: () => T): T {
	const messages = branchMessages();
	return withRawMessageProvider(
		sessionId,
		{
			readMessages: () => messages,
			getMessageCount: () => messages.length,
		},
		fn,
	);
}

test("Pi: a stored end_message one short of its end id continues after the id", () => {
	const sessionId = "pi-chunk-start";
	const start = withBranchProvider(sessionId, () =>
		resolveHistorianChunkStart(sessionId, {
			endMessage: 2,
			endMessageId: "u2",
		}),
	);
	expect(start).toBe(4);
	const chunk = withBranchProvider(sessionId, () =>
		readSessionChunk(sessionId, 1_000_000, 4),
	);
	expect(chunk.startIndex).toBe(4);
	expect(chunk.startMessageId).toBe("a2");
	expect(chunk.endMessageId).toBe("a2");
});

test("Pi: a missing end id falls back to the stored number", () => {
	const sessionId = "pi-chunk-start-revert";
	expect(
		withBranchProvider(sessionId, () =>
			resolveHistorianChunkStart(sessionId, {
				endMessage: 2,
				endMessageId: "u-gone",
			}),
		),
	).toBe(3);
	expect(
		withBranchProvider(sessionId, () =>
			resolveHistorianChunkStart(sessionId, null),
		),
	).toBe(1);
});

test("Pi: a block-indexed end still continues at the next message", () => {
	const sessionId = "pi-chunk-start-partial";
	const whole = withBranchProvider(sessionId, () =>
		resolveHistorianChunkStart(sessionId, {
			endMessage: 2,
			endMessageId: "u2",
		}),
	);
	expect(
		withBranchProvider(sessionId, () =>
			resolveHistorianChunkStart(sessionId, {
				endMessage: 2,
				endMessageId: "u2",
				endBlockIndex: 0,
			}),
		),
	).toBe(whole);
});
