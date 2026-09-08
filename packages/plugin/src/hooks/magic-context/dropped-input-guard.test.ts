/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    containsDroppedInputPlaceholder,
    createDroppedInputToolExecuteBeforeHook,
} from "./dropped-input-guard";

const blockedInputs: Array<[string, unknown]> = [
    ["tagged drop sentinel", { command: "[dropped §431§]" }],
    ["legacy five-character truncation", { command: "which...[truncated]" }],
    ["legacy array summary", { files: "[3 items]" }],
    ["legacy object summary", { metadata: "[object]" }],
    ["new dropped marker object", { dropped: "[dropped §431§]" }],
];

describe("dropped input execution guard", () => {
    for (const [label, input] of blockedInputs) {
        it(`detects the ${label}`, () => {
            expect(containsDroppedInputPlaceholder(input)).toBe(true);
        });
    }

    it("walks nested input without mistaking explanatory prose for a placeholder", () => {
        expect(
            containsDroppedInputPlaceholder({ nested: [{ value: "abcde...[truncated]" }] }),
        ).toBe(true);
        expect(
            containsDroppedInputPlaceholder({
                content: "The log used ...[truncated] before the final retry.",
            }),
        ).toBe(false);
        // A real value that ends with the sentinel text is longer than any copied
        // placeholder (five characters plus the sentinel) and must stay executable.
        expect(
            containsDroppedInputPlaceholder({
                content: "expected output line 1\nexpected output line 2\n...[truncated]",
            }),
        ).toBe(false);
    });

    it("rejects through the OpenCode tool.execute.before hook with recovery guidance", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();

        await expect(
            hook(
                { tool: "write", sessionID: "ses-431", callID: "call-431" },
                { args: { filePath: "/tmp/...[truncated]", content: "payload" } },
            ),
        ).rejects.toThrow("ctx_expand");
    });

    it("allows ordinary executable arguments", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();
        await expect(
            hook(
                { tool: "bash", sessionID: "ses-clean", callID: "call-clean" },
                { args: { command: "which docker" } },
            ),
        ).resolves.toBeUndefined();
    });
});
