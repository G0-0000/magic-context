# Pi retained-entry identity review

Header-based entry-ID restoration lets Oh My Pi (OMP) reapply saved message drops after native compaction hides session entries. This review finds one high-severity ambiguity defect: a unique remembered entry header can still describe multiple current messages, allowing an old drop to erase a newly inserted message.

Reviewed `b2fd9472ed62045ac87545252766c366f7198927`, **only** its changes to `packages/pi-plugin/src/context-handler.ts` and `retained-entry-reclaim.test.ts`, on tip `4020b7b0f7cee5bfd533a0bcb045f8f08feaf72e`. Baseline handler: `4692c4fdc962fe3b5643ad9aae8aeb52d73dca77`. No product code or existing test was changed. Review completed before the 16:15 UTC deadline on 2026-10-11.

## Finding: high — entry-side uniqueness does not establish event-side uniqueness

**Location:** `packages/pi-plugin/src/context-handler.ts:2196-2219`, especially the first-wins assignment at **2216-2219**.

`owners` counts distinct remembered/current **entry IDs** for each header. It does not count messages bearing that header in the **current event**. `used` prevents assigning one ID twice, but does not prevent assigning it to the wrong first message. A header unique on the previous successful pass can now belong to two event messages; restoration still assigns the remembered ID to the first one.

Minimal trace:

1. Successfully tag assistant entry `old-assistant`, timestamp 2. Optionally give it `responseId: "same-response"`.
2. Its entry disappears from the branch projection; only `live-user` remains.
3. The next context event contains `[new-message-with-that-header, old-message, live-user]`.
4. Strict resolution leaves both assistant slots unresolved. Restoration changes the first slot to `old-assistant`, leaving the actual old message unresolved. Reversing the event order changes which message receives the ID; it supplies no additional identity evidence.

**Failing tests**, all in `packages/pi-plugin/src/retained-entry-review.test.ts`:

- `retained review: a formerly unique millisecond must not identify the first of two event messages`
- `retained review: a formerly unique response id must not identify the first of two event messages`
- `retained review: two same-header event twins must not replay a saved drop onto an ambiguous slot`
- `retained review: duplicate-header tool owners must not give a new call the old call's dropped tag`

The first two expect `[undefined, undefined, "live-user"]` but receive `["old-assistant", undefined, "live-user"]`, including when the new message has different prose. The latter two drive the real context handler and prove a change to the messages returned for the model's next request, rather than merely inspecting IDs:

- For equal-text twins, a saved drop removes one ambiguous message: **expected two visible bodies, received one**. The baseline handler from `4692c4fd`, without retained-header restoration, preserves both.
- For `Read` calls reusing `reused-call`, timestamp 2, but with different arguments/results, the new invocation's `NEW_INVOCATION.txt` and output become **`[dropped §1§]`**. The old invocation remains visible under a newly allocated tag. Strict baseline preserves the new invocation.

The tool case also demonstrates why the existing tool-tag identity guards, introduced for issue 650's duplicate-tag regression, are insufficient here: the wrong restored real owner already has the requested tool tag, so `guardPiToolAllocations` accepts it at `context-handler.ts:2940-2944`; it never needs to establish a survivor between two conflicting rows. The problem is a false existing identity, not a failed duplicate-row repair. The exact content equality check for text likewise cannot distinguish equal-text twins.

### Reproduction and counterfactual

```sh
# From the repository root; run this command on Linux with eight vCPUs.
bun --version
MC_RETAINED_ENTRY_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test --timeout 30000 \
  packages/pi-plugin/src/retained-entry-review.test.ts
```

Bun **1.4.2**: **6 pass, 4 expected fail**, 1,021 assertions, 10 tests. The four failure names above are the only failures. All tests in this file are skipped unless `MC_RETAINED_ENTRY_REVIEW=1`, so the ordinary suite is not intentionally broken.

For an independent no-restoration control, copy the old handler from Git into a separate source file beside the current one and change only the new test's import:

