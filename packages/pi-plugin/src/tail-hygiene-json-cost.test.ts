import { expect, spyOn, test } from "bun:test";
import { refreshPiTailHygieneBaseline } from "./tail-hygiene-walk-pi";

test("excluded Pi parts never materialize whole JSON and unchanged parts reuse fingerprints", () => {
	const part = {
		type: "reasoning",
		text: "excluded",
		metadata: {
			diagnostics: Array.from({ length: 20_000 }, (_, i) => ({
				i,
				text: "x".repeat(100),
			})),
		},
	};
	const input = {
		messages: [
			{
				role: "assistant",
				content: [part, { type: "text", text: "first" }, part],
			},
			{ role: "user", content: "newest" },
		],
		tags: [],
		protectedTagNumbers: new Set<number>(),
		cacheBusting: true,
		now: 1,
	};
	const serialize = spyOn(JSON, "stringify");
	try {
		const previous = refreshPiTailHygieneBaseline(input);
		expect(
			serialize.mock.calls.filter(([value]) => value === part),
		).toHaveLength(0);
		serialize.mockClear();
		input.messages[0].content = [part, { type: "text", text: "second" }];
		const replay = refreshPiTailHygieneBaseline({
			...input,
			previous,
			cacheBusting: false,
		});
		// Reuse skips even the per-scalar serializer calls, not just the final join.
		expect(serialize).not.toHaveBeenCalled();
		part.metadata.diagnostics[0].text = "different";
		const edited = refreshPiTailHygieneBaseline({
			...input,
			previous: replay,
			cacheBusting: false,
		});
		expect(edited.baselineParts[0].contentHash).not.toBe(
			replay.baselineParts[0].contentHash,
		);
	} finally {
		serialize.mockRestore();
	}
});
