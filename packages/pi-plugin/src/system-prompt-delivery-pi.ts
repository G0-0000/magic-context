import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import type { LkgRequestIdentity } from "@magic-context/core/hooks/magic-context/lkg-measured-request";
import {
	acknowledgeSystemPromptDelivery,
	clearSystemPromptDelivery,
	recordHeldHeadForRequest,
	recordSystemPromptForRequest,
} from "@magic-context/core/hooks/magic-context/system-prompt-delivery";
import { BoundedSessionMap } from "@magic-context/core/shared/bounded-session-map";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";

const requests = new BoundedSessionMap<LkgRequestIdentity>(1000);

/** Pi invokes context before each provider call, including every tool-loop step.
 * before_agent_start alone cannot identify which of those calls succeeded. */
export function beginPiSystemPromptRequest(
	db: ContextDatabase,
	sessionId: string,
	modelKey: string,
): void {
	const request: LkgRequestIdentity = {
		kind: "v2",
		startedAt: Date.now(),
		previousResponseId: undefined,
		modelKey: piModelRefToCanonical(modelKey),
	};
	requests.set(sessionId, request);
	recordSystemPromptForRequest(
		sessionId,
		request,
		getOrCreateSessionMeta(db, sessionId).systemPromptHash,
		db,
	);
}

export function recordPiHeldSystemHead(
	sessionId: string,
	deferRefresh: (ownsHistory: boolean) => void,
): void {
	recordHeldHeadForRequest(sessionId, requests.get(sessionId), deferRefresh);
}

export function acknowledgePiSystemPromptResponse(
	sessionId: string,
	message: unknown,
): void {
	if (!message || typeof message !== "object") return;
	const reply = message as {
		role?: string;
		timestamp?: number;
		provider?: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
	};
	if (
		reply.role !== "assistant" ||
		!reply.provider ||
		!reply.model ||
		typeof reply.timestamp !== "number"
	)
		return;
	acknowledgeSystemPromptDelivery({
		sessionId,
		request: requests.get(sessionId),
		responseId: String(reply.timestamp),
		createdAt: reply.timestamp,
		modelKey: piModelRefToCanonical(`${reply.provider}/${reply.model}`),
		finish: reply.stopReason,
		error: reply.errorMessage,
		v2: true,
	});
}

export function clearPiSystemPromptDelivery(sessionId: string): void {
	requests.delete(sessionId);
	clearSystemPromptDelivery(sessionId);
}
