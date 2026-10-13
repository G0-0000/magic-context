# OpenCode 1: three cache rewrites following a forced flush

Session: `ses_331acff95fferWZOYF1pG0cjOn`, 2026-10-13 08:28–08:40 UTC.
TypeScript transform, Anthropic `claude-opus-5-5`. Investigation source revision:
`207e64e298dcb94309e29158a4998e363f66e901`.

**Report only. No product code was changed.** The accompanying test file contains
three expected-failing assertions and four passing controls/characterizations.

## Conclusions

The initial premise needs correcting:

* **08:32:20 was not an ordinary planned HARD preflight, nor a user `/ctx-flush`.**
  A final-wire fit check retried the transform, artificially raised postprocess
  pressure to 95%, and set the generic pending-materialization flag. Postprocess
  calls that flag `explicit_flush` regardless of its producer. The prefix was
  rebuilt at delivery, after the thinking hold was released, not during the
  earlier prefix preflight.
* **08:32:24 is an in-process seam/trim mismatch, not OpenCode applying a new
  compaction marker.** The rebuilt prefix's assistant boundary was absent at
  delivery. Delivery served older rows, but the next request's preparation cut
  them using the now-persisted boundary. The immutable source-order trimming
  remedy already exists, but its capture is restricted to deferred-history
  consumption and is absent on this forced-thinking retry.
* **08:33:37 is not a late refresh of a date that Magic Context froze.** The
  actual prompt has `<plugin-env> ... Date: YYYY-MM-DD`; the sticky-date matcher
  only recognizes `Today's date: ...`. The environment date is unmanaged. When
  the host first supplies the new date, it changes the system hash and causes
  the full provider miss.
* **08:36:19 is a new marker write/fold on that request**, not a four-minute-old
  write finally reaching OpenCode. The date-induced system-hash flush waited
  behind the active-thinking hold until the next real user turn. Its HARD fold
  and marker drain change the summary identity and allocate a new tag. A
  scheduler `defer` does not mean that a system-hash HARD fold cannot execute.
* These mechanisms **still reproduce on current master and on the issue-665
  source revision** tested below. The host's copied chunks also contain the
  issue-665 hold/retry code. This is not evidence of a pre-665 host.

## Evidence handling and loaded build

The analyzer was run first, exactly as requested:

```
bun packages/plugin/scripts/analyze-cache-busts.ts --session ses_331acff95fferWZOYF1pG0cjOn --since 2026-10-13T08:28:00Z --show-diff
```

It inspected 76 requests and reported four metered busts. Its byte differences
and usage totals are useful; `accounted_hard_marker_drain` at 08:32 is not an
accurate account of this particular pass. Its `unaccounted_defer_pass` at 08:36
also misses the separately logged system-hash HARD fold.

The live log and body dumps were read in place. Both databases were opened only
with `sqlite3 -readonly`. No live DB, dump, credential header, or private prompt
was copied into the repository. Dump extraction printed only dates, tags, shape,
sizes, hashes, and aggregate counts. The `.request.json` files contain headers;
the relevant prompt content is in the corresponding `.body.json` files.

The parent supplied code-only copies of the loaded entry and its transitive
chunks, plus `BUILD.txt`. They are retained, **untracked**, under
`local-ignore/investigation-evidence/loaded-dist/`. The stamp says entry mtime
**2026-10-13T02:56:05Z**, before the OpenCode server start at **07:48:50Z**, not
October 12 16:00. The newest source commit before that timestamp is
`3cecbda11b1f29b3668d10be1bfdbce27a030915`. That commit's package manifest still
says **0.48.0**; the later release commit sets 0.49.0. Calling `3cecbda1` the
0.49.0 release commit would be inaccurate.

Exact SHA-256 fingerprints of the copied code:

| File | SHA-256 |
|---|---|
| `index.js` | `be1ac3759049f9b14e81e3801d3cabf51d271b036cd97d715d71ecd996a9091e` |
| `index-manc5q60.js` (transform/system hook) | `245ce538e10654940e839ae8578a69032dec7d9252e7fe3bc9116d2e0ce68786` |
| `index-024yy5s8.js` (prefix rendering) | `976c8ec2006183c145fec802cd127dc2c7b74ce46c778eb41d2dd393cbe45951` |
| `index-d0y98r34.js` (postprocess) | `d2fa2e1d038d9852093cbb29cdbc6b5126a9ad25c2b0d1c5a88ce57810709000` |
| `index-qha31351.js` (wire estimation) | `24b8ff989496bd2856fc14c8548d8aabcd4ffe3820797ec5b28d8df5cf3939d5` |

