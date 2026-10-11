# Fastest safe path to live Broca compaction

## Decision in brief

**Cut a provider-only ck-mc branch from current master, keep context.db at 95, and deploy only ck-mc after executable protocol tests and integration tests on an isolated copy of a schema-95 database.** ck-mc is Magic Context's Rust module executable; “placement” below means replacing/restarting that registered executable, and “dists” means the built OpenCode/Pi plugin distributions. Start with the original provider implementation, not the latest fast-Rust OpenCode implementation. This is option (a), with the binary-only placement refinement in option (c).

The provider protocol does not intrinsically need context.db v96–v100. Its conversation, transcript, answer, tag and version state belongs to **store.db**. The delegated engine still reads the existing context.db domain; “provider state is private” does not mean “no context.db access.” Do **not** infer that the unmodified migration-branch binary is a safe v95 binary merely because its numeric context fence accepts 95: its memory writers and fingerprint expectations have changed.

Two findings materially shorten or qualify the release options:

1. **S1 and S2 are already on the inspected master.** Only S3, S4 and applicable follow-up fixes need extraction. They are not all absent from master.
2. **“Nothing but ck-mc opens store.db” is literally false.** ck-mc owns its migrations and normal runtime writes, but the dashboard reads it and doctor tooling opens it for inspection/paired backup. These exceptions do not require every OpenCode/Pi plugin distribution to acquire the new private provider-table migrations.

### Scope and evidence baseline

This is a source/history investigation, not a placement or a live compatibility certification. Source line references below are repository-relative and refer to **cc8617ece9f2fa51c8fb34eb542b570e7400877c**, the supplied migration-branch base. No product source, migration, live database or installed binary was changed. Broca 0.3.192+ role support and the live schema-95 database are premises supplied by the owner; this worktree does not contain Broca's implementation or a live database snapshot.

Local refs inspected during this investigation:

- `master`: **d235c62259a09890b8e358c0ce2062b6086ffd9a**.
- Common ancestor with the supplied base: **9d26c87081a9925217fa09698ce08e7a092e1f4d**.
- `git rev-list --count HEAD..master`: **148** commits; the reverse: **221**. These are graph counts including side histories, not 148 files or a conflict estimate.
- `git merge-base --is-ancestor 50c6faa6cf master` and the same check for `c5230e277b`: exit **0**; for `727ee88592` and `391290b223`: exit **1**.

| Slice | History evidence | Consequence |
| --- | --- | --- |
| S1: optional provider runner route | `50c6faa6cf`, implementation `66aeb37afa` | Already in master; retain its configurable/static provider target. |
| S2: append-only compaction engine seam | `c5230e277b` | Already in master; retain, then port later runner correctness fixes. |
| S3: durable compaction and step-transform provider surface | merge `727ee88592`; `f46b3546a5`, `1fcc921a46`, `2fc38ae02d` | Absent from master; principal extraction. |
| S4: Broca conformance plus fixes | merge `391290b223`; `ca4c934395`, `0b81ddc155`, `9e0e0b0aff` | Absent from master; carry runner acceptance and fixes, not unrelated host activation. |

The route target is process configuration rather than a plan-supplied module ID (`crates/mc-module/src/route_targets.rs:76-85`). The executable conformance contract explicitly binds provider/tool routes as **runner**, with **harness: broca** in the body (`crates/mc-module/tests/broca_conformance/README.md:11-19`). `docs/architecture/broca-transform-contract.md:73-115` describes full-request `owned-broca` transforms; this report instead relies on the provider-role contract for the four methods below.

## 1. Context.db needs of the runner-bound path

### Route separation comes first

`handle_provider_value` checks the bound route, admits either an OpenCode host or `RUNNER_BIND_HARNESS`, and rejects runner plans opting into host-only `observation: answer` or `serializer_profile: opencode-aisdk`. Host plan admission is only in the host branch. Runner `transform.declare` returns before catalog persistence checks and before setup/step/hook dispatch (`crates/mc-module/src/providers/mod.rs:150-227`). Thus the OpenCode host-runner persistence lane must not be counted as a Broca dependency.

