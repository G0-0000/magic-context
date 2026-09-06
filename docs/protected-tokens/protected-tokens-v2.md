# protected_tokens replaces protected_tags — design v2 (2026-09-06)

v1 → v2 folds the Athena design review (ct_00000000-0000-4009-98d2-8efe431fbd98, 3 seats, unanimous AMEND). Every v1 claim the panel refuted at source is corrected here with the cite. Origin: GitHub #426 (tenshiak). Ruling (Ufuk): full migration to a token-mass protection window, no hybrid.

## 1. What "protected" means (corrected)

Protection excludes a tag from MC's AUTOMATIC reclaim lanes: age sweep (`tool_reclaim_watermark`), `smart_drops` supersession/spent-control-plane lanes, and emergency drop planning. It never drops anything by itself; a tag outside the window is served verbatim until a reclaim lands on a cache-busting pass under `pressure_execute`.

`ctx_reduce` interaction, as shipped (v1 mis-stated this): a queued drop on a PROTECTED tag is deferred until the tag exits the window — `applyPendingOperations` skips any pending op on a protected tag (apply-operations.ts:104–113) and the tool's own acknowledgement computes immediate-vs-deferred from the same set (tools/ctx-reduce/tools.ts:152–157, 221–231; Pi context-handler.ts:1111–1122). This is intentional (a blind drop of the working set is held one window, not lost) and stays. Consequence of the migration, stated: under a 16k–64k mass window an explicit drop of a recent large read is deferred longer than under 20 tags. The tool's reply already says "queued, held"; the wording gains the reason ("inside the protected window; applies once older work displaces it").

Independent protections unchanged: open arcs, the newest message, the K=3 `ctx_reduce` exemplars, reasoning-adjacent skeleton pairs, the historian protected-tail boundary (protected-tail-boundary.ts:226–252, 620–782 never reads the reclaim window; stays independent).

## 2. The window (corrected)

Ordering key: `tag_number ASC, id ASC` — the order every shipped reclaim query already uses (storage-tags.ts:337–346, 381–385; getRecentTagOwnerMessageIds pages descending persisted tag order, :154–194; emergency anchors on maxTag, heuristic-cleanup.ts:82–89). Not `created_at`: lazy adoption of NULL-owner legacy rows can bind an old low tag_number to a new owner (tagger.ts:596–623), so invocation order and tag_number order diverge on migrated sessions, and tag_number is the order the lanes agree on.

Walk population: ALL persisted `tool` tag rows of the session, newest→oldest by tag_number, INCLUDING dropped / compacted / `edit_marker` rows, each counted at its persisted `token_count`. This is what keeps the window monotone: a 30k read compressed to a 200-byte `edit_marker` keeps occupying window budget, so the window never re-expands to re-protect (and re-render hints for) older tags. Cost, accepted: dead mass crowds the window after heavy reclaim, erring toward more reclaim — the structural minimum (§2.1) bounds that. (The panel split 2–1 on this; the deciding fact is §3: window membership feeds rendered hint bytes, so any non-monotone window is a defer-pass bust source.)

Mass semantics (corrected — v1 said "computed once at insert", which is false): `token_count` is mutated after insert in two ways — `updateTagTokenCount` bumps it when a later occurrence of the same call_id carries a larger output (storage-tags.ts:542–549), and `backfillToolTokensIfNull` fills NULL counts after insert (tagger.ts:583, 604, 615). Both mutations only GROW mass, so the window can only contract between two passes over the same rows, never expand → no-re-entry holds under mutation. NULL rows: counted as 0 mass for the walk (a NULL cannot displace anything; it is protected only if it falls inside the window by position, which the newest-3 minimum guarantees for the newest ones) — same treatment the hint value-floor gives legacy rows (storage-tags.ts:322–328).

Stop rule: protecting continues while accumulated mass < `floor`; the first arc that crosses the floor is still protected (inclusive), everything older is eligible.

