import { expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { __test as pi } from "../packages/pi-plugin/src/context-handler";

import {
    closeCompactionMarkerDb,
    injectCompactionMarker,
} from "../packages/plugin/src/features/magic-context/compaction-marker";
import {
    findPiFallbackToolOwnerTags,
    getAllStatusTagTokenTotalsFlat,
} from "../packages/plugin/src/features/magic-context/storage-tags";
import {
    resolveBoundaryContext,
    resolveProtectedTailBoundary,
} from "../packages/plugin/src/hooks/magic-context/protected-tail-boundary";
import { withRawMessageProvider } from "../packages/plugin/src/hooks/magic-context/read-session-chunk";
import type { Database } from "../packages/plugin/src/shared/sqlite";
import {
    contextStore,
    fixture,
    hostStore,
    messageId,
    random,
    SESSION,
} from "./host-stalls-fixture";

const OLD_LEGACY_MARKER_SQL = `SELECT m.id FROM message m WHERE m.session_id=? AND m.id<>?
    AND COALESCE(json_extract(m.data,'$.summary'),0)=1 AND COALESCE(json_extract(m.data,'$.finish'),'')='stop'
    AND COALESCE(json_extract(m.data,'$.parentID'),'')=? AND EXISTS(SELECT 1 FROM part p
      WHERE +p.session_id=m.session_id AND p.message_id=m.id AND COALESCE(json_extract(p.data,'$.type'),'')='text'
      AND COALESCE(json_extract(p.data,'$.text'),'')=?)`;

it("marker cleanup deletes the frozen lineage set including equal, skewed and missing timestamps", () => {
    const f = fixture();
    const oldHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = f.dir;
    mkdirSync(join(f.dir, "opencode"));
    const db = hostStore(join(f.dir, "opencode", "opencode.db"), 20);
    try {
        const boundary = messageId(18);
        const candidates = [
            ["legacy-equal", 6, boundary, "summary"],
            ["legacy-skewed", 5, boundary, "summary"],
            ["legacy-missing", null, boundary, "summary"],
            ["legacy-later", 7, boundary, "summary"],
            ["foreign-parent", 7, messageId(3), "summary"],
            ["foreign-text", 7, boundary, "other"],
        ] as const;
        for (const [id, time, parentID, text] of candidates) {
            db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
                id,
                SESSION,
                time,
                7,
                JSON.stringify({ role: "assistant", summary: true, finish: "stop", parentID }),
            );
            db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
                `${id}-part`,
                id,
                SESSION,
                7,
                7,
                JSON.stringify({ type: "text", text }),
            );
        }
        const old = db
            .prepare(OLD_LEGACY_MARKER_SQL)
            .all(SESSION, "canonical", boundary, "summary") as Array<{ id: string }>;
        expect(old.map((r) => r.id).sort()).toEqual([
            "legacy-equal",
            "legacy-later",
            "legacy-missing",
            "legacy-skewed",
        ]);
        expect(
            injectCompactionMarker({
                sessionId: SESSION,
                endMessageId: boundary,
                endOrdinal: 19,
                summaryText: "summary",
                directory: f.dir,
                resolvedBoundary: { id: boundary, timeCreated: 6 },
            }),
        ).not.toBeNull();
        const leftovers = old.filter((row) =>
            db.prepare("SELECT 1 FROM message WHERE id=?").get(row.id),
        );
        expect(leftovers.map((r) => r.id).sort()).toEqual([]);
        for (const row of old)
            expect(db.prepare("SELECT 1 FROM part WHERE message_id=?").get(row.id)).toBeNull();
        for (const id of [boundary, "foreign-parent", "foreign-text"])
            expect(db.prepare("SELECT 1 FROM message WHERE id=?").get(id)).not.toBeNull();
    } finally {
        closeCompactionMarkerDb();
        db.close();
        process.env.XDG_DATA_HOME = oldHome;
        f.cleanup();
    }
});

type TagRow = {
    type: string;
    message_id: string;
    tool_owner_message_id: string | null;
    token_count: number | null;
    input_token_count: number | null;
    reasoning_token_count: number | null;
};