| Runner operation | Actual work | Direct context.db domain access |
| --- | --- | --- |
| `transform.declare` | Decode preset/plan, return advisory subscriptions and allowed operations. | **None**, including no store-open wait on this route. `crates/mc-module/src/providers/step_transform.rs:222-271`; `crates/mc-module/src/providers/mod.rs:208-217`. |
| `transform.hook` | Wait for the shared store to open, load provider record/catalog, optionally ask the runner for transcript pages, mint/strip tags or append reminders, save answer/cadence state. | No direct domain SQL in the runner hook. Opening the store attaches context.db, so startup checks/resumed writes still apply. `crates/mc-module/src/providers/step_transform.rs:1114-1163,1200-1214,1264-1290`. |
| `compaction.setup` | Open store, load/persist setup and high-water state, scan runner history when supplied, run the engine for the initial view, persist answer. | Through project resolution and the delegated engine. `crates/mc-module/src/providers/compaction.rs:1313-1447`. |
| `compaction.step` | Check setup, ingest/scan transcript, reserve version before engine execution, return noop/replacement or durable wait + ready callback. | Through project resolution and the delegated engine. `crates/mc-module/src/providers/compaction.rs:1450-1597`. |

Runner `execute` constructs an `owned-broca` request and calls `transform::compaction::{setup,step}` (`crates/mc-module/src/providers/compaction.rs:734-803`). The seam in turn calls `transform_with_projection`; it disables native-host transport, engine-side tag minting and auto-search for this lane, leaving the step hooks in charge of new-subject edits (`crates/mc-module/src/transform.rs:2578-2612`). The runner's engine session key is a separate `mc-provider:` hash of project/session/harness, not the host's session key (`crates/mc-module/src/providers/records.rs:6-38`).

### Existing context domain read set

The following are the actual context read families beneath compaction, not a list of every table ck-mc can ever use. Rendering work varies by preset and pass: a head rebuild can compose m[0]/m[1]; worker/reader sessions are marked as subagents, and a deferred pass need not recompose the head (`crates/mc-module/src/transform.rs:2592-2612`). Memory reads are conditional on memory being enabled. Revision checks are not all conditional on having rendered memory.

| Context table(s) | Columns/operations used by this path | Evidence |
| --- | --- | --- |
| `workspaces`, `workspace_members` | Workspace `id`, `share_categories`; member `workspace_id`, `project_path`, `display_name`; resolve own/foreign memory visibility. | `crates/mc-store/src/single_store_schema.rs:300-339`. |
| `compartments` | Session filter; `id`, `sequence`, ordinal and message/block boundaries, `title`, `content`, summary-tier columns `p1`–`p4`, `importance`, `episode_type`, `legacy`, `created_at`; maximum sequence/coverage and history rendering. | `crates/mc-store/src/context_writes.rs:106-143`; `crates/mc-store/src/single_store_schema.rs:475-491`; `crates/mc-store/src/lib.rs:12710-12714`; `crates/mc-module/src/m0_compose.rs:521-539`; `crates/mc-module/src/m1_compose.rs:355-392`. |
| `memories` | `id`, `project_path`, `category`, `content`, `importance`, `status`, `expires_at`, `superseded_by_memory_id`, `updated_at`, `last_seen_at`, `verified_at`; eligible rows and max-ID watermark. Existing active/permanent and expiry/visibility predicate, **not** v99 revision/evidence columns. | `crates/mc-store/src/single_store_schema.rs:341-418`; `crates/mc-store/src/lib.rs:17704-17726`. |
| `memory_mutation_log` | Max `id` by project and pending mutations after the applied cursor; target/successor/category/content/visibility information for m[1] corrections. | `crates/mc-store/src/lib.rs:12700-12708`; `crates/mc-module/src/m1_compose.rs:403-499`. |
| `user_memories` | Active `content`, ordered by `promoted_at`, `id`; user-profile block when memory enabled. | `crates/mc-store/src/single_store_schema.rs:421-433`; `crates/mc-module/src/m0_compose.rs:582-591`. |
| `notes` | `project_path`, `updated_at` max for revision signal; session-note rows can be copied on lineage-related context writes. Ready smart-note bodies are **not** rendered into m[1]. | `crates/mc-store/src/lib.rs:12715-12719`; `crates/mc-module/src/m1_compose.rs:527-529`; `crates/mc-store/src/context_writes.rs:330-362`. |
| `project_state` | `project_memory_epoch` by project; `project_user_profile_version` on `__global__`. | `crates/mc-store/src/lib.rs:12720-12745`. |
| `m0_mutation_log` | Max `id`, session filter, `target_id` exclusion for the module's own rewrites. | `crates/mc-store/src/lib.rs:12728-12734`. |
| `compartment_history_versions` | If present: `session_id`, `generation`, `version`, `rewrite_version`, `seeded`; external-rewrite detection. Absence is explicitly tolerated. | `crates/mc-store/src/context_boundaries.rs:189-205`; `crates/mc-module/src/m1_compose.rs:281-305`. |
| v98 `compartment_score_selections`, `compartment_score_revisions` | **Optional later-branch read only**: selection `session_id`, `compartment_id`, `sequence`, `revision_id`; revision `id`, `session_id`, `compartment_id`, `source_identity`, `new_importance`. Missing either sidecar returns base scores/watermark zero. | `crates/mc-store/src/score_projection.rs:170-228`; `crates/mc-module/src/m0_compose.rs:521-524,602-618`. |

