import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { Database } from "../../shared/sqlite";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import { hasReclaimRide, reclaimRideLabel } from "./cache-busting-signals";
import { prepareServedShapeRepair } from "./served-shape-repair";

function database() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function draft(providerID = "openai", text = "§58§"): SessionContext {
    return {
        sessionID: "poisoned",
        model: { providerID, id: "mock-model" },
        agent: "build",
        messages: [
            { id: "old", role: "assistant", content: [{ type: "text", text }] },
            { id: "error-1", role: "assistant", content: [], finish: "error" },
            { id: "error-2", role: "assistant", content: [], finish: "error" },
            { id: "retry", role: "user", content: [{ type: "text", text: "retry" }] },
        ],
        system: [],
        tools: {},
        options: {},
    };
}

describe("served-shape copied-tag decisions", () => {
    it("admits one repair rebuild, then replays the frozen literal on defer and provider switch", () => {
        const db = database();
        let previous = "";
        for (const [index, provider] of [
            "openai",
            "openai",
            "anthropic",
            "bedrock",
            "openai",
        ].entries()) {
            const context = draft(provider);
            const mapped = adaptPayload(context);
            const repair = prepareServedShapeRepair(db, context.sessionID, mapped.messages);
            expect(repair.pending).toBe(index === 0);
            const signals = {
                hardFold: false,
                force: false,
                explicitFlush: false,
                publishedHistory: false,
                servedShapeRepair: repair.pending,
            };
            expect(hasReclaimRide(signals)).toBe(index === 0);
            if (index === 0) expect(reclaimRideLabel(signals)).toBe("ride=servedShapeRepair");
            repair.apply(repair.pending);
            mapped.commit();
            const bytes = JSON.stringify(context.messages);
            expect(context.messages[0].content[0].text).toBe("§58§");
            if (previous) expect(bytes).toBe(previous);
            previous = bytes;
        }
        db.close();
    });

    it("does not freeze a repair until the shared rebuild permission is granted", () => {
        const db = database();
        const context = draft();
        const mapped = adaptPayload(context);
        const repair = prepareServedShapeRepair(db, context.sessionID, mapped.messages);
        expect(repair.pending).toBe(true);
        repair.apply(false);
        expect(readReplayEnvelope(db, context.sessionID).servedShapeRepair).toBeUndefined();
        repair.apply(true);
        expect(readReplayEnvelope(db, context.sessionID).servedShapeRepair).toEqual({
            old: [{ index: 0, text: "§58§" }],
        });
        db.close();
    });

    it("leaves model-authored blank framing, real prose and canonical Anthropic undecided", () => {
        const db = database();
        for (const [provider, text] of [
            ["openai", " \n\t "],
            ["openai", "§12§ done"],
            ["anthropic", "§58§"],
        ]) {
            const context = draft(provider, text);
            const mapped = adaptPayload(context);
            expect(prepareServedShapeRepair(db, context.sessionID, mapped.messages).pending).toBe(
                false,
            );
        }
        expect(readReplayEnvelope(db, "poisoned").servedShapeRepair).toBeUndefined();
        db.close();
    });

    it("does not resurrect a message intentionally dropped after repair", () => {
        const db = database();
        const context = draft();
        const mapped = adaptPayload(context);
        prepareServedShapeRepair(db, context.sessionID, mapped.messages).apply(true);
        (mapped.messages[0].parts[0] as { text: string }).text = "[dropped §1§]";
        prepareServedShapeRepair(db, context.sessionID, mapped.messages).apply(false);
        expect((mapped.messages[0].parts[0] as { text: string }).text).toBe("[dropped §1§]");
        db.close();
    });

    it("retains unrelated replay namespaces when saving the repair", () => {
        const db = database();
        updateReplayDocument(db, "poisoned", (doc) => {
            doc.version = 2;
            doc.piNative = { opaque: "signed" };
            return true;
        });
        const context = draft();
        const mapped = adaptPayload(context);
        prepareServedShapeRepair(db, "poisoned", mapped.messages).apply(true);
        expect(readReplayEnvelope(db, "poisoned").piNative).toEqual({ opaque: "signed" });
        db.close();
    });
});
