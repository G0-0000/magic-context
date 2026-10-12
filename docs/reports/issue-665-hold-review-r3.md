# Third review: issue 665/664 signed-thinking holds (OpenCode TypeScript and Pi)

Reviewed **`2e63dd6965f40f48c072967354786cbd69522cc1`**, including its merge of
**master `24ebef59e11a61a0317aafe53ce16c73451b7439`**. This is a report-only
review: no product, architecture, structure, manifest or lockfile changes.
The new pressure tests and reproduction scripts require **`MC_665_R3=1`**;
set it in the environment before the command, as shown under Reproduction.
Without it, the new test cases skip and the scripts do not execute.

Terminology: **OC1/OC2** are the legacy and v2 OpenCode host lanes; **m[0]/m[1]**
are the synthetic cached knowledge/history messages at the request's head.
**r2** denotes the second review and its two randomized test files
(`docs/reports/issue-665-hold-review-r2.md`). **Signed thinking** is an assistant block with an opaque provider signature that
binds preceding request bytes. A **hold** keeps those bytes unchanged; a **reset**
omits every such block before a prefix rewrite. A **carried repair** is a queued
Pi tag-identity/number repair awaiting safe application. A **root divergence** is
the first differing serve after a matching previous serve. **Red/green** mean a
selected test failed/passed under a deliberate code break. Author control numbers
retain the implementation delivery's labels; each concrete break is defined below.

## Verdict

**The round-2 strict-binding failures are fixed in the sampled runs. The
revision does not meet the complete brief.** Unheld serves are not byte-identical
to the pinned master, and issue 668 is absent from the reviewed ancestry.
Measured-envelope pressure probes fit or refuse; the initially unpriced fixture
is discussed separately rather than counted as a real-host non-fit defect.

| Check | Result |
| --- | --- |
| Round-2 randomized strict binding | **Pass:** zero binding breaks on OC1, OC2 and Pi, including idle expiry and Pi carried repairs |
| Held flush and 75.1%-execute → explicit-flush defer sequences | **Pass:** the existing strengthened regression serves unchanged bytes through both shapes, releases once; removing either guard makes that exact test fail |
| Unheld byte parity with `24ebef59` | **Fail:** 2,808 / 15,360 compared provider-visible serves differ; all root divergences start on idle-expiry passes |
| Long signed tool loop at 85% / 95% | **Pass for measured envelope:** all eight OC/Pi primary/subagent cases visibly refuse; existing tests also cover successful reset-and-fit |
| Merge: 663, 667, 650 | **Pass:** 113 tests in eight Pi suites |
| Merge: 668 | **Not present:** neither issue-668 implementation commit is an ancestor of this tip or the pinned master; its suite cannot be rerun here |
| Author controls #6, #13, #21 plus two review controls | **Pass:** each selected test fails alone; #17's caller-only green is reproduced and its compensating helper control #18 fails alone |

These are measured transform/handler outputs and one mock-provider real-host
run, not an Anthropic account acceptance test or a reconstruction of either
operator's live store. No live store was opened.

## 1. Round-2 witnesses, now green

Ran the original two r2 test files with seeds **665, 664, 650, 1, 2, 3, 7, 8**,
**150 held** and **320 unheld** passes per seed/scenario. Bun 1.4.2 on
`linux,4c`: **88 tests passed, 250 assertions**. That is **3,600 held-scenario
passes** across OC1, OC2 and Pi, and **15,360 unheld-scenario passes**.

The three aggregate checks originally documented as expected failures in round 2
now require zero violations without expected-failure wrappers:

- `held drivers: no kept signed thinking is served behind changed bytes`;
- `Pi held drivers: no kept signed thinking is served behind changed bytes`;
- `Pi held drivers: m[0]/m[1] is never re-rendered while signed thinking is kept`.

All pass. The per-seed held-prefix/refusal checks also pass. All six OpenCode
idle/86%/96% ruling cases and all six Pi cases, including carried repair, pass.
`Pi carried identity repair: a failing declared rebuild refuses at most one turn`
passes as well. This directly reruns the witnesses that previously reported
72 OpenCode breaks and 21 Pi idle-expiry breaks.

The randomized coverage limits are explicit: OC2 uses its dependency adapter, not the
full host conversion; random OC compartment events are off because the harness
has no host message store. The real OC2 conversion is exercised separately below.

