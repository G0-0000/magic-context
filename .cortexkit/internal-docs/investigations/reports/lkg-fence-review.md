# Independent LKG recovery-fence review

Reviewed the durable last-good request (LKG) fence and immutable recovery-prefix changes across the complete range `207e64e298dcb94309e29158a4998e363f66e901..75e40737f04748104977d9e6a73c1f85a71bc9d8`. The final commit only adjusts when complete arrays are captured; the review includes the earlier fence implementation too. Report-only: no product changes, architecture changes, schema changes or package changes are included.

The author's initially absent report was supplied at `.cortexkit/internal-docs/investigations/reports/lkg-durable-recovery-fence-2026-10-13.md`. Its SHA-256 is `95d573b9b7718bdd9dcf79e3ed7e90b0a30f3fa464238cff1a940eb63b0837ba`. Its final-policy section, rather than the superseded per-capture-certificate claims, was reviewed. Claims below are observations from this review, not repetitions of that report.

## Result: one P2 finding; do not claim unconditional no-busy compatibility

### P2 — Pi held-prefix bytes change after a no-busy simulated restart with a carried identity repair

Here a **held pass** means a pass inside an unfinished signed-thinking turn where earlier provider-visible bytes should be preserved, unless an independent event already requires rebuilding the prefix. Signed thinking is assistant reasoning with a signature bound to preceding request bytes. The existing audit's held driver checks that preservation property over randomized multi-pass sessions. It passes at the exported, separately installed/built baseline (207e64e2) and fails at the candidate (75e40737) for seeds **2, 3 and 8**, with 150 passes each. The driver has no busy-database injection. It includes queued operations and carried tag-identity repairs. These are not the simpler append-only corpus below.

Observed candidate changes, all marked `unavoidable=[]` by the audit, meaning no independent reason to rebuild the held prefix was identified. Bracketed values name events on that pass; message indices are zero-based and identify the first changed message shared with the preceding served array:

- Seed 2: pass 96, `[history-refresh restart carried-pending]`, first changed message **0 of 141**.
- Seed 3: pass 17, `[restart carried-pending]`, first changed message **5 of 38**; pass 50, `[user restart carried-pending]`, first changed message **54 of 94**.
- Seed 8: pass 38, `[flush restart carried-pending]`, first changed message **0 of 79**; pass 138, `[restart carried-pending]`, first changed message **0 of 108**.

Executable witness: `packages/pi-plugin/src/lkg-fence-restart-regression.test.ts`. Each test runs the existing audit in an isolated child and requires its held-byte contract to pass. The tests are opt-in so the ordinary package suite remains usable; enabling them demonstrates the unfixed candidate regression with an expected failing exit status.

```sh
unset OPENCODE_DB
FENCE_REVIEW_REGRESSIONS=1 bun test packages/pi-plugin/src/lkg-fence-restart-regression.test.ts --timeout 180000
```

Candidate: **0 pass, 3 fail, 6 assertions**. Baseline ruling, in a separate export:

```sh
R2_SEEDS=2,3,8 R2_PASSES=150 BUN_JSC_useOMGJIT=0 \
  bun test packages/pi-plugin/src/issue-665-hold-review-r2.test.ts \
  -t 'held driver seed' --timeout 120000
```

Baseline: **3 pass, 15 filtered, 0 fail, 9 assertions**. The same unchanged driver's assertions were not redefined. The candidate's full eight-seed audit failed those three held-driver tests; its aggregate strict-signature-binding assertions passed. This is a cache-byte regression, not evidence that kept signed thinking survives changed preceding bytes. The restart here is the audit's process-state reset, not an OS restart; real SIGKILL evidence is separate below. The exact product cause was not minimized, and this report does not assign the failure to a particular hunk without further evidence.

## Independent complete-request differential

New witnesses: `packages/pi-plugin/src/lkg-fence-independent.test.ts` and `scripts/review-lkg-fence.ts`. The fixture uses a different xorshift generator and three seeds (81273, 177013, 991021), with 120 append passes per seed per host. Prose includes Unicode, literal section marks, escapes and newlines; tool messages/results and signed reasoning are mixed. OpenCode scheduler decisions cross execute/defer 24/13/22 times; a second Pi profile crosses 5%/90% usage at those same positions. The Pi fixture uses the real context handler. OpenCode 1 uses its messages-transform wrapper; OpenCode 2 uses `adaptPayload` in both directions around that wrapper.

Both revisions receive independently cloned raw arrays. The orchestrator compares **each complete JSON serialization directly**, never a shared hash proxy: Pi's returned object, OpenCode 1's output object, and OpenCode 2's full draft (system, tools, options, model and messages). These are fixture-visible requests, not a captured live provider HTTP body. Signed blocks use test signatures, not provider-issued cryptographic signatures.

