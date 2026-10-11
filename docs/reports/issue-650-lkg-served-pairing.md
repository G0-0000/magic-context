# Issue 650: Pi LKG / served-number publication pairing

## Scope and conclusion

Investigated the supplied master baseline **4692c4fdc962fe3b5643ad9aae8aeb52d73dca77**, including the merged #641 and #650 changes. Release comparison is against **v0.47.0 / ea34e43b444fa96eb4c5495c8f773c7cefecca1e**. The package version on this master baseline still says `0.47.0` despite source changes since that release tag, so the tag's commit, not the current manifest string, identifies the release source compared here (`packages/pi-plugin/package.json:3`). No live stores or user configuration were opened.

Source: issue 650, comment 11 by @willowite, dated 2026-10-11 (retrieved with the repository issue-reader identifier `issue://650/comments/11`). It reports Senpi 2026.10.10-11, Bun 1.4.2, Windows 11, Pi Magic Context 0.47.0, five positional-lane refusals, and an 80.7-second publication stage whose queued LKG and digest-ledger capture were discarded while served numbers persisted. The comment is field evidence, not an independently reproduced timing measurement.

A **last-known-good (LKG)** slot saves the transformed request for validated replay when a later context-handler invocation fails. A **pass** is one such invocation; its newly assigned served numbers are immutable numeric identities that later tag adoption must honor.

**Yes: master still allows durable served numbers without the corresponding LKG.** LKG capture is normally deferred, while the served-number file is appended synchronously. The late-write fence can correctly reject the later LKG callback without undoing that earlier append. A real-handler, file-backed, isolated regression below reproduces precisely that split by advancing the cooperative clock after the actual identity-file write. Product code is unchanged; the regression is intentionally an ordinary failing test, not `test.failing`.

The pairing invariant discussed here concerns **new numbers published by the same managed pass**, not a permanent requirement that the latest LKG contain every number ever served. The number file is cumulative; legitimate history removal may remove older numbered bytes from the newest LKG (`packages/pi-plugin/src/served-array-ledger.ts:331-337`). Side turns and compaction-off operation are distinct modes, not failures of managed-pass LKG publication (`packages/pi-plugin/src/context-handler.ts:5766,5798`).

## 1. Order and transaction boundaries

The normal managed pass follows this sequence:

| Order | Work | Publication boundary |
| --- | --- | --- |
| 1 | Set `LKG/served publication`, assert the 25-second outcome clock, and switch SQLite guards to the remaining outcome allowance. | No commit yet (`packages/pi-plugin/src/context-handler.ts:5757-5765`). |
| 2 | Resolve envelope attribution and call `captureAppliedPass` with the output and its entry ownership. | Detach/serialize now; **normally queue** the LKG commit (`packages/pi-plugin/src/context-handler.ts:5766-5795`; `packages/pi-plugin/src/pi-lkg.ts:796-869,923-948,1054-1070`). |
| 3 | Assert outcome again and call `capturePiServedArray` with the explicit assigned numbers. | **Synchronously append new numbers** to `pi-served-tag-numbers/<session>.jsonl`, then update the served cache and enqueue the digest/body telemetry (`packages/pi-plugin/src/context-handler.ts:5797-5803`; `packages/pi-plugin/src/served-array-ledger.ts:359-405`). |
| 4 | If rebuilt, acknowledge identity repair; capture reasoning status; assert outcome; publish the transform decision; return messages. | Further independent work, not a shared transaction (`packages/pi-plugin/src/context-handler.ts:5804-5835`). |
| 5 | Run the LKG callback and telemetry flush later. | LKG checks pass ownership and capture sequence, computes signatures/digests, installs the memory slot, then saves to DB. Telemetry independently rechecks its guard at flush (`packages/pi-plugin/src/pi-lkg.ts:934-1021`; `packages/pi-plugin/src/served-array-ledger.ts:266-309`). |

