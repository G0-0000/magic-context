import { expect, spyOn, test } from "bun:test";
import { providerVisiblePiPart } from "./provider-visible-parts-pi";
import { refreshPiTailHygieneBaseline } from "./tail-hygiene-walk-pi";

test("excluded Pi identity visits zero UI metadata bytes", () => {
	const data = { diagnostics: "x".repeat(18 * 1024 * 1024) };
	let bytesVisited = 0;
	let reads = 0;
	const metadata = new Proxy(data, {
		ownKeys(target) {
			bytesVisited += data.diagnostics.length;
			return Reflect.ownKeys(target);
		},
		get(target, key, receiver) {
			if (key === "diagnostics") bytesVisited += data.diagnostics.length;
			return Reflect.get(target, key, receiver);
		},
	});
	const part = {
		type: "thinking",
		thinking: "excluded",
		thinkingSignature: "signature",
		get metadata() {
			reads++;
			return metadata;
		},
		get details() {
			reads++;
			return metadata;
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
		expect({ bytesVisited, reads }).toEqual({ bytesVisited: 0, reads: 0 });
		expect(
			serialize.mock.calls.filter(([value]) => value === part),
		).toHaveLength(0);
		expect(
			serialize.mock.calls.filter(
				([value]) =>
					value !== null &&
					typeof value === "object" &&
					"type" in value &&
					value.type === "thinking",
			),
		).toHaveLength(1);
		serialize.mockClear();
		input.messages[0].content = [part, { type: "text", text: "second" }];
		const replay = refreshPiTailHygieneBaseline({
			...input,
			previous,
			cacheBusting: false,
		});
		expect(serialize).not.toHaveBeenCalled();
		data.diagnostics = "y".repeat(18 * 1024 * 1024);
		const edited = refreshPiTailHygieneBaseline({
			...input,
			previous: replay,
			cacheBusting: false,
		});
		expect(edited.baselineParts[0]).toEqual(replay.baselineParts[0]);
		expect(serialize).not.toHaveBeenCalled();
		expect({ bytesVisited, reads }).toEqual({ bytesVisited: 0, reads: 0 });
		part.thinkingSignature = "different signature";
		const forwarded = refreshPiTailHygieneBaseline({
			...input,
			previous: edited,
			cacheBusting: false,
		});
		expect(forwarded.baselineParts[0].contentHash).not.toBe(
			edited.baselineParts[0].contentHash,
		);
	} finally {
		serialize.mockRestore();
	}
});

test("Pi provider projection retains signatures, replay flags and opaque tool arguments", () => {
	const argumentsWithMetadata = { metadata: { actualToolInput: "keep me" } };
	const parts = [
		{ type: "text", text: "text", textSignature: "text-signature" },
		{
			type: "thinking",
			thinking: "reason",
			thinkingSignature: "thinking-signature",
			redacted: true,
		},
		{ type: "image", data: "YWJj", mimeType: "image/png" },
		{
			type: "toolCall",
			id: "call",
			name: "read",
			arguments: argumentsWithMetadata,
			namespace: "tools",
			thoughtSignature: "thought-signature",
		},
	];
	for (const part of parts)
		expect(
			providerVisiblePiPart({
				...part,
				metadata: { UI: true },
				details: { UI: true },
			}),
		).toEqual(part);
	const message = {
		role: "assistant",
		provider: "openai",
		api: "openai-responses",
		model: "fixture",
		stopReason: "toolUse",
		content: parts,
	};
	expect(
		providerVisiblePiPart({
			...message,
			metadata: { UI: true },
			details: { UI: true },
		}),
	).toEqual(message);
	expect(
		providerVisiblePiPart({
			type: "toolCall",
			arguments: argumentsWithMetadata,
		}),
	).toEqual({ type: "toolCall", arguments: argumentsWithMetadata });
});