```sh
git show 4692c4fd:packages/pi-plugin/src/context-handler.ts \
  > packages/pi-plugin/src/retained-review-baseline-handler.ts
python3 - <<'PY'
from pathlib import Path
p = Path('packages/pi-plugin/src')
text = (p / 'retained-entry-review.test.ts').read_text()
(p / 'retained-review-baseline-findings.test.ts').write_text(
    text.replace('"./context-handler"', '"./retained-review-baseline-handler"'))
PY
MC_RETAINED_ENTRY_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test --timeout 30000 \
  packages/pi-plugin/src/retained-review-baseline-findings.test.ts \
  --test-name-pattern 'formerly unique|event twins|tool owners'
```

The four corresponding assertions **pass with the baseline handler**, with six assertions and the other tests filtered out. Temporary copies were removed from source directories after verification. Both handler versions use the current tip's unchanged imported modules; only the handler is replaced. The entire historical checkout was not rebuilt.

A safe header-only fallback must establish uniqueness among current event messages before assigning any unresolved slot. Checking only entries and IDs already consumed is not sufficient. No product fix is included in this review.

## Other requested boundaries

### Edited/replaced messages, tree navigation and revert

- A same-header **prose rewrite** of a missing entry does receive its remembered entry ID. However, the existing text-content identity plan detects changed prose and gives it a new content identity (`context-handler.ts:828-856`). The content-drift control test drives the context handler through three passes of the replacement: the new body remains visible, bytes and tag numbers remain stable, and the old dropped row stays dropped. A blanket claim that every content rewrite inherits an old text drop would be incorrect.
- Two remembered entry owners sharing a header remain unresolved. The existing retained/current-owner ambiguity test also passes. Neither case defends the one-remembered-owner/two-event-message finding above.
- A branch switch and revert whose messages are present in their projections keep the correct branch IDs, even with colliding timestamps and different prose. Restoration is bypassed when normal projection alignment resolves every slot (`context-handler.ts:2141-2143`). The remembered map is session-scoped, not branch-scoped; `clearContextHandlerSession` deletes it, but ordinary tree navigation does not itself call that cleanup. No additional wrong-branch assignment was proven in the projected branch/revert cases.
- A real OMP **18.8.7** run loaded **pi-rewind 0.5.0**, moved three unsaved notes, navigated back to an earlier tree anchor and served another prompt. All three shaped turns completed; the notes retained tags **34, 35, 36**, with 20 provider requests total and no extension diagnostics. This uses the host's `navigateTree` API, not pi-rewind's interactive picker or file-checkpoint restoration.

The installed **pi-rewind** and **pi-rtk-optimizer** sources were inspected, rather than assuming they manufacture new same-header messages:

- **pi-rewind 0.5.0** uses `ctx.navigateTree(targetEntry.id, { summarize: true })` for conversation restoration (`src/commands.ts:141-160`) and checkpoint/file restoration in its tree/fork hooks. Its `src/index.ts:139-267` does not register a context-message replacement handler.
- **pi-rtk-optimizer 0.9.0** changes the system prompt, bash command input, and tool-result **content** (`src/index.ts:426-531`); its content mapper changes text blocks while retaining other block fields (`src/record-utils.ts:27-49`). It does not register a context-array replacement/drop handler in that version. These sources do not establish that either named extension produces the failing duplicate-event fixture. The optimizer package was source-inspected, **not run as an extension**.

Those extension paths are from the exact npm packages installed under the task worktree's ignored `.tmp-retained-review/installs/`, not other checkouts or live installations.

### Issue 650 repair, served evidence and refusal guards

Linux results on tip `4020b7b0f7`:

