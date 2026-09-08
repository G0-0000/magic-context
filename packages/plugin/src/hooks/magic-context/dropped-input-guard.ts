const LEGACY_TRUNCATION_SENTINEL = "...[truncated]";
const DROPPED_INPUT_MESSAGE =
    "A tool argument was a dropped placeholder and was not executed. Recover the original arguments with ctx_expand, then issue a fresh tool call.";

function isDroppedPlaceholderString(value: string): boolean {
    return (
        (value.startsWith("[dropped §") && value.endsWith("§]")) ||
        value.endsWith(LEGACY_TRUNCATION_SENTINEL) ||
        value === "[object]" ||
        /^\[\d+ items\]$/.test(value)
    );
}

export function droppedInputMarker(tagId: number): { dropped: string } {
    return { dropped: `[dropped §${tagId}§]` };
}

export function containsDroppedInputPlaceholder(value: unknown): boolean {
    const seen = new WeakSet<object>();

    const visit = (candidate: unknown): boolean => {
        if (typeof candidate === "string") return isDroppedPlaceholderString(candidate);
        if (candidate === null || typeof candidate !== "object") return false;
        if (seen.has(candidate)) return false;
        seen.add(candidate);
        if (Array.isArray(candidate)) return candidate.some(visit);
        return Object.values(candidate as Record<string, unknown>).some(visit);
    };

    return visit(value);
}

export function assertExecutableToolInput(input: unknown): void {
    if (containsDroppedInputPlaceholder(input)) {
        throw new Error(DROPPED_INPUT_MESSAGE);
    }
}

export function createDroppedInputToolExecuteBeforeHook() {
    return async (_input: unknown, output: unknown): Promise<void> => {
        const args =
            output !== null && typeof output === "object"
                ? (output as { args?: unknown }).args
                : undefined;
        assertExecutableToolInput(args);
    };
}

export { DROPPED_INPUT_MESSAGE };
