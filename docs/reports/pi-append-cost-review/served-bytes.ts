import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Compare the worktree's Pi context handler with the archived master handler.
// Share runner instrumentation and synthetic append/edit/compaction inputs only;
// each runner imports runtime source from its own checkout.
const base = resolve(process.argv[2] ?? ".review-base");
const runner = "packages/pi-plugin/scripts/experiments/perf/run.ts";
const source = readFileSync(runner, "utf8");
const extra = `
  if (finalPass) {
    const extensionRewrite = structuredClone(finalPass);
    const firstUser = extensionRewrite.messages.find((m: any) => m.role === 'user') as any;
    firstUser.content = 'same ID rewritten by a later extension';
    passes.push(extensionRewrite, structuredClone(finalPass));
    const edited = structuredClone(finalPass);
    const targetIndex = edited.branchEntries.findIndex((e: any) => e.type === 'message' && e.message.role === 'user');
    const target = edited.branchEntries[targetIndex] as any;
    const targetMessageIndex = edited.messages.findIndex((m: any) => m.role === 'user');
    edited.messages.splice(targetMessageIndex, 1);
    edited.branchEntries.push({type:'context_edit',id:'review-context-edit',parentId:edited.branchEntries.at(-1)?.id,timestamp:'2026-01-01T00:00:00.000Z',targetId:target.id,replacement:null} as any);
    passes.push(edited, structuredClone(finalPass));
    const compacted = structuredClone(finalPass);
    const start = compacted.branchEntries.findIndex((e: any) => e.type === 'message' && e.id === 'synthetic-entry-013800');
    const firstKept = compacted.branchEntries[start] as any;
    compacted.branchEntries.push({type:'compaction',id:'review-compaction',parentId:compacted.branchEntries.at(-1)?.id,timestamp:'2026-01-01T00:00:00.000Z',firstKeptEntryId:firstKept.id,summary:'review compacted prefix',tokensBefore:200000,fromHook:false} as any);
    compacted.messages = buildSessionContext(compacted.branchEntries, 'review-compaction', new Map(compacted.branchEntries.map((e:any)=>[e.id,e]))).messages;
    passes.push(compacted);
  }
`;
const instrumented = source
	.replace(
		"import { execFileSync }",
		"import { buildSessionContext } from '@earendil-works/pi-coding-agent';\nimport { execFileSync }",
	)
	.replace(
		'\n\tconst scratch = join(tmpdir(), "magic-context");',
		extra + '\n\tconst scratch = join(tmpdir(), "magic-context");',
	);
assert.notEqual(instrumented, source);
const root = mkdtempSync(join(tmpdir(), "review-wire-"));
const probes = [
	resolve(runner.replace("run.ts", "review-wire-run.ts")),
	join(base, runner.replace("run.ts", "review-wire-run.ts")),
];
try {
	probes.forEach((path) => {
		writeFileSync(path, instrumented);
	});
	const points = [
		2500,
		5000,
		7500,
		10000,
		12500,
		13800,
		...Array.from({ length: 65 }, (_, i) => 13802 + i * 2),
	].join(",");
	const reports: any[] = [];
	for (const [index, probe] of probes.entries()) {
		const label = index ? "base" : "head";
		const output = join(root, `${label}.json`);
		execFileSync(
			"bun",
			[
				probe,
				"--messages",
				"13930",
				"--points",
				points,
				"--pi087",
				"--external-writes",
				"--lingering-fallback",
				"--wire-output",
				join(root, label),
				"--output",
				output,
			],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		reports.push(JSON.parse(readFileSync(output, "utf8")));
	}
	assert.equal(
		reports[0].passes.length,
		77,
		"append, rewrite, revert, context_edit and compaction passes must all run",
	);
	assert.equal(
		reports[1].passes.length,
		77,
		"the base oracle must run the same 77 passes",
	);
	for (let i = 0; i < reports[0].passes.length; i++) {
		assert.equal(
			readFileSync(join(root, `head-${i + 1}.json`), "utf8"),
			readFileSync(join(root, `base-${i + 1}.json`), "utf8"),
			`literal served JSON pass ${i + 1}`,
		);
		assert.equal(
			reports[0].passes[i].tagRowsHash,
			reports[1].passes[i].tagRowsHash,
			`behavioral tag rows pass ${i + 1}`,
		);
		assert.equal(
			reports[0].passes[i].wireHash,
			reports[1].passes[i].wireHash,
			`wire SHA256 pass ${i + 1}`,
		);
	}
	console.log(
		JSON.stringify({
			passes: reports[0].passes.length,
			literalJsonComparisons: reports[0].passes.length,
			tagRowsComparisons: reports[0].passes.length,
			appendMessages: 13930,
			extraCases: [
				"same-ID extension rewrite",
				"revert",
				"context_edit removal",
				"revert after context_edit",
				"compaction contraction",
			],
			finalAppendBytes: reports[0].passes.at(-6)?.outputBytes,
			finalAppendTags: reports[0].passes.at(-6)?.tagRows,
		}),
	);
} finally {
	probes.forEach((path) => {
		rmSync(path, { force: true });
	});
	rmSync(root, { recursive: true, force: true });
}