- `issue-650-review.test.ts`, `issue-650-review-r2.test.ts`, `issue-650-review-r3.test.ts`, `pi-entry-alignment.test.ts`, `pi-entry-alignment-review.test.ts`, and `retained-entry-reclaim.test.ts`: **81 pass, 0 fail, 386 assertions**.
- The requested `issue-650-pairing-review.test.ts` **does not exist at this tip**. The present pairing suite, `issue-650-identical-pair.test.ts`, ran instead: **3 pass, 0 fail, 9 assertions**. It is not presented as the missing suite.
- The opt-in review's content-drift/three-pass control shows no new refusal or retagging in that shape. No additional repeated-refusal or repeated-repair defect was proven. The tool-drop finding shows an existing-tag false match can bypass the guards despite these suites being green.

### Plain Pi and served-byte differentials

There is **no OMP-only condition** around restoration (`context-handler.ts:2188-2190`). Any Pi event with unresolved slots and remembered headers can enter it. Nevertheless, all slots resolved normally in the ordinary plain-Pi inputs tested here, so the new path was inert in those runs.

The installed **Pi 0.87.1** and **Pi 1.1.0** runners both deep-clone the input and filter system messages before each `context` handler (`dist/core/extensions/runner.js:901-916` and `1006-1021`, respectively). Ordinary persisted messages, generated summaries/custom messages and context-edit projections can still be mapped through the plugin's projection alignment. An extension's context-only additions, a mismatch in an ambiguous same-header run, or an out-of-order/fingerprint-ambiguous event can remain unresolved. A rewrite with a unique current projected header is already supported by the ordinary resolver. Cloning alone does not make messages unresolved.

Each differential independently served inputs once through the current handler and once through the baseline handler, in separate Bun processes and fresh databases. The comparison asserted a **nonempty** list and equality of every printed served-array SHA-256, rather than comparing a file with itself.

| Differential | Compared arrays | SHA-256 of newline-joined equal output lines |
| --- | ---: | --- |
| Alignment `default` (Pi 0.87 projection and system-visible shape) | 16 | `b5b0f74c2a8744ed7751cffa1c4f0d95762dc03da1609433e81d60c3eefba2f0` |
| Alignment `kept-duplicates` | 16 | `c28a26b9d099a7a614618e72d6f86b1538d2c707ee1f934eb0abc798bfc5c134` |
| Alignment `issue-650` | 30 | `e1fe8aee10ffd240482a0a6b9a1a463e2864d4fe5e4bc8653e09621089c476d0` |
| Captured real Pi 1.1 inputs, including tool-result rewrite | 4 | `b8602f3057a9b6d41dbb195760ace3e77e1834629d46344ba253f707bb105776` |

The alignment driver was `packages/pi-plugin/scripts/experiments/alignment/differential.test.ts`, with `MC_ALIGN_DIFF=1` and each listed `MC_ALIGN_SCENARIO`. All six scenario/build runs passed (one test each). The default and kept-duplicates scenarios include ordinary turns, custom messages, same-millisecond users, tree summaries, context edits, native compaction and subsequent appends. The issue-650 scenario includes repaired duplicates, rewritten content, unresolved notes and rewind.

The real Pi 1.1 input capture ran with lower CPU priority (`nice -n 10`) and used the existing `issue-650-r3-host-probe.ts` scenario: a prior extension rewrites tool-result text. A temporary copy additionally saved input messages and branch entries. The host completed three turns/four provider requests with one tool tag and no diagnostics. The captured inputs had **1, 3, 5, 7 message slots and zero unresolved slots** on both replay handlers. Linux replay then compared the full returned JSON bytes through their hashes:

```text
pass 0:  105 bytes  673d1f75ec6abf736a6628c7168e08dbdb9e8d5a0e7492551b3c5b9204bdb574
pass 1:  852 bytes  fe5e74cdf1237edd39f7136ea3ab2bffb2486da13f0e3fb608c7ed1476236879
pass 2: 1463 bytes  1bacdb876a010621ae77a77fe212207885ac056c87a77e182e74961f63aab33b
pass 3: 2072 bytes  20b9d4d91d30a87d35c084813e13719028257cdbad3a5ba78e09d0bb1a730e95
```

