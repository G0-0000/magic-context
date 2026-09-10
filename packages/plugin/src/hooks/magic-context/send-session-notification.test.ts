import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
    __ignoredNotificationTest,
    flushIgnoredMessages,
    MAX_QUEUED_IGNORED_NOTIFICATIONS,
    sendIgnoredMessage,
} from "./send-session-notification";

const DEFAULT_TITLE = "New session - 2026-06-11T12:00:00.000Z";

describe("sendIgnoredMessage", () => {
    // Delivery-unit tests supply an idle harness; the lifecycle timeline is tested separately.
    beforeEach(() => __ignoredNotificationTest.setHoldDetector(() => false));
    afterEach(() => {
        __ignoredNotificationTest.reset();
    });

    it("returns skipped and does not post when the session never gets a real title", async () => {
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
            handler: Parameters<typeof setTimeout>[0],
            _timeout?: number,
            ...args: unknown[]
        ) => {
            if (typeof handler === "function") handler(...args);
            return 0 as never;
        }) as typeof setTimeout;

        try {
            const prompt = mock(async () => ({}));
            const get = mock(async () => ({ title: DEFAULT_TITLE }));
            const result = await sendIgnoredMessage(
                { session: { get, prompt } },
                "ses-never-titled",
                "persistent notification",
                {},
            );

            expect(result).toBe("skipped");
            expect(get).toHaveBeenCalledTimes(4);
            expect(prompt).not.toHaveBeenCalled();
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
    });

    // A titled session whose last assistant turn used a specific provider/model/
    // variant. `messages` feeds resolvePromptContext; `get` returns a real title
    // so the post is not skipped.
    function titledClientWithLastTurn() {
        const prompt = mock(async () => ({}));
        const get = mock(async () => ({ title: "Real title" }));
        const messages = mock(async () => ({
            data: [
                {
                    info: {
                        role: "assistant",
                        agent: "build",
                        providerID: "anthropic",
                        modelID: "claude-opus-4-8",
                        variant: "thinking",
                    },
                },
            ],
        }));
        return { prompt, get, messages };
    }

    function lastPromptBody(prompt: ReturnType<typeof mock>): Record<string, unknown> {
        const call = prompt.mock.calls.at(-1)?.[0] as { body?: Record<string, unknown> };
        return call?.body ?? {};
    }

    it("queues without creating a user row while the session is active", async () => {
        const session = titledClientWithLastTurn();
        const diagnostics: string[] = [];
        __ignoredNotificationTest.setHoldDetector(() => true);
        __ignoredNotificationTest.setDiagnosticObserver((message) => diagnostics.push(message));

        const result = await sendIgnoredMessage({ session }, "ses-active", "background status", {});

        expect(result).toBe("queued");
        expect(session.prompt).not.toHaveBeenCalled();
        expect(__ignoredNotificationTest.pendingTexts("ses-active")).toEqual(["background status"]);
        expect(diagnostics).toEqual([
            "ignored notification held before target checks (session active); queued",
        ]);
    });

    it("runs delivery callbacks only when a queued notice is actually sent", async () => {
        const session = titledClientWithLastTurn();
        let active = true;
        const onDelivered = mock(() => {});
        __ignoredNotificationTest.setHoldDetector(() => active);

        const result = await sendIgnoredMessage({ session }, "ses-callback", "callback status", {
            onDelivered,
        });

        expect(result).toBe("queued");
        expect(onDelivered).not.toHaveBeenCalled();

        active = false;
        await flushIgnoredMessages("ses-callback");

        expect(onDelivered).toHaveBeenCalledTimes(1);
    });

    it("flushes queued notices in order after the session becomes idle", async () => {
        const session = titledClientWithLastTurn();
        let active = true;
        __ignoredNotificationTest.setHoldDetector(() => active);

        await sendIgnoredMessage({ session }, "ses-idle-flush", "first status", {});
        await sendIgnoredMessage({ session }, "ses-idle-flush", "second status", {});
        expect(session.prompt).not.toHaveBeenCalled();

        active = false;
        await flushIgnoredMessages("ses-idle-flush");

        expect(
            session.prompt.mock.calls.map((call) => {
                const input = call[0] as { body?: { parts?: Array<{ text?: string }> } };
                return input.body?.parts?.[0]?.text;
            }),
        ).toEqual(["first status", "second status"]);
        expect(__ignoredNotificationTest.pendingTexts("ses-idle-flush")).toEqual([]);
    });

    it("keeps only the newest notices when the active queue is full", async () => {
        const session = titledClientWithLastTurn();
        __ignoredNotificationTest.setHoldDetector(() => true);

        for (let index = 0; index < MAX_QUEUED_IGNORED_NOTIFICATIONS + 3; index += 1) {
            await sendIgnoredMessage({ session }, "ses-bounded", `status ${index}`, {});
        }

        expect(__ignoredNotificationTest.pendingTexts("ses-bounded")).toEqual(
            Array.from(
                { length: MAX_QUEUED_IGNORED_NOTIFICATIONS },
                (_, index) => `status ${index + 3}`,
            ),
        );
        expect(session.prompt).not.toHaveBeenCalled();
    });

    it("pins the last assistant turn's agent+model+variant by default (mid-session)", async () => {
        const session = titledClientWithLastTurn();
        const result = await sendIgnoredMessage({ session }, "ses-titled", "historian failed", {});
        expect(result).toBe("sent");
        const body = lastPromptBody(session.prompt);
        expect(body.agent).toBe("build");
        expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
        expect(body.variant).toBe("thinking");
        expect(body.noReply).toBe(true);
    });

    it("passes noReply to promptAsync as well as prompt", async () => {
        const promptAsync = mock(async () => ({}));
        const get = mock(async () => ({ title: "Real title" }));
        const messages = mock(async () => ({
            data: [
                {
                    info: {
                        role: "assistant",
                        agent: "build",
                        providerID: "anthropic",
                        modelID: "claude-opus-4-8",
                    },
                },
            ],
        }));
        await sendIgnoredMessage(
            { session: { get, messages, promptAsync } },
            "ses-prompt-async",
            "async notification",
            {},
        );

        const input = promptAsync.mock.calls[0]?.[0] as { body?: Record<string, unknown> };
        expect(input.body?.noReply).toBe(true);
    });

    it("pins the session's last turn for an explicit command reply without supplied context", async () => {
        // Command replies must not switch the model used for the next real turn.
        const session = titledClientWithLastTurn();
        const result = await sendIgnoredMessage({ session }, "ses-titled", "command result", {});
        expect(result).toBe("sent");
        const body = lastPromptBody(session.prompt);
        expect(body.agent).toBe("build");
        expect(body.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
        expect(body.variant).toBe("thinking");
    });

    it("rolls back a notice that lands after a run starts and consumes the attempt", async () => {
        const session = titledClientWithLastTurn();
        const observedRows = new Set(["msg_notice"]);
        const diagnostics: string[] = [];
        let hold = false;
        __ignoredNotificationTest.setHoldDetector(() => hold);
        __ignoredNotificationTest.setDiagnosticObserver((message) => diagnostics.push(message));
        const deleter = mock(async (_sessionId: string, messageId: string) =>
            observedRows.delete(messageId),
        );
        __ignoredNotificationTest.setNoticeDeleter(deleter);
        session.prompt = mock(async () => {
            hold = true;
            return { info: { id: "msg_notice" } };
        });

        const result = await sendIgnoredMessage({ session }, "ses-rollback", "late status", {});

        expect(result).toBe("skipped");
        expect(observedRows.has("msg_notice")).toBe(false);
        expect(deleter).toHaveBeenCalledTimes(1);
        expect(deleter.mock.calls[0]?.[0]).toBe("ses-rollback");
        expect(deleter.mock.calls[0]?.[1]).toBe("msg_notice");
        expect(__ignoredNotificationTest.pendingTexts("ses-rollback")).toEqual([]);
        expect(diagnostics).toEqual([
            "notice rolled back (deleted row msg_notice); consumed after append",
        ]);
    });

    it("caller-supplied model/agent win over resolution", async () => {
        const session = titledClientWithLastTurn();
        await sendIgnoredMessage({ session }, "ses-titled", "explicit", {
            agent: "plan",
            providerId: "openai",
            modelId: "gpt-5.5",
            variant: "high",
        });
        const body = lastPromptBody(session.prompt);
        expect(body.agent).toBe("plan");
        expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" });
        expect(body.variant).toBe("high");
        // Fully supplied → no resolution needed.
        expect(session.messages).not.toHaveBeenCalled();
    });
});
