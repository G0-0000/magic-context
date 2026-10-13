# Pi: late tag prefixes after transient-storage LKG replay

## Conclusion

**Both small AGAUTH busts are a Magic Context recovery-path cache defect.** Our
context handler ran on all four requests. On requests **115** and **126**, writer
admission hit `SQLITE_BUSY` and Magic Context returned its last-known-good (LKG)
transformed prefix **plus an untouched new raw tail**. On the next healthy
requests, **116** and **127**, ordinary tagging added prefixes to that tail even
though it had already been sent to the provider. This invalidated a small suffix
of the previously cached conversation, not the entire prefix.

`no_mc_pass_row` means the analyzer found no nearby `transform_decisions` row
identifying a Magic Context scheduling/fold decision for the request; it is
**not evidence of a request bypassing Magic Context**. Neither Pi nor pi-rewind
is needed to explain these changes: our own served-array digests record both
versions, and our live log
records the recovery and healthy tagging paths.

No product code, tests, live logs, dumps, stores, or configuration were changed.
This report describes the defect and a proposed fix, not an implemented fix.

## Sources and exact bytes

Magic Context repository revision: `207e64e298dcb94309e29158a4998e363f66e901`.
Times and indices below are UTC and zero-based.

- **J (Pi session JSONL)**: `~/.pi/agent/sessions/--Users-ufukaltinok-Work-Projects-CortexKit-antigravity-auth--/2026-06-02T15-48-02-003Z_019e8905-3b53-7442-b79f-4ee106474820.jsonl`.
- **B (provider request/response dumps)**: `~/Work/Projects/CortexKit/antigravity-auth/.pi/pi-llm-debugging/019e8905-3b53-7442-b79f-4ee106474820/`.
- **L (Magic Context Pi log)**: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/pi/magic-context/magic-context.log`.
  This is the Pi harness log, **not** the daemon's dated files under the storage
  directory. Original line numbers are used below.
- **D (handler-output digest ledger)**: `~/.local/share/cortexkit/magic-context/pi-served-array-digests/019e8905-3b53-7442-b79f-4ee106474820-e52f0325bfcd.jsonl`.
- **DB**: `~/.local/share/cortexkit/magic-context/context.db`, queried with
  `sqlite3 -readonly`.

The analyzer resolves bodies to `<session cwd>/.pi/pi-llm-debugging/<sessionId>`
unless `--bodies-dir` overrides it
(`packages/pi-plugin/scripts/analyze-pi-cache-busts.ts:904–919`). It joins them to
served passes by write time, not by assuming filename numbers are globally
unique. The analyzer invocation in the reproduction section loaded 2,488 bodies,
matched 2,487 passes, and reported three busts in the 13-request window.
There are two JSONL candidates
with the same session ID; it selected the newer AGAUTH candidate above, not the
older `Work/OSS/opencode-antigravity-auth` copy.

### What the “10 characters” actually are

Each addition is **8 characters / 10 UTF-8 bytes**: `§` + five decimal digits +
`§` + one ASCII space. The vectors measure UTF-8 serialized block bytes, not
plain-text character counts (`packages/pi-plugin/src/served-array-ledger.ts:274–298`).
The decimal number identifies the message's Magic Context tag.

| Transition | Normalized MC message | Actual provider JSON location | Exact addition | Original text begins |
|---|---|---|---|---|
| 115 → 116 | 1209, assistant text | `messages[1310].content[1].text` | `§29368§ ` | `I'll refresh the drafts against 3.0.2 and check the cited line numbers before posting.` |
| 115 → 116 | 1210, tool result | `messages[1311].content[0].content` | `§29369§ ` | `ca92ad8f` followed by the command output |
| 126 → 127 | 1232, tool result | `messages[1344].content[0].content` | `§29384§ ` | `Created new file.` |
| 126 → 127 | 1233, tool result | `messages[1344].content[1].content` | `§29385§ ` | `Created work wi_eb07518ca61cf942: Remove code left dead by the common-auth migration` |

Thus these are **two late-tag events affecting four already-sent messages**,
not just the first divergence reported for each event. For every cell, the
later string is exactly `prefix + earlier string`; none of the underlying
result/prose text changed. The first marker's UTF-8 hex is
`c2a7 3239333638 c2a7 20`. System, tools, model, thinking settings, and all other
top-level request fields are equal across both pairs. The provider also moves
the terminal `cache_control` annotation as it appends messages; that is distinct
from the text changes.

