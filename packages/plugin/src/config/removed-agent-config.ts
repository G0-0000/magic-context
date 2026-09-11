const REMOVED_AGENT_CONFIG_KEY = "sidekick";

export const REMOVED_AGENT_CONFIG_WARNING = `The "${REMOVED_AGENT_CONFIG_KEY}" configuration was removed and is ignored.`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Remove the retired agent block before profile resolution or schema parsing.
 * The same warning array may be shared across user and project layers so one
 * load reports the removal once while preserving every unrelated setting.
 */
export function stripRemovedAgentConfig(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    let removed = false;
    const patched = { ...rawConfig };

    if (Object.hasOwn(patched, REMOVED_AGENT_CONFIG_KEY)) {
        delete patched[REMOVED_AGENT_CONFIG_KEY];
        removed = true;
    }

    if (isPlainObject(patched.profiles)) {
        const profiles = { ...patched.profiles };
        let profilesChanged = false;
        for (const [name, value] of Object.entries(profiles)) {
            if (!isPlainObject(value) || !Object.hasOwn(value, REMOVED_AGENT_CONFIG_KEY)) continue;
            const profile = { ...value };
            delete profile[REMOVED_AGENT_CONFIG_KEY];
            profiles[name] = profile;
            profilesChanged = true;
            removed = true;
        }
        if (profilesChanged) patched.profiles = profiles;
    }

    if (removed && !warnings.includes(REMOVED_AGENT_CONFIG_WARNING)) {
        warnings.push(REMOVED_AGENT_CONFIG_WARNING);
    }

    return removed ? patched : rawConfig;
}