Thus **the LKG request is prepared first, but new served numbers normally reach durable storage before the matching LKG**. The LKG coordinator defaults to `setImmediate`, starting with `syncCaptureRequired: false`; only retry-required captures run their commit inline (`packages/pi-plugin/src/pi-lkg.ts:533-549,1054-1069`). A cache-busting capture explicitly drops the previous replay slot while the replacement is pending (`packages/pi-plugin/src/pi-lkg.ts:918-921`).

Pi **does have durable LKG persistence on this baseline**: `createPiLkgCoordinator` registers `createDbLkgPersistence(db)` (`packages/pi-plugin/src/pi-lkg.ts:539`). The older claim in a test comment that Pi has no durable backend must not be used to describe current master (`packages/pi-plugin/src/issue-650-review-r2.test.ts:186-190`). LKG prefix chunks and metadata commit in their own SQLite transaction; errors are best-effort and return `false` while retaining the memory slot (`packages/plugin/src/hooks/magic-context/lkg-persist.ts:205-288`). The served-number append is a **different medium**, not a statement in that transaction (`packages/pi-plugin/src/served-array-ledger.ts:363-377`). The digest/body flush is also separate and diagnostic, delayed by 25 ms (`packages/pi-plugin/src/served-array-ledger.ts:18,254-309`).

## 2. Remaining split-publication paths and merged safeguards

| Scenario | Result on master |
| --- | --- |
| Deadline already expired before serialization/publication | Guard rejects before new identity append. This is defended, but does not cover an append that itself crosses the deadline (`packages/pi-plugin/src/context-handler.ts:5760,5779,5797`; `packages/pi-plugin/src/issue-641-publication.test.ts:109-157`). |
| **Identity append stalls across the deadline** | Append is real and irreversible at that point; the **next** guard throws before cache update/telemetry enqueue. The callback queued to save the transformed request later rejects the expired handler invocation. There is no rollback of the number file (`packages/pi-plugin/src/served-array-ledger.ts:369-389`; `packages/pi-plugin/src/pi-lkg.ts:934-945`). **Reproduced below.** |
| Deferred LKG becomes expired, cancelled, or stale after numbers were recorded | Callback returns after a failed ownership/deadline assertion or a newer capture sequence. Its guard does not remove the earlier identity delta (`packages/pi-plugin/src/pi-lkg.ts:934-948`; generation and signal checks at `packages/pi-plugin/src/context-handler.ts:3918-3937`). A later successful capture may heal the gap, but is not guaranteed. |
| LKG preparation, scheduling, or commit fails while the pass remains current | Capture can return without installing a slot; failure paths drop it and require a synchronous next capture, but do not make the handler skip served-number capture (`packages/pi-plugin/src/pi-lkg.ts:831-847,1014-1041,1057-1070`; `packages/pi-plugin/src/context-handler.ts:5780-5803`). The missing-slot window is especially clear after cache busting. |
| LKG DB save gets a busy/storage error | Memory capture precedes the save; `saveLkgSlotToDb` catches the error and returns false. Replay can still work in this process, but new numbers can be durable while the **matching durable** LKG is absent/old. `syncCaptureRequired` requests a future retry, not atomicity (`packages/pi-plugin/src/pi-lkg.ts:1014-1021`; `packages/plugin/src/hooks/magic-context/lkg-persist.ts:283-288`). |
| Identity storage itself fails | The identity error is safety-critical: the handler clears the prepared LKG state and refuses. This protects the opposite direction in the ordinary error path, but supplies no transaction or rollback for bytes already appended (`packages/pi-plugin/src/served-array-ledger.ts:367-378,407-411`; `packages/pi-plugin/src/context-handler.ts:5837-5844`). |
| Busy store before publication / historian join | These are not inherently orphaning: admission can replay a fitting prior LKG; otherwise it refuses. The emergency historian join occurs **before** publication and is charged to the optional clock (`packages/pi-plugin/src/context-handler.ts:4115-4181,5845-5855,5899-5948,4894-4905`). Historian startup can create contention, but there is no historian await inside the publication span `5757-5835`. |

### What #641 fences, and what it does not

