import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { cloneModuleNativeOutput } from "./module-wire";

it("copies 2048 native messages byte-identically without sharing mutable delta-basis containers", () => {
    const messages = Array.from({ length: 2048 }, (_, index) => ({
        info: { id: `msg_${index}`, role: index % 2 ? "assistant" : "user" },
        parts: [
            { type: "text", text: `history ${index} Ελληνικά 🚀 ${"ballast ".repeat(128)}` },
            {
                type: "tool",
                state: {
                    input: JSON.parse('{"__proto__":{"safe":true},"constructor":1,"z":2,"a":3}'),
                    output: "result",
                },
            },
        ],
    }));
    const baseline = JSON.stringify(structuredClone(messages));
    const cloned = cloneModuleNativeOutput(messages) as typeof messages;
    const serialized = JSON.stringify(cloned);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(sha(serialized)).toBe(sha(baseline));
    expect(serialized).toBe(baseline);
    for (let index = 0; index < messages.length; index++) {
        expect(cloned[index]).not.toBe(messages[index]);
        expect(cloned[index].info).not.toBe(messages[index].info);
        expect(cloned[index].parts).not.toBe(messages[index].parts);
        expect(cloned[index].parts[1].state).not.toBe(messages[index].parts[1].state);
    }
    cloned[0].parts[1].state!.input.z = 99;
    expect(messages[0].parts[1].state!.input.z).toBe(2);
});

it("preserves JSON container aliases and cycles in test doubles", () => {
    const shared = { nested: { value: 1 } };
    const input: unknown[] = [shared, shared];
    input.push(input);
    const result = cloneModuleNativeOutput(input);
    expect(result).toEqual(structuredClone(input));
    expect(result[0]).toBe(result[1]);
    expect(result[2]).toBe(result);
    expect(result[0]).not.toBe(shared);
});
