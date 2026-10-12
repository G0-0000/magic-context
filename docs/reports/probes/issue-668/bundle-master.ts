import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = process.env.MC668_ROOT;
if (!root?.includes("/magic-context/")) throw new Error("throwaway MC668_ROOT required");
const repo = resolve(import.meta.dir, "../../../..");
const source = execFileSync("git", ["show", "77b6ba7288a175a2cdd600fc216e0df2f35dd409:packages/pi-plugin/src/pi-context-refusal.ts"], { cwd: repo, encoding: "utf8" });
const result = await Bun.build({
  entrypoints: [join(repo, "packages/pi-plugin/src/index.ts")],
  outdir: join(root, "master-plugin"), target: "node", format: "esm", splitting: true,
  external: ["@earendil-works/pi-coding-agent", "@oh-my-pi/pi-coding-agent", "@earendil-works/pi-tui", "onnxruntime-node", "onnxruntime-web", "sharp", "node:sqlite"],
  plugins: [{ name: "base-guard", setup(build) {
    build.onLoad({ filter: /\/pi-context-refusal\.ts$/ }, () => ({ contents: source, loader: "ts" }));
  } }],
});
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
console.log(`Bun ${Bun.version}: built base guard in full extension (${result.outputs.length} artifacts)`);
