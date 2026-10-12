# Issue 666: OpenCode 2 generate replay after tools

## Real-host reproduction

Tested the unchanged 0.48.0 plugin first, then the patched plugin, on freshly
installed **`@opencode/cli@2.0.27`**, the newest stable release available at the
time of the run. Both arms used a real OpenCode server and the repository's mock
OpenAI Responses provider. The provider retained the literal HTTP request bodies.
No OpenCode source or message-building shim was substituted.

The regression test seeds a history compartment and a dropped older tool output,
then runs another turn with a successful host `shell` call followed by its final
runner request. It invokes `POST /api/session/:id/generate`, the request path used
by `/btw`, after that turn finishes. Hook probes confirm that the final runner
draft ends in a `role: "tool"` message without an ID.

**The reproduced branch was `capture`'s `no-anchor` skip, not an `apply` false
exit.** The preceding first-step capture was still present, the model and agent
matched, and its user-message anchor was still in the generate draft. The stale
first-step prefix was therefore applied. Its appended raw tool output lacked the
tag that Magic Context had served in the final runner request:

| Wire field | Last runner request | Baseline `/btw` | Patched `/btw` |
| --- | --- | --- | --- |
| Final `function_call_output.output` | `§5§ RAW-final-OUTPUT` | `RAW-final-OUTPUT` | `§5§ RAW-final-OUTPUT` |
| Runner body bytes | 37,718 | — | — |
| `/btw` body bytes | — | 37,962 | 37,968 |
| Literal runner history prefix reproduced | — | no, diverges at byte 862 | yes, all 886 bytes |
| Raw `instructions` and `tools` values | — | identical to that arm's runner | identical to that arm's runner |

This reproduces the stale-snapshot cache miss. It does **not** establish which
false exit occurred in the reporter's 306K-token session, or reproduce that
session's token counts. The mock demonstrates cache-prefix eligibility, not
actual cached-token usage from a paid provider.

## Implementation

`generateReplayAnchor` captures the last identified host message and clones every
id-less message after it **before** Magic Context tags or drops tool results.
The context hook snapshots the final served system, history and tools on every
enabled context call, including calls without a history head and tool-loop steps.

`apply` finds the saved ID in the new host draft, validates the exact original
id-less tail, and cuts after that tail. It then replaces the prefix with the
served snapshot and keeps only the genuinely new assistant/side-question tail.
Comparing the original host tail, rather than the transformed tail, allows
tagged and dropped tool outputs to replay without duplication. Tail validation
also prevents a checkpoint from causing a new side question to be consumed as
old history. An unanchorable capture discards any older snapshot.

Every capture skip and every false return from `apply` emits one persistent
`sessionLog` line: `no-anchor`, `no-prefix`, `model-mismatch`, `agent-mismatch`,
`anchor-not-found`, or `anchor-tail-mismatch`. Disabled context capture also
logs `compaction-disabled`. The parent explicitly chose plain persistent lines,
without a `[DEBUG]` marker: the existing logger and OpenCode 2 plugin API have no
log-level facility. Shared logging and host stdout are unchanged.

## Wire and isolation evidence

Committed captures are under [`gate-evidence/issue-666`](../../gate-evidence/issue-666/):

- `before-runner.json`, `before-btw.json`, `after-runner.json`, `after-btw.json`:
  exact provider request payloads, not normalized or reserialized snapshots.
- `differential.json`: byte counts, first divergence, independent prefix hashes,
  raw instructions/tools hashes, and the relevant tool-result values.
- `before-diagnostic.json`, `after-diagnostic.json`: hook-based reconstruction of
  the last-message-ID-only implementation's capture/apply decisions. The
  `lastIdOnly*` fields in the after record are counterfactual baseline decisions,
  not skip events from the patched implementation.
- `before-lsof.txt`, `after-lsof.txt`: complete `lsof -p <host pid> -Fn` inventories.
- `audit-captures.mjs`: repeatable independent byte-buffer checks against these
  saved HTTP payloads and descriptor inventories (34 assertions).

The prefix comparison includes the literal body through the last served `input`
item; the array's closing bracket is JSON framing, since `/btw` appends new items.
Raw `instructions` and `tools` are separately byte-compared in full. Requests
from different arms have different session IDs and throwaway paths; equality is
checked **within each arm**, with no normalization of either request.

The after-prefix SHA-256 is identical in both captured requests:
`8de05448b6f8edef00a2ecb4acb83e707b3382b4d3955beb90864860c20a9613`.

All host launches used throwaway HOME, XDG data/config/state/cache/runtime,
OpenCode DB and Magic Context storage paths under `$TMPDIR/magic-context/`.
The runner checks open descriptors at startup; the retained before/after `lsof`
inventories show only the isolated `opencode2.db`, `context.db`, and their WAL/SHM
handles. No live store or live configuration was opened, copied, migrated, or
hashed. Package unit suites did not export `OPENCODE_DB`. Host processes were
stopped, and the temporary installs, stores and working roots were removed after
the evidence was retained.

## Verification

- Linux, 8 vCPUs, Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1:
  `bun run build && bun run --cwd packages/plugin typecheck && bun run --cwd packages/plugin lint && bun run --cwd packages/plugin test`.
  Build and typecheck passed. Lint checked 1,378 files with no errors (10 existing
  warnings and 6 informational notices). Suite: **7,711 passed, 27 skipped,
  1 failed** across 781 files. The sole remaining known baseline failure was
  `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`,
  unable to resolve `onnxruntime-web/webgpu`. All worker-bundle tests passed once
  the build and suite ran in the same remote job.
- Focused Linux replay tests after mutation restore: **5 passed**, 34 assertions.
- Linux retained-capture audit, Node 24.21.0: **34 assertions passed**.
- Mac, Bun 1.4.2, OpenCode 2.0.27: `bun run build:v2`, then the new
  `generate-tool-tail.test.ts` and existing `generate.test.ts`: **2 passed**, 62
  assertions. The existing host test also confirmed no Magic Context DB writes,
  identical repeated generate bodies, and next-main-request parity with and
  without generate.
- Changed-file diagnostics: no errors or warnings; two existing deprecated-SQL
  hints in the perf script. Analysis categories unrelated to diagnostics were
  unavailable in the checkout's call-graph view.
- The additional repository-wide E2E `tsc` invocation found unrelated existing
  errors (Bun SQLite versus BetterSqlite3 types, ES2023 APIs under ES2022, and
  other old tests/imports). It reported none in the new host regression file;
  the plugin's authoritative typecheck passed.

The required mutation restored `const id = messages.at(-1)?.id` in
`generateReplayAnchor`, marked `NON-VACUITY BREAK`. Exactly
`generate captures the final request with id-less tool tails without duplicating them`
failed (`expected "a", received undefined`); the other four replay tests passed.
The live implementation was staged before mutation, the mutation produced a
nonempty one-file diff, and `git checkout -- <path> && touch <path>` restored an
empty unstaged diff. The five-test suite then passed again.

## Repeat

Install a current stable `@opencode/cli` in a throwaway root (do not change the
repository's dependency pins), build the plugin locally, and run:

```sh
MC_E2E_OPENCODE2_CLI="$THROWAWAY/host/node_modules/.bin/opencode" \
  bun test packages/e2e-tests/tests/opencode2/generate-tool-tail.test.ts
node gate-evidence/issue-666/audit-captures.mjs
```

The regression test creates its own isolated stores and prints the capture root.
Do not export `OPENCODE_DB` for package unit tests. Keep host runs on macOS;
run the package gates on Linux, building worker bundles in the same remote job
as the full suite.