The entry imports both handlers from `index-manc5q60.js:165–166`, and wires
`consumeMessagesPrepared` at `index.js:10700`. The copied transform contains the
thinking-fit recursive retry at `index-manc5q60.js:24242–24252`, and postprocess
contains the hold-release gate at `index-d0y98r34.js:6169–6175`. These are direct
content evidence that the issue-665 changes are present.

**Source-commit pin limitation:** the bundle does not embed a Git SHA. A Bun 1.4.2
rebundle of the archived `3cecbda1` plugin succeeded (712 modules) and produced a
byte-identical `index-qha31351.js`, but not byte-identical entry/transform/prefix
chunks. Thus the timestamp gives a candidate source revision, not proof that
every loaded byte was built from a clean checkout of precisely that SHA. The
fingerprints above identify the supplied build exactly; the conclusions below
cite its actual contents as well as current source. No stronger commit claim is
made.

## 1. 08:32:24 — delivery and replay use different trim opportunities

### Log and wire evidence

Live log references below are line numbers in `magic-context.log` as inspected.

| Lines | Evidence |
|---|---|
| 30756, 30781–30782 | First transform: 75.4%, scheduler execute, prefix preflight `foldExecuted=false`; pending operations held because no independently permitted prefix rewrite occurred that they could share. |
| 30806–30816 | Final-wire estimate 872,526; immediately another transform begins with the same 3,083 input messages, scheduler still 75.4%. |
| 30841–30846 | Retry still has `foldExecuted=false`; then reasoning strip of 98 assistants, `explicit_flush`, context **95.0%**, pending 249 applied. |
| 30860–30862 | Delivery: boundary `msg_12fa987200016ygl4CMFLLdHsC` absent; first remaining row `msg_12ef9bf49001p5JTUuDwnLuntP`; **no in-pass trim applied**; prefix rematerialized. |
| 30984–31011 | Next input has 3,084 messages, not a newly compacted host window. `prepareCompartmentInjection` runs; tag targets shrink from 2,608 to 2,353. |
| 31021–31036 | Defer pass: no heuristics or pending operations applied. The same boundary now precedes first remaining row `msg_12faa6311001piHg6sz058WxKf`; nothing further to cut. |

Bodies `08-32-20-796Z-000866` and `08-32-24-475Z-000869` have identical synthetic
head and summary (`§214072§`). Their first user message after that summary changes
from **60 parts**, starting `[dropped §212989§]`, to **18 parts**, starting
`[dropped §213248§]`. The analyzer counts system as message 0, so this is its
message 3. It contains consecutive user rows combined into one provider message.
The head hash is unchanged, excluding a second prefix render as the
first divergence on 08:32:24.

Read-only context rows associate 212989 with `msg_12ef9bf49001p5JTUuDwnLuntP:p0`
and 213248 with `msg_12faa6311001piHg6sz058WxKf:p0`. The OpenCode boundary row is an
assistant containing step metadata, 311 characters of reasoning, and one
`bash_status` tool, **no ordinary text**. Its tool tag is 213244. This is the
shape susceptible to removal by reduction/representation changes. The log
proves that the row was absent at final delivery; it does not name the exact
individual reducer that removed it.

There is no 08:32 marker-injection/drain line for this session. A marker-written-
one-request-late explanation is not needed and conflicts with the unchanged
incoming window size and unchanged summary identity.

### Mechanism and fix proposal

`transform.ts:1799–1808` captures immutable `prefixTrimSourceOrder` only when
deferred history is pending and the prefix is not frozen. Loaded equivalent:
`index-manc5q60.js:23665–23667`. On the forced retry the thinking hold is still
active at this earlier point; it is released only in postprocess
(`transform-postprocess-phase.ts:2326–2341`).

