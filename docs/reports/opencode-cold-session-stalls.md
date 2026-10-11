# OpenCode cold-session serving-thread stalls

## Change and serving contract

File-backed canonical counts are now guarded at the common count primitive, not
only at transform startup. A worker builds exact rank checkpoints every 256
**stored** rows, including excluded summaries, plus the exact total. The serving
thread uses binary search and a bounded suffix query. A cold synchronous lookup
can inspect at most 513 indexed keys; if that is insufficient it starts preparation
and throws `RawOrdinalsNotReady`, never falling through to the full-prefix SQL.
The small-prefix fallback is exact, not an estimated ordinal. In-memory test
stores retain the direct path because another connection cannot read them.
Native Bun handles are recognized by their filename as well as tracked handles.

Every store commit invalidates the ranks. The worker can reuse summary candidates
from an earlier snapshot, so a new rank calculation normally reads the index and
only new message JSON / known summaries, not every old message again. Rank
installation requires the serving connection's original store stamp and session
epoch to remain unchanged. Each connection gets its own scan: SQLite
`data_version` is connection-local and cannot certify another connection's
snapshot. Stale candidates remain useful as a worker seed; stale ranks never serve.

Caller inventory:

- `canonicalOrdinalOf` serves both raw-message-by-ID and ordinal-by-ID readers;
  both reach the guarded `countCanonicalOrdinalsIndexed` primitive.
- The session total reaches that same primitive. The raw `has` fallback also
  reaches the guarded by-ID reader.
- `read-session-chunk.ts` attaches `prepareRawSessionOrdinals` to both full/paged
  source readers and the single-message indexing source. Preparation awaits at
  most 250 ms asynchronously, while the worker continues afterward.
- Incremental indexing and reconciliation defer / retry when preparation says
  false. A session cleared while an index worker runs cancels admission and
  prevents an uncommitted replacement from reviving its FTS rows.
- Historian reads fail through their existing cleanup path when preparation is
  unavailable. Explicit `ctx_expand`, recomp and wrapup return a documented
  warming/deferred result after the bounded wait instead of running a count.
- Transforms still attempt preparation every pass. A required unavailable rank
  degrades the pass to the existing last-good replay/refusal path; no approximate
  coordinate is served. A session first opened hours after startup gets the same
  preparation and primitive guard as the first session.

Tag-owner cold builds, ratio changes and full invalidation rebuilds use the same
worker entry/lifecycle as ordinal preparation. A serving-thread read may only fold
bounded appends, not build the digest. The summary records the global tag high
watermark so a session's old last tag does not cause a scan through millions of
other sessions' newer rows. Existing foreign-commit shape/revision checks and
append tolerance remain intact. Foreign-commit shape counts run on the worker;
only bounded appended/adopted rows are returned, not copies of the cached maps.
This matters because off-thread indexing now commits from another connection.
Builds run in one read snapshot; installation
uses the validated **original** serving stamp, not a later version that could
accidentally certify an old digest. Previously cached prose ratios are folded
again on the worker, preserving the bounded ratio cache.

A defer pass starts preparation without awaiting it and skips the new trigger
projection while ownership is unknown. Postprocess skips fresh budget-based
removal and still replays persisted reasoning IDs / the materialized watermark.
A cache-busting pass may await 250 ms before the trigger and another 250 ms after
tagging when postprocess actually has permission for routine cleanup, since
late permission and tagging can invalidate the digest. If still cold, it keeps the
previous materialized cutoff (or no removal on a first touch), rather than pricing
missing owners as zero or inventing another engine cutoff. The wait is asynchronous;
it does not block OpenCode's event loop. Once ready, the unchanged engine computes
the fresh cutoff with unchanged grouping/pricing logic against the owner and
estimate maps used by base revision 881fa02095f56ed2156b35195258447566a51669.

Incremental FTS indexing now executes its complete SQLite transaction on the
worker. The main per-session queue awaits completion, then updates its tracking.
The worker uses the same WAL/NORMAL durability policy and preserves the originating
OpenCode/Pi/OMP harness. Pi packaging now emits the worker too. SQLite is closed
**before** posting success, because the receiver can terminate the worker on receipt.
This also avoids reusing a fixture/store path while a terminated thread still owns
its SQLite handle. Writer diagnostics split `end_ms` from acquisition/hold time.

## Profiler input and attribution

The read-only inputs were under
`~/.local/share/cortexkit/magic-context/host-profiler/`:

- `stall-2026-10-11T02-18-24.656Z.json`: 4,128 ms lag, raw by-ID count, 317 samples.
- `stall-2026-10-11T02-18-48.561Z.json`: 15,609 ms lag, owner projection, 948 samples.
- `stall-2026-10-11T02-19-06.317Z.json`: 6,465 ms lag, mixed COMMIT/embedding work.

No live database or config was opened, migrated or written. The third window was mixed:
`endWriterTransaction` / incremental COMMIT had 228 samples, but project-commit
embedding loading also had 183, plus other embedding reads. The 6.5 s window
therefore must not be reported as 6.5 s of COMMIT alone.

The identity-revision TEMP trigger runs during tag UPDATE statements, not COMMIT.
`indexSingleMessage` does not write tags. Its immediate transaction already owns
the WAL writer lock before COMMIT; lock acquisition happens at BEGIN, not in
`endWriterTransaction`. The wrapper has no per-row invalidation hook at COMMIT.
The fixture's slow COMMITs were native FTS merge work, not lock acquisition:
with identical data, disabling merge work reduced the COMMIT maximum from
327–352 ms to below 0.86 ms, while BEGIN stayed below 0.33 ms and tag revisions
never moved. The default-settings fixture is separately reported below. The exact
live native sub-operation (FTS merge versus checkpoint/I/O) cannot be recovered
from a sampling stack. Live OpenCode and Magic Context databases were excluded
from access to avoid disturbing the operator's stores. `end_ms` measures elapsed
time in the native COMMIT/END/ROLLBACK call, separately from BEGIN acquisition and
total writer hold time; it does not by itself distinguish FTS from disk I/O.
Either native cost is now off the serving thread.

## Reproduction and measurements

Linux 8 vCPUs, Bun **1.4.2**, base **881fa02095f56ed2156b35195258447566a51669**.
The same driver imported extracted base source for "before" and the modified
worker/checkpoint implementation on branch
`alfonso/task/bg_c399011e1ec6641d-opencode-stalls-on-the-real-store-tag-owner-cold`
for "after". There were two sessions in one process, each with 160,000 messages and
four tags per message. Both metadata and text parts had **17,490-byte** payloads.
The OpenCode-shaped file was **11,437,793,280 bytes**; the context file was
**6,647,513,088 bytes**, and the default-FTS file **6,647,590,912 bytes**.

All roots (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, SQLite temp) were
under `/motor-home/tmp/magic-context/bg_c399011e1ec6641d/`. Before fixture setup
and every raw-reader, owner-projection and index measurement, the driver ran
`lsof -p <pid> -Fn`, extracted all `.db`/WAL/SHM paths and rejected any path outside
that canonical throwaway root. Host PIDs 4, 33, 82, 279, 319 and 534 listed
only throwaway `.db`, `.db-wal` and `.db-shm` paths. No package suite exported
`OPENCODE_DB`.

Between cold paths the serving handle was closed or shrunk, WAL checkpointed,
then the file was fsynced and evicted with `posix_fadvise(DONTNEED)`. A fresh
private mmap plus `mincore` verified **zero resident pages** before every cold
measurement: 2,792,430 pages for OpenCode and 1,622,928 / 1,622,947 for context.
The second session was a cold first touch in the already-running process, not a
restart-only test. Its `opened-hours-later` label denotes a later first touch;
the driver did not wait hours between sessions.

Numbers below are longest main-thread blocks in ms, measured with a 2 ms ticker
and the gap between the last ticker callback (or operation start) and operation
completion. The reported maximum is the greater of that final gap and all ticker
gaps. Worker total latency is not mistaken for a block.

| Path | First session before → after | Later first touch before → after |
|---|---:|---:|
| Raw by-ID cold ordinal | 3498.67 → **16.66** | 4989.53 → **15.26** |
| Raw by-ID warm ordinal | 0.30 → 0.16 | 0.13 → 0.23 |
| Tag owner cold projection | 3650.36 → **161.87** | 3959.94 → **57.91** |
| Tag owner warm projection | 51.01 → 1.61 | 1.08 → 1.55 |
| Tag owner cold full rebuild | 6002.86 → **57.27** | 2566.89 → **48.03** |
| Incremental index cold, merge-heavy history | 3600.76 → **2.30** | 5.13 → **2.06** |
| Incremental index warm, worst of next 63 writes | 327.59 → **5.49** | 352.33 → **3.60** |
| Incremental index cold, default FTS history | 5.27 → **3.51** | 11.29 → **2.06** |
| Incremental index warm, default FTS worst | 5.10 → **3.95** | 10.88 → **3.53** |

