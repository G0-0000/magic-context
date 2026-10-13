# Active thinking prefix hold (issue 665 and issue 664)

## Round-three unheld compatibility correction

Imported the third review and its witnesses from `5925c21a979ccd9ce7c48fb76cbe2cba47776aef`.
It found 2,808 changed serves out of 15,360 comparisons: every first divergence
was at idle expiry, with unresolved-directory fallback also required on OpenCode.
The earlier revision had authorized extra cleanup even without an unfinished
thinking turn, changing preexisting behavior. Pi now grants that additional
cleanup and permission to strip thinking only while signed thinking holds the turn.
OpenCode again respects its existing unresolved-directory veto for idle timers;
its extra heuristic and emergency pricing also stays confined to held turns.
Actual unheld history rebuilds, explicit flushes and pressure relief retain their
existing admission rules. The initial durable thinking-omission call is unchanged.

The reviewer's `MC_665_R3` differential now reports **zero served differences and
zero state differences across 15,360 comparisons**, both before and after merging
master through `e3dcfd39338a33f01ca28f63f98f89e706c69ce0`. It compares against pinned
master `24ebef59`, the pre-change compatibility baseline; `e3dcfd39` is the later
master merged into this branch. Eight seeds and 320 passes per sequence cover
OpenCode 1, OpenCode 2 and Pi transforms. One shape has no signed thinking anywhere;
the other has signed final answers only in completed turns followed by a user,
not in the current turn. All 96 driver tests pass.
`unheld-parity-after.json` retains the merged-tree result outside build directories.

Two direct regressions pin the distinction. Pi's unheld idle expiry keeps the
queued drop, completed thinking and exact served bytes until an explicit flush.
OpenCode's unresolved-directory plus idle-expiry pass likewise leaves the queued
drop and bytes intact, while its existing explicit-flush regression still drains
the eligible drop. Removing either host's idle prerequisite makes only its named
test fail; restoring both returns the three-test selection to green. The prior
Pi test asserting extra cleanup on unheld idle expiry was intentionally changed
to preserve master behavior instead. The three cases are **Pi unheld idle expiry
preserves queued work and completed thinking until a priced rewrite**, **directory
fallback and unheld idle expiry do not authorize a queued drop**, and **directory
fallback freezes injection but drains an execute-threshold queued drop**.

Merged master's OMP diagnostic-context dispatch handling (`fb4792c4`, issue 668)
and release notes without conflicts. On the merged tree, Linux with 4 vCPUs,
Bun 1.4.2, TypeScript 5.9.3 and
Biome 2.5.1: both builds, typechecks and lint scripts pass. Diagnostic-context,
OMP dispatch and supersession fencing, and durable tag-identity/served-pair suites
(668, 663, 667 and 650), plus hold/latest-thinking/Rust-mode/pressure regressions pass
**1,136 tests with 19 skips and zero failures** across 29 files (11,625 assertions).
The held drivers cover 3,600 passes: no kept signed block follows a change to its
preceding provider-visible bytes. All eight measured pressure cases visibly
refuse; the unpriced reset case persists nine
omissions and fits. Builds bundle 712 plugin-entry, 754 v2 and 1,022 Pi modules;
lint checks 1,389 plugin and 317 Pi files, warnings only. Temporary baseline copies
were removed after verification. No live stores or host services were used by
these unit and differential runs.

## Current-master integration and second witness

Merged `origin/master` through `24ebef59e11a61a0317aafe53ce16c73451b7439`. The sole
textual conflict was Pi's pipeline argument construction. It retains master's
`fallbackInputFields` reuse together with the held-repair replay callbacks and
the signed-thinking fit-retry argument snapshot. Dispatch/receipt fences, the
per-pass fast paths, stall-read fixes and the Rust-mode hold/reset implementation
were retained from master; no held-turn or flush rule had to be discarded.
The first merge included the Rust hold revision at `1c947fb0e8`; a second clean
merge included the newer search changes and reports. The hold suites, every
mutation selection and both Linux host arms were rerun after that second merge.