Without source-order evidence, final injection looks for the boundary in the
already-mutated array and falls back to serving the window if it is absent
(`inject-compartments.ts:3918–3935`; loaded `index-024yy5s8.js:15786–15795`).
Rematerialization clears the preparation cache (`:3938–3942`). On the next
request, `prepareCompartmentInjection` rebuilds with the durable cached baseline
boundary and cuts before reductions can erase the boundary
(`:618–647, 672–685`). Hence the later tail start on a pass that otherwise only
replays decisions. This is **trim timing**, not a queued drop first applying on
the defer pass.

**Proposed fix:** capture canonical source order before pruning on every pass
that can deliver/refresh a prefix, including emergency hold releases. Do not
gate that evidence on whether a deferred-history flag was initially consumable.
Use the existing immutable-order trim at delivery (`:3842–3916`). Re-evaluate a
forced release's fold/preparation ownership before delivery rather than treating
it as though the earlier frozen preflight settled the trim.

**Proof:** the new seam reproduction removes an assistant boundary between
preparation and delivery. Without source order the fresh array retains
`covered-user`, while replay cuts it. With source order the two cuts agree. An
approval-stage integration test should additionally exercise the real recursive
fit retry and its reductions, and compare complete Anthropic request bytes over
the retry, first defer, and next user turn.

## 2. 08:33:37 — the environment date is outside the sticky-date matcher

The date-bearing body element is `<plugin-env> ... Date: 2026-10-12 ...` in
requests 000866, 000869, and `08-33-23-462Z-000884`. Request
`08-33-37-709Z-000888` has `Date: 2026-10-13`; its synthetic head, summary tag,
and first tail user block are unchanged. Usage is read=0, write=300,737.

Log 32143, **08:33:35.185Z**, explicitly records system hash
`d760bddc927dd08d1922ba750735caf7 → 9319e3ec623c6fee88f5535eefd9e6ad`, triggering
flush. At 32152 the transform freezes m[0]/m[1] for the active prefix-bound
thinking turn; 32181 records no HARD execution; 32182–32195 record replay/no
cleanup. There are **no `system prompt date frozen` or `updated` records** for
this session in the inspected log.

The sticky-date map is populated only by `/Today's date: .+/`
(`system-prompt-hash.ts:447–467`; loaded `index-manc5q60.js:24667–24690`). It never
recognizes this `Date:` line. For recognized dates, the advancing conditions are
the one-shot `systemPromptRefreshSessions` flag, idle expiry, or a non-date
content/preset change (`:422–435, 473–499`). Scheduler execute alone is not such
a signal, and the fit retry only adds pending **materialization**, not system
refresh (`transform.ts:2986–2988`). The handler consumes an incoming date; it
does not manufacture today's date from the clock.

Thus “frozen before midnight and should have refreshed at 08:32 HARD” is false
for this field. There was no normal HARD preflight then, no matching date freeze,
and the outgoing host date was still October 12. The dumps do not capture the
raw pre-hook system input, so they cannot identify which upstream host cache or
prompt renderer first supplied October 13 at 08:33.

**Proposed fix:** freeze recognized structured host-environment date fields as
well as `Today's date`, scoped to the actual environment block (not arbitrary
`Date:` text in documents). Tie their release to the request's actual prefix-
bust permission, not mere scheduler execute or a refresh queued for a future
request. On a system-first host, coordinate the system output and messages
decision so a date-only change cannot first escape on a held tool continuation.
If the host provides a stale date at the permitted refresh, define how to obtain
the live date in the host's timezone; matching another regex alone cannot turn
an incoming October 12 into October 13.

**Proof:** the new warm-date assertion fails on the `Date:` field inside
`<plugin-env>`, while the
`Today's date` control freezes and advances correctly. Add supported host date
formats, timezone/day rollover, multiple system elements, and both hook orders
to the eventual fix tests. Warm/held requests must be byte-identical; the live
date must appear on the one permitted rebuild, with no subsequent hash flush.

## 3. 08:36:19 — the date-induced flush drains at the next user turn

The evidence distinguishes a new write from a delayed host read:

* OpenCode message `msg_134679b7b001Dn8mdE0lsvmZyP` is a **user** row created at
  08:36:07. The transform starts at 08:36:08 with scheduler defer, 35.0%
  (log 34673–34684).
