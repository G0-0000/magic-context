# Chair rulings — protected_tokens campaign ct_00000000-0000-4001-98d2-1426c0049690, after round 3

These are normative. They resolve the two outstanding external rulings and the slice-plan fence rejection.

## Ruling 1 — the structural minimum is defined in tag-number space, not as "completed arcs"

Replace "newest-3 completed tool arcs" everywhere with: **the newest 3 tool-kind tags by `tag_number` (descending), regardless of completion state.** Rationale: open arcs are already never reclaim targets on every lane (`partHasCompletedResult` on TS/Pi; result-less arcs excluded in Rust selection), so an open arc counted among the 3 costs nothing and protects one fewer completed arc — an acceptable, strictly-safe over-protection. Consequences:
- No persisted ownership/completion field is required on either leg. `McTagRow` stays as it is at the pinned snapshot; the schema fence remains "floor snapshot + coordinate mapping only". Item (4) of the four-item fence enumeration is DELETED.
- The canonical protected set is `mass_window ∪ newest3_tool_tags`. Both operands are suffixes of the tool-row sequence ordered by `tag_number`, so the union is a suffix and the **cutoff form is exact**: `protected(row) := row.kind == tool && row.tag_number >= cutoff`, `cutoff = min(mass_cutoff, newest3_cutoff)`. Suffix contiguity is by construction, not a per-pass check; drop the fail-closed "convert cutoff consumers to set forms" machinery.
- Tie groups (rows sharing a `tag_number` — Rust call/result block rows of one invocation, TS composite-key rows for one invocation) are atomic under any `tag_number` comparison by construction. The mass walk accumulates a whole tie group before testing the floor (already ruled); the cutoff form inherits atomicity for free.
- Message/file-kind rows are never reclaim targets and are excluded from the walk and from the cutoff predicate.
- Fixture F7 stays but is re-stated: the minimum reaches past the mass boundary with an open arc among the newest 3 and a tie group at the added boundary; assert exact consumer membership on both legs equals the cutoff predicate over tool rows.

## Ruling 2 — defer-pass branch for mid-epoch contraction: there is no branch

The walk reads persisted rows and the epoch floor snapshot only; it never reads the served array. Served-array contraction/re-expansion (marker windows, #386 class) therefore cannot change membership. On a defer pass the computation is identical to an applying pass; its only consumers are (a) candidate eligibility, which lands nothing on a defer pass (first-application stays gated to busting passes — unchanged), and (b) the Channel-1 hint list, which is tail-only bytes on new tool outputs and cannot bust a prefix. Within a floor epoch the cutoff is monotone non-decreasing because per-row mass only grows (re-occurrence bump, NULL backfill) — contraction only. Required test: applying pass → marker contraction → defer pass → re-expansion; assert the cutoff and the hint list are identical across all three and that no prefix byte changes. Remove the open question.

## Ruling 3 — slice plan: disjoint fences, re-cut as follows

Slices must own disjoint path sets; no slice may touch another slice's paths. Re-cut:
- S1 TS core: `packages/plugin/src/features/magic-context/protection-window.ts` (new) + `storage-tags.ts` + their tests. Owns the walk, the cutoff, the floor snapshot read.
- S2 TS consumers + config: `packages/plugin/src/config/**`, `packages/plugin/src/hooks/magic-context/{supersession-reclaim,apply-operations,emergency-drop,tail-hygiene-walk,ctx-reduce-nudge}.ts` + tests, `packages/plugin/src/features/magic-context/storage-meta-persisted.ts` (floor snapshot write). Depends on S1.
- S3 Pi: `packages/pi-plugin/src/**` only. Depends on S1.
- S4 Rust: `crates/mc-module/src/**`, `crates/mc-store/src/**`, `crates/mc-module/tests/**`. No TS paths. Depends on S1 (for the golden generator inputs only; the generator lives in `crates/mc-module/gen/**`, owned by S4).
- S5 surfaces: `packages/cli/src/**`, `packages/dashboard/**`, `packages/docs/**`, `README.md`, `CONFIGURATION.md`, `packages/plugin/assets/**`, release notes. Deprecation warning surfaces for the dead key. Depends on S2.
- S6 verification: `packages/e2e-tests/tests/protected-tokens*.test.ts` (new files only) + the mode manifest entry. Depends on S2–S4.
No slice touches `packages/*/src/protection/**` or `packages/*/test/protection/**` (those paths do not exist and must not be created).

## Ruling 4 — fold and mint after importing these rulings; no further panel rounds are required for them.