The regression named **a flush in a held signed turn is parked through execute
and defer passes and consumed by one release bust** now explicitly covers the
second witness. At 75.1%, all 33 queued drops remain pending and their tags stay
active. An old dropped-message placeholder remains visible with no persisted
neutralization. A flush is parked, the queue grows to 401, and repeated 40% defer
passes neither strip thinking nor first-neutralize that placeholder. A real next
user applies the queue and neutralization together, consumes the flush once, and
subsequent serves remain identical. The test passes 28 assertions. A defer-only
neutralization mutant fails at the first 40% pass: the old placeholder becomes
empty while signed thinking remains. This is independent of the shared-veto
mutation, which also makes the same test fail.

All merged-tree gates and mutation selections ran on **Linux with 4 vCPUs**, Bun
1.4.2, TypeScript 5.9.3 and Biome 2.5.1. Both builds, both typechecks and both lint
scripts pass. Full package suites on the first merged snapshot reported Pi:
2,106 passes with 32 skips (2,138 total), and plugin: 7,857 passes with 28 skips
and three failures (7,888 total): the existing ONNX fixture and two timing-sensitive
SQLite diagnostic
checks. The latter file passes all five tests when rerun in isolation; it was not
edited. Every original mutation control was rerun, with the same outcomes, plus
the two second-witness controls described above.

The final restored hold, strict-binding and Rust-mode regression gate passes
940 tests with one skip across 11 files (10,659 assertions). This includes the
strengthened witness after restoring both of its mutants. Plugin typecheck and
lint also pass after the added assertions; the initial formatting-only lint
failure was corrected without changing the test contract. There are 21 merged-
tree mutation selections: 20 named tests fail alone, while the previously noted
Pi caller-only omission control stays green because the final helper repeats it.
Final builds bundle 712 plugin-entry, 754 v2 and 1,021 Pi modules. Final lint
checks 1,388 plugin and 314 Pi files, with warnings only.

The real OpenCode **2.0.26 Linux** differential also has the same result: zero
loop rewrites and one next-user rewrite after the fix, versus one loop rewrite
and two total with the shared veto neutralized. `merged-linux-host.json` retains
the measured hashes, counts, host PIDs and normalized `lsof` inventories. Both
host runs had only throwaway database descriptors; the runner removed both roots.
The Linux CLI tarball was fetched locally and transferred as temporary input,
not installed with remote network access or added to the repository.

## Review follow-up

The independent review and its two tests were cherry-picked from `62fa1e27`.
The follow-up narrows the directory veto back to m[0]/m[1] injection only. A
failed lookup cannot stop queued reductions, heuristic cleanup or a useful
explicit flush; the cached project memory/docs pair remains unchanged.

The final revision also enforces strict signed-thinking binding. Losing the
provider cache to idle expiry does not invalidate the signatures: while any
signed block is kept, its preceding bytes and m[0]/m[1] rendering stay unchanged.
An already-cold pass can admit eligible suffix work, not older-thinking stripping.
A first render that genuinely changes previously served knowledge, a necessary
identity rebuild, or an emergency fit retry persists omissions of **all** signed
blocks, including the active turn, before rewriting their prefix. First render
that reproduces the served pair keeps every block. Separate 85% and 95% tests
defend the existing pressure exceptions.

A carried Pi identity repair is checked before adoption/tagging can expose its
folded numbers. With a fitting LKG, the handler returns the last served prefix
plus the new raw tail; it does not clear m[0]/m[1], acknowledge the repair or
record a tag-identity calibration bust. The next permitted pass completes it.
When no fitting replay can be proved, the parent selected one deliberate,
attributed identity rebuild rather than refusing every step of the tool loop.
That pass first persists omissions of every signed block, clears the cached pair,
uses the folded numbers, admits eligible cleanup and acknowledges once. Tests
cover fitting, missing and unpriceable LKG evidence. A durable cache-clear failure
may refuse once; persistent failures keep the repair pending without repeatedly
interrupting later turns.