* **08:36:12.022**, log 34715–34716: HARD `reason=system_hash`, executed=true,
  bustsServedPrefix=true. At 34717–34720, pending operations are read under the
  generic `explicit_flush` label; both pending operations are protected no-ops.
* **08:36:16.851**, log 34740: a marker is injected at user
  `msg_12fa94b83001dr0YYISlfyuvKf`, summary `msg_12fa94b86001XZK4QbW6RXTl99`.
  Log 34743 records the marker drain applied at ordinal **162792**. Log
  34745–34746 records same-pass wire reconciliation.
* Body `08-35-05-645Z-000909` has summary `§214072§`; body
  `08-36-19-090Z-000924` has `§215618§`. Both bodies have the same system date,
  synthetic head, and first tail user block. This is not another date miss.
* Context tags associate 214072 with old summary
  `msg_12b5afff2001XVIgoGJsb11LZ9:p0` and 215618 with new summary
  `msg_12fa94b86001XZK4QbW6RXTl99:p0`. The old tag is now dropped. OpenCode
  contains the new summary row and compaction part on the boundary user.
  Its summary row's stored creation/update times are **October 12 10:29:46**,
  near that historical boundary, not the time of this marker write. Those
  coordinates are not evidence that the marker existed at that time; the
  October 13 write log establishes when it was installed in this investigation.

The 08:33 system hook ran before the messages transform (log 32142–32144), so it
correctly took its **system-first** branch, adding all three refresh sets
(`system-prompt-hash.ts:527–541`; loaded `index-manc5q60.js:24714–24720`). The
OpenCode-1 messages-first adoption code is present in the loaded entry but does
not turn this observed system-first request into a messages-first one.

The active-thinking hold prevents consumption until the new user turn
(`transform.ts:1574–1591`; `transform-postprocess-phase.ts:2337–2341`). On release,
`system_hash` is a HARD trigger irrespective of the scheduler's defer vote.
Marker draining then reads the pending target, requires covered/trimmed history,
applies the marker, and reconciles the representation on the same request
(`transform-postprocess-phase.ts:3597–3730`). Reconciliation retires the old
summary and assigns a tag to the new summary ID (`:1392–1457`). This explains
both the four-minute delay and the exact location of the byte divergence.

**Proposed fix:** prevent the date-only system miss from queuing a second HARD
fold, by keeping that date inside the shared held-prefix/date-freeze policy.
For an unavoidable real system-content change, distinguish an already-paid
provider system rewrite from a future materialization request; explicitly
decide whether to adopt that hash with the held cached pair or queue a separately
priced fold. Do not bypass the safeguard that keeps the history preceding signed
thinking unchanged during its unfinished tool loop just to make the second
rewrite happen sooner: it prevents provider rejection of the signature. Preserve the marker drain's existing
same-pass reconciliation.

**Proof:** the new integration characterization uses a throwaway OpenCode SQLite
store, real system hook, transform, compartment publication, pending marker,
and marker manager. A system-first `Date:` change queues materialization;
the signed continuation retains the old summary and pending work; an appended
real user, still under scheduler defer, changes the marker and summary tag and
drains materialization. After a date fix, the date-only branch must no longer
queue that second fold. Separate non-date hash-change tests should retain the
intentional hold/release semantics.

## Why 95.0%, and was that emergency justified?

### Exact producer and which pressure wins

The first request's scheduler used provider usage **657,477 / 872,000 = 75.4%**.
The local check subsequently selected the thinking-fit retry. Its implementation
adds `pendingMaterializationSessions`, restores the original input, and invokes
the transform recursively (`transform.ts:2969–2994`; loaded
`index-manc5q60.js:24242–24252`). That fits the otherwise unexplained adjacent
duplicate transform and the retry's 95% pressure exactly.

The scheduler continues using provider usage. Only the postprocess argument is
overridden to `Math.max(95, contextUsage.percentage)` when that retry is active
(`transform.ts:2795–2797, 2814`; loaded `index-manc5q60.js:24132`). The hold is
released for fit at postprocess `:2326–2335`. Pending-set membership becomes
`isExplicitFlush` at `:1989–1995`, and the label chooses that ahead of the force
label at `:2585` (loaded `index-d0y98r34.js:5982, 6272`). No user command is
necessary. **95.0% is a synthetic emergency control value, not a measurement.**

