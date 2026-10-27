/**
 * Tool-definition token measurement store.
 *
 * Every provider request carries the definitions of the tools offered on it,
 * and those definitions take room in the context window. This store measures
 * them so estimates of a request's size can include them. Each tool's
 * description + JSON-schema parameters is tokenized with the same Claude
 * tokenizer used everywhere else in the plugin and stored per tool under a
 * `${providerID}/${modelID}/${agentName}` route key.
 *
 * What a total counts: the tools of the current request. A tool the host
 * stopped offering, a tool measured in an earlier process, or a tool another
 * session was offered must not add to it. How the current request's tools are
 * known depends on the host (OpenCode 1 approximates the set, see below, and
 * until a route's first live measurement after a restart its stored rows stand
 * in for it):
 *
 * - OpenCode 1 fires its `tool.definition` hook once per tool per
 *   `ToolRegistry.tools()` call (once per request, all tools at once, before
 *   the messages transform of that request), with `{ toolID }` as input and
 *   no session and no "last tool" signal. Fires are grouped into flights: a
 *   fire for a tool already seen in the open flight, or one arriving more than
 *   `FLIGHT_GAP_MS` after the previous fire, starts a new flight. A route's
 *   total is the tools fired in its last `FLIGHT_WINDOW` flights, so a read in
 *   the middle of a flight still counts the previous complete set and a tool
 *   the host stopped offering leaves the total two flights later.
 * - OpenCode 2 has no such hook, but each request draft carries its whole tool
 *   set, so `recordToolDefinitionSet` replaces the route's set with exactly
 *   that set and remembers it for the draft's session. A read with that
 *   session id returns that session's own set, even when another session on
 *   the same route was offered different tools since.
 *
 * Persistence (v9+): measurements are also written to SQLite so that a
 * plugin restart can show a "Tool Defs" figure before the first request of
 * the new process. Rows loaded at startup are a placeholder for the route
 * only until its first live measurement in this process, which replaces them;
 * rows for tools that left the route's set are deleted as they leave, so the
 * table holds each route's current set. If `setDatabase()` hasn't been called
 * yet (cold path before openDatabase completes), measurements still update the
 * in-memory map and silently skip persistence.
 *
 * Hot-path optimization: `tool.definition` fires once per tool per LLM
 * flight (~58 tools × 5–18ms SQLite write = ~1.4s of redundant work per
 * flight on large MC databases). Tool descriptions and parameters almost
 * never change between flights, so each tool keeps the content fingerprint of
 * its last measurement and an identical fire only refreshes the flight
 * bookkeeping, without tokenizing or writing. Any tool whose description or
 * schema actually changed (e.g. MCP server restart, OpenCode upgrade) is
 * re-measured. Cached prepared statements avoid repeated `db.prepare()`
 * compile cost on first-flight rebuilds.
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { Database, Statement } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";

/** OpenCode 1: how many recent flights of a route count toward its total. */
const FLIGHT_WINDOW = 2;
/**
 * OpenCode 1: a fire this long after the previous fire on the same route
 * starts a new flight even when its tool was not seen yet. Within one flight
 * all fires start together, so this only catches a request whose tool set
 * shares no tool with the previous request's.
 */
const FLIGHT_GAP_MS = 2_000;
/** Flight number of a tool loaded from SQLite and not measured in this process. */
const LOADED_FROM_STORAGE = Number.NEGATIVE_INFINITY;

interface ToolSlot {
    tokens: number;
    /**
     * Content fingerprint of the measured description and parameters, or
     * undefined for a row loaded from SQLite, whose content this process has
     * not seen.
     */
    fingerprint: string | undefined;
    /** Flight in which the host last offered this tool. */
    flight: number;
}