## 2. Both live sequences and the freeze reason

The test at `packages/plugin/src/hooks/magic-context/transform.test.ts:5289`
(`a flush in a held signed turn is parked through execute and defer passes and
consumed by one release bust`) is genuinely strengthened, not merely renamed.
It warms a head, supplies **402 older signed assistants**, keeps a current signed
block, queues **33 drops**, executes at **75.1%**, parks a flush, grows the queue
to **401**, and serves **three 40% defer passes** before the next real user.

It checks the full served array, old tag statuses, pending rows, the still-visible
unneutralized dropped placeholder, no strip/drain/neutralization log, and one
active-thinking freeze diagnostic. Release drains the queue, neutralizes the
placeholder, consumes the flush, and three subsequent serves remain identical.
There is exactly **one `pending ops WILL APPLY — reason=explicit_flush`** log.
After the intentional mutations were removed, the test passes **28 assertions**.

Two separate guard removals prove that the same regression test detects both
an in-turn flush rewrite and a defer-pass dropped-placeholder rewrite:

1. Neutralizing the shared thinking veto changes bytes on the held flush serve
   (`:5408`), before release. Only the named test fails. This covers BROCA's
   repeated-bust mechanism rather than asserting a simulated billing total.
2. Author #21 permits first-neutralization only on **defer with a parked flush**.
   The first 40% pass changes `§404§ [dropped §903§]` into empty text while active
   thinking remains (`:5417`). Only the same named test fails. This isolates the
   second session's deferred neutralization independently of proactive stripping.

Author #6 separately makes `held execute denies thinking strip` return
`{messageIds:["old-answer"]}` instead of null. Thus the proactive strip assertion
is also live, not merely protected by the placeholder check.

For the issue-664 misleading/deduplicated-freeze-log contract, the held sequence checks **one** `m[0]/m[1] frozen: active thinking
turn` diagnostic for that user turn. The restored full transform suites also
cover the directory-fallback reason and turn-state pruning. In the real host
there are two active-thinking freeze lines for **two** user tasks, not two lines
for one task. The diagnostic names thinking, not directory failure.

### Real OpenCode 2.0.26, isolated on Linux

The gated `host.sh` builds the plugin and runs the existing real-host test
`OC2 execute-threshold thinking loop holds the prefix until one next-user bust`.
It passed **1 test / 16 assertions**. Four loop requests: **0 prefix changes**;
including the next-user request: **1 change**. Two pending drops remain before
the user and zero afterward. It measures system plus preceding message content,
excluding only moving `cache_control` fields.

`host-evidence.json` preserves the actual hashes, decisions and descriptor
inventories. Host **PID 108** used a fresh root under
`/motor-home/tmp/mc-665-r3-host.oFjhR8/runs/mc-opencode2-xutscW`.
The harness inventories the **whole process group with `lsof -p … -Fin`**, then
the test inventories the host PID directly with `lsof -p 108 -Fn`. Both contain
only that root's `context.db` and `opencode2.db`, including WAL/SHM descriptors.
HOME, XDG data/config/cache/state, TMPDIR and MC storage are private; the child is
stopped and its roots removed. The Linux platform tarball was fetched locally
and transferred as a disposable input, not fetched remotely or committed.
SHA-256: `0a116e033a02804741d4644337d012bdf5a24aac33a34c0c96534d2d53961119`.

This host test is the queued-drop execute/release scenario, **not** a literal
402-assistant fleet replay or a real Pi CLI run. The two detailed live sequence
shapes are exercised by the transform regression and independent mutations.

## 3. Unheld parity fails on both hosts

`differential.py` derives copies of the r2 drivers beside their originals so
relative imports remain real. It compares the reviewed production files with
**all seven differing existing production files** extracted from pinned master;
using only the old r2 script's four-file overlay would leave new product changes
in the alleged baseline. The new strict-prefix helper has no master counterpart
and is unused by the master overlay. Source files and generated drivers are
restored in `finally`. Run this only in a disposable runner checkout.

Two generated-event configurations, eight random seeds, 320 transform calls
per sequence, and three host lanes (OC1, OC2, Pi):

- **no-signed:** no signed thinking anywhere; the original completed-final-answer
  block is also removed. The trace explicitly checks zero served signed blocks.