The normalized tail of D sequence 115 ends with
`assistant:thinking(4774),text(111),toolCall(1076)` and
`toolResult:text(1304)`; sequence 116 has `text(121)` and `text(1314)` at the same
positions. Sequence 126 ends with `toolResult:text(42)` and
`toolResult:text(952)`; sequence 127 has `text(52)` and `text(962)` there.
These are handler-output records, before provider request serialization.

## Why the tags were missing on first send

| Request | Handler evidence in L | Result |
|---|---|---|
| 115, 08:57:37 | L:11817: `stage=findSessionId`; L:11819 at 08:57:37.574: `TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG replay served 1211 messages instead of raw 1355` | Handler ran; ordinary tagging did not run. Saved transformed prefix plus raw suffix was sent. |
| 116, 08:58:09 | L:11874–11890: normal stages including `fallbackIdentityAndAdoption` and `tagMessages`; L:11884: `decision=defer`; L:11926: completed, 1213 messages | Healthy pipeline tagged the two previously raw messages, as well as new eligible messages. |
| 126, 09:29:38 | L:12949: `stage=findSessionId`; L:12951 at 09:29:38.609: `TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG replay served 1234 messages instead of raw 1378` | Same recovery path; two completed tool results were sent raw. |
| 127, 09:29:53 | L:12952–12968: normal stages including `tagMessages`; L:12962: `decision=defer`; L:13004: completed, 1237 messages | Healthy pipeline added both late tool-result prefixes. |

The source explains the observed sequence:

1. `PiLkgCoordinator.beginPass` finds the saved input anchor and clones the
   suffix after it as `pristineTail` (`packages/pi-plugin/src/pi-lkg.ts:569–640`).
   Replay reconstructs the saved transformed output and appends that untouched
   tail (`pi-lkg.ts:722–802`).
2. The handler's writer-admission `beforeRetry` hook can fit-check this replay
   and throw `PiLkgAdmissionReplay` rather than wait for ordinary transformation
   (`packages/pi-plugin/src/context-handler.ts:4333–4397`). The catch captures
   served evidence and returns the replay directly (`context-handler.ts:6246–6267`).
3. A healthy invocation starts from its new `event.messages` and runs the
   pipeline (`context-handler.ts:4187–4188,4304–4323,5351–5403`). Its tagging stage
   allocates/applies normal tags (`context-handler.ts:8575–8609`). The busy
   return recorded served evidence, but did not publish a new applied LKG slot
   containing an immutable handoff of that raw suffix.

This excludes the proposed alternatives **for these two incidents**:

- **Handler bypass / another extension's independent request:** contradicted by
  the four handler traces and matching served digests. Other extensions may
  participate in the session, but do not explain this mutation.
- **Newest-message tagging deliberately deferred:** not the ordinary scheduler
  policy. Both recovering healthy passes say `defer` and still run `tagMessages`;
  only the storage-recovery return skips it. Most other newest messages were
  tagged on first send.
- **Still-streaming tool result:** the earlier dumps already contain the final
  result strings, with `is_error=false`; the later strings differ only by tags.
- **Fallback-ID adoption (issue 650):** when a real session-entry ID becomes
  available, Magic Context can adopt a tag previously allocated to a temporary
  message ID without renumbering it. Adoption may run in the healthy pipeline,
  but there was no previously served number on these four raw strings to adopt.
  The observed cause of their first untagged send is the logged LKG early return,
  not an identity-number substitution. Their precise internal entry IDs are not
  needed to establish that byte change.

### Why there is no MC decision row

The attribution classifier's `no_mc_pass_row` fallback describes missing
decision evidence (`packages/plugin/scripts/cache-bust-attribution.ts:378–425`).
The analyzer searches a bounded nearby decision window
(`packages/pi-plugin/scripts/analyze-pi-cache-busts.ts:382–410`). The latest
retained AGAUTH Pi decision in DB is **2026-10-12 14:37:39Z**; there are no rows
in the incident window.

This is not a per-request receipt table: the handler prepares decision
publication only for qualifying `bustedThisPass` pipeline outcomes, not every
healthy/defer pass (`context-handler.ts:5419–5458,6240–6244`), and Pi publication
can be delayed until an answering assistant ID is known
(`packages/pi-plugin/src/pi-reclaim-decision-row.test.ts:12–16`). Here the
healthy pipeline is not classifying its late tail tags as a scheduled prefix
fold. Missing rows do not contradict the live handler evidence, nor establish
a separate decision-writer failure.

## Frequency and token cost