Project resolution first consults `store.session_project_identity`, then the checkout identity resolver; it is not a context host-runner lookup (`crates/mc-module/src/lib.rs:5676-5733`). Date segments applied to compartments are module-store data, not a requirement for new context columns (`crates/mc-store/src/single_store_schema.rs:475-491`). Reading ARCHITECTURE.md/STRUCTURE.md from disk on head composition is separate from database schema (`crates/mc-module/src/m0_compose.rs:594-598`).

### Context writes and startup plumbing

These four provider methods do **not** write OpenCode LKG slots, served-move markers, host-runner entries/views or `session_meta.served_prefix/held_release`. Their provider records are saved through McStore (`crates/mc-store/src/provider_records.rs:44-67,84-123`). Declaration has no database writes; the runner hook only persists private provider state after the shared store is ready.

The compaction methods delegate to the shared transform engine, which is not read-only in every case:

- A revert/reconcile can call `truncate_compartments_for_revert` (`crates/mc-module/src/transform.rs:6433-6452`). Its context transaction deletes tail `compartments` and referring `compartment_events`, deletes out-of-range `primer_candidates`/`user_memory_candidates` and appends `m0_mutation_log(session_id, mutation_type, target_id, queued_at)` (`crates/mc-store/src/context_writes.rs:218-286,430-440`). Compartment triggers also maintain `compartment_history_versions`; its schema is a write companion (`crates/mc-module/src/host_store.rs:1095-1104`).
- Pending context writes are resumed when the store is attached, **before** serving even a hook (`crates/mc-module/src/single_store_reads.rs:268-275`). Pending variants include fold, compartment replacement, clear/truncate and lineage copy (`crates/mc-store/src/context_writes.rs:45-84`). Fold publication writes compartments/events/primer/user observations and can promote memory facts; lineage copy also copies session notes (`crates/mc-store/src/context_writes.rs:288-378`). This is shared startup/recovery behavior, not four independent writes in every compaction step.
- Every domain write flips `context_privilege_state(id=1, enabled)` inside the same transaction, with target/companion fingerprints checked before writing (`crates/mc-module/src/host_store.rs:1127-1171`).

Startup itself reads `schema_migrations.version`, `sqlite_master` and schema PRAGMAs for fingerprints (`crates/mc-module/src/host_store.rs:502-618,620-670`). It reads `single_store_state(id, state, migrated_at)` and checks that its migration stamp matches the private store's marker. On a fresh cache it can establish the existing single-store flag, but it does **not** apply context migrations v96–v100 (`crates/mc-module/src/single_store_reads.rs:157-177,179-267`). Existing correct single-store provisioning remains required at schema 95.

### Which later context migrations are actually needed?

| Context migration | Required for the Broca provider protocol? | Boundary |
| --- | --- | --- |
| v96: `lkg_slots.served_capture_id/input_move_digests`, `lkg_served_markers` | **No.** | Served-capture certification for agent moves, not runner provider records. DDL: `packages/plugin/src/features/magic-context/migrations.ts:3225-3237`. |
| v97: host-runner schema | **No.** | OpenCode's host transcript/view persistence, not Broca's runner callback transcript. DDL registration: `packages/plugin/src/features/magic-context/migrations.ts:3239-3244`; host/runner branch: `crates/mc-module/src/providers/mod.rs:161-210`. |
| v98: rescore sidecars/jobs | **No.** | Later renderer checks absence and renders base scores. `packages/plugin/src/features/magic-context/migrations.ts:3246-3251`; `crates/mc-store/src/score_projection.rs:175-188`. Do not extract unfinished rescore just to obtain the provider. |
| v99: memory lifecycle | **Not for the original provider/compaction read path. Yes for the branch's new memory writers.** | It adds `memories.revision/verify_*` and lifecycle tables; the new applier writes receipts/journal/pending/conflict/classification state. `packages/plugin/src/features/magic-context/migration-v99-memory-lifecycle.ts:6-10`; `crates/mc-store/src/memory_lifecycle/applier.rs:31-41`. Keep master's memory implementation in a provider release. |
| v100: `session_meta.served_prefix/held_release` | **No.** | Host signed-thinking persistence, not runner provider state. Rust's held-release metadata is instead in store.db. `packages/plugin/src/features/magic-context/migrations.ts:3260-3267`; `crates/mc-store/src/lib.rs:3254-3259`. |