The merge-heavy history was built with automerge=0/crisismerge=64, then restored
to SQLite's default automerge=4/crisismerge=16 before indexing. It is a controlled
pending-segment stress case, not a claim that the real store disables merging.
A second equally large file was built and measured with defaults throughout.
The no-merge control used automerge=0/crisismerge=64 on the same stress history;
its COMMIT maxima were 0.814 and 0.851 ms (versus 327.381 and 352.194 ms above).
The default-history COMMIT maxima were 4.920 and 10.669 ms. Every after run
recorded **zero BEGIN/COMMIT executions on the main handle**.

The first stress cold index block included work before COMMIT (its first COMMIT
was only 0.736 ms); it is deliberately not attributed entirely to COMMIT. The
subsequent 327–352 ms blocks were timed inside native COMMIT. The original live
6.5 s amplitude was not reproduced on the default-history fixture; the worker
boundary is exercised there anyway. It adds roughly 25–33 ms asynchronous
completion latency per incremental write, while eliminating main-thread commit
and merge work.

Both implementations returned ordinal **159840** and reasoning cutoff **639028**
for both cold sessions and both rebuilds. The first indexed document's checked
content matched the source, and all 64 incremental writes per session extended the prefix.
Existing full-read tag differential assertions and the 6,000-step ordinal
variants retain independent full-count oracles; the new bounded file-reader path
also fixes the small-session tests `a finished summary moved into an already
warm session must be excluded` and `6,000-step differential: session moves must
also match the old whole-prefix count`. They previously used `test.failing`
because moving a summary into a warm destination bypassed candidate discovery.
Bounded file reads now inspect those small prefixes directly, so both properties
pass without changing their independent oracle.

## Reproduce the driver

Run in one Linux job so its throwaway fixtures and build inputs remain available:

```sh
mkdir -p packages/plugin/scripts/perf-audit/.cold-baseline
git archive 881fa02095f56ed2156b35195258447566a51669 packages/plugin/src |
  tar -x -C packages/plugin/scripts/perf-audit/.cold-baseline
export COLD_ROOT="${TMPDIR:-/tmp}/magic-context/cold-session-probe"
COLD_PREPARE=1 bun packages/plugin/scripts/perf-audit/cold-session-cost.ts
COLD_LABEL=before COLD_SRC="$PWD/packages/plugin/scripts/perf-audit/.cold-baseline/packages/plugin/src" \
  bun packages/plugin/scripts/perf-audit/cold-session-cost.ts
COLD_LABEL=after bun packages/plugin/scripts/perf-audit/cold-session-cost.ts
COLD_LABEL=before COLD_INDEX_ONLY=1 COLD_DEFAULT_FTS=1 \
  COLD_SRC="$PWD/packages/plugin/scripts/perf-audit/.cold-baseline/packages/plugin/src" \
  bun packages/plugin/scripts/perf-audit/cold-session-cost.ts
COLD_LABEL=after COLD_INDEX_ONLY=1 COLD_DEFAULT_FTS=1 \
  bun packages/plugin/scripts/perf-audit/cold-session-cost.ts
COLD_LABEL=before COLD_INDEX_ONLY=1 COLD_NO_MERGE=1 \
  COLD_SRC="$PWD/packages/plugin/scripts/perf-audit/.cold-baseline/packages/plugin/src" \
  bun packages/plugin/scripts/perf-audit/cold-session-cost.ts
```

The source extraction and fixtures are disposable, not delivery artifacts. The
branch does not include extracted base code or database files. The package test
commands must run separately without the driver's `OPENCODE_DB` environment.

## Fixture/tool issues and limits

Initial commands `COLD_PREPARE=1 bun packages/plugin/scripts/perf-audit/cold-session-cost.ts`
under the root shown above failed with `SQLiteError: database or disk is full`,
`SQLITE_FULL`, at message batch 3,000. The exception was on **tag INSERT**, not
part INSERT; 142,893,056 bytes was the *OpenCode* file's size, while the failing
context file was 64,843,776 bytes. Free disk was about 261 GB, ulimit -f unlimited,
and SQLite temp was inside the throwaway root. The OpenCode connection read
max_page_count=4294967294; this was not evidence of a limit on the context handle.

