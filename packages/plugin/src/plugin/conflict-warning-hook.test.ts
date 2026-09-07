import { afterEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
    __ignoredNotificationTest,
    flushIgnoredMessages,
    observeIgnoredNotificationEvent,
} from "../hooks/magic-context/send-session-notification";
import { cleanupTestTempDir, createTestTempDir } from "../shared/test-temp-dir";
import { __conflictWarningTest, sendStartupAnnouncement } from "./conflict-warning-hook";

function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(path));
        } else if (entry.isFile() && path.endsWith(".ts")) {
            files.push(path);
        }
    }
    return files;
}

describe("conflict-warning notifications", () => {
    let temporaryRoot: string | undefined;
    const originalNoticeGate = process.env.MAGIC_CONTEXT_NOTICE_GATE;

    afterEach(() => {
        __ignoredNotificationTest.reset();
        __conflictWarningTest.reset();
        if (originalNoticeGate === undefined) delete process.env.MAGIC_CONTEXT_NOTICE_GATE;
        else process.env.MAGIC_CONTEXT_NOTICE_GATE = originalNoticeGate;
        if (temporaryRoot) cleanupTestTempDir(temporaryRoot);
        temporaryRoot = undefined;
    });

    it("holds the startup announcement while a run is in flight", async () => {
        const temp = createTestTempDir("mc-conflict-");
        temporaryRoot = temp.dir;
        const directory = join(temp.dir, "project");
        const sessionId = "ses-startup-announcement-active";
        __conflictWarningTest.setDesktopState(directory, { sessionId, sidecarUrl: null });
        process.env.MAGIC_CONTEXT_NOTICE_GATE = "hold";
        __ignoredNotificationTest.reset();

        const prompt = mock(async () => ({ data: { info: { id: "msg-startup" } } }));
        const get = mock(async () => ({ title: "Real project title" }));
        const markSeen = mock(() => {});

        await sendStartupAnnouncement(
            { session: { get, prompt } },
            directory,
            "9.9.9",
            ["A release feature"],
            "",
            markSeen,
        );

        expect(prompt).not.toHaveBeenCalled();
        expect(markSeen).not.toHaveBeenCalled();
        expect(__ignoredNotificationTest.pendingTexts(sessionId)).toEqual([
            "✨ Magic Context — what's new in v9.9.9:\n\n  • A release feature",
        ]);

        process.env.MAGIC_CONTEXT_NOTICE_GATE = "bypass";
        await flushIgnoredMessages(sessionId);
        expect(prompt).not.toHaveBeenCalled();
        observeIgnoredNotificationEvent({
            type: "session.idle",
            properties: { sessionID: sessionId },
        });
        await flushIgnoredMessages(sessionId);
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(markSeen).toHaveBeenCalledWith("9.9.9");
    });

    it("keeps direct noReply posts centralized in the guarded sender", () => {
        const sourceRoot = join(import.meta.dir, "..");
        const notificationSender = join(
            sourceRoot,
            "hooks",
            "magic-context",
            "send-session-notification.ts",
        );
        // These two assertions inspect the wire shape; runtime notification posts stay in the sender.
        const allowedSites = new Set([
            "hooks/magic-context/hook.test.ts:574",
            "hooks/magic-context/hook.test.ts:679",
        ]);
        const needle = ["noReply", "true"].join(": ");
        const violations = sourceFiles(sourceRoot)
            .filter((path) => path !== notificationSender)
            .flatMap((path) =>
                readFileSync(path, "utf8")
                    .split("\n")
                    .map((line, index) =>
                        line.includes(needle) ? `${relative(sourceRoot, path)}:${index + 1}` : null,
                    )
                    .filter((line): line is string => line !== null && !allowedSites.has(line)),
            );

        expect(violations).toEqual([]);
    });
});
