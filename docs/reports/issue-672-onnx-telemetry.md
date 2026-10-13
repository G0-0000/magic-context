# Issue 672: native ONNX telemetry opt-out

## Verdicts

Verified on the offline Linux x86_64 build server with Bun **1.4.2**, Node
**24.21.0**, and `onnxruntime-node` **1.30.0**:

| Claim | Result and evidence |
| --- | --- |
| A Bun `process.env` write reaches native `getenv` | **Refuted.** A native N-API probe returned `null` before and after the JavaScript write, in both the main thread and a worker. A separate Bun FFI `libc.setenv` probe did return `1`. |
| A Node `process.env` write reaches native `getenv` | **True in the main thread, false in a default worker.** The main-thread probe returned `1`; the worker probe returned `null`. Magic Context loads the model in a worker, so the Node-based Pi and Oh My Pi (OMP) extensions were affected too. |
| The Linux ORT package has telemetry that reads the variable | **Confirmed for the installed x86_64 binary.** Actual native model loads logged `NATIVE_GETENV ORT_DISABLE_TELEMETRY=<unset>`, created a device ID, and attempted to resolve `mobile.events.data.microsoft.com`. |
| Loading through Magic Context attempts an upload | **Confirmed at the destination-attempt boundary.** The real `LocalEmbeddingProvider`/embedding-worker/Transformers pipeline loaded a native ONNX session and produced `[1]`. With the original direct-worker transport, both runtimes attempted the Microsoft collector hostname; native DNS was blocked before a connection or payload could leave. The collector URL is set in upstream `posix/telemetry.cc:463-465`. We did not capture the HTTP POST or SDK header because DNS was intentionally denied. |
| A persistent device ID is created | **Confirmed in both baselines.** Each created `cache/Microsoft/DeveloperTools/.onnxruntime/deviceid` under its throwaway `XDG_CACHE_HOME`. The startup-opt-out and fixed runs created none. |
| Setting the variable before starting the process fixes it | **Confirmed on both runtimes.** Direct-worker controls launched with `ORT_DISABLE_TELEMETRY=1` showed native `getenv=1`, no outbound attempt, and no device ID. |
| macOS can use the same telemetry path | **Confirmed on macOS arm64 in the follow-up below.** Source includes Apple builds in the POSIX telemetry path (`cmake/onnxruntime_common.cmake:61-70,271-368`). The generic CMake option defaults off; the executed Node-package artifact included the uploader and created a device ID in the positive control. |

The reported assignment comes from the installed Transformers **4.3.0** source,
`src/backends/onnx-node.js:7-10`, not tracked Magic Context source. It is bundled
into the native Transformers chunks. There was no assignment owned by this
repository to remove. The redundant upstream write is retained: stripping it
would require rewriting dependency code during every build and adds no privacy
protection once the native environment is set at process birth.

## Initial subprocess implementation (superseded as the default below)

The model worker now lives in a dedicated subprocess forked with
`ORT_DISABLE_TELEMETRY=1` in its startup environment. The subprocess retains the
existing worker thread, model ownership, batching, cancellation, timeouts, lazy
restart, and idle-unref behavior. The parent disconnect terminates the subprocess.
JSON IPC uses base64 buffers to preserve float32 bits, including negative zero,
NaN, and infinities. All three package build directories ship the subprocess bootstrap:
OpenCode v1, OpenCode v2, and Pi/OMP. `BUN_BE_BUN=1` makes compiled Bun hosts run
the bootstrap as Bun rather than restarting the host application.

This avoids platform-specific libc loading and CRT assumptions. POSIX Bun FFI
`setenv` worked in an isolated probe, but would not solve Node's worker-local
environment copies without a native addon or assumptions about the caller's
thread. A child startup environment addresses both runtimes using existing Node
APIs. It adds one runtime process per loaded embedding provider; the model is
still loaded only once per provider, not once per request.

