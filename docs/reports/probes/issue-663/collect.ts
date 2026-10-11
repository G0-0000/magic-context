#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const evidence = join(repo, "local-ignore/issue-663/host");
const names = [
  "main-baseline", "late-start-baseline", "advisor-baseline", "capture-baseline",
  "advisor-responses-baseline", "capture-responses-baseline",
  "main-fixed", "late-start-fixed", "skip-fixed", "no-result-fixed", "advisor-fixed", "capture-fixed",
  "retry-fixed", "side-fixed", "steer-fixed", "task-fixed", "title-fixed", "compact-fixed",
  "advisor-responses-fixed", "capture-responses-fixed", "main-responses-fixed", "late-start-responses-fixed", "skip-responses-fixed",
  "main-plugin-fixed", "late-start-plugin-fixed", "advisor-plugin-fixed", "capture-plugin-fixed", "task-plugin-fixed",
  "advisor-plugin-responses-fixed", "capture-plugin-responses-fixed",
];
const runs = names.map(name => {
  const { summary, audit, requests } = JSON.parse(readFileSync(join(evidence, `${name}.json`), "utf8"));
  if (summary.version !== "omp/18.8.6" || existsSync(summary.root)) throw new Error(`invalid host version or uncleaned fixture: ${name}`);
  const databasePaths = [...new Set<string>(summary.dbLines.map((line: string) => line.slice(line.indexOf(summary.root))))];
  if (!databasePaths.length || databasePaths.some(path => !path.startsWith(summary.root))) throw new Error(`isolation evidence missing: ${name}`);
  const timestamp = audit[0].at;
  const timeline = audit.filter((row: { phase: string }) => ["agent_start", "agent_end", "context", "context-end", "managed-context-ready", "start-blocked", "start-released", "before_provider_request", "wire", "entry", "abort", "side-done", "skipped-context"].includes(row.phase)).map((row: { at: number; phase: string; session?: string; child?: boolean; event?: { messages?: unknown[]; payload?: Record<string, unknown> }; type?: string; data?: { message?: string } }) => ({
    ms: row.at - timestamp, phase: row.phase, session: row.session, child: row.child,
    messages: row.event?.messages?.length,
    requestRoles: ((row.event?.payload?.messages ?? row.event?.payload?.input) as Array<{ role?: string }> | undefined)?.map(message => message.role),
    refusal: row.type === "magic-context-turn-refused" ? row.data?.message : undefined,
  }));
  const wire = requests.map((request: { receivedAt: number; responseCompletedAt?: number; path: string; body: Record<string, unknown> }) => {
    const text = JSON.stringify(request.body.messages ?? request.body.input);
    const messages = (request.body.messages ?? request.body.input) as Array<{ role?: string }>;
    const tools = request.body.tools as Array<{ name: string }> | undefined;
    return { ms: request.receivedAt - timestamp, completedMs: request.responseCompletedAt ? request.responseCompletedAt - timestamp : null, path: request.path, roles: messages.map(message => message.role), advisor: tools?.some(tool => tool.name.replace(/^_/, "") === "advise") === true,
      managedMarker: text.includes("MANAGED663"), tagMarker: text.includes("§"), originalMarker: text.includes("ORIGINAL663"), sideMarker: text.includes("SIDE663"), steerMarker: text.includes("STEER663"), summaryEnvelope: text.includes("<conversation>"), titleEnvelope: text.includes("<chat>"), captureNudge: text.includes("Automated capture turn") };
  });
  const expected = name.includes("skip-") || name.includes("no-result-") || name === "late-start-baseline" ? 0 : name.includes("advisor") ? name.endsWith("baseline") ? 1 : 2 : name.includes("capture") || name.startsWith("main-") || name.startsWith("late-start-") ? 1 : name.startsWith("task-") ? 4 : name.startsWith("compact-") ? 5 : 2;
  if (wire.length !== expected) throw new Error(`request count mismatch for ${name}: ${wire.length}`);
  if (name.includes("capture") && wire.some((request: { captureNudge: boolean }) => request.captureNudge)) throw new Error(`raw capture dispatched: ${name}`);
  return { name, ...summary, databasePaths, dbLines: undefined, timeline, wire };
});
writeFileSync(join(repo, "docs/reports/issue-663-host-receipts.json"), JSON.stringify({ host: "Oh My Pi 18.8.6", runs }, null, 2) + "\n");
console.log(`Collected ${runs.length} host runs with contained database descriptors, expected request counts, and cleaned fixtures`);
