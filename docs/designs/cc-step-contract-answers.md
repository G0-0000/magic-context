# Claude Code step-contract answers

**Source baseline:** the Magic Context repository's migration branch, at commit
`3549c4340ef37066f6690fb466824ac752ba0cbb`.
**Design response:** 2026-10-12; recommendations for the October 13 agreement,
not a claim that the Claude Code lane is implemented or released.

This answers M1–M8 and the codec rules in Thalamus's
`thalamus-cc-step-contract-design-67d0f2a.md`, §§3–4: native codec, caller
admission, exact cuts/paging, context geometry, cache policy, guidance/delivery,
terminal refusal and session bootstrap. The codec review concerns preservation
of signed Anthropic thinking blocks and the request prefixes they depend on.
Here **MC** means Magic Context, **CC** means Claude Code, **SUBC** means the
Subconscious daemon/transport owner, and **BROCA** means the owned LLM-runner
and shared role-contract owner. **Mode 2** is the retiring whole-array
`transform` RPC; **m0/m1** are the settled-history head and its accumulated
delta. A request/view **fence** is a correlation or safety check that prevents
an incompatible answer from being applied or sent.

The report concerns the `reserved:thalamus` gateway bound to
`harness=claude-code`, not
`thalamus-harness`, and replaces mode 2 only after the paired gateway/MC/mod
release passes its gates. No product code, live store, or host process was
changed or exercised to produce this answer.

## Reading the answer

- **Covered** means an implemented operation/field closes the entire item.
- **Partial** means implemented pieces can be reused, but do not close the item
  without the specified additions or binding agreement.
- **New** means the requested lane capability is absent, even if a related
  transform or another provider profile exists.
- Paths and line numbers refer to the source baseline above. Documentation
  citations are design evidence, not proof that the documented feature runs.
- Proposed fields and provider codes below are explicitly proposals, not
  members of the currently pinned commons schemas. **SUBC/BROCA** own commons
  role-contract changes; **MC** owns its provider implementation and store;
  **Thalamus**, acting as the host runner here, owns gateway publication,
  TTL-expiry detection and marker placement, and the CC hook client.
- Effort is an engineering-day estimate for the incremental MC/contract work,
  including focused conformance tests, excluding the full gateway port, external
  review latency, and the 24-hour canary. Parallel estimates are not a summed
  promise to finish by October 13.

## Contract pin and disposition table

