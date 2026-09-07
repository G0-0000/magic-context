import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { shouldHoldIgnoredNotification } from "./read-session-db";

export interface NotificationParams {
    agent?: string;
    variant?: string;
    providerId?: string;
    modelId?: string;
    /** TUI toast lifetime in milliseconds (default: 5000). */
    toastDurationMs?: number;
    /** Runs after this notification is delivered, including after a queued flush. */
    onDelivered?: () => void;
}

export type NotificationDeliveryDisposition = "sent" | "queued" | "skipped" | "failed";

/**
 * Notifications are status lines, not user input. Keep only the newest entries
 * while a real turn is active so a long background run cannot grow memory or
 * manufacture a backlog of user rows at the next idle boundary.
 */
export const MAX_QUEUED_IGNORED_NOTIFICATIONS = 16;

interface QueuedIgnoredNotification {
    client: unknown;
    sessionId: string;
    text: string;
    params: NotificationParams;
    forcePersist: boolean;
}

const queuedIgnoredNotifications = new Map<string, QueuedIgnoredNotification[]>();
const flushingIgnoredNotifications = new Set<string>();
let midTurnDetector = (sessionId: string): boolean => shouldHoldIgnoredNotification(sessionId);
let notificationServerUrl: string | undefined;
let noticeDeleter: ((sessionId: string, messageId: string) => Promise<boolean>) | undefined;
let notificationDiagnosticObserverForTests: ((message: string) => void) | undefined;

function notificationDiagnostic(sessionId: string, message: string): void {
    notificationDiagnosticObserverForTests?.(message);
    sessionLog(sessionId, message);
}

function queueIgnoredNotification(notification: QueuedIgnoredNotification): void {
    const queued = queuedIgnoredNotifications.get(notification.sessionId) ?? [];
    queued.push(notification);
    if (queued.length > MAX_QUEUED_IGNORED_NOTIFICATIONS) {
        queued.splice(0, queued.length - MAX_QUEUED_IGNORED_NOTIFICATIONS);
        sessionLog(
            notification.sessionId,
            `ignored notification queue full; dropped oldest entries (kept newest ${MAX_QUEUED_IGNORED_NOTIFICATIONS})`,
        );
    }
    queuedIgnoredNotifications.set(notification.sessionId, queued);
}

function holdIgnoredNotification(
    notification: QueuedIgnoredNotification,
    checkpoint: "before target checks" | "during target checks" | "before append",
): void {
    queueIgnoredNotification(notification);
    notificationDiagnostic(
        notification.sessionId,
        `ignored notification held ${checkpoint} (session active); queued`,
    );
}

async function trySendTuiToast(
    sessionId: string,
    text: string,
    params: NotificationParams,
    forcePersist: boolean,
): Promise<boolean> {
    if (forcePersist) return false;

    const title = extractToastTitle(text);
    const message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    const toastVariant = inferToastVariant(text);
    const duration = params.toastDurationMs ?? 5000;
    const { isTuiConnected: checkTui } = await import("../../shared/rpc-notifications");
    if (!checkTui(sessionId)) return false;

    try {
        const { pushNotification } = await import("../../shared/rpc-notifications");
        pushNotification(
            "toast",
            {
                title,
                message,
                variant: toastVariant,
                duration,
            },
            sessionId,
        );
        return true;
    } catch {
        // RPC enqueue failed — fall through to the persisted ignored-message path.
        sessionLog(sessionId, "TUI RPC toast enqueue failed, falling back to ignored message");
        return false;
    }
}

/** Test seams for the process-local queue; production uses tracked message events with a cold-start DB fallback. */
export const __ignoredNotificationTest = {
    pendingTexts(sessionId: string): string[] {
        return (queuedIgnoredNotifications.get(sessionId) ?? []).map((item) => item.text);
    },
    reset(): void {
        queuedIgnoredNotifications.clear();
        flushingIgnoredNotifications.clear();
        midTurnDetector = (sessionId: string): boolean => shouldHoldIgnoredNotification(sessionId);
        notificationServerUrl = undefined;
        noticeDeleter = undefined;
        notificationDiagnosticObserverForTests = undefined;
    },
    setMidTurnDetector(detector: (sessionId: string) => boolean): void {
        midTurnDetector = detector;
    },
    setNoticeDeleter(deleter: (sessionId: string, messageId: string) => Promise<boolean>): void {
        noticeDeleter = deleter;
    },
    setDiagnosticObserver(observer: (message: string) => void): void {
        notificationDiagnosticObserverForTests = observer;
    },
};

