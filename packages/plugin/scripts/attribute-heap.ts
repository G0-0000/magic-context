#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DebugMemoryUsageResponse, DebugSessionHolderCount } from "../src/shared/rpc-types";

/**
 * Bun's JSC Inspector heap format is documented by the producer/consumer in
 * `oven-sh/bun/src/jsc/bindings/BunHeapProfiler.cpp`: Inspector nodes are flat
 * `[id, shallowSize, classNameIndex, flags]` tuples and edges are flat
 * `[fromId, toId, edgeTypeIndex, edgeNameOrIndex]` tuples. The string tables
 * resolve class, edge-type, and property/variable names. Inspector snapshots do
 * not contain function names, script URLs, source paths, or string contents.
 */
export interface JscHeapSnapshot {
    version: number;
    type: "Inspector";
    nodes: number[];
    nodeClassNames: string[];
    edges: number[];
    edgeTypes: string[];
    edgeNames: string[];
    magicContext?: {
        capturedAt?: number;
        memory?: DebugMemoryUsageResponse;
    };
}

export interface RetainedBucket {
    name: string;
    modulePath: string;
    count: number;
    shallowSize: number;
    retainedSize: number;
    largestRetainedSize: number;
}

export interface HeapAttributionAnalysis {
    snapshotVersion: number;
    nodeCount: number;
    edgeCount: number;
    shallowSize: number;
    rootRetainedSize: number;
    modulePathSignal: "unavailable-in-jsc-inspector";
    buckets: RetainedBucket[];
    attribution: {
        magicContext: number;
        host: number;
        unattributable: number;
    };
    sessions: DebugSessionHolderCount[];
}

const NODE_STRIDE = 4;
const EDGE_STRIDE = 4;
const NO_ENTRY = 0xffff_ffff;
const NO_MODULE_PATH = "<unavailable-in-jsc-inspector>";

// JSC exposes constructor/allocation class names but no source paths. These
// names are deliberately narrow: MC is a defensible lower bound, not a claim
// that generic Object/Array/string allocations belong to the host.
const MAGIC_CONTEXT_CLASS =
    /(?:MagicContext|ContextAuthority|SubcModuleTransport|OpenCodeRetrospectiveRawProvider|FailClosedBlockingError|MemoryAuthorityUnavailableError|RustTransformProtocolError|RawFallbackContextLimitError)/i;
const HOST_CLASS = /(?:OpenCode|Bun|WebSocket|Subprocess|Worker|SQLite|Database)/i;

type Attribution = 0 | 1 | 2;
const UNATTRIBUTABLE: Attribution = 0;
const MAGIC_CONTEXT: Attribution = 1;
const HOST: Attribution = 2;

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parseJscHeapSnapshot(text: string): JscHeapSnapshot {
    const value = JSON.parse(text) as Partial<JscHeapSnapshot>;
    if (value.type !== "Inspector") {
        throw new Error(
            `Unsupported heap snapshot type ${JSON.stringify(value.type)}; expected Bun/JSC Inspector`,
        );
    }
    if (!Number.isInteger(value.version) || (value.version ?? 0) < 2) {
        throw new Error(`Unsupported JSC heap snapshot version ${String(value.version)}`);
    }
    if (!isNumberArray(value.nodes) || value.nodes.length % NODE_STRIDE !== 0) {
        throw new Error("Invalid JSC nodes array (expected flat 4-number tuples)");
    }
    if (!isNumberArray(value.edges) || value.edges.length % EDGE_STRIDE !== 0) {
        throw new Error("Invalid JSC edges array (expected flat 4-number tuples)");
    }
    if (!isStringArray(value.nodeClassNames)) {
        throw new Error("Invalid JSC nodeClassNames string table");
    }
    if (!isStringArray(value.edgeTypes) || !isStringArray(value.edgeNames)) {
        throw new Error("Invalid JSC edge string tables");
    }
    return value as JscHeapSnapshot;
}

interface IdLookup {
    get(id: number): number | undefined;
}

