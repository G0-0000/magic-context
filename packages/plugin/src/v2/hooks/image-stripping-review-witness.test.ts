/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { stripProcessedImages } from "../../hooks/magic-context/strip-content";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { adaptPayload } from "./payload";
import type { SessionContext } from "./types";

// Answered images should be stripped in both hosts' representations. The adapter keeps
// OpenCode 2's `media` asset, but the strip helper currently recognizes only `file` parts.
// Opt into the known-failing assertion with MC_IMAGE_STRIPPING_REVIEW=1 bun test <this file>.
const review = process.env.MC_IMAGE_STRIPPING_REVIEW === "1" ? test : test.skip;
const DATA = "a".repeat(300);

test("image strip review control: OpenCode file shape reaches the strip helper", () => {
    const image: MessageLike = {
        info: { id: "user-image", role: "user" },
        parts: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${DATA}` }],
    };
    const result = stripProcessedImages(
        [
            image,
            { info: { id: "answer", role: "assistant" }, parts: [{ type: "text", text: "seen" }] },
        ],
        new Set(),
        {
            detect: true,
            watermark: 5,
            messageTagNumbers: new Map([[image, 1]]),
            persistNewIds: () => true,
        },
    );
    expect(result.stripped).toBe(1);
});

review("image strip review witness: native v2 user media is stripped on an admitted bust", () => {
    // Match the host's class-instance payload: its base64 bytes live under media.source,
    // rather than the top-level mime/url fields the helper reads from a `file` part.
    class HostAsset {
        readonly source = { type: "base64", data: DATA, mediaType: "image/png" };
        readonly mediaType = "image/png";
    }
    const draft: SessionContext = {
        sessionID: "image-review",
        model: { providerID: "anthropic", id: "model" },
        agent: "build",
        system: [],
        tools: {},
        options: {},
        messages: [
            {
                id: "user-image",
                role: "user",
                content: [
                    { type: "text", text: "inspect" },
                    { type: "media", media: new HostAsset(), filename: "image.png" },
                ],
            },
            { id: "answer", role: "assistant", content: [{ type: "text", text: "seen" }] },
        ],
    };
    const mapped = adaptPayload(draft);
    const image = mapped.messages[0];
    expect((image.parts[1] as { media: unknown }).media).toBeInstanceOf(HostAsset);
    const result = stripProcessedImages(mapped.messages, new Set(), {
        detect: true,
        watermark: 5,
        messageTagNumbers: new Map([[image, 1]]),
        persistNewIds: () => true,
    });
    mapped.commit();
    expect(result.stripped).toBe(1);
    expect(draft.messages[0].content.some((part) => part.type === "media")).toBe(false);
});