### 2.1 Structural minimum
The newest 3 completed tool arcs are always protected regardless of mass (bounded, deterministic; "newest user turn's arcs" was rejected as unbounded — a 50-arc turn would be fully protected). Open arcs and the live prompt are covered by the in-flight fences and the boundary's newest-meaningful-user floor (protected-tail-boundary.ts:694–707).

## 3. Sizing and the floor snapshot (corrected)

`floor = protected_tokens` when set (absolute, user tier; project tier raise-only), else derived: `clamp(round(0.05 × usableSoft), min(16_000, round(0.08 × usableSoft)), 64_000)`. The relative lower bound removes v1's hidden ≥200k assumption (16k was 16% of a 100k window). Table: 100k→8k, 200k→16k, 372k→18.6k, 872k→43.6k, 1M→50k.

Self-caused-bust hazard (v1 claimed none; refuted): the window feeds Channel-1 "oldest reclaimable" hint selection (getOldestActiveUnprotectedToolTags takes the protection input, storage-tags.ts:306–365), and hints are RENDERED into served content. `usableSoft` can move mid-session without a model change — `output_reserve` edits (window-geometry.ts:498–527) and FUSIFORM overlay reloads (:449–494), both loaded at config time (config/index.ts:688–689) with no HARD epoch — so a per-pass recomputed floor would change hint bytes on a defer pass. Rule: the effective floor is SNAPSHOTTED per session at the last cache-busting pass (`session_meta.protected_tokens_effective`, written on execute/HARD/flush passes only) and every consumer (lanes, hints, hygiene `U`) reads the snapshot; a geometry or config change takes effect on the next priced pass. Log the resolved floor with provenance (`absolute|derived`, the usableSoft used) when the snapshot changes.

## 4. ≥95% yield (#423 parity)

