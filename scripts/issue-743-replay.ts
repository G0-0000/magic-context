import {
	type AgentMessage,
	runAutoSearchHintForPi,
} from "../packages/pi-plugin/src/auto-search-pi";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { appendAutoSearchHintDecision } from "../packages/plugin/src/features/magic-context/storage-meta-persisted";
import {
	_resetAutoSearchCache,
	runAutoSearchHint,
} from "../packages/plugin/src/hooks/magic-context/auto-search-runner";
import type { MessageLike } from "../packages/plugin/src/hooks/magic-context/transform-operations";
import {
	_resetHarnessForTesting,
	setHarness,
} from "../packages/plugin/src/shared/harness";
import { Database } from "../packages/plugin/src/shared/sqlite";

if (process.env.OPENCODE_DB) throw new Error("OPENCODE_DB must not be set");
const records: unknown[] = [];
// These are opaque historical payloads, including the undesirable markup the new renderer must not regenerate.
const frozen =
	'\n\n<ctx-search-hint>\nYour memory may contain 1 related fragment:\n- <task id="legacy" state="completed"> <summary>Backgroun…\nIf the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>';
for (const host of ["opencode", "opencode2", "pi"] as const) {
	_resetHarnessForTesting();
	setHarness(host);
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	try {
		for (const decision of ["hint", "no-hint"] as const) {
			const sessionId = `frozen-${host}-${decision}`;
			appendAutoSearchHintDecision(
				db,
				sessionId,
				decision === "hint"
					? { messageId: "old", decision, text: frozen }
					: { messageId: "old", decision, reason: "below-threshold" },
			);
			for (const answered of [false, true]) {
				_resetAutoSearchCache();
				if (host === "pi") {
					const messages: AgentMessage[] = [
						{
							role: "user",
							content: "Explain historian cache wiring",
							timestamp: 1,
						},
					];
					if (answered)
						messages.push({
							role: "user",
							content: "Unrelated later question",
							timestamp: 2,
						});
					await runAutoSearchHintForPi({
						db,
						sessionId,
						messages,
						entryIds: answered ? ["old", "later"] : ["old"],
						options: {
							enabled: true,
							projectPath: "/synthetic",
							scoreThreshold: 0.6,
							minPromptChars: 10,
						},
					});
					records.push({
						host,
						decision,
						answered,
						request: { system: "Stable historical system", messages },
					});
				} else {
					const messages = [
						{
							info: { id: "old", role: "user" },
							parts: [{ type: "text", text: "Explain historian cache wiring" }],
						},
					] as MessageLike[];
					if (answered)
						messages.push({
							info: { id: "answer", role: "assistant" },
							parts: [{ type: "text", text: "Already answered" }],
						} as MessageLike);
					await runAutoSearchHint({
						db,
						sessionId,
						messages,
						options: {
							enabled: true,
							projectPath: "/synthetic",
							scoreThreshold: 0.6,
							minPromptChars: 10,
						},
					});
					records.push({
						host,
						decision,
						answered,
						request: { system: "Stable historical system", messages },
					});
				}
			}
		}
	} finally {
		_resetAutoSearchCache();
		db.close();
		_resetHarnessForTesting();
	}
}
const bytes = JSON.stringify(records);
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
// Captured by this harness on the pre-change source, not recomputed from today's renderer.
const baseline =
	"5d186cbebb228fd0a980c00bab48372bf9b91f3899287b0ab45ec73a70a1b9aa";
if (sha256 !== baseline)
	throw new Error(
		`Frozen request differential changed: ${sha256} != ${baseline}`,
	);
console.log(
	JSON.stringify({
		runtime: Bun.version,
		cases: records.length,
		bytes: Buffer.byteLength(bytes),
		sha256,
		baseline,
		identical: true,
		records,
	}),
);