The normal-work cutoff is 21 seconds, outcome cutoff 25 seconds, and initial writer allowance at most 16.5 seconds with a completion reserve (`packages/pi-plugin/src/pi-context-budget.ts:16-25,43-68`). The handler, LKG callback, and queued digest flush use ownership/deadline guards. OMP additionally requires a completed managed receipt before provider dispatch (`packages/pi-plugin/src/pi-context-refusal.ts:138-167,203-222`). These fences correctly stop **future** late work; they cannot preempt synchronous native/host calls or undo already-written bytes (`packages/pi-plugin/src/pi-context-budget.ts:11-14`).

The existing deferred-publication test queues a served digest **without passing any `servedTagNumbers`**. It therefore checks that the digest disappears, not that a previously written identity delta disappears (`packages/pi-plugin/src/issue-641-publication.test.ts:58-61,93-99`). Its serialization-stall partner crosses the deadline **before** identity append (`:109-152`). Both tests pass alongside the new red case; they are valid tests of different boundaries, not evidence of pair atomicity.

### What #650 repairs, and what it does not

Master's production repair rules no longer repeatedly throw when merging fallback and real-entry identities would require choosing between two already-served numbers:

- Use a unique cached rendered survivor or exactly one served candidate as proof. Tool proof requires matching owner/call/timestamp and rendered result identity; message proof requires header/fingerprint and part ordinal (`packages/pi-plugin/src/context-handler.ts:3293-3302`; `packages/pi-plugin/src/pi-tool-identity.ts:98-171`; `packages/pi-plugin/src/pi-message-identity.ts:78-105`).
- With no proof, claim the identity's once-guard and choose the newest number for one declared rebuild. A spent/unpersistable guard or damaged ledger leaves the duplicates unmerged, recording/logging recurrence rather than endlessly refusing (`packages/pi-plugin/src/context-handler.ts:3303-3349`; `packages/pi-plugin/src/pi-tag-identity-repair.ts:19-31,90-137`). A missing/reshaped replay request must not be confused with proven returned bytes; the returned-array cache and its digest are separately checked (`packages/pi-plugin/src/pi-tool-identity.ts:145-171`; `packages/pi-plugin/src/served-array-ledger.ts:122-152`).
- Record the fold and pending rebuild in one savepoint; undo the fold if recording fails. Force an execute/cache-busting pass and protect the surviving tags (`packages/pi-plugin/src/context-handler.ts:3351-3403,7948-7963,8090-8111`). Acknowledge the pending record **after the capture call**, not after its queued LKG actually commits (`packages/pi-plugin/src/context-handler.ts:5780-5805`).
- The survivor selector preserves the proven number, or accepts the declared rebuilding survivor; duplicate folding retargets operations and preserves queued reductions (`packages/plugin/src/features/magic-context/storage-tags.ts:1991-2013,2251-2293`).

These rules address identity reconciliation and the repeated-refusal policy. They do **not** couple the served-number file to LKG publication. Master also checks message headers rather than trusting equal counts alone to map context-array positions onto session-entry IDs (`packages/pi-plugin/src/context-handler.ts:1938-1960,2105-2151`). That addresses Senpi's transformed/custom turns lining up with the wrong entries despite coincident counts, not the independently reproduced publication split. The reporter's exact next-pass refusal is not reproduced here; master has changed the conflict policy. The narrower orphan-publication defect remains.

## 3. Real-handler regression and smallest coherent fix

Added `packages/pi-plugin/src/issue-650-lkg-served-pairing.test.ts` with two cases:

1. **Green control:** register the real `registerPiContextHandler`, serve one real fixture user message, drain the LKG callback, and check the returned numbered bytes against both the in-memory and DB LKG and a fresh read of the served-number file.
2. **Failing regression:** use the same handler and a file-backed throwaway DB, with a monotonic clock spy and a wrapper around the existing storage writer. The wrapper **performs the real write first**, then advances elapsed time to 26 seconds only when the path equals the fixture session's `getPiServedTagNumbersPath`. No LKG, tagging, handler, or DB implementation is mocked. This models a synchronous filesystem call returning after the 25-second outcome limit without sleeping for 80 seconds.

