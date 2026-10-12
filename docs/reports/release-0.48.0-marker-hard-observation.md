# Release 0.48.0: marker HARD observation

## Finding

The reported `SOFT+` (a normal replay without the requested rebuild) is
consistent with a **test log-observation race**, not an
OpenCode 1.18.32+ delay of the requested HARD. The fixture's trigger is
`mc_cache_state.meta.project_memory_epoch_pending`, not a system-prompt hash
change. It must be observed on the **next transform**, on both 1.18.31 and
1.18.35. The test still requires that exact pass to be HARD, applied, with
`reason=project_memory_epoch` and `prefix_bust_permitted=false`.

The unchanged base passed all seven tests with the installed OpenCode 1.18.35.
The unchanged HARD scenario also passed with 1.18.31. These results do not
support a deterministic host-version regression. A replay of the permitted
buffered-log visibility order reproduced the reported assertion while the
actual product pass was already HARD and committed.

## The missing synchronization

`RustTestHarness.sendPrompt()` waits for the host's response, not for the plugin
log file to flush. `packages/plugin/src/shared/logger.ts` buffers lines for up
to 500 ms. `waitForRustPasses(n)` waits only for **at least n visible lines**;
it cannot identify the request represented by the last line.

`mixedCatchup(true)` selects the HARD scenario that keeps the provider's system
and message bytes identical to the control request. It warms a
17k-message history, stages a lagging host marker, records an identical-prompt
provider control, then requests a rebuild without permitting a prefix bust.
Before the fix, that scenario had this valid interleaving:

1. The warm transform completes (HARD / first_render / row version 3), but its
   line is buffered. `beforeProbe` is read as zero.
2. The control transform completes (SOFT+ / none / version 5). The wait for
   `beforeProbe + 1` can be satisfied by the warm line alone.
3. The fixture sets the pending flag directly in SQLite and increments the
   cache row's version to 6 so a writer holding older metadata cannot overwrite
   the new flag. It then
   sends the identical prompt after reverting the control message.
4. The epoch transform completes (HARD / project_memory_epoch / version 7).
   The wait for two lines can instead be satisfied by the control's SOFT+
   line, while the epoch line is still buffered.
5. The test asserts against the previous pass and tears down the host. That
   can also prevent the buffered HARD line from reaching the failure log.

The release log has exactly the first-render/version-3 and control/version-5
lines for the failing session, with no epoch pass line. A successful unchanged
run on 1.18.35 adds the expected epoch/version-7 line. The failure log alone
cannot prove what the unflushed pass did; the controlled replay below separates
product execution from the erroneous observation.

The fix waits for the warm line **before** taking the control's baseline count.
Every later wait then has the preceding pass accounted for. The fixture also
uses `UPDATE ... RETURNING` to verify the staged flag and checks that the HARD's
committed row version is greater than the staged version. No sleep, host-version
exception, later-pass retry, or relaxation of byte-identity assertions is used.

## Controlled replay

The temporary replay limited diagnostic visibility to the minimum number of
lines requested by each wait. A logger flush between transforms can expose one
completed pass while the next line remains buffered, and an at-least-count wait
accepts that partial view. The replay changed visibility, not product decisions.
Removing the warm synchronization produced:

```text
visible=SOFT+/none/v5 actual=HARD/project_memory_epoch/v7 staged=6 pending={"pending":0}
Expected: "HARD"
Received: "SOFT+"
(fail) rust invariant: compaction marker byte identity > byte-preserving marker HARD holds the host marker, queued drops and frozen provider bytes
```

Only that selected test failed. Independently reading the fully flushed log
showed the real HARD, and the store showed that it had consumed the flag. With
the synchronization retained, the same visibility schedule passed, including
host-marker state, pending marker state, queued drop count, exact provider bytes,
and the frozen replay fence checks. Both temporary controls were restored from
the staged live fix; the working diff was empty after each restoration.

## Product implications and history

The transform loads `mc_cache_state` from a fresh SQLite transaction, captures
`project_memory_epoch_pending`, and includes it in the eager-HARD request
(`crates/mc-module/src/transform.rs`, around lines 3534–3578
and 3653–3655). HARD clears the flag in the metadata it commits. Transform and
historian metadata writes are row-version fenced; a writer that loaded version
5 cannot silently replace the fixture's version-6 flag. The observed version-7
HARD demonstrates that this scenario does not lose the flag to a stale snapshot,
historian write, or marker drain.

A real dashboard epoch bump is a separate input: Rust reads
`project_state.project_memory_epoch` in `load_m1_revision_snapshot`, hashes it
into the external revision, and compares that revision each pass. It does not
rely on the test's diagnostic counts or on OpenCode's system-transform ordering.
The `tests/cache-invariants.test.ts` scenario named "a genuine HARD trigger —
project epoch bump" exercises that input, verifies re-materialization, and
passed on 1.18.35. This investigation does not certify every concurrent
memory-write interleaving: in particular, composition and the later revision
acknowledgment are separate reads. That broader concurrency question is not the
cause reproduced here and is not changed by this fixture fix.