The reproducible census window is **2026-10-13 03:37:42Z–09:40:21Z**. Its lower
bound is the v0.49.0 release commit time
(`1dd2f925d5a8f604101e1d152eca846cabc9e3ef`, 05:37:42 +02:00). The AGAUTH host was
reported to be on the 0.49.0 build. The retained Pi log has no independent runtime-version stamp,
so this is a **post-release live-log census**, not proof that every logged host
restarted at the release instant. The rotated `magic-context.log.1` ends at
2026-10-12 23:00:08.201Z and contributes no rows to this window.

| Pi session in live log | Context starts / request bodies | Usage-joined served requests | SQLITE_BUSY LKG returns | Exact late-tag transitions / messages |
|---|---:|---:|---:|---:|
| AGAUTH `019e8905-3b53-7442-b79f-4ee106474820` | 48 | 48 | 2 | 2 / 4 |
| Anthropic Auth `019de471-4fdc-762d-9286-624dfad0b5fe` | 64 | 63 | 0 | 0 / 0 |
| **Total** | **112** | **111** | **2** | **2 / 4** |

The second session has one context/request at 08:15:39.832Z without a
usage-joined served request. It is included in the raw-body comparison, not
silently counted as a metered success. No other session has a context start in
the retained live log in this bounded window.

I scanned consecutive request bodies by file write time, including the
preceding body, and compared existing text/tool-result string fields for an
exact new `^§\d+§ ` prefix with otherwise unchanged text. The only matches are
the four cells above: **2/112 requests (1.79%)**, or **2/111 usage-joined requests
(1.80%)**; in AGAUTH, **2/48 (4.17%)**. Both logged LKG recoveries were followed
by this problem; no healthy-first-send pair exhibited it. This supports a
**systematic recovery→healthy transition bug**, not universal one-request-late
tagging. The sample of recovery events is only two; it does not estimate a
long-term contention rate.

The analyzer estimates **1,829 + 3,172 = 5,001 tokens** of previously sent
prefix reprocessing across the two busts. About **99.69%** and **99.48%** of the
prior prompt remained cached respectively. The cost is the invalidated tail
from the earliest new marker onward, not just four short marker strings and
not the roughly 600K-token whole prompt. `rewrittenTokens` is a meter-based
estimate, not a tokenizer-exact billing breakdown; dollars depend on the
provider's cache-read/write prices. I do not include unrelated provider full
misses in the 5,001-token defect estimate.

**Separate 09:28:35 miss:** the prior conversation content, system, and tools
are identical after ignoring the moved cache-control annotation and appended
messages; cache read is zero after **28m45.430s**, consistent with provider
cache expiry, not a Magic Context prefix rewrite (the exact eviction reason is
not observable).

## Proposed fix and proof

Keep the recovery availability benefit, but **make the exact recovered output
a served-prefix obligation for the next healthy pass**, including the appended
raw tail. A process-local detached snapshot can retain the input identity and
content evidence plus the returned output. After healthy admission, validate
that those input entries still match; preserve the recovered output as an
immutable prefix and tag only genuinely new suffix entries. Already-served raw
entries must remain raw until an explicit, attributable prefix-busting fold
permits normalizing them. Do not allocate speculative tag numbers or perform
extra tag-state reads/writes while writer admission is busy. Persist the
obligation under healthy admission if it must survive restarts; otherwise a
restart must take the safe refusal/rebuild path rather than promise byte
stability it cannot prove. Branch contraction, replay-owner mapping, and
content mismatch must use the existing validation/refusal rules, not positional
guessing. The coordinator already validates IDs/content for contracted replay
(`pi-lkg.ts:722–769`), but the recovery-to-healthy handoff is not implemented.

A narrower safe alternative is to refuse a busy replay that appends previously
unserved eligible raw messages, then retry after admission permits tagging. It
trades availability for simpler prefix correctness. Merely “tag the replay
tail” by allocating numbers while SQLite is busy would violate the admission
and served-number publication guarantees. Merely suppressing the analyzer
warning would leave the real provider cache cost intact.

The decisive regression belongs in
`packages/pi-plugin/src/context-handler-lkg.test.ts` (existing fit/recovery
coverage at 310–390):

1. Capture a healthy tagged prefix through the real handler.
2. Append an eligible assistant prose/tool-call message and a completed tool
   result. Force transient writer-admission `SQLITE_BUSY`; assert that the busy
   response is the captured prefix plus exact raw tail and that no unsafe tag
   allocation/publication occurred.
3. Release the lock; call the healthy handler with the same raw entries plus
   another turn. **Assert full serialized equality of every already-sent
   message against the busy response**, including the tail, not just the old
   LKG prefix. New suffix entries can be tagged.