// Preserve the original full-history SELECT and summation as an independent
// oracle: calibrated floating-point sums depend on the database's row order.
function fullTokenOracle(
    db: Database,
    floor: number,
    calibration: { proseRatio: number; toolsRatio: number },
) {
    const rows = db
        .prepare(`SELECT type,message_id,tool_owner_message_id,token_count,input_token_count,reasoning_token_count
        FROM tags WHERE session_id=?${floor > 0 ? " AND tag_number >= ?" : ""}`)
        .all(SESSION, ...(floor > 0 ? [floor] : [])) as TagRow[];
    const totals = new Map<string, number>();
    const nulls = new Set<string>();
    for (const row of rows) {
        if (row.type === "tool" && row.tool_owner_message_id === null) continue;
        const owner =
            row.type === "tool"
                ? row.tool_owner_message_id!
                : row.message_id
                      .replace(/:(?:p|file)\d+$/, "")
                      .replace(/:mc-text-v1:[0-9a-f]+:[0-9a-f]+:o\d+$/, "");
        if (row.token_count === null) {
            nulls.add(owner);
            totals.delete(owner);
            continue;
        }
        if (nulls.has(owner)) continue;
        const weight =
            ((row.token_count ?? 0) + (row.input_token_count ?? 0)) *
                (row.type === "tool" ? calibration.toolsRatio : calibration.proseRatio) +
            (row.reasoning_token_count ?? 0) * calibration.proseRatio;
        totals.set(owner, (totals.get(owner) ?? 0) + weight);
    }
    return { totals, nullMessageIds: nulls };
}

it("seeded owner subsets preserve exact floating sums and boundary decisions before and after ANALYZE", async () => {
    const f = fixture();
    const db = contextStore(join(f.dir, "context.db"));
    try {
        const rng = random(0xbadcafe);
        const owners = [
            "pi-msg-α%_",
            "owner:colon",
            "😀",
            ...Array.from({ length: 27 }, (_, i) => `owner-${i}`),
        ];
        const weights = [0, 1, 3, 999, 1e15, 1e-12, 1234567, null];
        const insert =
            db.prepare(`INSERT INTO tags(session_id,message_id,type,status,tag_number,tool_owner_message_id,
            token_count,input_token_count,reasoning_token_count) VALUES (?,?,?,?,?,?,?,?,?)`);
        db.transaction(() => {
            for (let i = 0; i < 800; i++) {
                const owner = owners[Math.floor(rng() * owners.length)];
                const type = ["message", "file", "tool"][Math.floor(rng() * 3)];
                const contentId =
                    i % 2
                        ? `${owner}:mc-text-v1:abc:123:o${i}`
                        : `${owner}:${type === "file" ? "file" : "p"}${i}`;
                insert.run(
                    SESSION,
                    type === "tool" ? `call-${i}` : contentId,
                    type,
                    ["active", "dropped", "compacted"][i % 3],
                    1000 + i,
                    type === "tool" && i % 7 ? owner : null,
                    weights[
                        Math.floor(
                            rng() *
                                (owners.indexOf(owner) < 25 ? weights.length - 1 : weights.length),
                        )
                    ],
                    i % 5,
                    i % 13,
                );
            }
        }).immediate();
        for (const analyzed of [false, true]) {
            if (analyzed) db.exec("ANALYZE");
            for (const floor of [0, 1100, 1500]) {
                const calibration = {
                    proseRatio: 1.370000000000001,
                    toolsRatio: 0.830000000000001,
                };
                const full = fullTokenOracle(db, floor, calibration);
                for (let trial = 0; trial < 30; trial++) {
                    const subset = owners.filter(() => rng() < 0.4);
                    const actual = getAllStatusTagTokenTotalsFlat(
                        db,
                        SESSION,
                        floor,
                        calibration,
                        subset,
                    );
                    expect([...actual.totals.keys()].every((id) => subset.includes(id))).toBe(true);
                    for (const owner of subset) {
                        expect(Object.is(actual.totals.get(owner), full.totals.get(owner))).toBe(
                            true,
                        );
                        expect(actual.nullMessageIds.has(owner)).toBe(
                            full.nullMessageIds.has(owner),
                        );
                    }
                }
                const messages = owners.map((id, index) => ({
                    id,
                    ordinal: index + 1,
                    role: index % 2 ? "assistant" : "user",
                    parts: [{ type: "text", text: `fixture ${id}` }],
                }));
                await withRawMessageProvider(
                    SESSION,
                    { readMessages: () => messages },
                    async () => {
                        for (const contextLimit of [2000, 128000]) {
                            const ctx = resolveBoundaryContext({
                                db,
                                sessionId: SESSION,
                                mode: "trigger",
                                contextLimit,
                                executeThresholdPercentage: 80,
                                taggerFloor: floor,
                            });
                            const frozen = fullTokenOracle(db, floor, ctx.calibration!);
                            const oldCtx = {
                                ...ctx,
                                storedTokenTotalsForMessages: undefined,
                                storedTokenTotals: frozen.totals,
                                createdAt: 1234,
                            };
                            expect(
                                resolveProtectedTailBoundary({ ...ctx, createdAt: 1234 }),
                            ).toEqual(resolveProtectedTailBoundary(oldCtx));
                        }
                    },
                );
            }
        }
    } finally {
        db.close();
        f.cleanup();
    }
});

