# Issue 668: OMP diagnostic context and superseded raw-message dispatch

## Result

On real **OMP 18.10.3**, `/dump` calls the extension context hook through
`#formatLlmRequestJson` and `dumpLlmRequestToTmpDir` in
`@oh-my-pi/pi-coding-agent/src/session/agent-session.ts`. It supplies no purpose
field. Magic Context now positively recognizes those two host frames, only on
OMP, and returns the identical messages array before creating a budget,
operation, generation, or receipt. Unknown callers remain normal passes.
The synchronous stack capture temporarily raises the stack limit and restores it
before yielding. The unit fixture and real-host receipts pin the frames to 18.10.3.

A genuinely replaced pass still throws its original error back to OMP. Just
before that throw, it appends a single user message with one text block to its
own input array:

> Magic Context did not prepare this request for the current turn. <nonce>

The nonce is a fresh `crypto.randomUUID()`, recorded only in the extension's
memory. The OMP payload hook checks for those exact nonces before consulting
any completion receipt. Refusal does not abandon the newer pass's receipt.
The newest 32 nonces per session remain unsendable across clean passes until
that session's receipts are cleared, so a retained payload cannot borrow a new
receipt on retry. This is not a message-content heuristic: similar prose
or a truncated nonce is not refused. Pi, OMP side turns, sessions whose side-turn
latch disabled the fence, and compaction-off sessions never receive a marker.

## Real-host checks

Eight final child processes used the pinned OMP SDK, its real extension runner,
provider serialization, abort signal, session JSONL writer, and a localhost
mock HTTP provider. The full Magic Context extension was loaded, not just a
replacement context handler. `run.sh` isolates HOME, CFFIXED_USER_HOME, TMPDIR,
all XDG roots, OMP agent state, and Magic Context storage **before Bun starts**.
`host.ts` asserts those values instead of repairing late isolation. `lsof -p`
is checked before every prompt (including the retry and clean pass), and at the end;
all observed store descriptors were inside the corresponding disposable root.

The committed [host receipts](issue-668-host-receipts.json) preserve checks,
HTTP counts and text excerpts, dump frames, session hashes, nonces and process
IDs. Raw `audit.json`, `hooks.jsonl`, `lsof-*.txt`, session copies and output
remain under `$TMPDIR/magic-context/bg_001775389acba519/`, outside build output.

| Full plugin / scenario | Anthropic Messages run | OpenAI Responses run | Result per API |
| --- | --- | --- | --- |
| Fixed: idle and overlapping dump | `fixed.SaLYTa` | `fixed.osuVVE` | 4 checks; no errors, no managed/session writes, live prepared request sent |
| Fixed: two live passes, no dump | `fixed.xc9rA5` | `fixed.fXavol` | 7 checks; loser and exact payload retry: 0 HTTP; newer and later clean request: 1 HTTP each |
| Master before this fix | `master.vA79fY` | `master.GYw83z` | 2 checks; unprepared loser and prepared replacement both sent |
| Released npm 0.48.0 | `released.s6yxST` | `released.uDwj3f` | 2 checks; unprepared loser and prepared replacement both sent |

For overlap, the host starts a real `session.prompt`, observes entry into its
context hook, then starts a second live preparation through
`session.convertMessagesToLlm`. Only the loser's payload dispatch is held until
the replacement finishes, to expose receipt borrowing deterministically. The
replacement is sent via OMP's real `streamSimple` with the session's provider
options. These are SDK pipeline overlaps, not two simultaneous CLI prompts.
`--no-dump` omits **every** diagnostic call in the conflict comparisons.
Thus **yes**, the same raw-message send occurs without `/dump` on both released
0.48.0 and master (base `77b6ba7288a175a2cdd600fc216e0df2f35dd409`), for both APIs.
This demonstrates the overlap case; native automatic retry scheduling itself
was not separately exercised.

The marked retry replays the captured provider body verbatim at the real
`before_provider_request` hook during another session-owned provider attempt.
The receipts confirm both marked bodies are byte-equivalent JSON, two marker
refusals occur, and neither produces an HTTP call. A new normal pass then sends
successfully. This tests payload retries independently of OMP's retry delay policy.

For the dump-only overlap measurement, a second disposable context.db
connection holds `BEGIN IMMEDIATE` while the live pass yields at writer
admission. The session is flushed before the snapshots; the lock is released
only after comparing the dump's before/after rows and session text. This
separates diagnostic writes from legitimate concurrent live-pass writes. It
uses the normal bounded writer wait, not a stubbed pipeline. Idle snapshots
have no writer lock. The dump's own temporary output file is expected; no
Magic Context state or session entry is written by diagnostic preparation.

