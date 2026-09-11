# Rust adapter transport and permission-probe measurements

## Mechanisms

The adapter now reports per-call lane wait, route/connect/open wait, JSON request encode, synchronous SUBC issue, opaque response wait/decode, remaining settlement, and the outer wrapper on the existing `rust pass` line. The existing `other` budget is split into preflight, todo permission verdict (host probe and durable write separately), session-directory resolution, paging, delivery acknowledgements, and bookkeeping. `output_clone` is a child of `apply`, not an additional top-level duration. Full-retry transport is no longer also charged to `wire_build`.

The expensive previously unnamed host work was `app.agents()` plus `session.get()` for the todowrite permission verdict: 20.8–24.1 ms on the small hermetic fixture. A fresh verdict is now requested when adapter-visible bust signals are present: first/full/recovery pass, missing durable verdict, model/system-prompt/agent/config/project/profile/mural/protection/marker identity changes, execute pressure, pending refresh/materialization, memory sync, emergency/frozen state, pending agent drops, idle TTL, or the preceding module response's reconcile/historian hint. Otherwise the persisted permission verdict is replayed. No TTL cache of permission allows was introduced. The module decision remains authoritative; unexpected unprobed busts are logged by both sides. `possible_stale_mint` is deliberately an upper bound (an unprobed bust with an available verdict), not a claim that a pair was actually emitted.

Native output now copies JSON containers directly rather than invoking structuredClone's serialization path. Nested mutable objects remain isolated from the acknowledged delta basis; immutable strings are shared. The permission verdict is written to SQLite only when it differs from the durable value.

## SUBC API finding and upgrade

The plugin pin was 0.4.1, not the binary-capable version assumed in the brief. It is now 0.11.1, with its Bun lock entry committed. Bun also refreshed existing workspace version metadata from 0.41.1 to 0.41.4. Pi and e2e retain their independent existing pins.

The published changelog lists binary bodies/wire-flag-driven replies in 0.11.0 and per-route reconnect fault isolation in 0.11.1. `RequestOptions.binary` describes the **request**, not a binary-reply preference. Setting it for MC JSON would mislabel the protocol. MC requests retain the JSON flag, with pre-encoded JSON bytes. `request()` still owns terminal frame reception and JSON decoding. `onProgress` observes interim PUSH/StreamData, not terminal first-byte arrival. No false first-byte/body-receive measurements were invented. The Synapse JSON `call()` and wake-plane `catalogList()` call sites remain compatible and are covered by typecheck/full tests.

Needed upstream API for finer attribution: a per-request monotonic timing callback with socket write, first terminal header/body byte, complete frame, decode start/end, and promise resolution; alternatively an explicitly raw terminal-reply API preserving frame flags/errors. Current `transport_response_wait_decode` includes those inaccessible boundaries and event-loop scheduling. Routes and capabilities are already cached by connection generation; the ordinary measured lane/route waits are effectively zero.

## Measurements

All timings are wall-clock and share a loaded host. Fixture logs distinguish adapter overhead (`elapsed - module`) from end-to-end elapsed; the previous fixture label `adapter_ms` actually meant overhead.

Final paired 2,000-message fixture, five steady SOFT+ samples:

| Quantity | Original adapter | Optimized adapter |
|---|---:|---:|
| p50 adapter overhead | 45.4 ms | 13.5 ms |
| Representative end-to-end / handler | 120.8 / 75.4 ms | 75.5 / 62.0 ms |
| Overhead samples | 50.7, 51.8, 45.4, 40.9, 43.5 | 13.5, 14.2, 10.6, 23.1, 13.4 |
| Representative apply | 8.5 ms | 3.1 ms |
| Representative other | 27.6 ms | 0.6 ms |

The +20 ms objective holds at p50 and on four of five final synthetic samples, **not as a worst-case guarantee**. The remaining outlier is retained rather than hidden.

Exact representative final line:

```text
rust pass: decision=SOFT+ reason=none scheduler=defer defer_reason=scheduler_defer historian_no_fire=trigger_false canonical_cause=below_proactive_floor served_from=transform in=2005 out=2007 applied=true row_version=6 elapsed=75.5 ms module=62.0 ms stages=identity_resolve:0.0 prompt_surface:0.0 mural_resolve:0.0 prefix_guard:3.2 ordinal_resolve:0.4 state_sync:0.0 clone:0.0 wire_build:0.2 wire_messages:3 transport:65.4 transport_pages:1 transport_bytes:6413 apply:3.1 lkg_snapshot:2.2 mirror_pull:0.0 compartment_mirror:0.0 other:0.6 transport_lane:0.0 transport_route:0.0 transport_encode:0.0 transport_issue:0.1 transport_response_wait_decode:65.2 transport_settle:0.0 transport_wrapper:0.0 preflight:0.2 todo_verdict:0.1 todo_probe:0.0 todo_persist:0.0 todo_probe_required:0 todo_probe_reason:none todo_unprobed_bust:0 session_directory:0.0 paging:0.0 output_clone:2.0 delivery:0.0 bookkeeping:0.1
```