- **no-kept:** the original unheld-bound driver: signed final answers only from
  completed older turns, immediately followed by a user; no active thinking hold.
  This is a no-current-turn-kept-thinking shape, not a claim that every historical
  signed block has disappeared on every defer pass.

The comparison follows r2's provider-visible fields: OC message id/role/error,
provider/model and visible parts; Pi role/content, tool-call id/name, error flag,
assistant provider/model. Timestamps and usage envelopes are excluded.
Comparisons hash the **provider-visible representation**, not a permission flag,
cache label or expected value generated by the implementation. Equal trace
lengths and no refusals are asserted. The comparator reports actual first changed
message bytes for each root; the final script exits nonzero on parity failure.

| Shape | OC1 different / compared | OC2 different / compared | Pi different / compared |
| --- | ---: | ---: | ---: |
| no-signed | 435 / 2,560 | 435 / 2,560 | 533 / 2,560 |
| no-current-turn-kept thinking | 435 / 2,560 | 435 / 2,560 | 535 / 2,560 |
| Total | 870 / 5,120 | 870 / 5,120 | 1,068 / 5,120 |

These are differing **passes**, including propagated differences, not 2,808
independent defects. Root counts: **9 per OC lane per shape**, all with
**directory fallback + idle expiry**; Pi **77 / 78 roots**, all at idle expiry.

The following examples show differing tool-result bytes; compact supporting
output is retained in `differential-evidence.json`:

- OC1/OC2, no-signed, seed **3**, pass **210**: fallback + idle expiry; head drains
  four pending operations, master keeps four. `call-185` output becomes
  `[dropped §226§]` instead of the prior tagged BULK output. m[0]/m[1] is not the
  first changed content.
- Pi, no-signed, seed **665**, pass **17**: usage 70% + idle expiry, no pending
  drop. The routine cleanup changes `call-10`'s result to `[dropped §13§]`; master
  retains its BULK output. Thus this is not only a difference in queued-work timing.

**Finding R3-U1 (Medium, explicit compatibility ruling):** the unheld idle-expiry
and directory-fallback rider changes remain outside byte parity with master.
They are cache-safe on genuinely cold requests and align with the author's
stated rider policy, but the review brief explicitly requires unchanged unheld
behavior. The earlier r2 report already identified the Pi idle-expiry change;
this run establishes that it also differs from the newly requested master.
Smallest remedy: narrow the new rider permission to held/reset cases, or get an
explicit ruling that this unheld policy change is permitted. Do not call this
check green because the driver tests themselves generated traces successfully.

## 4. Pressure: fit or visible refusal with the real request envelope

The final gated r3 files exercise **primary and subagent**, at **85% and 95%**,
with eight large tool results and nine signed assistants, the last block behind
every useful result. Protected tool counts and the ordinary protected-token
floor are zero. The OC fixture asserts that its SDK input limit is **100,000**,
uses **`claude-opus-5-5`**, and records a system-token count and a measured read-tool
schema. Pi supplies that same model/window, a system prompt and read-tool schema.
The supplied usage percentages are independent of the actual returned size.

**All eight final measured-envelope pressure cases visibly refuse with
`EmergencyFailClosedError`.** No oversized output array is returned. The existing
pressure tests additionally prove successful resets for reclaimable inputs and
visible refusals for irreducible ones at wall (96%) and final-fit (75%) on both
hosts. Thus a long hold does not simply run past the window in these measured
cases. This is transform/handler refusal, not a provider-billed dispatch test.
The corpus presents an already-large signed ingress, not every intermediate
provider exchange in the eight-step loop.

A separate ninth test, `r3 OpenCode unpriced reset persists nine omissions and
replays original ingress`, isolates reset durability with a synthetic model and
without measured envelope metadata. At 95% it returns **3,098 bytes / 139 estimated
content tokens**, strips all nine blocks, persists nine omission IDs, empties the
queue and does not resurrect thinking on the original signed ingress. Removing
the omission write makes that exact test fail while its current output remains
small and contains no reasoning. This test requires a successful reset; an
exception cannot satisfy its assertions.

### Initial unpriced probe: not a demonstrated pressure defect

The earlier fixture used synthetic `r3-opus-5-5` with no measured system/tool
envelope. At 85%, the primary returned 363,053 bytes / **120,129 estimated content
tokens**, no reasoning and eight queued drops; subagent returned 218,662 bytes /
72,103 estimated content tokens. At 95%, both reset to small outputs. Those counts
include text, tool output and serialized arguments, not JSON envelope keys.
They are the repository's estimator, not measured Anthropic billing tokens.