## The marker does not persist

At the losing hook's entry and immediately before returning its error, the
probe copies the actual session JSONL. After OMP processes the fallback and
finishes the turn, it flushes and copies the JSONL again. In both fixed API
runs, the before-marker and after-marker files are identical:

| API | Bytes before / after marker | SHA-256 before / after marker |
| --- | --- | --- |
| Anthropic | 2,027 / 2,027 | `e010cd512ce5e180d3348407488d26ee355f55c6af8ac1bdbf966bee9051f448` |
| Responses | 2,380 / 2,380 | `bfa897c8799641febb9c4c3a74b4a6ae9f4b608ec089f8fd6906914bfe6cab28` |

The flushed after-turn JSONL contains no marker. Its expected normal prompt,
assistant-abort and display-only refusal records can increase its size; OMP
never serializes the mutated fallback array as session history. The diagnostic
snapshot hashes also match before/after at idle and during the held live pass.

## First, late-isolation run

The earlier run started at **2026-10-12T21:02:19.842Z**
(epoch milliseconds `1791838939842`). Metadata supplied by the parent agent,
who used `stat` without opening either file:

- `~/.omp/cache/legacy-pi-extension-cache.db`: mtime
  **2026-10-12T21:02:21Z** (epoch seconds `1791838941`), size **266,240 bytes**.
  The mtime is 1.158 seconds after run start: the first run modified OMP's own
  extension-cache database. Contents were not inspected; OMP may have recorded
  the test extension there.
- `~/.omp/logs/omp.2026-10-12.39026.log`: **1,303 bytes**, created at 21:02Z,
  matching the first process. The first run created one 1.3 KB OMP log file.
  Other OMP logs were older. No log contents were inspected.

The parent reports no Magic Context or OMP session store was touched in that
first run. This worker did not access any live `~/.omp`, `~/.pi`, `~/.config`,
or Magic Context store. All new host runs were isolated before startup.

## Verification and mutation controls

Linux (`runon: linux,4c`): Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**.

- `bun run --cwd packages/pi-plugin test`: **2,073 pass, 32 skip, 0 fail**, 214
  files, 162,284 assertions. The install step checked 1,013 installs across
  1,254 packages with no lockfile or manifest changes.
- `bun run --cwd packages/pi-plugin typecheck`: passed (retina build typecheck
  and Pi `tsc --noEmit`).
- `bun run --cwd packages/pi-plugin lint`: passed; 315 files checked, 49
  existing warnings, no errors. The three issue source files are warning-free.
- Restored issue 668 tests: **9 pass**, 48 assertions. All existing issue 667
  and 663 files and expectations are unchanged from the task base.
- The Pi bundle was built locally because real OMP runs consume its local
  artifacts; Bun bundled 1,017 modules. Linux verification did not depend on
  those artifacts.

Each mutation staged the live files first, showed an empty unstaged diff,
introduced a one-line diff, ran the same 9-test issue suite, and restored via
`git checkout -- <path> && touch <path>` to an empty unstaged diff:

1. Disable positive `isOmpDumpContextStack` recognition: only
   `issue 668: only the pinned OMP dump frames identify a diagnostic` failed
   (`Expected: true; Received: false`). The other 8 tests stayed green.
2. Disable the exact-nonce dispatch refusal: only
   `issue 668: real conflict fallback and retries refuse without revoking the newer receipt`
   failed (`Expected aborts: 2; Received: 0`). The other 8 stayed green.

The [mutation receipts](issue-668-mutation-checks.json) name each green and red
test and preserve the applied/restored diff-stat pairs. No mutation remains in
the delivered tree. The restored issue suite is green.

## Send-hook cost and bounded retention

The send hook now looks up the current session/operation key's nonce set first.
With no retained nonce it does **not** call `JSON.stringify`, inspect the large
conversation for markers, or allocate a nonce-search array. A different
session's retained markers do not make this session serialize its request.
The nonce map participates in `clearPiContextReceipt` alongside completion and
lifecycle maps. Each session retains at most its newest **32** nonces, dropping
the oldest on insertion. No durable format or host behavior was changed.

**Known limit:** a retry carrying a nonce evicted by the 32-entry cap is no
longer identifiable by this marker check and could pass using a later valid
receipt. Clearing that session's receipts also retires its nonce history;
without a fresh completed context pass the normal receipt check still refuses.