ORT's C API has `DisableTelemetryEvents`, but the Node binding exports observed
on Linux were only `InferenceSession`, `listSupportedBackends`, and `initOrtOnce`.
The installed Node/common declarations and upstream N-API wrapper expose no
telemetry-disabling method or session/environment setting. Calling the C API
would also be too late to guarantee prevention of initialization events
(`docs/Privacy.md:24-30`).

### Windows boundary

**Native performance is retained on Windows; there is no automatic WASM downgrade.**
The subprocess sets the environment there too, but a one-time message makes clear
that the variable disables POSIX uploads, not collection of native events through
Event Tracing for Windows (ETW).

Pinned ORT v1.30.0 source and documentation establish this platform distinction:

- `onnxruntime/core/platform/windows/telemetry.cc:20-32` includes ETW/TraceLogging;
  `259-274` registers the provider; `376-391,488-519` emit TraceLogging events.
- `cmake/onnxruntime_common.cmake:271-284` links the 1DS upload SDK only under
  `onnxruntime_USE_TELEMETRY AND NOT WIN32`.
- `docs/Privacy.md:8-20,24-30` describes Windows' built-in ETW mechanism, possible
  OS transmission based on user consent, and recording only when an external
  trace session collects. This is not ORT's own Windows network uploader.
- `onnxruntime/core/platform/telemetry_environment.h:110-117` explicitly says
  Windows ETW does not consult `ORT_DISABLE_TELEMETRY`.
- `js/node/src/inference_session_wrap.cc:15-40` lists N-API session members without
  a telemetry disable method. `js/common/lib/inference-session.ts:46-186` and the
  installed common environment declarations expose no equivalent option.

Windows diagnostic settings govern the OS diagnostic pipeline; external trace
collectors can separately collect/export ETW events. We cannot guarantee all
collector behavior or disable ETW through the current ORT JavaScript API. Users
who require no native ETW provider can explicitly choose `local_runtime: "wasm"`.
Windows behavior was researched from source, not executed on a Windows host.