interface RouteMeasurements {
    providerID: string;
    modelID: string;
    agentName: string;
    tools: Map<string, ToolSlot>;
    /** True once the host offered this route's tools in this process. */
    live: boolean;
    /** Number of the open flight (OpenCode 1) or of the last set write (OpenCode 2). */
    flight: number;
    /** Tools fired in the open flight (OpenCode 1). */
    open: Set<string>;
    lastFireAt: number;
}

interface ToolSetSummary {
    total: number;
    /** Undefined when a counted tool's content is unknown in this process. */
    signature: string | undefined;
    hash: string;
}

interface SessionFlight {
    key: string;
    /** OpenCode 2: the exact set this session's last request carried. */
    exact?: ToolSetSummary;
}

const routes = new Map<string, RouteMeasurements>();

// The route each session's tools were last measured under, and on OpenCode 2
// the exact set. Bounded like other per-session state: an evicted session
// falls back to its route's figure.
const sessionFlights = new BoundedSessionMap<SessionFlight>(1000);

// Database reference for persistence. Set by setDatabase() once
// openDatabase() has finished migrations. Until then, measurements only
// update the in-memory map (lossy, but the next measurement after init will
// land in SQLite).
let persistenceDb: Database | null = null;

// Cached statements — recompiling on every fire was a significant share of
// the hot-path cost. Initialized lazily on first use after `setDatabase()` and
// dropped on reset / DB rebind.
let cachedInsertStmt: Statement | null = null;
let cachedPruneStmt: Statement | null = null;

function agentKey(agentName: string | undefined): string {
    return agentName && agentName.length > 0 ? agentName : "default";
}

function keyFor(providerID: string, modelID: string, agentName: string | undefined): string {
    return `${providerID}/${modelID}/${agentKey(agentName)}`;
}

/**
 * Build a stable fingerprint of all inputs that determine the measured value.
 * Correctness beats the prior shallow optimization: nested schema changes must
 * invalidate cached token counts too.
 */
function fingerprintFor(description: string, parameters: unknown): string {
    return createHash("sha256")
        .update(description)
        .update("\0")
        .update(stableStringify(parameters))
        .digest("hex");
}

function measure(description: string, parameters: unknown): number {
    // Serialize parameters to match what the provider actually sees on the
    // wire. `JSON.stringify(undefined)` returns undefined, so guard that.
    let paramsText = "";
    try {
        paramsText = parameters === undefined ? "" : JSON.stringify(parameters);
    } catch {
        paramsText = "";
    }
    // Count: description + serialized params. This is the token cost of a
    // single tool's definition inside the `tools` array the provider
    // receives. Overhead around the array (field names, commas, braces) is
    // attributed to the separate "Overhead" bucket the RPC handler computes
    // as a residual against inputTokens.
    return estimateTokens(description) + estimateTokens(paramsText);
}

function routeFor(providerID: string, modelID: string, agentName: string | undefined) {
    const key = keyFor(providerID, modelID, agentName);
    let route = routes.get(key);
    if (!route) {
        route = {
            providerID,
            modelID,
            agentName: agentKey(agentName),
            tools: new Map(),
            live: false,
            flight: 0,
            open: new Set(),
            lastFireAt: 0,
        };
        routes.set(key, route);
    }
    return { key, route };
}

/**
 * The tools a route's total counts. Before the host offered the route's tools
 * in this process, that is the set loaded from SQLite; after, the tools of the
 * last `FLIGHT_WINDOW` flights.
 */
function currentTools(route: RouteMeasurements): Array<[string, ToolSlot]> {
    const entries = [...route.tools.entries()];
    if (!route.live) return entries;
    const oldest = route.flight - (FLIGHT_WINDOW - 1);
    return entries.filter(([, slot]) => slot.flight >= oldest);
}

