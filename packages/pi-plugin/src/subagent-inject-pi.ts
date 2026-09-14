/**
 * Pi transform-time task-requested memory injection.
 *
 * When a REAL user task message carries an explicit `⟦mc-mem: 11, 55, 44⟧`
 * marker, fetch those memories by ID and append their FULL content to the
 * END of that message in a `<ctx-subagent-inject>` snapshot block. This
 * complements the auto-search hint (which only nudges the agent to call
 * ctx_search): explicit naming means the parent already knows the IDs and
 * asks for deterministic, sitewise, budget-external full text — the agent
 * does not need to call any tool.
 *
 * ## Scope declarations (v1)
 *
 *  - Pi only. OpenCode is NOT implemented in v1; the shared config schema
 *    carries `memory.subagent_inject.enabled` for both harnesses but only
 *    the Pi runtime acts on it.
 *  - Normal transform path only. The compaction-off path is NOT supported
 *    in v1 (same gate as auto-search: the handler only mounts this runner
 *    when `!options.compactionOff`). PARITY §27 keeps that mode additive-only.
 *  - Not gated on `isSubagent`: Pi cannot reliably see that flag, and the
 *    primary use case (pi-subagents children running the full entry) is
 *    exactly where markers appear in ordinary user task messages.
 *
 * ## Marker contract (see the oracle audit, P1-1 / §5)
 *
 *  - Bounded single-line COARSE locator regex + strict per-token validation.
 *    The coarse regex uses a fixed character class with a hard length bound
 *    (no nested quantifiers), so pathological inputs scan in linear time and
 *    can never stall the per-turn context path (measured upstream-style
 *    catastrophic backtracking on the naive pattern: 26 ones + "x" did not
 *    finish in 1500ms; this pattern is O(n)).
 *  - Markers never span lines and never span text parts. Fenced code,
 *    inline code, blockquote lines, and already-generated
 *    `<ctx-subagent-inject>` blocks are stripped before scanning, so a
 *    marker shown literally (wrapped in backticks or a fence) does NOT
 *    trigger. Assistant/tool/synthetic messages are never scanned, and
 *    memory bodies rendered inside our own payload are never re-parsed.
 *  - Token grammar: positive safe integers, optional single leading `#`,
 *    separated by spaces, tabs, or ASCII commas. Leading zeros, `0`,
 *    negatives, decimals, exponents, unsafe integers, `11#55`, consecutive
 *    commas, trailing commas — all make THAT MARKER invalid as a whole
 *    ("no partial slicing": `⟦mc-mem: 11#55⟧` never degrades into a
 *    request for 11). Full-width punctuation and look-alike Unicode
 *    brackets are never normalized into the marker.
 *  - Message-level merge: markers are collected in appearance order across
 *    the message's text parts; IDs dedupe by first occurrence; at most
 *    MAX_TASK_MEMORY_IDS (10) IDs are processed per task — over-limit IDs
 *    are reported in the payload's unavailable note, never silently
 *    dropped, and never replace earlier missing/archived IDs.
 *
 * ## Two-layer read filter (P1-2)
 *
 *  - Access scope: the shared `createMemoryVisibilityFilter` (narrow
 *    extraction of the tool read contract — project/workspace identity,
 *    alias expansion, share categories). Unauthorized IDs produce ONE
 *    opaque "not available" note; no content, category, or project
 *    metadata ever leaks.
 *  - Injection eligibility: status must be `active` or `permanent` AND the
 *    memory must be unexpired. `memoryVisibleToTool` deliberately does not
 *    enforce status/expiry for own-project memories, so this layer is
 *    applied separately (archived/expired own memories are NOT injected).
 *    `merged`/`superseded` IDs do NOT follow to successor IDs.
 *
 * ## Persistence and byte-stable replay (P1-3, §4)
 *
 *  - Decisions live in their OWN session_meta namespace
 *    (`subagent_inject_decisions`) — never in `auto_search_hint_decisions`.
 *    CAS + first-writer-wins, same pattern as auto-search.
 *  - Keyed by session + stable SessionEntry ID (never array index or
 *    timestamp). Successful decisions persist the COMPLETE rendered wire
 *    payload and replay it verbatim; deterministic failures (invalid
 *    marker, hard-capacity refusal, zero available IDs) persist a decision
 *    too, so they are observable and never re-litigated. Transient failures
 *    (DB errors) persist NOTHING and retry next pass — a retryable fault
 *    must never masquerade as "ID not found".
 *  - Replay covers EVERY still-visible original message carrying a
 *    decision. A task A followed by a marker-less task B keeps A's
 *    snapshot on A. If the original message is compacted away the snapshot
 *    is pruned with the safe materialization GC and is NEVER migrated into
 *    m[0]/m[1] or the newest user message. Resume relies on the persisted
 *    decision, not any in-process Map (this module keeps no per-turn
 *    state).
 *  - First-read time is frozen into the decision at first decision time;
 *    later update/archive/expire of the memory does NOT refresh or retract
 *    the historical snapshot. A NEW task naming the same ID re-reads at
 *    its own first-decision time.
 *
 * ## Ordering and stacking (§4.1, §4.3)
 *
 * Auto-search runs FIRST, this injection SECOND (the context handler
 * mounts them in that order, and replay preserves it: note-nudge/auto-search
 * replay happens in `applyNoteNudges`, this module's replay runs after).
 * `<ctx-subagent-inject>` is part of auto-search's stacked-augmentation
 * detection list, so a message already carrying our block never gets a
 * fresh auto-search hint. The payload appends to the message's LAST text
 * part (or a new trailing text part), preserving image/other parts — never
 * to the first text part like the legacy helper. First-time append and
 * replay produce byte-identical results because both paths go through
 * `appendPayloadToMessage` with the persisted payload.
 *
 * ## Capacity (P1-4)
 *
 * Bypassing the 8000-token memory injection budget does NOT bypass the
 * model's hard context window. Before a fresh payload is appended we check
 * `currentInputTokens + estimateTokens(payload)` against the live sane-
 * bounded model window; if it does not fit we persist an explicit
 * `capacity-exceeded` no-inject decision, log it, and append NOTHING —
 * never a silent truncation and never a fake "必达". When no sane window
 * is known we cannot pre-check; the payload is still bounded by the same
 * per-task ID cap and row content, and the existing overflow/fail-closed
 * pipeline semantics downstream are left untouched.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { getMemoriesByIds } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { Memory } from "@magic-context/core/features/magic-context/memory/types";
import { createMemoryVisibilityFilter } from "@magic-context/core/features/magic-context/memory/visibility-filter";
import {
	appendSubagentInjectDecision,
	getSubagentInjectDecisions,
	type SubagentInjectDecision,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

export type AgentMessage = ContextEvent["messages"][number];

type UserMessage = Extract<AgentMessage, { role: "user" }>;

export interface PiSubagentInjectOptions {
	enabled: boolean;
	projectPath: string;
}

/** Message-level dedupe cap for requested memory IDs (contract constant, not configurable). */
export const MAX_TASK_MEMORY_IDS = 10;

