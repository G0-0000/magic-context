#!/usr/bin/env bun
// Build the pre-fix and master dispatch guards for real-host comparisons,
// without changing the plugin's production source.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const output = join(repo, ".cache/issue-663");
const piSource = join(repo, "packages/pi-plugin/src");
mkdirSync(output, { recursive: true });
for (const [name, revision] of [["baseline", "e720b700^"], ["master", "e720b700"]]) {
	const source = execFileSync("git", ["show", `${revision}:packages/pi-plugin/src/pi-context-refusal.ts`], { cwd: repo, encoding: "utf8" })
		.replaceAll('from "./', `from "${piSource}/`)
		.replaceAll('from "@magic-context/core/', `from "${join(repo, "packages/plugin/src")}/`)
		.replace('from "@earendil-works/pi-tui"', `from "${join(repo, "packages/pi-plugin/node_modules/@earendil-works/pi-tui/dist/index.js")}"`);
	const fence = join(output, `refusal-${name}.ts`);
	writeFileSync(fence, source);
	const guard = readFileSync(join(import.meta.dir, "guard.ts"), "utf8")
		.replace('"../../../../packages/pi-plugin/src/pi-context-refusal"', JSON.stringify(fence))
		.replaceAll("../../../../packages/pi-plugin/src/", `${piSource}/`);
	const entry = join(output, `guard-${name}.ts`);
	writeFileSync(entry, guard);
	execFileSync(process.execPath, ["build", entry, "--outfile", join(output, `guard-${name}.mjs`), "--target", "node"], { cwd: repo, stdio: "inherit" });
}
console.log(`Bun ${Bun.version}: built 2 historical dispatch fences`);