/** OpenCode HTTP origin used to DELETE a notice row that lost the append race. */
export function setNotificationServerUrl(url: string | undefined): void {
    notificationServerUrl =
        typeof url === "string" && url.length > 0 ? url.replace(/\/$/, "") : undefined;
}

interface NotificationClient {
    session?: {
        prompt?: (opts: unknown) => unknown | Promise<unknown>;
        promptAsync?: (opts: unknown) => Promise<unknown>;
    };
}

function notifyDelivered(sessionId: string, params: NotificationParams): void {
    try {
        params.onDelivered?.();
    } catch (error: unknown) {
        sessionLog(sessionId, "notification delivery callback failed:", getErrorMessage(error));
    }
}

function hasNotificationSessionClient(client: unknown): client is NotificationClient {
    if (client === null || typeof client !== "object") return false;
    const candidate = client as Record<string, unknown>;
    if (candidate.session === undefined) return true;
    if (candidate.session === null || typeof candidate.session !== "object") return false;
    const session = candidate.session as Record<string, unknown>;
    return (
        (session.prompt === undefined || typeof session.prompt === "function") &&
        (session.promptAsync === undefined || typeof session.promptAsync === "function")
    );
}

/**
 * Map notification text to a TUI toast variant based on content heuristics.
 */
function inferToastVariant(text: string): "success" | "error" | "warning" | "info" {
    const lower = text.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("alert"))
        return "error";
    if (lower.includes("warning") || lower.includes("⚠")) return "warning";
    if (
        lower.includes("complete") ||
        lower.includes("success") ||
        lower.includes("✓") ||
        lower.includes("finished")
    )
        return "success";
    return "info";
}

/**
 * Extract a short title from notification text (first line or first sentence).
 */