The default 15 replay/byte-safety suites also ran with each handler: **118 pass, 5 skip, 0 fail; 1,134 assertions; 123 tests per run**. Sorted test-name/outcome lists matched exactly. Suite inventory:

```text
issue-485-replay-gate native-replay-pi native-replay-state-pi
reasoning-replay-pi fold-content-replay overwall-upgrade-replay
issue-640-641-combined-differential served-array-ledger served-collision
served-identity-refusal resolve-pi-stable-id transcript-pi
tail-hygiene-parity marker-drain-wire-stability system-ordinals-pi
```

Matching test outcomes alone do not establish byte identity for every possible replay. The **66 independent served-array comparisons** above provide direct byte evidence for the specified inputs; the suites additionally assert their own replay/fixture contracts. The same five default opt-in/child tests were skipped in both the current-handler and baseline-handler runs.

### Memory and lifetime

`recordSuccessfulTaggedMessageIds` creates a **new** header map on each successful recorded pass, adding only real IDs in that pass's input (`context-handler.ts:705-724`). The pre-pipeline copy at `4162-4167` retains raw input IDs even when pipeline compaction trims positional IDs; the successful recording call is at `5198-5208`. There is no session-long accumulation of headers. The bound is the latest recorded input's distinct real IDs, **not** a fixed message count: if a host's raw input grows, the window can grow with it.

`clearContextHandlerSession` deletes both maps at `10254-10255`. Tracked sessions are capped at **100**, with eviction invoking that cleanup (`1067-1095`). The review controls replace a one-entry window 1,000 times, check the live ID set is always one entry, confirm the initial ID cannot be restored and the latest can, then confirm session clear removes restoration. A separate 100-session eviction control confirms the oldest remembered window cannot restore an ID. These controls pass. This establishes the map's algorithmic bound and cleanup, not a native heap/RSS measurement.

### Original reclaim test and OMP overflow E2E

The unchanged `retained-entry-reclaim.test.ts` passes all **three** tests with the current handler. Against the independent baseline-handler copy, **only** `retained raw prose replays its saved drop after native branch compaction` fails, at its body-absence assertion; the timestamp-change and retained/current-owner ambiguity tests remain green (**2 pass, 1 fail**). Thus the positive test does detect removal of the fix.

Its ambiguity test has **two entry owners** (`old-assistant` and `other-assistant`), so restoration declines that bucket; it does not cover **one remembered owner with two unresolved event messages**. Moreover, `toContain(f.body)` only requires one of its two bodies to survive. The new review asserts both bodies remain visible when identity is ambiguous.

The unchanged real OMP **18.2.6** overflow test ran on macOS under `nice -n 10`:

```sh
MC_E2E_HOST=omp bun test --timeout 600000 \
  packages/e2e-tests/tests/short-context-overflow.test.ts
```

With a fresh isolated environment and process-tree descriptor audit: **1 pass, 9 skips, 0 fail, 4 assertions** (OpenCode, OpenCode2 and Pi scenarios plus their setup/teardown hooks were skipped); all 30 turns succeeded, historian requests were observed, **23 tags were dropped**, and peak/final usage were **92.8%**, below 100%.

## Host isolation and retained evidence

All native host invocations ran on the Mac, niced, with fresh HOME/CFFIXED_USER_HOME, XDG data/config/state/cache/runtime, OPENCODE_DB, MAGIC_CONTEXT_STORAGE_DIR and agent directories. None used live stores, configurations or another checkout. Unit tests and byte replays ran on Linux with `runon: "linux,8c"` and in-memory/fresh test databases.

The overflow wrapper repeatedly captured `lsof -nP -Fn -p <descendant-pids>` during the test, canonicalized SQLite DB/WAL/SHM paths, required nonempty database evidence and rejected paths outside the throwaway root. The Pi/OMP reporter probes additionally asserted final host-PID containment with their built-in `lsof` audit; their empty startup DB lists are **not** offered as proof of final isolation.