That primary85 red run cannot establish a real-host non-fit refusal defect:
its route was deliberately unknown and its envelope unavailable. The existing
policy refuses only on **refusal-grade** evidence, not any synthetic local count.
When the same probe supplies the actual prefix-bound model and measured envelope,
**all four OC cases refuse visibly**. The final pressure contract therefore uses
those real-model inputs; the successful unpriced95 path is retained solely as a
separate, non-vacuous durability control. No expectation was inverted to bless an
oversized measured request. Unknown/unpriced requests remain a limit of this
review's unconditional fit proof, not a claimed accepted provider send.

The relevant final refusal/retry predicates are `transform.ts:2962-2993`: they
require over-limit refusal-grade evidence; recursive retry also requires active
thinking, and the refusal following reset uses the retry/fit-release state.
This distinction matters when comparing to Rust's trusted final-wire guard.

### Rust-mode comparison on merged master

The native wall witness verifies that an oversized signed tool-result loop fits
or refuses. Ran `review_r2_witness_signed_loop_over_window_must_fit_or_refuse`:
**1 passed**, cargo/rustc 1.99.0. It reports **104,122 tool-result tokens before,
45 after, zero pending drops, unchanged head**. Also ran the Rust host frozen,
emergency and latest-thinking recovery files: **52 passed / 251 assertions**.
These include refusal when a reset's whole request remains over-window and the
frozen fitting/untrusted/non-fitting replay distinctions.

The native primary guard (`crates/mc-module/src/transform.rs:7771-7797`) uses the
force band/95% state, a positive hard limit, trusted over-limit final-wire input,
and over-limit served text. It resets, then returns `SignedTurnOverLimit` if the
reset still cannot fit. This review reruns the named wall witness and host matrix;
it does not claim a new Rust differential for the exact OC85 fixture or universal
provider-token accuracy. The Rust implementation has continued to evolve beyond
the older r2 parity table; do not use that table's line numbers as current facts.

## 5. The Pi merge and existing contracts

The pipeline construction retains `fallbackInputFields` from master together
with `readLastServedMessages`, the held identity replay callback and retry snapshot
(`context-handler.ts:4812-4820,5257-5358,6023-6075`). The authoritative executed
merge check was the eight existing Pi suites:

- `issue-663-dispatch.test.ts`: **14** passed;
- `issue-667-superseded-fence.test.ts`: **6** passed;
- `issue-667-review.test.ts`: **8** passed;
- `issue-650.test.ts`: **16** passed;
- `issue-650-review.test.ts`: **16** passed;
- `issue-650-review-r2.test.ts`: **21** passed;
- `issue-650-review-r3.test.ts`: **24** passed;
- `issue-650-r3.test.ts`: **8** passed.

The first three preserve lifecycle/receipt attribution and dispatch admission.
The 650 matrix includes pairing/survivor evidence, dropped-message replay,
recurrence, damaged/full ledgers, carried repairs and LKG availability. No tests
were edited. The current `latest-turn-thinking.test.ts` also passes its held
identity, contention, cold-byte and all-or-none strip contracts.

**Issue 668 is a revision mismatch, not a verified merge success.**
`git merge-base --is-ancestor` returns **1** for both `850a28cbde` (issue-668
implementation) and `cf68110a93` (bounded nonces), and pinned master's tree has no
`packages/pi-plugin/src/issue-668-diagnostic-context.test.ts`. Both commits are
visible in repository history, but neither is in this reviewed ancestry. Running
a similarly named receipt test is not evidence for diagnostic-context isolation
or exact rejected-nonce retries. Next action: merge the issue-668 branch if it
is meant to be included, then rerun its unchanged suite plus 663/667/650. This
report does not graft unrelated product code into the review branch.

## 6. Mutation controls and the green caller-site control

Each real mutation used the required sequence: stage the live files, empty
`git diff --stat`, mark **`NON-VACUITY BREAK`**, capture a nonempty stat, run the
one named test on `linux,4c`, then `git checkout -- <path> && touch <path>` and
capture an empty stat. No mutation is committed. Every red selection below has
**exactly one failing test**, with other tests filtered rather than collateral
failures. No passing-only sample is counted as a red control.

