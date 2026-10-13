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
| macOS can use the same telemetry path | **Supported by source, not runtime-tested.** The POSIX telemetry sources and non-Windows 1DS linking include Apple builds when telemetry is enabled (`cmake/onnxruntime_common.cmake:61-70,271-368`). The generic CMake option defaults off (`cmake/CMakeLists.txt:169-175`); the privacy documentation says official builds enable it. No particular macOS artifact was inspected or executed. |

The reported assignment comes from the installed Transformers **4.3.0** source,
`src/backends/onnx-node.js:7-10`, not tracked Magic Context source. It is bundled
into the native Transformers chunks. There was no assignment owned by this
repository to remove. The redundant upstream write is retained: stripping it
would require rewriting dependency code during every build and adds no privacy
protection once the native environment is set at process birth.

## Implementation and choice

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

Linux arm64, macOS execution, and Windows execution were unavailable. Stock
OpenCode 1/2, Pi, and OMP were not launched; their shared embedding source and all
published build trees were checked, plus a compiled-Bun host probe. The exact
reported HTTP method/SDK header and a downloaded default trained model were not
reproduced. The privacy defect and suppression were demonstrated with an offline
native ONNX model, without sending actual telemetry.
