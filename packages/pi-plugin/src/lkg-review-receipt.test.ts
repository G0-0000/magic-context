import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

// This witness records the unsafe behavior rather than asserting that it is safe.
// An explicit exit skips beforeExit, just as a crash loses queued diagnostics.
test("review witness: a lost busy receipt authorizes stale Pi restart bytes", () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-review-receipt-"));
	const common = `
import { createFakePi, createTestDb, fakeContext, userMessage, assistantMessage } from ${JSON.stringify(join(import.meta.dir, "test-utils.test.ts"))};
import { registerPiContextHandler } from ${JSON.stringify(join(import.meta.dir, "context-handler.ts"))};
import { capturePiServedArray, flushPiServedArrayLedger, piLastServedMatchesLkg } from ${JSON.stringify(join(import.meta.dir, "served-array-ledger.ts"))};
import { getSlot } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/hooks/magic-context/lkg-slot.ts"))};
import { updateSessionMeta } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/features/magic-context/storage.ts"))};
import { Database } from ${JSON.stringify(join(import.meta.dir, "../../plugin/src/shared/sqlite.ts"))};
const dir = ${JSON.stringify(dir)};
const sessionId = 'review-lost-receipt';
const db = createTestDb(dir + '/context.db');
db.exec('PRAGMA busy_timeout=0');
const fake = createFakePi();
Object.assign(fake.pi, { getAllTools: () => [] });
registerPiContextHandler(fake.pi, { db });
const handler = fake.handlers.get('context');
const head = [userMessage('head', 1)];
const raw = [...head, assistantMessage('already served raw', 2)];
const pass = (messages, ids) => handler({ messages: structuredClone(messages) }, {
 ...fakeContext(sessionId, dir, ids, messages),
 getSystemPrompt: () => 'Complete system.',
 model: { provider: 'openai-codex', id: 'gpt-5.6-sol', contextWindow: 272000, maxTokens: 68000 }
});
`;
	const run = (code: string) => {
		const result = spawnSync(process.execPath, ["--eval", common + code], {
			env: { ...process.env, XDG_DATA_HOME: dir, BUN_JSC_useOMGJIT: "0" },
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.error) throw result.error;
		expect(result.status).toBe(0);
		const line = result.stdout
			.split("\n")
			.find((item) => item.startsWith("WITNESS "));
		if (!line) throw new Error(`${result.stdout}\n${result.stderr}`);
		return JSON.parse(line.slice(8)) as {
			messages: unknown[];
			trusted?: boolean;
			prefix?: string;
		};
	};
	try {
		const busy = run(`
updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
await pass(head, ['head']);
await new Promise(resolve => setImmediate(resolve));
flushPiServedArrayLedger();
const locker = new Database(dir + '/context.db');
locker.exec('BEGIN IMMEDIATE');
const result = await pass(raw, ['head', 'tail']);
console.log('WITNESS ' + JSON.stringify({ messages: result.messages }));
process.exit(0);
`);
		expect(JSON.stringify(busy.messages.at(-1))).toContain(
			'"text":"already served raw"',
		);
		const restarted = run(`
const slot = getSlot(sessionId);
const trusted = piLastServedMatchesLkg(sessionId, slot.jsonPrefix);
const result = await pass(raw, ['head', 'tail']);
console.log('WITNESS ' + JSON.stringify({ trusted, prefix: slot.jsonPrefix, messages: result.messages }));
process.exit(0);
`);
		expect(restarted.trusted).toBe(true);
		expect(restarted.prefix).not.toContain("already served raw");
		expect(JSON.stringify(restarted.messages)).not.toBe(
			JSON.stringify(busy.messages),
		);
		expect(JSON.stringify(restarted.messages.at(-1))).toMatch(
			/§\d+§ already served raw/,
		);
		console.log(
			"REVIEW_LOST_RECEIPT: stale digest trusted; already-sent tail gained a tag after process restart",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 90_000);