- Normal profile: **1,080 complete request pairs matched** (360 per host).
- Pi pressure-crossing profile: **another 1,080 pairs matched** (360 per host).
- Initial simpler model/profile run also matched 1,080 pairs; it is not counted in the stronger totals.
- No synthetic restart/branch contraction is included in this append corpus; the P2 finding is why these green comparisons cannot imply universal compatibility.

Reproduce entirely inside an isolated worktree; Linux `runon: linux,4c,net` is needed for the exported baseline's install. All runtime stores/output must stay outside the checkout:

```sh
git archive --format=tar -o lkg-review-base.tar 207e64e298dcb94309e29158a4998e363f66e901
BASE=$(mktemp -d); OUT=$(mktemp -d)
tar -xf lkg-review-base.tar -C "$BASE"
bun install --cwd "$BASE" --frozen-lockfile
bun run --cwd "$BASE" build
FENCE_REVIEW_BASE="$BASE" FENCE_REVIEW_OUTPUT="$OUT/normal" bun scripts/review-lkg-fence.ts
FENCE_REVIEW_PRESSURE=1 FENCE_REVIEW_BASE="$BASE" FENCE_REVIEW_OUTPUT="$OUT/pressure" bun scripts/review-lkg-fence.ts
rm lkg-review-base.tar
```

Each profile ran 18 isolated passing fixture processes. The normal profile had 241 assertions per process. Pi pressure processes had five assertions (byte equality is checked by the parent orchestrator); OpenCode retained the 241 assertions. Baseline installs used the committed lockfile, installed 1,000 packages and changed no manifests or lockfiles. Baseline and candidate root builds passed with Bun 1.4.2; each TUI generation checked nine outputs and rewrote none.

## Busy → healthy → fold and signed thinking

Reran the unchanged complete-byte handoff tests in `transform-degraded-pass.test.ts` for both v1/v2 store generations, and both Pi shapes in `context-handler-lkg.test.ts` (prose/result and two results). All passed. They compare the full recovered prefix on repeated healthy passes, verify that genuinely new content is tagged, normalize at the already-busting fold with exactly one tag, and check the immediately following request and tag rows are unchanged. These are executable provider-wrapper/transform witnesses, not an installed OpenCode CLI session.

```sh
bun test packages/plugin/src/hooks/magic-context/transform-degraded-pass.test.ts \
  packages/pi-plugin/src/context-handler-lkg.test.ts \
  -t 'preserves the entire busy raw tail|preserves complete busy recovery bytes' --timeout 120000
```

The original combined command ran the two signed-thinking audit files, both full busy/fold files and the new Pi crash file. Completed signed-turn omissions, multiple completed turns and refusal when omission persistence fails were therefore exercised. The strict-thinking audit portion used:

```sh
R2_SEEDS=665,664,650,1,2,3,7,8 R2_PASSES=150 BUN_JSC_useOMGJIT=0 \
  bun test packages/plugin/src/hooks/magic-context/issue-665-hold-review-r2.test.ts \
  packages/pi-plugin/src/issue-665-hold-review-r2.test.ts --timeout 120000
```

Both hosts' OpenCode held drivers and both audit files' aggregate strict-binding assertions passed. The Pi held drivers had the three P2 failures above. The original broad five-file command ran 163 passing tests and four failures: those three plus an overly strong new crash witness's clean-boundary expectation. That new witness was corrected against actual publication ordering; no pre-existing assertion was edited.

## Real-process restart and native macOS mutex evidence

`lkg-fence-opencode-sigkill.test.ts` drives both OpenCode bridges through actual disposable SQLite locks and kills child processes with **SIGKILL**, before dirty locking, after temp sync, after dirty publication and after returning a recovery tail. It reads the durable slot in a new process. Before publication, no tail was returned and the old slot remains admissible; after dirty publication or after returning the recovery tail, the retained older slot is inadmissible. Its ordinary-deferred cases return a new fully tagged request, die before `setImmediate` publication and retain the earlier valid slot. Those two ordinary cases also passed unchanged in the baseline export: **2 pass, 8 filtered, 10 assertions**. This confirms the accepted baseline crash window rather than falsely promising synchronous ordinary publication.

`lkg-fence-sigkill.test.ts` exercises the real Pi handler at the same recovery points, plus a crash during the healthy fold's commit. A new-process handler whose database writer is locked refuses after the dirty-publication and returned-tail cases. The fold clears the old durable slot and fence, then commits a new tagged slot; a crash at that commit can therefore authorize the **new** slot, containing the entire tail the model saw. Requiring all commit crashes to refuse would be stronger than the safety property and would misclassify this safe route.

