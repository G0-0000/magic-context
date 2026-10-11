export type TemperatureMetadata = {
    temperature?: boolean;
    capabilities?: { temperature?: boolean };
    compat?: { supportsTemperature?: boolean; supportsSamplingParams?: boolean };
};

const loggedModels = new Set<string>();

export function temperatureCapability(metadata: unknown): boolean | undefined {
    if (!metadata || typeof metadata !== "object") return undefined;
    const model = metadata as TemperatureMetadata;
    const supported =
        model.capabilities?.temperature ??
        model.temperature ??
        model.compat?.supportsTemperature ??
        model.compat?.supportsSamplingParams;
    return typeof supported === "boolean" ? supported : undefined;
}

export function logTemperatureDrop(
    model: string,
    supported: boolean | undefined,
    log: (message: string) => void,
): void {
    if (loggedModels.has(model)) return;
    loggedModels.add(model);
    log(
        `Subagent temperature dropped for ${model}: ${supported === false ? "metadata says no" : "metadata missing"}`,
    );
}

/** Only a positive capability permits sampling; reasoning alone is not evidence. */
export function subagentTemperature(
    model: string,
    metadata: unknown,
    temperature: number | undefined,
    log: (message: string) => void,
): number | undefined {
    if (temperature === undefined) return undefined;
    const supported = temperatureCapability(metadata);
    if (supported === true) return temperature;
    logTemperatureDrop(model, supported, log);
    return undefined;
}

/** OpenCode 1 computes agent sampling before chat.params resolves the final model. */
export function applyHiddenSubagentTemperature(
    input: { agent: string; model?: TemperatureMetadata & { providerID?: string; id?: string } },
    output: { temperature?: number },
    log: (message: string) => void,
): void {
    if (!/^(?:historian(?:-|$)|dreamer(?:-|$)|smart-note-compiler$)/.test(input.agent)) return;
    const temperature = subagentTemperature(
        `${input.model?.providerID ?? "unknown"}/${input.model?.id ?? "unknown"}`,
        input.model,
        output.temperature,
        log,
    );
    if (temperature === undefined) delete output.temperature;
    else output.temperature = temperature;
}

export const __temperatureTest = {
    reset(): void {
        loggedModels.clear();
    },
};
