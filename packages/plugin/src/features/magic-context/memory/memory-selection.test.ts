import { describe, expect, it } from "bun:test";
import { compareMemorySelectionPriority, memoryLengthPenalty, memorySelectionScore, type MemorySelectionCandidate } from "./memory-selection";

function candidate(id: number, overrides: Partial<MemorySelectionCandidate> = {}): MemorySelectionCandidate {
    return { id, category: "RESEARCH", importance: 0, status: "active", lastSeenAt: null, verifiedAt: null, lineTokens: 96, ...overrides };
}

describe("memory selection scoring", () => {
    it("uses every category base and the legacy fallback", () => {
        for (const [category, base] of Object.entries({ OPS_RULES: 80, ENV_STATE: 65, CONFIG_VALUES: 65, INCIDENTS: 50, MODEL_KNOWLEDGE: 40, RESEARCH: 30, CONSTRAINTS: 30 })) {
            expect(memorySelectionScore(candidate(1, { category: category as MemorySelectionCandidate["category"] }))).toBe(base);
        }
    });
    it("rounds and clamps importance, treating missing and non-finite values as zero", () => {
        for (const [importance, bonus] of [[null, 0], [undefined, 0], [NaN, 0], [Infinity, 0], [-100, 0], [1, 0], [2, 1], [50, 13], [100, 25], [500, 25]] as const) {
            expect(memorySelectionScore(candidate(1, { importance: importance as number })) - 30).toBe(bonus);
        }
    });
    it("uses each inclusive length boundary", () => {
        for (const [length, penalty] of [[96, 0], [97, 1], [128, 1], [129, 3], [160, 3], [161, 5], [192, 5], [193, 8], [256, 8], [257, 12], [384, 12], [385, 16], [512, 16], [513, 20], [768, 20], [769, 25]]) {
            expect(memoryLengthPenalty(length)).toBe(penalty);
        }
    });
    it("orders permanent, score, reinforcement, then id", () => {
        const rows = [candidate(5), candidate(4, { lastSeenAt: 10 }), candidate(3, { verifiedAt: 10 }), candidate(2, { importance: 100 }), candidate(1, { status: "permanent", lineTokens: 1000 })];
        expect(rows.sort(compareMemorySelectionPriority).map((row) => row.id)).toEqual([1, 2, 3, 4, 5]);
    });
});
