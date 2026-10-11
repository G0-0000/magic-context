# Subagent temperature capability gating

## Policy

A configured temperature is a sampling value for models with affirmative temperature metadata, not a command to force every transport to accept sampling. `0` is a configured value. False, absent, and unknown capability values omit temperature. A rejection despite positive metadata remains an ordinary provider error: there is no temperature-specific retry or learned rejection cache.

`subagentTemperature` in `packages/plugin/src/shared/subagent-temperature.ts` is reused by all four hosts and understands these model metadata shapes:

| Host | Resolved model signal | Missing signal |
| --- | --- | --- |
| OpenCode 1 | `capabilities.temperature` on the `chat.params` model | Omit |
| OpenCode 2 | `capabilities.temperature` or a boolean `temperature` on the selected catalog row | Omit |
| Pi | `compat.supportsTemperature`, when supplied by the registry | Omit |
| OMP | `compat.supportsSamplingParams` | Omit |

OpenCode 1's installed SDK 1.17.11 declares `capabilities.temperature` separately from reasoning. Pi's newer AI SDK 0.87.1 declares `compat.supportsTemperature` for Anthropic compatibility, but there is no universal Pi temperature flag across APIs; its implicit default is deliberately not treated as affirmative metadata. OMP 18.2.6 declares sampling compatibility separately from reasoning compatibility. OpenCode 2's installed client 2.0.22 catalog has no declared temperature capability, so its current rows omit the override unless a host exposes an affirmative field. No reasoning/model-name heuristic substitutes for capability metadata.

OpenCode 1 gates all historian, dreamer, and smart-note compiler agent sampling at the final `chat.params` boundary. OpenCode 2 looks up the selected model for each hidden completion attempt, including fallback models, before registering its shaped request. Pi and OMP use `ctx.model` at `before_provider_request`, not an event model field or the chain head. They also remove inherited temperature fields from supported payload shapes when sampling is omitted. The host-side `PiSubagentRunner` forwards a content-free drop diagnostic emitted by the calibration extension in the spawned Pi/OMP process, from either stdout or stderr into the session log, once per model per host process.

The Pi dreamer currently loads `historian-calibration-extension.ts` only to fingerprint the effective system prompt for telemetry, not to apply historian sampling. Its task runtime configuration has no temperature field. Any authored OpenCode dreamer request or agent sampling passes through the same capability gate as historians.

## Why could four Pi Codex calls succeed?

The live `subagent_invocations` ledger, which records model-call status, provider/model identifiers, timing, and token usage, was queried only with `sqlite3 -readonly ~/.local/share/cortexkit/magic-context/context.db` to compare the successful calls with the temperature failures. No provider was called and no store was modified.

The four completed `pi` / `historian` / `gpt-6.1-sol` rows on 2026-10-10 are:

| Invocation | Start (UTC) | Duration (seconds) | Input / output tokens |
| --- | --- | --- | --- |
| 23253 | 16:33:00 | 70.9 | 40238 / 1982 |
| 23255 | 16:34:11 | 100.9 | 53806 / 3027 |
| 23258 | 16:39:29 | 74.4 | 40238 / 2229 |
| 23260 | 16:40:43 | 94.6 | 53806 / 2903 |

All four have provider `openai`, session `019de471-4fdc-762d-9286-624dfad0b5fe`, null task, and null parent invocation. That same session has temperature-rejected zero-token invocations later, starting at 20:17. The other failing session is `019e8905-3b53-7442-b79f-4ee106474820`. Temperature-rejection counts for the investigated UTC windows are: Oct 8 22h: 2; Oct 9 10h/11h/12h: 7/12/1; Oct 10 20h/21h/22h/23h: 28/36/36/46. The ledger also has nine earlier temperature errors on Oct 8 02h–03h.

There **is** a source-level path difference upstream of the four call sites in `pi-historian-runner.ts`: automatic runs in `context-handler.ts` forward `historianOptions.temperature`, but `commands/ctx-wrapup.ts` does not pass temperature to `runPiHistorian`. The manual wrapup's historian therefore runs without the configured temperature override. Within `runPiHistorian`, the first, repair, fallback, and editor calls all forward the same optional temperature; none selectively removes it for Codex. A manual wrapup is consequently a concrete explanation for a successful Codex fallback despite the global configured temperature. Before capability gating, an automatic run would inject that temperature and be rejected before generating tokens.

However, **the invocation ledger alone cannot prove that these four calls were manual wrapups**. It stores neither the command/trigger, effective temperature, serialized request, transport API, loaded plugin version, nor account identity. The completed rows have the same recorded provider/model and even the same session as later failures; they do not demonstrate a different route or account. A different loaded configuration/build or a provider extension bypassing payload hooks would also be compatible with the ledger. Establishing which explanation actually occurred requires contemporaneous command/request logs, which were not read under the store-access restriction. Preventing unsupported temperature injection through model capability gating does not depend on guessing the trigger or account behind those four historical calls.
