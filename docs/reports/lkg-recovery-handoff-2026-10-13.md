# Last-good recovery tails remain byte-stable

> Historical implementation report for cc47f005. Its diagnostic-ledger restart
> proof and completed-turn strip were rejected by independent review. See
> `lkg-durable-recovery-fence-2026-10-13.md` for the durable fence, signed-turn
> corrections, restored clean-restart availability and current verification.

## Change and restart policy

The diagnosis in `pi-lkg-late-tags-2026-10-13.md` was cherry-picked from
`80c8430c` before implementation. A recovery response now creates a detached,
process-local obligation: the input IDs and content evidence plus the exact
returned array, including its untagged tail. Healthy passes validate the ID
sequence and content using the existing snapshot/digest rules. They preserve
that output as a prefix and tag only genuinely new messages. No JSONL owner is
inferred from a message's position.

Pi records the obligation at both recovery returns
(`packages/pi-plugin/src/context-handler.ts:6297,6389`), validates it in
`packages/pi-plugin/src/pi-lkg.ts:587–651`, withholds tail tagging at
`context-handler.ts:8625`, and installs the exact prefix at `context-handler.ts:6006`.
Successful captures extend it until a fold that changes the served prefix.
A declared tag-identity repair that rebuilds that prefix also releases it,
preserving the existing issue 650 contract. Normalization is attributed through
`lkgFrozenReleaseReason= recovery_tail_normalized`; the decision writer stores
this in `materialize_reason` alongside the fold reason. Tests check an actual
persisted decision row and reduction of a previously tagless tool result.

The busy Pi evidence recorder now skips both SQLite identity state and the
served-number sidecar (`packages/pi-plugin/src/served-array-ledger.ts:437–457`).
It neither allocates numbers nor reads/publishes tag identities.

Restart chooses **refusal while storage is unavailable, then an attributed
healthy rebuild**, rather than reconstructing an unproven prefix. For Pi, an
existing latest-served digest can prove that the persisted LKG is still exactly
the last returned array (`served-array-ledger.ts:129`). A matching digest permits
ordinary restart behavior without inventing an obligation. A newer recovery
array, missing receipt, truncated receipt, or digest mismatch instead causes
`lkg_restart_rebuild`. Content changes and contractions cause
`lkg_recovery_input_rebuild`. Rebuilding an unproven signed prefix strips its
signatures rather than keeping signed thinking behind changed bytes.

## OpenCode 1 and 2

Both TypeScript adapters have the same defect shape and are fixed through their
shared implementation:

- OpenCode 1 registers the common wrapper at
  `packages/plugin/src/index.ts:921–940`.
- OpenCode 2 invokes that wrapper with adapted messages at
  `packages/plugin/src/v2/hooks/context.ts:1987–2005`, and creates the shared
  transform with `storeGeneration: "v2"` at `context.ts:1678–1694`.
- The wrapper previously returned saved output plus the pristine raw tail;
  its successful recovery now records that exact array at
  `packages/plugin/src/plugin/messages-transform.ts:348–365`. The healthy path
  calls the shared transform at `messages-transform.ts:573`.
- Shared healthy tagging consults the obligation at
  `packages/plugin/src/hooks/magic-context/transform.ts:792,2368`. The fold
  preflight normalizes withheld messages through `normalizeRecoveryTail`, and
  decision publication attributes the release at `transform.ts:3355`.

OpenCode TypeScript has no equivalent latest-served receipt proving that the
old persisted slot includes every pre-restart recovery response. It therefore
refuses busy replay after an unproven restart and declares a healthy rebuild.
Two issue 653 tests that previously required busy restart availability now
require this safe refusal. Their content-mismatch invalidation test is unchanged.
This is an intentional availability-contract change, not a silent test repair.

