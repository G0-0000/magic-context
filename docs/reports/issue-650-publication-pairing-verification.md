# Pi served-number / last-good publication: implementation and verification

Baseline: `82a3f0c11ad77ce5dfe09ff775b1277184bd9cab`. The original regression in `issue-650-lkg-served-pairing.test.ts` is unchanged.

## Durable boundary and transition

A managed context pass now commits synchronously. The existing `saveLkgSlotToDb` immediate SQLite transaction saves the request chunks and metadata, then runs the served-number publication callback before committing. Any callback/storage failure rolls back the request and its identity delta together. No schema, table, column, or migration changed.

The cumulative assigned numbers live in the existing v2 replay envelope in `session_meta.trailing_blank_decisions`, under `piServedTagNumbers`. Updates use the envelope's existing compare-and-swap helper and preserve its other namespaces. This state is independent of LKG pruning/invalidation: removing old history or rejecting a replay does not authorize renumbering previously served identities. An unchanged identity set does not rewrite the envelope. The LKG save's fingerprint shortcut cannot skip a supplied publication callback.

Adoption reads the union of the legacy number JSONL and the SQLite-committed numbers. It reads that union once per adoption invocation, not once per colliding tag. Existing JSONL-only evidence remains honored; the first successful managed publication also imports that evidence into the committed envelope. The number JSONL remains a cumulative compatibility mirror, but a managed caller can only append numbers already in the committed union. This preserves identities for older releases as well. A missing mirror can be repaired from the committed numbers, including when serving validated LKG replay. Compaction-off operation retains its existing distinct behavior; side turns do not publish managed identities.

Only after the commit succeeds and the outcome guard still admits the pass does Pi install the new memory LKG and usage attribution. The served cache/digest ledger and identity-repair acknowledgement follow the commit. A failed capture or DB save enters the existing validated-replay-or-refusal recovery path, never unmanaged history fallback. A failed identity mirror refuses dispatch without deleting the already committed pair. Empty host history with no newly assigned numbers has no input prefix or identity delta to publish and retains its previous behavior.

SQLite and filesystem calls remain cooperatively, not preemptively, fenced. If the commit returns after 25 seconds, the durable pair can exist, but the post-commit outcome guard rejects the result before memory evidence, mirroring, acknowledgement or dispatch. If the mirror crosses the deadline, its numbers already have a committed request; subsequent evidence and dispatch remain fenced. The OMP managed-receipt dispatch fence is unchanged.

## Test contract changes

Synchronous publication makes formerly best-effort LKG capture mandatory for a nonempty managed request. Some old tests assumed a pass could succeed without identifiable LKG inputs or with an unreadable publication envelope. They were updated explicitly, not silently treated as ordinary successful passes:

- Branch-unavailable and identical-unsaved-twin passes now assert visible refusal. Their identity-adoption assertions remain: explicit legacy JSONL fixtures model older releases that had already served those numbers without an LKG. In particular, the surviving identical note must still retain its own number after its twin is dropped.
- The unsupported-version and malformed-whole-document restart tests now assert refusal and byte-preserving storage, rather than successful publication through unreadable safety state. Malformed **native-lane** data in an otherwise valid envelope still permits its prior local cleanup behavior; assertions preserve the old namespaces while allowing the new served-number namespace.
- The note-ref-failure test now asserts refusal and preservation of the existing anchor, with no fresh note persistence. Several unrelated successful context fixtures now supply matching branch messages/IDs rather than synthetic default branch messages; their model, transform-error and restart-state expectations are unchanged.
- The identity-write-failure test now models a post-commit mirror failure: it refuses and retains the committed request/number pair, instead of cancelling a pending deferred request.

New publication tests cover transaction rollback after the actual identity update, serialization failure, legacy/SQLite union, preservation of unrelated replay namespaces, identity retention after LKG invalidation, real-handler DB-save refusal, and a real-handler commit returning after the outcome deadline.

## Bytes and pass-time cost

All runners used Bun `1.4.2 (744846f84)` on Linux with 8 vCPUs. Tests use throwaway roots only. Baseline product sources were loaded from the baseline commit into this isolated worktree after staging the implementation, then restored from the index; no parent checkout or live store was opened.

