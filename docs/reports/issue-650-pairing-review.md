# Issue 650: publication-pairing correctness review

## Resolution after independent review

The findings below preserve the original review of `8680e41c5adf01c2fb9dd6b1b115644f0c033dc9`, including its original failing assertions. The task-giver subsequently refined the contract to **handler-admitted identity reservations**, not dispatched-only facts: late, stale or ended-turn OMP refusal retains admitted numbers and the saved request while permitting zero sends. The four boundary tests are renamed to assert that contract. The warmed legacy-reader cache is now validated against file metadata and the import test also checks SQLite directly. Immediate downgrade visibility after a failed mirror remains a documented compatibility limit; its test asserts the missing old-reader evidence, then proves visibility after the next successful new-version repair. The updated actual-0.47.0 review run passes all 18 tests. See `issue-650-publication-pairing-verification.md` for implementation, mutation proofs, known limits and final gates. Envelope scalability debt is assigned to a normalized number table on the migration branch, not fixed here.

## Scope and result

Reviewed `82a3f0c11ad77ce5dfe09ff775b1277184bd9cab..8680e41c5adf01c2fb9dd6b1b115644f0c033dc9`, including `docs/reports/issue-650-lkg-served-pairing.md` (problem) and `docs/reports/issue-650-publication-pairing-verification.md` (implementation claims). The latter's results were treated as claims, not verification. Product code, existing tests, manifests, `ARCHITECTURE.md`, and `STRUCTURE.md` are unchanged by this review.

A served tag number is the immutable identity rendered as `§N§` in model-visible message bytes. A **last-known-good (LKG)** request is a saved transformed message array for later recovery replay. **OMP** means Oh My Pi; its managed receipt is the host's permission to dispatch a successfully prepared request. **CAS** means compare-and-swap against the previously read SQLite column.

**The SQLite pairing fixes the original split between durable numbers and a missing saved request, but it does not implement “numbers if and only if dispatched.”** Four ordinary failing tests establish the admitted-but-undispatched boundary. Two further failing tests establish warmed-cache legacy interoperability and downgrade-before-mirror-repair gaps. Ordinary alignment bytes match the baseline; the replay and changed-expectation suites passed.

All execution was on Linux with **8 vCPUs**, Bun **1.4.2 (744846f84)**. Database and XDG roots were disposable. The fixtures register the **real `registerPiContextHandler`**, use the real SQLite persistence and identity code, and drive the real OMP receipt hook with a fake host API/abort callback. “Dispatch” in these fixtures means the product hook admitted a modeled provider send, not a network request to a provider. No live stores or provider services were contacted.

The new file is `packages/pi-plugin/src/issue-650-pairing-review.test.ts`. Its assertions are ordinary `test` assertions, not `test.failing`; **`MC_PAIRING_REVIEW=1`** enables them. A complete release-interoperability run additionally supplies `MC_REVIEW_RELEASE`, pointing to an extracted **v0.47.0 / `ea34e43b444fa96eb4c5495c8f773c7cefecca1e`** source tree. Without that second variable, the two release-only cases skip and the peer-append case uses the current legacy-format writer as a fallback. The final complete run was **12 passed, 6 intentionally failed, 89 assertions, 18 tests / 1 file**, exit 1. Without the flag, all **18 skip**, exit 0.

The specification has explicit exceptions: unreadable/future envelopes and transient publication failures serve without new evidence. Those exceptions inherently weaken the literal “if” direction. I treat their serving behavior as required, not as separate bugs. The findings below concern the forbidden undispatched publication direction and interoperability, not a demand that these explicitly optional failures become refusals.

## Findings, with failing proofs

### 1. High — publication is tied to outcome admission, not dispatch

**Locations:** `packages/pi-plugin/src/context-handler.ts:5817-5838,5850-5859,5890-5900,5932-5935`; `packages/pi-plugin/src/pi-lkg.ts:1047-1081`; `packages/pi-plugin/src/pi-context-refusal.ts:122-166,203-222`.