4. Repeat with two tool results as the tail, matching the 126 → 127 case in the
   byte-evidence table. Check served numbers, duplicate allocation, restart
   handling, and identity/content
   mismatch refusal. A coordinator-only replay test is insufficient: the bug
   occurs across the next healthy handler invocation.

That cross-pass equality assertion should fail today at the first newly added
`§…§ ` prefix and pass after the proposed handoff. This report does **not** claim
to have added or run that failing reproduction. Existing
`pi-lkg.test.ts:251–311` covers replay of a contracted captured suffix plus
append/restart, and `served-array-ledger.test.ts:206–226` covers normal and
detached capture; neither proves the new cross-pass invariant.

For a fix, run those focused suites plus the Pi package's `bun run typecheck`,
then replay the 115 → 116 and 126 → 127 pairs from B in an isolated fixture and
verify the returned previous-message prefix is unchanged. A live smoke test should record
the recovery reason and compare exact returned bytes on the following healthy
request, independently of whether a transform-decision row exists.

## Reproduction and evidence preservation

Initial read-only command (run from this worktree):

```sh
cd packages/pi-plugin
bun scripts/analyze-pi-cache-busts.ts \
  --session '019e8905-3b53-7442-b79f-4ee106474820' \
  --since '2026-10-13T08:57:30Z' --until '2026-10-13T09:30:00Z' \
  --show-diff --all-rows
```

To reproduce the census meter results, use the exported
`analyzePiCacheBustSession` with `sinceExclusiveMs=Date.parse("2026-10-13T03:37:42Z")`
and `untilInclusiveMs=Date.parse("2026-10-13T09:40:21Z")` for both session IDs in
the table. It returns 48 and 63 requests respectively; the two non-full-miss
busts are the supplied late-tag pairs. For the raw-body census, the other body
directory is
`~/Work/Projects/CortexKit/anthropic-auth/.pi/pi-llm-debugging/019de471-4fdc-762d-9286-624dfad0b5fe/`.
Sort `*-req.json` by `stat.mtimeMs`, restrict the same window plus its immediate
predecessor, and compare common-index text fields and string tool-result
contents: require `later === marker + earlier`, where `marker` is the entire
leading `§<digits>§ ` match, and require that the earlier string has no such
leading marker. This also checks the one request without joined usage.
The log census counts
`stage=findSessionId`, `transform completed in`, and `TRANSIENT STORAGE FAILURE`
by timestamp/session, not by a search for `no_mc_pass_row`.

Read-only decision query:

```sh
sqlite3 -readonly ~/.local/share/cortexkit/magic-context/context.db \
  "SELECT session_id,harness,count(*),
          datetime(min(ts_ms)/1000,'unixepoch'),
          datetime(max(ts_ms)/1000,'unixepoch')
   FROM transform_decisions WHERE harness='pi'
   GROUP BY session_id ORDER BY max(ts_ms) DESC;"
```

SHA-256 of the supplied raw request evidence (the files remain in B, not copied
into a build directory or this repository):

| File | SHA-256 |
|---|---|
| `115-req.json` | `c323318ff5a56339456a4ececad4a4007e025a106d01c27216ed12586ff79648` |
| `116-req.json` | `c6de75dbc46ed6e444e81baaec10e35d5522762faf707ee386dfca4862259c06` |
| `123-req.json` | `88c1e3931b316bb0004ee3133d8edf03774c7d54ea262a4e2d0b19d202f0e66c` |
| `124-req.json` | `2019d36a696836f8a5500b298b37f91a5eda3927e351e2d61a8a6ff2314fc412` |
| `126-req.json` | `fc85802716535887d9c1a0b1d268f95267e88c9e6260c161cbe5635674fbbb38` |
| `127-req.json` | `f6884b024fed6c680d205f64816bf5d39052fa30fab997355d2035b7521c75fa` |

Verification of the supporting analyzer and existing recovery/capture tests
(not a reproduction of the missing cross-pass invariant):

```sh
cd packages/pi-plugin
bun ../../scripts/check-bun.mjs
BUN_JSC_useOMGJIT=0 bun test --parallel=1 --timeout 30000 \
  scripts/analyze-pi-cache-busts.test.ts src/context-handler-lkg.test.ts \
  src/pi-lkg.test.ts src/served-array-ledger.test.ts
```

On Linux with Bun 1.4.2: **63 tests passed, 0 failed, 252 assertions**, four files.
No typecheck/build was needed for this Markdown-only change.