A parent-approved niced Mac diagnostic attempt failed identically. Read-only
inspection of that throwaway context file showed max_page_count=1073741823,
12,000 tags, 1,002 FTS segments and the fixture's automerge=0/crisismerge=10000.
Disabling crisis merging beyond FTS's available segment IDs had produced
SQLITE_FULL; it was a **fixture configuration error, not a MOTOR disk cap or a
Magic Context product bug**. The 198 MB partial Mac fixture was deleted, and no
successful native-Mac measurement is claimed. With the parent's approval the
final reproduction returned to Linux, used crisismerge=64 for the stress-history
builder, and separately measured an unchanged-default FTS history. It completed
successfully on the multi-GB stores. No `sudo purge` or live-store access was used.

The default-history fixture did not reproduce the live COMMIT amplitude. The
reported controlled merge timings distinguish native work from acquisition, but
not the exact native operation in the historical live capture. The 183-sample
project-embedding load and the synchronous paged-reconciliation transaction path
are outside this change's three specified paths and remain follow-up candidates.

## Verification

All build/test/typecheck/lint gates ran on Linux 8c with Bun 1.4.2.

- `bun run build`: passed; OpenCode, standalone v2, Pi and CLI bundles emitted
  (707 / 749 / 1011 / 412 modules respectively); nine TUI outputs unchanged.
- `bun run --cwd packages/plugin test`: **7679 passed, 20 skipped, one existing
  baseline failure**, across 775 files. The failing test was
  `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`:
  its temporary bundle cannot resolve `onnxruntime-web/webgpu`. Its test, build
  and probe scripts, temp helper and lockfile are unchanged from base. This same
  remote-resolution failure is documented in `docs/reports/issue-653-review.md`
  and `docs/reports/oc-stall-fixes-review.md`. The gate ran after building artifacts;
  all worker load/packaging tests and all affected behavior tests passed.
- Focused historian, tag-summary, cold-session, trigger and index-staleness checks:
  102 passed, zero failed, six files. Caveman byte-replay checks also passed before
  the complete plugin run. The full suite includes three independent 6,000-step
  ordinal differential variants and the existing full-read tag-map comparisons.
- `bun run --cwd packages/pi-plugin test`: 1921 passed, ten skipped, zero failed,
  196 files. Both suites ran frozen install: 1013 installs / 1254 packages checked,
  no dependency or lockfile changes. Pi's manifest change is packaging-only.
- `bun run typecheck`: passed for four packages; TypeScript 5.9.3. This gate is
  silent on success and exited zero.
- `bun run lint`: passed, Biome 2.5.1, 1808 files checked across four packages;
  existing warnings remain, no new warning added by this change.
- Comment/prose review examined 27 of 28 changed files (JSON manifest excluded),
  and its two comment / eight prose clarity findings were addressed.

The package's normal TypeScript selection excludes test files. A temporary
configuration also typechecked the new cold-session test plus five edited tag /
rank differential files; all six passed with TypeScript 5.9.3. Initially including
`raw-ordinal-warmup.test.ts` exposed three pre-existing TS2349 errors in its
unchanged `Database | UnwrappedDatabase` helper calls to `prepare`; that file was
excluded from the extra test-only check, not edited to hide a runtime failure.
The temporary configuration was removed before delivery. Scoped inspection of
six production files had authoritative diagnostics with zero errors/warnings;
call-graph-derived categories remained unavailable, not claimed clean.

Three isolated mutation controls proved the silent serving-thread fences are
observable. Each control staged the live files first, applied a two-insertion /
one-deletion mutation, ran one exact-name test, restored from the index, touched
the restored file, and verified an empty working diff. Each negative run had one
failure and seven filtered-out tests, with no other failure:

| Neutralized control | Exact red test |
|---|---|
| File-store count primitive's host-thread guard | `cold raw point, ordinal and total readers cannot execute an unbounded count` |
| Cold owner-digest host-thread guard | `cold and invalidated tag digests read no owner rows on the serving thread` |
| File-store off-thread index delegation | `incremental FTS COMMIT executes on the worker and persists identical source bytes` |

After restoring all controls, the full cold-session file and both indexing
regression files passed: **27 tests, zero failures, 124 assertions**, followed by
package TypeScript 5.9.3 typecheck and Biome 2.5.1 lint (1371 files). No mutation
remains in the source. This final narrow run also covers the teardown-epoch checks
that prevent an old source-preparation result from retrying work after teardown.
