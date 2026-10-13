import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.MC668_ROOT;
if (!root?.includes("/magic-context/")) throw new Error("throwaway MC668_ROOT required");
const digest = (path: string) => {
	if (!existsSync(path)) return undefined;
	const bytes = readFileSync(path);
	return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
const marker = "Magic Context did not prepare this request for the current turn. ";
const runs = process.argv.slice(2).map((name) => {
	const dir = join(root, name);
	const audit = JSON.parse(readFileSync(join(dir, "audit.json"), "utf8"));
	const hooks = readFileSync(join(dir, "hooks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const host = audit.find((entry: any) => entry.phase === "host");
	const wires = audit.filter((entry: any) => entry.phase === "wire");
	const markedAttempts = hooks.filter((entry: any) => entry.phase === "before_provider_request" && JSON.stringify(entry.payload).includes(marker));
	return {
		name, host,
		isolation: audit.filter((entry: any) => entry.phase === "isolation").map((entry: any) => ({
			label: entry.label, pid: entry.pid, openStoreDescriptors: entry.files.length,
			allInsideRunRoot: entry.files.every((line: string) => line.includes(host.root)),
		})),
		checks: audit.filter((entry: any) => entry.phase === "check"),
		httpCalls: Object.fromEntries(["warm", "idle-dump", "overlap", "newer", "loser", "retry", "clean"].map((scenario) => [scenario, wires.filter((entry: any) => entry.scenario === scenario).length])),
		requestText: wires.map((entry: any) => ({
			scenario: entry.scenario,
			content: JSON.stringify(entry.body.messages ?? entry.body.input).match(/(?:§\d+§ )?(?:replacement live history|live turn while diagnostic is emitted|later clean turn)/g) ?? [],
			containsMarker: JSON.stringify(entry.body).includes(marker),
		})),
		contextErrors: hooks.filter((entry: any) => entry.phase === "context-error").map((entry: any) => entry.error),
		dumpFrames: hooks.filter((entry: any) => entry.phase === "context" && entry.stack.includes("dumpLlmRequestToTmpDir")).map((entry: any) => entry.stack.split("\n").filter((line: string) => /at (?:#formatLlmRequestJson|dumpLlmRequestToTmpDir) /.test(line))),
		markedDispatchAttempts: markedAttempts.length,
		markedRetryPayloadEqual: markedAttempts.length === 2 ? JSON.stringify(markedAttempts[0].payload) === JSON.stringify(markedAttempts[1].payload) : undefined,
		marker: hooks.filter((entry: any) => entry.phase === "fallback-array").map((entry: any) => ({
			sessionUnchanged: entry.sessionUnchanged,
			text: entry.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.text?.startsWith(marker))?.text,
		})),
		idleBefore: digest(join(dir, "idle-before.json")), idleAfter: digest(join(dir, "idle-after.json")),
		overlapBefore: digest(join(dir, "overlap-before.json")), overlapAfter: digest(join(dir, "overlap-after.json")),
		sessionBeforeMarker: digest(join(dir, "session-before-marker.jsonl")),
		sessionAfterMarker: digest(join(dir, "session-after-marker.jsonl")),
		sessionAfterTurn: digest(join(dir, "session-after-turn.jsonl")),
	};
});
const output = join(root, "host-receipts.json");
writeFileSync(output, JSON.stringify({ bun: Bun.version, runs }, null, 2) + "\n");
console.log(`Bun ${Bun.version}: summarized ${runs.length} host runs to ${output}`);
