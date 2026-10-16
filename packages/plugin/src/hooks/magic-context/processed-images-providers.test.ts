import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isRecord } from "../../shared/record-type-guard";
import { stripProcessedImages } from "./strip-content";
import type { MessageLike } from "./tag-messages";

const image = (size = 300) => ({
    type: "file",
    mime: "image/png",
    url: `data:image/png;base64,${"a".repeat(size)}`,
});
const message = (id: string, role: string, parts: unknown[]): MessageLike =>
    ({ info: { id, role }, parts }) as MessageLike;

// Compare against the saved pre-change function so an accidental change to
// image eligibility or empty-marker bytes cannot also change the expected output.
const baseSource = readFileSync(
    new URL("./__fixtures__/processed-images.6dec81e7.ts.txt", import.meta.url),
    "utf8",
);
const baseJavascript = new Bun.Transpiler({ loader: "ts" })
    .transformSync(baseSource)
    .replaceAll("export ", "");
const baseStrip = new Function("isRecord", `${baseJavascript}\nreturn stripProcessedImages;`)(
    isRecord,
) as typeof stripProcessedImages;

test("issue 699 Anthropic user images are byte-identical to base across randomized sessions", () => {
    let seed = 699;
    const random = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
    };
    for (let scenario = 0; scenario < 300; scenario++) {
        const raw: MessageLike[] = Array.from({ length: 2 + random(30) }, (_, i) =>
            message(`m-${i}`, random(3) ? "user" : "assistant", [
                { type: "text", text: `text-${random(10)}` },
                { ...image([0, 175, 200, 500][random(4)]), cache_control: { type: "ephemeral" } },
                ...(random(2) ? [image()] : []),
            ]),
        );
        const frozen = new Set<string>();
        for (let pass = 0; pass < 5; pass++) {
            const watermark = random(raw.length);
            const detect = random(2) === 1 && watermark > 0;
            const old = structuredClone(raw);
            const current = structuredClone(raw);
            const tags = (messages: MessageLike[]) =>
                new Map(messages.map((msg, i) => [msg, i + 1]));
            const oldResult = baseStrip(old, frozen, {
                detect,
                watermark,
                messageTagNumbers: tags(old),
            });
            const newResult = stripProcessedImages(current, frozen, {
                detect,
                watermark,
                messageTagNumbers: tags(current),
            });
            expect(JSON.stringify(current)).toBe(JSON.stringify(old));
            expect(newResult).toEqual(oldResult);
            for (const id of oldResult.newlyStrippedIds) frozen.add(id);
            raw.push(message(`tail-${pass}`, pass % 2 ? "user" : "assistant", [image()]));
        }
    }
});

test("issue 699 tool attachments use non-empty markers, retain other files, and replay without an answer", () => {
    const raw = [
        message("tool-owner", "assistant", [
            {
                type: "tool",
                callID: "read-call",
                tool: "read",
                state: {
                    status: "completed",
                    input: { filePath: "pixel.png" },
                    output: "",
                    attachments: [
                        image(),
                        {
                            type: "file",
                            mime: "application/pdf",
                            url: "data:application/pdf;base64,abc",
                        },
                        image(),
                    ],
                },
            },
        ]),
        message("answer", "assistant", [{ type: "text", text: "seen" }]),
    ];
    const frozen = new Set<string>();
    const markers = new Map<string, "" | "[image stripped]">();
    const first = structuredClone(raw);
    const result = stripProcessedImages(first, frozen, {
        detect: true,
        watermark: 4,
        messageTagNumbers: new Map([[first[0], 3]]),
        frozenMarkers: markers,
        persistNewIds: (ids, newMarkers) => {
            expect(first).toEqual(raw);
            for (const id of ids) {
                frozen.add(id);
                markers.set(id, newMarkers.get(id)!);
            }
            return true;
        },
    });
    expect(result).toEqual({ stripped: 2, newlyStrippedIds: ["tool-owner"] });
    expect(first[0].parts).toEqual([
        {
            type: "tool",
            callID: "read-call",
            tool: "read",
            state: {
                status: "completed",
                input: { filePath: "pixel.png" },
                output: "[image stripped]\n[image stripped]",
                attachments: [
                    {
                        type: "file",
                        mime: "application/pdf",
                        url: "data:application/pdf;base64,abc",
                    },
                ],
            },
        },
    ]);
    const replay = structuredClone(raw.slice(0, 1));
    stripProcessedImages(replay, frozen, {
        detect: false,
        watermark: 0,
        messageTagNumbers: new Map(),
        frozenMarkers: markers,
    });
    expect(JSON.stringify(replay[0])).toBe(JSON.stringify(first[0]));
    const unAnswered = structuredClone(raw.slice(0, 1));
    expect(
        stripProcessedImages(unAnswered, new Set(), {
            detect: true,
            watermark: 4,
            messageTagNumbers: new Map(),
        }).stripped,
    ).toBe(0);
    expect(unAnswered).toEqual(raw.slice(0, 1));
});

test("issue 699 failed tool-image persistence leaves native bytes intact", () => {
    const raw = [
        message("tool", "assistant", [
            {
                type: "tool",
                state: { status: "completed", output: "read", attachments: [image()] },
            },
        ]),
        message("answer", "assistant", []),
    ];
    const current = structuredClone(raw);
    const outcome = stripProcessedImages(current, new Set(), {
        detect: true,
        watermark: 1,
        messageTagNumbers: new Map(),
        persistNewIds: () => false,
    });
    expect(outcome).toEqual({ stripped: 0, newlyStrippedIds: [] });
    expect(current).toEqual(raw);
});
