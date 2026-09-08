/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createPiDroppedInputGuard } from "./dropped-input-guard-pi";

const blockedInputs: Array<[string, Record<string, unknown>]> = [
	["tagged drop sentinel", { command: "[dropped §431§]" }],
	["legacy truncation", { command: "which...[truncated]" }],
	["legacy array summary", { files: "[3 items]" }],
	["legacy object summary", { metadata: "[object]" }],
	["new dropped marker", { dropped: "[dropped §431§]" }],
];

describe("Pi dropped input execution guard", () => {
	for (const [label, input] of blockedInputs) {
		it(`blocks the ${label}`, () => {
			const result = createPiDroppedInputGuard()({
				type: "tool_call",
				toolCallId: "call-431",
				toolName: "write",
				input,
			});

			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("ctx_expand"),
			});
		});
	}

	it("allows ordinary executable arguments", () => {
		const result = createPiDroppedInputGuard()({
			type: "tool_call",
			toolCallId: "call-clean",
			toolName: "bash",
			input: { command: "which docker" },
		});

		expect(result).toBeUndefined();
	});
});
