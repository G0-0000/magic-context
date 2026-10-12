# Rust historian accounting

ck-mc writes historian accounting to the existing schema-95 `context.db` tables. No migration or backfill is involved. Historian calls made after the Rust-mode cutover on **2026-09-18** and before this writer was deployed were not recorded; their model attempts, usage and run results cannot be reconstructed from compartments. The dashboard and `/ctx-status` counts therefore remain incomplete for that interval.

## Routes and vocabulary

- The Broca driver records each attempted model, including failed starts, provider failures, timeouts after recovery re-drain, and empty responses. Fallback invocations link to the preceding recorded attempt through `parent_invocation_id` and use `task = 'fallback'`.
- The host child-session runner forwards each attempted model and its provider usage in an additive `historian.complete.invocations` array. ck-mc records those attempts only after accepting the report. Duplicate, expired and superseded reports do not create new invocation rows. Deferred reports record their attempts before acknowledgment, so a subsequent module restart still has the invocation to link when it publishes.
- Wrapup uses the same firing/publication path and records `run_kind = 'incremental'`, as the TypeScript wrapup path does. Rust `session.recomp` resets the session and schedules no model call itself; subsequent actual firings are incremental, not a fabricated recomp invocation.
- Invocation statuses use the TypeScript vocabulary: `completed`, `empty`, `failed`, `aborted`, `timed_out`. Validation refusals after a completed model response produce a failed historian run, without changing the completed model invocation into a provider failure. Historian-run statuses are `success`, `failed`, `noop`.
- Harness labels are the bound session's labels, not the runner's name. The historian row links the latest invocation started during that firing, and includes input ordinals, the next unprocessed ordinal, persisted compartment ids/count, emitted facts/events, promoted/published counts and importance distribution.

Accounting is best effort, outside the publication transaction, matching the TypeScript writers. Its context writer acquisition is nonblocking, with SQLite's busy timeout temporarily set to zero and restored afterward. A busy writer, missing telemetry table, schema refusal or failed insert is logged and cannot fail a historian publication. An unavailable invocation write leaves a nullable historian foreign key. Host implementations predating the additive report field can still publish, but cannot supply per-attempt usage or model identity. A host that disappears without reporting cannot supply its unreported attempts; ck-mc still records the terminal failed/timed-out run.

## Compatibility gates

The dashboard's invocation list/count readers live in `packages/dashboard/src-tauri/src/historian_telemetry.rs` and are re-exported by `db.rs`. The mc-module compatibility test compiles the same reader source, including its existing Rust unit tests, without requiring the Tauri UI's native libraries on Linux.

```sh
cargo test -p mc-module -p mc-store
cargo clippy -p mc-module -p mc-store --all-targets -- -D warnings
cargo test -p mc-module dashboard_reader
MC_HISTORIAN_TEST_DB=/tmp/rust-historian-context.db cargo test -p mc-module rust_historian_dashboard_shape_and_status_count
MC_HISTORIAN_TEST_DB=/tmp/rust-historian-context.db bun test packages/plugin/src/features/magic-context/rust-historian-telemetry.test.ts
bun test packages/plugin/src/hooks/magic-context/historian-host-runner.test.ts
bun run --cwd packages/plugin typecheck
```

Use a fresh export path for each compatibility run (`VACUUM INTO` refuses to overwrite an existing file). The TypeScript gate reads the actual Rust-produced database with the same `countHistorianRuns` helper used by `/ctx-status`. The dashboard-shape test asserts two model attempts, an error on the first, fallback parent linkage, provider token counts and the linked historian result. Omitting the Rust invocation write must fail that test rather than silently leaving the Historian tab empty.