/**
 * Hard upper bound for the coarse marker locator's inner span. 10 safe
 * integers need at most ~190 characters; anything longer can never be a
 * valid request and stays unscanned.
 */
const MARKER_INNER_MAX_CHARS = 200;

const MARKER_PREFIX = "⟦mc-mem:";
const INJECT_TAG_OPEN = "<ctx-subagent-inject>";
const INJECT_TAG_CLOSE = "</ctx-subagent-inject>";

// Coarse locator: fixed character class (no \n, no \r, no ⟧), hard length
// bound, no nested quantifiers — linear-time on any input and can never
// match across a line boundary (see module doc, P1-1).
const COARSE_MARKER_RE = /⟦mc-mem:[^\n\r⟧]{0,199}⟧/g;

// Regions that never count as marker context: fenced code blocks, inline
// code spans, blockquote lines, and blocks this module already appended.
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const BLOCKQUOTE_LINE_RE = /^[ \t]*>.*$/gm;
const PRIOR_INJECT_BLOCK_RE =
	/<ctx-subagent-inject>[\s\S]*?<\/ctx-subagent-inject>/g;

// Strict inner grammar: tokens of `#?digits` separated by space/tab runs or
// a single ASCII comma with optional padding. Trailing padding allowed;
// leading/trailing/duplicated commas rejected; `11#55` rejected. Every
// separator alternative REQUIRES its following token, so a marker is either
// fully valid or wholly abandoned — never partially sliced.
const STRICT_INNER_RE =
	/^[ \t]*#?[0-9]+(?:[ \t]+#?[0-9]+|[ \t]*,[ \t]*#?[0-9]+)*[ \t]*$/;
