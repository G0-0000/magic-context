import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = (path: string) =>
	JSON.stringify(join(import.meta.dir, path));

for (const point of [
	"before-dirty",
	"temp-synced",
	"dirty",
	"returned",
	"committed",
] as const) {
	test.skipIf(process.platform === "win32")(
		`independent SIGKILL Pi recovery boundary: ${point}`,
		() => {
			const root = mkdtempSync(join(tmpdir(), "mc-sigkill-review-"));
			const common = `
import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createFakePi, createTestDb, fakeContext, userMessage, assistantMessage } from ${modulePath("test-utils.test.ts")};
import { registerPiContextHandler } from ${modulePath("context-handler.ts")};
import { __test as fence, hasCleanLkgRecoveryFence, lkgRecoveryFencePath } from ${modulePath("../../plugin/src/hooks/magic-context/lkg-recovery-fence.ts")};
import { getSlot } from ${modulePath("../../plugin/src/hooks/magic-context/lkg-slot.ts")};
import { updateSessionMeta } from ${modulePath("../../plugin/src/features/magic-context/storage.ts")};
import { Database } from ${modulePath("../../plugin/src/shared/sqlite.ts")};
const root = ${JSON.stringify(root)};
const id = 'independent-killed-pi';
const db = createTestDb(root + '/context.db');
db.exec('PRAGMA busy_timeout=0');
const fake = createFakePi();
Object.assign(fake.pi, {getAllTools: () => []});
registerPiContextHandler(fake.pi, {db, protectedTags:0, injection:{injectionBudgetTokens:10000}, scheduler:{executeThresholdPercentage:80}});
const raw = [userMessage('old head', 1), assistantMessage('new raw tail that the model saw', 2)];
const pass = (messages) => fake.handlers.get('context')({messages: structuredClone(messages)}, {
 ...fakeContext(id, root, messages.map((_, i) => 'entry-' + i), messages),
 getSystemPrompt: () => 'Fixed system.',
 model: {provider:'openai-codex', id:'gpt-5.6-sol', contextWindow:272000, maxTokens:68000}
});
const kill = () => process.kill(process.pid, 'SIGKILL');
const isolate = () => {
 const files = spawnSync('lsof',['-p',String(process.pid),'-Fn'],{encoding:'utf8'});
 if(files.status !== 0 || /\\/(?:\\.local\\/share\\/opencode|\\.local\\/share\\/cortexkit\\/magic-context|\\.config\\/(?:opencode|cortexkit))\\//.test(files.stdout)) throw new Error('Live-store isolation not proved');
 console.log('SIGKILL_LSOF pid=' + process.pid + ' forbidden=0');
};
`;
			const run = (code: string) =>
				spawnSync(process.execPath, ["--eval", common + code], {
					env: {
						...process.env,
						OPENCODE_DB: undefined,
						MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
						MAGIC_CONTEXT_TEST_DATA_DIR: root,
						XDG_DATA_HOME: root,
						XDG_CONFIG_HOME: root,
						BUN_JSC_useOMGJIT: "0",
					},
					encoding: "utf8",
					timeout: 30000,
					windowsHide: true,
				});
			try {
				const killed = run(`
updateSessionMeta(db, id, {piStableIdScheme:1});
await pass(raw.slice(0,1));
await new Promise(resolve => setImmediate(resolve));
isolate();
updateSessionMeta(db, id, {lastResponseTime:Date.now(), cacheTtl:'59m', lastContextPercentage:4, lastInputTokens:4000, systemPromptHash:'before-fold'});
${point === "before-dirty" ? "fence.setIoObserver(op => { if(op === 'mutex') kill(); });" : ""}
${point === "temp-synced" || point === "dirty" ? `fence.setObserver(phase => {console.log('PHASE ' + phase); if(phase === ${JSON.stringify(point)}) kill();});` : ""}
const locker = new Database(root + '/context.db');
locker.exec('BEGIN IMMEDIATE');
const result = await pass(raw);
writeFileSync(root + '/model-saw.json', JSON.stringify(result.messages));
console.log('BEFORE_FOLD ' + readFileSync(lkgRecoveryFencePath(id),'utf8'));
${point === "returned" ? "kill();" : ""}
locker.exec('ROLLBACK');
${point === "committed" ? `fence.setObserver(phase => {console.log('PHASE ' + phase); if(phase === ${JSON.stringify(point)}) kill();});` : ""}
updateSessionMeta(db, id, {systemPromptHash:'force healthy fold'});
await pass([...raw, userMessage('next user',3)]);
await new Promise(resolve => setImmediate(resolve));
throw new Error('Did not reach selected kill boundary');
`);
				expect(killed.signal, killed.stdout + killed.stderr).toBe("SIGKILL");
				const sawTail = existsSync(join(root, "model-saw.json"));
				expect(sawTail).toBe(["returned", "committed"].includes(point));
				if (sawTail)
					expect(readFileSync(join(root, "model-saw.json"), "utf8")).toContain(
						'"text":"new raw tail that the model saw"',
					);
				const restart = run(`
const slot = getSlot(id);
isolate();
const trusted = hasCleanLkgRecoveryFence(id, slot);
const locker = new Database(root + '/context.db');
locker.exec('BEGIN IMMEDIATE');
let result; let refused = false;
try { result = await pass([...raw,userMessage('next user',3)]); } catch { refused = true; }
console.log('RESTART ' + JSON.stringify({trusted, refused, saved: slot?.jsonPrefix, result}));
`);
				expect(restart.status, restart.stderr).toBe(0);
				const line = restart.stdout
					.split("\n")
					.find((line) => line.startsWith("RESTART "));
				if (!line) throw new Error(restart.stdout + restart.stderr);
				const proof = JSON.parse(line.slice(8));
				const shouldTrust =
					point === "before-dirty" ||
					point === "temp-synced" ||
					point === "committed";
				expect(proof.trusted, killed.stdout + JSON.stringify(proof)).toBe(
					shouldTrust,
				);
				expect(proof.refused).toBe(!shouldTrust);
				if (point === "committed")
					expect(proof.saved).toContain("§2§ new raw tail that the model saw");
				console.log(
					`SIGKILL_PROOF point=${point} signal=${killed.signal} modelSawTail=${sawTail} restartTrusted=${proof.trusted} refused=${proof.refused}`,
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		90000,
	);
}
