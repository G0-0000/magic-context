# Serve native-memory attribution (2026-09-11)

## Result

Bun/JSC's Inspector snapshot cannot attribute the missing RSS: it has no source paths, and the
round-1 constructor lower bound covered only 198 KiB of a 202 MiB JS heap. The useful next probe is
`debug.memoryUsage`, which now returns process `external`/`arrayBuffers`, every live SQLite handle and
its PRAGMAs, tokenizer/runtime load state, serialized model bytes, LKG bytes, Rust wire-cache size,
and active message-index buffer size.

The 2,000-message hermetic A/B produced:

| scenario | RSS MiB | delta vs hooks-off | heapTotal MiB | external MiB | arrayBuffers MiB | SQLite cache upper bound | LKG | local model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| hooks off | 2,032.7 | 0.0 | 362.6 | 46.4 | 0.3 | 0 | 0 | off |
| MC on, embeddings off | 1,364.9 | -667.8 | 461.5 | 62.2 | 0.4 | 71.8 MiB | 3.7 MiB | off |
| MC on, embeddings on | 2,283.3 | +250.6 | 479.6 | 270.0 | 197.1 | 71.8 MiB | 3.7 MiB | 86.9 MiB, loaded native |

The hooks-only pair is not an additive attribution: the separate cold serves varied by 668 MiB in
the opposite direction while the MC-on heap was larger. It demonstrates that a one-shot RSS delta
is dominated by host/JSC allocator state. The controlled embedding feature delta is still strong:
turning local embeddings on over the MC-on baseline added **918.4 MiB RSS**, 207.8 MiB external, and
196.7 MiB array buffers. The ONNX load-time counter observed +199.6 MiB RSS, +350.8 MiB external, and
+267.8 MiB array buffers while loading an 86.9 MiB serialized model; load-time deltas are signed,
approximate, and can include concurrent host work.

Shadow embedding was not run in the TypeScript fixture because it requires a hermetic subc/Synapse
lane. Run the same script with `MC_E2E_MODE=rust` to add the shadow row. The script prints both the
human table and raw counters:

```sh
bun --cwd packages/e2e-tests run measure:native-memory
```

## SQLite connections in an OpenCode serve

All production TypeScript constructors pass through `src/shared/sqlite.ts`, so the live call counts
handles even when they are opened outside `storage-db.ts`.

| handle/path | lifetime | tuning and upper-bound formula |
| --- | --- | --- |
| `context.db` main writer (`storage-db.ts`) | process-wide, one per distinct explicit DB path; normally one | configured `cache_size=-65536` KiB = **64 MiB** per handle; `mmap_size=0` by default |
| `opencode.db` cached read-only session reader (`read-session-db.ts`) | process-wide after first history read | runtime default `cache_size=2000` pages; observed page size 4,096, so **7.8125 MiB** |
| `opencode.db` cached compaction-marker writer (`compaction-marker.ts`) | process-wide after first marker write | not passed through MC tuning; default `2000 * page_size`, observed **7.8125 MiB** |
| `opencode.db` dreamer/session-project reader (`open-opencode-db.ts`) | transient, explicitly closed after scan | default `2000 * page_size`, observed **7.8125 MiB** while open |
| `context.db` transform-decision writer (`transform-decision-log.ts`) | transient synchronous write, then close | default `2000 * page_size`, observed default implies **7.8125 MiB** while open |
| legacy `context.db` migration source | boot-only, then close | default cache while migration copies rows |

The steady-state formula observed by the harness was `64 MiB + 2000 * 4096 = 71.8125 MiB` for two
handles. After the marker writer opens it is approximately 79.625 MiB. A concurrent transient reader
or decision writer raises it by about 7.8125 MiB. These are configured cache ceilings, not committed
or resident bytes. A positive `PRAGMA cache_size` is pages multiplied by `page_size`; a negative value
is KiB directly. `sqlite3_status()` and `sqlite3_db_status()` are not exposed by Bun's or Node's
SQLite API, and the RPC says `sqliteStatusApi: "unavailable"` rather than pretending the ceiling is
residency.

`tool-owner-backfill.ts` temporarily `ATTACH`es `opencode.db` to the main connection. That is not a
new SQLite connection, but the attached database has its own pager/cache while attached. The four
FTS5 virtual tables (`primers_fts`, `memories_fts`, `message_history_fts`, `git_commits_fts`) also do
**not** open four connections. Their postings and shadow tables occupy `context.db` pages and compete
inside the main connection's cache. The live call reports `fts5TableCount` (four in the harness).

WAL and SHM are separate mappings/files. The call reports current sidecar file sizes per handle; the
A/B observed 0.07–2.7 MiB WAL files and one 32 KiB SHM file per database. File size is only a mapping
or page-cache bound, not private RSS, and the OS can share physical pages between two mappings of the
same sidecar. `page_count`, `freelist_count`, and `page_size` describe database footprint, not RSS.
Configured `mmap_size` is zero, so database-file mmap cannot explain gigabytes unless the live call
shows a different value or many leaked handles.

Prepared statements and SQLite/FTS scratch allocations are native to the SQLite runtime. Many
modules cache statements in `WeakMap<Database, Statement>`, but no runtime API exposes their byte
count. They are bounded by the small live-handle count and are a secondary suspect unless the call
shows connection growth.

## Other native/out-of-heap owners

### Tokenizer

`read-session-formatting.ts` lazily loads `ai-tokenizer` and the Claude vocabulary. The RPC reports
load state and the transitive serialized encoding chunks, **2,349,411 bytes (2.24 MiB)** in this
install. An isolated first-use probe moved RSS by 76.8 MiB, heap used by 12.0 MiB, and external by
9.4 MiB. That process delta includes module parse/JIT and allocator granularity, but it bounds the
one process-wide tokenizer far below gigabytes. It does not multiply per session.

