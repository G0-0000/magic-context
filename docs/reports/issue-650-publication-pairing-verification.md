# Pi served-number / last-good publication: implementation and verification

Baseline: `82a3f0c11ad77ce5dfe09ff775b1277184bd9cab`. The original regression in `issue-650-lkg-served-pairing.test.ts` is unchanged.

## Durable boundary and transition

A **capturable** managed context pass commits synchronously. The existing `saveLkgSlotToDb` immediate SQLite transaction saves the request chunks and metadata, then runs the served-number publication callback before committing. Any callback/storage failure rolls back the request and its identity delta together. Publication evidence is not a precondition for serving an otherwise completed managed transform. No schema, table, column, or migration changed.

The cumulative assigned numbers live in the existing v2 replay envelope in `session_meta.trailing_blank_decisions`, under `piServedTagNumbers`. Updates use the envelope's existing compare-and-swap helper and preserve its other namespaces. This state is independent of LKG pruning/invalidation: removing old history or rejecting a replay does not authorize renumbering previously served identities. An unchanged identity set does not rewrite the envelope. The LKG save's fingerprint shortcut cannot skip a supplied publication callback.

Adoption reads the union of the legacy number JSONL and the SQLite-committed numbers, once per adoption invocation rather than once per colliding tag. Existing JSONL-only evidence remains honored and is imported during successful publication. The number JSONL is a cumulative compatibility mirror, appended only after a successful pair or admitted number-only commit. A missing mirror is repaired from committed numbers on the next successful publication, including validated LKG replay. An unreadable SQLite envelope does not erase valid legacy JSONL evidence. Compaction-off remains a distinct mode; side turns do not publish managed identities.

The serving policy is:

1. A capturable request commits its LKG and number delta together, then installs memory evidence while the outcome guard still admits the invocation.
2. Recurring capture limitations (unavailable branch, identical unsaved twins, unidentifiable input, or a snapshot that cannot be saved) still serve the transformed bytes. Their assigned numbers commit independently in the existing envelope, **after outcome admission**, without creating an LKG. This preserves numeric identity across a later conflicting real row or session reload.
3. An unreadable or future-version envelope remains byte-for-byte untouched. The transformed result still serves with neither new LKG nor new number evidence. A later unproven conflict uses the existing one-time repair.
4. A transient pair or number-only commit failure rolls back its publication and still serves the completed transformed result. It never substitutes unmanaged history. Storage admission, transform failures, ownership checks and OMP receipt rules outside optional publication retain their prior precedence.
5. A post-commit mirror failure still serves the authoritative pair/numbers and is repaired on a subsequent successful publication.

The served cache/digest ledger and identity-repair acknowledgement follow a successful identity commit. An uncaptured request clears usage attribution so its assistant cannot be measured against an older capture. Empty host history with no new numbers keeps its prior behavior. Every number-only, skipped, failed-commit or failed-mirror outcome emits a typed `publication` pass-metric sample with `count: 1`, status and stable reason. Warning lines are suppressed per session/reason with a process-local 1,000-session cache that survives context-cache clearing; observers cannot turn diagnostic failure into refusal.

SQLite and filesystem calls remain cooperatively, not preemptively, fenced. Outcome admission precedes both pair and number-only transactions. A native commit can nevertheless return after 25 seconds; its admitted durable state may exist, but the post-commit guard rejects the result before subsequent evidence and dispatch. This late-native-commit edge remains an explicit limitation, not an authorization to start writes after expiry. If a mirror crosses the deadline, the post-write guard still refuses dispatch; in the original capturable regression its numbers already have a matching committed request. The OMP managed-receipt fence is unchanged.

## Test contract changes

The initial mandatory-capture interpretation has been removed. The original branch-unavailable, twin, note-ref and unreadable-envelope **serving and numeric-identity assertions are restored**, without legacy seeding or weakened identity selection. Additional observations assert no new LKG is saved for recurring limitations, the admitted numbers remain honored, each affected pass is counted, and only one warning is logged per reason. Unreadable/future envelopes instead assert no new LKG/number evidence and unchanged stored bytes. Malformed native lanes inside a valid envelope still preserve their own namespaces while allowing committed number metadata.

The mirror test now performs a real targeted identity-file write failure, asserts the managed bytes still serve and the pair survives, then proves the next successful pass repairs the mirror. New tests retain rollback, serialization, union and late-commit coverage, and add repeated branch/twin serving, pair-save and number-only-save failure, three unreadable envelope shapes, and an unpaired conflict that repairs once and keeps serving. Direct coordinator failures remain internal signals, not provider refusals. The test fixture observes real SQLite save calls, logger calls and pass metrics rather than mocking their outcomes.

## Bytes and pass-time cost

All runners used Bun `1.4.2 (744846f84)` on Linux with 8 vCPUs. Tests use throwaway roots only. Baseline product sources were loaded from the baseline commit into this isolated worktree after staging the implementation, then restored from the index; no parent checkout or live store was opened.

The existing alignment differential ran for `default`, `kept-duplicates`, and `issue-650`, each with both `pi087` and `systems` host shapes. All **60 per-pass served hashes** (including identity-repair, compaction and rewind cases) were independently compared against the baseline and matched. The existing independent Pi defer fixture also matched:

| Messages | Request bytes | SHA-256, identical on baseline and implementation |
| --- | ---: | --- |
| 604 | 129,157 | `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85` |
| 18,528 | 4,043,055 | `4cf4442a37d51c943c4ec00dc2695e1e1be988751f7368e699ade37cdd24006b` |

The fixture now accepts `REVIEW_PI_MESSAGES` (default 600, unchanged messages) and uses a throwaway **file-backed** Pi database. Its observer measures the actual `lkgCapture` stage; it asserts all 32 captures were observed. Handler times exclude input cloning/setup and the deferred drain between samples. Each trial consists of a cold pass, one warmup, and 30 measured warm passes. The 18,528-message history is synthetic, not the user's actual ANTAUTH store or a Windows filesystem/antivirus reproduction.

The latest matched baseline/current trial also observes all 32 existing `total` transform samples. Subtracting that pre-publication stage from each completed handler measurement isolates its remaining publication/outcome tail rather than attributing unrelated transform variability to the commit.

| File-backed 18,528-message trial | Cold handler ms | Cold LKG ms | Warm handler median ms | Warm LKG median / maximum ms | Warm publication-tail median ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original baseline | 11,736.53 | 139.89 (deferred) | 301.90 | 10.10 / 13.61 (deferred) | 60.87 |
| Corrected serving policy | 15,425.07 | 183.00 (inline) | 331.16 | 22.57 / 27.82 (inline) | 83.65 |

The measured warm handler increase is **29.26 ms, 9.7%**. The publication/outcome tail increases **22.77 ms**; cold publication tails are 67.49/255.68 ms. Earlier roughly-3% warm measurements described the prior implementation/trials, not a promise for the corrected policy. An additional corrected-policy trial measured 384.77 ms warm median, 26.84 ms inline LKG median and 13.19 s cold handler; historical cold trials ranged 9.93–14.99 s on the baseline and 10.46–15.43 s on synchronous implementations. These shared-runner timings vary substantially, so both the whole-pass result and the isolated tail are reported.

The task-giver explicitly accepted the **9.7%** measurement as not a large regression: much of this work already ran on the same main thread through deferred `setImmediate`; it is now charged before dispatch. Native IO remains unbounded by preemption. The named follow-up is **append-only LKG publication: write only new chunks and the served-number delta rather than re-saving/fingerprinting the whole slot**. Existing persistence already avoids rewriting unchanged chunk bodies, but still lays out/hashes the complete request and saves whole-slot metadata. That optimization is not part of this change. Indefinitely growing cumulative JSON number sets also remain a future storage optimization.

Reproduction, from `packages/pi-plugin`:

```sh
REVIEW_OUTPUT=$(mktemp -d) REVIEW_PI_MESSAGES=18524 BUN_JSC_useOMGJIT=0 \
  bun test src/issue-640-641-combined-differential.test.ts \
  --test-name-pattern 'independent Pi' --timeout 120000
MC_ALIGN_DIFF=1 BUN_JSC_useOMGJIT=0 \
  bun test scripts/experiments/alignment/differential.test.ts --timeout 30000
# Repeat the latter with MC_ALIGN_SCENARIO=kept-duplicates and =issue-650.
```

## Gates and mutation control

- `bun run test`: **1,941 passed, 10 skipped, 0 failed**, 1,951 tests across 198 files, 86,150 assertions; 246.97 seconds. This includes the Pi replay suites, #641 outcome/publication coverage and OMP receipt dispatch coverage. Opt-in differentials were run separately as above.
- `bun run typecheck`: passed, two TypeScript project checks; TypeScript **5.9.3**.
- `bun run lint`: passed, **298 files**, no fixes/errors; Biome **2.5.1**, 49 existing warnings.
- `bun run build`: passed, 22 web modules and 1,013 main-bundle modules, including the normal worker entry points.
- From `packages/plugin`, `BUN_JSC_useOMGJIT=0 bun test src/hooks/magic-context/lkg-persist.test.ts --timeout 30000`: **5 passed**, 31 assertions.
- Test script's frozen install checked **1,013 installs across 1,254 packages**, no dependency changes. No manifest or lockfile changed.
- AFT inspection supplied authoritative TypeScript diagnostics for six scoped files: no errors/warnings; structural call-graph categories were unavailable. The package typecheck is the authoritative gate.

For each non-vacuity control, the live implementation was staged and `git diff --stat` was empty. The first control reintroduced refusal for a recurring uncapturable request (1 file, 2 insertions): `serves recurring branch-unavailable captures and records admitted numbers only` failed with `PiStorageBusyError`; `pairs a completed real Pi pass with its served numbers and LKG` remained green (1 pass, 1 fail; 12 filtered tests).

The second control appended actual number JSONL bytes independently **before outcome admission**, then cleared only the number-reader cache so the ordinary completed-pass control remained valid. The applied diff was `packages/pi-plugin/src/context-handler.ts | 10 ++++++++++` (1 file, 10 insertions). The unchanged regression then produced exactly:

```text
(pass) pairs a completed real Pi pass with its served numbers and LKG
error: expect(received).toBeDefined(); Received: undefined
(fail) does not orphan durable served numbers when identity append overruns the Pi publication budget
1 pass, 1 fail, 14 expect() calls; Ran 2 tests across 1 file.
```

Each control was restored with `git checkout -- packages/pi-plugin/src/context-handler.ts && touch packages/pi-plugin/src/context-handler.ts`; the resulting unstaged diff was empty. No mutation marker remains in product code.
