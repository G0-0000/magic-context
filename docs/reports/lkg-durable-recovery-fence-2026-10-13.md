# Durable recovery fence and signed-turn follow-up

This supersedes the restart-safety claims in `lkg-recovery-handoff-2026-10-13.md`.
The independent review at `d17eef5c0dc8f862019c542b2c6fde8f092471a6` was
cherry-picked as `e2bdc847b4` before this follow-up. Its diagnostic-ledger and
completed-signed-turn findings were reproduced through the real handler.

## Safety and availability

Pi no longer imports or uses diagnostic served-array digests as safety evidence.
`piLastServedMatchesLkg` and its obsolete safety test were removed. The ledger
remains diagnostic and can lose an entire busy receipt without authorizing a
restart replay. The two-process review witness now asserts refusal, followed by
an attributed healthy rebuild, both for process exit before diagnostic flush and
for a swallowed diagnostic write failure. A sibling witness proves that a clean
Pi restart can serve the saved prefix plus an exact raw tail while SQLite is busy.

A recovery rebuild now records thinking omissions for **all** invalidated
reasoning-bearing assistants, including completed turns and redacted thinking.
Recovery rebuild is an explicit prefix-edit cause. Missing stable identities or
failed omission persistence refuses the request rather than returning changed
bytes with old signatures. The four tests checking signed-turn recovery now run normally;
additional cases cover multiple completed turns and a failed omission write.

The shared fence is `lkg-recovery-fences/<sha256(session-id)>.json` under the
configured Magic Context storage directory. It contains a version, session,
harness, model/provider, exact slot key, served-array digest, publication revision,
clean/dirty state and checksum. The slot key includes exact output/input evidence
and capture generation metadata. Missing, corrupt, mismatched, or dirty evidence
cannot authorize a process-cold recovery. There is no schema change or additional
database.

On macOS/Linux, every recovery return durably marks the certificate dirty first,
including Pi side contexts and both OpenCode recovery implementations. Publication
writes a unique owner-only temporary file, fsyncs it, renames it, then fsyncs its
directory and parent. Directories are 0700 and files 0600; reads reject permissive
or symlinked certificate directories/files. A failed dirty publication yields no
recovery permission. Clean publication follows the matching SQLite commit and
post-commit verification. Failed, interrupted or superseded publication remains
non-authorizing. Optional uncaptured outputs also invalidate an older clean claim.

Writers use a **Lamport bakery mutex** with private, exclusive-created PID/nonce
contender files and atomic ticket replacement. The mutex surrounds dirty returns,
SQLite commit plus certification, and durable clear. Dead owners are reclaimed by
PID evidence, with process-birth identity protecting against PID reuse. Linux uses
boot ID plus process start ticks; macOS obtains process start in fixed UTC/C
locale. A paused live holder is never stolen merely because a lease aged. An
uncertain holder has a bounded wait and refusal, not infinite blocking. Unique
contender names prevent stale cleanup from unlinking a successor's lock. These
file primitives and PID probes support all three OS families; native execution of
the new fence/mutex tests was Linux-only.

**Windows policy approved during engineering review:** no clean or dirty fence
files are published or trusted there. Process-local recovery remains available,
while restart replay refuses until a healthy rebuild. The platform decision is
centralized in the fence module, with a Windows-branch test injectable on any OS.
No best-effort Windows directory flush is advertised as durable.

Certificates are removed by durable LKG clear, persistent session deletion and
orphan/stale-slot cleanup. Interrupted temporary certificate files are removed
under the session mutex. A stale certificate cannot authorize a different slot
key. Automated scans verified that storage-file creation uses the owner-only
helpers and that all subprocesses hide their consoles on Windows.

## Rust and ordinary-pass compatibility

Healthy Rust module output remains available when `context.db` is busy. Its
normal capture stays deferred. Before an uncertified result returns, the sidecar
is made dirty without consulting the busy database; its detached current snapshot
is installed in memory at the successful return boundary. A deferred commit that
fails or is superseded cannot certify an older result.