const TOKEN_RE = /^#?[0-9]+$/;

function escapeXmlText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Strict per-token validation. Returns null when the marker is invalid as
 * a WHOLE — invalid markers are abandoned, never partially interpreted.
 */
export function parseMarkerInner(inner: string): number[] | null {
	if (inner.length === 0 || inner.length > MARKER_INNER_MAX_CHARS) return null;
	if (!STRICT_INNER_RE.test(inner)) return null;
	const tokens = inner.split(/[ \t,]+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return null;
	const ids: number[] = [];
	for (const token of tokens) {
		if (!TOKEN_RE.test(token)) return null;
		const digits = token.startsWith("#") ? token.slice(1) : token;
		// Leading zeros ("007") are not a canonical ID spelling — reject rather
		// than silently coercing, so the marker contract stays strict.
		if (digits.length > 1 && digits.startsWith("0")) return null;
		const id = Number(digits);
		if (!Number.isSafeInteger(id) || id <= 0) return null;
		ids.push(id);
	}
	return ids;
}

/**
 * Scan ONE text part for marker requests. Parts are scanned independently:
 * a marker split across two text parts is never stitched together (§8.1).
 */
export function scanTextPartForIds(text: string): {
	ids: number[];
	sawMalformedMarker: boolean;
} {
	const stripped = text
		.replace(FENCED_CODE_RE, "")
		.replace(PRIOR_INJECT_BLOCK_RE, "")
		.replace(INLINE_CODE_RE, "")
		.replace(BLOCKQUOTE_LINE_RE, "");
	COARSE_MARKER_RE.lastIndex = 0;
	const ids: number[] = [];
	let sawMalformedMarker = false;
	while (true) {
		const match = COARSE_MARKER_RE.exec(stripped);
		if (match === null) break;
		const inner = match[0].slice(MARKER_PREFIX.length, -"⟧".length);
		const parsed = parseMarkerInner(inner);
		if (parsed === null) {
			sawMalformedMarker = true;
			continue;
		}
		for (const id of parsed) {
			if (!ids.includes(id)) ids.push(id);
		}
	}
	return { ids, sawMalformedMarker };
}

/** Injection eligibility layer: active/permanent AND unexpired. */
function isInjectableMemory(memory: Memory, now: number): boolean {
	if (memory.status !== "active" && memory.status !== "permanent") return false;
	if (memory.expiresAt !== null && memory.expiresAt <= now) return false;
	return true;
}

function collectTextParts(message: UserMessage): string[] {
	const { content } = message;
	if (typeof content === "string") return content.length > 0 ? [content] : [];
	const parts: string[] = [];
	for (const part of content) {
		if (
			part.type === "text" &&
			typeof part.text === "string" &&
			part.text.length > 0
		) {
			parts.push(part.text);
		}
	}
	return parts;
}

/**
 * Append the payload to the END of the message: the last text part when
 * content is an array (image and other parts untouched), a direct string
 * concat when content is a string, or a new trailing text part for
 * image-only messages.
 *
 * The only guard is an EXACT-payload match, which prevents a same-pass
 * double write. Idempotency is owned by the persisted decision (replay),
 * NEVER by substring-sniffing for `<ctx-subagent-inject>` — a task may
 * legitimately discuss that tag as plain text (§5.4), and treating the
 * bare open tag as "already injected" would silently drop the payload.
 */
export function appendPayloadToMessage(
	message: UserMessage,
	payload: string,
): boolean {
	if (payload.length === 0) return false;
	const existing = collectTextParts(message).join("\n");
	if (existing.includes(payload)) return false;

	if (typeof message.content === "string") {
		message.content += payload;
		return true;
	}
	let lastTextIndex = -1;
	for (let i = message.content.length - 1; i >= 0; i -= 1) {
		if (message.content[i]?.type === "text") {
			lastTextIndex = i;
			break;
		}
	}
	if (lastTextIndex >= 0) {
		const part = message.content[lastTextIndex];
		if (part?.type !== "text") return false;
		message.content[lastTextIndex] = { ...part, text: part.text + payload };
		return true;
	}
	message.content.push({ type: "text", text: payload.trimStart() });
	return true;
}

/**
 * Undo a payload that `appendPayloadToMessage` appended as the message's
 * trailing bytes (string tail or last text part tail). Used to realign the
 * wire to a contested decision's winner payload. Returns false when the
 * payload is not an exact trailing suffix (nothing is mutated then).
 */
function stripPayloadSuffix(message: UserMessage, payload: string): boolean {
	if (typeof message.content === "string") {
		if (!message.content.endsWith(payload)) return false;
		message.content = message.content.slice(0, -payload.length);
		return true;
	}
	for (let i = message.content.length - 1; i >= 0; i -= 1) {
		const part = message.content[i];
		if (part?.type === "text" && typeof part.text === "string") {
			if (!part.text.endsWith(payload)) return false;
			message.content[i] = {
				...part,
				text: part.text.slice(0, -payload.length),
			};
			return true;
		}
	}
	return false;
}

interface ResolvedUserMessage {
	index: number;
	message: UserMessage;
	messageId: string;
}

/**
 * Resolve every meaningful user message to its stable SessionEntry ID.
 * Ref-map misses are skipped (never guessed positionally — a spliced
 * positional id would anchor the snapshot to the wrong message).
 */
function resolveUserMessages(
	messages: AgentMessage[],
	entryIds: readonly (string | undefined)[],
	entryIdByRef?: ReadonlyMap<object, string> | null,
): ResolvedUserMessage[] {
	const resolved: ResolvedUserMessage[] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (msg?.role !== "user") continue;
		const userMsg = msg as UserMessage;
		if (collectTextParts(userMsg).join("").trim().length === 0) continue;
		if (entryIdByRef) {
			const byRef = entryIdByRef.get(msg as object);
			if (typeof byRef === "string") {
				resolved.push({ index: i, message: userMsg, messageId: byRef });
			}
			continue;
		}
		const messageId = entryIds[i];
		if (typeof messageId === "string") {
			resolved.push({ index: i, message: userMsg, messageId });
		}
	}
	return resolved;
}

