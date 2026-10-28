import { tool } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../../config";
import { isCompactionEnabled, isDreamerRunnable } from "../../config/agent-disable";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { getProtectionWindowForSession } from "../../features/magic-context/protection-window";
import { getObservedEpochFloor } from "../../features/magic-context/storage-meta-persisted";
import { setCtxReduceRegisteredGlobally } from "../../hooks/magic-context/ctx-reduce-availability";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { subagentToolRefusal } from "../../plugin/subagent-tool-policy";
import { type Database, withAsyncPrivilegedWriter } from "../../shared/sqlite";
import { createCtxExpandTools } from "../../tools/ctx-expand";
import { createCtxMemoryListTools, createCtxMemoryTools } from "../../tools/ctx-memory";
import { createCtxNoteTools } from "../../tools/ctx-note";
import { createCtxReduceTools } from "../../tools/ctx-reduce";
import { createCtxSearchTools } from "../../tools/ctx-search";
import { resolveOpenCodeStrataAsk } from "../../tools/ctx-search/strata-ask";
import type { V2Context } from "./types";

/** Registration dispose and one OC2 call both cancel that call's Strata requests. */
function mergeAbortSignals(
    lifecycle: AbortSignal,
    call: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
    if (!call || call === lifecycle) return { signal: lifecycle, dispose: () => undefined };
    if (typeof AbortSignal.any === "function") {
        return { signal: AbortSignal.any([lifecycle, call]), dispose: () => undefined };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (lifecycle.aborted || call.aborted) {
        controller.abort();
        return { signal: controller.signal, dispose: () => undefined };
    }
    lifecycle.addEventListener("abort", abort, { once: true });
    call.addEventListener("abort", abort, { once: true });
    return {
        signal: controller.signal,
        dispose: () => {
            lifecycle.removeEventListener("abort", abort);
            call.removeEventListener("abort", abort);
        },
    };
}

/**
 * OpenCode 2 requires explicit tool-editor registration; it does not load the v1
 * tool map.
 *
 * `rustToolBackends` is what routes a tool call through the module instead of
 * writing only the host read model. Registering these tools without it in Rust
 * mode would let an agent's note or memory land in `context.db` alone, where the
 * module — the authority for both — would never see it.
 */
export async function registerTools(
    context: V2Context,
    db: Database,
    config: MagicContextPluginConfig,
    rustToolBackends?: RustToolBackends,
    isInternalChild?: (sessionId: string) => boolean,
    ensureProjectRegistered = ensureProjectRegisteredFromOpenCodeDirectory,
) {
    const compaction = isCompactionEnabled(config);
    setCtxReduceRegisteredGlobally(compaction);
    const project = {
        db,
        resolveProjectPath: (directory: string) =>
            resolveProjectIdentityForSession(directory, config.allow_home_project),
        ensureProjectRegistered,
    };
    const definitions = {
        ...(compaction
            ? createCtxReduceTools({
                  db,
                  protectedTools: config.protected_tools,
                  getProtectionWindow: (sessionID) =>
                      getProtectionWindowForSession(
                          db,
                          sessionID,
                          getObservedEpochFloor(db, sessionID),
                      ),
                  ...(rustToolBackends ? { rustToolBackends } : {}),
              })
            : {}),
        ...createCtxExpandTools({
            db,
            expandTools: config.historian?.expand_tools,
            transformMode: config.transform_mode,
        }),
        ...createCtxNoteTools({
            ...project,
            dreamerEnabled: isDreamerRunnable(config),
            smartNotesEnabled: config.smart_notes.enabled,
            ...(rustToolBackends ? { rustToolBackends } : {}),
        }),
        ...createCtxSearchTools({
            ...project,
            rerankConnectionFile: config.subc?.connection_file,
            rerankConfig: config.rerank,
            // v2 has no per-tool cwd. `context.location.directory` is the
            // session workspace and is read at execute time, then resolved
            // through the same trust-filtered loader as OpenCode 1.
            resolveStrataAsk: resolveOpenCodeStrataAsk,
        }),
        ...(config.memory.enabled
            ? {
                  ...createCtxMemoryTools({
                      ...project,
                      ...(rustToolBackends ? { rustToolBackends } : {}),
                  }),
                  ...createCtxMemoryListTools({
                      ...project,
                      ...(rustToolBackends ? { rustToolBackends } : {}),
                  }),
              }
            : {}),
    };
    const controller = new AbortController();
    await context.tool.transform?.((editor) => {
        for (const [name, definition] of Object.entries(definitions)) {
            editor.add?.({
                name,
                description: definition.description,
                input: tool.schema.toJSONSchema(tool.schema.object(definition.args)),
                options: { codemode: false },
                async execute(input, call: {
                    sessionID: string;
                    messageID: string;
                    agent: string;
                    signal?: AbortSignal;
                    progress(value: Record<string, unknown>): Promise<void>;
                }) {
                    // A stale or invented call must not bypass request-local hiding,
                    // reach a module backend, or acquire a write transaction.
                    const refusal = subagentToolRefusal(db, name, call.sessionID, isInternalChild);
                    if (refusal) return { content: refusal };
                    // Admit write tools asynchronously before their synchronous storage helpers run.
                    if (name === "ctx_memory" || name === "ctx_note" || name === "ctx_reduce")
                        await withAsyncPrivilegedWriter(db, () => undefined);
                    // Parse like OpenCode 1 does: keep unknown keys and fall back to
                    // the raw input on a type error. Each tool validates its own
                    // arguments and needs `reduced`/`summary` to recover a call whose
                    // real arguments arrived wrapped; a strict parse stripped them
                    // and threw on a wrongly typed field before the tool saw it.
                    const parsedInput = tool.schema
                        .object(definition.args)
                        .passthrough()
                        .safeParse(input);
                    const abort = mergeAbortSignals(controller.signal, call.signal);
                    try {
                        const result = await definition.execute(
                            (parsedInput.success ? parsedInput.data : input) as Parameters<
                                typeof definition.execute
                            >[0],
                            {
                                sessionID: call.sessionID,
                                messageID: call.messageID,
                                agent: call.agent,
                                directory: context.location.directory,
                                worktree: context.location.directory,
                                abort: abort.signal,
                                metadata: (value) => {
                                    void call.progress(value);
                                },
                                ask: async () => {
                                    throw new Error(
                                        "This tool requires an unavailable permission request",
                                    );
                                },
                            },
                        );
                        return { content: typeof result === "string" ? result : result.output };
                    } finally {
                        abort.dispose();
                    }
                },
            });
        }
    });
    return { dispose: () => controller.abort() };
}
