# AFT cold state-sync: diagnosis, repair, and measurements

## Delivery boundary

The Rust module **and** adapter must be deployed. Live AFT acceptance (<1 second for a cold adapter against the warm module store) is **pending the operator's ck-mc bounce, OpenCode restart, and retry**. The operator explicitly authorized delivery with that measurement pending. No deployment, live database mutation, or master push was performed.

The fixtures below exercise real adapter collection/serialization and real module/store import separately. The adapter fixture's client is hermetic, not a live subc socket. Their timings must not be presented as one measured live end-to-end pass.

## Findings before the repair

Line references in this section are against base `246a1c390e9a81944b867c1cd94ae5b7166e26e3`.

* There is no fixed 30-second state-sync deadline. `rust-mode-transform.ts:158,1545,1596-1613` supplies a **15-second per-call AbortController**. `module-transport.ts:41,485-495` also defaults to 15 seconds. Assembly happens before these per-page calls. Thus the observed 30.8/49.1-second `state_sync` stage includes work outside the per-call timer; the supplied aggregate lines cannot partition it further.
* `module-transport.ts:522-527` closes/invalidates the shared client on that abort. Closing pending requests replaces the caller's timeout reason with **client closed**, and can fail unrelated sessions. This is a direct adapter cancellation/connection-lifetime coupling, not evidence that the healthy module is wedged. The supplied session-scoped log has **no reconnect line, route-generation change, or AttemptMismatch**. That absence does not rule out global transport events outside the slice, but it does not support attributing the failure to a subc idle/reconnect bug either.
* `module-state-sync.ts:1802-1851` only remembers watermarks after every page returns. `:1345-1367` resets force-seed cursors to -1/0, `:1398-1405` loads every compartment, and `:1553-1555` walks all historical dropped tags. `:1368-1373` memoizes by owner but still performs individual raw reads for distinct owners. AFT's 136k distinct historical owners defeat that memo.
* `mc-store::materialize_drop_seed_units` scans the growing `frozen_units` vector for each candidate (`crates/mc-store/src/lib.rs:6468-6481`): quadratic work. The instrumented 148,070-tag import spent **58,906.947 ms in that bracket** before the lookup repair.
* The retained-boundary and skipped-compartment stderr messages occur **inside** the import transaction; they alone do not prove commit/ack completion. The new receipt is persisted with the transaction, so recovery no longer depends on inference from those messages.
* State-sync's intermediate pages are RAM staging, not durable imports (`crates/mc-module/src/lib.rs:9463-9478`). The final page assembles/imports the series. The operator approved resuming this staging while keeping only the final series receipt durable; daemon restart may resend uncommitted staging.
* The cold path is the paged path (`module-state-sync.ts:1624-1626`), not a separate unpaged tag upload. Bytes alone explain neither the per-owner reads nor the quadratic tag import. R2 (`e2109bdc`) is mirror draining after transformation; the failed passes never reached those stages (both mirror timings are zero). R4 (`11abb86f`) changes snapshot hashing, not this import loop. The older `c711ec26` page/replay work does not make state-sync staging durable. Source inspection plus isolated stage measurements settled these mechanisms, so no speculative multi-commit bisect was run.

## Repair