function extractToastTitle(text: string): string {
    // Use first markdown heading if present
    const headingMatch = text.match(/^#+\s+(.+)/m);
    if (headingMatch) return headingMatch[1].trim();
    // Use first line if short enough
    const firstLine = text.split("\n")[0].trim();
    if (firstLine.length <= 80) return firstLine;
    return "Magic Context";
}

async function sendIgnoredMessageNow(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
    forcePersist: boolean,
): Promise<NotificationDeliveryDisposition> {
    // A final active-run check closes the window created by the title/context
    // lookups below. The normal caller checks before entering this function too.
    if (midTurnDetector(sessionId)) {
        holdIgnoredNotification(
            { client, sessionId, text, params, forcePersist },
            "during target checks",
        );
        return "queued";
    }

    // Title-safety guard (issue #129): an ignored message is hidden from the
    // LLM but NOT `synthetic`, so OpenCode's title gate counts it as a real
    // user message — one post into a not-yet-titled session permanently
    // suppresses that session's title generation. Only persist into sessions
    // that already have a real title (the toast path above is unaffected).
    const { waitForSafeNotificationTarget } = await import("../../shared/safe-notification-target");
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") {
        sessionLog(sessionId, "notification skipped (session not titled yet)");
        return "skipped";
    }

    // Check again immediately before constructing the prompt. This prevents an
    // active run that began during title lookup or prompt-context resolution
    // from receiving a new user row.
    if (midTurnDetector(sessionId)) {
        holdIgnoredNotification(
            { client, sessionId, text, params, forcePersist },
            "during target checks",
        );
        return "queued";
    }

    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for notification");
        return "failed";
    }
    const c = client;

    // Pin the prompt context (agent + model + variant) to the session's most
    // recent real turn. WHY: even though this is `noReply: true` (no assistant
    // turn fires now), OpenCode's createUserMessage RECORDS prompt context on
    // the appended user message, and THAT becomes the session's active
    // model/agent for the NEXT real turn. Passing nothing makes OpenCode record
    // the DEFAULT agent/model — which then switches the model on the user's
    // next turn and busts the provider prefix cache the prior turn warmed.
    // Mirrors AFT's notifications.ts (issue #62).
    //
    // Caller-supplied params win; otherwise resolve from the last assistant
    // turn. We only pin values actually resolved from real messages (never a
    // synthesized default), and resolution failures degrade to "pin nothing"
    // (today's behavior) — so a fresh/empty session is never made worse.
    let agent = params.agent || undefined;
    let variant = params.variant || undefined;
    let model =
        params.providerId && params.modelId
            ? { providerID: params.providerId, modelID: params.modelId }
            : undefined;
    if (!agent || !model || !variant) {
        try {
            const { resolvePromptContext } = await import("../../shared/prompt-context");
            const resolved = await resolvePromptContext(client, sessionId);
            if (resolved) {
                agent = agent ?? resolved.agent;
                model = model ?? resolved.model;
                variant = variant ?? resolved.variant;
            }
        } catch {
            // Resolution is best-effort; on failure fall back to whatever the
            // caller passed (possibly nothing) rather than blocking the notice.
        }
    }

    // The context lookup above can yield to a newly started run. Check directly
    // before the SDK call so the final mutation gate covers that last window too.
    if (midTurnDetector(sessionId)) {
        holdIgnoredNotification({ client, sessionId, text, params, forcePersist }, "before append");
        return "queued";
    }

    const input = {
        path: { id: sessionId },
        body: {
            // noReply prevents this status line from starting a new model loop.
            // It does not make appending during an active loop safe; the caller
            // defers while mid-turn, which is the separate safety gate.
            noReply: true,
            agent,
            model,
            variant,
            parts: [
                {
                    type: "text",
                    text,
                    ignored: true,
                },
            ],
        },
    };

    try {
        let result: unknown;
        if (typeof c.session?.prompt === "function") {
            result = await Promise.resolve(c.session.prompt(input));
        } else if (typeof c.session?.promptAsync === "function") {
            result = await c.session.promptAsync(input);
        } else {
            sessionLog(sessionId, "session prompt API unavailable for notification");
            return "failed";
        }
        const messageId = extractPromptedMessageId(result);
        if (
            await revertNoticeIfUnsafe({
                client,
                sessionId,
                text,
                params,
                forcePersist,
                messageId,
            })
        ) {
            return "queued";
        }
        notifyDelivered(sessionId, params);
        return "sent";
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send notification:", msg);
        return "failed";
    }
}

function extractPromptedMessageId(result: unknown): string | undefined {
    if (result === null || typeof result !== "object") return undefined;
    const root = result as Record<string, unknown>;
    const data =
        root.data !== null && typeof root.data === "object"
            ? (root.data as Record<string, unknown>)
            : root;
    const info =
        data.info !== null && typeof data.info === "object"
            ? (data.info as Record<string, unknown>)
            : data;
    return typeof info.id === "string" && info.id.length > 0 ? info.id : undefined;
}

