# Cold-stall correctness corrections

Follow-up to `9fd10c8085893746aca06b9d68f97473a118654b` and independent review
`1107f2e00fc0ab7808e3c9ddd2385ada02f33477` (cherry-picked as `cfd9a89c9f`). The
review report and witness expectations were not changed.

## Four fixes

1. **Durable omissions win.** The owner wait now runs at postprocess entry,
   before any local DB decision/protection snapshots or mutations. The former
   early transform owner wait is non-awaiting prewarm. Reasoning IDs and the
   drop-mode flag are reread as a committed union after later async todo/search
   work, even if no new IDs were selected. The current model epoch's cleared
   reasoning watermark is replayed too. Dropped-tag statuses are freshly replayed
   against the original target graph before final representation. Authorized
   latest-turn restoration is followed by omission replay again, so it cannot
   undo a peer's committed removal. Read failures fail closed, not to an empty set.
   A new real-WAL peer-drop test complements the unchanged peer-reasoning witness.
2. **Seeds never certify exclusion.** Every rank-building row now evaluates the
   complete current summary/finish predicate inside the worker's read snapshot.
   Seeded candidate discovery remains only a hint; missing moved-in IDs cannot
   become ordinary rows by default. This also covers changed flags below the
   anchors. The tradeoff is that every worker re-rank may parse all session JSON;
   serving-thread counts remain bounded, exact or deferred, never full scans.
3. **Short source accounting and process-local writer priority.** Normal source
   normalization/hashing moved outside the write transaction. Documents exceeding
   64 KiB normalized UTF-8 are omitted from FTS, with an explicit durable skip
   reason, original content hash, source identity and ordinal. Their identity is
   computed in 256 KiB byte chunks; each progress update is a separate short
   transaction, giving way between chunks. Final source/progress publication is
   another short transaction. Skip records are removed by explicit message/index
   cleanup; normal following messages remain searchable. UTF-8 encoding happens
   before chunk hashing, so a surrogate pair crossing a boundary does not alter
   the identity.

   The process-local coordinator announces foreground interest before waiting.
   A worker obtains a permit for one chunk only when no foreground turn is active
   or waiting, rechecks after CAS, and releases it after COMMIT/rollback. A colliding
   awaited transform waits asynchronously for the in-flight permit **before** its
   250 ms SQLite acquisition lease starts. No new chunk can overtake it. Worker
   termination is awaited before releasing an orphaned permit. This is not a
   cross-process lock: SQLite continues to arbitrate other hosts. Shared FTS
   automerge/crisismerge/WAL policy was not changed.
4. **Memory append pages are drained.** The memory path drains every 513-row page
   before advancing its global high watermark, rather than treating the first
   page as complete. File serving paths retain their bounded defer guard.

## Snapshot-to-apply audit

The removed late wait crossed the following local DB-derived views. Moving it to
entry means all these reads/derivations now occur **after** that suspension:

- whole-part removal IDs, readable-state flag and drop-leaves-reasoning policy;
- frozen merged/binding IDs, retained active thinking, protected thinking set,
  mutation-protected targets and the safe reasoning cutoff;
- pending-operation list and its application/accounting decisions;
- temporal decisions and their frozen first-application policy;
- cached M0/M1 fallback capture, off-wire prefix preparation, hard-fold/ride and
  routine/emergency cleanup admission, and emergency episode observations;
- protected tool IDs derived from active tags, and the applied cleanup result;
- binding-prefix omission projection and calibration/owner estimates used in
  fresh reasoning selection.

Todo synthesis and auto-search still contain existing later awaits. A fresh
committed omission union and fresh visible dropped statuses are read after them,
independently of local selection/persistence. Final merged/binding decisions come
from the existing later replay snapshot; whole-part IDs are explicitly unioned
rather than replaced. Cleared watermark replay is monotone only within the same
`lastObservedModelKey`, preserving the deliberate model-transition reset.

The following **parent-supplied pass inputs** cross entry's wait. They are retained
as one coherent tagged/prepared input, per the review ruling; individual pieces
are not rebound to a newer peer render:

| Input | Why it is carried coherently / post-wait treatment |
|---|---|
| Tagged message graph, message-tag numbers, target closures and captured pristine source bodies | Already created and used together by tagging; rebuilding only one map would point edits at different part coordinates. Durable drops replay through this same graph. |
| Partial-compartment bounds embedded in target closures | Part of the same original target coordinate system; not separately refreshed underneath closures. |
| Active tag/protected-token window, protected tag IDs/numbers, cutoff and count | One caller-computed protection cohort for these wire objects; not replaced with a peer's tag mass while retaining old targets. Fresh pending-op application already loads selected rows in its own transaction. |
| Session metadata: cached M0/M1 bytes, mural, cached coverage/marker bounds, TTL/system identity, last todo state | Rendering/admission input associated with the prepared prefix. No wholesale metadata replacement discards local successful writes or relabels cached bytes. Monotone omission fields are reread separately before serving. |
| Prepared compartment injection and its trim/coverage boundary; local history-rebuild outcomes | Bytes and seam/coverage are one tuple. Updating only its boundary would bless an older render as new history. |
| Caller usage/overflow sample, window/limit geometry and derived scheduler/budget gates | These define this request's admission/protection decisions, not a newer concurrent request's measurements. |
| Project binding / prefix-freeze verdict and host-vs-MC compaction classification | Bound to this host window and prepared-history identity. |
| Thinking-recovery authorization and captured latest-turn originals | Bound to the caller's anchored turn. Restoration cannot override the final durable omission union. |
| Tool-reclaim watermark and dropped-tag watermark used for new selections | Pass inputs; later selectors still use their existing transactional/fresh-row rules. Final visible drops/removals override older selection observations. |
| Frozen tool availability, permission verdicts and pass-local publication/materialization sets | Intentional request policy, not reread as an unrelated peer's request. |

There is no owner suspension between these local reads and their application now.
The former transform-level wait crossed session metadata/usage/overflow, recovery
and project authorization, compaction classification and the tag-load floor; it
has been removed entirely rather than selectively refreshing those derived chains.
No broad epoch retries were added. The parent explicitly chose preservation of
coherent pass input plus fresh durable omissions, not refusal under ordinary peers.

## Default-FTS measurement and accepted latency limit

Linux 8c, Bun 1.4.2. `index-chunk-hold.ts` builds **2,000,000 documents**, each with
**2,560-byte** text, using default FTS settings throughout. It then measures 512
incremental writes and foreground collisions on that same index. The config
before/after contained only `{k:"version",v:4}`; no merge setting override occurred.
`lsof` for host PID 2 showed only throwaway `context.db`, WAL and SHM paths under
`$TMPDIR/magic-context/bg_c399011e1ec6641d-hold/`; all six isolation variables and
SQLite temp were placed there. No live store/config was read or migrated.

Milliseconds:

| Operation | p50 | p95 | p99 | maximum |
|---|---:|---:|---:|---:|
| One normal incremental transaction hold | 0.673 | 0.987 | 14.371 | **1327.307** |
| Native COMMIT | 0.167 | 0.314 | 13.878 | **1326.890** |
| Foreground collision wait + its one-row write | 2.269 | 3.379 | 16.008 | **1328.511** |
| 60 MB source's identity/skip chunk hold (231 transactions) | 0.007 | 0.029 | 0.205 | **0.972** |
| 60 MB source's chunk COMMIT | 0.005 | 0.014 | 0.025 | **0.356** |

The default-policy rare merge is not bounded by document size. The benchmark
stopped with `escalationRequired=true` / exit 2 because COMMIT exceeded one second.
The parent reviewed these exact numbers and accepted this slice's **1.33 s maximum
asynchronous collision wait**, with no global FTS-policy change: formerly the
same native merge froze the main thread; now other sessions/event-loop callbacks
remain responsive. This is a measured distribution, not a hard sub-1s promise.
The setup's 500-document transactions had maximum 1753.115 ms; they are bulk fixture
construction, not the incremental maintenance path.

Cross-process contention is still SQLite contention. This change improves the
large-message case (no giant FTS insertion, sub-ms skip chunk holds) and gives
way between chunks, but cannot give foreground priority to another Pi/OpenCode
process. Normal default-policy merges may still hold the shared writer lock for
the measured tail; off-thread execution changes responsiveness, not that native
cross-process lock duration. Released hosts keep their default merge policy.

