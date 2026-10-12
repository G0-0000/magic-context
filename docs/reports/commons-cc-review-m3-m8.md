# Commons Claude Code step-lane review: M3, M8 and admission

## Scope and disposition

Reviewed commons **`45b09aaff555948040458119b218212ed91d317b`** from the supplied
`commons-45b09aa.tar.gz` and its single-commit patch. This is not a revision in
Magic Context's Git repository. All commons citations below are **postimage
file:line coordinates in that archive**, not coordinates in commons master.
`CP` abbreviates `crates/cortexkit-role-compaction-provider`; `ST` abbreviates
`crates/cortexkit-role-step-transform-provider`. MC requirements are from
`docs/designs/cc-step-contract-answers.md` in this task's Magic Context (MC)
worktree. `MC answers:<lines>` cites line numbers in that document. `CC` means
Claude Code; native CC traffic means raw Anthropic-schema messages on the
attested, declared Claude Code step lane.

**Disposition: the additive wire work is useful and backward-compatible, but
it is not yet sufficient to close M3/M8 for MC's native step attachment and
mode-2 bootstrap.** Two missing wire agreements and three concrete defects are
listed below. Passing serde/helper tests do not establish a native codec,
durable bootstrap, signed-prefix safety, or daemon admission integration.

| Item | Classification | Result |
| --- | --- | --- |
| Exact `{message_id, part_index}` endpoint and inclusive/partial semantics | Correct and sufficient | Original top-level index, scalar part zero, retained remainder and structural non-application are defined. |
| Frozen replacement bytes/reference, SHA-256 and cut/head mapping | Correct and sufficient | Raw string bytes and immutable identity are represented; a hook head is distinguished from the role replacement. |
| Native ingress/hook `raw_message` provenance | **Gap G1** | Neither message type carries the raw JSON sidecar; removal of transport-level `cache_control` is not specified. |
| Digest/version-bound optional view paging | Correct and sufficient | Typed mismatch refusals, digest-echoing pages, UTF-8 byte cursors and no latest-view substitution. |
| Reference payload when view retrieval is not selected | **Defect D1** | An accepted reference can be unreadable on its own declared lane. |
| Declared payload caps and oversized-message refusal | Correct and sufficient | Strict envelope bounds, named refusal, no oversized-first-message exception on the selected lane. |
| Capability data in describe/declare/setup; identifier grammar and generations | Correct and sufficient | Optional outer bundle, data-field epochs/generations, immutable selection helpers. |
| Complete render-epoch inventory at admission | **Defect D2** | Validation admits a bundle lacking tagger, memory and compartment epochs. |
| Mode-2 bootstrap completion receipt | **Gap G2** | A format name and prose are not a wire receipt or an explicit completion result. |
| Canonical conversation identity versus generation-specific state | **Defect D3** | The expanded host-admission text still unconditionally says the conversation key is the old triple. |
| `ClaudeCodeLane::admit` two-input gate and connection freeze | Correct and sufficient for that gate | Does not authenticate or implement the surrounding advertised-bundle/bound-conversation admission checks. |
| Legacy decode/serialization, Broca and OpenCode absence behavior | Correct and sufficient | Added outer fields default/omit; existing discriminants, required ops and old host opt-ins remain intact. |
| Existing vectors and new vector/type correspondence | Correct and sufficient | No existing vector/checksum payload is changed by the patch; new fragments round-trip in the role suites. |

## Findings requiring correction

### G1 — Gap: inbound raw provenance is missing (release-blocking for native signed traffic)

**Evidence:** `CP/src/status.rs:45-54` defines `StatusMessage` as only
`ordinal`, `mid`, and parsed `message: Value`. `ST/src/hook.rs:47-104` contains
parsed `message: Option<Value>` at lines 68-76 but no `raw_message`. The archive
has no `raw_message` field in either role. The new size checks serialize those
parsed values (`CP/src/status.rs:390-405`; `ST/src/hook.rs:119-134`).
`CP/src/view.rs:23-30` preserves *output replacement* strings; it does not supply
original-message provenance on ingress.

MC requires a UTF-8 JSON `raw_message` sidecar alongside parsed admission and
hook messages, preserving original order/escapes/scalar form and signed-block
slices, with only agreed transport-level `cache_control` removal
(MC answers:94-107,124-131). A parsed `Value` cannot reconstruct those bytes.
An unknown sidecar sent today would be ignored, not retained by these types.
The empty-ingress and simple-head CC vectors do not exercise this requirement
(`test-vectors/compaction-provider-v1/claude-code.json:5,20-27`).