The design review approved clean certification for **Rust-only complete frozen-array
captures**: their committed array/input evidence matches the latest returned
array digest, and Rust's cold path freezes that exact array instead of retagging.
Pi and TypeScript recovery obligations remain dirty until rebuilding. A newer
Rust return dirties the certificate again before returning. Tests prove both
clean-after-deferred-commit restart availability and refusal when a newer result
has returned but its commit has not landed.

The existing assertions that healthy Rust output and same-process replay remain
available while `context.db` is busy were retained.
Only its unsafe cold subsection changed: replaying old output 1 after output 2
was already returned is now refusal. The deferred-capture tests and two long
frozen-restart tests retain their expectations. Unproven cold slots with a healthy
module take the existing attributable rebuild route; unavailable modules refuse.

TypeScript now certifies the complete returned provider-visible array rather
than an early anchor. This avoids forcing a rewrite of a held signed prefix on
ordinary restarts after a partial capture. Mandatory preparation failures still
throw; successfully returned arrays, including optional-work fallbacks, get exact
ID/content evidence. Low-level early-anchor projection remains available and its
existing tests are unchanged. Admission fixtures now actually commit their seeded
LKG and certificate before pretending that a writer is busy. Both original #653
positive restart expectations are restored.

## Proofs and gates

All executable commands used `runon: linux,4c`, Bun 1.4.2, TypeScript 5.9.3 and
Biome 2.5.1. Stores and host fixtures were disposable. No live stores, schema
migrations, ARCHITECTURE.md or STRUCTURE.md were touched.

- Package typechecks passed; Pi lint checked 320 files with 67 existing warnings;
  OpenCode lint checked 1400 files with 11 existing warnings and six infos.
- Root build passed, including OpenCode v2, Pi and CLI; the TUI generator checked
  nine outputs and rewrote none.
- Pi full serial suite: **2139 passed, 39 skipped, 0 failed**, 162766 assertions
  across 219 files. A parallel run's sole failure was an existing nested child's
  five-second timeout under load; its entire file also reran clean (10 passed,
  one child-only skip, 49 assertions). Actual implementation failures in metadata
  admission and malformed-envelope compatibility were fixed, not redefined.
- Built OpenCode full suite: 7959 passed, 33 skipped, two failures. The known Node
  WASM temporary-output fixture cannot resolve `onnxruntime-web/webgpu`, as on the
  exported base. The other deferred-capture assertion was fixed by validating the
  physical durable generation instead of an intentionally stale test backend;
  its authoritative typecheck/lint and isolated 10-assertion rerun passed. Final
  Rust recovery, complete frozen-snapshot restart, fence and #653 suites also
  passed: **270 tests, one child-only skip, no failures, 3921 assertions across
  five files**.
- Focused fence, owner-only, #653 and Rust availability/certification run: 25
  passed, no failures, 136 assertions. It includes real two-process publication,
  dead-holder recovery and crashes between temp sync/rename, dirty mark/return,
  and commit/clean publication, plus failed dirty/clean writes and lifecycle cleanup.
- Actual durable dirty publication was measured, not assumed free: 12 isolated
  samples had median 0.410 ms and maximum 0.622 ms. A loaded suite's 12 samples
  measured median 1.353 ms and maximum 16.279 ms. These are small disposable
  records on the Linux runner, not a production latency bound.

The seeded 90-message append/defer fixture `lkg-review-no-busy.test.ts` ran against Git-exported
master `207e64e298dcb94309e29158a4998e363f66e901` and the candidate. Direct equality
of all 32 complete serialized requests per host passed (96 comparisons):

| Host | Corpus bytes | Equal SHA-256 |
|---|---:|---|
| Pi | 1289443 | `43d3774b62c82d79dbc79885fdc2329da649d5d6978d8835f8b9e3d57f0db646` |
| OpenCode 1 | 1550040 | `69820f3e1e4202cee04e0a94678135a0bdfd4a243343afd8f04eec1b7d5ff0c9` |
| OpenCode 2 | 921416 | `94989c3b3a01d5e08dc663fc7de1835a512ba88385e677d6b3759b7a211f03cd` |