At ≥95% the token window and the newest-3 minimum yield exactly as the count window does today (protectedCutoff = maxTag, reserveCount = 0, emergency-drop.ts:208–228; the #423 fixture is the reference); only open arcs, K=3 exemplars and reasoning-adjacent skeleton pairs remain. Below 95%, if the window covers every droppable arc, `planEmergencyDrop` returns `noop('no-candidates')` without consuming the episode latch (emergency-drop.ts:266–270) — degrade, not deadlock; the 95% backstop is behind it. At a 200k window the 16k floor + newest-3 protect ~8% of usableSoft: not a starvation source.

## 5. Config cutover (clean; inventory corrected)

- New key `protected_tokens?: number` (1_000 ≤ n ≤ 1_000_000), user tier + project tier (project raise-only vs the effective user value).
- `protected_tags` → deprecated: parsed so loading never fails, IGNORED for behaviour, loud warning on every #421 surface (OpenCode banner, Pi notice, /ctx-status first line, dashboard, doctor). No numeric conversion.
- The config-LOCATION migration (`migrate-config-loc…`) copies file bytes verbatim, so the dead key propagates into fresh configs and the warning would fire forever: the location migration strips `protected_tags` (with a one-line notice) — the only migration that rewrites the key.
- Reader inventory to convert (all must read the snapshot/floor, none the count): schema + default transform (config/schema/magic-context.ts:874, 1156–1163, 1462–1471), `DEFAULT_PROTECTED_TAGS` (defaults.ts:1), create-session-hooks defaulting (:29–34), tool-registry → createCtxReduceTools (:136–140), ctx-reduce protectedSet acknowledgement (tools/ctx-reduce/tools.ts:152–157, 221–231), rpc-handlers `protectedTagCount` status field (:843–845) → becomes `protectedTokens{floor, protectedCount, protectedMass}`, rust-mode-transform wire sites (:1441, 2220), Pi index threading (pi-plugin/src/index.ts:739, 1120, 1317–1319, 1438, 1459), Pi ctx_reduce tool options (pi-plugin/src/tools/index.ts:66–70), Pi hygiene (tail-hygiene-walk-pi.ts:648–652), Rust `TransformRequest` wire default 20 (transform.rs:676–678, 895–897, 915–916), Rust tail_hygiene protected_tag_numbers (tail_hygiene.rs:445–457, 541–546), Rust `protected_cutoff_ordinal` (selection.rs:1154) and `tag_window_protected_block_ids` (selection.rs:1392–1393), dashboard coverage list (config-field-coverage.ts:33), docs generator (build-config-docs.ts:131), schema tests (magic-context.test.ts:670–681), CONFIGURATION.md/README/docs site, setup wizard.
- Pi has NO existing token-based protection (v1 repeated tenshiak's claim; the panel could not locate it — Pi consumes a count at tail-hygiene-walk-pi.ts:650–652 and context-handler.ts:1110–1123). Pi simply adopts the shared rule.

## 6. Three legs, resolved artifacts (corrected)

The window is a derived MEMBERSHIP, not a scalar, and the Rust module has three consumers needing three forms: an ordinal cutoff (`select_emergency`, selection.rs:1154), a block-id set (`tag_window_protected_block_ids`, :1392–1393) and a tag-number set (tail_hygiene.rs:445–457). Rule: each leg derives membership from ITS OWN persisted tag rows with the shared algorithm (§2) — TS from `tags`, Rust from `mc_tags` (which carries per-tag token counts and is authoritative for tags in rust mode) — and the host sends only the resolved floor scalar (`protected_tokens_effective`, the §3 snapshot) the way it sends `effective_execute_threshold`; the module resolves the floor itself only on hostless legs (Claude Code), from the same config forms TS reads (object/scalar parity — see the 2026-09-06 execute_threshold bug). Rust then produces its three forms from one walk. Shared TS core (`@magic-context/core`) holds the walk for OpenCode + Pi. Differential goldens: same fixture rows → identical membership on TS and Rust.

## 7. Channel-1 / hygiene (corrected claim)

The `U` exclusion switches from the tag set to the token-window set at the three symmetric sites (tail-hygiene-walk.ts:317–329, tail_hygiene.rs:445–457, tail-hygiene-walk-pi.ts:648–652). Users WILL notice on edit-heavy sessions: excluded mass grows from ~5k to the floor, so `U` drops and nudge bands quieten — intended, and stated in the release notes. Compliance grace is unaffected (baseline and pre_level carried verbatim across refresh, tail_hygiene.rs:755–759; Pi :717).

## 8. Tests (red-first, each leg)

- window: 20 tiny edits (5k) → window extends to the floor; one 40k read → newest-3 holds; monotonicity under an upward token_count bump and under a NULL backfill (window contracts or holds, never re-expands); dropped/edit_marker rows counted at original mass (no re-entry after compression); NULL rows = 0 mass.
- ordering: tag_number order with a lazily-adopted legacy row (tagger.ts:596–623 shape) — walk matches the lanes' order.
- snapshot: output_reserve edit and overlay reload mid-session → floor unchanged on defer passes (hint bytes identical), changes on the next priced pass.
- yield at ≥95% (#423 token variant), no-candidates no-op at 94%.
- ctx_reduce: drop on a protected tag is deferred and acknowledged as held; applies when the tag exits the window.
- config: absolute override, project raise-only, deprecated key warns on every surface and changes nothing; location migration strips it; derived-default table for 100k/200k/372k/872k/1M.
- TS↔Rust differential goldens for membership (three Rust forms) at a fixed floor; Pi parity via the shared core.
- Channel-1 `U` excludes the token window; grace baseline unchanged across the switch.

## 9. Out of scope

`RECENT_TOOL_SKELETON_WINDOW` (dropped-call skeletons, newest 20) and the #386 supersession owner floor (newest-20 by persisted chronology) are structural constants, not the knob. `execute_threshold_*` untouched.