| Control | Deliberate break | Exact selected test / outcome | Applied stat, then restored |
| --- | --- | --- | --- |
| Author #6 | One-line neutralization of shared `activeThinkingPrefixHold` before first-application lanes | `active-thinking shared bust permission > held execute denies thinking strip` — **red**, `old-answer` stripped | postprocess: `1+` / empty |
| Same guard, live-sequence selection | Same #6 mutant | `a flush in a held signed turn is parked through execute and defer passes and consumed by one release bust` — **red**, held flush bytes change at `:5408` | postprocess: `1+` / empty |
| Author #13 | One-line neutralization of Pi's shared `protectedSignedPrefix` | `Pi 66% signed-prefix hold denies thinking strip until the next user` — **red**, persisted `binding_mismatch:old-answer` | context-handler: `1+` / empty |
| Author #21 | First-neutralize on defer when the persistent flush set still contains the session | Same full live-sequence test — **red**, placeholder emptied at first 40% pass | postprocess: `1+ 1-` / empty |
| Review A | Do not delete the completed persistent flush signal | Same full live-sequence test — **red**, flush still pending after release at `:5442` | postprocess: `1+ 1-` / empty |
| Review B | Return successful thinking freeze without writing omission IDs | `r3 OpenCode unpriced reset persists nine omissions and replays original ingress` — **red**, nine expected durable omissions vs zero while the output has no reasoning | postprocess: `1+ 5-` / empty |
| Author #17, additionally rerun | `stripActiveTurn=false` only in initial Pi `stripForPrefixRewrite` | `Pi rewriting first render strips all thinking and admits queued work` — **green**, 6 assertions | context-handler: `1+ 1-`; instrumented reach proof `2+ 1-` / empty |
| Author #18, compensating control | Shared Pi strip helper always protects latest turn, ignoring `stripActiveTurn` | Same Pi first-render test — **red**, `sig-4` remains | provider-error-recovery: `1+ 1-` / empty |

**#17's green is acceptable for the tested successful return, not evidence that
all-thinking omission lacks a test.** An instrumented rerun proves the initial
caller actually executes: `activeThinkingTurn=true`, initial persisted result
contains only `old-answer`; the final output still contains no signature. #18
makes the final helper preserve `sig-4` and the exact test fails. The final helper
is a genuine second enforcement point.

**Do not remove the initial caller-site code solely because this successful-path
mutation is green.** Its `persistOnly` call records all omission IDs *before*
the pipeline adopts/rewrites the prefix and refuses if that persistence fails
(`context-handler.ts:7780-7806`; `provider-error-recovery-pi.ts:330-351`). The final
helper operates after pipeline/retry output exists (`context-handler.ts:6042-6059`).
The early durable ordering and final served-output enforcement have distinct
jobs. Removing that caller or its all-thinking flag would require additional
failure/interruption tests proving the early persistence is redundant, not just
this end-output check. No such removal is part of this review.

Two preliminary narrower mutations were also restored and are not counted as
the required author controls: changing only the final OC proactive permission
stayed green because no earlier prefix-edit opportunity was admitted; using
local `isExplicitFlush` in the defer mutant was **not reached** because the hold
clears that local flag while preserving the persistent flush set. The reachable
shared-veto and persistent-set mutations above then each reddened the exact
named test. This distinction prevents a predicate that cannot match a parked
flush from masquerading as a non-vacuity result.

## Gates and reproduction

All build/check/test/mutation commands ran on **Linux with exactly 4 vCPUs**.
No runner queue refusal occurred, so the requested five-minute retry was not
needed. No local unit-suite fallback or remote network access was used.
Versions: **Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1, Python 3.14.4,
cargo/rustc 1.99.0**.

