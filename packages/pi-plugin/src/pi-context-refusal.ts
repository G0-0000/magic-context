import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { findPiTagIdentityConflict } from "@magic-context/core/features/magic-context/storage-tags";
import { log } from "@magic-context/core/shared/logger";
import { withSqliteTransformPass } from "@magic-context/core/shared/sqlite";
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

export class PiContextSupersededError extends Error {}

interface Operation {
	pass?: PiContextBudget;
	// The latest pass's context event. Its messages are read only when a late
	// agent_end must be attributed (see endBelongsToEarlierRun), never on the
	// context hook's own unguarded stack.
	input?: { readonly messages?: unknown };
	// Whether the dispatch fence has already admitted a request for the latest pass.
	dispatched: boolean;
	started: boolean;
	ready: boolean;
	refused: boolean;
	ended: boolean;
}
const receiptMaps = new Set<Map<string | object, Operation>>();
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
 * - a pass whose input holds a message the ended run never had (OMP clones
 *   messages, so role + timestamp identify them) was built for a later run.
 * A pass that was already dispatched keeps the original behaviour: the end
 * invalidates its receipt for any later request.
 */
function endBelongsToEarlierRun(operation: Operation, event: unknown): boolean {
	if (!operation.pass || operation.dispatched) return false;
	const end = event as { willContinue?: unknown; messages?: unknown };
	if (end?.willContinue === true) return true;
	let input: unknown;
	try {
		input = operation.input?.messages;
	} catch {
		return false;
	}
	if (!Array.isArray(input) || !Array.isArray(end?.messages)) return false;
	const ended = new Set<string>();
	for (const message of end.messages) {
		const key = messageKey(message);
		if (key) ended.add(key);
	}
	if (ended.size === 0) return false;
	return input.some((message) => {
		const key = messageKey(message);
		return key !== undefined && !ended.has(key);
	});
}

/**
 * Pi catches context-hook exceptions and continues with its original messages.
 * Escaping errors here are deliberate refusals: abort the operation as well as
 * logging the original error. The entry is display-only, never a model message.
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
	const lifecycleCounts = (key: string | object) => {
		let counts = lifecycle.get(key);
		if (!counts) {
			counts = { starts: 0, ends: 0 };
			lifecycle.set(key, counts);
		}
		return counts;
	};
	const fenceEnabled = resolvePiHarnessKind() === "omp";
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
			lifecycleSeen.ends++;
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
			if (options.compactionOff?.(ctx)) return;
			// Advisors inherit the payload hook, but review formatted copies of
			// new messages in their own agent. They neither consume nor grant the
			// receipt that authorizes the main conversation's managed messages.
			const payload = (event as { payload?: unknown }).payload;
			if (isOmpAdvisorRequest(payload)) return;
			const key = operationKey(ctx);
			// OMP erases the ephemeral request's attribution before this hook. Its
			// abort API is session-wide, so after seeing OMP's attributed reminder
			// and prompt in a context event we cannot safely abort any payload here.
			// Every other session still requires a completed managed context pass,
			// even when we do not recognize the provider's body format.
			if (sideSessions.get(key)?.sides) return;
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
			try {
				if (capture)
					throw new Error(
						"no context pass ran for OMP auto-learn capture; raw conversation refused",
					);
				if (!active.pass)
					throw new Error("no context pass ran for this operation");
				// Judge this operation's latest pass from operation state only. The
				// pass's own ownership guard also fails for a replaced pass; a replaced
				// pass is never read here, so it can never refuse the current turn.
				// An unfinished pass is not a receipt, and past its outcome deadline
				// it can no longer become one.
				if (
					!budget.completed &&
					(budget.abandoned || budget.elapsed() >= PI_CONTEXT_BUDGET.outcomeMs)
				)
					throw new PiContextDeadlineError(budget.diagnostic());
				// A context result completed before the preparation deadline remains
				// valid on provider retries until refusal or the end of its own run.
				if (active.ended)
					throw new Error(
						"the run that owned the latest context pass has ended; no managed result for this request",
					);
				if (
					!budget.completed ||
					!active.ready ||
					active.refused ||
					budget.abandoned
				)
					throw new Error("context pass ran without a managed context receipt");
				active.dispatched = true;
			} catch (error) {
				active.refused = true;
				budget.stage = "provider dispatch";
				refuse(ctx, budget, error, isCurrent);
			}
		});
	}
	pi.registerEntryRenderer?.<{ message: string }>(
		ENTRY_TYPE,
		(entry) => new Text(entry.data?.message ?? RETRY_MESSAGE, 0, 0),
	);
	pi.on("context", async (event, ctx) => {
		const budget = new PiContextBudget();
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
		active.input = event;
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
					"Pi context pass superseded before writer admission",
				);
		};
		try {
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
			// A newer pass owns this session now. Calling its session-wide abort
			// API from the abandoned hook would cancel the replacement turn.
			if (error instanceof PiContextSupersededError || !isCurrent()) {
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
