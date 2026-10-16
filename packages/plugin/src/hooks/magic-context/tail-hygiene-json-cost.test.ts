import { expect, spyOn, test } from "bun:test";
import * as stableJson from "../../shared/stable-json";
import { refreshTailHygieneBaseline } from "./tail-hygiene-walk";

test("excluded OpenCode parts never materialize whole JSON and unchanged parts reuse fingerprints", () => {
    const part = {
        type: "tool",
        callID: "cost-call",
        tool: "edit",
        state: {
            status: "completed",
            input: { path: "file.ts" },
            output: "[dropped §1§]",
            metadata: {
                diagnostics: Array.from({ length: 20_000 }, (_, i) => ({
                    i,
                    text: "x".repeat(100),
                })),
            },
        },
    };
    const messages = [
        {
            info: { id: "cost-owner", role: "assistant" },
            parts: [part, { type: "text", text: "first" }, part],
        },
        { info: { id: "cost-newest", role: "user" }, parts: [{ type: "text", text: "next" }] },
    ];
    const input = {
        messages,
        tags: [],
        protectedTagNumbers: new Set<number>(),
        cacheBusting: true,
        now: 1,
    };
    const serialize = spyOn(stableJson, "stableStringify");
    const fingerprint = spyOn(stableJson, "stableStringifyHash");
    try {
        let previous = refreshTailHygieneBaseline(input);
        expect(serialize.mock.calls.filter(([value]) => value === part)).toHaveLength(0);
        expect(fingerprint.mock.calls.filter(([value]) => value === part)).toHaveLength(1);
        serialize.mockClear();
        fingerprint.mockClear();
        messages[0].parts[1] = { type: "text", text: "second" };
        previous = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
        expect(serialize).not.toHaveBeenCalled();
        expect(fingerprint).not.toHaveBeenCalled();
        // A metadata edit alone is intentionally invisible to the existing message replay.
        // A sibling edit invalidates that replay, so the full excluded identity must update.
        part.state.metadata.diagnostics[0].text = "different";
        messages[0].parts[1] = { type: "text", text: "third" };
        const changed = refreshTailHygieneBaseline({ ...input, previous, cacheBusting: false });
        expect(fingerprint.mock.calls.filter(([value]) => value === part)).toHaveLength(1);
        expect(changed.baselineParts[0].contentHash).not.toBe(
            previous.baselineParts[0].contentHash,
        );
    } finally {
        serialize.mockRestore();
        fingerprint.mockRestore();
    }
});