| Gate | Result |
| --- | --- |
| Original r2 drivers/rulings, eight seeds | 88 passed, 250 assertions; strict binding and repeated-failure regressions green |
| Full unheld differential | 96 driver tests passed; 15,360 comparisons / 2,808 served divergences; original observational run exited 0, not a parity pass |
| Final nonzero comparator, seed 665 | 12 driver tests passed; 1,920 comparisons / 232 Pi divergences; comparator **exits 1** as required |
| Eight merge suites plus initial pressure probes | 113 existing merge tests passed; initial pressure-test assertions were subsequently narrowed from an unjustified 20k-byte size target to the actual 100k content-estimator limit |
| Initial unpriced transform/postprocess/latest-turn plus r3 probes | 401 passed, 2 failed / 403: unpriced OC primary85 estimate and one unrelated 5s auto-search timeout; not the final measured-envelope pressure result |
| Exact unrelated auto-search timeout rerun, `--timeout 30000` | 1 passed, 4 assertions; no code change |
| Final trace-count guard smoke check, seed 665 / 32 passes | 12 driver tests passed; 192 comparisons / 8 Pi divergences; exits 1, with all six host/seed traces required |
| Final measured-envelope pressure probes plus explicit durability probe | 9 passed, 27 assertions: all eight fit-or-refuse cases visibly refuse; the reset-durability case fits and persists all nine omissions |
| Rust native wall witness | 1 passed; 104,122 → 45 result tokens, zero pending |
| Rust frozen/emergency/latest-thinking host files | 52 passed, 251 assertions |
| Both package typecheck scripts | Passed; final OC cache-isolation/limit assertion checked again with plugin typecheck |
| Both full package lint scripts | Passed: 1,389 plugin / 315 Pi files; warnings only |
| Final scoped new-witness lint | Passed, one file per package; one Pi non-null-handler assertion warning |
| Linux plugin build plus real OC2 host | Passed; 9 compiled TUI files checked/unchanged; host 1 passed / 16 assertions |
| AFT scoped diagnostics for both new test files | 0 diagnostics; combined header partial for unavailable structural call-graph categories |
| Opt-in fences | 9 cases skip without MC_665_R3; all three reproduction scripts print skip without the gate |
| Comment review | Six source/report files examined; JSON data excluded; clarified source comments and added report terminology |
| Shell syntax | host.sh passed, GNU Bash 5.3.9 |
| Python syntax | 2 scripts passed |

Not run: the full unrelated package suites, a Pi CLI/provider host, an Anthropic
account, or the absent issue-668 suite. This report does not substitute r2's
unheld trace-generation successes for the new master parity check. Failed
first attempts due to a missing generated `test` import, an incorrect tarball
binary suffix and a selector aimed at the wrong test file were corrected; none
is counted as a completed behavioral check.

Commands (from the worktree):

```sh
# Check that signed thinking never follows changed bytes (round-2 review tests).
R2_SEEDS=665,664,650,1,2,3,7,8 R2_PASSES=150 R2_UNHELD_PASSES=320 \
  bun test packages/plugin/src/hooks/magic-context/issue-665-hold-review-r2.test.ts \
  packages/pi-plugin/src/issue-665-hold-review-r2.test.ts

# Check fit-or-refuse and durable omissions: nine passes on 2e63dd6965.
MC_665_R3=1 bun test --timeout 30000 \
  packages/plugin/src/hooks/magic-context/issue-665-hold-review-r3.test.ts \
  packages/pi-plugin/src/issue-665-hold-review-r3.test.ts

# Prepare baseline locally, then transfer the worktree to a disposable Linux job.
# _base is temporary input, never committed. All commands require MC_665_R3=1.
MC_665_R3=1 python3 docs/reports/issue-665-hold-review-r3/extract-base.py \
  docs/reports/issue-665-hold-review-r3/_base
MC_665_R3=1 MC_665_R3_SCRATCH=1 \
  BASE_SRC=docs/reports/issue-665-hold-review-r3/_base \
  R3_OUT="$TMPDIR/r3-differential" \
  python3 docs/reports/issue-665-hold-review-r3/differential.py
# Expect exit 1 for unheld master-byte differences. R3_SEEDS=665 selects one seed.

# Real host: download this platform archive locally, transfer it as temporary input,
# and invoke on Linux. Never use a live installation's HOME/XDG/store roots.
MC_665_R3=1 R3_HOST_TARBALL=/absolute/path/to/cli-linux-x64-2.0.26.tgz \
  bash docs/reports/issue-665-hold-review-r3/host.sh

bun run --cwd packages/plugin typecheck
bun run --cwd packages/pi-plugin typecheck
cargo test -p mc-module --lib \
  review_r2_witness_signed_loop_over_window_must_fit_or_refuse -- --nocapture
```

The JSON evidence files are compact immutable summaries of executed output,
outside regenerable build directories. The mutation table above names each
selected test, its intentional code break and its failing or passing result.
