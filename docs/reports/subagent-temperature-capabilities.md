# Subagent temperature capability gating

## Policy

A configured temperature is a sampling value for models with affirmative temperature metadata, not a command to force every transport to accept sampling. `0` is a configured value. False, absent, and unknown capability values omit temperature. A rejection despite positive metadata remains an ordinary provider error: there is no temperature-specific retry or learned rejection cache.

`subagentTemperature` in `packages/plugin/src/shared/subagent-temperature.ts` is reused by all four hosts. It resolves each selected model in two steps. First, the host's own model metadata, whenever it states a boolean. Second, only when the host is silent, the models.dev catalogue that OpenCode caches on the machine (`packages/plugin/src/shared/models-dev-temperature.ts`). No match in either means no temperature.

| Host | Where the selected model's metadata lives | Temperature field there | Source that decides |
| --- | --- | --- | --- |
| OpenCode 1 (1.18.35) | the `chat.params` model, built by OpenCode from models.dev plus `opencode.json` and auth-plugin provider definitions | `capabilities.temperature` (models.dev `temperature`; Antigravity's plugin definitions set `true`) | host metadata; OpenCode itself leaves agent temperature out for a model whose flag is false |
| OpenCode 2 (2.0.22) | `context.model.list()` rows (`@opencode/schema` model) | none: `capabilities` holds tools and modalities only | models.dev cache |
| Pi (`@earendil-works/pi-coding-agent` 0.83) | `ctx.model` from the pi-ai registry and `~/.pi/agent/models.json` custom providers | only Anthropic `compat.supportsTemperature`, which no registry entry sets | models.dev cache |
| OMP (18.2.6) | `ctx.model` with resolved compat | `compat.supportsSamplingParams` (OpenAI-compatible and Anthropic APIs only) | host metadata when present; otherwise models.dev cache |

The cache is `OPENCODE_MODELS_PATH` when set (OpenCode reads that file instead of its cache), else `$XDG_CACHE_HOME/opencode/models.json`, defaulting to `~/.cache/opencode/models.json`. OpenCode 1 writes it. Neither OpenCode 2, Pi nor OMP writes a models.dev JSON of its own: Pi's `models-store.json` and OMP's `models.db` carry no temperature flag. A machine without the cache therefore omits the override on those hosts, which keeps the rule that missing metadata never sends. Matching is exact on provider and model id. Two provider aliases name the same models.dev provider: `google-antigravity` maps to `google`, and OMP's `opencode-zen` maps to `opencode`. On Google, the Antigravity plugins' `antigravity-<model>` ids map to `<model>`. So `google/antigravity-gemini-3.8-flash` (OpenCode) and `google-antigravity/gemini-3.8-flash` (Pi) both resolve to models.dev `google/gemini-3.8-flash`. Codex (`openai-codex`) is deliberately not mapped to `openai`, because the ChatGPT backend is a different transport from the OpenAI API that models.dev describes. It gets no catalogue answer and no temperature. A missing, unparsable or partially written file is not evidence. The parsed index is reused until the file's mtime or size changes.

Each process logs one line per model and decision, naming the source, for example `Subagent temperature sent for google/gemini-3.8-flash: models.dev cache entry google/gemini-3.8-flash says yes`. Pi and OMP children emit the same decision as a content-free `mc_temperature` event, and the parent session log records it.

No reasoning or model-name heuristic substitutes for capability metadata.

OpenCode 1 gates all historian, dreamer, and smart-note compiler agent sampling at the final `chat.params` boundary. OpenCode 2 has no agent-level sampling, so its hidden-completion executor authors the configured `historian.temperature` onto historian requests, including the editor, recomp and fallback passes. It never authors it onto dreamer-task requests, whose bodies are unchanged. It then gates the value per selected model, fallbacks included. Before this change nothing put `historian.temperature` on an OpenCode 2 request, so the gate never fired there. Pi and OMP use `ctx.model` at `before_provider_request`, not an event model field or the chain head. They also remove inherited temperature fields from supported payload shapes when sampling is omitted.

## Real-host evidence

`packages/e2e-tests/tests/subagent-temperature-hosts.test.ts` boots each real host in a throwaway root. The model metadata comes from a models.dev catalogue copied into that root's cache; the committed fixture holds verbatim entries. The test pins only the historian to each case's provider and model, starts the historian, and reads the temperature in the request body that the mock provider captured. While each host was alive, `lsof` over every spawned process showed no path under `~/.local/share/opencode`, `~/.local/share/cortexkit/magic-context`, `~/.config/opencode`, `~/.config/cortexkit` or `~/.cache/opencode`. The historian chains come from the user's configuration, re-entered by hand: on OpenCode, `anthropic/claude-sonnet-5-5` then `openrouter/meta/muse-spark-1.3-contributor`; on Pi, `openrouter/meta/muse-spark-1.3-contributor` then `openrouter/google/gemini-3.8-flash`. The briefed Gemini Flash, Antigravity and Codex cases were added to them. One run used a copy of this machine's OpenCode cache (`MC_E2E_MODELS_CATALOG`, sha256 `8edfca35…f8a`), and every case passed:

| Host | Historian model | Temperature on the wire | Decision |
| --- | --- | --- | --- |
| OpenCode 1 | `google/gemini-3.8-flash` | 0.1 | host metadata says yes |
| OpenCode 1 | `openai/gpt-6.1-sol` | absent | OpenCode omits it (models.dev `false`) |
| OpenCode 1 | `anthropic/claude-sonnet-5-5` | absent | OpenCode omits it (models.dev `false`) |
| OpenCode 1 | `openrouter/meta/muse-spark-1.3-contributor` | 0.1 | host metadata says yes |
| OpenCode 2 | `google/gemini-3.8-flash` | 0.1 | models.dev cache `google/gemini-3.8-flash` says yes |
| OpenCode 2 | `google/antigravity-gemini-3.8-flash` | 0.1 | models.dev cache `google/gemini-3.8-flash` says yes |
| OpenCode 2 | `openai/gpt-6.1-sol` | absent | models.dev cache says no |
| OpenCode 2 | `anthropic/claude-sonnet-5-5` | absent | models.dev cache says no |
| OpenCode 2 | `openrouter/meta/muse-spark-1.3-contributor` | 0.1 | models.dev cache says yes |
| Pi | `openrouter/meta/muse-spark-1.3-contributor` | 0.1 | models.dev cache says yes |
| Pi | `openrouter/google/gemini-3.8-flash` | 0.1 | models.dev cache says yes |
| Pi | `google-antigravity/gemini-3.8-flash` | 0.1 | models.dev cache `google/gemini-3.8-flash` says yes |
| Pi | `openai-codex/gpt-6.1-sol` | absent | no host or models.dev metadata |

Pi's real Codex wire needs a ChatGPT login, so the Codex case uses the Responses wire with the same provider and model ids. The decision depends only on those ids and the metadata.

On this loaded machine, OpenCode 1's pressure trigger sometimes waits indefinitely on its off-thread tag warm-up. The unchanged `historian-success` scenario failed the same way during this work. The OpenCode 1 lane therefore falls back to `/ctx-wrapup`, which runs the same historian agent through the same `chat.params` gate.

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