export function buildInjectPayload(args: {
	ids: number[];
	injected: Array<{ id: number; memory: Memory }>;
	unavailableIds: number[];
	overLimitIds: number[];
	readAt: number;
}): string {
	const { ids, injected, unavailableIds, overLimitIds, readAt } = args;
	const lines: string[] = [];
	lines.push(
		`Task-requested memory snapshot (requested IDs: ${ids.join(", ")}; first read at ${new Date(readAt).toISOString()}).`,
	);
	for (const { id, memory } of injected) {
		lines.push(
			`- [ID ${id}] [${memory.category}] ${escapeXmlText(memory.content)}`,
		);
	}
	const notes: string[] = [];
	if (unavailableIds.length > 0) {
		// Opaque on purpose: missing, unauthorized, archived, and expired IDs
		// are indistinguishable here so no foreign metadata can leak (§5.3).
		notes.push(`${unavailableIds.join(", ")} (not available)`);
	}
	if (overLimitIds.length > 0) {
		notes.push(
			`${overLimitIds.join(", ")} (over the ${MAX_TASK_MEMORY_IDS}-memory per-task limit; not processed)`,
		);
	}
	if (notes.length > 0) {
		lines.push(`Unavailable: ${notes.join("; ")}.`);
	}
	return `\n\n${INJECT_TAG_OPEN}\n${lines.join("\n")}\n${INJECT_TAG_CLOSE}`;
}