* A module advertising `state_sync_resume` provides a lightweight `session.status` inventory (generation, materialized boundary, max owned compartment sequence) and seed-progress/receipt probe. Inventory does not hydrate compartment summary bodies or frozen units.
* A cold adapter sends only compartments above that inventory cursor. An uninitialized store still requests the full seed. Seed owners are selected at/after the **materialized boundary ID**, using canonical raw ordering rather than a message-count cut. Dropped-tag filtering occurs in SQL before hydrating historical tag rows. Pending drops, strips, note anchors, search-hint decisions, and synthetic todo anchors are filtered to the same eligible owner set.
* One batched raw query loads the eligible tail and parts. Canonical ordinal memo entries are populated from that query. Its instrumentation counts the actual raw query callback, not a guessed constant. Historical compartment boundary lookups outside the tail remain explicit, separately counted reads if a delta needs them.
* A stable content identity excludes transport sequence/page split and uses compartment sequence plus the mutation watermark for compartment identity. The module stores `_state_sync_seed_id` and `_state_sync_seed_generation` in the **existing** `shadow_acked_watermarks` JSON in the import transaction. No SQL schema/version migration. Progress probes resume staged pages; committed receipts survive adapter/collector restart. Both sides fence generation. A changed snapshot starts a new series rather than pretending unrelated staged pages are durable.
* A caller abort races only its own response. It does not invalidate the shared socket. Real connection failures retain their existing recovery behavior. State-sync request deadlines are typed `state_sync_timeout`, carrying `stage`, `page`, `pages`, and `series`. The below-25ms lane-floor case is explicitly tested as `correctness_lane`; the response timeout case uses 50ms and reports `module_ack`.
* Budget: `min(90000, 15000 + 2 * (payload array item count + raw owner-message count))` ms. For the 770-owner/282-drop warm fixture it is 17,104ms. This safety ceiling is not the performance acceptance threshold.
* Drop/strip import indexes retained frozen units once, preserving first-retained-unit precedence and candidate ordering. The repair removes the growing-vector scan without changing LKG/raw fallback discipline.
* Old modules that lack `state_sync_resume` retain the previous paged protocol; no inventory/receipt request is sent. An explicit compatibility test covers both old delta-capability values.

## Permanent timing semantics

Adapter: `rust.state_sync_detail` attributes DB collection, CPU serialization, page construction, inventory/receipt status calls, per-page round trips, counts, and raw SQL reads. `rust.state_sync_page` reports each actual upload's bytes/page/elapsed time. The existing outer `rust.state_sync` line remains unchanged. `module_ack_ms` is the final-page round trip **within** `transport_ms`, not an additional duration to sum.

Module: `mc-state-sync-timing side=module` reports typed decode, page validation/staging, series assembly, import wait, and response/ack preparation. `side=store` reports the nested import/drop-unit bracket and transaction commit. Store import includes the drop-unit bracket; module import includes store import plus commit. Ack means preparing the response, not proof that the consumer received bytes. Page 0 staging legitimately has zero assembly/import; the final page carries those stages. These are production writes, not benchmark-only logs.

The timing gate reads actual emitted logs, not source literals or a formatting proxy. Deleting either module/store write and replacing measured values with constants each reddened its named gate. Adapter delete/constant mutations reddened the fixture's log assertions; disabling boundary inventory produced the historical seed/query explosion below. Restores were index-backed, with nonempty mutation diffs and empty post-restore diffs.

## Measurements from those production lines

### Adapter: old force collection control versus boundary-scoped warm inventory

Fixture: 1,500 already-owned compartments, 100,000 historical dropped tags, 770 tail messages / 282 tail dropped tags. Same collection fixture, inventory scoping disabled for the control. The control deliberately fails the seed-count fence.

```text
[2026-09-11T08:45:44.387Z] [magic-context][ses-aft-warm] transform stage: stage=rust.state_sync_detail elapsed=3209.048ms collect_ms=2737.817 serialize_ms=453.903 page_build_ms=16.405 status_ms=0.028 transport_ms=0.062 module_ack_ms=0.062 compartments=1500 tags=100282 bytes=8038130 pages=1 raw_reads=200564 raw_messages=100282
[2026-09-11T09:16:56.962Z] [magic-context][ses-aft-warm] transform stage: stage=rust.state_sync_detail elapsed=102.688ms collect_ms=77.345 serialize_ms=23.829 page_build_ms=0.333 status_ms=0.030 transport_ms=0.025 module_ack_ms=0.025 compartments=0 tags=282 bytes=13337 pages=1 raw_reads=1 raw_messages=770
```

The hermetic status/transport figures above are mock-client round trips, not live network measurements.

### Module: genuinely cold store, old quadratic bracket (debug profile)

Fixture: 1,627 compartments, 148,070 drop seeds, two pages. This baseline run reached and verified the imported counts, then failed its newly added receipt probe because the probe initially omitted `v=1`; that fixture issue was corrected before subsequent runs. The import-stage measurements are unaffected by that later probe error.

