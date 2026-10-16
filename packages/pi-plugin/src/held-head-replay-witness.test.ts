import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// The normal seed aged away enough reads to hide this defect. Existing user
// protection can retain them even with the original age policy: a held pass
// must still replay the empty history head previously sent to the provider,
// rather than switching to newer summaries cached in the database.
test("held-head witness: retained reads cannot replace a held empty history head", () => {
	const root = resolve(import.meta.dir, "../../..");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		BUN_JSC_useOMGJIT: "0",
		R2_SEEDS: "8",
		R2_PASSES: "69",
	};
	delete env.OPENCODE_DB;
	const result = spawnSync(
		process.execPath,
		[
			"test",
			"--preload",
			resolve(
				import.meta.dir,
				"__fixtures__/held-head-retained-tools.preload.ts",
			),
			resolve(import.meta.dir, "issue-665-hold-review-r2.test.ts"),
			"-t",
			"Pi held driver seed 8:",
			"--timeout",
			"180000",
		],
		{ cwd: root, env, encoding: "utf8", timeout: 180000, windowsHide: true },
	);
	expect(result.stderr).toContain("Pi held driver seed 8:");
	expect(result.status, result.stdout + result.stderr).toBe(0);
}, 180000);