The pair commits before the post-commit outcome/ownership checks and before the managed receipt exists. The mirror also runs before the last outcome checks. The OMP fence correctly refuses late, stale, or ended receipts, but it does not remove their already-durable numbers. Atomic request/number pairing is **not** atomic dispatch/number publication.

Failing test names (all in the new gated file):

- `review: sqlite overrun records no numbers for OMP-refused bytes`
- `review: mirror overrun records no numbers for OMP-refused bytes`
- `review: stale pass after real commit records no undispatched numbers`
- `review: ended OMP turn before provider dispatch records no numbers`

For the first two, a wrapper performs the **real** SQLite save or targeted JSONL append, then advances the same monotonic clock to **26,000 ms**, beyond the **25,000 ms** outcome deadline. The handler/receipt fence aborts, the modeled dispatch count is zero, and the stored LKG contains the numbered request. The assertion that SQLite numbers are empty fails: **received `[1]`**. The mirror case additionally reached the actual number-file writer, not merely telemetry.

The stale case creates a replacement OMP operation immediately after the real save returns; ownership rejection prevents the old result from dispatching, yet `[1]` remains. This deliberately models the return/ownership boundary, not JavaScript running concurrently inside a native SQLite call. The ended-turn case needs **no clock or persistence spy**: complete the real handler, deliver `agent_end`, then invoke `before_provider_request`. The fence aborts the ended turn, zero sends are admitted, and `[1]` remains.

This is an explicit limitation of the reviewed implementation, not a newly discovered secret in its report: `issue-650-publication-pairing-verification.md:23` allows admitted durable state after a late native commit. The newly added test `real managed handler refuses late-commit without late served evidence` even expects persisted `[1]` (`pi-served-publication.test.ts:221-224`). It tests absence of *later mirror/digest evidence*, not absence of authoritative served numbers. The original pairing regression now passing proves the LKG exists alongside orphaned-for-dispatch numbers; it cannot prove the stronger dispatched-only rule.

**Impact / decision:** either the public contract must explicitly reserve identities for admitted requests that never dispatch, or publication must acquire a dispatch-aware state/protocol. Merely adding another cooperative check before or after commit cannot guarantee the stated rule. Do not “fix” this by blindly deleting cumulative numbers: another accepted pass may depend on them.

### 2. Medium — a warmed process omits a legacy peer's newly served numbers from both import and adoption

**Locations:** `packages/pi-plugin/src/served-array-ledger.ts:93-108,138-139`; `packages/pi-plugin/src/context-handler.ts:5819-5822,5853-5856`.

The SQLite side is read freshly, but the legacy JSONL side is cached indefinitely by session/path. A second process can append valid evidence after the first process cached an empty file. The first process's next successful publication imports its cached legacy set, not the now-current file. Its supposedly unioned adoption read also omits the peer's number.

**Failing test:** `review: legacy peer append after cache warmup is imported on the next real pass`.

The complete run keeps the new process alive, warms its empty legacy read, then starts the actual **0.47.0 source handler** against the same disposable session/database. The old handler serves `§1§` and appends its identity evidence. The new handler then serves its own `§2§` pass successfully. The independent file read, SQLite read, and production adoption reader show:

```text
PAIRING_LEGACY {"file":[1,2],"committed":[2],"adoption":[2]}
Expected to contain: 1
Received: [2]
```

This is not a lost update in the SQLite CAS: the old process never wrote the new SQLite namespace. It is a stale cross-process legacy read defeating the required union/import. The JSONL bytes survive, and clearing the process cache/restarting would recover them; the failure is their invisibility to the still-running adopter. The test does not claim to reproduce an ensuing wrong conflict survivor or next-pass refusal.

### 3. Medium — downgrade continuity is best-effort until a failed mirror is repaired

**Locations:** `packages/pi-plugin/src/served-array-ledger.ts:392-410`; `packages/pi-plugin/src/served-identity-refusal.test.ts:78-102`; `packages/pi-plugin/src/context-handler.ts:3963-3978`.

After a committed pair, a failed mirror intentionally permits serving. A 0.47.0 reader only consults JSONL, so it has no evidence of the new identities if the new process exits or is downgraded before another successful publication repairs the mirror.

**Failing test:** `review: 0.47.0 sees every dispatched identity after a failed new-version mirror`.