function summarize(entries: Array<[string, ToolSlot]>): ToolSetSummary {
    let total = 0;
    for (const [, slot] of entries) total += slot.tokens;
    const ids = entries.map(([id]) => id).sort();
    const fingerprints = new Map(entries.map(([id, slot]) => [id, slot.fingerprint]));
    const complete = ids.every((id) => fingerprints.get(id) !== undefined);
    return {
        total,
        // A tool whose content this process has not measured could have changed
        // since the row was written, so no signature can vouch for the set.
        signature: complete
            ? createHash("sha256")
                  .update(JSON.stringify(ids.map((id) => [id, fingerprints.get(id)])))
                  .digest("hex")
            : undefined,
        // An empty string means no tool definitions were observed, as before
        // any measurement.
        hash: ids.length === 0 ? "" : createHash("sha256").update(ids.join("\0")).digest("hex"),
    };
}

function resolve(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId: string | undefined,
): ToolSetSummary | undefined {
    if (!providerID || !modelID) return undefined;
    const key = keyFor(providerID, modelID, agentName);
    if (sessionId) {
        const flight = sessionFlights.peek(sessionId);
        if (flight?.key === key && flight.exact) return flight.exact;
    }
    const route = routes.get(key);
    if (!route) return undefined;
    const entries = currentTools(route);
    // A route known only from storage with no rows is not a measurement. A
    // live route with no tools is: OpenCode 2 sent a request with no tools.
    if (!route.live && entries.length === 0) return undefined;
    return summarize(entries);
}

