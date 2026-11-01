/**
 * Shared corpus pinning the two deliberately-duplicated status-ledger parsers
 * to identical verdicts: the query side's `parseStatusChanges`
 * (flow-render.ts) and the write side's `parseChanges` (strata-cache.ts).
 * Both sides' tests import these fixtures, so a behavior drift in either
 * parser fails one suite or the other; the write side additionally counts
 * dropped lines, which is its own concern and not part of the verdict.
 *
 * `changes` spells out the rows every parser MUST extract from `raw`, in
 * order. Lines that every parser must drop silently (corrupt JSON, torn
 * tails, foreign shapes, invalid ids or timestamps, unknown ops, a `remove`
 * without a known `kind`) appear inline in `raw`; a torn final line models a
 * crash mid-append and costs that row and nothing else.
 */
import type { StatusChange } from "./flow-render";

export interface StatusLedgerFixture {
    readonly name: string;
    /** Exact ledger bytes. */
    readonly raw: string;
    /** The rows every parser must extract from `raw`, in ledger order. */
    readonly changes: readonly StatusChange[];
}

const TS = "2026-11-01T00:00:00.000Z";

const line = (event: object): string => JSON.stringify(event);

export const STATUS_LEDGER_FIXTURES: readonly StatusLedgerFixture[] = [
    {
        name: "valid rows of every op and remove kind, in order",
        raw: [
            line({ op: "add", id: 7, ts: TS }),
            line({ op: "update", id: 8, ts: TS }),
            line({ op: "remove", id: 9, kind: "archive", ts: TS }),
            line({ op: "remove", id: 10, kind: "delete", ts: TS }),
            line({ op: "remove", id: 11, kind: "superseded", ts: TS }),
            "",
        ].join("\n"),
        changes: [
            { op: "add", id: 7, ts: TS },
            { op: "update", id: 8, ts: TS },
            { op: "remove", id: 9, kind: "archive", ts: TS },
            { op: "remove", id: 10, kind: "delete", ts: TS },
            { op: "remove", id: 11, kind: "superseded", ts: TS },
        ],
    },
    {
        name: "a torn final line costs that row and nothing else",
        raw: `${line({ op: "add", id: 7, ts: TS })}\n{"op":"ad`,
        changes: [{ op: "add", id: 7, ts: TS }],
    },
    {
        name: "corrupt and foreign lines between valid rows never poison the rest",
        raw: [
            line({ op: "add", id: 7, ts: TS }),
            "not json at all",
            line({ op: "move", id: 8, ts: TS }),
            line({ op: "remove", id: 9, ts: TS }),
            line({ op: "remove", id: 10, kind: "merged", ts: TS }),
            "[1,2,3]",
            '"just a string"',
            "42",
            "null",
            line({ op: "add", id: 0, ts: TS }),
            line({ op: "add", id: -3, ts: TS }),
            line({ op: "add", id: 2.5, ts: TS }),
            line({ op: "add", id: "7", ts: TS }),
            line({ op: "add", id: 9007199254740992, ts: TS }),
            line({ op: "add", id: 12 }),
            line({ op: "add", id: 13, ts: "not-a-date" }),
            line({ op: "add", id: 14, ts: 123 }),
            line({ op: "add", id: 15, ts: TS }),
            "",
        ].join("\n"),
        changes: [
            { op: "add", id: 7, ts: TS },
            { op: "add", id: 15, ts: TS },
        ],
    },
    {
        name: "blank and whitespace-only lines are not rows",
        raw: `\n   \n${line({ op: "update", id: 3, ts: TS })}\n\t\n`,
        changes: [{ op: "update", id: 3, ts: TS }],
    },
    {
        name: "timestamps normalize the same way on both sides",
        raw: [
            line({ op: "add", id: 7, ts: "2026-11-01T08:00:00+08:00" }),
            line({ op: "add", id: 8, ts: "2026-11-01" }),
            "",
        ].join("\n"),
        changes: [
            { op: "add", id: 7, ts: TS },
            { op: "add", id: 8, ts: TS },
        ],
    },
    {
        name: "unknown extra fields are ignored, duplicates stay in order",
        raw: [
            line({ op: "add", id: 7, ts: TS, extra: "ignored", kind: "archive" }),
            line({ op: "add", id: 7, ts: TS }),
            "",
        ].join("\n"),
        changes: [
            { op: "add", id: 7, ts: TS },
            { op: "add", id: 7, ts: TS },
        ],
    },
    {
        name: "empty and whitespace-only input yields no rows",
        raw: "",
        changes: [],
    },
];