The handler rejects with `stage=LKG/served publication elapsed=26000ms`; its deferred LKG is discarded and no digest-ledger file appears. The durable number file nevertheless contains tag 1. After clearing the served cache, the test rereads the same durable identity. The invariant then demands either no newly published numbers or a matching recoverable request; it fails because the memory LKG is undefined. The test also loads the DB slot, and its green partner checks that the durable and memory request bytes agree. Fixture roots replace both XDG data and config homes, and the package preload independently fences bare database opens (`packages/pi-plugin/test-preload.ts:23-29`). Cleanup restores globals and removes only the throwaway roots.

**Smallest coherent fix to propose, not implement:** introduce one managed-pass publication operation that prepares both outputs, then publishes **the LKG and authoritative served-number delta together, or neither**, before returning the result. The existing LKG SQLite transaction is a natural durable boundary: add the identity delta to that same transaction, treating capture/DB failure as failure of the whole publication. Update in-memory evidence only after that commit; acknowledge identity rebuilds only after the pair succeeds. Keep the JSONL digest/body ledger as optional telemetry.

Crucially, the current number JSONL cannot remain a second independent authoritative append if SQLite is the chosen boundary. Existing JSONL identities must remain honored (import/read their union during transition), and a JSONL mirror must not authorize an uncommitted pair. An alternative is one atomic authoritative per-pass record containing both the request and its identity delta. Merely reordering the current calls, putting the number append in the deferred callback, or wrapping only the DB operations does **not** give atomicity across SQLite and a file. Nor is blindly deleting cumulative numbers after failure safe: another accepted pass may already rely on them (`packages/pi-plugin/src/served-array-ledger.ts:331-337`).

The commit boundary may itself return after a deadline; the dispatch/refusal fence must still run. Atomic pairing ensures that a stalled commit leaves both durable records or neither, rather than pretending cooperative checks can preempt the commit. A late result must not bypass the host receipt fence. No fix is included, as requested: investigation stops at the demonstrated defect and failing test.

## 4. What can cost 80 seconds, and what remains on master?

**No source evidence proves the cause of that particular 80.7-second episode.** In particular, spawning a historian is not evidence of awaiting it during this stage. The publication span has no `await`; the conditional emergency historian join is earlier, under its own stage and the shared optional budget (`packages/pi-plugin/src/context-handler.ts:4894-4905,5757-5835`). Deferred historian startup also checks its originating optional cutoff (`packages/pi-plugin/src/issue-641-outcome.test.ts:93-154`). A historian may contribute CPU or storage contention, but an 80-second historian join *inside publication* is not supported by this baseline.

Potential costs, without assigning unmeasured durations:

| Operation | Still present on master / release comparison |
| --- | --- |
| Host envelope and calibration | In-stage `sessionDecisionCalibration` reads session metadata; envelope capture calls host prompt/tool APIs, serializes/parses JSON, estimates tokens and hashes attribution. Those synchronous calls can block without a cooperative interruption (`packages/pi-plugin/src/context-handler.ts:5769-5775,5815`; `packages/plugin/src/features/magic-context/session-decision-calibration.ts:98-115`; `packages/pi-plugin/src/pi-lkg-fit-envelope.ts:18-29,40-80,92-148`). The envelope/calibration files are unchanged from v0.47.0. |
| Output preparation and serialization | Detach all output fields; compare exact reusable prefixes; serialize changed messages/array. A materialization changing many messages may reduce reuse; CPU, allocation/GC or host-defined serialization can dominate even with few messages (`packages/pi-plugin/src/pi-lkg.ts:796-830`). This capture path is unchanged from v0.47.0. |
| Served identity and full-array diagnostic preparation | Cold reads scan identity JSONL; SHA-256 covers the serialized array; divergence and tail vectors are computed; directory creation and **synchronous file append** remain. Windows filesystem/antivirus stalls are a plausible class of delay, not a diagnosis of this reporter's machine (`packages/pi-plugin/src/served-array-ledger.ts:81-119,325-377`; `packages/plugin/src/shared/storage-permissions.ts:45-68`). The critical identity append is unchanged from v0.47.0. Optional body/digest **writes** are deferred, so their flush is not normally inline stage cost (`packages/pi-plugin/src/served-array-ledger.ts:385-402`). |
| Synchronous LKG retry | After a failed capture/save, `syncCaptureRequired` runs digest computation and DB save inline. That path can add large-input work and writer contention to this stage; ordinarily it is deferred (`packages/pi-plugin/src/pi-lkg.ts:934-1021,1054-1069`; `packages/plugin/src/hooks/magic-context/lkg-persist.ts:216-288`). The scheduling and DB persistence paths already existed in v0.47.0. |
| Content digest algorithm | The release used three SHA updates per detached field with text encoding. Master packs typed fields into 64 KiB chunks, reducing that per-field cost (`packages/plugin/src/hooks/magic-context/lkg-slot.ts:269-278 at v0.47.0`; current `:289-373`). Pi capture calls the shared digest helper (`packages/pi-plugin/src/pi-lkg.ts:985-988`), so an inline retry benefits; the normal deferred digest does not explain inline publication time by itself. Legacy-slot verification retains a legacy path (`packages/plugin/src/hooks/magic-context/lkg-slot.ts:389-427`). This improvement is not an 80-second latency guarantee. |
| Identity-rebuild acknowledgement | Master adds a conditional DB transaction after capture, absent from the release's publication span (`packages/pi-plugin/src/context-handler.ts:5804-5805`; `packages/pi-plugin/src/pi-tag-identity-repair.ts:210-236`). It is not a removed release cost and does not wait for the queued LKG to commit. |