function persistInsert(route: RouteMeasurements, toolID: string, tokens: number): void {
    if (!persistenceDb) return;
    try {
        // Compile statement once per DB binding. `.run()` is reusable
        // across calls with different bound values.
        cachedInsertStmt ??= persistenceDb.prepare(
            `INSERT OR REPLACE INTO tool_definition_measurements
             (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        cachedInsertStmt.run(
            route.providerID,
            route.modelID,
            route.agentName,
            toolID,
            tokens,
            Date.now(),
        );
    } catch {
        // Persistence is best-effort. A SQLITE_BUSY or transient write
        // failure must not break the live measurement: the in-memory map
        // already has the new value. Drop the cached statement on error — if
        // the DB connection went bad, recompiling on the next attempt is the
        // safe move.
        cachedInsertStmt = null;
    }
}

/** Delete the route's stored rows for every tool not in `kept`, in one statement. */
function persistPrune(route: RouteMeasurements, kept: Iterable<string>): void {
    if (!persistenceDb) return;
    try {
        cachedPruneStmt ??= persistenceDb.prepare(
            `DELETE FROM tool_definition_measurements
             WHERE provider_id = ? AND model_id = ? AND agent_name = ?
               AND tool_id NOT IN (SELECT value FROM json_each(?))`,
        );
        cachedPruneStmt.run(
            route.providerID,
            route.modelID,
            route.agentName,
            JSON.stringify([...kept]),
        );
    } catch {
        // Best-effort, as for inserts: a stale row only affects the figure
        // shown after the next restart, until the route is measured again.
        cachedPruneStmt = null;
    }
}

/** OpenCode 1: close the open flight and forget tools outside the window. */
function startFlight(route: RouteMeasurements): void {
    route.flight += 1;
    route.open = new Set();
    const oldest = route.flight - (FLIGHT_WINDOW - 1);
    let pruned = false;
    for (const [toolID, slot] of route.tools) {
        if (slot.flight >= oldest) continue;
        route.tools.delete(toolID);
        pruned = true;
    }
    if (pruned) persistPrune(route, route.tools.keys());
}

/**
 * Register the database used to persist measurements. Called by
 * openDatabase() after runMigrations() has ensured the
 * `tool_definition_measurements` table exists. Subsequent measurements will
 * write through to SQLite.
 */
export function setDatabase(db: Database): void {
    persistenceDb = db;
    // New DB binding invalidates any cached statement compiled against the
    // previous handle.
    cachedInsertStmt = null;
    cachedPruneStmt = null;
}

/**
 * Populate the in-memory store from the `tool_definition_measurements` table.
 * Called once at startup after setDatabase(), before the first sidebar
 * snapshot or status query, so the sidebar's "Tool Defs" segment shows a
 * figure immediately on restart instead of 0.
 *
 * Loaded rows stand in for a route only until the host offers that route's
 * tools in this process; the first live measurement replaces them. Rows
 * written before stored sets were pruned can hold every tool a route was ever
 * offered, so they must not outlive that first measurement, and since this
 * process never measured their content they carry no fingerprint.
 *
 * Idempotent: re-running over the same DB reapplies the same values; the
 * per-route tool key ensures duplicates overwrite rather than accumulate.
 * Routes already measured in this process are left alone.
 */
export function loadToolDefinitionMeasurements(db: Database): void {
    let rows: Array<{
        provider_id: string;
        model_id: string;
        agent_name: string;
        tool_id: string;
        token_count: number;
    }> = [];
    try {
        rows = db
            .prepare(
                "SELECT provider_id, model_id, agent_name, tool_id, token_count FROM tool_definition_measurements",
            )
            .all() as typeof rows;
    } catch {
        // Table doesn't exist yet — migrations haven't run. Nothing to load.
        return;
    }

    for (const row of rows) {
        const { route } = routeFor(row.provider_id, row.model_id, row.agent_name);
        if (route.live) continue;
        route.tools.set(row.tool_id, {
            tokens: row.token_count,
            fingerprint: undefined,
            flight: LOADED_FROM_STORAGE,
        });
    }
}

/**
 * OpenCode 1: measure one tool the host is offering on the current request.
 * Called from the `tool.definition` plugin hook once per tool per flight.
 * `sessionId` is the session the request is believed to belong to (the hook
 * carries none); it only records which route that session last flew.
 */
export function recordToolDefinition(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    toolID: string,
    description: string,
    parameters: unknown,
    sessionId?: string,
): void {
    if (!providerID || !modelID || !toolID) return;
    const { key, route } = routeFor(providerID, modelID, agentName);

    // Flight bookkeeping runs before the fingerprint skip: an unchanged tool
    // must still be marked as offered on this flight.
    const now = Date.now();
    if (!route.live) {
        // First live fire for the route in this process: the rows loaded from
        // SQLite stop counting. Tools re-offered in this flight are measured
        // and written again.
        route.live = true;
        route.flight = 1;
        route.open = new Set();
        let loaded = false;
        for (const [id, slot] of route.tools) {
            if (slot.flight !== LOADED_FROM_STORAGE) continue;
            route.tools.delete(id);
            loaded = true;
        }
        if (loaded) persistPrune(route, route.tools.keys());
    } else if (route.open.has(toolID) || now - route.lastFireAt > FLIGHT_GAP_MS) {
        startFlight(route);
    }
    route.open.add(toolID);
    route.lastFireAt = now;
    if (sessionId) sessionFlights.set(sessionId, { key });

    // Fast-path skip: if this exact tool's last measurement carried an
    // identical fingerprint, tokenizing and writing would produce the same
    // result.
    const fingerprint = fingerprintFor(description ?? "", parameters);
    const slot = route.tools.get(toolID);
    if (slot && slot.fingerprint === fingerprint) {
        slot.flight = route.flight;
        return;
    }
    const tokens = measure(description ?? "", parameters);
    route.tools.set(toolID, { tokens, fingerprint, flight: route.flight });
    // Write-through to SQLite so the value survives a plugin restart.
    persistInsert(route, toolID, tokens);
}

/**
 * OpenCode 2: record the exact tool set one request carries. The route's set
 * becomes exactly `tools` (tools no longer offered are forgotten and their
 * stored rows deleted), and `sessionId`'s figure becomes this set until its
 * next request. Unchanged tools are not tokenized or written again.
 */
export function recordToolDefinitionSet(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    tools: Iterable<{ id: string; description: string; parameters: unknown }>,
    sessionId?: string,
): void {
    if (!providerID || !modelID) return;
    const { key, route } = routeFor(providerID, modelID, agentName);
    route.live = true;
    route.flight += 1;
    route.lastFireAt = Date.now();
    const next = new Map<string, ToolSlot>();
    const written: Array<[string, number]> = [];
    for (const tool of tools) {
        if (!tool.id) continue;
        const fingerprint = fingerprintFor(tool.description ?? "", tool.parameters);
        const previous = route.tools.get(tool.id);
        if (previous && previous.fingerprint === fingerprint) {
            next.set(tool.id, { ...previous, flight: route.flight });
            continue;
        }
        const tokens = measure(tool.description ?? "", tool.parameters);
        next.set(tool.id, { tokens, fingerprint, flight: route.flight });
        written.push([tool.id, tokens]);
    }
    const removed = [...route.tools.keys()].some((id) => !next.has(id));
    route.tools = next;
    route.open = new Set(next.keys());
    if (removed) persistPrune(route, next.keys());
    for (const [toolID, tokens] of written) persistInsert(route, toolID, tokens);
    if (sessionId) sessionFlights.set(sessionId, { key, exact: summarize([...next.entries()]) });
}

/**
 * Hash the tool names of the current tool set for one model/agent route.
 *
 * Tool names alone identify the prefix change this marker explains. Schema
 * fingerprints remain necessary for measurement de-duplication, but including
 * them here would add cost without improving cache-bust attribution. An empty
 * string is returned both before any measurement and for a request that
 * carried no tools; it does not tell those cases apart.
 */
export function getCurrentToolSetHash(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId?: string,
): string {
    return resolve(providerID, modelID, agentName, sessionId)?.hash ?? "";
}

/**
 * Hash the current tool set's IDs and full schemas so provider usage is reused
 * only for the same definitions. Undefined when a counted tool's content was
 * not measured in this process.
 */
export function getToolDefinitionMeasurementSignature(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId?: string,
): string | undefined {
    return resolve(providerID, modelID, agentName, sessionId)?.signature;
}

/**
 * Returns the measured tokens of the current tool set for a
 * `{provider, model, agent}` route, or `undefined` when never measured (e.g.
 * fresh session before first turn). With `sessionId`, an OpenCode 2 session
 * whose last request flew this route gets that request's exact set.
 */
export function getMeasuredToolDefinitionTokens(
    providerID: string,
    modelID: string,
    agentName: string | undefined,
    sessionId?: string,
): number | undefined {
    return resolve(providerID, modelID, agentName, sessionId)?.total;
}

/**
 * The tool-definition total of the route `sessionId` last flew: on OpenCode 2
 * the exact set of that session's last request, on OpenCode 1 the route's
 * recent-flight total. For a session whose current route has no
 * measurement yet (for example right after a model switch), this is the best
 * evidence of the tools it is offered; undefined when the session never had
 * its tools measured.
 */
export function getSessionToolDefinitionTokens(sessionId: string | undefined): number | undefined {
    if (!sessionId) return undefined;
    const flight = sessionFlights.peek(sessionId);
    if (!flight) return undefined;
    if (flight.exact) return flight.exact.total;
    const route = routes.get(flight.key);
    return route ? summarize(currentTools(route)).total : undefined;
}

/** Test helper: reset the store so suites don't leak measurements. */
export function __resetToolDefinitionMeasurements(): void {
    routes.clear();
    sessionFlights.clear();
    persistenceDb = null;
    cachedInsertStmt = null;
    cachedPruneStmt = null;
}

/** Inspection helper: snapshot each route's current set (for debug logging/tests). */
export function getToolDefinitionSnapshot(): Array<{
    key: string;
    totalTokens: number;
    toolCount: number;
}> {
    return Array.from(routes.entries()).map(([key, route]) => {
        const entries = currentTools(route);
        return { key, totalTokens: summarize(entries).total, toolCount: entries.length };
    });
}