function buildIdLookup(nodes: number[]): IdLookup {
    const nodeCount = nodes.length / NODE_STRIDE;
    let maxId = 0;
    for (let offset = 0; offset < nodes.length; offset += NODE_STRIDE) {
        const id = nodes[offset] ?? 0;
        if (!Number.isSafeInteger(id) || id < 0) {
            throw new Error(`Invalid JSC node id at tuple ${offset / NODE_STRIDE}: ${id}`);
        }
        maxId = Math.max(maxId, id);
    }

    // JSC IDs are normally dense. A typed lookup uses much less memory than a
    // Map on multi-million-node captures; sparse/adversarial IDs fall back.
    if (maxId <= Math.max(1_000_000, nodeCount * 8)) {
        const ordinals = new Int32Array(maxId + 1);
        ordinals.fill(-1);
        for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
            ordinals[nodes[ordinal * NODE_STRIDE] ?? 0] = ordinal;
        }
        return {
            get(id: number) {
                if (!Number.isSafeInteger(id) || id < 0 || id >= ordinals.length) return undefined;
                const ordinal = ordinals[id];
                return ordinal === -1 ? undefined : ordinal;
            },
        };
    }

    const ordinals = new Map<number, number>();
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
        ordinals.set(nodes[ordinal * NODE_STRIDE] ?? 0, ordinal);
    }
    return ordinals;
}

interface Graph {
    outgoingOffsets: Uint32Array;
    outgoingTargets: Uint32Array;
    incomingOffsets: Uint32Array;
    incomingSources: Uint32Array;
}

function prefixOffsets(degrees: Uint32Array, edgeCount: number): Uint32Array {
    const offsets = new Uint32Array(degrees.length + 1);
    let cursor = 0;
    for (let ordinal = 0; ordinal < degrees.length; ordinal += 1) {
        offsets[ordinal] = cursor;
        cursor += degrees[ordinal] ?? 0;
    }
    offsets[degrees.length] = cursor;
    if (cursor !== edgeCount) {
        throw new Error(`Heap graph edge count mismatch: indexed ${cursor}, expected ${edgeCount}`);
    }
    return offsets;
}

function buildGraph(snapshot: JscHeapSnapshot, ids: IdLookup): Graph {
    const nodeCount = snapshot.nodes.length / NODE_STRIDE;
    const edgeCount = snapshot.edges.length / EDGE_STRIDE;
    if (edgeCount > NO_ENTRY) throw new Error("Heap graph has more than 2^32-1 edges");
    const outgoingDegrees = new Uint32Array(nodeCount);
    const incomingDegrees = new Uint32Array(nodeCount);

    for (let offset = 0; offset < snapshot.edges.length; offset += EDGE_STRIDE) {
        const from = ids.get(snapshot.edges[offset] ?? -1);
        const to = ids.get(snapshot.edges[offset + 1] ?? -1);
        if (from === undefined || to === undefined) {
            throw new Error(`Heap edge ${offset / EDGE_STRIDE} references an unknown node id`);
        }
        outgoingDegrees[from] += 1;
        incomingDegrees[to] += 1;
    }

    const outgoingOffsets = prefixOffsets(outgoingDegrees, edgeCount);
    const incomingOffsets = prefixOffsets(incomingDegrees, edgeCount);
    const outgoingTargets = new Uint32Array(edgeCount);
    const incomingSources = new Uint32Array(edgeCount);
    const outgoingCursor = outgoingOffsets.slice(0, nodeCount);
    const incomingCursor = incomingOffsets.slice(0, nodeCount);

    for (let offset = 0; offset < snapshot.edges.length; offset += EDGE_STRIDE) {
        const from = ids.get(snapshot.edges[offset] ?? -1) as number;
        const to = ids.get(snapshot.edges[offset + 1] ?? -1) as number;
        outgoingTargets[outgoingCursor[from] ?? 0] = to;
        outgoingCursor[from] += 1;
        incomingSources[incomingCursor[to] ?? 0] = from;
        incomingCursor[to] += 1;
    }

    return { outgoingOffsets, outgoingTargets, incomingOffsets, incomingSources };
}

interface Dominators {
    postOrderToOrdinal: Uint32Array;
    ordinalToPostOrder: Uint32Array;
    immediateDominatorPostOrder: Uint32Array;
}