### Could a provider build run against live schema 95? What does the fence do?

**A master-based provider extraction can, by design, remain a context-95 build.** Preserve master's context schema fixture, fingerprint map and memory writers; add the runner surface/private-store persistence and applicable engine fixes. No compatibility shim or fake migration version is needed. The affirmative answer is about this extraction, subject to the copied-v95 gates below, **not** a certification of cc8617ec unchanged.

The Rust context fence is **not a minimum-version check and not a numeric file-wide refusal**. `BUILT_CONTEXT_FENCE_VERSION = 100` is explicitly reported, not enforced (`crates/mc-module/src/host_store.rs:63-73`). It requires a migration ledger, records the persisted lane below the fork floor and fingerprints the tables that exist (`:620-670`). `lane_ahead` is informational; table presence/schema fingerprints decide writability (`:672-706`). A database at 95 is not rejected just because 95 < 100 and is not auto-upgraded to 100 by ck-mc. Reads execute against the existing schema; unsupported SQL can still fail. Writes recheck the target and companions under `BEGIN IMMEDIATE` (`:1127-1142`).

**The unmodified latest binary is not a safe general v95 placement.** v99 changes `memories` and the branch expects its new fingerprint (`crates/mc-module/src/host_store.rs:342-344`) plus memory mutation/verification companions (`:1099-1103`). Even history-only pending writes declare `memories` in `HISTORY_TABLES` (`crates/mc-store/src/context_writes.rs:34-43`), so memory-off is not a universal escape from write refusals. Initial setup/read-only happy paths may work, while recovery/publication/tool writes do not. A numeric fence-only test would miss this. The `master`→base diff of `host_store.rs` confirms both the 95→100 reported ceiling and changed memory fingerprint.

For contrast, TypeScript hosts use a global **ahead-of-supported** context fence and their migrator then upgrades older schemas. Moving the shared file to 100 would make a host built for 95 refuse it; switching a feature off does not undo that fence. See `packages/plugin/src/features/magic-context/storage-db.ts:329-388` and the migration/ceiling lockstep requirement in `packages/plugin/src/features/magic-context/migrations.ts:3271-3279`.

## 2. Store.db needs and ownership

### Minimum versus latest implementation

All bundled store migrations run on open; the newest bundled migration is also the binary's rollback ceiling (`crates/mc-store/src/lib.rs:3268-3284,7981-8005,8065-8083`). Therefore an **unmodified** cc8617ec binary takes the private store through **68**, irrespective of the route exercised. A release extraction can stop earlier only by shipping the corresponding earlier provider/store implementation, not by making a v68 implementation pretend it knows v65.

| Store migration | What it adds | Broca necessity / extraction decision |
| --- | --- | --- |
| v64 | `cortexkit_fence`; move fences/cuts/installs/key map/tag epochs. `crates/mc-store/src/move_store.rs:29-57`. | Not a compaction payload requirement. It precedes v65 and supplies tables used by the branch's opener/writer guards and session-root pruning (`crates/mc-store/src/lib.rs:8084-8087,8232-8254`). Retain the genuine migration and any referenced fencing support rather than renumber v65 or invent a no-op with v64's identity. Activating session moves, including certification using the context v96 served-capture markers, is not required for the provider release. |
| v65 | `mc_provider_sessions_v1(project_root, session, harness, record)` and `mc_provider_catalogs_v1(project_root, session, catalog)`. `crates/mc-store/src/migrations/store_065_provider_records.sql:1-18`. | **Required for the original S3 durable provider.** Holds setup/answers, high-water tags/versions, admission, transcript/cursor state. This is the minimal provider release's natural ceiling. |
| v66 | Normalized conversations, lineages, messages, answers, policy parts, views, legacy tags, pending/consumed drops; migration from v65 records. `crates/mc-store/src/migrations/store_066_provider_log.sql:3-144`. | **Required if copying the latest provider persistence.** Runner record APIs now call `provider_legacy`, which loads/reconstructs and saves those normalized tables (`crates/mc-store/src/provider_records.rs:44-65`; `crates/mc-store/src/provider_legacy.rs:49-175,177-282`). Not required by the wire contract or original v65 implementation. Normalized storage does not make the current Broca lane bounded: it still hydrates the whole record. |
| v67 | `SELECT 1` fence step protecting `ModuleMeta::held_release`. `crates/mc-store/src/lib.rs:3254-3259`. | **No new provider table.** Needed if shipping held-release semantics, and also reused by applied-score-watermark support (`docs/designs/compartment-rescore.md:96-137`). Exclude those features in a v65 extraction. Do not weaken a fence once either metadata contract is included. |
| v68 | Bounded policy summaries/change log, indexes and invalidation/maintenance triggers. `crates/mc-store/src/migrations/store_068_provider_policy_summaries.sql:13-139`. | **Not required by the runner-bound Broca hooks.** This optimization supplies Channel-1 policy inputs for **host** hooks (`crates/mc-module/src/providers/policy_summary.rs:1105-1112`); runner hooks take a separate branch (`crates/mc-module/src/providers/step_transform.rs:1123-1129`). Include only with that implementation and its correctness/performance gates. |

