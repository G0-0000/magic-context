import { expect, test } from "bun:test";

async function run(command: string[], env?: Record<string, string>) {
    const child = Bun.spawn(command, { cwd: new URL("../", import.meta.url).pathname, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { output: out + err, code };
}

function value(line: string, key: string): number {
    const found = new RegExp(`(?:^| )${key}=([0-9.]+)`).exec(line);
    expect(found, `missing ${key}: ${line}`).not.toBeNull();
    return Number(found![1]);
}

test("adapter state-sync timing writes measured stages and bounded seed counts", async () => {
    const result = await run(["bun", "test", "packages/plugin/src/hooks/magic-context/module-state-sync.test.ts", "-t", "AFT warm inventory sends only boundary-owned seeds", "--timeout", "30000"], { NODE_ENV: "production", MC_STATE_SYNC_TIMING_FIXTURE: "1" });
    console.log(result.output);
    expect(result.code).toBe(0);
    const line = result.output.split("\n").find((line) => line.includes("stage=rust.state_sync_detail"));
    expect(line).toBeDefined();
    for (const key of ["collect_ms", "serialize_ms", "page_build_ms", "transport_ms", "module_ack_ms"]) expect(value(line!, key)).toBeGreaterThan(0);
    expect(value(line!, "compartments")).toBe(0);
    expect(value(line!, "tags")).toBe(282);
    expect(value(line!, "raw_reads")).toBe(1);
    expect(value(line!, "raw_messages")).toBe(770);
    expect(value(line!, "pages")).toBe(1);
}, 60000);

test("module state-sync timing writes decode staging import commit and ack", async () => {
    const result = await run(["cargo", "test", "-p", "mc-module", "--lib", "aft_sized_state_sync_timing_fixture", "--", "--nocapture"]);
    console.log(result.output);
    expect(result.code).toBe(0);
    const lines = result.output.split("\n");
    const pages = lines.filter((line) => line.startsWith("mc-state-sync-timing side=module"));
    expect(pages).toHaveLength(3);
    for (const page of pages) {
        expect(page).toContain("session=ses ");
        for (const key of ["decode_ms", "stage_page_ms", "ack_ms", "bytes"]) expect(value(page, key)).toBeGreaterThan(0);
    }
    const last = pages.find((line) => value(line, "page") === 1)!;
    expect(value(last, "assemble_series_ms")).toBeGreaterThan(0);
    expect(value(last, "import_ms")).toBeGreaterThan(0);
    expect(value(last, "tags")).toBe(148070);
    const warm = pages.find((line) => value(line, "pages") === 1)!;
    expect(value(warm, "compartments")).toBe(0);
    expect(value(warm, "tags")).toBe(282);
    expect(value(warm, "import_ms")).toBeGreaterThan(0);
    const store = lines.find((line) => line.startsWith("mc-state-sync-timing side=store"));
    expect(store).toBeDefined();
    for (const key of ["import_ms", "drop_seed_units_ms", "commit_ms"]) expect(value(store!, key)).toBeGreaterThan(0);
    expect(value(store!, "compartments")).toBe(1627);
    expect(value(store!, "tags")).toBe(148070);
}, 240000);