function buildPostOrder(graph: Graph, nodeCount: number): {
    postOrderToOrdinal: Uint32Array;
    ordinalToPostOrder: Uint32Array;
    reachable: Uint8Array;
} {
    const postOrderToOrdinal = new Uint32Array(nodeCount);
    const ordinalToPostOrder = new Uint32Array(nodeCount);
    const reachable = new Uint8Array(nodeCount);
    const stackNodes = new Uint32Array(nodeCount);
    const stackEdges = new Uint32Array(nodeCount);
    let top = 0;
    let postOrder = 0;
    stackNodes[0] = 0;
    stackEdges[0] = graph.outgoingOffsets[0] ?? 0;
    reachable[0] = 1;

    while (top >= 0) {
        const ordinal = stackNodes[top] ?? 0;
        const end = graph.outgoingOffsets[ordinal + 1] ?? 0;
        let edge = stackEdges[top] ?? 0;
        let descended = false;
        while (edge < end) {
            const target = graph.outgoingTargets[edge] ?? 0;
            edge += 1;
            stackEdges[top] = edge;
            if (reachable[target]) continue;
            reachable[target] = 1;
            top += 1;
            stackNodes[top] = target;
            stackEdges[top] = graph.outgoingOffsets[target] ?? 0;
            descended = true;
            break;
        }
        if (descended) continue;
        postOrderToOrdinal[postOrder] = ordinal;
        ordinalToPostOrder[ordinal] = postOrder;
        postOrder += 1;
        top -= 1;
    }

    // The root is last among reachable nodes. Move it after any malformed
    // unreachable records and attach those records directly to the root later.
    if (postOrder > 0 && postOrderToOrdinal[postOrder - 1] === 0) postOrder -= 1;
    for (let ordinal = 1; ordinal < nodeCount; ordinal += 1) {
        if (reachable[ordinal]) continue;
        postOrderToOrdinal[postOrder] = ordinal;
        ordinalToPostOrder[ordinal] = postOrder;
        postOrder += 1;
    }
    postOrderToOrdinal[postOrder] = 0;
    ordinalToPostOrder[0] = postOrder;
    postOrder += 1;
    if (postOrder !== nodeCount) {
        throw new Error(`Heap DFS indexed ${postOrder} of ${nodeCount} nodes`);
    }
    return { postOrderToOrdinal, ordinalToPostOrder, reachable };
}

function intersectDominators(first: number, second: number, idom: Uint32Array): number {
    let left = first;
    let right = second;
    let steps = 0;
    while (left !== right) {
        while (left < right) {
            left = idom[left] ?? NO_ENTRY;
            if (left === NO_ENTRY) return second;
        }
        while (right < left) {
            right = idom[right] ?? NO_ENTRY;
            if (right === NO_ENTRY) return first;
        }
        steps += 1;
        if (steps > idom.length * 2) throw new Error("Dominator intersection did not converge");
    }
    return left;
}

function computeDominators(graph: Graph, nodeCount: number): Dominators {
    const { postOrderToOrdinal, ordinalToPostOrder, reachable } = buildPostOrder(
        graph,
        nodeCount,
    );
    const rootPostOrder = nodeCount - 1;
    const idom = new Uint32Array(nodeCount);
    idom.fill(NO_ENTRY);
    idom[rootPostOrder] = rootPostOrder;
    for (let ordinal = 1; ordinal < nodeCount; ordinal += 1) {
        if (!reachable[ordinal]) idom[ordinalToPostOrder[ordinal] ?? 0] = rootPostOrder;
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (let postOrder = rootPostOrder - 1; postOrder >= 0; postOrder -= 1) {
            const ordinal = postOrderToOrdinal[postOrder] ?? 0;
            if (!reachable[ordinal]) continue;
            let next = NO_ENTRY;
            const start = graph.incomingOffsets[ordinal] ?? 0;
            const end = graph.incomingOffsets[ordinal + 1] ?? 0;
            for (let edge = start; edge < end; edge += 1) {
                const predecessor = graph.incomingSources[edge] ?? 0;
                const predecessorPostOrder = ordinalToPostOrder[predecessor] ?? 0;
                if (idom[predecessorPostOrder] === NO_ENTRY) continue;
                next =
                    next === NO_ENTRY
                        ? predecessorPostOrder
                        : intersectDominators(predecessorPostOrder, next, idom);
                if (next === rootPostOrder) break;
            }
            if (next !== NO_ENTRY && idom[postOrder] !== next) {
                idom[postOrder] = next;
                changed = true;
            }
        }
    }

    for (let postOrder = 0; postOrder < rootPostOrder; postOrder += 1) {
        if (idom[postOrder] === NO_ENTRY) idom[postOrder] = rootPostOrder;
    }
    return {
        postOrderToOrdinal,
        ordinalToPostOrder,
        immediateDominatorPostOrder: idom,
    };
}

