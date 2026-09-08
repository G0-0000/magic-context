/**
 * Debug / data-collection switch for settled ordinary child sessions
 * (historian, sidekick, and memory migration). Privacy-sensitive dreamer and
 * smart-note children are still deleted after their prompts settle.
 *
 * Unsettled children are never deleted inline because OpenCode's server loop may
 * still be writing after a client timeout or abort. They remain for the
 * age-gated sweep; privacy-sensitive rows are swept even when this switch is on.
 *
 * Process-global, set once at boot from config (mirrors `harness.ts`). A config
 * change requires a restart to take effect.
 */
let keepSubagents = false;

/** Set at plugin boot from `keep_subagents` config. */
export function setKeepSubagents(value: boolean): void {
    keepSubagents = value === true;
}

/** True when settled ordinary child sessions should be retained. */
export function shouldKeepSubagents(): boolean {
    return keepSubagents;
}

/** Test-only reset. Do NOT call from production paths. */
export function _resetKeepSubagentsForTesting(): void {
    keepSubagents = false;
}
