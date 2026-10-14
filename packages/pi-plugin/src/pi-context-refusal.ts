import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { findPiTagIdentityConflict } from "@magic-context/core/features/magic-context/storage-tags";
import { log } from "@magic-context/core/shared/logger";
import { withSqliteTransformPass } from "@magic-context/core/shared/sqlite";
import { isOmpDumpContext } from "./omp-diagnostic-context";
import {
	isOmpAdvisorRequest,
	isOmpSideContext,
	isOmpUnmanagedCaptureRequest,
} from "./omp-request-kind";
import {
	PI_CONTEXT_BUDGET,
	PiContextBudget,
	PiContextDeadlineError,
} from "./pi-context-budget";
import { resolvePiHarnessKind } from "./pi-harness-kind";

const ENTRY_TYPE = "magic-context-turn-refused";
const RETRY_MESSAGE =
	"Magic Context could not safely prepare this turn; send your message again.";
const MAX_UNSENDABLE_NONCES_PER_SESSION = 32;

export class PiContextSupersededError extends Error {
	constructor(
		message: string,
		readonly origin = "context ownership",
	) {
		super(message);
	}
}

interface Operation {
	pass?: PiContextBudget;
	// role:timestamp keys of the latest pass's input messages, captured before
	// its handler ran. The handler rewrites the event's message array in place
	// (synthetic history, todo and system messages OMP never holds), so only
	// this snapshot can be compared with a late agent_end's messages (see
	// endBelongsToEarlierRun). Undefined when the input could not be read.
	inputKeys?: readonly string[];
	// Whether the dispatch fence has already admitted a request for the latest pass.
	dispatched: boolean;
	started: boolean;
	ready: boolean;
	refused: boolean;
	ended: boolean;
}
const receiptMaps = new Set<Map<string | object, unknown>>();
export function clearPiContextReceipt(sessionId: string): void {
	for (const receipts of receiptMaps) receipts.delete(sessionId);
}

function operationKey(ctx: ExtensionContext): string | object {
	return (
		ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager ?? "no-session"
	);
}

function messageKey(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const { role, timestamp } = message as {
		role?: unknown;
		timestamp?: unknown;
	};
	return typeof role === "string" && typeof timestamp === "number"
		? `${role}:${timestamp}`
		: undefined;
}

/**
 * OMP sends the extension `agent_end` notification detached, after its
 * post-turn maintenance (retry backoff, compaction, session_stop hooks). The
 * next run or scheduled continuation can therefore start, run its context
 * pass, and even dispatch before the previous run's end reaches this hook.
 * The event names no operation, so an end that arrives while the latest pass
 * has not been dispatched yet is attributed from evidence:
 * - `willContinue` says the agent continues, so a not-yet-dispatched pass is
 *   the continuation's own pass (or will be replaced by it);
 * - a pass whose input, as captured before its handler ran, holds a message
 *   the ended run never had (OMP clones messages, so role + timestamp
 *   identify them) was built for a later run.
 * A pass that was already dispatched keeps the original behaviour: the end
 * invalidates its receipt for any later request.
 */
function endBelongsToEarlierRun(operation: Operation, event: unknown): boolean {
	if (!operation.pass || operation.dispatched) return false;
	const end = event as { willContinue?: unknown; messages?: unknown };
	if (end?.willContinue === true) return true;
	if (!operation.inputKeys || !Array.isArray(end?.messages)) return false;
	const ended = new Set<string>();
	for (const message of end.messages) {
		const key = messageKey(message);
		if (key) ended.add(key);
	}
	if (ended.size === 0) return false;
	return operation.inputKeys.some((key) => !ended.has(key));
}

function inputMessageKeys(event: {
	readonly messages?: unknown;
}): string[] | undefined {
	try {
		const messages = event.messages;
		if (!Array.isArray(messages)) return undefined;
		const keys: string[] = [];
		for (const message of messages) {
			const key = messageKey(message);
			if (key) keys.push(key);
		}
		return keys;
	} catch {
		// An unreadable input cannot attribute an end; the end then applies.
		return undefined;
	}
}