function nodeClassName(snapshot: JscHeapSnapshot, ordinal: number): string {
    const index = snapshot.nodes[ordinal * NODE_STRIDE + 2] ?? -1;
    return snapshot.nodeClassNames[index] ?? "(unknown)";
}

function directAttribution(className: string): Attribution {
    if (MAGIC_CONTEXT_CLASS.test(className)) return MAGIC_CONTEXT;
    if (HOST_CLASS.test(className)) return HOST;
    return UNATTRIBUTABLE;
}

function retainedSizes(snapshot: JscHeapSnapshot, dominators: Dominators): Float64Array {
    const nodeCount = snapshot.nodes.length / NODE_STRIDE;
    const retained = new Float64Array(nodeCount);
    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
        retained[ordinal] = Math.max(0, snapshot.nodes[ordinal * NODE_STRIDE + 1] ?? 0);
    }
    for (let postOrder = 0; postOrder < nodeCount - 1; postOrder += 1) {
        const ordinal = dominators.postOrderToOrdinal[postOrder] ?? 0;
        const parentPostOrder = dominators.immediateDominatorPostOrder[postOrder] ?? (nodeCount - 1);
        const parent = dominators.postOrderToOrdinal[parentPostOrder] ?? 0;
        if (parent !== ordinal) retained[parent] += retained[ordinal] ?? 0;
    }
    return retained;
}

function attributedShallowSizes(
    snapshot: JscHeapSnapshot,
    dominators: Dominators,
): HeapAttributionAnalysis["attribution"] {
    const nodeCount = snapshot.nodes.length / NODE_STRIDE;
    const owner = new Uint8Array(nodeCount);
    const totals = { magicContext: 0, host: 0, unattributable: 0 };
    for (let postOrder = nodeCount - 1; postOrder >= 0; postOrder -= 1) {
        const ordinal = dominators.postOrderToOrdinal[postOrder] ?? 0;
        const direct = directAttribution(nodeClassName(snapshot, ordinal));
        if (direct !== UNATTRIBUTABLE) {
            owner[ordinal] = direct;
        } else if (postOrder !== nodeCount - 1) {
            const parentPostOrder = dominators.immediateDominatorPostOrder[postOrder] ?? (nodeCount - 1);
            owner[ordinal] = owner[dominators.postOrderToOrdinal[parentPostOrder] ?? 0] ?? 0;
        }
        const size = Math.max(0, snapshot.nodes[ordinal * NODE_STRIDE + 1] ?? 0);
        if (owner[ordinal] === MAGIC_CONTEXT) totals.magicContext += size;
        else if (owner[ordinal] === HOST) totals.host += size;
        else totals.unattributable += size;
    }
    return totals;
}

export function analyzeJscHeapSnapshot(snapshot: JscHeapSnapshot): HeapAttributionAnalysis {
    const nodeCount = snapshot.nodes.length / NODE_STRIDE;
    if (nodeCount === 0) throw new Error("Heap snapshot contains no nodes");
    const ids = buildIdLookup(snapshot.nodes);
    const graph = buildGraph(snapshot, ids);
    const dominators = computeDominators(graph, nodeCount);
    const retained = retainedSizes(snapshot, dominators);
    const buckets = new Map<string, RetainedBucket>();
    let shallowSize = 0;

    for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
        const name = nodeClassName(snapshot, ordinal);
        let bucket = buckets.get(name);
        if (!bucket) {
            bucket = {
                name,
                modulePath: NO_MODULE_PATH,
                count: 0,
                shallowSize: 0,
                retainedSize: 0,
                largestRetainedSize: 0,
            };
            buckets.set(name, bucket);
        }
        const shallow = Math.max(0, snapshot.nodes[ordinal * NODE_STRIDE + 1] ?? 0);
        const nodeRetained = retained[ordinal] ?? shallow;
        shallowSize += shallow;
        bucket.count += 1;
        bucket.shallowSize += shallow;
        bucket.retainedSize += nodeRetained;
        bucket.largestRetainedSize = Math.max(bucket.largestRetainedSize, nodeRetained);
    }

    return {
        snapshotVersion: snapshot.version,
        nodeCount,
        edgeCount: snapshot.edges.length / EDGE_STRIDE,
        shallowSize,
        rootRetainedSize: retained[0] ?? 0,
        modulePathSignal: "unavailable-in-jsc-inspector",
        buckets: [...buckets.values()].sort((a, b) => b.retainedSize - a.retainedSize),
        attribution: attributedShallowSizes(snapshot, dominators),
        sessions: snapshot.magicContext?.memory?.holders.sessions ?? [],
    };
}

