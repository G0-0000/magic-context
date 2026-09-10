import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { clearTrackedOpenCodeSession, observeOpenCodeTurnEvent } from "./read-session-db";
import {
    __ignoredNotificationTest,
    flushIgnoredMessages,
    observeIgnoredNotificationEvent,
    sendIgnoredMessage,
    setNotificationServerUrl,
} from "./send-session-notification";

const sessionId = "ses-sugaroverdose-timeline";
afterEach(() => {
    __ignoredNotificationTest.reset();
    clearTrackedOpenCodeSession(sessionId);
});

it("holds Sugaroverdose's 16:52 notices after finish=stop until session.idle, discards on activity and deduplicates", async () => {
    const prompt = mock(async () => ({ info: { id: "notice" } }));
    const client = { session: { prompt, get: async () => ({ title: "Real title" }) } };
    const params = { agent: "build", variant: "default", providerId: "local", modelId: "27B" };
    const event = (type: string, properties: Record<string, unknown>) =>
        observeIgnoredNotificationEvent({ type, properties });
    observeOpenCodeTurnEvent("message.updated", {
        info: {
            id: "real-user",
            sessionID: sessionId,
            role: "user",
            time: { created: Date.parse("2026-09-07T16:47:35Z") },
        },
    });
    const assistant = {
        id: "assistant",
        parentID: "real-user",
        sessionID: sessionId,
        role: "assistant",
        finish: "stop",
        time: {
            created: Date.parse("2026-09-07T16:47:42Z"),
            completed: Date.parse("2026-09-07T16:51:23Z"),
        },
    };
    // The requested task ends at 16:51:23, but finish=stop is not run-loop exit.
    observeOpenCodeTurnEvent("message.updated", { info: assistant });
    event("message.updated", { info: assistant });
    for (const time of ["16:52:01", "16:52:41", "16:53:00"]) {
        expect(
            await sendIgnoredMessage(client, sessionId, `⏳ Context at 95% — ${time}`, params),
        ).toBe("queued");
        await flushIgnoredMessages(sessionId);
    }
    expect(prompt).toHaveBeenCalledTimes(0);
    // Activity before idle invalidates the pending status rather than replaying it later.
    event("session.status", { sessionID: sessionId, status: { type: "busy" } });
    event("session.idle", { sessionID: sessionId });
    await flushIgnoredMessages(sessionId);
    expect(prompt).toHaveBeenCalledTimes(0);
    expect(await sendIgnoredMessage(client, sessionId, "Compaction complete", params)).toBe("sent");
    expect(await sendIgnoredMessage(client, sessionId, "Compaction complete", params)).toBe("sent");
    expect(prompt).toHaveBeenCalledTimes(1);
    // The next real prompt begins a new run, revoking idle authorization.
    observeOpenCodeTurnEvent("message.updated", {
        info: {
            id: "next-real-user",
            sessionID: sessionId,
            role: "user",
            time: { created: Date.parse("2026-09-07T17:02:08Z") },
        },
    });
    event("session.status", { sessionID: sessionId, status: { type: "busy" } });
    expect(await sendIgnoredMessage(client, sessionId, "Next status", params)).toBe("queued");
    expect(prompt).toHaveBeenCalledTimes(1);
});

it("discards a notice whose idle authorization expires during target lookup even if idle returns", async () => {
    const prompt = mock(async () => ({}));
    const assistant = {
        id: "done",
        sessionID: sessionId,
        role: "assistant",
        finish: "stop",
        time: { created: 1 },
    };
    observeOpenCodeTurnEvent("message.updated", { info: assistant });
    observeIgnoredNotificationEvent({ type: "session.idle", properties: { sessionID: sessionId } });
    const client = {
        session: {
            prompt,
            get: async () => {
                observeIgnoredNotificationEvent({
                    type: "session.status",
                    properties: { sessionID: sessionId, status: { type: "busy" } },
                });
                observeIgnoredNotificationEvent({
                    type: "session.idle",
                    properties: { sessionID: sessionId },
                });
                return { title: "Real title" };
            },
        },
    };
    expect(
        await sendIgnoredMessage(client, sessionId, "Stale status", {
            agent: "build",
            variant: "high",
            providerId: "local",
            modelId: "27B",
        }),
    ).toBe("skipped");
    await flushIgnoredMessages(sessionId);
    expect(prompt).not.toHaveBeenCalled();
    expect(__ignoredNotificationTest.pendingTexts(sessionId)).toEqual([]);
});

it("consumes a held notice after append starts a run and rollback returns 409 without retrying", async () => {
    let active = true;
    const rows: Array<{ id: string; role: string; parentID?: string }> = [];
    const prompt = mock(async () => {
        const id = `notice-${rows.length}`;
        rows.push({ id, role: "user" });
        rows.push({ id: `assistant-${id}`, role: "assistant", parentID: id });
        active = true;
        return { info: { id } };
    });
    const client = { session: { prompt, get: async () => ({ title: "Real title" }) } };
    __ignoredNotificationTest.setHoldDetector(() => active);
    setNotificationServerUrl("http://localhost:12345");
    const remove = spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response("Active run parent", { status: 409 }),
    );
    try {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Embedded 7 compartments of history for semantic search.",
            {
                agent: "build",
                variant: "default",
                providerId: "local",
                modelId: "27B",
            },
        );
        expect(prompt).not.toHaveBeenCalled();
        for (let cycle = 0; cycle < 14; cycle++) {
            active = false;
            await flushIgnoredMessages(sessionId);
        }
        expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove.mock.calls[0]?.[1]?.method).toBe("DELETE");
        expect(__ignoredNotificationTest.pendingTexts(sessionId)).toEqual([]);
    } finally {
        remove.mockRestore();
    }
});