At 08:36 that same label means pending system-hash materialization. It is not
proof of a standing permission left by 08:32: the fit retry and the later hash
change are distinct producers. The reproduction explicitly proves that the
pending flag drains on successful release. Renaming the label to
`pending_materialization` and recording its origin would prevent this confusion.

### The estimate: signature mass, not the mural's base64

The logged estimate can be reconstructed exactly using the static Opus-5
calibration table entry: its prose multiplier is 1.571778 and its tool multiplier
is 1.551639, converting local tokenizer counts to estimated provider counts:

```
ceil(320109 * 1.571778 + 209439 * 1.551639 + 13954 + 30457) = 872526
```

The conversation/tool numbers are local token counts; system/tool-definition
numbers in this log are already calibrated (`final-wire-token-estimate.ts:462–530`).
`providerMass` applies static ratios (`decision-calibration.ts:54–68`).

The estimator **tokenizes encrypted thinking signatures as conversation text**
(`final-wire-token-estimate.ts:119–128`; loaded `index-qha31351.js:1237–1242`).
Counting the nearest pre-retry provider body, `08-32-08-824Z-000863`, in place
with the repository tokenizer gives:

| Component | Count |
|---|---:|
| Visible text, local tokens | 165,162 |
| Thinking text, local tokens | 10,514 |
| 98 opaque signatures, local tokens | **141,862** |
| Signature characters | 202,016 |
| Signature local count × prose multiplier 1.571778, rounded up | **222,976** |
| Image estimate | **1,590** |
| Image base64 characters | 125,936 |

The fit retry removes reasoning from **98 assistants**, named by the
`proactive thinking strip` log at line 30842. The 08:32:20 body
has zero thinking/signature fields, and its one mural is still estimated at
1,590 tokens even though its base64 has 126,056 characters. Image files are
counted by dimensions/fallback, not base64 BPE (`final-wire-token-estimate.ts:130–139`;
`image-token-estimate.ts:14–52`). The mural hypothesis is refuted for this path.

The signature contribution alone is greater than the difference between the
logged estimate and prior measured provider input. Removing the nearest body's
signature contribution from 872,526 gives approximately **649,550**, below the
872,000 window and close to the previous 657,477 provider total. This is a
strong explanation for a **false local over-window decision**: treating opaque
authentication metadata like model-readable prose supplies roughly 223k of
spurious pressure. The new estimator assertion demonstrates that a short
fitting request becomes `refusalGrade=true`, `refusalTokens=9272` solely by
adding an opaque signature.

**Evidence limit:** 000863 is the prior served request, not a dump of the first
08:32:16 transform that was never sent. The telemetry omits `refusalBasis` and
`refusalTokens`. Retry selection can use a correlated provider-prefix count,
a calibrated estimate, or a byte-bound refusal; `trusted=true` alone is not the
refusal predicate. It is therefore not possible to reconstruct the exact
unsent retry threshold from this log. The data do not justify asserting the
request truly exceeded the window, nor that all of the 222,976 count difference
is an exact measurement of the unsent request's error. The strong signature
overcount finding and the fully evidenced synthetic-retry mechanism should be
separated from that remaining measurement gap.

**Proposed fix:** do not count opaque signatures/redacted authentication data
as ordinary prose for fit/refusal. Prefer exact correlated provider prefix plus
the appended, genuinely token-bearing suffix; preserve signature bytes for
prefix-identity matching even when they do not add prose mass. Add diagnostics
for refusal basis/tokens, signed-metadata mass, provider usage, and retry origin.
Do not authorize an emergency prefix rewrite merely because an upper-envelope
telemetry estimate is numerically above the window. Prove that an honestly large
text/tool request still triggers recovery/refusal, while a large signature or
mural payload alone does not.

## Tests and current-master status

New file: `packages/plugin/src/hooks/magic-context/post-flush-cache-rewrites.test.ts`.
All roots and both databases in the integration fixture are throwaway. No live
log, dump, DB, or credential is needed by these tests.