Both role crates are package **0.1.2**, pinned to commons
`85c105dfc10dfcd02360ef31b07b4bc67dea41f8`
(`Cargo.lock:214-222,267-274`). Their **wire majors are v1**, not 0.1.2.
Below, `CP/` expands to commons
`crates/cortexkit-role-compaction-provider/src/`, and `ST/` to
`crates/cortexkit-role-step-transform-provider/src/`, at that exact pin.
`ST-CONTRACT.md` names the crate-root document
`crates/cortexkit-role-step-transform-provider/CONTRACT.md` at the same pin
(not a file under `src/`).
The pinned [CP source](https://github.com/cortexkit/commons/tree/85c105dfc10dfcd02360ef31b07b4bc67dea41f8/crates/cortexkit-role-compaction-provider/src)
and [ST source](https://github.com/cortexkit/commons/tree/85c105dfc10dfcd02360ef31b07b4bc67dea41f8/crates/cortexkit-role-step-transform-provider/src)
were read directly; these are not inferred schemas from the attachment.

**Answer to M3–M8:** none closes in full merely by citing an existing RPC operation.
Reuse the existing view/fence/ingress-paging, usage, stability, guidance,
reduction, refusal and epoch surfaces. M7 needs **new MC mapping/tests, not a
new commons refusal schema**. M4 needs both schema and engine plumbing; M3
needs exact native boundary/raw-view retrieval; M5 needs CC policy exposure,
not a second TTL scheduler; M6 needs namespace/delivery binding; M8 needs
capability publication and isolated bootstrap.

| Gap | Disposition and implemented citation | Smallest closure proposal | Owner | Store migration needed? | Incremental effort |
| --- | --- | --- | --- | --- | --- |
| M1 codec | **New**; general CC profile only, `crates/mc-module/src/healing.rs:30-49`; step dispatch is two-profile, `crates/mc-module/src/providers/codec.rs:8-29` | Native Anthropic codec, raw provenance sidecar, signed-prefix admission and conformance | MC + Thalamus; SUBC/BROCA for raw sidecar | No separate DDL: existing message BLOB/view JSON can retain bytes; M8 generation migration shared | 3–5 days |
| M2 admission | **New** for CC; bound host/runner checks exist, `crates/mc-module/src/providers/mod.rs:150-210` | Attested `reserved:thalamus` + bound `claude-code` + frozen CC/answer plan; no body-principal authority | SUBC transport attestation; SUBC/BROCA normative host contract; MC admission | No, apart from M8 | 1–2 days, plus daemon attestation dependency |
| M3 boundary/paging | **Partial**; `CP/answer.rs:14-20,51-92`, `CP/status.rs:244-254`; immutable store views, `crates/mc-store/src/provider_log.rs:1359-1371` | Exact inclusive native part endpoint plus frozen raw replacement/hash and bounded `compaction.view.read`; negotiate hard caps | SUBC/BROCA additive view/retrieval contract; MC persistence/codec; Thalamus exact install | No separate DDL for view metadata/retrieval; **yes** for chunked oversized ingress if required for parity | 2–4 days; add 1–2 for chunked ingress |
| M4 geometry/protection | **Partial**; `CP/status.rs:211-230`; normalization drops geometry/output reserve, `crates/mc-module/src/transform.rs:2359-2397,2593-2594` | Carry soft/hard geometry, attributed fill, explicit reserve and `mid_turn`; preserve all protection gates | SUBC/BROCA additive status fields; MC engine adapter; Thalamus measurement | No separate DDL; persist policy/evidence in existing JSON | 1–2 days |
| M5 cache policy/head | **Partial**; stability slots, `crates/mc-module/src/providers/compaction.rs:866-880`; runner rebuild input, `CP/status.rs:230-232` | Frozen CC policy with absent/default/authored marker intent; runner-owned expiry; view/slot identity without text parsing | MC policy reply; Thalamus runner/markers; SUBC/BROCA for typed extensions | No separate DDL | 0.5–1 day |
| M6 guidance/reduction/delivery | **Partial**; facades dispatched, `crates/mc-module/src/lib.rs:14752-14763`; host reduction, `crates/mc-module/src/providers/step_transform.rs:471-568` | Keep facades, authorize canonical tool surface in plan, resolve generation tags, command idempotence, explicit notice-id dispatch ack | MC facade adapter; Thalamus intercept/dispatch WAL; SUBC/BROCA for notice extension | No separate DDL for existing queues/pending-notice meta; M8 mapping shared | 1–2 days |
| M7 terminal refusal | **Partial**; terminal wire shape `CP/answer.rs:187-204`; engine constant `crates/mc-module/src/transform.rs:2128-2129`; adapters currently map errors to transient | Map protected-tail condition to `refuse/window_too_small` with exact provider code/reason before outage handling | MC mapping/tests + Thalamus precedence; no commons type change | No | 0.5 day |
| M8 attach/bootstrap | **Partial**; role describe, `crates/mc-module/src/providers/mod.rs:75-88`; epochs, `crates/mc-module/src/lib.rs:1370-1398`; current triple key, `crates/mc-store/src/provider_records.rs:36-42` | Publish CC capability/epoch bundle; new profile generation, explicit resumable bootstrap receipt, canonical identity mapping | MC discovery/store/bootstrap; SUBC/BROCA capability agreement; Thalamus ledger/cutover | **Yes**, additive generation key/uniqueness and canonical mapping; no memory rewrite or old-state deletion | 1–2 days |

Estimates share the native codec, attested admission and profile-generation
namespace work; do not count those dependencies twice. The schema additions
require a coordinated pinned
release even where lenient decoding would accept an extra JSON member.

## M1 — raw Anthropic codec and signed-thinking safety

**New for the step lane.** `claude-code-anthropic` exists in the general
serializer/healing profile (`crates/mc-module/src/healing.rs:30-49,98-117`),
but step profile selection, request decode and view encode only dispatch
`owned-broca` and `opencode-aisdk`
(`crates/mc-module/src/providers/codec.rs:8-29,38-54,91-100`). An unsupported
step profile currently returns `invalid_params`. Selecting the existing enum
is not implementing the CC codec.

**Smallest design:** add that native step codec; accept raw Anthropic `messages`
entries without reclassifying their native roles or normalizing scalar content.
Keep top-level system/tools/model/thinking/headers in the gateway. Preserve
message entries that contain system reminders; do not drop them by role.
Use an additive, profile-required `raw_message` UTF-8 JSON sidecar on message
admission and hook subjects, alongside the existing parsed `message` value.
Validate equality after the agreed narrow transport-marker removal; derive
block spans from those raw bytes and persist provenance with the immutable
record. A parsed JSON value cannot recover original member order or escapes.
The store can validate message BLOBs without re-encoding
(`crates/mc-store/src/provider_log.rs:783-789`), but current host status
admission first serializes the parsed value
(`crates/mc-module/src/providers/compaction.rs:1021-1025`); a BLOB column alone
does not provide the missing provenance.
Adding this sidecar is **commons work (SUBC/BROCA)**; decoding, raw-splice
rendering and validation are **MC-internal**, paired with Thalamus's raw ledger.
A lossless profile-specific envelope is an alternative only if both owners
explicitly agree it; silently routing CK as `owned-broca` is not.

Proposed profile failures: `invalid_params` naming `raw_message` for missing or
mismatched provenance; terminal `refuse/code=misconfigured` with
`provider_code=signed_prefix_edit` or `invalid_signed_tool_boundary`
for a required unsafe replacement. The finer provider codes are new; the
role refusal shape already exists. Never synthesize signatures, author
redacted payload, or tag signed text.
The Broca replacement codec already rejects newly authored signed/redacted
reasoning (`crates/mc-module/src/providers/codec.rs:376-407`); reuse the safety
principle, not its native spelling or permission to carry an arbitrary raw CC
message.

### Check of Thalamus §4 against the existing CC profile

- Raw signed-block bytes, scalar/block form, order, tool IDs and unknown extras
  are **target conformance requirements**, not guaranteed by the two existing
  step codecs. Strip `cache_control` only at recognized transport locations;
  never recursively remove similarly named members in tool input/opaque data.
  If a signed block contains a recognized directive, preserve all other raw
  bytes while deleting only that member, and document this sole exception.
  Restore markers only on eligible render-copy text/tool candidates.
- The general engine's historical reasoning strip removes an entire block,
  rather than truncating signed text
  (`crates/mc-module/src/transform.rs:15517-15538`). That does not establish
  byte-exact raw Anthropic round-tripping.
- Active signed-prefix admission exists, but is not a proof for **every kept
  signed block**: its reverse scan stops at a real user, and then rejects prefix
  edits before its selected boundary
  (`crates/mc-module/src/edit_admission.rs:63-89,92-128`). The CC prefix audit
  deliberately documents edit paths producing `PREFIX_ERROR`, including older
  thinking retained on a bust
  (`crates/mc-module/tests/signed_thinking_prefix_audit.rs:714-765,847-885`).
  This is a known source limitation, not a passing release gate. The signed
  hold design explicitly distinguishes current-turn admission and older-turn
  removal, and notes the CC gap
  (`docs/designs/signed-thinking-hold.md:27-47,49-86`); it is a design, not a
  blanket implemented raw-byte guarantee.
- **Required invariant for CC steps: no edit before kept signed thinking.**
  Admission must consider all surviving signed/redacted blocks, including
  historical ones, and block tag/strip/head/replacement edits that change their
  bound prefix. Suppress optional edits; refuse a required unsafe cut. Removal
  of covered signed blocks is allowed only within the authorized valid run;
  do not remove surviving tail blocks to rescue a cut. The existing adapter's
  replacement logic can strip later signed blocks after a first edit
  (`crates/mc-module/src/transform.rs:2788-2812`); it must not be inherited as the
  CC tail policy. The gateway's `drop_block` control is a provider binding
  safeguard, not an exemption from this MC invariant or a cache-hit guarantee.

Conformance must compare original raw slices to actual final-wire slices,
including noncanonical key order/escapes/extras, redacted blocks, nested tool
markers, scalar text, neighboring text rewrites, signed-prefix changes and
cuts before/after complete signed/tool runs. The attachment's two captures
are evidence only for their observed standard thinking spellings, not for
redacted or arbitrary JSON forms.

## M2 — attested CC host admission

**New for this principal/profile pair.** Current provider entry requires a
bound project route, admits only OpenCode/OpenCode2 hosts or a runner bind,
and requires host `serializer_profile=opencode-aisdk` plus
`observation=answer`. Body `session`/`harness` cannot contradict the bound
conversation (`crates/mc-module/src/providers/mod.rs:150-210`). It explicitly
calls bind a temporary trust boundary until daemon-attested caller identity
exists (`:159-160`). The plan is frozen at `transform.declare`; subsequent
plan drift is `invalid_params`
(`crates/mc-module/src/providers/step_transform.rs:1049-1110`).

**Proposal:** daemon-attested principal `reserved:thalamus`, bound project and
resolved session/agent, `harness=claude-code`, and the M1 native profile with
`observation=answer`. Reuse the frozen declare/setup plan, but widen *both*
provider entry and host-plan/host-conversation routing checks; adding a string
to the codec enum alone does not do that. Keep owned-runner and host plans
mutually exclusive. Freeze canonical `ctx_reduce` eligibility and the notice
acknowledgement capability in the CC plan; do not infer them from its body
harness or from a tag.

Use existing `route_unbound` for missing/unauthorized bind and
`invalid_params` naming `session`, `harness` or `params` for a bound-call or
plan mismatch. Attested identity is a **SUBC transport/runtime dependency**,
not a caller-supplied `principal` member in the role body. The role need not
invent a principal field, but **its normative host-admission contract must
change**: the pinned exception names only direct OpenCode/OpenCode2 callers
(`ST-CONTRACT.md:534-565`). SUBC/BROCA must extend that exception to the
attested CC pair, including answer observation, no transcript reads and the
host paging departures; MC then implements it. MC's per-conversation key includes bound project,
session and harness (`crates/mc-module/src/providers/records.rs:13-29,281-287`);
Thalamus must resolve subagents before binding and keep separate actors,
lineages, cursors, views, tags and delivery ledgers. There is no authorization
inheritance from `thalamus-harness`.

## M3 — exact endpoint, immutable views and large frames

**Covered pieces:**

- `compaction.setup`/`step` return `compaction_id`, monotonic `version`, a
  half-open ordinal `range`, and finished `replacement` messages. Before
  `range.from` is omitted, `[from,to)` is replaced, `to` onward is sent as
  written; `from==to` inserts before `to`. Finished replacements are **not
  re-hooked** (`CP/answer.rs:51-92`). This is the working model-view range,
  not necessarily the summarized history's endpoint.
- Optional `coverage={end_mid,ordinal}` names the newest covered **message**;
  trim advances only after application (`CP/answer.rs:14-20,166-174`). The
  host implementation freezes engine and native wire view together and
  returns that coverage (`crates/mc-module/src/providers/compaction.rs:609-647,1276-1292`).
  `(compaction_id,version)` acknowledgements are validated before promote/burn
  (`:987-1001`). Store content is immutable per conversation/version; only
  application state can change (`crates/mc-store/src/provider_log.rs:1359-1371`).
- Ingress is cursor-paged with `after_ordinal`, `messages`, `more`
  (`CP/status.rs:244-254`). `more=true` fences view execution on the host lane
  (`crates/mc-module/src/providers/compaction.rs:1105-1121`). This is **not**
  replacement reply paging. This host exception re-pages immediately only
  on `more=true`, with a fresh request ID; it needs no `compaction.ready`
  service and performs no transcript read. A missing final-page gap refuses
  `history_unreadable`, not an unbounded wait/retry
  (`ST-CONTRACT.md:567-570,643-665`). CC needs its own attested host admission
  to inherit immediate paging and no transcript reads/ready service.
  The role helper sends a single oversized message
  alone (`CP/status.rs:163-181`), while MC rejects a host status envelope above
  3 MiB (`crates/mc-module/src/providers/compaction.rs:974-979`) and likewise
  bounds hooks (`crates/mc-module/src/providers/step_transform.rs:580-585`).

**What `end_message_id` promises today:** the engine/compartment anchor uses
flat block IDs `<mid>#<index>` (last `#`, zero-based numeric index;
`crates/mc-module/src/ck_wire.rs:742-749`). The last compartment's
`end_message_id` is the cache/revert anchor; its `end_message` ordinal is the
inclusive coverage end, with greater ordinals in the live tail
(`crates/mc-module/src/compartment_coverage.rs:135-150`). The engine checks
that a claimed boundary exists at its claimed ordinal
(`crates/mc-module/src/transform.rs:2113-2122,10717-10731`). Neither the pinned
role's `Coverage` nor `CompactionMessage` contains `end_message_id`, raw
replacement bytes, a digest, or a page locator. Internal anchor vocabulary
is therefore **not yet the promised CC wire endpoint**. The general renderer
selects tail messages by `ordinal > coverage`, not by a partial block endpoint
(`crates/mc-module/src/transform.rs:9550-9552,17447-17454`). Do not claim that
an internal part anchor makes arbitrary partial-message trimming supported.

**Smallest additive agreement:**

1. Add `coverage.end_message_id=<mid>#<part>` and an exact raw-view payload or
   immutable payload reference to the CC answer. Define `part` as the
   zero-based **original native top-level content-block index**, inclusive:
   remove through that complete block, keep subsequent blocks in order. A
   scalar content message has one part, `#0`, without changing scalar form.
   The CC codec must retain its native-to-internal part map; nested tool-result
   children and opaque hook `subject_part` IDs are not this coordinate. Never
   infer the endpoint from `range.to`, the last rendered MID or summary text.
2. Freeze raw replacement bytes, endpoint, profile/generation, lineage, view
   ID/version, byte length and digest as one object. **Role replacement bytes
   stand for the role's `[from,to)` range, not automatically just the prefix
   removed by the CC hook.** For a native hook cut, also supply an MC-authored
   `cut_replacement_ref` for the exact head to install and a retained-tail
   identity map, frozen with that endpoint. This prevents installing an entire
   working view and then duplicating its already-included tail. Without this
   mapping the gateway declines the hook cut; it must not infer a head by
   reading summary text or assuming that any first two messages are m0/m1.
   Expose a bounded `compaction.view.read` extension keyed by that exact
   object plus byte cursor;
   every page echoes its version/digest. A later view must not alter those
   bytes. Reuse existing immutable view rows; do not assume mode-2
   `accept_reply_pages` applies to this role. No new fold-boundary query.
3. Advertise envelope/page/single-message caps and account for raw-sidecar
   overhead. Paginate below the 3 MiB envelope limit, not at the role helper's
   default 4 MiB message budget (`CP/status.rs:152-180`). A single unrepresentable
   oversized ingress message refuses `invalid_params` naming `messages` (or
   `message` for a hook), with `provider_message_too_large` as the host-side
   terminal classification already named in `ST-CONTRACT.md:634-641`; no
   truncation/raw-forward. Supporting larger single-message ingest requires a
   separately negotiated chunked immutable payload capability, not the current
   helper's oversized-first-message behavior.

An explicitly bounded canary can refuse those oversized originals safely,
but that does **not** close mode-2 large-message parity. If parity is required
at cutover, add profile-negotiated `message_fragments` to status and an
immutable `message_ref` on hooks: fragments identify MID/ordinal, generation,
lineage, total length, digest and byte offset; admit/promote only after complete
assembly/validation. Retry identical offsets idempotently; conflicting bytes
refuse, incomplete final assembly is `history_unreadable`. This requires
SUBC/BROCA schema agreement plus MC chunk assembly and additive staging rows
in the store (not a truncated `mc_provider_messages` record). Budget another
1–2 engineering days and include this capability in the October 13 decision;
view retrieval alone does not solve oversized input.

**Partial message:** first canary should advertise `partial_message_cut=false`
and emit only exact, whole-message-representable endpoints. If a committed
endpoint is not representable by the CC hook while retaining the remainder's
engine handles, the gateway declines the cut, keeps the full host transcript,
and records `last_not_applied.reason=structural` for that exact view; it does
not acknowledge it applied. Unknown part, inconsistent digest/view or broken
signed/tool run fences publication. Never snap earlier, flatten the remainder,
or silently discard the remainder. The wire turn may continue only with a
separately admissible prior managed view. A boundary inside a signed block is
invalid; one just after it is not automatically a valid tool/reasoning run.

## M4 — geometry, fill and native continuation

**Partial.** The role already carries model/variant, `context_window`,
`output_limit`, `previous_usage`, `previous_provider_code` and
`estimate.request_tokens/previous_input`
(`CP/status.rs:56-79,211-230`). MC normalizes prior input + cache read + optional
cache write; it prefers a complete measurement to the estimate, **not their
maximum** (`crates/mc-module/src/transform.rs:2377-2397`). Scheduling compares
that total against context window times execute threshold (`:2565-2567`).
That is useful measured-input fill, but not CC's soft wall: the host's
usable input budget after native reserves/allowances, rather than the raw
catalog context window.

Today the provider normalizer retains only the context window and input
measurements (`crates/mc-module/src/providers/compaction.rs:650-704`); its
internal status has no output reserve or continuation evidence
(`crates/mc-module/src/transform.rs:2359-2369`). The adapter explicitly resets
`req.geometry=None` (`:2593-2594`). The host engine template carries neither
`mid_turn` nor output reserve
(`crates/mc-module/src/providers/compaction.rs:504-508`). Merely sending the
role's `output_limit` or `step_kind=tool_step` does not restore that parity.

The full-array engine already has
`geometry={usable_soft,usable_hard,absolute_wall,derivation}`
(`crates/mc-module/src/transform.rs:657-665`) and `mid_turn` (`:845-848`);
soft-band/hard-ceiling selection distinguishes the two limits
(`:8595-8622`). Reuse these semantics, not the retiring `transform` RPC.
Protection is independently resolved from effective config/context window
(`crates/mc-module/src/providers/compaction.rs:455-475`); geometry is not
permission to weaken protected tokens, protected tool counts or signed/tool arcs.

**Proposal:** additive CC status fields `geometry` (the existing shape),
`output_reserve` (actual planned reservation, distinct from catalog
`output_limit`), `mid_turn` (explicit native continuation evidence), and
`fill={input_tokens,basis,observed_request_id}` (gateway's current-request,
response-anchored fill or labeled estimate). Retain existing usage/estimate
fields for attribution and compatibility. Plumb the **current** status model
and variant into the same geometry/protection policy; the existing host
engine template/context use the setup model
(`crates/mc-module/src/providers/compaction.rs:504-507,552-555`). A model change
must not evaluate fill against one envelope and protected budgets against
another. The gateway owns overlapping-response
MAX/sequence arbitration and matching-byte anchors; MC must not fabricate that
causal history from the most recent unrelated response.

Require `0 < usable_soft <= usable_hard <= absolute_wall <= context_window`
when all walls are supplied; include output-reserve subtraction and envelope
allowances in `derivation`. Interpret the supplied ceilings as already usable
input ceilings, so MC does **not** subtract reserve twice. Use soft for bands,
hard for hard-fit/refusal evidence, and the actual model window for policy
floors. Validate claimed measured fill against its admitted request/generation;
missing measured fill falls back to the explicitly labeled estimate, not a
200k guess. Keep `step_kind` for hook scheduling and use `mid_turn` for native
continuation/protection without freezing a provisional streaming tail as final.
Refuse missing/contradictory required CC geometry with `invalid_params` naming
`geometry`; an unfit protected tail uses M7, not generic estimate overflow.

## M5 — cache policy, times and head identity

**Covered:** setup's head slots have stability rank 2 at index 0 (m0), rank 1
at index 1 (m1), and execute-threshold call conditions
(`crates/mc-module/src/providers/compaction.rs:866-880`). Whole-view identity
is `(compaction_id,version)`, with immutable committed replacement bytes.
These ranks say relative stability, not expiry time or a promise that m0 never
changes. CC can choose eligible cache markers by rank without reading summary
text; it must not mistake every new whole-view version for a changed m0.

**Runner-owned TTL expiry is the ruling and matches the provider lane.**
MC forces internal producer TTL to `never` because no trusted previous-response
time reaches its scheduler
(`crates/mc-module/src/providers/compaction.rs:558-560,760-764`). The runner
reports expiry via `prefix_rebuilding`; `CP/status.rs:95-110,230-232` already
has the reason-bearing field. `previous_usage.completed_at` and runner `now`
exist (`CP/status.rs:56-67,255-256`), but MC's normalized provider status does
not consume their timing for expiry. `never` here disables MC's idle detector;
it is **not** a marker TTL, an instruction to retain cache forever, or a reply
policy for the gateway.

**Missing CC policy surface:** the full-array profile distinguishes absent
marker TTL from explicit provider-default empty string and authored `5m`/`1h`
(`crates/mc-module/src/transform.rs:2955-2975,3014-3028`). Its assumed lifetime
is a different value, can be clamped to Anthropic's one-hour ceiling, and
uses five minutes for explicit subagent policy (`:2978-3011`). Do not collapse
these to a boolean, or equate internal `never` with an absent directive.

**Proposal:** freeze an MC policy reply in setup/the CC plan, with
`marker_ttl={intent:absent|provider_default|authored,ttl?:5m|1h}` and
`assumed_lifetime` plus provenance and policy revision. Absent means preserve
the gateway's existing default policy; provider-default means no `ttl` member
on the marker; authored means exactly the agreed supported TTL. Thalamus must
admit `1h` only with its paired provider capability/beta header. It records
previous-response completion and request-ingress times against the exact
publication intent, computes expiry once, and sends
`prefix_rebuilding.reason=expired_cache` (the existing spelling in
`CP/status.rs:95-110`); MC must not start another timer from
queue-delayed module `now_ms`.

Use the M3 frozen raw view/slot bytes as opaque head identity. If explicit
per-slot identities are wanted, add `head_slots=[{index,rank,bytes_sha256}]`
to setup/view metadata; hash the **actual committed render bytes**, not
summary content or epoch strings. Frozen identical m0 bytes can remain the
same identity across m1-only view updates. This is additive policy/metadata,
not a new cache RPC or store table. Reject unsupported TTL/intent combinations
with `invalid_params` naming the policy field; never silently downgrade `1h`
or silently inherit expiry disabled.

## M6 — guidance, reductions and Channel-2 delivery

**Covered facades, incomplete step binding.** `guidance.get` resolves the
bound session, selects `full` versus `no_reduce` from the CC profile and
`tool_present`, rejects a contradictory requested `variant`, and returns
`bytes`, `hash`, `content_hash` and a tool manifest
(`crates/mc-module/src/lib.rs:9765-9829,9860-9879`). CC's surface predicate is
exactly CC profile plus tool presence (`:1413-1433`); it is not proof that the
step plan authorized the tool. Thalamus can keep this operation and append
only the selected guidance to top-level system, outside message ingest.

Canonical `ctx_reduce` exists as a facade. It resolves conversation scope and
routes runner/admitted host conversations to provider reduction
(`crates/mc-module/src/lib.rs:13281-13307`). Host reduction looks up committed
hook/engine tags, deduplicates already queued targets, and queues rather than
immediately rewriting served bytes
(`crates/mc-module/src/providers/step_transform.rs:471-568`).
`agent_drops.append` already requires `session_id`, raw `drop` ranges and a
nonempty `command_id`; it resolves the bound session, validates tag targets,
and returns `duplicate=true` for a repeated command
(`crates/mc-module/src/lib.rs:7784-7821,7841-7928,18523-18536`). The four step
operations do **not** execute Claude Code's MCP tool, and the existing host
conversation selector admits only OpenCode/OpenCode2
(`crates/mc-module/src/providers/step_transform.rs:274-289`).

**Smallest CC route:** retain `guidance.get`, canonical `ctx_reduce` and
`agent_drops.append` through mode-2 deletion. Freeze the authorized tool
manifest/profile/surface in the declare/setup plan. Full guidance requires the
canonical, actually served reduce tool and an appendable system surface;
otherwise use no-reduce and advertise no active reduction tags. Match requested
surface against that plan (`invalid_params` for contradictory plan/surface;
existing facade `bad_request` for malformed variants/ranges).

Add MC-internal generation-aware facade resolution: guidance/memory identity
uses the canonical bound conversation; reductions resolve only that
generation/lineage's committed tag rows and pending queue. Use a durable
command key derived from `(provider_generation,lineage_id,tool_use_id)`;
retries return the original receipt, and the same command with different
ranges refuses. Require that key on the CC intercepted route, retaining the
harmless MCP acknowledgement separately from the real queue effect. Do not
invoke both the provider reducer and the old facade for one intercepted call.
A tag's existence, unknown tag tolerance or a successful harmless tool reply
must not grant reduction authority. Protected drops remain queued until
eligible on an independently authorized rebuild; they do not promise immediate
release (`docs/designs/protected-tools.md:34-50`). This needs an internal
adapter/idempotence check, not a replacement tool catalog or new commons tool.

**Channel-2 is not closed by ordinary subject service evidence.** Host
`served_through_ordinal` means durably committed for serving; `unserved_subjects`
burns pending outputs before promotion
(`ST-CONTRACT.md:572-605`). `pass_complete` is only a scheduling barrier,
explicitly not an acknowledgement (`ST-CONTRACT.md:622-633`). Neither names a
notice or proves an HTTP dispatch. The full-array CC path already accepts
`channel2_delivered_id` and maintains a frozen pending directive ID/text/time;
only an exact matching ID clears it
(`crates/mc-module/src/transform.rs:859-865,13914-13958,13967-13994`).

Expose that existing directive/ack mechanism as an additive CC per-pass
extension: `channel2_directive={directive_id,text,armed_at_ms}` on applicable
noop/replacement replies, and `channel2_delivered_id` plus a publication
receipt on the next status. Bind the receipt to generation, lineage,
request/dispatch ID, applied view ID/version and final-wire digest. MC persists
and re-serves a pending notice until a matching acknowledgement (or its
existing explicit lease/rearm policy), rejecting cross-generation/stale
mismatches instead of clearing another conversation's notice. Thalamus records
acknowledgement **only after actual provider dispatch**, never after status
ingestion, MC answer commit, local append, issued hook cut, or WAL intent.
Lost responses replay the dispatch receipt/ack idempotently; they do not
invent delivery. MC trusts the attested caller's receipt, not an independently
observable provider network event. This typed notice extension needs
SUBC/BROCA agreement; it reuses existing pending-notice meta and queues rather
than requiring a new SQL table.

## M7 — terminal protected-tail refusal outranks pass

**Wire covered; MC mapping missing.** `compaction.step` already supports
`answer=refuse`, role `code`, user-facing `reason` and open `provider_code`
(`CP/answer.rs:187-204`). Retry comes only from the fixed role code, not the
provider code or a caller's `retryable` flag. `window_too_small` and
`misconfigured` are nonretryable; `provider_busy`/`history_unreadable` are
retryable (`CP/errors.rs:230-257`).

The exact existing protected-tail provider code and user-facing reason are
(`crates/mc-module/src/transform.rs:2128-2129`):

```text
provider_code: protected_tool_results_over_limit
reason: The tool results kept by protected_tools are larger than this model's context window, so this turn was not sent. Lower the protected_tools counts.
```

The provider adapters currently funnel engine errors through `transient`
(`crates/mc-module/src/providers/compaction.rs:607-608,786-791`), so the role's
ability to carry the code does not prove this condition reaches CC as a
terminal refusal. Smallest fix: match that typed engine error **before** the
generic transient conversion and return request-correlated
`refuse/code=window_too_small`, with that exact `provider_code` and reason.
Use refusal-grade calibrated evidence for the protected subset, not a large
full-request estimate; the source design explains the distinction
(`docs/designs/protected-tools.md:40-44`). No new commons enum, schema or store
migration is needed.

**Claude Code provider-dispatch precedence:**

1. Admission/identity/final-wire defects and explicit compaction refusals prevent
   provider dispatch. A terminal protected-tail refusal is never an outage,
   never a fallback candidate and never automatically retried. It sends zero
   raw retry requests and adds no refused result to history.
2. Host paging `wait` with `more=true` drains the next page under a fresh fence;
   ordinary wait, if negotiated, is bounded/correlated. Neither permits a cut.
3. Hook timeout/failure/unrecognized output follows its frozen
   `on_unavailable` policy: `pass` freezes no hook output for that new subject,
   not an all-history raw bypass. The declaration uses 1,500 ms and `pass`
   (`crates/mc-module/src/providers/mod.rs:26`;
   `crates/mc-module/src/providers/step_transform.rs:222-270`).
   `ST/subscription.rs:183-194` defines pass for hook failure; hook answers
   have no compaction `refuse` variant (`ST/answer.rs:157-179`).
4. A transport-unavailable compaction step can use last-good only if the CC
   publication ledger proves it safe for this exact envelope, lineage,
   covered history and tail. The ordinary role's last-applied fallback
   (`CP/errors.rs:105-121`) is not permission to send an inadmissible CC body.

Do not report the protected-tail condition from a hook as an ordinary hook
error: `pass` could legitimately swallow that error class. Put the terminal
condition in the compaction answer and preserve its typed classification in
Thalamus's dispatch gate. Focused tests must cover explicit refuse versus
hook pass, lost/late answers, unavailable fallback, and zero automatic/raw retries.

## M8 — capability pins and mode-2 bootstrap

**Covered inventory:** `role.describe` advertises the imported role majors/ops
as alpha plus `runner_groups=[transcript_reads]`
(`crates/mc-module/src/providers/mod.rs:75-88,28-30`). The pinned wire names
are `compaction-provider/v1` (`CP/lib.rs:50-73`) and
`step-transform-provider/v1` (`ST/lib.rs:56-87`). The host exception, once
admitted, can operate without transcript reads/ready service; the generic
description does not globally relax runner requirements
(`ST-CONTRACT.md:549-560`).

Current **general render** epochs are CC profile **3**, tagger **4** (only when
active), memory **3**, compartment **2**
(`crates/mc-module/src/lib.rs:1370-1398,1436-1443`). `status` publishes them
under `epochs` (`:8874-8880`; dispatcher `:14751`). These are not a released
CC step-codec/raw-provenance epoch. Do not invent that number or copy old
opaque render strings into native ingest identity.

Current provider state is keyed by `(project_root,session,harness)`;
lineage selects immutable MID/ordinal messages below it
(`crates/mc-store/src/provider_records.rs:36-42`;
`crates/mc-store/src/provider_log.rs:34-54,750-789`). Known MID/ordinal or byte
mismatches refuse rather than overwrite
(`crates/mc-module/src/providers/compaction.rs:1017-1097`). That safety cannot
be bypassed to admit former CK and new raw Anthropic as the same bytes.
The OpenCode host lane adopts `engine_namespace=binding.session`
(`crates/mc-module/src/providers/step_transform.rs:1081`;
`crates/mc-module/src/providers/compaction.rs:846-848`), while owned provider
keys have a separate hashed engine namespace
(`crates/mc-module/src/providers/records.rs:31-38`). This is existing
transport-adoption machinery, not a profile-conversion/bootstrap guarantee.
Setup itself is an empty-range insertion/replayed initial view, not an engine
   opportunity or proof of imported history
(`crates/mc-module/src/providers/compaction.rs:893-959`). A CC initial view
must obey the same signed-prefix admission as later views: use an empty
replacement until a valid head can be inserted if placeholder m0/m1 would
change a kept signed block's prefix. `noop` only records
ingress cursor progress (`CP/answer.rs:163-165`), not bootstrap completion.

**Smallest capability bundle for the paired CC gateway/MC release:** augment
discovery, checked before attaching a managed conversation, with the admitted
principal/harness/profile and required observation mode; pinned commons rev,
wire majors and package versions; CC codec/raw-provenance and render epochs;
exact-endpoint semantics; partial-cut support; ingress/hook/single-message
and view-page caps; raw-view retrieval/digest; cache-policy revision; canonical
reduce/guidance and notice-dispatch-ack capabilities; provider-generation and
bootstrap receipt format. Callers must check these before managed traffic,
then freeze the selected bundle in declare/setup. An absent/unsupported
required capability refuses attach (`misconfigured`/`invalid_params` as
appropriate), not mode-2 or raw fallback. Existing common ops are retained;
capability metadata and normative compatibility require SUBC/BROCA agreement.

**Bootstrap from mode-2 originals into native step state, keeping user identity:**

1. Keep the exact externally resolved project/session/agent identity. Allocate
   an explicit profile-specific `provider_generation`, with a fresh native
   ingest ledger, cursor, view/version, tags, reduction queue and publication
   state. Add generation to the internal provider key/engine namespace, **not**
   to the user's session ID or memory owner. Record its canonical conversation
   mapping and old-generation provenance; never erase old mode-2 cache/state.
2. Bootstrap only from gateway **originals**, with stable native MID/ordinal
   sidecars and M1 raw provenance, not old tag-rendered CK arrays or opaque
   m0/m1 prefixes. Declare/admit the CC plan, record setup, admit bounded
   contiguous pages, and freeze each eligible subject's outcome once. Bind
   any native cut/descent to actual available history; missing originals
   refuse `history_unreadable`, not an invented complete transcript.
3. Persist a resumable bootstrap receipt with generation, lineage, source
   frontier/count/digest, selected profile/epoch bundle and applied initial
   view. Return an explicit `bootstrap_complete` receipt only after full
   admission and safe view validation. Gateway publication remains fenced
   until it records this receipt; a lost reply resumes the same generation,
   not a second tagging pass. Setup ready or a noop alone is insufficient.
4. Keep durable memories and their IDs/project/agent ownership in place;
   compose the new head by reading them through the canonical mapping. Old
   history summaries may remain durable memories, but their old CK boundary
   or rendered head is not silently treated as admitted native source. Resolve
   guidance, historian scope, reductions, notices and acknowledgements through
   the same mapping. Do not duplicate memory creation or replay old reductions
   as new commands. Keep old state readable for operator rollback, which must
   recognize/refuse new-generation cuts rather than ingest them as originals.

This proposal needs **one additive MC-store migration**: generation-aware
conversation identity/uniqueness plus canonical mapping/receipt metadata,
with existing rows classified as legacy. Today's schema has a unique triple
and all dependent transcript/view rows use its `conv_key`
(`crates/mc-store/src/migrations/store_066_provider_log.sql:3-46,80-90`), so
parallel profile generations cannot safely be squeezed into the current key.
Update the key-derived indices/fences and per-generation locks together;
keep the canonical session component intact. Raw message bytes already have
BLOB storage, and immutable views already have JSON storage
(`crates/mc-store/src/provider_log.rs:75-80,1349-1371`), so raw provenance and
view retrieval do not require separate tables. If oversized-message parity
is part of the release, include M3's additive chunk-staging rows in the
migration set. No durable memory rewrite, destructive backfill, live-store
experiment, or `state_import` of old CK as new native identity is required.

## October 13 agreement and October 15–16 canary

Treat the October 13 milestone as a **paired, versioned contract agreement**,
not approval based on a list of method names. It must name the admitted
principal/profile, signed-byte provenance format, exact cut coordinate,
large-frame limits and retrieval protocol, geometry and cache-policy fields,
notice/reduction acknowledgements, terminal refusal mapping, and bootstrap
namespace. Do not assign invented epoch values before the paired CC gateway/MC
release establishes them.

The canary is conditional on implementation and conformance, not on this
report. Before October 15, require:

1. Real bound CC calls and negative principal/session/project/subagent tests;
   a cold bootstrap, restart, and rollback recognition test.
2. Exact-boundary/no-snap and frozen-view replay tests, including oversized
   ingress and replacement, missing/incorrect page hashes, partial hook entries,
   tool arcs, and signed/redacted blocks.
3. Golden raw-byte tests for noncanonical signed JSON and edits adjacent to it;
   an edit-before-kept-signed-thinking control must fail closed or suppress the
   edit. Unchanged raw block bytes alone are not proof of a valid signed prefix.
4. Geometry, output-reserve, response-attributed fill, native continuation and
   TTL-expiry controls, proving that the parent agent and each spawned subagent
   use independent conversation state.
5. Full/no-reduce guidance, exactly-once reduction, notice dispatch/restart,
   and a terminal protected-tail refusal with zero raw retries.
6. Publication WAL crash points before/after MC commit, view install and actual
   dispatch, plus admissible last-good and unsafe-fallback controls.

Measure adjacent chronological **actual forwarded request bytes**: unchanged
cacheable prefix lengths, marker positions/TTL, provider cache-read/write/input
usage and paid cost. Also measure latency by warm/bootstrap/compaction cohort
and refusal counts. The 24-hour
October 15–16 canary must exercise a real CC hook replacement and a protected-tail
refusal (or leave those gates open); a quiet canary is not compaction evidence.
If a required agreement or gate slips, extend mode-2 retirement rather than
snap a cut, flatten signed blocks, or raw-forward a managed refused request.