/**
 * Run task-requested memory injection against the current message array.
 *
 * Replay first (byte restoration from persisted decisions for every
 * still-visible message), then at most ONE fresh first-decision — and only
 * for a marker-bearing message that is still the live array tail, so a
 * fresh append never rewrites an already-served cache prefix (same
 * discipline as auto-search).
 */
export async function runSubagentInjectForPi(args: {
	sessionId: string;
	db: Database;
	messages: AgentMessage[];
	entryIds?: readonly (string | undefined)[] | null;
	entryIdByRef?: ReadonlyMap<object, string> | null;
	options: PiSubagentInjectOptions;
	/** Per-context projection so replay reads session_meta once. */
	decisions?: readonly SubagentInjectDecision[];
	/** Live model-window accounting for the pre-submit capacity check. */
	capacity?: { contextLimit: number | undefined; currentInputTokens: number };
	/** Test hook: freeze the first-read timestamp. */
	now?: number;
}): Promise<AgentMessage[]> {
	const { sessionId, db, messages, options, entryIdByRef } = args;
	if (!options.enabled) return messages;
	const entryIds: readonly (string | undefined)[] =
		args.entryIds === undefined || args.entryIds === null
			? messages.map((message, index) => {
					const timestamp = (message as { timestamp?: unknown }).timestamp;
					return `test-entry-${index}:${typeof timestamp === "number" ? timestamp : "no-ts"}`;
				})
			: args.entryIds;

	const resolved = resolveUserMessages(messages, entryIds, entryIdByRef);
	if (resolved.length === 0) return messages;

	const existing = args.decisions ?? getSubagentInjectDecisions(db, sessionId);
	const decisionByMessageId = new Map(existing.map((d) => [d.messageId, d]));

	// --- Replay: byte restoration for every still-visible decided message. ---
	for (const { message, messageId } of resolved) {
		const decision = decisionByMessageId.get(messageId);
		if (!decision) continue;
		if (decision.decision === "inject" || decision.decision === "unavailable") {
			appendPayloadToMessage(message, decision.text);
		}
		// "no-inject" decisions persist nothing to the wire by design.
	}

	// --- Fresh first-decision: only for the live tail message. ---
	const tail = resolved[resolved.length - 1];
	if (!tail || tail.index !== messages.length - 1) return messages;
	if (decisionByMessageId.has(tail.messageId)) return messages;

	const textParts = collectTextParts(tail.message);
	if (textParts.length === 0) return messages;
	const ids: number[] = [];
	let sawMalformedMarker = false;
	for (const part of textParts) {
		const scanned = scanTextPartForIds(part);
		sawMalformedMarker = sawMalformedMarker || scanned.sawMalformedMarker;
		for (const id of scanned.ids) {
			if (!ids.includes(id)) ids.push(id);
		}
	}
	if (ids.length === 0) {
		// No marker at all: no decision, no query (§8.1). A marker that is
		// present but malformed IS a deterministic failure and is persisted
		// so it stays observable and is not re-litigated every pass.
		if (sawMalformedMarker) {
			appendSubagentInjectDecision(db, sessionId, {
				messageId: tail.messageId,
				decision: "no-inject",
				reason: "invalid-marker",
			});
			sessionLog(
				sessionId,
				"subagent-inject: marker present but invalid; abandoned",
			);
		}
		return messages;
	}

	const overLimitIds = ids.slice(MAX_TASK_MEMORY_IDS);
	const requestedIds = ids.slice(0, MAX_TASK_MEMORY_IDS);

	let memories: Memory[];
	try {
		memories = getMemoriesByIds(db, requestedIds);
	} catch (error) {
		// Transient failure — persist nothing, retry next pass; never let a
		// retryable fault masquerade as "ID not found" (§5.3).
		log(
			`[subagent-inject] memory lookup failed for session ${sessionId} (will retry next pass): ${error instanceof Error ? error.message : String(error)}`,
		);
		return messages;
	}
	const byId = new Map<number, Memory>(
		memories.map((memory) => [memory.id, memory]),
	);
	const isVisible = createMemoryVisibilityFilter(db, options.projectPath);
	const now = args.now ?? Date.now();

	const injected: Array<{ id: number; memory: Memory }> = [];
	const unavailableIds: number[] = [];
	for (const id of requestedIds) {
		const memory = byId.get(id);
		if (!memory || !isVisible(memory) || !isInjectableMemory(memory, now)) {
			unavailableIds.push(id);
			continue;
		}
		injected.push({ id, memory });
	}

	const readAt = now;
	const payload = buildInjectPayload({
		ids: requestedIds,
		injected,
		unavailableIds,
		overLimitIds,
		readAt,
	});

	// Pre-submit hard capacity check (P1-4): bypassing the memory budget
	// must not overflow the model window. Unknown/garbage window → cannot
	// check; proceed (downstream overflow protection is untouched).
	const contextLimit = args.capacity?.contextLimit;
	if (
		typeof contextLimit === "number" &&
		Number.isFinite(contextLimit) &&
		contextLimit > 0
	) {
		const current = args.capacity?.currentInputTokens ?? 0;
		if (current + estimateTokens(payload) > contextLimit) {
			appendSubagentInjectDecision(db, sessionId, {
				messageId: tail.messageId,
				decision: "no-inject",
				reason: "capacity-exceeded",
			});
			sessionLog(
				sessionId,
				`subagent-inject: payload does not fit the model context window (${current} + ~${estimateTokens(payload)} > ${contextLimit}); refusing to truncate`,
			);
			return messages;
		}
	}

	const decision: SubagentInjectDecision =
		injected.length > 0
			? {
					messageId: tail.messageId,
					decision: "inject",
					text: payload,
					ids: requestedIds,
					readAt,
				}
			: {
					messageId: tail.messageId,
					decision: "unavailable",
					text: payload,
					ids: requestedIds,
					readAt,
				};
	// Append BEFORE persisting. The exact-payload guard only prevents a
	// same-pass double write; it must never sniff for the bare open tag — a
	// task discussing `<ctx-subagent-inject>` as plain text is not "already
	// injected" (§5.4). If the append is blocked, the failure must be
	// observable and the decision must NOT be persisted, so the next pass
	// retries with fresh bytes (transient-failure semantics, §5.3).
	const appended = appendPayloadToMessage(tail.message, payload);
	if (!appended) {
		sessionLog(
			sessionId,
			`subagent-inject: WARN append blocked for ${tail.messageId} (exact payload already on the wire without a persisted decision); decision NOT persisted, retrying next pass`,
		);
		return messages;
	}
	const outcome = appendSubagentInjectDecision(db, sessionId, decision);
	if (!outcome.ok) {
		// CAS exhausted: roll the wire bytes back so a half-persisted injection
		// cannot replay differently on the next pass. Retry next pass instead.
		stripPayloadSuffix(tail.message, payload);
		sessionLog(
			sessionId,
			`subagent-inject: decision CAS failed for ${tail.messageId}; rolled back wire append, retrying next pass`,
		);
		return messages;
	}
	// First-writer-wins: under contention the COMMITTED decision's payload is
	// what replays forever. If a concurrent writer won with different bytes
	// (its own frozen readAt), realign this pass's wire to the winner so first
	// pass and replays stay byte-identical.
	if (
		(outcome.decision.decision === "inject" ||
			outcome.decision.decision === "unavailable") &&
		outcome.decision.text !== payload
	) {
		if (stripPayloadSuffix(tail.message, payload)) {
			appendPayloadToMessage(tail.message, outcome.decision.text);
		}
	}
	sessionLog(
		sessionId,
		`subagent-inject: ${outcome.decision.decision} for ${tail.messageId} (${injected.length} injected, ${unavailableIds.length} unavailable, ${overLimitIds.length} over-limit)`,
	);

	return messages;
}
