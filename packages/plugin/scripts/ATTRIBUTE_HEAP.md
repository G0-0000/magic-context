# Heap attribution instrument

`attribute-heap.ts` analyzes the JSC heap snapshots produced by the opt-in
`debug.heapSnapshot` RPC:

```sh
bun packages/plugin/scripts/attribute-heap.ts /path/to/snapshot.heapsnapshot
```

## Bun/JSC format

The implementation follows Bun's own consumer in
`src/jsc/bindings/BunHeapProfiler.cpp` and validates the shape before analysis.
For an `Inspector` snapshot, `nodes` is a flat sequence of four-number tuples:

1. node id
2. shallow byte size
3. index into `nodeClassNames`
4. flags

`edges` is a flat sequence of four-number tuples:

1. source node id
2. target node id
3. index into `edgeTypes`
4. property/variable name index into `edgeNames`, or the numeric array index

Bun 1.4.2 emits JSC Inspector version 3. Bun's public API documents the same
arrays and `Inspector` type (older releases emitted version 2). The analyzer
accepts version 2 or newer and rejects non-Inspector snapshots.

The JSC Inspector payload has no function names, source URLs, module paths, or
string contents. Therefore module-path attribution cannot be recovered from the
snapshot. Magic Context attribution is intentionally reported as a lower bound:
recognized Magic Context constructor nodes and the objects they dominate.
Recognizable host runtime constructors are reported separately; generic
`Object`, `Array`, `string`, closures (`Function`), and similar nodes stay
unattributable rather than being guessed. The RPC adds capture-time per-session
holder counts as a top-level `magicContext` metadata field because the JSC graph
cannot reveal Map key string values.

## Retained size

The analyzer computes immediate dominators with the Cooper-Harvey-Kennedy
algorithm, matching the algorithm in Bun's heap profiler source, then folds each
node's shallow bytes into its immediate dominator. The top-30 table groups these
per-node retained sizes by JSC allocation/constructor class. Grouped retained
sizes overlap when one constructor's instances dominate another constructor's
instances, so that table is diagnostic ranking rather than an additive total.
The MC/host/unattributable totals are additive: every node's shallow bytes are
assigned exactly once through its nearest recognized dominator.

The implementation uses typed CSR adjacency arrays and a dense typed node-id
lookup when JSC ids permit it. The initial `JSON.parse` still requires memory
proportional to snapshot text; run attribution as a separate process after the
snapshot is captured, not inside the memory-heavy serve.
