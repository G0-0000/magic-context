import { describe, expect, it } from "bun:test";
import { type AuditReport, classifyHighFindings } from "./audit-packed-packages";

const ROOT = "@cortexkit/opencode-magic-context";
const advisory = (id: string) => ({
    source: 1,
    title: "toml-node advisory",
    url: `https://github.com/advisories/${id}`,
});
const TOML_ADVISORIES = ["GHSA-4qx8-w7c3-pj3p", "GHSA-9j65-hcg3-gc64", "GHSA-9qmh-m7c6-f92p"].map(
    advisory,
);

/** The shape npm audit reported for the packed plugin on 2026-10-23. */
function tomlChain(): NonNullable<AuditReport["vulnerabilities"]> {
    return {
        toml: { severity: "high", via: [...TOML_ADVISORIES] },
        effect: { severity: "high", via: ["toml"] },
        "@opencode-ai/plugin": { severity: "high", via: ["effect"] },
        [ROOT]: { severity: "high", via: ["@opencode-ai/plugin"] },
    };
}

describe("packed audit exceptions", () => {
    it("accepts the documented toml advisories along OpenCode's plugin path", () => {
        const result = classifyHighFindings({ vulnerabilities: tomlChain() }, ROOT);
        expect(result.refused).toEqual([]);
        expect(result.accepted).toHaveLength(4);
        expect(result.unusedExceptions).toEqual([]);
    });

    it("refuses a toml advisory that is not on the list", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities.toml = {
            severity: "high",
            via: [...TOML_ADVISORIES, advisory("GHSA-0000-0000-0000")],
        };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("toml (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("refuses a new advisory on a package along the path", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities.effect = { severity: "high", via: ["toml", advisory("GHSA-1111-1111-1111")] };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("effect (high)");
        expect(result.refused).toContain("@opencode-ai/plugin (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("refuses toml reached through a package outside the documented path", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities["some-other-dependency"] = { severity: "high", via: ["toml"] };
        vulnerabilities[ROOT] = { severity: "high", via: ["@opencode-ai/plugin", "some-other-dependency"] };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("some-other-dependency (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("refuses an unrelated critical finding", () => {
        const vulnerabilities = { ...tomlChain(), lodash: { severity: "critical", via: [advisory("GHSA-x")] } };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toEqual(["lodash (critical)"]);
    });

    it("reports an exception that no longer matches anything", () => {
        const result = classifyHighFindings({ vulnerabilities: {} }, ROOT);
        expect(result.accepted).toEqual([]);
        expect(result.refused).toEqual([]);
        expect(result.unusedExceptions).toEqual(["toml"]);
    });
});