Normal mode uses `it.failing` to mark the three unfixed assertions as expected to
fail; Bun then reports them as passing tests. This is deliberate
report-only coverage, **not seven claims that the bugs are fixed**. Set
`MC_POST_FLUSH_EXPECT_FIXED=1` to expose them as ordinary red assertions.

| Test | Master / `3cecbda1` outcome |
|---|---|
| `plugin-env Date stays frozen on a warm signed-loop request` | Red: returned October 13, expected October 12 |
| `fresh prefix and replay cut at the same removed assistant seam (sourceOrder=false)` | Red: fresh includes `covered-user`, replay does not |
| `opaque thinking signatures do not turn a fitting request into refusal evidence` | Red: refusalTokens=9272, expected <1000 |
| `recognized date freezes on warm passes and advances with a refresh signal` | Green |
| `fresh prefix and replay cut at the same removed assistant seam (sourceOrder=true)` | Green |
| `mural image estimation is independent of base64 payload length` | Green |
| `system-first date miss queues a second fold and marker write at the next user turn` | Green characterization of the delayed second rewrite |

Verification (Bun 1.4.2):

* Normal current-master run: **7 pass, 0 fail, 25 expectations**, three tests
  explicitly marked expected-failing.
* With `MC_POST_FLUSH_EXPECT_FIXED=1`, the expected-failure annotation is disabled:
  current-master run **4 pass, 3 fail, 25 expectations**; exactly
  the three assertions above, with all controls green.
* Archived `3cecbda1` source, same reproduction file, package Bun preload:
  **4 pass, 3 fail, 25 expectations**, same failure names and values. Source was
  archived locally and extracted in a remote job's temporary root, with links
  to this worktree's installed dependencies. No second Git worktree was used.
* `bun run --cwd packages/plugin typecheck`: passed, TypeScript **5.9.3**;
  package script runs the retina build typecheck, plugin no-emit typecheck, and
  scripts typecheck.
* New test Biome check: one file checked (Biome version recorded in delivery).

The first archived-source invocation was made above the plugin package and did
not load its Bun test-isolation preload, so it hit duplicate compartment rows
in the test safety layer's throwaway fallback DB, reused across cases without
the preload's per-case isolation. Duplicate compartment sequence keys violated
a uniqueness constraint. That was a harness error, not a product finding;
the package-directory run above resolved it. Earlier remote attempts to invoke
the ignored archive directly matched no test files; a code-only tar supplied
the archive to the remote runner instead. No live-store access occurred in any
of these runs. A full workspace suite/build was not necessary for report and
test-only changes; the supplied worktree's initial `bun run build` was green.

## Approval-stage acceptance criteria

1. A provider-proven fitting signed continuation cannot enter forced rebuild
   because of signature/base64 metadata inflation; genuinely over-window text
   still recovers or refuses.
2. A rebuilding request and its immediate defer replay share exactly the same
   summary-covered tail start, including when a tool-only assistant boundary
   disappears during reduction.
3. Supported environment dates are frozen during warm/held requests, advance on
   the same paid rebuild, and cause neither a later full miss nor a separately
   queued date-only HARD/marker rewrite.
4. Actual non-date identity changes retain the signed-prefix hold contract and
   marker update's same-request agreement: the summary placed in the provider
   request must match the summary identity written to the host store. Attribution reports those
    hard signals separately from the scheduler decision and from user commands.

## Implementation follow-up: estimation and evidence limits

The preceding sections describe the original investigation, including the
expected-failing tests before the fixes. The reproduction assertions now run as
ordinary tests. The delayed date-miss characterization has become a non-date
content-change control: that intentional signed-prefix hold/release remains.

Encrypted signature strings are no longer tokenized as conversation prose in
the OpenCode final-wire and Pi request estimators (including their fit byte
proxies). Plaintext thinking still counts, and ciphertext still participates in
exact prefix identity. The captured-body aggregates above support this change:
`872,526 - 222,976 = 649,550`, compared with provider input **657,477** on the
previous served request carrying **98 signed assistants**. The difference is
7,927 tokens (about 1.2%). This is aggregate corroboration, not an independent
count of the unsent request or a claim that underlying thinking is free.

