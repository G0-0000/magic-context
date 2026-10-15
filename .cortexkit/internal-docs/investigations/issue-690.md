# Trailing filtered historian rows: coverage repair

## Confirmed mechanism

The provider-free `todowrite` invocation/result pair from the public report
reproduces the defect in both readers at master
`d376a848a5de45f51fe1efdf9df4a77e8355a9fd`.

- TypeScript: `read-session-chunk.ts` folds a separate result into the invocation
  expansion, then `recordFilteredNoise` queues the result's metadata. The final
  flush previously advanced only the scan watermark. The real reader returned
  end 1, count 1 and arc 1→2. Expansion disabled and a visible successor returned
  ends 2 and 3 respectively.
- Rust: `historian_chunk.rs::Builder::push_message` filters expanded tool-result
  blocks and queues the result's `MessageMeta`. Final flushing likewise omitted
  terminal pending metadata. The matching regression returned end 1 instead of
  2, while both controls passed.
- Coverage validation correctly checked the advertised interval, not the missing
  frontier. The terminal healer correctly refused to extend through an arc beyond
  that frontier. No validator, healer, terminal guard, model, retry, budget, schema,
  or migration code was changed.

## Repair and filtered-noise policy

After successful final block admission, append trailing filtered metadata to the
chunk's raw coverage and advance its endpoint ordinal/ID and count. Do not render
duplicate text or change token accounting. A failed final block admission must
not let trailing noise jump over budget-rejected visible content.

TypeScript rows always retain their raw message ID. Filtered expanded results,
ignored text, pure reminders, internal initiator markers, directives, empty text
and zero-part rows can all join existing nonempty coverage, just as they already
do when a later visible row absorbs them. All-noise chunks retain their separate
`filteredNoiseLines` persistence path; they do not become contentful chunks.

Rust has the same expansion defect and repair, but zero-block messages have no
flat-block ID. They cannot be persisted endpoints: `MessageMeta` marks them
unanchorable, and `historian_validate.rs::map_parsed_compartments_to_chunk`
rejects unanchorable/empty-ID ends. Therefore only absorb through the last
anchorable pending row; an unanchorable suffix remains outside advertised coverage
until a real successor can own it (or the existing all-noise progress path handles
it). The scan watermark still includes that suffix. Tests cover reminders,
empty text, system-role metadata, interposed zero-block rows and a zero-block tail.
Rust directives are not currently filtered into pending noise by its rendering
path; that unrelated behavior is unchanged.

## Eligible-end safety

The readers consume an exclusive caller-selected eligible end. They must not read
past it to manufacture a completed pair. TypeScript selection fences completed
arcs using the wider snapshot at `protected-tail-boundary.ts:768-772`;
`read-session-true-raw-tokens.ts:532-568` retreats a crossing end to the invocation
when it is not already covered. A new real-reader test fences an end through a
2→3 arc back to 2 and confirms only the earlier row is offered. Rust uses the
same completed-component fence in `boundary.rs:1338-1395`; the chunk regression
confirms a fenced exclusive end excludes the invocation. Existing Rust boundary
tests for ordinary/reasoning completed arcs also pass. No selection policy changed.

## Differential evidence

`read-session-chunk-differential.test.ts` compares SHA-256 digests of **complete
serialized chunk objects** (text, counts, IDs, metadata, arcs, result boundaries,
and flags) with reference outputs captured before editing the master reader.
The deterministic seed is 690. The 1,002 cases comprise:

- 600 randomized visible-ended eligible slices, with internal noise, expanded
  split tool results, role merging, commits, offsets, and expansion on/off;
- 400 randomized noise-free cases at budgets 1, 20, 80 and 100,000;
- 2 shared expansion fixture cases, with expansion on/off.

All reference digests remain identical after the repair:

```text
visibleEnded a5c23476c9f336e415fd5c9d03d24f145440de3f8d5fe380a2861a07243d2ead
budgeted     7fc52610561735f7c7b6d766f36147302871898ec03e44f98075a3d68ad0e268
fixture      db81787ce0674b0f1177ab0609d96fc26036a4a87e101878aacf13ae24b927ef
```

The randomized ample-budget cases end at a visible eligible row; the budgeted
cases contain no filterable rows. Thus none can silently classify a changed
terminal-filtered case as an allowed mismatch. Rust's existing historian chunk
and input-source goldens also pass unchanged.

## Mutation evidence

Both mutations were applied only after staging the implementation and confirming
an empty unstaged `git diff --stat`. Each changed one source line to disable the
terminal metadata admission with an explicit temporary mutation marker, was tested on Linux, and was
restored using `git checkout -- <path> && touch <path>`. Each restoration produced
an empty unstaged diff. Neither mutation remains in the source.

1. TypeScript: `read-session-chunk.ts`, 1 file, 1 insertion/1 deletion while
   mutated. The exact failing test was `trailing filtered chunk coverage >
   expanded result-only tail preserves coverage and maps the healed terminal
   endpoint`, expected end 2, received 1. The `expansion disabled` and `visible
   successor` endpoint controls and the 1,002-case differential stayed green:
   3 passed, 1 failed, 9 filtered out.
2. Rust: `historian_chunk.rs`, 1 file, 1 insertion/1 deletion while mutated.
   `historian_chunk::tests::trailing_expanded_result_coverage` alone failed,
   expected end 2, received 1. The `expansion_off_control` and
   `visible_successor_control` tests stayed green: 2 passed, 1 failed.

## Verification

All execution gates ran on the Linux runner. No host session or live store was
opened. Source formatting and Git operations were local.

- Bun 1.4.2: scoped reader/expansion/validation/differential run passed 66 tests
  before the final additional noise/fence assertions. The full plugin run after
  those additions passed 8,169 tests, skipped 33 and failed 9 bundle-review tests
  because ignored `dist/auto-search-worker.js` artifacts were absent remotely.
  After `bun run build`, only that failed suite was rerun: 9 passed, 2 skipped,
  0 failed. No unrelated source changes were needed.
- Final focused coverage/differential run: 13 passed, 0 failed, 90 assertions;
  all 1,002 serialized chunk outputs still match master. Final package typechecks
  and changed-file lint also passed after the comment review.
- `bun run build`: passed for plugin, Pi plugin and CLI; TUI checked 9 generated
  files with no drift.
- `bun run --cwd packages/pi-plugin test`: 2,331 passed, 40 skipped, 0 failed.
- TypeScript 5.9.3: plugin and Pi package `typecheck` scripts passed (three and
  two project checks respectively).
- Biome 2.5.1: plugin and Pi `lint` passed, checking 1,434 and 349 files. Existing
  unrelated warnings/infos remain. Changed-file check has no diagnostics.
- Cargo 1.99.0: `cargo test -p mc-module` passed all 1,810 library tests with
  27 ignored, plus the integration targets reached before `real_daemon`.
  Four `real_daemon` tests failed at `tests/real_daemon.rs:1087` because the runner
  lacks the sibling `subconscious` checkout required by `fs::canonicalize`.
  No daemon/host was launched by those failing tests; they fail before staging.
  This environment-dependent suite was not retried or supplied a live host.
- Clippy 0.1.99: `cargo clippy -p mc-module --all-targets -- -D warnings` passed.
- rustfmt 1.10.0: `cargo fmt --check` passed.
- Tool diagnostics: no TypeScript/Biome diagnostics in changed files. Rust tool
  diagnostics were partial because worker cargo-check integration is disabled;
  the compiler tests and clippy above are authoritative.

The one existing assertion intentionally changed is the filtered-tail endpoint
test: it formerly pinned end 2 after two filtered rows; it now pins end 4 plus
the endpoint ID, count and contiguous metadata. Its no-more-work and omitted-text
claims remain unchanged.