**Suggested correction:** add optional-on-wire `raw_message: Option<String>`
with `default`/`skip_serializing_if` to both `StatusMessage` and `HookCall`.
Require it only for admitted native CC messages/hook subjects; refuse missing
or mismatched provenance with `invalid_params` naming `raw_message`. Specify
parsed/raw equality after removal at recognized transport-marker locations,
never recursive removal from tool input or opaque data, and preservation of
all other raw bytes. Include sidecar escaping/overhead in single-message and
full-envelope accounting. Add noncanonical order/escapes, scalar content,
signed/redacted blocks and nested `cache_control` examples, not just parsed
JSON equality tests. MC's codec/store still owns raw-span validation and safe
splicing; no product implementation is requested in this review.

### D1 — Defect: a reference can pass publication validation without a readable capability

**Evidence:** `RawPayload::Reference` is accepted when its `ViewRef` equals the
outer frozen identity (`CP/src/view.rs:90-94`).
`StepAnswer::validate_claude_code` checks identity/profile/generation/coverage
but never checks the payload kind against `bundle.raw_view_read`
(`CP/src/answer.rs:262-284`). Conversely `read_frozen_view` requires that flag
and otherwise refuses `unavailable_lane` (`CP/src/view.rs:148-152`).
The `ClaudeCodeCapabilities` bundle may legitimately declare `raw_view_read=false`
(`ST/src/claude_code.rs:62,74-118`). Thus changing a valid inline fixture to a
matching reference and selecting `raw_view_read=false` leaves publication
validation successful while retrieval is unavailable.

The contract calls the reference an immutable locator served by view reading
(`CP/CONTRACT.md:933-940`) but also says reading MUST NOT be a prerequisite to
applying an answer (`:963-966`). For a CC consumer that needs byte-exact raw
replacement bytes, a parsed `replacement` is not an equivalent fallback.

**Suggested correction:** forbid a reference on a lane that has not selected
a supported immutable retrieval capability; use inline bytes there. Specify
that a selected reference must remain resolvable in the frozen connection,
generation and lineage, including a hook's `cut_replacement_ref`. Clarify the
optional-reading rule: a consumer can skip reading when it already has verified
bytes, and legacy
inline replacements need no new operation, but it must not re-encode parsed
messages to substitute for unavailable raw bytes. Add a negative test for a
reference with `raw_view_read=false`, plus unavailable referenced-head cases.

### D2 — Defect: admission accepts an incomplete rendering epoch bundle

**Evidence:** `ST/CONTRACT.md:725-733` says the epochs include rendering's
tagger, memory and compartment epochs. The fixture carries all six named
epochs (`test-vectors/step-transform-provider-v1/claude-code.json:13`).
However `ClaudeCodeCapabilities::validate` requires only `codec`,
`raw_provenance`, and `render` (`ST/src/claude_code.rs:88-90`);
`ClaudeCodeLane::admit` relies on that validation (`:135-140`). Removing
`tagger`, `memory`, and `compartment` therefore still passes the helper's
admission check. The presence of those keys in a happy-path vector does not
defend their required inventory.

MC distinguishes profile/render, active tagger, memory and compartment epochs
from new codec/raw-provenance epochs (MC answers:549-554,577-584). A single
`render` number is not a defined aggregate replacing those component pins.

**Suggested correction:** require `memory` and `compartment`, and specify and
enforce how the tagger epoch is supplied when tagging is active (or require
all three keys for this bundle version). Alternatively define an explicit
aggregate-render epoch contract covering these components, rather than
silently treating `render` as one. Test removal of each required key. The
actual supported epoch values must still be checked against provider discovery;
synthetic fixture values must not become release pins.

### G2 — Gap: a bootstrap format identifier does not transport completion evidence