Evidence roots below the original system temp directory `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/`:

| Run | Root beneath system temp | Observed host PID / evidence |
| --- | --- | --- |
| OMP overflow | `pi-retained-review-omp-overflow-57zzt8c_/` | process-tree PIDs 18536, 18545, 18713, 18922, 20062, 21671; `lsof.jsonl`, `audit-result.json`, `stdout.log`; all descriptors contained |
| Pi 1.1 rewrite | `magic-context/issue-650-r3-retained-pi-k3d6lQ/` | 13689; `pi-final-lsof.txt`, `pi-result.json`, `pi-requests.json` |
| Pi 1.1 input capture | `magic-context/issue-650-r3-retained-pi-input-LpnePI/` | 48882; the same evidence plus `pi-context.jsonl` with inputs/branch entries |
| OMP 18.8.7 / rewind | `magic-context/issue-650-r3-retained-omp-srPZ0w/` | 53480; `omp-final-lsof.txt`, `omp-result.json`, `omp-context.jsonl`, `omp-requests.json` |

Observed DB families were exclusively the hosts' fresh `data/cortexkit/magic-context/context.db`, OMP `.omp/agent/{agent,models,skill-descriptions}.db` and `.omp/cache/legacy-pi-extension-cache.db`, with associated WAL/SHM files. The overflow's descriptor audit recorded **zero** out-of-root paths.

An initial overflow run placed its isolated root inside the ignored worktree scratch directory. Its scenario passed at 92.8%, but the repository's after-all storage-leak sentinel correctly rejected a `context.db` underneath the repository. Its own descriptor audit still found no live/out-of-root store. That throwaway DB tree was removed after preserving logs; the final run used the system temp root above and passed both scenario and sentinel. This initial infrastructure failure is not represented as a clean suite result.

The worktree's ignored `.tmp-retained-review/evidence/probes/` retains the temporary baseline handler, differential/replay test copies and the synthetic Pi 1.1 capture, outside build/cache directories. Copies of the inspected public host/extension source files and version manifests are retained under `.tmp-retained-review/evidence/extensions/`, so removing the isolated `node_modules` installations does not remove that source evidence. Only the report and opt-in review test are committed. The native hosts' throwaway session directories were retained by setting `MC_E2E_KEEP=1`.

## Final gates and coverage limits

- Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**.
- Pi package `bun run --cwd packages/pi-plugin typecheck`: passed (both configured TypeScript projects).
- The package excludes `*.test.ts`, so a temporary focused tsconfig additionally included the new review file, package `@types` roots and Bun types; `tsc --noEmit -p retained-review-tsconfig.json`: passed. Initial focused-config placement/type-root errors were corrected; test types were then checked, rather than relying on Bun transpilation.
- Project Biome `check packages/pi-plugin/src/retained-entry-review.test.ts`: passed, one file checked.
- Fresh scoped AFT inspection reported zero diagnostics but **partial** call-graph-based structural analysis because this isolated checkout's call graph was unavailable; it was not substituted for the TypeScript checks.
- The normal focused test run leaves the review flag unset: **84 pass, 10 opt-in skips, 0 fail, 395 assertions across eight files**; the existing issue-650/alignment/reclaim tests remain green. The enabled run deliberately exposes four failures documenting the single finding; no production change is included.

Not covered: pi-rewind's interactive checkpoint UI/file restore; an actual pi-rtk-optimizer-loaded host session; every provider's possible response-ID reuse; arbitrary multi-extension ordering; long-lived native heap measurements; full historical-checkout/build comparison; all replay opt-ins; and the absent `issue-650-pairing-review.test.ts`. The synthetic duplicate fixtures prove a wrongful entry-ID assignment for message arrays accepted by the context-extension API, not that either named third-party extension currently creates those duplicates. No separate branch/revert, memory-growth, or repeated-refusal defect was established. Ordinary-input byte equivalence is scoped to the independently compared inputs listed above, not all possible Pi sessions.