Durability has measurable cost. In that 32-pass synthetic corpus the warm median
was approximately Pi 10.86→23.05 ms, OpenCode 1 5.23→11.06 ms and OpenCode 2
8.82→23.13 ms; outliers existed. Byte identity is proved, not performance parity.
The v2 no-busy fixture uses real context adaptation; its busy/fold proof remains
at the shared v2 wrapper/transform, as the independent review documented.

Six isolated mutations each failed exactly one named test, with no other failures:

1. Skip recovery dirty publication: lost-receipt witness trusted stale restart
   evidence (`Expected false`, `Received true`).
2. Skip recovery thinking omissions: completed-turn witness returned
   `signed-proof` behind changed tag/head bytes.
3. Swallow omission persistence failure: the refusal witness resolved instead
   of rejecting.
4. Bypass the publisher mutex: the two-process commit/clean test found a commit
   that no longer matched its certificate.
5. Bypass exact returned-array/digest certification: the newer-Rust-result test
   incorrectly certified old committed bytes (`Expected false`, `Received true`).
6. Skip dirty-before-healthy-return: the same newer-result test incorrectly
   allowed cold replay (resolved instead of rejecting).

Each deliberately broken implementation was staged from the live state, marked
`NON-VACUITY BREAK` to identify the temporary fault, and had a
non-empty `git diff --stat` while applied, and was restored with checkout plus
touch to an empty unstaged diff. No mutation remains. The default full suites
retain their opt-in skips; this report does not claim live-provider cache testing.

A fleet-wide upgrade of AFT's shared database format (reader version 17 required)
temporarily blocked commands before any
Linux gate ran. Work was held uncommitted until the parent explicitly released
it; no toolkit store was modified or downgraded.

## Resumed final verification

The interrupted run preserved an unfinished process-cache scaffold in
`lkg-recovery-fence.ts`. Its lookup function had no callers. The scaffold was
removed, restoring that source file byte-for-byte to the verified implementation
in `eadcb52a5a`; no fence caching optimization is included in this delivery.
The durability cost above still applies.

Fresh typecheck, lint, build and test runs after that restoration all used Linux
with `runon: "linux,4c"`,
Bun 1.4.2, TypeScript 5.9.3 and Biome 2.5.1:

- Pi typecheck passed both compiler gates; lint checked 320 files with the same
  67 warnings. The full serial suite passed 2139 tests, skipped 39 and failed
  none, with 162766 assertions across 219 files.
- OpenCode typecheck passed all three compiler gates; lint checked 1400 files
  with 11 warnings and six infos. Root build passed and its TUI generation
  checked nine outputs without rewriting any.
- The built full OpenCode suite passed 7960 tests, skipped 33 and failed one,
  with 273398 assertions across 793 files. The sole failure was the previously
  reproduced baseline fixture `Node WASM Transformers fixture > builds with
  real fs and persists a model for offline reuse`: its throwaway bundle could
  not resolve `onnxruntime-web/webgpu`. No LKG or host recovery test failed.
- AFT's fresh file diagnostics for the restored fence reported no
  errors, warnings, infos or hints; call-graph analysis was unavailable.

An independent fault-injection run verified that the complete-byte reproduction
detects tag prefixes added to already-served raw messages. Changing
`recoveryNormalized` in `packages/pi-plugin/src/context-handler.ts` to true on
every healthy recovery pass, marked `NON-VACUITY BREAK`, made exactly
`Pi context handler LKG replay > preserves complete busy recovery bytes on
healthy passes (prose and result)` fail: the complete-array comparison found
new `§2§` and `§3§` prefixes. There were zero passes, one failure and 30 filtered
tests; no other test failed. The staged live state had an empty unstaged diff;
the applied mutation showed one file with two insertions and three deletions.
After `git checkout -- packages/pi-plugin/src/context-handler.ts` and touching
the restored file, the unstaged diff was empty. The subsequent full Pi suite
above includes the restored reproduction and both raw-tail shapes.