Upstream references are pinned to
[`microsoft/onnxruntime/v1.30.0`](https://github.com/microsoft/onnxruntime/tree/v1.30.0).

## Reproducible verification

Run `bash scripts/probe-onnx-telemetry.sh` on Linux with Bun, Node, a C compiler,
Node development headers, Python, and strace. It generates a tiny offline
BERT-shaped ONNX graph and tokenizer; there are no trained weights or downloads.
This is real native session creation and feature-extraction inference through
Magic Context, not a mocked pipeline or a test of embedding quality.

Every real load observes **65 seconds** after inference. Three seconds was
insufficient: ORT selects the SDK's BestEffort batching profile
(`posix/telemetry.cc:527-529`). Native `getaddrinfo` and IP `connect` are denied
before ORT loads, and strace records network syscalls across descendants. All
HOME/XDG paths and queued telemetry are disposable; no live stores are opened.
The offline server supplies an additional egress barrier. Its helper shell
printed a preload-path warning in the Bun baseline; the native ORT process itself
successfully logged the getenv and blocked collector DNS observations.

Final integration result:

- 2 native-environment probes (Bun and Node main/worker distinctions above).
- 2 positive baseline controls: collector destination attempted and blocked,
  one device ID each, native inference succeeded.
- 5 opted-out real loads: Bun/Node startup controls, Bun/Node fixed provider,
  and a compiled Bun host dynamically loading the provider from disk.
- Every opted-out load: native `getenv=1`, `[1]` inference, zero outbound DNS/IP
  connection or send attempts, zero device IDs. Unix IPC/name-service sockets
  are not mistaken for outbound traffic.

Additional gates: root typecheck (TypeScript 5.9.3), root build (Bun 1.4.2),
local/provider/transport/install-shape tests (49 passed, 176 assertions), the built
Node-WASM filesystem cache probe (1 passed), and targeted Biome 2.5.1 checks
(5 source files and 1 manifest). Frozen install checked 999 installs
across 1254 packages without changes. The standalone existing
`transformers-node-wasm.test.ts` failed because its `/motor-home/tmp` output could
not resolve `onnxruntime-web/webgpu`; neither that test nor its build helper was
modified. The same built package probe passed in its normal dist location.

### Mutation proof

The live implementation was staged, with an empty unstaged `git diff --stat`.
The subprocess's `ORT_DISABLE_TELEMETRY` startup value was changed from `1` to `0`
to neutralize the native opt-out and prove the test detects its absence. The
intentional-mutation marker was present only during the failing run. The mutation showed:

```text
embedding-worker-client.ts | 2 +-
1 file changed, 1 insertion(+), 1 deletion(-)
(fail) embedding worker transport > native getenv sees telemetry disabled before the model worker initializes
Expected: 1
Received: 0
9 pass, 1 fail; 30 expect() calls; 10 tests
```

The nine tests that still passed with the opt-out neutralized were:

- worker inherits the resolved model cache, harness and trusted-group permission policy
- provider reports worker crashes and recovers lazily without changing its interface
- old Bun worker teardown protection also overrides explicit native
- host timers remain responsive during a synchronous large batch
- transferred vectors preserve float32 bits
- worker crash rejects outstanding requests and a later request recovers
- unresponsive worker times out all pending callers and restarts on the next request
- aborted caller settles without waiting for inference
- idle worker does not prevent clean process exit

Restoration used `git checkout -- embedding-worker-client.ts` followed by `touch`;
the unstaged diff was empty again. The restored regression tests and native ONNX
model loads through the provider passed.

## Limits

Linux arm64 and Windows execution remain unavailable. Stock OpenCode 1/2, Pi,
and OMP were not launched; their shared embedding source and all published build
trees were checked, plus a compiled-Bun host probe. The exact reported HTTP
method/SDK header was not captured because DNS was denied. The follow-up below
adds macOS execution, the default trained model's Linux benchmark, native-model
host-death checks, and actual npm package file-list comparisons.

## Follow-up: macOS, cost, failure handling, and package contents

### macOS native execution

`bash scripts/probe-onnx-telemetry-macos.sh` ran **locally**, on Darwin 27 arm64,
with Bun **1.4.2**, Node **26.10.0**, and Apple clang **21.0.0**. Each case had a
throwaway HOME, XDG_CACHE_HOME, and TMPDIR. A dyld interposer logged native getenv
calls and blocked DNS/IP connections; a Seatbelt profile additionally denied
outbound networking and writes under the real home.

| Case | Native ORT getenv | Inference | Device IDs after load | Device IDs after 65 s |
| --- | --- | --- | --- | --- |
| Bun original direct worker | unset | native `[1]` | 1 | 1 |
| Bun subprocess | 1 | native `[1]` | 0 | 0 |
| Node subprocess | 1 | native `[1]` | 0 | 0 |

The positive control attempted `mobile.events.data.microsoft.com`, which the
interposer blocked. It created
`HOME/Library/Application Support/Microsoft/DeveloperTools/.onnxruntime/deviceid`.
This **macOS artifact does include the uploader**. ORT's Apple path uses absolute
HOME and appends `Library/Application Support`, ignoring XDG_CACHE_HOME on Apple
(`posix/device_id.cc:280-317`, `device_id.h:62-64`). Neither fixed case made an
outbound attempt. Native process-start observations were distinguished by PID
from ORT's later getenv calls, so the child, not just the host, was observed.

The enabled SDK's Cocoa cache initialization attempted the real user's generic
Bun HTTP-cache directory; Seatbelt denied those writes. No live OpenCode or Magic
Context stores were opened. All generated telemetry files were disposable.

### Linux cost: default trained model

`bash scripts/probe-embedding-transport.sh` ran on `linux,4c`, x86_64, with Bun
1.4.2, Node 24.21.0, and ORT 1.30.0. The default **Xenova/all-MiniLM-L6-v2 fp32**
model was downloaded locally and copied into the offline job, not fetched by the
Linux runner. Its ONNX file is 90,387,606 bytes, SHA-256
`759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e`.
Both transports returned actual 384-dimensional embeddings.

Each fresh scenario measured owner creation to first embedding, followed by five
warm-ups and **200 sequential batches of two typical memory/message texts**.
The baseline directly starts the same embedding worker, so model code and
inference options are shared. Telemetry was disabled at process birth for both.

| Runtime / transport | Cold to first embedding (ms) | Batch p50 (ms) | Batch p95 (ms) | Parent RSS (MiB) | Model child RSS (MiB) | Total RSS (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bun / direct worker | 414.00 | 78.60 | 109.41 | 320.29 | 0 | 320.29 |
| Bun / subprocess | 498.62 | 85.90 | 113.15 | 42.36 | 344.91 | 387.27 |
| Node / direct worker | 482.21 | 75.87 | 99.00 | 324.11 | 0 | 324.11 |
| Node / subprocess | 477.36 | 76.67 | 104.22 | 53.24 | 352.76 | 406.00 |

The final run's subprocess deltas are **+7.30 ms p50 / +3.73 ms p95 / +66.99 MiB
RSS for Bun**, and **+0.80 ms p50 / +5.22 ms p95 / +81.88 MiB RSS for Node**.
Cold latency was noisy: an earlier exploratory run measured Bun 441.33 vs 451.49
ms, and Node 448.07 vs 477.11 ms. Do not infer a stable Node cold-start speedup
from the final sample, or treat these single-run deltas as a statistical bound.

These are process-cold, not disk-cold, measurements; host program startup,
parent-side module imports, and downloads are excluded. RSS was sampled after
batch 200, sums both processes, and double-counts shared pages rather than
measuring unique physical memory/PSS. Default ORT threading was retained; the
four-vCPU sandbox emitted CPU-affinity warnings. Reproducible summary numbers
are retained in `issue-672-transport-benchmark.json`. The extra runtime's memory
cost is material and should be considered when many providers are loaded.

### Crashes, kills, and host death

The transport probe passed **five checks per runtime on both Linux and macOS**:

1. A worker exit with code 7 rejects both outstanding requests; the next request
   lazily creates a replacement and returns a valid result.
2. SIGKILL of the model subprocess rejects both outstanding requests; the next
   request restarts successfully. The follow-up improves the diagnostic from
   `exited (null)` to `exited (SIGKILL)` and adds a focused regression test.
3. Normal idle host exit leaves no live model subprocess.
4. Explicit `process.exit(0)` leaves no live model subprocess.
5. SIGKILL of the host leaves no live model subprocess.

Host-death cases loaded and inferred with the **trained native model** before
exiting/killing the host. Both Bun and Node model owners stopped within the
probe's first ~0–23 ms observation interval after host exit, well inside its
five-second deadline. Linux zombies, if present pending init reaping, are treated
as stopped, not live runtimes; the test does not claim a PID has been reaped merely
because it stopped running.

The kernel closes the host's IPC endpoint on death. The existing child-side
`disconnect` handler exits the whole model process, including its worker thread.
**No SIGKILL-surviving live orphan was observed**, so no additional parent-death
polling/watch was introduced. If a future runtime loses IPC-disconnect delivery,
the fallback would compare `process.ppid` with the expected parent PID captured
at launch, exiting on reparenting, alongside the IPC check; a simple `kill(pid,0)`
watch alone is insufficient because of PID reuse.

Non-vacuity control: the source changes were first staged to save the verified
implementation in Git's index, leaving the unstaged diff empty. Then
the disconnect handler was temporarily neutralized. The unstaged diff showed one
file, one insertion and one deletion. **`host-death idle (bun)` failed**, naming a
surviving native model subprocess after five seconds. `subprocess-death crash`
and `subprocess-death SIGKILL` still passed; later host cases and the Node phase
were not reached. The probe killed the intentional orphan. The handler was
restored with checkout plus touch, the unstaged diff returned to empty, and all
lifecycle cases passed afterward.

### Manifest changes and actual npm file lists

The original privacy fix changes only build/clean scripts, not dependencies,
exports, package versions, or `files` allowlists:

- Plugin `build`: adds `embedding-worker-process.ts` as an explicit entry so
  `dist/embedding-worker-process.js` is emitted beside the v1 worker.
- Plugin `build:v2`: adds the same entry for `dist/v2`, and adds its output to the
  pre-build cleanup list so a stale subprocess entry is not retained.
- Plugin `clean`: removes the subprocess entry from both v1 and v2 output trees.
- Pi plugin `build`: adds the shared subprocess source as an entry, and cleans a
  previous `dist/embedding-worker-process.js` before regenerating it.
- Pi plugin `clean`: removes that output alongside the embedding worker.

`ORT_PACK_REPORT_DIR=docs/reports bash scripts/probe-embedding-pack.sh` performed
clean builds in disposable directories **inside this worktree**, using Git
archives rather than switching branches. It ran `npm pack --dry-run --json`
with npm **11.19.1** for each package at the baseline and updated source: four
actual dry runs. Fresh trees avoid counting stale content-hashed chunks left by
normal development builds.

| Package | Baseline files | Updated files | Raw paths added / removed | Added stable paths |
| --- | ---: | ---: | --- | --- |
| OpenCode plugin | 1763 | 1769 | 53 / 47 | `dist/embedding-worker-process.js`, `dist/v2/embedding-worker-process.js`, declarations/maps for `embedding-worker-process` and `onnx-telemetry` |
| Pi/OMP plugin | 77 | 78 | 14 / 13 | `dist/embedding-worker-process.js` |

There are no removed stable paths. Other raw changes are content-hashed split
chunk renames, which are expected when the transport source changes. Full added
and removed path lists are committed in `issue-672-pack-plugin.json` and
`issue-672-pack-pi-plugin.json`; the script explicitly asserts all three published
subprocess entry paths. The unchanged `files: ["dist", ...]` allowlists include
them, and the prepublish-only hook is not substituted for an actual pack dry run.

## Current design: in-process preparation where it works

The default no longer allocates a second runtime process for ordinary Bun or
main-thread Node hosts. Before creating the existing model worker, the client:

- **Node main thread:** assigns `process.env.ORT_DISABLE_TELEMETRY = "1"`.
  The new worker has **no explicit env override**. Its native ORT `getenv`
  observes the main process's updated libc environment even though its JavaScript
  `process.env` is a separate copy.
- **Ordinary Bun:** dynamically imports `bun:ffi`, calls libc `setenv` with
  overwrite enabled, and verifies the result with native `getenv` before creating
  the worker. macOS uses `/usr/lib/libSystem.B.dylib`; Linux first tries
  `libc.so.6`, with a musl loader candidate if unavailable. No universal library
  path is assumed: import/load/symbol/setter failures select the protected
  subprocess fallback. The dynamic import is externalized and optional under
  Node, with a narrow local API type rather than requiring Bun ambient types in
  the Node-only Pi package.

The client deduplicates concurrent startup and checks disposal after asynchronous
preparation, so two first requests do not create two owners and disposal cannot
leave a late worker. Structured-clone float32 transfer is retained for direct
workers; the existing base64 IPC codec is used only by subprocesses.

### Concrete evaluation matrix

| Host | Linux | macOS arm64 | Production choice |
| --- | --- | --- | --- |
| Node main thread | native getenv=1, native inference, no ID/attempt for 65 s | same | direct worker |
| Ordinary Bun 1.4.2 | native getenv=1, native inference, no ID/attempt for 65 s | same | direct worker |
| Compiled Bun 1.4.2, raw disk worker | native setter succeeds, but model import fails | native getter confirms 1, but model import fails | retain subprocess |
| Compiled Bun 1.4.2, protected subprocess | native getenv=1, native inference, no ID/attempt for 65 s | same | fallback passed |

The original unprotected direct-worker controls still created a device ID and
attempted the blocked collector hostname on both platforms. Thus the direct
worker's absence of telemetry is not explained by an uploader-free runtime.
The normal Node worker inherits native state from the main thread; it does not
need SHARE_ENV or a JavaScript worker-local setter.

**The compiled failure is not a libc-setenv failure.** A compiled executable
using FFI successfully changed native getenv to 1 on macOS. On both Linux and
macOS, its direct disk worker then failed before session creation:

```text
Cannot find package 'sharp' imported from .../dist/transformers.node-7tx13786.js
```

The same macOS compiled direct-worker control failed without any setter. Sharp
was installed and ordinary Bun/Node resolved it; placing dependency symlinks at
both the bundle directory and its ancestor did not fix the compiled case. The
existing subprocess with `BUN_BE_BUN=1` loaded the same worker/model successfully.
We did not invent a module-resolution shim or claim an exact Bun loader root
cause from this evidence. Because native inference could not be verified in that
compiled-worker configuration, compiled Bun conservatively keeps the subprocess.
This still costs the extra runtime memory in stock compiled OpenCode-style hosts.

A second exceptional case is a **Node host already executing inside a worker**:
its `process.env` writes are not native writes, so preparation refuses that path
and retains subprocess isolation rather than pretending that setting worked.
Bun FFI availability or libc failures likewise retain isolation. Musl behavior
and Windows execution were not tested; the existing Windows ETW warning and
native-performance decision remain unchanged. No automatic WASM downgrade was
introduced.

These exceptions mean the subprocess entry, lifecycle cleanup, and packed-file
checks remain necessary. Its lifecycle probe now explicitly selects the fallback,
so its crash/SIGKILL/orphan checks still exercise that path instead of accidentally
killing an in-process test runner. The package build scripts additionally keep
`bun:ffi` external in each Node-targeted native bundle.

### Memory comparison against the original worker

A new Linux four-vCPU run used the same trained fp32 MiniLM model and 200 batches
of two texts per scenario. Both the original worker and the updated ordinary
Bun/Node path had **zero model child processes**:

| Runtime / path | Cold (ms) | p50 (ms) | p95 (ms) | RSS (MiB) | Extra model processes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bun original worker | 461.65 | 105.66 | 144.19 | 336.76 | 0 |
| Bun native-env worker | 505.63 | 100.19 | 148.36 | 341.34 | 0 |
| Node original worker | 512.26 | 97.30 | 133.98 | 312.90 | 0 |
| Node main-env worker | 643.08 | 94.28 | 123.07 | 299.93 | 0 |

The measured RSS differences were **+4.57 MiB for Bun and -12.97 MiB for Node**,
within allocator/process-run variation rather than the previous fixed second
runtime's 67–82 MiB. This is not a claim that the fix saves 13 MiB under Node or
has exactly zero byte overhead. The important structural difference is that no
second process is allocated in these main-thread cases. Full numeric summaries
are in `issue-672-in-process-benchmark.json`; the prior subprocess measurements
remain historical evidence for the retained exceptional path.

### Strengthened mutation-checked test

The native-getenv regression now launches a **fresh Bun process with native
ORT_DISABLE_TELEMETRY=0**. A native addon reads getenv inside the model worker at
module initialization. The test requires 1 and also requires worker PID = host
PID, so a subprocess fallback cannot pass as evidence for the direct-worker fix.

After staging the live implementation, a marked mutation bypassed both native
setenv and its confirmation while falsely returning success. Only
`native getenv sees telemetry disabled before the model worker initializes`
failed: expected 1, received 0. The other eleven transport tests, including the
new concurrent-start/dispose race and the forced subprocess-kill test, passed.
The mutated helper diff was one insertion and three deletions in
`onnx-telemetry.ts`; checkout plus touch restored an empty unstaged diff.