**Evidence:** the only wire member is
`ClaudeCodeCapabilities.bootstrap_receipt_format: String`
(`ST/src/claude_code.rs:68`), validated only as an identifier (`:82`).
`ST/CONTRACT.md:734-738` describes the receipt contents and a publication fence,
but no receipt shape, response location, resume request or explicit
`bootstrap_complete` result is defined. `CP/src/setup.rs:238-265` still returns
only ready/initial configuration or refusal; `CP/src/answer.rs:178-228` has no
bootstrap receipt member. A notice `DispatchReceipt` concerns provider dispatch,
not full original-source admission or bootstrap completion
(`CP/CONTRACT.md:1025-1031`).

MC requires a durable resumable receipt containing generation, lineage, source
frontier/count/digest, selected profile/epoch bundle and safely applied initial
view, and an explicit completion receipt before publication is unfenced
(MC answers:598-609). Naming `native-bootstrap-receipt/v1` in discovery does
not let MC and the gateway exchange that evidence. This is a missing wire
agreement, not a demand that a pure serde crate implement MC's store migration.

**Suggested correction:** define that named receipt schema and its agreed
transport location. For example, add an optional typed bootstrap-completion
receipt to the final ingress answer, with a generation/lineage-scoped resume
identity and exact source frontier/count/digest, frozen selected bundle and
initial-view identity. Define when it may first be returned, persistence before
reply, identical replay after a lost reply, rejection of conflicting source or
generation, and the gateway's durable refusal to send native managed traffic
until it records the completed receipt. A bare ready/noop or `more=false`
remains insufficient. Add lost-reply/resume and missing-original
vectors and ensure all new fields remain absent for legacy callers.

### D3 — Defect: the expanded CC host lane still pins generation-blind conversation identity

**Evidence:** after explicitly adding the attested CC pair, both contracts
still say **“The conversation key remains the §1 triple”**
(`CP/CONTRACT.md:683-692`; `ST/CONTRACT.md:537-546`). The referenced §1 rules
explicitly include every piece of per-session state under that triple
(`CP/CONTRACT.md:60-64`; `ST/CONTRACT.md:59-63`). The new bundle separately
carries `profile_generation` and `provider_generation`
(`ST/src/claude_code.rs:51-53`), and later prose says generation-aware identity
belongs to the provider/gateway (`CP/CONTRACT.md:914-922`). The unqualified old
key statement is ambiguous/contradictory for precisely the newly admitted pair.

MC must retain canonical project/session/agent ownership while allocating a
fresh profile-specific ledger/cursor/view/tag/publication generation, rather
than colliding with old mode-2 bytes at the same MID/ordinal
(MC answers:556-568,590-597,619-628). Generations are not session-ID suffixes.

**Suggested correction:** qualify the old triple rule as canonical external
conversation identity and legacy-lane behavior. State explicitly that CC
provider state, uniqueness, engine namespace, locks, MID/ordinal ledgers,
views/cursors and receipts are additionally scoped by the selected provider
and profile generation, while retaining canonical project/session/agent and
memory ownership. Define the old-generation provenance/canonical mapping and
same-generation bootstrap resumption rule. The additive persistence migration
is MC work; commons needs an unambiguous identity contract, not that migration.

## Correct and sufficient portions (and integration boundaries)

### M3 endpoint, frozen view and paging

- **Exact endpoint and cut semantics — correct and sufficient.**
  `CP/src/view.rs:7-13` makes the endpoint a typed pair, not a flattened MID
  suffix or opaque hook part. `CP/CONTRACT.md:926-932` explicitly makes the
  original top-level part index zero-based and inclusive, preserves scalar
  form, and retains subsequent parts. Lines 953-959 require the selected
  partial-cut capability and fence unknown parts/digest conflicts/unsafe runs;
  an unrepresentable cut records `last_not_applied.reason=structural`, with no
  earlier snapping or remainder loss. This matches MC answers:250-257,294-303.
  The original-part map and run fences are provider/codec responsibilities
  (`CP/CONTRACT.md:943-944`), not established by serde alone. **Correction: none.**
- **Frozen bytes, identity and native-cut mapping — correct and sufficient as
  a representation.** `CP/src/view.rs:15-54` binds ID/version/byte length/digest,
  profile and generations, lineage, endpoint and inline/reference payload.
  Strings preserve their decoded UTF-8 bytes without parsing the inner JSON.
  Hashing checks that exact byte string (`:56-66,90-94`), and
  `CP/CONTRACT.md:933-952` defines immutable metadata, decoded-byte digest scope,
  role `[from,to)` replacement versus a separate hook head, and retained-tail
  engine handles. Both mapping fields must be supplied together
  (`CP/src/view.rs:78-88`). Answer validation cross-checks version,
  profile/generations and coverage (`CP/src/answer.rs:268-282`). The gateway
  declines a cut without the mapping, rather than inferring m0/m1. **Correction:
  none to this representation; G1 and D1 remain necessary end-to-end fixes.**