The test rejects only the targeted identity-file write, serves `§1§` through the real handler and OMP receipt fence, verifies one admitted send and committed SQLite `[1]`, then launches the actual release's identity reader in a separate process. That reader returns **`[]`**, failing the expectation `[1]`.

This is a **compatibility limitation**, not a violation of “mirror only after commit” or the required transient-failure serving policy. The existing mirror-failure test correctly proves next-pass repair, but cannot prove immediate downgrade continuity. Existing database tag-to-message mappings may still happen to render `§1§`; this proof establishes missing immutable served evidence, not automatic renumbering on every downgrade. Deployment documentation needs to state this boundary, or downgrade needs an explicit export/repair step before switching to the old reader.

## End-to-end rules and controls

The following all passed with the real handler and OMP hook:

- A completed pass admits one send; its serialized served array equals the **durable SQLite LKG** byte-for-byte, committed numbers are `[1]`, and the mirror contains `[1]`.
- Recurring unavailable-branch and unsaved-identical-twin passes each serve twice, retain identical bytes, record `[1]` and `[1,2,3]` respectively **without an LKG**, and count both number-only outcomes. These are the permitted number-only paths, not refusals.
- A publication-only `database is locked` trigger rolls back the pair, still serves managed numbered bytes, admits dispatch, and logs/counts `commit_failed/pair_commit_failed`. This is the explicit transient-failure exception.
- A separate process holds a real `BEGIN IMMEDIATE` lock on the disposable database. With a prior fitted LKG, the real handler replays exactly the previously served bytes and keeps only the already-published `[1]`. Both sends are admitted; the busy replay takes about **88 ms**, not a new number-only publication.
- Malformed and future-version envelopes remain exactly unchanged, save no new LKG or mirror, and still dispatch the managed numbered bytes. The existing valid-envelope/invalid-number case also passed in the selected publication suite.

Existing outcome/publication tests, storage-busy/no-LKG refusals, writer-wait tests and receipt tests also passed. The review therefore cannot confirm “no path records undispatched numbers”: finding 1 disproves it. For dispatched bytes, ordinary and recurring uncapturable paths keep evidence; permitted unreadable/transient exceptions intentionally do not. No additional dropped-number path was found in the tested **new/new SQLite** races.

## Served bytes and replay

I independently exported the **base** with `git archive` and ran it in a disposable source tree inside the task's worktree, with the same locked dependencies. No baseline sources were overlaid on product files. A Python collector ran the existing alignment differential separately in base and current trees, collected only `ALIGN_DIFF` lines containing a SHA-256, compared each pass label/count/hash, and asserted **exactly 60 matches**. Both host shapes were exercised: `pi087` withholds system messages from the context callback, while `systems` retains them.

| Scenario | Per-pass hashes, base = current | SHA-256 of the ordered label/hash result list |
| --- | ---: | --- |
| `default` | 16 | `38b35cd3772b2142b4903413c2f54d9d38df9fdf571320a2cde3787dab31fa30` |
| `kept-duplicates` | 16 | `7ad4fdc429902f937ce8cac80046f47ffcc47adc33f8afa82798993970889c54` |
| `issue-650` | 28 | `e538dc3e180abb04b09acac30fbfc74144e141791bdd16ab6f12ebfc1c4f4a25` |

Each of the six differential executions passed its existing test; totals were **6 tests, 30 assertions**, plus the collector's independent comparisons. The archived tree initially needed links to package-scoped dependencies, not just root `node_modules`; the collector also initially tried to parse a diagnostic-only issue-650 line as a hash. Both harness setup errors were corrected before the successful comparison. No unequal served hash was observed.

The **11 baseline replay/LKG files** passed **125 tests, 2 skipped, 638 assertions**. The current run included these files and the changed-contract/outcome/receipt/publication suites: **350 passed, 15 skipped, 0 failed, 1,645 assertions, 365 tests / 22 files**. Its review tests were disabled; that run preceded adding five further opt-in cases, which cannot affect its executed tests. The final gating-only run confirmed **18 skips**.

Both baseline and current printed identical upgrade-replay hashes:

- pre/defer1/defer2/restart: `cff0f81850cc8413c11d6d0d7a17aa20817ef9bece6f6639b71feac2f58ad416`
- reclaim/frozen: `feda30626531abb643f857e237961e77d5dce151c2166c4f8420720cf928606a`
- existing independent no-system replay gate: `GATE F baseline=59d2ef9c3b293b491adb39971cfd598439b98022 passes=6`

The suites exercise within-version byte-identical replay, native/reasoning state, contraction and fit fences, and process restart. They do not emit cross-version hashes for every replay assertion; the **60-pass alignment comparison**, rather than a blanket inference from green replay tests, supplies the exhaustive cross-base byte comparison for the requested three scripts. The implementation report's 18,528-message performance trial was not re-run as part of this correctness review.

## Concurrency and shared OpenCode storage

The new concurrency control launches **two separate Pi handler processes on one session/database**, alongside a third process invoking OpenCode's normal reasoning-removal envelope writer **25 times**. Every numbered returned Pi array is represented in the final SQLite number set; the `piNative` sentinel and all 25 OpenCode reasoning-removal IDs survive. A separate deterministic two-connection test forces a competing number write between an envelope read and its CAS: the mutator runs **twice**, `[1,2]` survives, and the other namespace survives. Thus the collision branch was actually reached, not inferred from a lucky concurrent run.

The relevant shared primitive is the bounded whole-column CAS in `packages/plugin/src/features/magic-context/storage-replay-document.ts:383-437`. Paired Pi saves use an immediate transaction, serializing SQLite writers; number-only publication does too. OpenCode's reasoning-removal namespace and backup share the envelope (`storage-reasoning-removal.ts:60-68,99-117`), while modern trailing-blank choices usually use `session_replay_decisions` rather than growing this envelope (`storage-replay-document.ts:451-551`). `piNative` is Pi's native state, not OpenCode's normal namespace.

No new/new CAS lost update or namespace erasure was reproduced. The bounded CAS can still fail and log under persistent contention; the serving policy explicitly allows publication failure. The concurrent handler test is a scheduled process race, not exhaustive exploration of all interleavings. The deterministic collision control covers a real stale-read/CAS-retry boundary; finding 2 separately covers the **old/new JSONL** boundary that SQLite CAS cannot repair.

## Upgrade/downgrade controls

A release process writes **JSONL-only** evidence `[99]` before the new process's first legacy read. A successful real new-handler pass imports it with the newly served `1`: committed `[99,1]`. This passed, and contrasts with the warmed-cache failure in finding 2. The original committed/legacy-union and LKG-invalidation test passed too.

The actual release source, not the still-`0.47.0` manifest in the reviewed tree, identifies the old reader/handler. The downgrade proof establishes that only-after-commit mirroring remains safe for the new reader but cannot guarantee old-reader continuity after an optional mirror error. No live upgrade/downgrade was performed.

## Envelope growth: measured, not a failing correctness finding

The opt-in measurement tests seed one file-backed SQLite envelope, then perform **15 single-number delta publications** at each size. Each publication uses a real immediate transaction and the real envelope updater. Serialization is separately timed on the already-parsed envelope, including its UTF-8 byte-length calculation. CAS time includes reads, parse/validation, union allocation, whole-envelope serialization, SQL CAS and transaction commit; it is **not** just the SQL statement. The final corrected run produced:

| Cumulative numbers | Envelope bytes | Serialize median / maximum (ms) | Full delta/CAS transaction median / maximum (ms) |
| ---: | ---: | ---: | ---: |
| 50,000 | 288,949 | 0.175 / 2.262 | 1.963 / 7.969 |
| 200,000 | 1,288,950 | 0.608 / 2.963 | 11.962 / 34.038 |

These are hot, dense positive-number sets on the Linux runner with no deliberate contention; maximums include scheduling/GC noise. They exclude full LKG serialization and compatibility-mirror repair. Both measurement tests also verify the final number count, so a no-op writer could not produce these results while passing.

