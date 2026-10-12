# Active thinking prefix hold (issue 665 and issue 664)

## Review follow-up

The independent review and its two tests were cherry-picked from `62fa1e27`.
The follow-up narrows the directory veto back to m[0]/m[1] injection only. A
failed lookup cannot stop queued reductions, heuristic cleanup or a useful
explicit flush; the cached project memory/docs pair remains unchanged.

The active-thinking veto applies only while there is a reusable prefix. First
render without a cached pair and an idle-expired, already-cold cache admit safe
reductions, routine cleanup and older-thinking stripping in the same pass.
Per-target thinking protection still retains unsafe operations. Tests cover
both hosts and a cold pass whose queued operations are all protected. Separate
85% and 95% tests defend the existing pressure exceptions.

A carried Pi identity repair is checked before adoption/tagging can expose its
folded numbers. With a fitting LKG, the handler returns the last served prefix
plus the new raw tail; it does not clear m[0]/m[1], acknowledge the repair or
record a tag-identity calibration bust. The next permitted pass completes it.
When no fitting replay can be proved, the parent selected one deliberate,
attributed identity rebuild rather than refusing every step of the tool loop.
That pass clears the cached pair, uses the folded numbers, admits eligible
cleanup and acknowledges once. Both branches have real-handler tests.

The cache-safe unheld Pi contention behavior is retained and pinned: a
contended preflight with no other invalidation replays the old todo snapshot,
preserves sticky anchors and keeps older thinking. A successful subsequent
fold demonstrates that all three edits become available when permission returns.
Hold-log state is pruned by the OpenCode 1 and OpenCode 2 deletion seams.

The original host differential below remains the warm-cache issue-665 scenario;
its after arm is rerun against the follow-up code. Rust is a separate task and
is unchanged here.

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

Each host used a fresh root below `$TMPDIR/magic-context/bg_a50a6413bb418af2/`.
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
`touch`. Exact red test names and observations are included in the delivery's
mutation evidence.

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
- Plugin and Pi lint scripts: passed (warnings only; 1,378 and 303 files checked).
- Pi full suite: 1,988 passed, 28 skipped, zero failed (2,016 tests).
- Plugin full suite after building both packages on Linux: 7,721 passed,
  27 skipped, one unrelated fixture failure (7,749 tests). All bundled-worker
  tests pass with Linux-built artifacts.
- One unrelated fixture remains failing: `Node WASM Transformers fixture > builds
  with real fs and persists a model for offline reuse`, because its temporary
  bundle cannot resolve `onnxruntime-web/webgpu`. No embedding or fixture code was
  changed to conceal that failure.
- Focused changed-file gate before the final cold-only Pi fixture: 421 passed,
  zero failed across five files with the repository's file-isolated `--parallel=4`
  setting. The added cold-only fixture passed separately, and the final full
  suites include it and all follow-up regressions.
- Linux builds: plugin bundled 708 modules for the main entry and 750 for v2;
  Pi bundled 1,013 modules. Nine compiled TUI files were unchanged.
- The original host-test typecheck (the test file is unchanged in this follow-up)
  found zero owned diagnostics in the full e2e project, with exactly one owned
  test checked among 3,295 source files. That broader project had 30 diagnostics
  in other files, so its aggregate tsc gate was not clean.
- Real-host after arm: one test passed, 16 assertions. The before arm reddened only
  that same test with one loop prefix change instead of zero. The host gates ran
  locally because the installed 2.0.26 executable is a macOS binary.
- Scoped live diagnostics covered all four changed implementation files: no
  errors; one existing unused-import warning and its corresponding hint. The
  snapshot was fresh.