- **Optional, frozen-version paging — correct and sufficient.** The operation
  is not added to required discovery ops (`CP/src/lib.rs:63-88`).
  `ViewReadRequest` names view/version/digest/byte cursor
  (`CP/src/view.rs:98-105`); pages echo total length and whole-view digest via
  flattened `ViewRef` (`:118-134`). The reader rejects unknown version, mismatched
  requested/stored digest, invalid UTF-8 cursor and unavailable lane
  (`:148-170`), slices without splitting a character, and shrinks pages for
  JSON escaping overhead (`:172-203`). There is no latest-view fallback.
  Connection/generation/lineage-scoped lookup is normative
  (`CP/CONTRACT.md:967-982`) and explicitly a precondition of the helper
  (`CP/src/view.rs:136-138`); it must be implemented in the provider store.
  Errors returned by the helper must be converted to the typed refusal reply
  with the original request ID. **Correction: none to paging identity/refusal
  semantics; fix D1's capability inconsistency.**
- **Caps and oversized ingress — correct and sufficient for the bounded
  canary, not large-message parity.** `ST/src/claude_code.rs:34-42,105-113`
  supplies positive ingress/hook/single-message/page caps. Declared ingress
  and hook *ceilings* may equal 3 MiB; accepted encoded envelopes must be
  strictly smaller. The fixture uses 3 MiB ceilings, 1 MiB single-message and
  1 KiB raw pages (`test-vectors/step-transform-provider-v1/claude-code.json:16`).
  Status/hook checks count the op envelope and refuse `invalid_params` naming
  `messages`/`message` (`CP/src/status.rs:390-405`; `ST/src/hook.rs:119-134`).
  Page replies count escaped bytes (`CP/src/view.rs:178-203`).
  `CP/CONTRACT.md:983-991` and `ST/CONTRACT.md:766-780` name host-terminal
  `provider_message_too_large`, prohibit truncation/raw-forwarding and reject
  the ordinary oversized-first-message allowance. The host classification
  is not a new wire refusal discriminant. Missing ingress chunking is
  explicitly unnegotiated; view paging alone cannot bootstrap oversized
  originals (MC answers:272-292). **Correction: none to these bounds/refusal
  rules; G1 requires the missing sidecar to be counted as well.**

### M8 bundle and `ClaudeCodeLane::admit`

- **Discovery/declaration data and identifier names — correct and sufficient
  as metadata.** Both `RoleDescribe` types contain optional typed `claude_code`
  (`CP/src/describe.rs:52-55`; `ST/src/describe.rs:52-55`). The declare request
  and answer carry it (`ST/src/subscription.rs:340-343,390-398`) and Setup
  receives the same selection (`CP/src/setup.rs:63-67`). The bundle contains
  principal/harness/profile/observation, revision/package/wire pins, epochs,
  endpoint/partial policy, caps, retrieval/digest, cache revision,
  reduce/guidance/notice flags and generations
  (`ST/src/claude_code.rs:47-70`). The exact identifier is
  `claude-code-step/v1` (`:12`); the grammar implementation checks lowercase
  kebab names, length, positive non-zero-padded u32 version and no whitespace
  (`:175-202`). Generations/epochs are fields, not name suffixes.
  **Correction: none to those names/fields; D2/G2/D3 limit bundle completeness.**
- **Two-input admission — correct and sufficient for its documented gate.**
  `ST/src/claude_code.rs:130-145` rejects any selected bundle unless the
  transport-supplied principal is exactly `reserved:thalamus`, returning
  `invalid_params`/`claude_code` (`:17-31,135-139`). Attested-but-undeclared and
  ordinary undeclared calls produce an inactive lane. The owned selection is
  private (`:124-127`), is connection-checked by `selected_for` (`:149-160`),
  and exact whole-bundle equality is checked by `check_frozen` (`:164-172`).
  `DeclareRequest::admit_claude_code` clones the selection, not a borrowed
  mutable request (`ST/src/subscription.rs:367-376`). The tests cover wrong
  principal/connection, selection drift and attempted activation of a legacy
  lane (`ST/tests/claude_code.rs:46-107`). **Correction: none to this gate.**