it("Pi prefix seeks match LIKE for every ASCII casing, wildcards and Unicode suffixes", () => {
    const f = fixture();
    const db = contextStore(join(f.dir, "context.db"));
    try {
        const spellings = [..."pi-msg-"].reduce<string[]>(
            (xs, c) =>
                xs.flatMap((x) => (/[a-z]/.test(c) ? [x + c, x + c.toUpperCase()] : [x + c])),
            [""],
        );
        const ids = spellings.flatMap((p) => [p, `${p}%_`, `${p}αéİ😀`, `${p}owner:colon`]);
        ids.push("pı-msg-α", "pi-msğ-α", "xpi-msg-%_", "pi-msg.α", "pi-msg-\u0000after");
        for (const [i, id] of ids.entries()) {
            db.prepare(`INSERT INTO tags(session_id,message_id,type,status,tag_number,tool_owner_message_id,entry_fingerprint)
                VALUES (?,?,?,'active',?,?,?)`).run(
                SESSION,
                `call-${i}`,
                "tool",
                1000 + i * 2,
                id,
                null,
            );
            db.prepare(`INSERT INTO tags(session_id,message_id,type,status,tag_number,entry_fingerprint)
                VALUES (?,?,'message','active',?,?)`).run(
                SESSION,
                `${id}:p0`,
                1001 + i * 2,
                JSON.stringify(["user", i, "text", "payload", `digest-${i}`]),
            );
        }
        const oldOwners = db
            .prepare(`SELECT tag_number AS tagNumber,message_id AS callId,tool_owner_message_id AS toolOwnerMessageId,status
            FROM tags WHERE session_id=? AND type='tool' AND tool_owner_message_id LIKE 'pi-msg-%' ORDER BY tag_number`)
            .all(SESSION) as ReturnType<typeof findPiFallbackToolOwnerTags>;
        expect(findPiFallbackToolOwnerTags(db, SESSION)).toEqual(oldOwners);
        const oldHeaders = db
            .prepare(`SELECT DISTINCT entry_fingerprint FROM tags WHERE session_id=? AND type='message'
            AND entry_fingerprint IS NOT NULL AND message_id LIKE 'pi-msg-%'`)
            .all(SESSION) as Array<{ entry_fingerprint: string }>;
        expect(pi.readPiFallbackFingerprintHeaders(db, SESSION)).toEqual(
            new Set(
                oldHeaders.map((row) =>
                    JSON.stringify(JSON.parse(row.entry_fingerprint).slice(0, 4)),
                ),
            ),
        );
        expect(oldOwners.length).toBe(129);
    } finally {
        db.close();
        f.cleanup();
    }
});
