/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attributeHeapFile } from "./attribute-heap";

const FIXTURE_BYTES = 2 * 1024 * 1024;

class MagicContextHeapFixtureHolder {
    readonly sessionId = "ses-known-heap-fixture";
    readonly payload = new Uint8Array(FIXTURE_BYTES);
    readonly child = { marker: "known-retained-child", values: [1, 2, 3, 4] };
}

describe("JSC heap attribution", () => {
    test("parses a real Bun snapshot and retains a known object graph within 10%", () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), "mc-heap-fixture-"));
        const fixturePath = join(fixtureRoot, "known.heapsnapshot");
        const holder = new MagicContextHeapFixtureHolder();
        const fixtureGlobal = globalThis as typeof globalThis & {
            __magicContextHeapFixture?: MagicContextHeapFixtureHolder;
        };
        fixtureGlobal.__magicContextHeapFixture = holder;

        try {
            writeFileSync(fixturePath, JSON.stringify(Bun.generateHeapSnapshot()));
            const analysis = attributeHeapFile(fixturePath);
            const bucket = analysis.buckets.find(
                (candidate) => candidate.name === "MagicContextHeapFixtureHolder",
            );

            expect(bucket).toBeDefined();
            expect(bucket?.largestRetainedSize).toBeGreaterThanOrEqual(FIXTURE_BYTES * 0.9);
            expect(bucket?.largestRetainedSize).toBeLessThanOrEqual(FIXTURE_BYTES * 1.1);
            expect(analysis.attribution.magicContext).toBeGreaterThanOrEqual(FIXTURE_BYTES * 0.9);
        } finally {
            delete fixtureGlobal.__magicContextHeapFixture;
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });
});