The [dispatch benchmark](issue-668-dispatch-benchmark.json) compares the real
registered send hooks from commit `850a28cbdef23a69b8ca8276cdff56ed7734f86f`
and the revised source. Bun **1.4.2**, Linux x64, `runon: linux,4c`; the Anthropic-shaped
payload is **5,246,098 bytes** (approximately 5 MiB), with 100 text messages.
Each case warmed 100 calls and measured 1,000 calls, synchronously, without an
HTTP provider. The payload's `toJSON` counts actual serializations; all four
count controls passed over 4,400 calls. Timing includes the other unchanged
receipt/advisor checks and timer overhead, not context preparation.

| Retained nonces | Version | Mean per request | Median | p95 | Serializations including warmup |
| --- | --- | --- | --- | --- | --- |
| 0 | Before | 4.511797 ms | 4.488059 ms | 6.895780 ms | 1,100 |
| 0 | After | 0.000537 ms | 0.000311 ms | 0.001342 ms | **0** |
| 32 | Before | 8.702982 ms | 7.388563 ms | 13.784896 ms | 1,100 |
| 32 | After | 9.999418 ms | 9.154671 ms | 15.871615 ms | 1,100 |

The common nonce-free path removes approximately **4.51 ms per 5 MiB request**
in this run. Sessions retaining markers still pay for one full serialization
and up to 32 substring searches. The 32-nonce timings are not an improvement
claim: these sequential samples use different random nonce values and include
allocation/GC and host timing variance.

The added tests cover no serialization (with a throwing `toJSON`), session
isolation, oldest eviction with all 32 retained markers still refused, and
receipt cleanup leaving another session's marker intact. The existing 668,
663 and 667 expectations remain unchanged.

Revised Linux verification (`linux,4c`): **40 pass, 0 fail, 239 assertions**
across all four issue 668/663/667 test files. TypeScript 5.9.3 typecheck passed;
Biome 2.5.1 checked 315 Pi source files with no errors and the same 49 existing
warnings. The full-suite and real-host receipts above describe the original
delivery; this narrow revision reran the requested issue suites rather than
those broader gates.

The [revised mutation receipts](issue-668-nonce-mutation-checks.json) record
five Linux controls: dump detection, exact-nonce refusal, nonce-free
serialization, newest-32 eviction, and receipt cleanup. Each produced only its
named expected red test, with unaffected green tests named in the receipts.
The exact-nonce and serialization runs used explicit test-name filters to
isolate those properties; cap and cleanup were each tested against the full
12-test issue 668 file. All mutations were restored to empty unstaged diffs
before the final green issue-suite run.

To reproduce the comparison, generate the historical module beside its relative
dependencies, run the benchmark on Linux, then remove the generated module:

```sh
git show 850a28cbdef23a69b8ca8276cdff56ed7734f86f:packages/pi-plugin/src/pi-context-refusal.ts \
  > packages/pi-plugin/src/issue-668-benchmark-before.ts
bun docs/reports/probes/issue-668/dispatch-benchmark.ts
rm packages/pi-plugin/src/issue-668-benchmark-before.ts
```

## Reproduce

Provision OMP 18.10.3 under `$MC668_ROOT/host` and npm plugin 0.48.0 under
`$MC668_ROOT/released` (these runs reused earlier disposable installs). Set
`MC668_ROOT` to a directory under `$TMPDIR/magic-context/<task>/`. Never install
or run the probe against live user roots.

```sh
bun run --cwd packages/pi-plugin build
MC668_ROOT="$root" bun docs/reports/probes/issue-668/bundle-master.ts
MC668_ROOT="$root" bash docs/reports/probes/issue-668/run.sh fixed
MC668_ROOT="$root" bash docs/reports/probes/issue-668/run.sh fixed --responses
MC668_ROOT="$root" bash docs/reports/probes/issue-668/run.sh fixed --conflict --no-dump
MC668_ROOT="$root" bash docs/reports/probes/issue-668/run.sh fixed --conflict --no-dump --responses
MC668_ROOT="$root" MC668_PLUGIN="$root/master-plugin/index.js" \
  bash docs/reports/probes/issue-668/run.sh master --conflict --no-dump
MC668_ROOT="$root" MC668_PLUGIN="$root/released/node_modules/@cortexkit/pi-magic-context/dist/index.js" \
  bash docs/reports/probes/issue-668/run.sh released --conflict --no-dump
# Repeat the baseline commands with --responses for the other API.
```
