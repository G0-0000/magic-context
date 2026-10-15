import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    noteRustServedRaw,
    preserveRustServedRaw,
    releaseRustServedRaw,
    servedRawBlockIds,
} from "./rust-served-raw";
import type { MessageLike } from "./transform-operations";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "rust-served-raw-"));
    directories.push(dir);
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const input = [
        {
            info: { id: "assistant", role: "assistant", sessionID: "raw" },
            parts: [
                {
                    id: "thinking",
                    type: "reasoning",
                    text: "signed thinking",
                    metadata: { anthropic: { signature: "sig" } },
                },
                {
                    id: "result",
                    type: "tool",
                    tool: "read",
                    callID: "call",
                    state: { status: "completed", input: {}, output: "raw result" },
                },
                { id: "text", type: "text", text: "raw text" },
            ],
        },
    ] as MessageLike[];
    return { db, path, input };
}

test("served raw evidence survives a new database connection and matches native IDs, not part positions", () => {
    const { db, path, input } = fixture();
    const served = structuredClone(input);
    (served[0]!.parts[2] as { text: string }).text = "§77§ raw text";
    noteRustServedRaw(db, "raw", input, served);
    expect(servedRawBlockIds(db, "raw")).toEqual(["assistant#0", "assistant#1", "assistant#2"]);
    const reopened = new Database(path);
    databases.push(reopened);
    const candidate = structuredClone(served);
    candidate[0]!.parts.shift();
    (candidate[0]!.parts[0] as { state: { output: string } }).state.output = "§9§ raw result";
    preserveRustServedRaw(reopened, "raw", candidate);
    expect(JSON.stringify(candidate)).toBe(JSON.stringify(served));
    releaseRustServedRaw(reopened, "raw", candidate);
    expect(servedRawBlockIds(reopened, "raw")).toEqual([
        "assistant#0",
        "assistant#1",
        "assistant#2",
    ]);
    (candidate[0]!.parts[1] as { state: { output: string } }).state.output = "§9§ raw result";
    releaseRustServedRaw(reopened, "raw", candidate);
    expect(servedRawBlockIds(reopened, "raw")).toEqual(["assistant#0"]);
});

test("every raw serve refreshes a completed part and its newly projected result block", () => {
    const { db, input } = fixture();
    input[0]!.parts.pop();
    const pending = structuredClone(input);
    (pending[0]!.parts[1] as { state: { status: string } }).state.status = "running";
    noteRustServedRaw(db, "raw", pending, pending);
    expect(servedRawBlockIds(db, "raw")).toEqual(["assistant#0"]);
    noteRustServedRaw(db, "raw", input, input);
    expect(servedRawBlockIds(db, "raw")).toContain("assistant#2");
    (input[0]!.parts[1] as { state: { output: string } }).state.output = "updated result";
    noteRustServedRaw(db, "raw", input, input);
    const candidate = structuredClone(input);
    (candidate[0]!.parts[1] as { state: { output: string } }).state.output = "§5§ updated result";
    preserveRustServedRaw(db, "raw", candidate);
    expect(candidate).toEqual(input);
});

test("ambiguous ID-less raw parts fail closed rather than overwriting a same-type neighbor", () => {
    const { db, input } = fixture();
    delete (input[0]!.parts[2] as { id?: string }).id;
    noteRustServedRaw(db, "raw", input, input);
    const candidate = structuredClone(input);
    (candidate[0]!.parts[2] as { text: string }).text = "different neighbor";
    expect(() => preserveRustServedRaw(db, "raw", candidate)).toThrow(EmergencyFailClosedError);
});

test("a session with no raw replay evidence has no output normalization or persistence", () => {
    const { db } = fixture();
    const candidate = ["legacy fixture"] as unknown as MessageLike[];
    preserveRustServedRaw(db, "untouched", candidate);
    releaseRustServedRaw(db, "untouched", candidate);
    expect(candidate).toEqual(["legacy fixture"]);
    expect(
        db.query("SELECT session_id FROM session_meta WHERE session_id = ?").get("untouched"),
    ).toBeNull();
});