function getServerAuth(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function deleteNoticeMessage(sessionId: string, messageId: string): Promise<boolean> {
    if (noticeDeleter) return noticeDeleter(sessionId, messageId);
    if (!notificationServerUrl) {
        sessionLog(sessionId, "cannot roll back notice: no server URL for session.message.delete");
        return false;
    }
    const url = `${notificationServerUrl}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;
    try {
        const auth = getServerAuth();
        const response = await fetch(url, {
            method: "DELETE",
            headers: auth ? { Authorization: auth } : {},
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            sessionLog(
                sessionId,
                `notice rollback DELETE failed status=${response.status} url=${url}`,
            );
            return false;
        }
        return true;
    } catch (error: unknown) {
        sessionLog(sessionId, "notice rollback DELETE error:", getErrorMessage(error));
        return false;
    }
}

async function revertNoticeIfUnsafe(notification: {
    client: unknown;
    sessionId: string;
    text: string;
    params: NotificationParams;
    forcePersist: boolean;
    messageId: string | undefined;
}): Promise<boolean> {
    // Re-read the hold predicate after the write. If a run started or an
    // unanswered real user prompt exists, our row must not remain the newest
    // user message: OpenCode's loop-exit check uses MessageV2.latest without
    // filtering ignored/noReply rows. Prefer a lost notice over a phantom turn.
    if (!midTurnDetector(notification.sessionId)) return false;
    if (notification.messageId) {
        const deleted = await deleteNoticeMessage(notification.sessionId, notification.messageId);
        if (deleted) {
            notificationDiagnostic(
                notification.sessionId,
                `notice rolled back (deleted row ${notification.messageId}); queued for idle delivery`,
            );
        } else {
            sessionLog(
                notification.sessionId,
                "failed to roll back a notice that landed while a run was active",
            );
        }
    } else {
        sessionLog(
            notification.sessionId,
            "notice landed while a run was active but the new row id was not returned",
        );
    }
    queueIgnoredNotification({
        client: notification.client,
        sessionId: notification.sessionId,
        text: notification.text,
        params: notification.params,
        forcePersist: notification.forcePersist,
    });
    return true;
}

export async function sendIgnoredMessage(
    client: unknown,
    sessionId: string,
    text: string,
    params: NotificationParams,
    // When true, always persist as an ignored message instead of using the TUI
    // toast path, so the content remains in scrollback. Use this for outcomes of
    // long-running background work, such as a session-upgrade result, when a
    // transient five-second toast may be missed.
    forcePersist = false,
): Promise<NotificationDeliveryDisposition> {
    // TUI notifications are already out-of-band and do not create a user row.
    if (await trySendTuiToast(sessionId, text, params, forcePersist)) {
        notifyDelivered(sessionId, params);
        return "sent";
    }

    // OpenCode's MessageV2.latest is role-based and treats an ignored-only user
    // row as the latest user turn. Do not create that invisible chronology entry
    // while a run is in flight or an unanswered real prompt exists.
    if (midTurnDetector(sessionId)) {
        holdIgnoredNotification(
            { client, sessionId, text, params, forcePersist },
            "before target checks",
        );
        return "queued";
    }

    return sendIgnoredMessageNow(client, sessionId, text, params, forcePersist);
}

/**
 * Flush queued status lines after an event that may have made the session idle.
 * The event hook and tool.execute.after both call this; the same DB-backed gate
 * remains authoritative, so a non-idle event is harmless.
 */
export async function flushIgnoredMessages(sessionId: string): Promise<void> {
    if (flushingIgnoredNotifications.has(sessionId) || midTurnDetector(sessionId)) return;
    const queued = queuedIgnoredNotifications.get(sessionId);
    if (!queued || queued.length === 0) return;

    queuedIgnoredNotifications.delete(sessionId);
    flushingIgnoredNotifications.add(sessionId);
    try {
        for (const notification of queued) {
            const disposition = await sendIgnoredMessage(
                notification.client,
                notification.sessionId,
                notification.text,
                notification.params,
                notification.forcePersist,
            );
            if (disposition === "queued") {
                // The current item is already re-queued by sendIgnoredMessage.
                // Preserve the remaining entries behind it in their original order.
                for (const remaining of queued.slice(queued.indexOf(notification) + 1)) {
                    queueIgnoredNotification(remaining);
                }
                break;
            }
        }
    } finally {
        flushingIgnoredNotifications.delete(sessionId);
    }
}

export function clearIgnoredMessages(sessionId: string): void {
    queuedIgnoredNotifications.delete(sessionId);
    flushingIgnoredNotifications.delete(sessionId);
}

/**
 * Send a real user prompt that will be processed by the model (not ignored).
 * Used by /ctx-aug to inject the augmented prompt after sidekick completes.
 */
export async function sendUserPrompt(
    client: unknown,
    sessionId: string,
    text: string,
): Promise<void> {
    if (!hasNotificationSessionClient(client)) {
        sessionLog(sessionId, "session prompt API unavailable for user prompt");
        return;
    }
    const c = client as NotificationClient;

    const input = {
        path: { id: sessionId },
        body: {
            parts: [{ type: "text", text }],
        },
    };

    try {
        if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(input);
        } else if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(input));
        } else {
            sessionLog(sessionId, "session prompt API unavailable for user prompt");
        }
    } catch (error: unknown) {
        const msg = getErrorMessage(error);
        sessionLog(sessionId, "failed to send user prompt:", msg);
    }
}