/**
 * Pi catches context-hook exceptions and continues with its original messages.
 * Failed preparation refuses the operation, but user cancellation ends quietly.
 * A refusal entry is display-only, never a model message.
 */
export function registerPiGuardedContext(
	pi: ExtensionAPI,
	handler: (
		event: ContextEvent,
		ctx: ExtensionContext,
		budget: PiContextBudget,
	) =>
		| Promise<{ messages: ContextEvent["messages"] } | undefined>
		| Promise<void>,
	options: {
		compactionOff?: (ctx: ExtensionContext) => boolean;
		onRefusal?: (
			ctx: ExtensionContext,
			budget: PiContextBudget,
			message: string,
			isCurrent: () => boolean,
		) => void;
	} = {},
): void {
	const operations = new Map<string | object, Operation>();
	const sideSessions = new Map<
		string | object,
		{ contexts: number; sides: number }
	>();
	receiptMaps.add(operations);
	// Keep the dispatch backstop disabled for previously observed side sessions
	// after cache eviction or reload: OMP still erases side-request attribution.
	// Only per-turn completion records are invalidated by cache cleanup.
	const newOperation = (): Operation => ({
		dispatched: false,
		started: false,
		ready: false,
		refused: false,
		ended: false,
	});
	// Lifecycle notifications seen per session. A run emits one agent_start and
	// one agent_end, so ends catching up with starts means the start of the run
	// that owns a misattributed pass has not been delivered yet.
	const lifecycle = new Map<
		string | object,
		{ starts: number; ends: number }
	>();
	// Cache eviction and session cleanup reset the counts with the receipts.
	receiptMaps.add(lifecycle);
	const lifecycleCounts = (key: string | object) => {
		let counts = lifecycle.get(key);
		if (!counts) {
			counts = { starts: 0, ends: 0 };
			lifecycle.set(key, counts);
		}
		return counts;
	};
	const fenceEnabled = resolvePiHarnessKind() === "omp";
	// When this hook throws, OMP retains its original message array rather than
	// a newer pass's prepared messages. Mark that unprepared array so it cannot
	// use the newer pass's completion record. Each session retains its newest
	// 32 nonces across successful context passes; receipt cleanup retires them too.
	const unsendableNonces = new Map<string | object, Set<string>>();
	receiptMaps.add(unsendableNonces);
	const refuse = (
		ctx: ExtensionContext,
		budget: PiContextBudget,
		reason: unknown,
		isCurrent: () => boolean,
	): void => {
		if (!isCurrent()) {
			log(
				`[magic-context][pi] DISCARDED CONTEXT RESULT ${budget.diagnostic()}`,
				reason,
			);
			return;
		}
		budget.abandoned = true;
		budget.recovery =
			budget.recovery === "not attempted"
				? "no managed result; refused"
				: budget.recovery;
		const identityConflict = findPiTagIdentityConflict(reason);
		const message = identityConflict
			? `${identityConflict.message}. ${budget.diagnostic()}`
			: `${RETRY_MESSAGE} ${budget.diagnostic()} (${reason instanceof Error ? reason.message : String(reason)})`;
		try {
			ctx.ui?.notify(message, "error");
		} catch (error) {
			log("[magic-context][pi] refusal notice failed", error);
		}
		try {
			pi.appendEntry(ENTRY_TYPE, { message });
		} catch (error) {
			log("[magic-context][pi] refusal entry failed", error);
		} finally {
			if (!budget.sideTurn) ctx.abort();
		}
		// This callback only queues a diagnostic; it must never do storage work on
		// the payload hook's synchronous dispatch stack.
		try {
			options.onRefusal?.(ctx, budget, message, isCurrent);
		} catch (error) {
			log("[magic-context][pi] refusal diagnostic failed", error);
		}
	};
	if (fenceEnabled) {
		pi.on("agent_start", (_event, ctx) => {
			const key = operationKey(ctx);
			lifecycleCounts(key).starts++;
			const pending = operations.get(key);
			// OMP forwards lifecycle events asynchronously. A preceding extension
			// can delay agent_start until this run's context pass has already finished.
			// Adopt that pass on its first start, not a receipt from an earlier run.
			const active =
				pending && !pending.started && !pending.ended
					? pending
					: newOperation();
			active.started = true;
			operations.set(key, active);
		});
		pi.on("agent_end", (event, ctx) => {
			const key = operationKey(ctx);
			const lifecycleSeen = lifecycleCounts(key);
			// An end without a delivered start (the extension loaded mid-run, or
			// the counts were reset) must not leave ends ahead of starts: every
			// later kept pass would then look unstarted and be adoptable by a
			// new run's start.
			lifecycleSeen.ends = Math.min(
				lifecycleSeen.ends + 1,
				lifecycleSeen.starts,
			);
			const counts = sideSessions.get(key);
			if (counts)
				log(
					`[magic-context][pi] OMP context counts session=${String(key)} side_contexts=${counts.sides} context_passes=${counts.contexts} dispatch_fence=${counts.sides ? "latched off" : "on"}`,
				);
			const operation = operations.get(key);
			if (operation) {
				if (endBelongsToEarlierRun(operation, event)) {
					// The pass belongs to a run whose own start may still be in flight.
					// Let that late start adopt the operation instead of erasing it.
					if (lifecycleSeen.starts <= lifecycleSeen.ends)
						operation.started = false;
					log(
						`[magic-context][pi] agent_end attributed to an earlier run; keeping the latest context pass session=${String(key)} ${operation.pass?.diagnostic() ?? ""}`,
					);
					return;
				}
				operation.ended = true;
				operation.ready = false;
			}
		});
		// OMP supplies session identity, but no provider-attempt ID. The latest
		// context pass is the receipt for this operation, including payload retries.
		// No awaits, DB access or payload hashing are allowed in this backstop.
		pi.on("before_provider_request", (event, ctx) => {
			const cancelledOperation = operations.get(operationKey(ctx));
			const signal = (ctx as { signal?: AbortSignal }).signal;
			if (signal ? signal.aborted : cancelledOperation?.pass?.isCancelled()) {
				cancelledOperation?.pass?.cancel();
				if (cancelledOperation) cancelledOperation.ready = false;
				return;
			}
			if (options.compactionOff?.(ctx)) return;
			const payload = (event as { payload?: unknown }).payload;
			const key = operationKey(ctx);
			// OMP erases the ephemeral request's attribution before this hook. Its
			// abort API is session-wide, so after seeing OMP's attributed reminder
			// and prompt in a context event we cannot safely abort any payload here.
			// Every other session still requires a completed managed context pass,
			// even when we do not recognize the provider's body format.
			if (sideSessions.get(key)?.sides) return;
			const nonces = unsendableNonces.get(key);
			// Most sessions have no superseded payloads. Do not serialize their
			// potentially multi-megabyte conversation just to inspect an empty set.
			if (nonces?.size) {
				const serializedPayload = JSON.stringify(payload);
				if (
					serializedPayload &&
					[...nonces].some((nonce) => serializedPayload.includes(nonce))
				) {
					// Preserve the replacement context pass's completion record: this
					// refusal applies only to the older, marked request.
					const budget = new PiContextBudget();
					budget.stage = "provider dispatch";
					refuse(
						ctx,
						budget,
						"superseded context fallback is not a managed request",
						() => true,
					);
					return;
				}
			}
			// OMP also invokes this send hook for advisor agents. They review separate,
			// formatted session updates rather than the main conversation, so they
			// neither need nor establish a completed main-context pass.
			if (isOmpAdvisorRequest(payload)) return;
			let operation = operations.get(key);
			if (!operation) {
				operation = newOperation();
				operations.set(key, operation);
			}
			const active = operation;
			const isCurrent = () => operations.get(key) === active;
			const capture = isOmpUnmanagedCaptureRequest(payload);
			const budget =
				(capture ? undefined : active.pass) ?? new PiContextBudget();
			let refusalOrigin: "agent_end" | undefined;
			try {
				if (capture)
					throw new Error(
						"no context pass ran for OMP auto-learn capture; raw conversation refused",
					);
				if (!active.pass)
					throw new Error("no context pass ran for this operation");
				// Judge this operation's latest pass from operation state only, not
				// through the pass's assertOwner guard. That guard reports any lost
				// ownership as a supersession, including an end it cannot attribute,
				// and turned those into visible refusals of the current turn. A pass
				// replaced by a newer one is never read here. An unfinished pass is
				// not a receipt, and past PI_CONTEXT_BUDGET.outcomeMs it can no
				// longer become one.
				if (
					!budget.completed &&
					(budget.abandoned || budget.elapsed() >= PI_CONTEXT_BUDGET.outcomeMs)
				)
					throw new PiContextDeadlineError(budget.diagnostic());
				// A context result completed before the preparation deadline remains
				// valid on provider retries until refusal or the end of its own run.
				if (active.ended) {
					refusalOrigin = "agent_end";
					throw new Error(
						"the run that owned the latest context pass has ended; no managed result for this request",
					);
				}
				if (
					!budget.completed ||
					!active.ready ||
					active.refused ||
					budget.abandoned
				)
					throw new Error("context pass ran without a managed context receipt");
				active.dispatched = true;
			} catch (error) {
				if (signal ? signal.aborted : budget.isCancelled(error)) {
					budget.cancel();
					active.ready = false;
					return;
				}
				active.refused = true;
				// Report what invalidated the prepared result and the last preparation
				// stage it reached, rather than blaming a writer lock during dispatch.
				budget.stage = refusalOrigin
					? `provider dispatch (origin=${refusalOrigin}; context stage=${budget.stage})`
					: "provider dispatch";
				refuse(ctx, budget, error, isCurrent);
			}
		});
	}
	pi.registerEntryRenderer?.<{ message: string }>(
		ENTRY_TYPE,
		(entry) => new Text(entry.data?.message ?? RETRY_MESSAGE, 0, 0),
	);
	pi.on("context", async (event, ctx) => {
		// A dump is a read-only snapshot, not a provider preparation. In particular,
		// do not allocate an operation, claim a generation, or enter SQLite here.
		if (fenceEnabled && isOmpDumpContext()) return { messages: event.messages };
		const budget = new PiContextBudget();
		// Pi's context signal is a live getter. Retain this pass's signal even
		// after the session goes idle or a replacement run starts.
		budget.signal =
			(event as { signal?: AbortSignal }).signal ??
			(ctx as { signal?: AbortSignal }).signal;
		budget.sideTurn = fenceEnabled && isOmpSideContext(event);
		const key = operationKey(ctx);
		if (fenceEnabled) {
			let counts = sideSessions.get(key);
			if (!counts) {
				counts = { contexts: 0, sides: 0 };
				sideSessions.set(key, counts);
			}
			counts.contexts++;
			if (budget.sideTurn && ++counts.sides === 1)
				log(
					`[magic-context][pi] OMP dispatch fence disabled for session ${String(key)}: verified ephemeral context; session-wide abort cannot distinguish provider operations (side_contexts=${counts.sides} context_passes=${counts.contexts})`,
				);
		}
		const owner = operations.get(key);
		let operation = operations.get(key);
		if (budget.sideTurn || !operation || operation.ended || !fenceEnabled) {
			operation = newOperation();
			if (!budget.sideTurn) operations.set(key, operation);
		}
		const active = operation;
		active.pass = budget;
		active.inputKeys = undefined;
		active.dispatched = false;
		active.ready = false;
		// A refusal aborts the run it was raised in. A later pass on the same
		// operation (its run's start or the previous end not delivered yet) is
		// new work and earns its own receipt; the refused pass stays abandoned.
		active.refused = false;
		const isOwned = () =>
			budget.sideTurn
				? operations.get(key) === owner
				: operations.get(key) === active && active.pass === budget;
		const isCurrent = () => isOwned() && (budget.sideTurn || !active.ended);
		budget.assertOwner = () => {
			if (!isCurrent())
				throw new PiContextSupersededError(
					"Pi context pass superseded: no longer valid for this operation",
					active.ended
						? "agent_end"
						: operations.get(key) !== (budget.sideTurn ? owner : active)
							? "operation replacement or cache eviction"
							: "newer context pass",
				);
			budget.signal?.throwIfAborted();
		};
		try {
			// Do not start storage work for the post-tool context hook that Pi may
			// invoke while the cancelled run is unwinding.
			budget.assertOutcome();
			// Snapshot the input before the handler rewrites it in place. Reading
			// here, not on the hook's unguarded prefix, keeps a throwing messages
			// getter on the refusal path.
			if (fenceEnabled && !budget.sideTurn)
				active.inputKeys = inputMessageKeys(event);
			// Share at most 250 ms of synchronous waiting for later turn writes,
			// including autocommit statements. Initial session-meta admission uses
			// the separate yielding writer budget shared with OpenCode.
			// Do not rerun the handler: it may already have committed earlier writes.
			// The outcome deadline covers the whole pass, including the foreground
			// reservation that withSqliteTransformPass may wait on before the handler
			// starts and any await the handler leaves unguarded. Work still running
			// at the deadline is abandoned by the refusal below, so its guards stop
			// further writes.
			const result = await budget.waitMandatory(
				Promise.resolve(
					withSqliteTransformPass(() => handler(event, ctx, budget)),
				),
			);
			if (result?.messages) {
				budget.completed = true;
				active.ready = true;
			}
			return result;
		} catch (error) {
			if (budget.isCancelled(error)) {
				budget.cancel();
				if (isOwned()) active.ready = false;
				return;
			}
			// A newer pass owns this session now. Calling its session-wide abort
			// API from the abandoned hook would cancel the replacement turn.
			if (error instanceof PiContextSupersededError || !isCurrent()) {
				if (
					fenceEnabled &&
					!budget.sideTurn &&
					!sideSessions.get(key)?.sides &&
					!options.compactionOff?.(ctx)
				) {
					const nonce = crypto.randomUUID();
					let nonces = unsendableNonces.get(key);
					if (!nonces) {
						nonces = new Set();
						unsendableNonces.set(key, nonces);
					}
					nonces.add(nonce);
					if (nonces.size > MAX_UNSENDABLE_NONCES_PER_SESSION) {
						const oldest = nonces.values().next().value;
						if (oldest !== undefined) nonces.delete(oldest);
					}
					event.messages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: `Magic Context did not prepare this request for the current turn. ${nonce}`,
							},
						],
						timestamp: Date.now(),
					});
				}
				log(
					`[magic-context][pi] DISCARDED CONTEXT RESULT ${budget.diagnostic()}`,
					error,
				);
				throw error;
			}
			log("[magic-context][pi] turn refused", error);
			// Direct handler fixtures lack the host abort API; retain their original
			// exception contract. Real Pi contexts always supply abort().
			if (typeof ctx.abort !== "function") {
				budget.abandoned = true;
				options.onRefusal?.(
					ctx,
					budget,
					error instanceof Error ? error.message : String(error),
					isOwned,
				);
				throw error;
			}
			active.refused = true;
			refuse(ctx, budget, error, isOwned);
			return { messages: event.messages };
		}
	});
}