function formatBytes(bytes: number): string {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function percent(part: number, total: number): string {
    return total === 0 ? "0.00%" : `${((part / total) * 100).toFixed(2)}%`;
}

export function renderHeapAttribution(
    analysis: HeapAttributionAnalysis,
    snapshotPath: string,
): string {
    const lines = [
        `Magic Context heap attribution: ${snapshotPath}`,
        `JSC Inspector v${analysis.snapshotVersion}: ${analysis.nodeCount.toLocaleString()} nodes, ${analysis.edgeCount.toLocaleString()} edges, ${formatBytes(analysis.shallowSize)} shallow heap`,
        "Dominator retained sizes use the Cooper-Harvey-Kennedy algorithm. Bucket retained totals overlap across dominator ancestry and do not sum to the heap total.",
        "Module/source signal: unavailable in Bun's JSC Inspector format (no function names, script URLs, source paths, or string contents). MC attribution is a constructor-name/dominator lower bound.",
        "",
        "Top 30 retained-size allocation buckets",
        "rank\tretained\tlargest\tshallow\tcount\tallocation/constructor\tmodule-path",
    ];
    analysis.buckets.slice(0, 30).forEach((bucket, index) => {
        lines.push(
            `${index + 1}\t${formatBytes(bucket.retainedSize)}\t${formatBytes(bucket.largestRetainedSize)}\t${formatBytes(bucket.shallowSize)}\t${bucket.count}\t${bucket.name}\t${bucket.modulePath}`,
        );
    });
    lines.push(
        "",
        "Exclusive attribution totals (each node's shallow bytes assigned once through its nearest recognized dominator)",
        `Magic Context\t${formatBytes(analysis.attribution.magicContext)}\t${percent(analysis.attribution.magicContext, analysis.shallowSize)}`,
        `Host\t${formatBytes(analysis.attribution.host)}\t${percent(analysis.attribution.host, analysis.shallowSize)}`,
        `Unattributable\t${formatBytes(analysis.attribution.unattributable)}\t${percent(analysis.attribution.unattributable, analysis.shallowSize)}`,
    );
    const magicContextBuckets = analysis.buckets
        .filter((bucket) => directAttribution(bucket.name) === MAGIC_CONTEXT)
        .sort((left, right) => right.retainedSize - left.retainedSize);
    if (magicContextBuckets.length > 0) {
        lines.push(
            "",
            "Magic Context named-holder retained buckets (non-additive when holder dominator subtrees overlap)",
            "retained\tshallow\tcount\tholder",
        );
        for (const bucket of magicContextBuckets) {
            lines.push(
                `${formatBytes(bucket.retainedSize)}\t${formatBytes(bucket.shallowSize)}\t${bucket.count}\t${bucket.name}`,
            );
        }
    }
    if (analysis.sessions.length > 0) {
        lines.push(
            "",
            "Per-session Magic Context holders (capture-time RPC metadata; JSC omits Map key string values)",
            "session\tlkg\ttagger assignments\ttool accounting\twire raw\twire output\twire snapshots",
        );
        for (const session of analysis.sessions) {
            lines.push(
                `${session.sessionId}\t${formatBytes(session.lkgBytes)}\t${session.taggerAssignments}\t${session.taggerToolAccounting}\t${session.wireRawMessages}\t${session.wireMessages}\t${session.wireContentSnapshots}`,
            );
        }
    }
    return lines.join("\n");
}

export function attributeHeapFile(snapshotPath: string): HeapAttributionAnalysis {
    return analyzeJscHeapSnapshot(parseJscHeapSnapshot(readFileSync(snapshotPath, "utf8")));
}

if (import.meta.main) {
    const snapshotPath = process.argv[2];
    if (!snapshotPath || process.argv.length !== 3) {
        console.error("Usage: bun scripts/attribute-heap.ts <snapshot.heapsnapshot>");
        process.exit(2);
    }
    const absolutePath = resolve(snapshotPath);
    try {
        console.log(renderHeapAttribution(attributeHeapFile(absolutePath), absolutePath));
    } catch (error) {
        console.error(`attribute-heap: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