The registry assigns precisely these versions in `crates/mc-store/src/lib.rs:3240-3265`. Schema numbering is persisted compatibility state, not a feature flag. If the live private store is already newer than the extraction's ceiling, the candidate will refuse it: preflight its version and never erase a ledger entry to force a downgrade. A new store ceiling needs a placement/rollback plan for **all users of the placed ck-mc**, even though no OpenCode/Pi dist needs to migrate store.db itself.

### Who opens the private file?

The normal module opener calls `McStore::open_with_private_permissions`, then attaches context.db before publishing the handle (`crates/mc-module/src/lib.rs:4828-4852`). The module's `StorageDescriptor` derives its isolated SQLite path (`crates/mc-module/src/lib.rs:19050-19061`). OpenCode's host provider client sends role requests through `moduleClient.call` (`packages/plugin/src/hooks/magic-context/host-runner/provider-client.ts:550-562`); it does not create the `mc_provider_*` schema in context.db.

There are real exceptions to an absolute “only ck-mc opens it” statement:

- Dashboard resolves `cortexkit/magic-context/store.db`, opens **read-only**, and reads managed-session cache presence, tolerating missing tables (`packages/dashboard/src-tauri/src/db.rs:3740-3785`).
- `doctor single-store` opens both databases **read-only** for inspection (`packages/cli/src/commands/doctor-single-store.ts:138-168`).
- `doctor git-fts-map` opens both files read/write, takes a store `BEGIN IMMEDIATE` for a consistent paired backup and later rolls it back; the context repair is the operation being performed (`packages/cli/src/commands/doctor-git-fts-map.ts:148-183,211-234`). Tests/probes also open isolated stores.

**Deployment conclusion:** store.db is ck-mc-owned for runtime schema/migrations, not exclusively opened by its process. Adding provider tables to it does not require rebuilding every OpenCode/Pi dist. Preserve existing externally inspected tables, ensure maintenance tools are compatible, drain/restart the module for placement, and keep a paired rollback backup. This is much narrower than migrating the shared context.db.

## 3. Splitting options

### (a) Provider release from today's master — recommended

**Contents:** retain master S1/S2; port the S3 runner surface, original v65 provider persistence/catalog-startup behavior and genuine v64 prerequisites; port S4 runner conformance and the applicable runner engine/codec fixes. Keep master's context-95 schema/fingerprints, memory code and existing full-request host adapters. Do not cherry-pick the whole migration branch or the fast-Rust host adapter train.

Concrete source/history units:

- S3 `f46b3546a5` + `1fcc921a46` + `2fc38ae02d`, or the first-parent merge diff of `727ee88592`, is a starting patch set, **not** a promise of clean cherry-picks. That merge added about **3,880 lines across 23 files**, including provider tests and move-inventory integration. Extract or adapt its inventory references without claiming context v96 exists.
- v64 store support originated in `90488bd9f2` (about **2,499 added lines / 9 files**). Review its store-fence/support dependency separately; don't drag its separate context served-capture implementation `b32872280f` into the release.
- S4 `391290b223` adds the executable test rig/shared fixture and the history/transport fixes. Carry the **runner** fixes from `ca4c934395`/`0b81ddc155`, plus the current-output retry fix `dff86491bf` and its tests. Its live engine implementation returns the current replacement rather than a stale prior view (`crates/mc-module/src/transform.rs:2626-2640`); regression rationale is also recorded in `docs/reports/r73-compaction-fix-review.md`.
- Audit later commits by reachable runner behavior, not by their merge labels. For example, `4cc50000d5` includes shared transform/reasoning lookup improvements as well as host-provider code; take a shared hunk only if needed to preserve correctness or demonstrated Broca cost. `d660687b2f` is a historian CAS recovery fix and needs a regression assessment if the extraction's existing historian path reaches it. Do not import all of M3/M4/M5 or the signed-thinking train to obtain these fixes.
- Refresh pinned commons/role dependencies and offline Cargo.lock consistently; retain the conformance fixture's byte provenance (`crates/mc-module/tests/broca_conformance/README.md:59-72`). Avoid downgrading master's dependency fixes via an old entire lockfile.