The shared-publication tests independently SIGKILL at matching commit, before clean publication and after successful clean publication. Commit/before-clean retain dirty evidence and refuse; after-clean admits only the matching new slot. The fence observer named `clean` runs **before** the actual clean write, so it is correctly treated as `before-clean`, not proof of finished publication.

```sh
unset OPENCODE_DB
bun test packages/plugin/src/hooks/magic-context/lkg-fence-opencode-sigkill.test.ts \
  packages/pi-plugin/src/lkg-fence-sigkill.test.ts \
  packages/plugin/src/hooks/magic-context/lkg-recovery-fence.test.ts --timeout 100000
```

The first three-file run passed **31 tests, 248 assertions** before the three additional shared SIGKILL publication cases were added; those cases subsequently passed separately (**3 pass, 10 filtered, 12 assertions**). Existing fence tests also cover corrupt/mismatched scope, failed dirty/clean writes, two publishers, cleanup and Windows cold-refusal policy. They use process exit for their older crash fixtures; the new witnesses use SIGKILL explicitly.

On this **Mac**, Bun 1.4.2 and native `ps`/PID probes were exercised, not a Linux substitute:

```sh
bun test packages/plugin/src/shared/storage-file-mutex-review.test.ts \
  packages/plugin/src/hooks/magic-context/lkg-recovery-fence.test.ts --timeout 30000
```

**19 pass, 0 fail, 198 assertions.** The new mutex witness SIGSTOPs a live holder, proves a contender times out without entering, SIGKILLs the holder, waits for exit, and proves reclamation and ticket cleanup. A second test corrupts the contender file recording a live owner's PID and birth identity, and refusal remains within a 2.5-second outer bound (200-ms mutex budget). A third test injects an `EPERM` PID probe while retaining a real live holder, exercising `isPidAlive`'s inconclusive branch: it refuses within the same bound and never enters protected work. The existing two-process test completed all 24 publications with a certificate matching the final commit. Native dirty-publication median was 1.889 ms, maximum 2.078 ms over 12 samples. This is a disposable-storage measurement, not a production bound.

### Live-store isolation

No forbidden store/config was opened. Unit suites never received an exported `OPENCODE_DB`; the runner explicitly removes it from child environments. The package preload forces disposable XDG data/config homes; each host fixture additionally uses an explicit temporary SQLite file and storage root. Every new live host child executes `lsof -p <pid> -Fn` against itself after opening its database and rejects any forbidden path. Native holder checks recorded `REVIEW_LSOF` with 9 paths and zero forbidden paths for all three children. Differential processes recorded 26–32 paths and zero forbidden paths. These checks prove the sampled live descriptor sets, not an exhaustive system-call trace of files opened and closed before sampling. No installed OpenCode or Pi CLI was launched.

## Warm fence I/O and foreground cost

The independent probe spies on **ESM** `node:fs` exports for path operations and tracks fence file descriptors for `writeSync`/`fsyncSync`/`closeSync`. It covers both the fence directory and mutex paths. It is separate from the author's `setIoObserver`, which is retained as a second assertion. A deliberate warm read made the independent assertion fail on `lstatSync`. An initial CJS-export probe was blind to the ESM imports; the mutation exposed that false-green proxy and it was replaced before final delivery.

After correcting the probe, all three final 120-pass candidate fixtures passed, each with 241 assertions and **zero actual observed fence I/O** on every warm normal pass. The 90% Pi profile may legitimately establish a numbers-only/raw obligation and is not claimed to have zero fence I/O throughout; only normal passes receive that assertion.

Measured foreground warm medians, ms, exclude the first ten passes. Values are the three fixed-seed runs from the complete differential, with baseline/candidate execution order reversed for the middle seed:

| Host | Baseline normal | Candidate normal | Baseline pressure | Candidate pressure |
|---|---|---|---|---|
| Pi | 10.110 / 8.200 / 8.309 | 10.355 / 9.244 / 7.860 | 11.468 / 9.708 / 11.046 | 11.344 / 11.120 / 9.158 |
| OpenCode 1 | 4.669 / 4.009 / 3.469 | 4.886 / 4.066 / 4.230 | 4.334 / 4.938 / 4.220 | 4.955 / 4.739 / 4.293 |
| OpenCode 2 | 4.490 / 2.928 / 3.749 | 5.370 / 3.688 / 3.961 | 5.257 / 4.605 / 3.898 | 5.526 / 4.556 / 4.495 |