The byte-preserving HARD intentionally **holds** the lagging host marker and
queued drops when no provider prefix bust is permitted. Holding them in this
scenario is the asserted cache-safety property, not a missed needed rebuild.
The separate render-epoch scenario still verifies an admitted prefix bust,
marker advancement to ordinal 16940, retained tool parts, smaller full input
resynchronization, and subsequent byte-stable SOFT+ / bounded append transport.

The relevant fixture logic is already present in `v0.47.0`; the only diff in
this file from that tag to base `87c241cb` is the host-version check changing
from `1.18.x` to any `1.x`. The log-count helper and logger have no changes in
that range. There is no reproducible good/bad version predicate with which to
bisect either hosts or master. The controlled visibility replay identifies a
pre-existing synchronization hole without attributing it to the raw-ordinal,
owner-wait, cold-stall, or fallback-config changes.

The module emits `broca ... not registered` when it attempts to start its
configured historian producer, whose module ID is `broca`. The mixed fixture
explicitly sets `startHistorianProducer: false`, so that producer is intentionally
absent from the hermetic daemon. The diagnostics also appear in
passing render-epoch runs. They are not the requested HARD trigger.

## Isolation and unrelated verification failures

OpenCode 1.18.31 and 1.18.35 were installed under the task's throwaway root.
PATH was explicitly pinned, and fixtures used private HOME, XDG data/config/
state/runtime/cache, OPENCODE_DB, and MAGIC_CONTEXT_STORAGE_DIR. The test's
`lsof` assertions printed only throwaway `.db` paths; no live stores or host
configuration were accessed. Local Rust builds used `nice -n 10` and
`CARGO_BUILD_JOBS=4`, using the current module and lock-pinned daemon.

During verification, `lsof -p existing,missing` was confirmed to return 1 on
macOS even when the persistent process was successfully inspected. A transient
host child can exit between `ps` and `lsof`. The isolation helper now tolerates
that exact case only if every persistent root PID is present and at least one
sampled child vanished. It still rejects timeout/other statuses, missing roots,
empty database evidence, and any database outside the fixture.

An initial file run with OpenCode 1.18.31 stopped with ENOSPC after three passes. Verification
resumed only after the operator freed disk space. Other file runs encountered
unrelated `SQLITE_BUSY` in the metadata-only scenario or OpenCode startup; these
are recorded separately from the target HARD assertion, which passed. The
metadata-only scenario recovered in a fresh-process targeted run. The package
TypeScript check has unrelated baseline errors; the changed test has no compiler
diagnostics in the full TypeScript program.

## Final verification

All native runs below used Bun 1.4.2, `nice -n 10`, the hermetic Rust lane,
and throwaway host stores.

| Check | Result |
| --- | --- |
| Unchanged base, OpenCode 1.18.35, whole marker file | 7 pass / 0 fail |
| Unchanged HARD scenario, OpenCode 1.18.31 | 1 pass / 0 fail |
| Fixed fixture with controlled one-line diagnostic visibility | 1 pass / 0 fail |
| Final marker file, OpenCode 1.18.31 | 7 pass / 0 fail |
| Final marker file, OpenCode 1.18.35, within the full release lane | 7 pass / 0 fail |
| Full manifest Rust lane, `scripts/run-rust-hermetic-e2e.sh` | 59 files ran: 56 passed (114 tests), 3 failed only because the OpenCode 2 binary was an uninstalled ASCII placeholder |
| Those 3 OpenCode 2 files after installing the pinned 2.0.22 CLI under throwaway HOME | All 3 passed (6 tests); all 59 manifest files therefore have passing results, 120 tests total |
| External `lsof` audit of full lane | 118 host PIDs seen and verified; no outside-root databases or unchecked hosts |
| External `lsof` audit of final recovered gates | 28 host PIDs seen and verified; no outside-root databases or unchecked hosts |
| TypeScript 5.9.3, full e2e package program | Baseline failure: 30 diagnostics outside the changed test; 0 diagnostics for the changed test |
| Isolation-helper controls: exited child accepted; missing host, foreign DB, and unexpected status rejected | 4 pass / 0 fail |

The full manifest command's initial status was **fail**, not silently green;
only its three files that could not execute the placeholder OpenCode 2 binary
were rerun after installing OpenCode 2 with
the repository's `ensure-shared-opencode2.ts` script. No repository manifest or
lockfile was changed by that throwaway installation. All other manifest files
passed on their first attempt, including the marker file.

The isolation branch controls compiled the actual helper declaration from the
changed source and supplied `ps`/`lsof` results for an exited transient child,
a missing persistent host, a foreign database, and an unexpected exit status. Temporarily
removing the persistent-root check made only
`marker isolation rejects an omitted persistent host` fail; the exited-child,
foreign-database, and unexpected-status controls remained green. This proves
that accepting a vanished transient child does not make the persistent-host
guard vacuous. The mutation was restored before final verification.