**Work/size:** roughly **3–5 small implementation/review slices, 4–7 engineer-days plus independent review and placement**, assuming no newly found behavior gap. The original S3 + S4 + v64 source/fixtures are of order **8–10k added lines**, mostly tests/fixtures and already written code; not a one-file switch. This estimate is for extraction, reconciliation and verification, not writing the original engine again. The latest `providers/` subtree alone is much larger, which is a reason not to copy it wholesale.

**Risks:** cherry-pick conflicts in shared transform/lib/store code; accidentally carrying v99 fingerprints or host-only tables; catalog startup/admission regression; missing a later runner correctness fix; larger-session costs of the original whole-record provider; fixed role/commons versions not matching the live Broca. Existing signed-thinking problems in master are not solved by omitting the unfinished hold. Require a Claude-family Broca case with reasoning/tool arcs as well as non-reasoning cases; “avoids this campaign” is not “certifies every Anthropic prefix mutation.”

**Avoided:** the *new* signed-thinking hold campaign, memory slice-3 redesign, rescore S4, OpenCode fast-Rust P2 cost target, and the migration-branch catch-up merge. Starting from current master means its current fixes are already present; a small forward delta still has conflicts to resolve.

### (b) Ship the migration branch with unfinished work disabled

**Contents:** reconcile this branch with current master; provide real, default-off gates for unfinished behavior; then ship context.db 100 + store.db 68 through the existing migration discipline. All hosts sharing context.db need compatible plugin/Pi/CLI placements, rebuilt distributions and coordinated restarts. Stale hosts cannot keep a 95 ceiling after one host migrates to 100 (`packages/plugin/src/features/magic-context/storage-db.ts:373-388,891-908`).

There is **no single existing switch that makes this safe**:

- **Signed-thinking hold:** the current engine computes admission from retained thinking/model classification and applies prefix protection without a user-config feature flag (`crates/mc-module/src/transform.rs:5354-5370,17688-17762`). A rollback/off gate must reproduce the previous engine/host behavior across all relevant decisions and persisted parking, not merely stop creating a new record. A flag cannot leave an already-held obligation silently lost. The design still requires admission checks on coverage/placeholder/todo edits, served-prefix recording, release and Claude Code work (`docs/designs/signed-thinking-hold.md:1689-1751`).
  - Terminology matters: **Claude-family signed thinking** can affect Broca and OpenCode. The specific **Claude Code serializer** has a temporary gate excluding trigger parking; that is not an overall feature off-switch (`crates/mc-module/src/transform.rs:5356-5361`). The design postpones removing that gate until the completed-turn strip is ready (`docs/designs/signed-thinking-hold.md:1732-1751`). Do not equate this partial profile exclusion with all Claude sessions being unaffected.
- **Memory redesign:** gating future automated work can defer its activation, but already landed v99 memory admission/tool writer routing is not neutralized by `auto_promote: false`. Agent saves explicitly ignore that setting (`crates/mc-store/src/memory_lifecycle/applier.rs:135-139`). The redesigned spec now calls for approval-bound writers, applied snapshots, continuation/materializer/search/inbox slices and separate activation proofs (`docs/designs/memory-lifecycle.md:467-498`). The owner's “slice-3 redesign” is a rollout dependency label; the checked-in r2 plan is now a finer-grained campaign, not one missing boolean. Retaining S1/S2 requires explicitly scoping/accepting their semantics, or adding and proving a legacy routing gate.
- **Rescore S4:** defer the execution/job entry points, not just score rendering. Already landed sidecars and applied-watermark support can remain passive; missing-sidecar compatibility already exists. Completing durable execution is independent work with crash/admission/billing/source-CAS/cancel gates (`docs/designs/compartment-rescore.md:86-94,139-150`). This checkout contains schema, identity and render support, but no production `ctx-rescore` command implementation was found in plugin source; this report does not certify S4 readiness. If only the unfinished executor remains off, it can be avoided as an activation gate, while schema/projection/rollback obligations remain.
- **Fast-Rust OpenCode:** the existing switch is sufficient to keep the **OpenCode host pipeline** off: `rust_pipeline` defaults to `full_request`, and the schema labels provider mode experimental/not for production (`packages/plugin/src/config/schema/magic-context.ts:1143-1148`). It is not a Broca provider-role off-switch. The outstanding P2 target is rebuild p50 ≤ **1.10×** comparable full-request p50; the report records **1.25–1.47×** synthetic ratios, with P1–P4 not signed off (`docs/reports/provider-pipeline-performance-gate.md:480-488,645-656`). Keep this mode off and its default-cutover performance campaign need not block a Broca-only release.

