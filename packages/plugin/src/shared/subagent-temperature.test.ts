import { beforeEach, describe, expect, test } from "bun:test";
import {
    __temperatureTest,
    applyHiddenSubagentTemperature,
    subagentTemperature,
} from "./subagent-temperature";

beforeEach(() => __temperatureTest.reset());

describe("subagent sampling metadata", () => {
    for (const [host, yes, no] of [
        [
            "OpenCode 1",
            { capabilities: { temperature: true } },
            { capabilities: { temperature: false } },
        ],
        ["OpenCode 2", { temperature: true }, { temperature: false }],
        [
            "Pi",
            { compat: { supportsTemperature: true } },
            { compat: { supportsTemperature: false } },
        ],
        [
            "OMP",
            { compat: { supportsSamplingParams: true } },
            { compat: { supportsSamplingParams: false } },
        ],
    ] as const) {
        test(`${host} requires affirmative metadata and preserves explicit zero`, () => {
            const logs: string[] = [];
            const note = (line: string) => logs.push(line);
            expect(subagentTemperature("provider/yes", yes, 0.1, note)).toBe(0.1);
            expect(subagentTemperature("provider/yes", yes, 0, note)).toBe(0);
            expect(subagentTemperature("provider/no", no, 0.1, note)).toBeUndefined();
            expect(
                subagentTemperature("provider/missing", { reasoning: false }, 0.1, note),
            ).toBeUndefined();
            expect(
                subagentTemperature("provider/unknown", { temperature: "yes" }, 0.1, note),
            ).toBeUndefined();
            expect(subagentTemperature("provider/unset", yes, undefined, note)).toBeUndefined();
            expect(logs).toEqual([
                "Subagent temperature dropped for provider/no: metadata says no",
                "Subagent temperature dropped for provider/missing: metadata missing",
                "Subagent temperature dropped for provider/unknown: metadata missing",
            ]);
        });
    }

    test("drop logging is once per model, but does not remember a denial as a capability", () => {
        const logs: string[] = [];
        const note = (line: string) => logs.push(line);
        expect(subagentTemperature("p/m", undefined, 0.1, note)).toBeUndefined();
        expect(subagentTemperature("p/m", undefined, 0.1, note)).toBeUndefined();
        expect(subagentTemperature("p/m", { temperature: true }, 0.1, note)).toBe(0.1);
        expect(logs).toHaveLength(1);
    });

    test("OpenCode 1 guards historian, dreamer and compiler per resolved model, not unrelated agents", () => {
        const yes = { providerID: "p", id: "flash", capabilities: { temperature: true } };
        const no = { providerID: "p", id: "fallback", capabilities: { temperature: false } };
        for (const agent of [
            "historian",
            "historian-editor",
            "historian-recomp",
            "dreamer",
            "dreamer-classifier",
            "smart-note-compiler",
        ]) {
            const output: { temperature?: number } = { temperature: 0 };
            applyHiddenSubagentTemperature({ agent, model: yes }, output, () => {});
            expect(output).toEqual({ temperature: 0 });
            applyHiddenSubagentTemperature({ agent, model: no }, output, () => {});
            expect(output).toEqual({});
            output.temperature = 0.1;
            applyHiddenSubagentTemperature({ agent }, output, () => {});
            expect(output).toEqual({});
        }
        const output = { temperature: 0.4 };
        applyHiddenSubagentTemperature({ agent: "build", model: no }, output, () => {});
        expect(output.temperature).toBe(0.4);
    });
});