- **Admission integration is not supplied by `admit`.** Its string arguments
  are not authentication proofs; the API expressly requires trusted transport
  inputs (`ST/src/claude_code.rs:1-4,121-122`). The bundle's profile is only
  checked for non-emptiness and epoch/version pins for basic inventory
  (`:86-104`). There is no advertised-bundle argument or bound project/session/
  agent input. This is not evidence that arbitrary caller pins or profiles are
  supported. `ST/CONTRACT.md:710-724` already requires the resolved bind,
  supported advertised selection, unchanged declaration/setup echo, and
  provider checks of conversation/profile/observation. MC must perform those
  checks before constructing the lane, retain that single lane for the
  connection, and call `check_frozen` on Setup/re-declaration; recreating a lane
  per call would defeat freezing. These are explicit integration obligations,
  not a body-supplied authentication bypass proved by this patch. **Correction:
  none to the documented division of responsibility; do not present the
  helper's successful return as the entire attach/bootstrap gate.**

## Backward compatibility: 0.2.0 packages, wire stays v1

**Classification: correct and sufficient for today's wire payloads.**

| Extended wire type | Archive evidence | Legacy decode/serialization |
| --- | --- | --- |
| CP and ST `RoleDescribe.claude_code` | `CP/src/describe.rs:52-55`; `ST/src/describe.rs:52-55` | `default`, `Option`, omitted on `None`; old capabilities and runner groups retain their previous serialization policy. |
| `DeclareRequest.claude_code`, `Declaration.claude_code` | `ST/src/subscription.rs:342-343,397-398` | `default`, omitted on `None`; old declarations need no new member. |
| `SetupRequest.claude_code` | `CP/src/setup.rs:65-67` | `default`, omitted on `None`; existing Setup fields are unchanged. |
| `Coverage.endpoint`, `CompactionMessage.raw_view` | `CP/src/answer.rs:20-21,100-101` | `default`, omitted on `None`; today's parsed replacements/coverage decode unchanged. |
| `StepAnswer` notice members | `CP/src/answer.rs:181-196` | Both applicable variants default/omit the new option; no existing answer discriminant changes. |
| `StepStatus` geometry/reserve/continuation/fill/notice fields | `CP/src/status.rs:269-280` | Every new member is `default`/optional/omitted when absent; `Some(false)` is still an explicit `mid_turn=false`. |
| `HookCall` | `ST/src/hook.rs:47-104,106-137` | No new required field; the new validator is separate from shape decoding and returns immediately on an unselected lane. |
| New `FrozenView`, raw payload and view-read types | `CP/src/view.rs:15-54,98-134` | These are new optional-extension payloads, not extra required fields on old objects; nested required fields apply only when the extension is present. |

No extended legacy object gains `deny_unknown_fields`. Existing strict
answer/hook/phase discriminants retain their meaning. An old reader can ignore
new members; that establishes legacy absence compatibility, not permission to
attach native CC to an old provider. Required native capabilities must still be
negotiated before traffic. Selecting an incomplete/malformed new bundle may
refuse, without making the old absent bundle invalid.

Both package manifests declare 0.2.0 (`CP/Cargo.toml:14`; `ST/Cargo.toml:15`),
while `CP/src/lib.rs:53-60` and `ST/src/lib.rs:57-64` retain the v1 role names.
The minor bump properly acknowledges Rust source breakage from fields on
previously exhaustive `CompactionMessage`, `StepAnswer` and `Declaration`
shapes (`CP/CHANGELOG.md:3-9`; `ST/CHANGELOG.md:3-7`); it is not a wire-major bump.
The conformance consumer updates its compaction-role dependency from 0.1.2 to
0.2.0 (`crates/cortexkit-role-llm-runner-conformance/Cargo.toml:23`), so its
source builds with the new answer fields.

Absence remains today's Broca/OpenCode behavior: lane validators immediately
return for no selected bundle (`CP/src/status.rs:374-376`;
`ST/src/hook.rs:116-118`; `CP/src/answer.rs:259-261`). Required runner groups are
not globally emptied. Direct OpenCode still requires its own attested direct
bind and `opencode-aisdk`/answer opt-ins (`CP/CONTRACT.md:683-718`;
`ST/CONTRACT.md:537-574`). A `channel2_directive` notice is explicitly forbidden
without the attested, declared lane; that does not change any old payload in
which the new notice field is absent.