A read-only transaction replayed the current post-compaction AFT raw-history tail into a disposable real Rust stack. IDs, agent/model routing and summary filtering were adapted to the isolated harness; text/reasoning/tool payloads were retained. This is not a replay of the live module's durable state. Both synthetic and real-history runs had **8 observed passes, zero unprobed busts**; the real replay included a coverage-fold HARD. No internal-repair exceptions were needed. This bounded sample does not prove the local predictor is complete for every future module decision.

The final real replay still probed on every steady pass because `todo_probe_reason:module_hint` remained asserted. Its p50 overhead was **72.5 ms** (251.4 ms end-to-end, handler 178.9 ms); probe 36.6 ms, request wait/decode 194.4 ms, apply 4.3 ms, LKG 7.8 ms. The +20 ms objective is **not met on this hint-active replay**. Removing the hint would improve speed but lose the conservative coverage-fold protection, so it remains enabled. A tighter module hint is the next safe optimization.

Live AFT before measurement at 2026-09-11T11:36:05.920Z: SOFT+, in=841, elapsed=247.7 ms, module=59.8 ms, transport=66.4 ms, apply=28.9 ms, other=141.8 ms. The preceding pass had transport=337.6 ms. This variability did not reproduce as persistent transport overhead in the hermetic run. Live deployment/after measurement is explicitly owned by the parent; this task never deployed to the live host.

## Byte identity

The synthetic fixture initially interleaved generated history with the seed user/assistant pair because it anchored timestamps at the newest seed message. Provider latency changed that ordering between runs. It now anchors before the earliest seed message and asserts ordering. With the same deterministic fixture, the original and optimized adapters produced identical **raw provider message arrays**, including cache-control fields, for all five SOFT+ samples. SHA256s in order:

```text
9105bdf80a08a1ef72f333710becefba749cd5555bc488062ba1b0645ba5e6a9
036feec5c21ee774ca8fdf6152e8d612178ada2a56c396c80c653bd49e4e7f18
ee3ad27c6dc81f51a0dc46af02d413a1d19b65097c2cff0a2a0e4b03ee139f81
5caf60121366d49e5484a749fa677d9f2cba33a0da80800bc38929343c004412
3137b69ef3f7edcdea6c79de6cc688ff519b77a0eee50a379b49c8838edf4c99
```

The 2,048-message adapter test separately compares served native JSON against the prior structuredClone representation through SOFT+, SOFT and HARD. Matching before/after hashes:

- SOFT+: `cc0c9877b18fbdb8898dac5418d00b2bc7274b3446913273e047d53173986102`
- SOFT: `c707d9a9b961deaa99b57105af7a0f712e2bc27e086bc4c617c757bbfe83b27d`
- HARD: `e90fc73a12695fef9622eff4b60008ba1623c1e9f7c771d4c5ef3b99cd3b9fc8`

These SOFT/HARD hashes are adapter-boundary fixtures with controlled module responses, not claims of independent real-module SOFT/HARD provider captures.

## Gates and reproduction

- `cd packages/plugin && bun run typecheck`: passed.
- `cd packages/plugin && set -o pipefail; bun test --parallel --timeout 30000`: final exit 0, 4,655 pass / 0 fail, 412 files (82.71 s). Earlier loaded runs had wall-clock budget failures and occasional unrelated timeouts; these were not weakened. Isolated reruns passed and the final full run passed.
- Plugin-local `node_modules/.bin/biome check` on six changed plugin TS files: passed.
- `cargo test -p mc-module --lib`: 1,102 pass, six ignored; `cargo clippy -p mc-module --lib -- -D warnings`: passed. Cargo.lock drift restored, never committed.
- E2E package-wide tsc has an unrelated existing Bun/BetterSqlite3 mismatch in `tests/pi-compaction-off.test.ts:60`; scoped replay/harness tsc using the repository's strict compiler options passed.
- Final hermetic synthetic and real replay runs passed. Prior 2k × 1KiB attempts exceeded the 15-second unpaged cold budget under load; the final permanent 2k fixture uses 128-byte history messages. Whole-lifetime raw AFT replay was too large; bounded post-compaction replay completed.
- Mutation controls detect removed transport timing delivery, removed same-line attribution, mutable delta-basis sharing, always probing defer, omitted execute-pressure probing, disabled module unprobed-bust guard, and absent live timing fields in the hermetic fixture. All mutants restored before delivery.

Run the synthetic fixture from `packages/e2e-tests`:

```sh
MC_E2E_MODE=rust NODE_ENV='' bun test --timeout 600000 tests/rust-multi-frame-delta-perf.test.ts
```

Optional replay: set `MC_RUST_PERF_REPLAY_DB` and `MC_RUST_PERF_REPLAY_SESSION`. Optional raw provider capture: set `MC_RUST_PERF_WIRE_ARTIFACT` to an absolute ignored output prefix. No raw real-session content is committed.
