import { expect, test } from "bun:test";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";
import { createPiTranscript } from "./transcript-pi";

const originalText =
	"I have been looking at the implementation and the tests are important.";
const signature = JSON.stringify({ v: 1, id: "msg_text", phase: "commentary" });
const opaque = {
	type: "reasoning",
	id: "rs_keep",
	encrypted_content: "opaque+/=",
	summary: [],
	extra: { signature: "unchanged" },
};
function fixture(api = "openai-responses") {
	return {
		role: "assistant",
		api,
		provider: "openai",
		model: "mock",
		timestamp: 1,
		content: [{ type: "text", text: originalText, textSignature: signature }],
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "openai",
			dt: true,
			signature: "payload-signature",
			items: [
				opaque,
				{
					type: "message",
					role: "assistant",
					id: "msg_text",
					phase: "commentary",
					status: "completed",
					signature: "item-signature",
					content: [
						{
							type: "output_text",
							text: originalText,
							annotations: [
								{ type: "url_citation", url: "https://example.com" },
							],
							logprobs: [],
						},
					],
				},
			],
		},
	};
}

function admitted(message: ReturnType<typeof fixture>) {
	const model = {
		api: message.api,
		provider: message.provider,
		id: message.model,
	};
	return piMatchesPreparedStructure(
		{ input: message.providerPayload.items },
		piPreparedStructure([message], model),
	);
}

for (const [name, text, sentinel] of [
	["drop", "[dropped §3§]", true],
	["caveman", "§3§ I looking at implementation + tests important.", false],
] as const) {
	test(`native assistant ${name} rewrites only matched output_text and replays identically`, () => {
		for (const api of ["openai-responses", "openai-codex-responses"]) {
			let served: string | undefined;
			for (let pass = 0; pass < 4; pass++) {
				const raw = fixture(api);
				const pristine = JSON.stringify(raw);
				const messages = [raw];
				const transcript = createPiTranscript(messages, undefined);
				const part = transcript.messages[0].parts[0];
				if (sentinel) part.replaceWithSentinel(text);
				else part.setText(text);
				transcript.commit();
				const next = messages[0];
				const expected = JSON.parse(pristine);
				expected.content[0].text = text;
				expected.providerPayload.items[1].content[0].text = text;
				expect(JSON.stringify(next)).toBe(JSON.stringify(expected));
				expect(JSON.stringify(raw)).toBe(pristine);
				expect(next.content[0].textSignature).toBe(signature);
				expect(next.providerPayload.items[0]).toBe(opaque);
				expect(admitted(next)).toBe(true);
				const bytes = JSON.stringify(next);
				if (served !== undefined) expect(bytes).toBe(served);
				served = bytes;
			}
		}
	});
}

test("native assistant tag-only keeps cached bytes and existing dispatch allowance", () => {
	const raw = fixture();
	// With only text items, dispatch accepts unlabelled cached text alongside
	// prepared text carrying a leading "§N§ " label. Remove reasoning to test it.
	raw.providerPayload.items.shift();
	const payload = raw.providerPayload;
	const before = JSON.stringify(payload);
	const messages = [raw];
	const transcript = createPiTranscript(messages, undefined);
	transcript.messages[0].parts[0].setText(`§3§ ${originalText}`);
	transcript.commit();
	expect(messages[0].providerPayload).toBe(payload);
	expect(JSON.stringify(messages[0].providerPayload)).toBe(before);
	expect(admitted(messages[0])).toBe(true);
});

test("native assistant ambiguous match preserves payload and still refuses", () => {
	const raw = fixture();
	raw.providerPayload.items.push(structuredClone(raw.providerPayload.items[1]));
	const payload = raw.providerPayload;
	const before = JSON.stringify(payload);
	const messages = [raw];
	const transcript = createPiTranscript(messages, undefined);
	transcript.messages[0].parts[0].setText(
		"§3§ I looking at implementation + tests important.",
	);
	transcript.commit();
	expect(messages[0].providerPayload).toBe(payload);
	expect(JSON.stringify(payload)).toBe(before);
	expect(admitted(messages[0])).toBe(false);
});

for (const kind of [
	"missing-signature",
	"wrong-phase",
	"duplicate-block",
	"multiple-outputs",
] as const) {
	test(`native text identity rejects ${kind} without guessing`, () => {
		const raw = fixture();
		const item = raw.providerPayload.items[1] as {
			phase: string;
			content: { type: string; text: string }[];
		};
		if (kind === "missing-signature") raw.content[0].textSignature = "invalid";
		if (kind === "wrong-phase") item.phase = "final_answer";
		if (kind === "duplicate-block") raw.content.push({ ...raw.content[0] });
		if (kind === "multiple-outputs")
			item.content.push({ type: "output_text", text: "another output" });
		const payload = raw.providerPayload;
		const before = JSON.stringify(payload);
		const messages = [raw];
		const transcript = createPiTranscript(messages, undefined);
		transcript.messages[0].parts[0].setText("edited text");
		transcript.commit();
		expect(messages[0].providerPayload).toBe(payload);
		expect(JSON.stringify(payload)).toBe(before);
		expect(admitted(messages[0])).toBe(false);
	});
}

test("native text replay selects id and phase rather than position", () => {
	const raw = fixture();
	const selected = raw.providerPayload.items[1];
	raw.providerPayload.items.push({
		...selected,
		phase: "final_answer",
	} as typeof selected);
	raw.providerPayload.items.reverse();
	const messages = [raw];
	const transcript = createPiTranscript(messages, undefined);
	transcript.messages[0].parts[0].setText("edited text");
	transcript.commit();
	expect(messages[0].providerPayload.items[0]).toBe(
		raw.providerPayload.items[0],
	);
	expect(messages[0].providerPayload.items[2]).toBe(opaque);
	expect(messages[0].providerPayload.items[1]).toEqual({
		...selected,
		content: [
			{
				...(selected as { content: object[] }).content[0],
				text: "edited text",
			},
		],
	});
});