## Vectors, test results and limits of evidence

**Vector/type correspondence — correct and sufficient.** The new CP fixture
covers the endpoint/raw view, page and typed refusals; the ST fixture's bundle
is deliberately combined with describe/declare fragments by the test, not
claimed to be a complete standalone describe response
(`ST/tests/claude_code.rs:27-41`; vector README:42-48). The CP raw head has
34 decoded bytes and the stated SHA-256, checked independently against a
literal digest (`CP/tests/claude_code.rs:141-160`). Synthetic epochs and pins
are labelled synthetic, not claims about a released MC codec
(`CP` vector README:51-57; `ST` vector README:42-48). No vector/type mismatch
was found. These vectors omit raw native ingress, bootstrap receipts and
missing-component-epoch rejection; their successful round trips do not close
the missing raw-ingress provenance, bootstrap completion receipt or complete
epoch-admission checks.

**Existing vector bytes — correct and sufficient against the supplied patch.**
Its 30-file change list adds only the two new JSON fixtures and their separate
`CLAUDE_CODE_SHA256SUMS`; it changes the two top-level vector READMEs, but no
existing JSON vector or existing `joint/SHA256SUMS`/joint fixture file. The
legacy byte assertions are retained; two old Rust variant literals merely
receive absent optional notice fields. The hash checks below also confirm the
three existing joint-fixture files against the unchanged manifest. This
comparison uses the supplied complete single-commit patch, not a checkout of
its parent or an independently fetched commons Git history.

### Executed verification

The archive was extracted locally under `$TMPDIR/commons-45b09aa/` for review.
For Linux execution the remote command started inside the Magic Context task worktree,
extracted the same attached archive into the remote `$TMPDIR`, then ran Cargo
there. The gitignored archive was temporarily staged solely to make it visible
in the runner snapshot, then unstaged; it is not part of the report commit.

- **Linux, 4 vCPUs:** `rustc --version` →
  `rustc 1.99.0 (b940084d7 2026-09-28)`;
  `cargo --version` → `cargo 1.99.0 (5f94df478 2026-08-27)`.
- **`cargo test --locked -p cortexkit-role-compaction-provider -p cortexkit-role-step-transform-provider` — passed:**
  114 tests across 10 nonempty test targets, zero failures/ignored; two empty
  doc-test targets. Includes the old byte/host-lane suites and new 18 CP/7 ST
  Claude Code tests. Relevant names include
  `view_read_pages_echo_frozen_identity`, `view_read_refuses_digest_mismatch`,
  `oversized_single_message_refuses_by_name_without_truncation`,
  `attested_and_declared_applies_and_freezes_connection_bundle`,
  `declared_without_attestation_refuses_by_name`,
  `legacy_step_bytes_unchanged`, `legacy_hook_bytes_unchanged`, and
  `absent_answer_fields_preserve_legacy_bytes`.
- **`cargo test --locked` on the complete extracted workspace — passed:**
  100 test/doc-test targets, 1,145 passed, zero failed, four ignored, exit 0.
  Counts are aggregated from all raw `test result` lines, not the truncated
  display. This does not assert live daemon/gateway/MC-store conformance.
- **`shasum --version` → `6.02`; `shasum -a 256 -c` — passed:**
  run from each manifest directory for CP and ST `CLAUDE_CODE_SHA256SUMS` and
  CP `joint/SHA256SUMS`; five files checked, all OK.

Initial remote attempts were not test failures: running with the local
extraction as remote cwd was refused (outside the workspace), a visibility
probe hit the shared permit queue, and the first worktree-cwd extraction lacked
the ignored archive. Staging the input resolved transport; both actual Cargo
runs completed on Linux. A first checksum command used the wrong manifest cwd;
the corrected directory-scoped run checked all five files successfully.
No local Cargo fallback was used.

This is a report-only change. No product code, manifests, architecture or
structure documents are changed by the MC delivery. No mutation proof or
live canary is claimed; the findings above are source/contract comparisons,
not newly installed runtime guards. The provided worktree-preparation build
is not used as evidence for commons or native signed-thinking safety.
