import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { failedRequiredJobs } from "./check-ci-results";

const root = resolve(import.meta.dir, "../../..");
const text = await Bun.file(resolve(root, ".github/workflows/ci.yml")).text();
type Step = { name?: string; run?: string; if?: string; uses?: string };
type Job = { name: string; needs?: string[]; if?: string; steps: Step[]; strategy?: { "fail-fast": boolean; matrix: { shard: number[] } } };
const workflow = Bun.YAML.parse(text) as { jobs: Record<string, Job> };

test("summary requires every job and always runs", () => {
    const summary = workflow.jobs["ci-summary"]!;
    expect(summary.name).toBe("CI (required)");
    expect(summary.if).toBe("${{ always() }}");
    expect([...summary.needs!].sort()).toEqual(Object.keys(workflow.jobs).filter((job) => job !== "ci-summary").sort());
});

test("summary rejects failed, cancelled, skipped and missing legs", () => {
    const required = ["first", "second"];
    expect(failedRequiredJobs(required, { first: { result: "success" }, second: { result: "success" } })).toEqual([]);
    for (const result of ["failure", "cancelled", "skipped", "", undefined]) {
        expect(failedRequiredJobs(required, { first: { result: "success" }, second: { result } })).toEqual(["second"]);
    }
    expect(failedRequiredJobs(required, { first: { result: "success" } })).toEqual(["second"]);
    expect(() => failedRequiredJobs([], {})).toThrow();
});

test("Docker and host lanes depend only on preflight, never on unit suites", () => {
    for (const id of ["e2e-opencode", "e2e-opencode2", "e2e-pi", "e2e-omp", "e2e-host-opencode", "e2e-host-opencode2", "e2e-host-pi", "e2e-host-omp"]) {
        expect(workflow.jobs[id]!.needs).toEqual(["preflight"]);
    }
    expect(workflow.jobs["e2e-host-opencode"]!.strategy).toEqual({ "fail-fast": false, matrix: { shard: [0, 1, 2, 3] } });
    expect(workflow.jobs["e2e-host-opencode2"]!.strategy).toEqual({ "fail-fast": false, matrix: { shard: [0, 1] } });
});

test("cache oracle and separate OC2 regressions run exactly once even after a suite failure", () => {
    const oracle = workflow.jobs["e2e-host-opencode"]!.steps.filter((step) => step.run?.includes("src/cache-analysis.test.ts"));
    expect(oracle).toHaveLength(1);
    expect(oracle[0]!.if).toContain("matrix.shard == 0");
    expect(oracle[0]!.if).toContain("!cancelled()");
    const regressions = workflow.jobs["e2e-host-opencode2"]!.steps.filter((step) => step.run?.includes("store-generation-conversion.test.ts"));
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.run).toContain("marker-s3-runtime.test.ts || status=1");
    expect(regressions[0]!.if).toContain("matrix.shard == 0");
    expect(regressions[0]!.if).toContain("!cancelled()");
});

test("Rust archive consumers preserve all lib partitions and remaining target kinds", () => {
    const lib = workflow.jobs["rust-mc-module-lib"]!;
    expect(lib.strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
    for (const id of ["rust-mc-module-lib", "rust-mc-module-parity"]) {
        expect(workflow.jobs[id]!.needs).toEqual(["preflight", "rust-lib-archive"]);
        expect(workflow.jobs[id]!.steps.some((step) => step.run?.includes("--archive-file ci-rust-lib/archive.tar.zst"))).toBe(true);
    }
    const commands = workflow.jobs["rust-mc-module-integration"]!.steps.map((step) => step.run ?? "").join("\n");
    expect(commands).toContain("--test '*' --bins --no-fail-fast");
    expect(commands).toContain("--doc --no-fail-fast");
    for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
            for (const line of (step.run ?? "").split("\n")) {
                if (/cargo test/.test(line) && !/--list/.test(line)) expect(line).toContain("--no-fail-fast");
            }
        }
    }
});