The final ESM-probe candidate-only medians were Pi 8.819, v1 3.743 and v2 3.977 ms. Baseline/candidate measurement profiles had identical instrumentation, but the comparison runs preceded correction of the CJS probe; the final corrected probe's cost is therefore not silently folded into those baseline measurements. Shared-runner pauses reached seconds. There is no observed 2x durability regression, but these samples **do not establish a formal all-host within-noise bound**: several v2 paired medians were 20–26% higher. Stronger repeated paired measurements on an idle runner are needed before asserting performance parity. This is an explicitly unresolved requested check, not a proven performance finding.

## The three requested author controls, rerun

Source mutations intentionally disabled individual protections to prove the corresponding test notices the fault. All were staged from the live state, labelled `NON-VACUITY BREAK`, showed non-empty unstaged diffs, and were restored with `git checkout -- <path>` plus `touch` to an empty unstaged diff. No mutation or product edit remains.

| Control | Selected expected-red test | Observed result | Applied diff |
|---|---|---|---|
| Restore a fence read on every warm ordinary commit | `durable recovery fence > warm synchronous captures perform zero fence I/O` | only that test failed; received 32 reads instead of `[]`; 15 filtered | fence.ts, 1 insertion |
| Skip dirty publication before returning a recovered Pi tail | `review witness: exit before flush cannot authorize stale Pi restart replay` | only that test failed; expected false, received true; 2 filtered | fence.ts, 1 insertion |
| Mark an ordinary fully tagged directory-fallback pass dirty | `a pass that falls back to the launch directory > a no-busy directory-fallback managed pass writes no recovery fence` | only that test failed; received one write instead of `[]`; 41 filtered | transform.ts, 4 insertions |

Exact selected-test commands:

```sh
bun test packages/plugin/src/hooks/magic-context/lkg-recovery-fence.test.ts -t 'warm synchronous captures perform zero fence I/O'
bun test packages/pi-plugin/src/lkg-review-receipt.test.ts -t 'review witness: exit before flush cannot authorize stale Pi restart replay' --timeout 90000
bun test packages/plugin/src/hooks/magic-context/transform-degraded-pass.test.ts -t 'a no-busy directory-fallback managed pass writes no recovery fence' --timeout 30000
```

Restored positive run: **3 pass, 58 filtered, 0 fail, 80 assertions**. Additional independent ESM-probe control: restoring the warm read failed only `independent randomized complete-request corpus and warm I/O`, on `lstatSync`, with zero other failures. The three restored candidate fixtures each passed 120 normal passes and 241 assertions in the Warm fence I/O section.

## Verification and remaining limits

- Linux suites/builds used `runon: linux,4c`; export installs additionally used `,net`. Native mutex checks stayed on the Mac.
- Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**.
- Both package typecheck scripts passed (three OpenCode compiler invocations, two Pi invocations). Package scripts exclude tests, so the new `scripts/tsconfig.lkg-fence-review.json` explicitly typechecks all five witness files and the orchestrator; its `tsc --noEmit` gate passed after adding the repository's existing script type-root convention and annotating the revision tuples.
- Scoped lint checked two plugin witness files and three Pi witness files without errors. The standalone runner/config use the existing script Biome configuration and passed their two-file check after formatting.
- Initial output inside the checkout was rejected by the package's isolation guard; all subsequent differential stores/outputs were moved to external temporary directories. No checkout database is delivered.
- Windows was tested only through the existing injectable policy branch, not natively. No live-provider cache billing or cryptographic signature acceptance was tested.
- The OpenCode 2 independent tests exercise actual message adaptation, but not the installed v2 context-registration lifecycle/store reader. The busy/fold evidence for v2 remains the real shared transform/wrapper with v2 dependencies.
- Host-level SIGKILL matrices cover the recovery publication/return boundaries; commit/clean timing is additionally covered at the shared publication primitive. This is not exhaustive instruction-by-instruction crash testing of every raw-fallback, numbers-only, failed-preparation or Rust-module path.
- Fresh code-health inspection through the AFT toolkit was partial: root scripts lacked a root TypeScript/Biome project marker and the call graph was unavailable. The explicit compiler/lint gates above are authoritative; no clean AFT diagnostic claim is made.
- Sidekick research incorrectly pinned the baseline even when asked for current HEAD; its unsupported current-code conclusions were not used. File reads and executable gates supplied the evidence instead.

The retained evidence is this report, the executable witnesses and the final delivery JSON's mutation evidence (exact failed test outputs, applied non-empty diff statistics and restored empty diff statistics). Regenerable build directories and disposable exports are not evidence artifacts. The verified safety improvements do not erase the demonstrated no-busy Pi cache regression or justify calling the review an unconditional approval.