The real host profiler detects watchdog **lateness**, not request elapsed time:
Bun and Node compare the tick gap against the 250 ms watchdog interval. A new
real-timer test holds a coordination permit asynchronously for 1330 ms, waits
through the foreground gate, observes over 100 event-loop ticks with no 500 ms
stall report, then verifies the same watchdog reports a real 900 ms synchronous
block. Inspector data alone is stubbed; timers, coordination and blocking are real.
Thus the asynchronous collision wait is not counted as a main-thread stall.

## Gates and regression controls

All verification ran on Linux 8c. Versions: Bun 1.4.2, TypeScript 5.9.3,
Biome 2.5.1. The enabled unchanged review passed all seven tests, including the
full eight-pass byte differential (8123, 8123, 8123, 8123, 8123, 8145, 8145,
8145 bytes), plus all its positive controls. Four additional correction tests
passed, including a peer drop and the real-timer stall-profiler control.

Root build passed (708 / 750 / 1012 / 412 bundled modules for OpenCode/v2/Pi/CLI;
nine TUI outputs unchanged). Full plugin suite: **7683 passed, 27 skipped, one
known baseline failure**, 7711 tests / 777 files. The unchanged Node WASM
Transformers fixture cannot resolve `onnxruntime-web/webgpu` from its temporary
bundle on the remote runner; this is the same documented pre-existing failure,
not a green full-suite claim. All affected tests and worker packaging tests pass.

Full Pi suite finally passed **1921 tests, ten skipped, zero failed**, 1931 tests
across 196 files. A preceding loaded run had one timing flake: the unmodified slow
embedding deadline test observed 3201.7 ms against its 3150 ms ceiling; a subsequent
full suite passed unchanged. Frozen installs checked 1013 installs / 1254 packages,
no dependency or lock changes. No suite exported `OPENCODE_DB` globally.

Four-package typecheck passed, as did a temporary test-only configuration checking
the unchanged review and new correction test (the standard config excludes tests).
Root lint passed after formatting, 1811 files across four packages, existing
warnings only. The temporary configuration and baseline extraction are disposable
verification inputs, not delivery files. Initial regressions in synthetic-history
replay, statement-compilation bounds and the transaction-acquisition fence were
fixed without rewriting their expectations; their focused rerun passed 19 tests.
Visible-drop replay excludes synthetic/replaced history objects, and skip metadata
uses per-connection cached statements.

## Mutation evidence

Live implementation files were staged before every temporary control. Every
mutation produced a non-empty `git diff --stat`; restoration used the staged
index plus `touch`, and an empty working diff was captured each time. No witness
expectation was edited. Selected checks ran one exact test name, so unrelated
checks were filtered, not falsely described as passing.

- Restoring the pre-wait removal snapshot and disabling its final union made the
  unchanged peer-reasoning witness red: private reasoning returned on the wire.
- Restoring seeded-ID-only exclusion made the unchanged large-session move
  witness red: all three ordinals were 1025 instead of 1024.
- Disabling the memory page drain made its unchanged witness red: 514 instead
  of 601 owners.
- Bypassing coordination and admitting a giant document **while retaining
  outside-lock normalization** did not redden the refused-turn witness on this
  runner. This control is reported as undefended, not as a proof. Reintroducing
  normalization/hashing under the writer as well reproduced `SQLITE_BUSY` and
  reddened exactly that refused-turn witness. This distinguishes independent
  layers of protection instead of assuming every neutralization recreates a
  sufficiently long overlap.
- Independently bypassing foreground coordination reddened its dedicated
  owned-chunk wait test; independently lifting the FTS size cap reddened the
  oversized-skip/normal-searchability test. These red controls reach both files
  involved in the undefended partial control.
- Disabling final visible-drop replay reddened the new peer-drop witness.

After all restorations, the unchanged review, new correction controls and both
SQLite scope/acquisition regression files passed: **28 tests, zero failures,
123 assertions**. The eight-pass differential again matched every byte. Product
and two test-only TypeScript checks then passed with TypeScript 5.9.3. The baseline
extraction and temporary typecheck configuration were removed before commit.

Three sidekick comment-review attempts returned incomplete/truncated coverage
instead of actionable findings; no clean comment-review result is claimed. The
snapshot inventory was separately researched with concrete source citations and
reviewed against the implementation. Comments/prose were manually checked for
plain-language reasons and for no assertion that default-policy COMMIT is bounded
below one second.
