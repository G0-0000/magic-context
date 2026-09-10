/**
 * Isolate OpenCode's synchronous input capture and last-known-good (LKG) commit work.
 * Run: bun packages/plugin/scripts/benchmark-rust-content-snapshots.ts
 * The baseline computes FNV during input snapshotting with production helpers;
 * the new path delays FNV until commit and proves digest reuse with exact input fields.
 * Commit includes captureSlot and SQLite persistence, but not RPC, output serialization,
 * or a filesystem fsync: the database is in memory. A priced (cache-busting) response
 * must durably commit before returning, even with no cached digests (cold). Non-busting
 * responses run the same commit work in their scheduled callback.
 */
import assert from "node:assert/strict";
import { runMigrations } from "../src/features/magic-context/migrations";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { saveLkgSlotToDb } from "../src/hooks/magic-context/lkg-persist";
import {
    captureSlot,
    incrementalLkgContentDigests,
    type LkgInputSnapshot,
    type LkgSlot,
    messageContentSnapshot,
} from "../src/hooks/magic-context/lkg-slot";
import { __rustModeTransformTest as adapter } from "../src/hooks/magic-context/rust-mode-transform";
import type { MessageLike } from "../src/hooks/magic-context/transform-operations";
import { Database } from "../src/shared/sqlite";

const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const warmups = 3;
const samples = 20;
let sink: unknown;
function measure(fn: () => unknown) {
    for (let index = 0; index < warmups; index++) sink = fn();
    const times: number[] = [];
    for (let index = 0; index < samples; index++) {
        const start = performance.now();
        sink = fn();
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { p50_ms: times[Math.floor(samples * 0.5)], p95_ms: times[Math.floor(samples * 0.95)] };
}
function baselineCommit(
    inputs: readonly LkgInputSnapshot[],
    snapshots: ReturnType<typeof messageContentSnapshot>[],
    prior?: LkgSlot,
) {
    const inputContentSignatures = snapshots.map((snapshot) => snapshot.signature);
    return {
        ...incrementalLkgContentDigests(
            inputs.map((input, index) => ({
                ...input,
                signature: inputContentSignatures[index] ?? "",
            })),
            prior?.inputContentSignatures
                ? {
                      ids: prior.inputIdSeq,
                      signatures: prior.inputContentSignatures,
                      digests: prior.inputContentDigests,
                  }
                : undefined,
        ),
        inputContentSignatures,
    };
}
const results = [];
for (const count of [2000, 5000, 10000]) {
    const sessionId = `snapshot-bench-${count}`;
    const messages = Array.from({ length: count }, (_, index) => ({
        info: {
            id: `m-${index}`,
            role: index % 2 ? "assistant" : "user",
            sessionID: "bench",
            time: { created: index },
        },
        parts:
            index % 2
                ? [
                      {
                          id: `p-${index}`,
                          type: "tool",
                          callID: `call-${index}`,
                          tool: "read",
                          state: {
                              status: "completed",
                              input: { filePath: `src/file-${index}.ts` },
                              output: `file ${index}\n${"source line with realistic ASCII text.\n".repeat(108)}`,
                              title: "Read file",
                              metadata: {},
                          },
                      },
                  ]
                : [
                      {
                          id: `p-${index}`,
                          type: "text",
                          text: `question ${index}: ${"Please inspect the implementation. ".repeat(12)}`,
                      },
                  ],
    })) satisfies MessageLike[];
    const snapshotsBefore = messages.map(messageContentSnapshot);
    const snapshotsAfter = adapter.contentSnapshotsFor(messages);
    assert.deepEqual(
        snapshotsAfter.map((snapshot) => snapshot.fields),
        snapshotsBefore.map((snapshot) => snapshot.fields),
    );
    const inputs = messages.map((message, index) => ({
        id: message.info.id,
        fields: snapshotsAfter[index]?.fields ?? [],
    }));
    const before = baselineCommit(inputs, snapshotsBefore);
    const after = adapter.rustCaptureDigests(inputs, undefined, null);
    assert.deepEqual(before, after);
    const slotFor = (digests: typeof after): LkgSlot => ({
        jsonPrefix:
            '[{"info":{"id":"served","role":"assistant"},"parts":[{"type":"text","text":"compressed output"}]}]',
        inputIdSeq: inputs.map((input) => input.id),
        inputContentDigests: digests.digests,
        inputContentSignatures: digests.inputContentSignatures,
        lastInputMessageId: inputs.at(-1)?.id ?? "",
        modelKey: null,
        providerKey: null,
        capturedAt: 1,
        captureSequence: 1,
        rowVersion: 1,
    });
    const persist = (digests: typeof after) => {
        const slot = slotFor(digests);
        assert.ok(captureSlot(sessionId, slot));
        assert.ok(saveLkgSlotToDb(db, sessionId, slot));
        return digests;
    };
    const prior = slotFor(after);
    const mutationIndex = Math.floor(count / 2);
    const changed = structuredClone(messages);
    (changed[mutationIndex]?.parts[0] as { text: string }).text = "older message rewritten";
    const changedBefore = changed.map(messageContentSnapshot);
    const changedAfter = adapter.contentSnapshotsFor(changed);
    const changedInputs = changed.map((message, index) => ({
        id: message.info.id,
        fields: changedAfter[index]?.fields ?? [],
    }));
    const changedDigests = adapter.rustCaptureDigests(changedInputs, prior, inputs);
    assert.equal(changedDigests.reusedPrefix, mutationIndex);
    assert.deepEqual(changedDigests, baselineCommit(changedInputs, changedBefore, prior));
    const deltaStart = count - 1;
    results.push({
        count,
        fixture_json_bytes: Buffer.byteLength(JSON.stringify(messages)),
        cold_full_snapshot_before: measure(() => messages.map(messageContentSnapshot)),
        cold_full_snapshot_after: measure(() => adapter.contentSnapshotsFor(messages)),
        cold_commit_before: measure(() => persist(baselineCommit(inputs, snapshotsBefore))),
        cold_commit_after: measure(() =>
            persist(adapter.rustCaptureDigests(inputs, undefined, null)),
        ),
        priced_cold_sync_commit_before: measure(() =>
            persist(baselineCommit(inputs, snapshotsBefore)),
        ),
        priced_cold_sync_commit_after: measure(() =>
            persist(adapter.rustCaptureDigests(inputs, undefined, null)),
        ),
        warm_resend_mutated_index: mutationIndex,
        warm_resend_commit_before: measure(() =>
            persist(baselineCommit(changedInputs, changedBefore, prior)),
        ),
        warm_resend_commit_after: measure(() =>
            persist(adapter.rustCaptureDigests(changedInputs, prior, inputs)),
        ),
        warm_suffix_snapshot_before: measure(() => [
            ...snapshotsBefore.slice(0, deltaStart),
            ...messages.slice(deltaStart).map(messageContentSnapshot),
        ]),
        warm_suffix_snapshot_after: measure(() => [
            ...snapshotsAfter.slice(0, deltaStart),
            ...adapter.contentSnapshotsFor(messages.slice(deltaStart)),
        ]),
        warm_unchanged_commit_before: measure(() =>
            persist(baselineCommit(inputs, snapshotsBefore, prior)),
        ),
        warm_unchanged_commit_after: measure(() =>
            persist(adapter.rustCaptureDigests(inputs, prior, inputs)),
        ),
    });
}
console.log(
    JSON.stringify(
        {
            runtime: Bun.version,
            platform: process.platform,
            arch: process.arch,
            warmups,
            samples,
            results,
        },
        null,
        2,
    ),
);
assert.ok(sink);
db.close();
