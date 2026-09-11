/**
 * Pi loud fail-closed surface when storage cannot open at boot.
 *
 * Registers the minimum hooks that prevent silent native-compaction fallthrough:
 * - `session_before_compact` always cancels (MC owns compaction when enabled)
 * - `context` throws {@link FailClosedBlockingError} on every primary pass
 *
 * Periodically re-probes storage; when open succeeds, invokes `onRecovered` so
 * the full runtime can start without a process restart.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createFailClosedBlockingError,
	createFailClosedController,
	type FailClosedReason,
	isFailClosedBlockingError,
	shouldBypassFailClosedBlock,
} from "@magic-context/core/features/magic-context/fail-closed-block";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";

const PREFIX = "[magic-context][pi]";

export interface PiFailClosedSurface {
	adoptRecovered(db: ContextDatabase): Promise<boolean>;
}

export function registerPiFailClosedSurface(
	pi: ExtensionAPI,
	args: {
		reason: FailClosedReason;
		tryReopen: () => Promise<ContextDatabase | null>;
		onRecovered: (db: ContextDatabase) => void | Promise<void>;
		report?: (message: string) => void;
	},
): PiFailClosedSurface {
	const report = args.report ?? log;
	const controller = createFailClosedController();
	controller.arm(args.reason);
	let recovered = false;
	let recovering: Promise<boolean> | null = null;

	const recoverWith = (
		resolveDatabase: () => Promise<ContextDatabase | null>,
	): Promise<boolean> => {
		if (recovered) return Promise.resolve(true);
		if (recovering) return recovering;
		const attempt = (async () => {
			try {
				const db = await resolveDatabase();
				if (!db) return false;
				// Install every full-runtime handler before releasing either blocking
				// hook. Otherwise the first turn after a late open can slip through the
				// fail-closed listener before the real context listener exists.
				await args.onRecovered(db);
				recovered = true;
				controller.clear();
				report(
					`${PREFIX} storage recovered; full Magic Context runtime installed and fail-closed cleared`,
				);
				return true;
			} catch (error) {
				report(
					`${PREFIX} storage re-probe failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			}
		})();
		recovering = attempt;
		void attempt.finally(() => {
			if (recovering === attempt) recovering = null;
		});
		return attempt;
	};

	const tryRecover = (): Promise<boolean> => recoverWith(args.tryReopen);

	// Keep cancelling native compaction while MC is enabled but inoperable.
	// Pi's ExtensionRunner ignores undefined results and stops at the first truthy
	// `cancel`, so recovery can leave this listener registered without weakening
	// the full runtime listener's veto, regardless of registration order.
	pi.on("session_before_compact", async () => {
		if (recovered) return;
		log(
			`${PREFIX} session_before_compact: cancelling — magic-context fail-closed (storage unavailable)`,
		);
		return { cancel: true };
	});

	pi.on("context", async (_event, _ctx) => {
		if (recovered) return;
		try {
			await controller.enforce({
				blockingEnabled: true,
				// Pi subagent children never load this extension (env guard in
				// index.ts). No additional agent-name exemption is required here.
				exempt: shouldBypassFailClosedBlock({ isPiSubagentEnv: false }),
				tryReopen: tryRecover,
			});
		} catch (error) {
			if (isFailClosedBlockingError(error)) throw error;
			throw createFailClosedBlockingError(
				controller.getReason() ?? args.reason,
				{ cause: error },
			);
		}
		// enforce() returned without throw only when recovered mid-pass.
	});

	report(
		`${PREFIX} fail-closed blocking surface registered (${args.reason.kind}); primary turns will error until storage recovers or the build is upgraded`,
	);
	return {
		adoptRecovered: (db) => recoverWith(async () => db),
	};
}