**Judgment:** 200k is well below a 25-second stall in this measurement and is not demonstrated to be a present long-session correctness blocker. It is a real scalability debt: adding one number copies/parses/rewrites roughly 1.3 MB, grows linearly with cumulative history, and occurs synchronously before dispatch. Multiple reads and unrelated namespace writers can pay related whole-envelope costs. An indefinitely long session is not bounded by these two samples, and cold/contended disks or Windows antivirus were not measured. The results support an eventual append-only/normalized number store, not a claim that this explains the field report's 80 seconds. There is no failing-test finding here because the measurements do not establish a violated latency limit.

## Every changed test expectation

Compared each test diff against the serving/identity rules, not just its new green result. Apart from changing a failed post-commit mirror from mandatory evidence to an optional compatibility write, the reviewed range adds observations while preserving the old served-content assertions.

| Changed file / cases | Old → new expectation | Assessment |
| --- | --- | --- |
| `served-identity-refusal.test.ts:21-102` | JSONL identity failure used to refuse and cancel capture; now a failed **post-commit mirror** still serves, checks authoritative `[1,2]` versus mirror `[1]`, then checks next-pass repair. | Correct for the new optional-mirror rule. It deliberately removes the old mandatory-file guarantee; finding 3 shows the unrepaired downgrade consequence. |
| `native-replay-state-pi.test.ts:301-314` | Exact envelope-string equality for malformed native lanes becomes structural equality after removing only `piServedTagNumbers`, plus exact number-set `[1,2,3,4]`. | Correct: valid v2 outer envelopes may gain this namespace while malformed native lanes remain preserved. This is not permission to rewrite an unreadable outer document. |
| `native-replay-state-pi.test.ts:320-360` | Future-version serving/raw-byte preservation remains; publication-skip counts are added. | Correct; the strong stored-byte expectation is retained. |
| `overwall-upgrade-replay.test.ts:224-253` | Existing malformed-document replay behavior remains; exact `"{"` preservation and skip counts are added. | Strengthens the unreadable-envelope rule. |
| `context-handler.test.ts:3078-3114` | Note-ref failure still replays its existing anchor and persists no new anchor; adds number-only publication observation. | Correct for an uncapturable input attribution, not a weakened note-content claim. |
| `issue-640-review-r2.test.ts:181-238,240-285,465-508` | Existing distinct fallback/real IDs, literal marker, and reload adoption assertions remain; add number-only observations and no-new-LKG checks. The first case checks the previous real LKG still holds the earlier served output. | Correct: inability to capture the new request is not refusal or permission to renumber it. |
| `issue-640-review.test.ts:290-344` | Racing real-ID/fallback output assertions remain; adds number-only observation. | Correct. |
| `issue-650-review-r3.test.ts:529-576` | Twin rewind/numeric survival remains; adds duplicate-entry-id number-only observation. | Correct for unsaved twins. |
| `issue-640-641-combined-differential.test.ts:44-150` | Same-wire assertion remains; adds configurable message count, file-backed DB, 32 LKG/total timing samples and richer performance metadata. | Does not change expected served bytes. Source/diff reviewed; this opt-in performance fixture was not rerun here. |

The **new**, rather than modified, late-commit test in `pi-served-publication.test.ts:175-239` explicitly permits committed numbers and a saved request even when the deadline then prevents dispatch. It is the material mismatch with the stated dispatched-only rule, not evidence that the existing unchanged orphan-pairing regression defends dispatch identity. New recurring/unreadable/transient/mirror tests otherwise match the stated exception policies. No existing test was edited to manufacture a pass in this review.

## Verification and reproduction

Authoritative checks on the final new test:

- Pi `bun run typecheck`: passed both project checks (`tsc -p ../retina-local-fs/tsconfig.build.json && tsc --noEmit`), TypeScript **5.9.3**. This script excludes `*.test.ts`, so it was supplemented below rather than being presented as test-file type coverage.
- `bun run tsc --noEmit -p ../../review-650.tsconfig.json`: passed with a temporary root configuration extending the Pi tsconfig, including only the new test, empty exclusions, and explicit `typeRoots: ["./packages/pi-plugin/node_modules/@types"]`. The first root-config attempt lacked that package-scoped type-root and failed; it was a harness configuration issue, not a product/package type error. The temporary configuration is not committed.
- `bun run biome check src/issue-650-pairing-review.test.ts`: passed, **1 file**, Biome **2.5.1**.
- The available static-analysis inspection tool returned partial/unavailable scoped analysis; the explicit TypeScript check above supplies type coverage for the new test.
- Frozen install checked **1,013 installs across 1,254 packages**, no dependency changes. No manifests/lockfiles changed.
- Gated complete review: **12 pass / 6 intentional failures / 89 assertions**. Disabled review: **18 skipped / 0 failures**.
- The CAS collision control was then tightened to preserve the real OpenCode `reasoningRemoval` and backup namespaces; its impacted-only rerun passed **1 test, 4 assertions** (two release-only cases skipped, other cases filtered). Final explicit test typecheck and one-file lint passed again after that edit.
- Current selected replay/contract/outcome/receipt gate: **350 pass / 15 skip / 0 fail**, 22 files. Baseline replay/LKG gate: **125 pass / 2 skip / 0 fail**, 11 files. The current selection also contains the unchanged original pairing regression, which passed both cases.
- Independent alignment comparison: all **60** per-pass SHA-256 values and labels/counts match; **six** differential test executions passed.

No full workspace suite or new bundle build was run for a report-and-test-only change. The task supplied a prepared successful build, which is not counted as independently rerun verification. No production code was changed to create the failures: each failing test directly asserts observable state, while neighboring passing controls use the same real handler and store.

To reproduce the 0.47.0 reader's missing identity after a failed compatibility mirror, export source locally in the isolated worktree before submitting the commands to the Linux runner; link each extracted tree's root and package-scoped dependencies to the locked installed equivalents:

```sh
git archive ea34e43b444fa96eb4c5495c8f773c7cefecca1e > review-650-release.tar
# Linux execution, from the worktree root:
mkdir -p .tmp-review-650-release
tar -xf review-650-release.tar -C .tmp-review-650-release
ln -snf "$PWD/node_modules" .tmp-review-650-release/node_modules
ln -snf "$PWD/packages/pi-plugin/node_modules" .tmp-review-650-release/packages/pi-plugin/node_modules
ln -snf "$PWD/packages/plugin/node_modules" .tmp-review-650-release/packages/plugin/node_modules
export MC_REVIEW_RELEASE="$PWD/.tmp-review-650-release"
cd packages/pi-plugin
MC_PAIRING_REVIEW=1 BUN_JSC_useOMGJIT=0 \
  bun test src/issue-650-pairing-review.test.ts --timeout 30000
# Expected: 12 pass, precisely the six named contract assertions red, exit 1.
```

For alignment, export `82a3f0c11ad77ce5dfe09ff775b1277184bd9cab` in a separate disposable tree with the same links, then run the following separately in the extracted tree's `packages/pi-plugin` and the current tree's `packages/pi-plugin`. Compare `ALIGN_DIFF` label/count/hash records, excluding diagnostic-only lines without `sha256=`; expect **16 + 16 + 28** records per build. Do not mistake either individual test passing for the cross-build comparison.

```sh
for scenario in default kept-duplicates issue-650; do
  MC_ALIGN_DIFF=1 MC_ALIGN_SCENARIO="$scenario" BUN_JSC_useOMGJIT=0 \
    bun test scripts/experiments/alignment/differential.test.ts --timeout 30000
done
```

The replay gate's eleven files were: `pi-lkg.test.ts`, `pi-lkg-wire-fence.test.ts`, `pi-lkg-measured-basis.test.ts`, `pi-lkg-fit-envelope.test.ts`, `context-handler-lkg.test.ts`, `native-replay-pi.test.ts`, `native-replay-state-pi.test.ts`, `reasoning-replay-pi.test.ts`, `overwall-upgrade-replay.test.ts`, `issue-485-replay-gate.test.ts`, and `fold-content-replay.test.ts`. Use `BUN_JSC_useOMGJIT=0 bun test <these src/ paths> --timeout 30000` in each package tree. Extraction and Linux execution must be in the same remote command when runner scratch trees are not retained across commands.
