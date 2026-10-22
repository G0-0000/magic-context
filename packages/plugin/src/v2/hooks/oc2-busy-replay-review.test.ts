// Witness tests for the OpenCode 2 busy-database replay (the saved last good
// request served again when Magic Context's database is busy), as introduced
// by "mason: OpenCode 2 replays its saved request on a busy database". Each
// test asserts a property that commit breaks, so each fails until it is fixed:
// the replay's tool list in a subagent session, and the cost of reading the
// stored message times. Skipped unless MC_REVIEW_OC2REPLAY=1.
import { Database as BunDatabase } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import * as models from "../../shared/models-dev-cache";
import { V2StoreReaderPool } from "../store-reader";
import {
    installBusyAdmission,
    installTransientFailure,
    lkgEvents,
    oc2ContextFixture,
    prose,
} from "./__tests__/oc2-context.fixture";
import * as contextModule from "./context";
import type { SessionContext, V2Context } from "./types";

const reviewTest = test.skipIf(process.env.MC_REVIEW_OC2REPLAY !== "1");
const AREA = "oc2-replay-review";

/**
 * Register the real context hook with `mutate` applied to every context draft
 * before the hook sees it, so a test can hand the hook tools the fixture's
 * host does not send.
 */
function withDraftMutation(mutate: (draft: SessionContext) => void) {
    const realRegister = contextModule.registerContext;
    return spyOn(contextModule, "registerContext").mockImplementation((async (ctx: V2Context) => {
        const session = ctx.session as unknown as Record<string, unknown> & {
            hook: (name: string, cb: (draft: SessionContext) => Promise<void>) => Promise<void>;
        };
        return realRegister({
            ...ctx,
            session: {
                ...session,
                hook: (name: string, cb: (draft: SessionContext) => Promise<void>) =>
                    session.hook(
                        name,
                        name === "context"
                            ? async (draft: SessionContext) => {
                                  mutate(draft);
                                  return cb(draft);
                              }
                            : cb,
                    ),
            },
        } as unknown as V2Context);
    }) as typeof realRegister);
}

// In a subagent session every healthy pass removes the primary-only tools
// (ctx_memory, ctx_note) from the request (hideSubagentTools, context.ts). The
// replay served at writer admission returns before that removal, so the busy
// turn sends a tool list the saved request never had: the provider's cached
// prefix (tools come first) is lost on the turn the replay exists to keep
// cached, and the model is offered two tools it may not call.
for (const busy of ["admission", "admission-exhausted"] as const)
    reviewTest(
        `review: a subagent ${busy} replay sends the saved request's tool list`,
        async () => {
            const failure = installTransientFailure();
            const admission = installBusyAdmission();
            const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
            const register = withDraftMutation((draft) => {
                draft.tools = {
                    ...draft.tools,
                    ctx_memory: { description: "Memory", input: { type: "object" } },
                    ctx_note: { description: "Notes", input: { type: "object" } },
                } as SessionContext["tools"];
            });
            const seed = busy === "admission" ? 9201 : 9202;
            const f = await oc2ContextFixture(seed, { area: AREA, instructions: false });
            try {
                // The host's session row names a parent: a subagent session.
                const host = new BunDatabase(process.env.OPENCODE_DB!);
                host.prepare("UPDATE session_v2 SET parent_id = 'ses-parent' WHERE id = ?").run(
                    f.session,
                );
                host.close();
                f.compartment(4);
                await f.pass();
                f.respond();
                f.user(`${seed} the saved turn: ${prose}`, 120000);
                const saved = await f.pass();
                f.respond();
                f.user(`${seed} the busy turn: ${prose}`, 120000);
                expect(getSlot(f.session)).toBeDefined();
                expect(Object.keys(saved.draft.tools ?? {}).sort()).toEqual(["read"]);
                if (busy === "admission") admission.state.busyNext = true;
                else admission.state.exhaustNext = true;
                const replay = await f.attempt();
                expect(lkgEvents(replay.logs)).toBe("lkg_replay_served");
                expect(replay.draft.system).toEqual(saved.draft.system);
                // While the admission replay skips the subagent tool removal, this
                // receives ["ctx_memory", "ctx_note", "read"].
                expect(Object.keys(replay.draft.tools ?? {}).sort()).toEqual(["read"]);
            } finally {
                register.mockRestore();
                admission.restore();
                failure.restore();
                limit.mockRestore();
                await f.cleanup();
            }
        },
        60000,
    );

// TypeScript mode now reads the stored message times on every pass, not only
// with temporal awareness on. The read (V2StoreReader.messageTimes) filters on
// session_id and id in batches of 500 ids. On the host's schema (built below)
// EXPLAIN QUERY PLAN shows SQLite choosing the (session_id, time_created, id)
// index over the primary key, so each batch walks every row of the session. A draft holding the whole session (one the host never folded)
// therefore costs the square of the session length: about 0.9 s per pass for
// 50,000 messages on the Linux runner. Reading the same 2,000 times should cost
// about the same in a 50,000-message session as in a 5,000-message one.
reviewTest(
    "review: reading stored message times does not scan the whole session",
    () => {
        const root = join(tmpdir(), "magic-context", AREA, `times-${process.pid}`);
        mkdirSync(root, { recursive: true });
        const path = join(root, "store.db");
        const writer = new BunDatabase(path);
        try {
            writer.exec("PRAGMA journal_mode=WAL");
            // The OpenCode 2 store schema, as mirrored in dashboard/src-tauri/src/db.rs.
            writer.exec(`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer, data text NOT NULL);
            CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
            CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
            CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
            CREATE INDEX session_message_time_created_idx ON session_message (time_created);`);
            const insert = writer.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
            const sessions = { long: 50000, short: 5000 } as const;
            const ids: Record<keyof typeof sessions, string[]> = { long: [], short: [] };
            writer.exec("BEGIN");
            for (const [session, count] of Object.entries(sessions) as Array<
                [keyof typeof sessions, number]
            >)
                for (let i = 0; i < count; i++) {
                    const id = `${session}-${String(i).padStart(6, "0")}`;
                    ids[session].push(id);
                    const assistant = i % 2 === 1;
                    insert.run(
                        id,
                        session,
                        assistant ? "assistant" : "user",
                        i,
                        1000 + i,
                        null,
                        JSON.stringify({
                            text: "x".repeat(200),
                            time: assistant
                                ? { created: 1000 + i, completed: 2000 + i }
                                : { created: 1000 + i },
                        }),
                    );
                }
            writer.exec("COMMIT");
            const pool = new V2StoreReaderPool();
            const reader = pool.open(path);
            try {
                const median = (session: keyof typeof sessions) => {
                    const latest = ids[session].slice(-2000);
                    reader.messageTimes(session, latest);
                    const samples: number[] = [];
                    for (let n = 0; n < 7; n++) {
                        const start = performance.now();
                        reader.messageTimes(session, latest);
                        samples.push(performance.now() - start);
                    }
                    return samples.sort((a, b) => a - b)[3]!;
                };
                const short = median("short");
                const long = median("long");
                const whole = performance.now();
                reader.messageTimes("long", ids.long);
                const wholeMs = performance.now() - whole;
                console.log(
                    `OC2_REVIEW_TIMES 2000 ids: ${short.toFixed(1)} ms in 5,000 messages, ${long.toFixed(1)} ms in 50,000 (ratio ${(long / short).toFixed(1)}); all 50,000: ${wholeMs.toFixed(1)} ms`,
                );
                expect(long / short).toBeLessThan(3);
            } finally {
                reader.close();
                pool.close();
            }
        } finally {
            writer.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
    300000,
);
