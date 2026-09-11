import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "../light-descriptions";
import { CTX_NOTE_DESCRIPTION } from "./constants";

const NOTE_IDS_DESCRIPTION =
    "One to fifty note ids for 'dismiss' only; do not combine with note_id.";

const pluginSchemaSource = readFileSync(resolve(import.meta.dir, "tools.ts"), "utf8");
const piSchemaSource = readFileSync(
    resolve(import.meta.dir, "../../../../pi-plugin/src/tools/ctx-note.ts"),
    "utf8",
);
const rustSchemaSource = readFileSync(
    resolve(import.meta.dir, "../../../../../crates/mc-module/src/lib.rs"),
    "utf8",
);

describe("ctx_note multi-dismiss schema parity", () => {
    it("keeps the changed schema fields byte-identical across TS, Pi, and Rust", () => {
        for (const source of [pluginSchemaSource, piSchemaSource, rustSchemaSource]) {
            expect(source).toContain(NOTE_IDS_DESCRIPTION);
        }
        expect(pluginSchemaSource).toContain(".array(tool.schema.number().int().min(1))");
        expect(pluginSchemaSource).toContain(".max(50)");
        expect(piSchemaSource).toContain(
            "Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })",
        );
        expect(piSchemaSource).toContain("maximum: Number.MAX_SAFE_INTEGER");
        expect(piSchemaSource).toContain("maxItems: 50");
        expect(rustSchemaSource).toContain(
            '"minItems": 1, "maxItems": 50, "items": { "type": "integer", "minimum": 1, "maximum": 9007199254740991_i64 }',
        );
    });

    it("mentions the array form once in each description preset", () => {
        expect(CTX_NOTE_DESCRIPTION.match(/\bnote_ids\b/g)).toHaveLength(1);
        expect(CTX_NOTE_LIGHT_DESCRIPTION.match(/\bnote_ids\b/g)).toHaveLength(1);
    });
});