**Work/size:** at least **4–6 cross-runtime slices, roughly 6–12 engineer-days plus independent review, fleet migration/restart and external/live-gate time**. Uncertainty is substantially greater than (a): signed-thinking disable/reenable transitions and today's-master reconciliation are not bounded by a simple switch patch. This is not an estimate for finishing every redesigned memory slice.

**Risks:** a disabled feature still migrates the shared database; migrating before draining old hosts leaves their schema-95 builds unable to reopen the shared file; partial gates change Claude or memory behavior anyway; parked state survives off/rollback; tests prove only the off configuration and not later enablement; all existing branch regression fixes and a large catch-up merge must coexist. `compaction.enabled: false` is not a useful umbrella gate because it also removes the requested Broca compaction.

**Avoided:** fast-Rust **default cutover/P2** with its existing switch; rescore S4 execution and future memory activation *only after explicit gates/scope acceptance*. It does **not** currently avoid signed-thinking work, v99 writer semantics, fleet context migrations, or the catch-up merge. New off-switches are product changes that need their own contract/gates; this report does not implement them.

### (c) Better deployment boundary, and the emergency-checkpoint alternative

**Best refinement: (a) as a ck-mc-only placement, not a fleet dist release.** Build the master-based provider subset, leave context.db 95 and all OpenCode/Pi distributions untouched, and restart/replace only the registered ck-mc process. This avoids turning a Broca delivery into a host migration ceremony. It adds roughly **one packaging/placement slice** to (a), not another implementation: version/build identity, offline build, module capability probe, paired backup/drain/restart, one operator-approved Broca worker-agent canary and documented rollback.

This uses the existing provider routes and private store. It does **not** invent a schema compatibility shim, create a second context.db, weaken fingerprints, or assume separate Broca/OpenCode copies of the registered module. A placed ck-mc serves its existing non-Broca callers too; legacy route/Claude/OpenCode regression tests remain required. The four methods are additional surface on the normal bound module (`crates/mc-module/src/providers/mod.rs:144-233`).

**Alternative for a true emergency:** build a reviewed pre-v98/v99/v100 checkpoint after S4 and its retry fixes, place only its ck-mc, and retain its genuine private-store migrations. Numerically newer context fences alone do not force a context upgrade, so an earlier fingerprint-compatible checkpoint could be validated at 95. This could reduce cherry-pick work, but it discards intervening master fixes, dependency changes and host safety improvements. S4's merge is already embedded in fast-Rust M1–M4 history, so this is **not** automatically the minimal v65 binary. Budget **1–3 extraction/validation days plus review** only if the checkpoint passes the same copied-v95/legacy gates; failure sends it back to (a). It avoids the newer hold/memory/rescore campaign and fast-Rust activation, but **postpones**, rather than solves, today's-master catch-up. No such checkpoint was built or certified in this report.

**Not better:** placing cc8617ec as-is while leaving context.db 95. Numeric fence tolerance is not schema compatibility. Also not better: a “Broca-only flag” on a shared registered binary while migrating the file to 100; old hosts still hit their global fence.

### Avoidance matrix

“Excluded” means no new code/schema from that unfinished campaign; it does not claim to fix master's existing defects. “Deferred” requires a genuine inactive interface and still carries landed state contracts.

| Unfinished item | (a) master-based minimal provider | (b) migration branch + gates | (c) binary-only (a) / emergency checkpoint |
| --- | --- | --- | --- |
| Signed-thinking hold, no general off-switch today | Excluded; retain master behavior and test Claude-family Broca validity. | **Not avoided today**; add/prove a real gate or finish the required safe behavior. Claude Code parking exclusion alone is insufficient. | Binary-only (a): excluded. Earlier checkpoint: excluded only if predating the hold. |
| Memory slice-3 redesign | Excluded; retain master memory semantics. | Future activation can be deferred, but v99/new writer semantics require explicit acceptance or legacy gate. | Binary-only (a): excluded. Checkpoint: choose pre-v99. |
| Rescore S4 | Excluded. | Executor can be deferred; sidecar/applied-score rollback contracts remain. | Excluded at the selected earlier boundary. |
| Fast-Rust OpenCode rebuild cost target | Exclude host pipeline; not a Broca release gate. | Existing `rust_pipeline: full_request` avoids default-cutover gate; no claim of meeting P2. | Same as (a), or keep earlier checkpoint host mode off. |
| Catch-up merge of today's master | Avoided by starting at master, with only targeted extraction reconciliation. | **Required**; 148 master-only commits at the inspected refs. | Binary-only (a): avoided. Emergency checkpoint: deferred/stale, not solved. |
| Fleet context.db v96–v100 migration | Avoided; remain at 95. | **Required**, flags do not suppress registered DDL. | Avoided only after copied-v95 compatibility proof. |