```text
mc-state-sync-timing side=module session=ses page=0 pages=2 compartments=1627 tags=0 bytes=3576259 decode_ms=3.356 stage_page_ms=256.776 assemble_series_ms=0.000 import_ms=0.000 ack_ms=0.095
mc-state-sync-timing side=store session=ses import_ms=59447.424 drop_seed_units_ms=58906.947 commit_ms=21.596 compartments=1627 tags=148070
mc-state-sync-timing side=module session=ses page=1 pages=2 compartments=0 tags=148070 bytes=6404351 decode_ms=81.391 stage_page_ms=679.450 assemble_series_ms=1.666 import_ms=59477.092 ack_ms=0.008
```

Final debug cold bracket: `drop_seed_units_ms=256.608`, store `import_ms=773.994`, `commit_ms=30.410`. Debug timing is diagnostic, not evidence for the live one-second bar.

### RELEASE profile: cold store followed by warm 282-seed import over 148k retained units

Command: `cargo test --release -p mc-module --lib aft_sized_state_sync_timing_fixture -- --nocapture`. This is the optimized fixture benchmark; it prints the production sub-stage lines and asserts imported counts/receipts rather than using a separate synthetic timing implementation.

```text
mc-state-sync-timing side=module session=ses page=0 pages=2 compartments=1627 tags=0 bytes=3576240 decode_ms=0.722 stage_page_ms=13.697 assemble_series_ms=0.000 import_ms=0.000 ack_ms=0.006
mc-state-sync-timing side=store session=ses import_ms=108.664 drop_seed_units_ms=41.693 commit_ms=41.277 compartments=1627 tags=148070
mc-state-sync-timing side=module session=ses page=1 pages=2 compartments=0 tags=148070 bytes=6404351 decode_ms=27.691 stage_page_ms=86.396 assemble_series_ms=1.173 import_ms=152.425 ack_ms=0.003
mc-state-sync-timing side=store session=ses import_ms=56.419 drop_seed_units_ms=5.071 commit_ms=21.468 compartments=0 tags=282
mc-state-sync-timing side=module session=ses page=0 pages=1 compartments=0 tags=282 bytes=12786 decode_ms=0.057 stage_page_ms=23.156 assemble_series_ms=0.007 import_ms=78.052 ack_ms=0.002
```

Warm module handler stages total approximately **101.274ms**; store import and commit are nested in the 78.052ms module import figure. Cold two-page handler stages total approximately **282.113ms**. The first cold page now omits redundant `session_id`, as the adapter does; its log resolves the bound session ID and the timing gate verifies that attribution. Fixture setup/readback is outside these production stages. Neither total includes a real subc socket or claims the live AFT acceptance result.

## Gates

* `bun install --frozen-lockfile`: completed in this worktree; no intentional manifest/lockfile changes.
* `bun run typecheck`: passed.
* `cd packages/plugin && set -o pipefail; bun test --parallel --timeout 30000`: **exit 0**, 4,627 passed. The initial full run caught the new 5ms timeout-test assumption; the corrected test checks the lane floor separately and the full gate was rerun green. A later concurrent native/plugin run hit an unrelated 30-second timeout in `verify authority applier > writes through memory.set_verification under MODULE authority without mutating the mirror` (its module client is mocked, not this transport). That file passed all 24 tests on isolated retry, and the final full plugin run without a concurrent native suite passed all 4,627 tests.
* `cargo test -p mc-module --lib`: 1,101 passed, 6 ignored (private-capture/explicit ignored tests).
* `cargo test -p mc-store --lib`: 139 passed.
* `cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings`: passed after fixing the new needless-question-mark lint.
* `bun test scripts/state-sync-timing-gate.test.ts`: 2 passed, reading actual adapter/module/store writes.
* Release-profile fixture above: passed.
* `bun run --cwd packages/plugin build`: passed.
* AFT inspection completed but its LSP producers were unavailable; authoritative checks are the typecheck/cargo gates above.
* Comment lint: 16 comments checked, none flagged (cold-reader service unavailable).

The external sibling `subc-core` checkout reports 0.17.24 while the baseline lock records 0.17.21. Cargo refreshes that local path-package version during gates. This unrelated lockfile change is restored, not included in delivery. Formatter tooling required the package's explicit Biome configuration; no configuration change is included.