The existing alignment differential ran for `default`, `kept-duplicates`, and `issue-650`, each with both `pi087` and `systems` host shapes. All **60 per-pass served hashes** (including identity-repair, compaction and rewind cases) were independently compared against the baseline and matched. The existing independent Pi defer fixture also matched:

| Messages | Request bytes | SHA-256, identical on baseline and implementation |
| --- | ---: | --- |
| 604 | 129,157 | `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85` |
| 18,528 | 4,043,055 | `4cf4442a37d51c943c4ec00dc2695e1e1be988751f7368e699ade37cdd24006b` |

The fixture now accepts `REVIEW_PI_MESSAGES` (default 600, unchanged messages) and uses a throwaway **file-backed** Pi database. Its observer measures the actual `lkgCapture` stage; it asserts all 32 captures were observed. Handler times exclude input cloning/setup and the deferred drain between samples. Each trial consists of a cold pass, one warmup, and 30 measured warm passes. The 18,528-message history is synthetic, not the user's actual ANTAUTH store or a Windows filesystem/antivirus reproduction.

| File-backed 18,528-message trial | Cold handler ms | Cold LKG ms | Warm handler median ms | Warm LKG median / maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Baseline 1 | 14,993.20 | 139.29 (deferred) | 335.97 | 11.41 / 14.98 (deferred) |
| Baseline 2 | 9,934.41 | 127.01 (deferred) | 323.04 | 12.47 / 15.07 (deferred) |
| Synchronous pair 1 | 10,457.66 | 129.12 (inline) | 348.36 | 25.33 / 31.74 (inline) |
| Synchronous pair 2 | 13,446.50 | 143.39 (inline) | 332.47 | 23.69 / 30.09 (inline) |

Warm handler increases were **12.40 ms (3.7%)** and **9.43 ms (2.9%)**. The cold LKG work charged inline is 129–143 ms; cold handler times have several seconds of baseline variability and overlap the new timings. An earlier single cold file-backed comparison measured 10.39 s versus 13.53 s; the repeated trials and stage observer distinguish that variability from the much smaller synchronous LKG work. These measurements do not show a large pass-time regression, but do not guarantee bounded native IO latency on user machines. The numbers accumulate in a JSON envelope, so indefinitely growing histories still incur whole-envelope serialization when adding identities; a dedicated indexed identity table remains a possible future migration-branch optimization.

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

- `bun run test`: **1,934 passed, 10 skipped, 0 failed**, 1,944 tests across 198 files, 86,037 assertions; 240.67 seconds. This includes the Pi replay suites, #641 outcome/publication coverage and OMP receipt dispatch coverage. Opt-in differentials were run separately as above.
- `bun run typecheck`: passed, two TypeScript project checks; TypeScript **5.9.3**.
- `bun run lint`: passed, **297 files**, no fixes/errors; Biome **2.5.1**, 49 existing warnings.
- `bun run build`: passed, 22 web modules and 1,013 main-bundle modules, including the normal worker entry points.
- From `packages/plugin`, `BUN_JSC_useOMGJIT=0 bun test src/hooks/magic-context/lkg-persist.test.ts --timeout 30000`: **5 passed**, 31 assertions.
- Test script's frozen install checked **1,013 installs across 1,254 packages**, no dependency changes. No manifest or lockfile changed.
- AFT inspection supplied authoritative TypeScript diagnostics for five scoped files: no errors/warnings; structural call-graph categories were unavailable. The package typecheck is the authoritative gate.

For the required non-vacuity control, the live implementation was staged and `git diff --stat` was empty. A temporary mutation inserted the original independent JSONL publication before the LKG transaction. The applied diff was `packages/pi-plugin/src/context-handler.ts | 5 +++++` (1 file, 5 insertions). The unchanged regression then produced exactly:

```text
(pass) pairs a completed real Pi pass with its served numbers and LKG
error: expect(received).toBeDefined(); Received: undefined
(fail) does not orphan durable served numbers when identity append overruns the Pi publication budget
1 pass, 1 fail, 14 expect() calls; Ran 2 tests across 1 file.
```

The control was restored with `git checkout -- packages/pi-plugin/src/context-handler.ts && touch packages/pi-plugin/src/context-handler.ts`; the resulting unstaged diff was empty. No mutation marker remains in product code.