## 4. Recommendation and slices in order

Choose **the master-based minimal provider extraction (a), deployed by replacing only ck-mc as described in (c)**. Optimize for the earliest *verified provider binary*, not the earliest migration-branch version number. Start at the pinned current master (refresh the pin before implementation). Keep context-95 behavior as a non-negotiable release invariant.

1. **Pin and prune the extraction.** Confirm S1/S2 ancestry, compare S3/S4/follow-ups with current master, make a file/hunk dependency list. Keep host adapters, context schema fixture/fingerprints, memory writers and signed-thinking behavior from master. Establish the exact commons/Broca role compatibility and explicitly defer moves/fast-Rust/rescore/lifecycle activation.
2. **Private-store prerequisite slice.** Bring genuine v64 support needed by the existing fenced store code, then v65 durable provider records. Preserve migration IDs and old table layouts. Test fresh install, populated-v63 upgrade, crash/reopen and older-binary refusal; do not touch context.db migration history. If review chooses normalized v66 for a concrete Broca requirement, make it a separate measured slice rather than silently expanding to v68.
3. **S3 runner provider slice.** Port setup/step/declare/hook, record/catalog persistence, runner-bound tool join and catalog startup failure handling. Retain independent provider-runner route configuration. Prove runner plans cannot enter OpenCode's observation/serializer lane and answer/tag/version allocations remain restart-safe.
4. **S4 and correctness closure.** Port real-executable conformance, shared-byte fixture and fault controls; include deferred-history/accepted-view/transport fixes and current-output retries. Reconcile shared master fixes rather than overwriting the transform wholesale. Conformance has a genuine executable/router boundary, but scripted Broca, not Broca's implementation (`crates/mc-module/tests/broca_conformance/README.md:3-9,21-27`).
5. **Context-95 compatibility and non-Broca regression gate.** On isolated copies, boot the candidate with a real schema-95 context and representative v63 store; run all four runner methods, head/worker/reader, threshold/replacement/drop/protection, paging/wait, rejected answer, restart and revert/reconcile recovery. Exercise existing memory/tool/historian publication and pending context-write recovery too. Check schema ledger and sqlite schema before/after: context stays **95**, no v96–v100 objects appear, existing table fingerprints/writers remain valid. Test missing/incorrect single-store stamps separately. This is the gate that distinguishes a real compatibility claim from a green numeric fence.
6. **Build, review and ck-mc placement.** Required Rust scope: `cargo check -p mc-store -p mc-module`, relevant store/provider/engine tests, Linux `cargo test -p mc-module --test broca_conformance --features drive-fault`, module legacy regressions and repository fmt/clippy gates. Compare declared/catalog tool bytes and legacy Claude/OpenCode behavior. Build only the intended ck-mc release artifact, record its build/role/schema identities, take the paired backup, drain/restart the module, verify role descriptions and run an authorized Broca mason canary on the placed executable. Existing hosts must continue operating without context migrations or rebuilt dists.
7. **Rollback/cost observation.** Record prior binary + paired store/context backup and stop writers before restoring them. An old ck-mc with a v63 ceiling cannot open the newly migrated private store; swapping only the executable is not rollback (`crates/mc-store/src/lib.rs:8065-8083`). Observe actual Broca step/hook/record cost and Claude-family served-prefix validity; don't claim the OpenCode P2/24-hour canary was passed. Keep the remaining migration train separate for its own feature/schema release.

### Report verification and remaining gaps

This report is based on current source, reachable local Git history and table/route call inspection. The worktree preparation reported `bun run build` succeeded before this task, but that is **not** a compatibility gate for an extracted provider binary. No new candidate was built, no product tests were added, no live placement occurred and no production data was opened. The schema-95 integration run, real Broca caller/canary and release-size estimates remain prospective. Those are explicit delivery slices, not evidence already obtained.

Report validation checks citation paths/ranges, referenced local commits and report-only change scope. It does not substitute for the runtime gates listed above. This investigation used local repository evidence only; “current master” means the pinned local ref above, not a newly fetched remote branch.