The cache-safe unheld Pi contention behavior is retained and pinned: a
contended preflight with no other invalidation replays the old todo snapshot,
preserves sticky anchors and keeps older thinking. A successful subsequent
fold demonstrates that all three edits become available when permission returns.
Hold-log state is pruned by the OpenCode 1 and OpenCode 2 deletion seams.

The host differential below was rerun against the final strict-binding revision.
The held execute/flush/401-op/defer sequence is also pinned: flush intent stays
parked throughout the loop and is consumed once when the next user releases it.
Pi's target protection uses the projected mutation view, not raw message indices,
so empty shells cannot shift a boundary ahead of a retained signature. Rust is a
separate task and is unchanged here.

## Real-host differential

The committed OpenCode 2 test uses **OpenCode 2.0.26**, the real host's shell and
ctx_reduce tools, and an Anthropic-shaped mock provider. It first completes an
older task with signed thinking, then runs a new thinking/tool loop. ctx_reduce
queues two drops; the provider reports 66,000 input tokens, above the configured
65% execute threshold (66.7% of the host's output-reserved window). Three later
parallel shell calls move the working-set protection beyond the queued targets.
The next real user arrives at 61,000 tokens, below the execute threshold.

| Arm | Shared-prefix changes inside loop | Including next user | Pending rows before/after next user |
| --- | ---: | ---: | --- |
| Before: shared frozen-prefix veto neutralized | 1 | 2 | 2 / 0 |
| After: veto restored | 0 | 1 | 2 / 0 |

`before.json` and `after.json` contain the measured hashes, pass decisions, host
PIDs, and open database paths. The before arm neutralizes only the active-thinking
veto; on this warm-cache fixture that restores the old permission, while retaining
corrected logging. The same regression
test fails on the before arm and passes on the after arm. This measures provider
request content, not simulated cache billing or estimated savings. Only moving
`cache_control` breakpoints are excluded from byte comparisons; system content
and every previously served message remain part of the comparison.

The final after host was PID 57132; the before host was PID 68261. Each used a
fresh root below `$TMPDIR/magic-context/bg_a50a6413bb418af2/`.
HOME, all XDG roots, the host database, and Magic Context storage were private.
The runner inventories the entire host process group with `lsof -p`; the test
also inventories the host PID directly. No live store was opened, even read-only.
Hosts were stopped and the temporary roots and installed CLI were removed after
verification. Evidence is retained here, outside build output directories.

To repeat with an installed CLI version at least 2.0.24:

```sh
bun run --cwd packages/plugin build
mkdir -p "$TMPDIR/magic-context/prefix-hold/runs"
MC_E2E_OPENCODE2_CLI=/absolute/path/to/opencode.exe \
TMPDIR="$TMPDIR/magic-context/prefix-hold/runs" \
MC_HOLD_REPORT="$PWD/after.json" \
bun test packages/e2e-tests/tests/opencode2/active-thinking-prefix-hold.test.ts
```

The repository pins an older CLI, so this test skips when that older host is
selected. The measured differential above explicitly selected 2.0.26.

## Unit and mutation coverage

The primary transform regression warms m[0]/m[1], queues old and active-turn
drops, and requests a system-hash fold at 66%. Two held passes preserve the entire
served array. One next-user pass rebuilds the pair and drains both drops. It also
checks the active-thinking reason once per user turn. Directory-fallback coverage
checks the other reason and its per-turn deduplication.

Plugin lane controls observe pending drain admission, actual heuristic/caveman
admission, the age-sweep watermark, the persisted todo anchor, and the proactive
strip result, as well as complete served bytes. Removing the shared veto reddens
each named lane test individually. Disconnecting heuristics from that shared
permission also reddens the heuristic and caveman tests.

Pi controls observe pipeline gates, history-signal retention, auto-search
admission, sticky-anchor GC, todo anchoring, strip persistence, and placeholder
discovery flags. A separate ambiguous-identity fixture proves that unproven tag
repair stays unmerged while held and can repair after permission returns. These
controls were run individually with only their named test selected. For each
mutation, the index first held the implementation, `git diff --stat` was nonempty
with the mutant applied, and empty after `git checkout -- <mutated path>` plus
`touch`. The final revision reran all thirteen named lane controls individually:
each selected test failed alone. The force-band and wall controls now also fail
when emergency admission is disabled. Complete-omission controls fail when active
thinking is excluded from a necessary rewrite. One Pi caller-only omission mutant
stayed green because the final strip repeated the same decision; disabling that
decision in the shared strip helper failed the named first-render test. Exact
controls, outcomes and applied/restored diffs appear in the delivery evidence.

The Pi trim-only force regression was not inverted: its initial strip now runs
after the initial turns end. An initial active-thinking hold would intentionally
leave published work pending, making the later force pass no longer trim-only.
Source-contract expectations now name the shared permission and held history
retention rather than the former unconditional identity-rebuild override.

## Rust audit (unchanged)

Rust has an analogous split, but not the identical TypeScript permission site.
`crates/mc-module/src/transform.rs:5208-5211` disables ordinary prefix
materialization for the signed hold. Independent flush/pending authorization at
`5285-5301` and `5520-5527` can still discover mutations; the classifier can choose
SOFT/HARD, whose byte composition is at `6048-6067` and `6376-6394`. The returned
permission follows that served plan (`5800-5807`, `7674`), not the hold. Closing
only the response boolean after composition would hide a mutation rather than
prevent one. Correcting classification and frozen replay across those branches
is not the same few-line permission fix, so Rust was audited but not modified.

## Verification outcome

All package gates below ran on Linux with 8 vCPUs, Bun 1.4.2, TypeScript 5.9.3,
and Biome 2.5.1. Package unit suites did not export OPENCODE_DB.

- Plugin and Pi typecheck scripts: passed.
- Plugin and Pi lint scripts: passed (warnings only; 1,380 and 304 files checked).
- Pi full suite: 2,016 passed, 28 skipped, zero failed (2,044 tests).
- Final plugin full suite after both Linux builds: 7,758 passed, 27 skipped,
  one unrelated fixture failure (7,786 tests). The initial run's four missing-Pi-
  artifact failures all passed after building Pi, including a nine-test isolated
  worker-file rerun (two skips).
- One unrelated fixture remains failing: `Node WASM Transformers fixture > builds
  with real fs and persists a model for offline reuse`, because its temporary
  bundle cannot resolve `onnxruntime-web/webgpu`. No embedding or fixture code was
  changed to conceal that failure.
- Linux builds: plugin bundled 709 modules for the main entry and 751 for v2;
  Pi bundled 1,014 modules. Nine compiled TUI files were unchanged.
- Final restored Pi regressions: 66 passed across three files, 339 assertions.
  The full plugin suite includes all restored OpenCode lane, pressure and strict
  binding controls.
- The original host-test typecheck (the test file is unchanged in this revision)
  found zero owned diagnostics in the full e2e project, with exactly one owned
  test checked among 3,295 source files. That broader project had 30 diagnostics
  in other files, so its aggregate tsc gate was not clean.
- Final real-host after run: one test passed, 16 assertions. The before run failed
  only that same test with one loop prefix change instead of zero. The host gates ran
  locally because the installed 2.0.26 executable is a macOS binary.
- The final gates and mutation selections use Bun 1.4.2; package tools report
  TypeScript 5.9.3 and Biome 2.5.1. An 8-vCPU mutation job was refused before start
  because the shared runner was full; its single-test selections subsequently
  completed on Linux with the appropriate 2-vCPU allocation. No local unit-suite
  fallback was used.
- Final scoped diagnostics covered six implementation files: zero errors, two
  lint warnings and one unused-import hint. Structural-analysis categories were
  unavailable, so the combined inspection was partial; package typechecks are
  the authoritative clean diagnostic gates.