### Local embeddings / ONNX

`embedding-local.ts` loads either `onnxruntime-node` or ONNX WebAssembly and creates a Transformers
feature-extraction pipeline. The native runtime owns model weights, graph optimizations, tensor
arenas, worker threads/stacks, and temporary input/output tensors; WASM owns a linear memory reported
mostly as external/array-buffer memory. ONNX exposes no arena-residency counter here, so the RPC
reports:

- loaded provider count, unique models, and native/WASM mode;
- serialized bytes under MC's model-cache directory (86.9 MiB for MiniLM in the A/B); and
- process RSS/external/array-buffer deltas captured around each successful load.

`project-embedding-registry.ts` keeps one provider per registered project and has no process-wide
provider cap. Multiple live projects can therefore create multiple ONNX sessions for the same model.
This is the leading MC-native explanation for multi-gigabyte RSS. On the 10.5 GiB serve, first check
`native.localEmbedding.providerCount`, `models`, `runtimes`, and load deltas. Ten providers at the
observed 0.2–0.9 GiB each are plausible; one provider alone is not enough.

### QuickJS smart-note sandbox

`smart-notes/sandbox-runner.ts` lazily loads one process-wide asyncify QuickJS WASM module. Each check
gets a disposable context with an 8 MiB heap limit and 512 KiB stack limit. An isolated first check
moved RSS by 38.2 MiB, external by 34.3 MiB, and array buffers by 16 MiB. The RPC reports attempted vs
successfully loaded. A single shared module cannot plausibly account for 10.5 GiB unless contexts are
leaking; normal contexts are disposed after each check.

### LKG snapshots

`lkg-slot.ts` stores `jsonPrefix` and digest arrays as JS strings/arrays, not retained `Buffer`s. Its
accounting is an estimated UTF-16 size, hard-capped at **64 MiB process-wide** and **24 MiB per slot**.
The A/B held one 3.7 MiB slot. SQLite persistence temporarily binds serialized values but durable LKG
bytes become database pages/cache. The live per-session `lkgBytes` sum therefore rules LKG out above
64 MiB in this implementation. It contributes to JS heap, not hidden native RSS.

### Rust adapter wire/delta state

The serve-side Rust adapter retains one `RustWireCache` per session: content-field snapshots,
fingerprints, and the previous native output array. Those are JS objects/strings/arrays, not retained
Buffers. `module-wire.ts` creates a `Buffer` only transiently while chunking a serialized oversized
item. The new `wireCache.estimatedBytes` counter sums field strings and serialized native output by
session. The subc client's socket implementation can have transient native network buffers, while
the Rust module/store itself runs in the separate supervised daemon and is not part of the OpenCode
serve's RSS. A large wire estimate should appear in JS heap; it is not a good explanation for a
large RSS-minus-heap gap.

### Message-index reconciliation

The reconciler normally reads bounded pages of 100 raw messages. A legacy provider without
`readPage` can retain one full-session fallback snapshot until reconciliation ends. Both forms are JS
objects/strings. The RPC reports active retained message count and serialized bytes; after the A/B
both were zero. `completedIncrementalKeys` can grow with revisions (about 2,500 entries for the
2,000-message run) but is also JS heap. FTS index content lives in SQLite pages covered above.

### Files and other transient buffers

There is no production `Bun.file()` use in the plugin source; the only occurrences are tests. Session
and config reads use Node filesystem APIs and return ordinary JS strings/Buffers, not persistent
mmaps. Image dimension parsing, M0/M1 materialization, RPC JSON, heap-snapshot streaming, and
WebSocket/module framing create transient `Buffer`/`Uint8Array` objects already reflected in
`arrayBuffers`/`external`. The heap-snapshot endpoint itself should not be used while measuring the
steady state because capture allocates diagnostic output.

## What can explain a 10.5 GiB live serve?

1. **Multiple loaded local embedding providers / ONNX arenas** — plausible and the top MC suspect.
   Check provider count and per-load deltas first; temporarily set `embedding.provider: off`, restart,
   and compare the same workload.
2. **Host/OpenCode/JSC native retention unrelated to MC** — also plausible. Hooks-off reached 2.0 GiB
   for only 2,000 messages and exceeded the embeddings-off MC process, proving large run-to-run host
   variance. Compare repeated cold pairs or OS PSS/VM-region data before assigning the full RSS delta.
3. **SQLite connection leak or changed tuning** — plausible only if the live call shows dozens of
   handles, nonzero multi-gigabyte `mmap_size`, or unexpectedly large per-connection caches. Normal
   steady-state bounds are under 80 MiB plus small WAL/SHM mappings.
4. **Rust wire/session holders and message-index state** — can scale with many sessions but live on the
   JS heap and are directly visible in the holder table. Check unusually large session arrays or queue
   counts, but they do not naturally explain RSS far above heap.
5. **Tokenizer, QuickJS, and LKG** — cannot explain gigabytes under current caps and measured sizes:
   roughly 77 MiB tokenizer first-use RSS, 38 MiB shared QuickJS first use, and at most 64 MiB LKG.

For the live restart, capture `debug.memoryUsage` before any embedding/search/smart-note work, after
first use, and after opening several project sessions. Growth in `providerCount` with stepwise
RSS/external jumps identifies ONNX multiplication; growth in `connectionCount` identifies SQLite
leakage; flat MC counters with rising RSS points back to OpenCode/Bun or another plugin.