These comparisons were checked with local Git diffs of v0.47.0 against the supplied baseline, including the handler, Pi LKG/ledger, budget/envelope/calibration, and shared LKG persistence/digest files. The 21/25-second budget file is unchanged. Thus the **split ordering and the non-preemptible synchronous identity IO still exist**, although some shared digest costs have improved and the alignment/conflict repairs have changed. A stage lasting 80 seconds can exceed the cooperative limit in a synchronous call and be rejected only afterward. It must not be described as an allowed 80-second publication budget (`packages/pi-plugin/src/pi-context-budget.ts:11-25`).

To diagnose the actual episode, the missing evidence is per-operation timing around envelope APIs, detached-field/JSON work, identity read/create/append, synchronous retry digests/DB save, and GC/process descheduling. Also needed is whether `syncCaptureRequired` was set: it indicates a previous capture/save failure requiring the normally deferred digest/DB work to run inline. Message counts alone do not bound payload size. No live-store probe or Windows latency measurement was attempted.

## Verification (Linux, 8 vCPUs)

Tool versions: Bun **1.4.2 (744846f84)**, TypeScript **5.9.3**, Biome **2.5.1**. Commands below run from `packages/pi-plugin`; its test preload supplies the additional throwaway-root fence.

- `bun run typecheck` — passed: `tsc -p ../retina-local-fs/tsconfig.build.json && tsc --noEmit` (two project checks, silent exit 0; version obtained with `bun run tsc --version`).
- `bun run biome check src/issue-650-lkg-served-pairing.test.ts` — passed, checked 1 file with no fixes after correcting the initial formatting finding.
- `BUN_JSC_useOMGJIT=0 bun test src/issue-650-lkg-served-pairing.test.ts src/issue-641-publication.test.ts src/issue-641-outcome.test.ts src/issue-650-message.test.ts src/issue-650-review-r3.test.ts --timeout 30000` — **44 passed, exactly 1 intentionally failed**, 45 tests / 5 files, 160 assertions, exit 1. All existing selected #641/#650 tests and the new completed-pass control passed.

Captured failing test output:

```text
(pass) pairs a completed real Pi pass with its served numbers and LKG
102 | expect(slot).toBeDefined();
error: expect(received).toBeDefined()
Received: undefined
(fail) does not orphan durable served numbers when identity append overruns the Pi publication budget
44 pass
1 fail
160 expect() calls
Ran 45 tests across 5 files. [2.50s]
```

The sole failure is the asserted missing LKG, not a harness timeout, storage-isolation failure, type error, or unrelated repair regression. No full workspace suite or product build was run for this report-and-test-only change; no manifests or lockfiles changed.
