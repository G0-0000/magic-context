import type { Memory } from "./types";

export type MemorySelectionCandidate = Pick<Memory, "id" | "importance" | "status" | "lastSeenAt" | "verifiedAt" | "category"> & { lineTokens: number };

export function memoryReinforcementAt(memory: MemorySelectionCandidate): number | null {
    const timestamps = [memory.lastSeenAt, memory.verifiedAt].filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function memoryLengthPenalty(tokens: number): number {
    if (tokens <= 96) return 0;
    if (tokens <= 128) return 1;
    if (tokens <= 160) return 3;
    if (tokens <= 192) return 5;
    if (tokens <= 256) return 8;
    if (tokens <= 384) return 12;
    if (tokens <= 512) return 16;
    if (tokens <= 768) return 20;
    return 25;
}

export function memorySelectionScore(memory: MemorySelectionCandidate): number {
    const bases: Record<string, number> = { OPS_RULES: 80, ENV_STATE: 65, CONFIG_VALUES: 65, INCIDENTS: 50, MODEL_KNOWLEDGE: 40, RESEARCH: 30 };
    const importance = memory.importance;
    const bonus = typeof importance === "number" && Number.isFinite(importance)
        ? Math.max(0, Math.min(25, Math.round(importance / 4))) : 0;
    return (Object.hasOwn(bases, memory.category) ? bases[memory.category]! : 30) + bonus - memoryLengthPenalty(memory.lineTokens);
}

/** Permanent first, then composite score, reinforcement recency, and id. */
export function compareMemorySelectionPriority(left: MemorySelectionCandidate, right: MemorySelectionCandidate): number {
    if (left.status === "permanent" && right.status !== "permanent") return -1;
    if (right.status === "permanent" && left.status !== "permanent") return 1;
    const score = memorySelectionScore(right) - memorySelectionScore(left);
    if (score !== 0) return score;
    const leftAt = memoryReinforcementAt(left);
    const rightAt = memoryReinforcementAt(right);
    if (leftAt === null && rightAt !== null) return 1;
    if (rightAt === null && leftAt !== null) return -1;
    return (rightAt ?? 0) - (leftAt ?? 0) || left.id - right.id;
}