Anthropic documents that signatures contain encrypted full thinking, are opaque
to clients, and must be preserved unchanged during tool use:
[Thinking encryption and preserving thinking blocks](https://platform.claude.com/docs/en/build-with-claude/thinking).
Its omitted-display mode still bills full thinking, and prior thinking on models
that preserve it counts as later input:
[context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
and [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting).
These pages do not separately itemize ciphertext's token contribution. They
support counting the underlying thought, not applying prose BPE to its encrypted
representation. No live bodies or stores were accessed during this follow-up.

For a signature-only or redacted assistant step, the estimator uses the host's
stored reasoning count, then its output count (which includes thinking), and
finally the existing **1,000-token unknown-reasoning-step heuristic**, once per
assistant message. That fallback is independent of ciphertext length and is
not a proven upper bound. An unchanged, exactly correlated provider request
prefix takes precedence: fit uses its measured input plus only the appended
suffix. Unknown opaque-step counts and signed-request estimate/provider ratios
are logged for drift visibility without changing decisions. Provider overflow
recovery and the measured-usage emergency guard remain intact.

The Rust module's reasoning-budget path already uses plaintext/reported usage
or the same opaque fallback, rather than signature BPE. Its request guard consumes
the host's final-wire evidence, so it benefits from the shared OpenCode estimator
change. Generic Rust BPE of serialized historian/boundary blocks is not a
provider request estimate and is unchanged.

### Rust-mode environment dates

The additional reported OpenCode 1/ck-mc incident had a date-only full miss of
about 387k at 08:33:30Z, followed by a history-head HARD rewrite of about 197k at
08:33:57Z. Those are supplied incident aggregates, not newly inspected stores.
The owner of date normalization is still the TypeScript system hook:
`hook.ts` registers it independently of the messages transform backend.
`rust-mode-transform.ts` forwards its persisted `systemPromptHash` as
`system_prompt_hash` in the request and pass inputs. The module compares that
render identity in `crates/mc-module/src/transform.rs` before classifying HARD.
Keeping date-only drift out of the host hash therefore prevents both the wire
escape and the later module system-identity fold; no Rust hash normalization
rule is necessary. When the system hook runs first, it can leave a date update
waiting for the messages pass. The Rust adapter supplies its actual
`prefix_bust_permitted` verdict to that pending update: a replay keeps the date
frozen, while an admitted prefix rewrite lets the already-built system array
advance on the same request.
Adapter tests run the real system hook in both hook orders, keep signed thinking
on the served wire, and assert identical requests, unchanged module hash inputs,
no queued materialization, and no second simulated system-hash HARD.

OpenCode 2 copies the system hook's strings into structured system blocks before
the messages pass. Its adapter now registers a request-local update callback so
an authorized deferred date change reaches those blocks on the same paid
request. Updating only the hook's string array would leave that request frozen
and expose the new date on replay, causing another miss despite an acknowledged
hash. A test exercises the real `applyV2SystemPrompt` copy rather than just the
string-array proxy.

### Request-scoped date permission

Date waiters and completed rewrite decisions now belong to individual requests,
not to the session. OpenCode 2's context draft is the mutable container holding
one provider request's system blocks and messages. Its object identity names
that request, and the adapter attaches that identity to the adapted output before
the messages wrapper
runs. TypeScript fit retries and Rust adapter calls retain their own request
handle through that output, so completing one pass cannot release another
request's date.

OpenCode 1's hook API supplies no common request token. Its fallback pairs hook
stages on the last real-user message ID used by thinking recovery to mark the
start of the unfinished tool loop. This is the issue-665 turn anchor:
`activeAnthropicTurnStart(messages, true)` identifies the boundary, excluding
synthetic users and tool-result-only carriers. The system hook reads that same
anchor from the read-only host store. Each paired pass still owns a unique
handle. If overlapping unidentified stages share that anchor before they can be
paired, the dates remain frozen rather than guessing which pass's permission
belongs to which output. Missing anchors also fail closed. The imported
independent review witness now asserts that A's rebuilding pass advances only
A, while B's held output stays at its original date.

The accepted estimate and staleness limits are unchanged: encrypted thinking
without visible text still uses the documented heuristic when usage is unavailable, and continuously warm
sessions keep their frozen date until a permitted rebuild.
