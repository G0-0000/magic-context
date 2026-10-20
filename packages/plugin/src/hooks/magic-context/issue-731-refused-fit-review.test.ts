import { expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { recordToolDefinition } from "../../features/magic-context/tool-definition-tokens";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { clearInjectionCache } from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

for (const host of ["oc1", "oc2"] as const)
    for (const subagent of [false, true])
        test(`review issue 731 ${host} ${subagent ? "subagent" : "primary"}: retry after refused signed fit must not serve the same over-window result`, async () => {
            const home = createTestTempDir("issue-731-refused-fit-review-");
            const db = openDatabase(`${home.dir}/context.db`)!;
            const sessionId = `issue-731-refused-fit-review-${host}-${subagent}`;
            const route = { providerID: "anthropic", modelID: "claude-opus-5-5" };
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, {
                cacheTtl: "never",
                lastResponseTime: Date.now(),
                systemPromptTokens: 100,
                systemPromptHash: "review-system",
                isSubagent: subagent,
            });
            recordDetectedContextLimit(db, sessionId, 16_000, "anthropic/claude-opus-5-5");
            recordToolDefinition("anthropic", route.modelID, undefined, "read", "Read", {
                type: "object",
            });
            let decision: "execute" | "defer" = "defer";
            const usage = new Map([
                [
                    sessionId,
                    {
                        usage: { percentage: 70, inputTokens: 11_200 },
                        updatedAt: Date.now(),
                        hasUsageTokens: true,
                    },
                ],
            ]);
            const deferred = new Set<string>();
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: { shouldExecute: () => decision },
                contextUsageMap: usage,
                liveModelBySession: new Map([[sessionId, route]]),
                historyRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                deferredHistoryRefreshSessions: deferred,
                lastHeuristicsTurnId: new Map(),
                directory: home.dir,
                protectedTokens: 4000,
                clearReasoningAge: 0,
                historianRunnable: false,
                injectDocs: false,
                memoryConfig: { enabled: false },
                ...(host === "oc2"
                    ? {
                          storeGeneration: "v2" as const,
                          hostCleanupCompactionMarkers: () => ({
                              verified: true,
                              removedLineages: 0,
                              removedRows: 0,
                              retainedLineages: 0,
                          }),
                      }
                    : {}),
            });
            const msg = (id: string, role: "user" | "assistant", parts: unknown[]) =>
                ({
                    info: {
                        id,
                        role,
                        sessionID: sessionId,
                        ...(role === "assistant" ? { ...route, finish: "stop" } : {}),
                    },
                    parts,
                }) as MessageLike;
            let output = "small result";
            const source = () => [
                msg("msg01", "user", [{ type: "text", text: "start" }]),
                msg("msg02", "assistant", [{ type: "text", text: "done" }]),
                msg("msg03", "user", [{ type: "text", text: "continue" }]),
                msg("msg04", "assistant", [
                    {
                        type: "reasoning",
                        text: "Covered thought",
                        metadata: { anthropic: { signature: "old-signature" } },
                    },
                ]),
                msg("msg05", "user", [{ type: "text", text: "continue work" }]),
                {
                    ...msg("msg06", "assistant", [
                        {
                            type: "reasoning",
                            text: "Active thought",
                            metadata: { anthropic: { signature: "active-signature" } },
                        },
                        {
                            type: "tool",
                            tool: "read",
                            callID: "read-call",
                            state: { status: "completed", input: {}, output },
                        },
                    ]),
                    info: { ...msg("msg06", "assistant", []).info, finish: "tool-calls" },
                },
            ];
            const compartment = (sequence: number, start: number, end: number) => ({
                sequence,
                startMessage: start,
                endMessage: end,
                startMessageId: `msg0${start}`,
                endMessageId: `msg0${end}`,
                title: "Covered",
                content: `History ${sequence}`,
            });
            try {
                appendCompartments(db, sessionId, [compartment(0, 1, 2)]);
                await transform({}, { messages: source().slice(0, 5) });
                await transform({}, { messages: source() });
                appendCompartments(db, sessionId, [compartment(1, 3, 4)]);
                deferred.add(sessionId);
                decision = "execute";
                output = "RECLAIMABLE tool result words ".repeat(30_000);
                let refused = false;
                const first = source();
                try {
                    await transform({}, { messages: first });
                } catch (error) {
                    expect(error).toMatchObject({ name: "EmergencyFailClosedError" });
                    refused = true;
                }
                // A pass can fit by deleting the result. If it refuses instead,
                // retrying unchanged input must still check it against the context limit.
                if (!refused) {
                    expect(JSON.stringify(first)).not.toContain("RECLAIMABLE tool result words");
                    return;
                }
                const retry = source();
                let retryError: unknown;
                try {
                    await transform({}, { messages: retry });
                } catch (error) {
                    retryError = error;
                }
                if (!retryError) {
                    const estimate = estimateFinalWireInputTokens({
                        messages: retry,
                        systemPromptTokens: 100,
                        ...route,
                    });
                    expect(
                        estimate.refusalTokens ?? estimate.tokens,
                        "a returned retry must actually fit",
                    ).toBeLessThanOrEqual(16_000);
                } else {
                    expect(retryError).toMatchObject({ name: "EmergencyFailClosedError" });
                }
            } finally {
                clearInjectionCache(sessionId);
                closeReadOnlySessionDb();
                closeDatabase();
                home.cleanup();
            }
        }, 30_000);