Rust-mode OpenCode already freezes recovery output instead of adopting normal
module output on the next healthy defer. It selects that replay at
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:4357–4407` and
skips postprocessing with `if (!replayedFrozenRepresentation)` at
`rust-mode-transform.ts:4410–4421`. No Rust-mode change was needed.

## Independent proofs

All executable verification ran on Linux with `runon: "linux,4c"`, Bun 1.4.2,
TypeScript 5.9.3 and Biome 2.5.1. All databases, host fixtures and stores were
disposable; no live stores or provider request dumps were touched.

Before product changes, the real-handler reproduction failed both complete-array
comparisons: prose plus a completed tool result acquired `§2§`/`§3§`, and two
completed results acquired those prefixes on the healthy pass. After the fix,
`context-handler-lkg.test.ts` covers both sequences, a second healthy pass,
normalization at a real system-hash fold, decision-row attribution, reduction
after normalization, content mismatch, branch contraction, and restart.
OpenCode tests run the same full-byte handoff through the real wrapper/shared
transform for both v1 and v2 store generations, then normalize at a fold and
reduce a previously tagless text message.

Four isolated mutation controls each produced exactly one named failing test,
with every other test filtered out, and were restored from the staged live tree:

1. Pi: authorize normalization on every healthy recovery pass. The prose/result
   complete-byte reproduction fails on newly added `§2§` and `§3§` prefixes.
2. OpenCode: forget the recovery prefix before healthy tagging. The v1
   complete-byte reproduction fails on `§6§ answer` / `§7§ follow-up`.
3. Restart: always trust the older persisted prefix. The latest-served digest
   test fails (`Expected: false`, `Received: true`).
4. Busy evidence: read the identity sidecar during recovery. The no-tag-state
   test fails with `PiServedIdentityError` on deliberately unreadable evidence.

Each control had a non-empty `git diff --stat` while applied and an empty one
after `git checkout -- <mutated path> && touch <mutated path>`.

The existing `issue-640-641-combined-differential.test.ts` ran independently
against exported base `207e64e298dcb94309e29158a4998e363f66e901` and the changed
source, with a common disposable project directory. Each source produced 30
stable samples per harness. Direct comparisons of the complete serialized
outputs were equal, not merely comparisons against a hash computed by the
implementation:

| Harness | Bytes | Equal baseline/fixed SHA-256 |
|---|---:|---|
| Pi | 129157 | `04ea978c77f9f929db807d4111e1f49655f78db70f78174b62899899dc560d85` |
| OpenCode 1 | 599 | `1858cb22d26467847a365974827421103ac1dcc30479b294fdcdc7bf4b4ff80c` |
| OpenCode 2 | 686 | `16fcdeadebc42355d415381f2b5f53df54188c193b4cb61a86a52d63a2b31ce0` |

## Gates and limitations

- Pi typecheck and lint passed. Lint checked 318 files and reported 67 existing
  warnings, no errors.
- Pi full suite: **2127 passed, 36 skipped, 0 failed**, 162676 assertions across
  217 files. This includes the default issue 650 and issue 640/641 suites.
  Opt-in timing, live-host and large-loop fixtures remain skipped by default;
  the ordinary-byte differential above was explicitly enabled.
- OpenCode typecheck and lint passed. Lint checked 1397 files, with 11 existing
  warnings and 6 informational diagnostics, no errors.
- Root build passed: OpenCode 1, OpenCode 2, Pi and CLI bundles were built; the
  TUI generator checked nine committed outputs and rewrote none.
- Built OpenCode full suite: **7929 passed, 33 skipped, 1 failed**, 273224
  assertions across 792 files. The sole failure is the existing Node WASM
  Transformers temporary-output fixture: it cannot resolve
  `onnxruntime-web/webgpu` from the Linux temporary directory. That same test
  fails on the exported base revision. The first unbuilt run also lacked worker
  bundles; building resolved all of those failures.
- Narrow OpenCode recovery suites: **160 passed, 0 failed**, 2987 assertions.
  After the final unproven-rebuild thinking-safety adjustment, the broader
  transform/thinking/LKG/messages/v2 context suites passed **677 tests, 0 failed**,
  5714 assertions across 32 files, with typecheck and lint repeated.
- Three writer-diagnostics timing tests also failed in an earlier run and on
  the exported base; they passed in the final built full OpenCode run.
- The baseline sandbox initially rejected dependency symlinks, so those
  symlinks were removed and Linux performed its normal offline setup. No local
  test fallback was used. Frozen-lockfile installs reported 1013 checked
  installs across 1254 packages, with no changes.

Implementation failures encountered during verification were fixed rather than
changing their claims: identity repair must discharge a rebuilt prefix, and a
normal Pi restart must keep its signed hold when the latest-served digest proves
the persisted request is current. Neither ARCHITECTURE.md nor STRUCTURE.md was
changed.
