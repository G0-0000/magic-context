import { type ChildProcess, fork } from "node:child_process";
import { log } from "../../../shared/logger";
import type { EmbeddingFailure } from "./embedding-failure";
import type { LocalEmbeddingNativeMemoryStats } from "./embedding-local";

export type EmbeddingWorkerReply = {
    id: number;
    loaded: boolean;
    vectors?: (Float32Array | null)[];
    failure?: EmbeddingFailure | null;
    error?: string;
    stats?: LocalEmbeddingNativeMemoryStats;
};

// JSON IPC works in both Node and Bun; base64 preserves all float32 bits, including NaN and -0.
export type EmbeddingWorkerWireReply = Omit<EmbeddingWorkerReply, "vectors"> & {
    vectors?: (string | null)[];
};

let warnedWindowsTelemetry = false;

/** One model owner; a dead or unresponsive worker rejects every outstanding request. */
export class EmbeddingWorkerClient {
    private worker: ChildProcess | null = null;
    private nextId = 1;
    private readonly pending = new Map<
        number,
        {
            resolve: (reply: EmbeddingWorkerReply) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private disposed = false;

    constructor(
        private readonly data: Record<string, unknown>,
        private readonly entry = new URL(
            new URL(import.meta.url).pathname.endsWith(".ts")
                ? "./embedding-worker.ts"
                : "./embedding-worker.js",
            import.meta.url,
        ),
        private readonly timeoutMs = 5 * 60_000,
    ) {}

    private start(): ChildProcess {
        if (this.disposed) throw new Error("embedding worker disposed");
        if (this.worker) return this.worker;
        // Bun's process.env and Node workers' environment copies do not update native getenv.
        // Spawn with ORT_DISABLE_TELEMETRY=1 in the OS environment, before the addon is loaded.
        const worker = fork(
            new URL(
                new URL(import.meta.url).pathname.endsWith(".ts")
                    ? "./embedding-worker-process.ts"
                    : "./embedding-worker-process.js",
                import.meta.url,
            ),
            [],
            {
                env: {
                    ...process.env,
                    ORT_DISABLE_TELEMETRY: "1",
                    // Set BUN_BE_BUN so a compiled Bun executable runs the worker script, not the host app.
                    ...(process.versions.bun ? { BUN_BE_BUN: "1" } : {}),
                },
                execArgv: [],
                serialization: "json",
                stdio: ["ignore", "inherit", "inherit", "ipc"],
            },
        );
        if (process.platform === "win32" && this.data.runtimePreference !== "wasm") {
            // Windows uses Event Tracing for Windows (ETW); this environment opt-out only applies to POSIX uploads.
            if (!warnedWindowsTelemetry) {
                warnedWindowsTelemetry = true;
                const warning =
                    "[magic-context] ORT_DISABLE_TELEMETRY=1 prevents ONNX uploads on POSIX. Windows native ONNX uses OS-controlled ETW diagnostics instead and exposes no JavaScript telemetry-disable API; Windows diagnostic settings and trace collectors govern collection.";
                console.warn(warning);
                log(warning);
            }
        }
        this.worker = worker;
        worker.unref();
        worker.channel?.unref?.();
        worker.on("message", (wire: EmbeddingWorkerWireReply) => {
            const reply: EmbeddingWorkerReply = {
                ...wire,
                vectors: wire.vectors?.map((vector) =>
                    vector === null
                        ? null
                        : new Float32Array(Uint8Array.from(Buffer.from(vector, "base64")).buffer),
                ),
            };
            if (this.worker !== worker) return;
            const request = this.pending.get(reply.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(reply.id);
            if (reply.error) request.reject(new Error(reply.error));
            else request.resolve(reply);
            if (this.pending.size === 0) {
                worker.unref();
                worker.channel?.unref?.();
            }
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.worker = null;
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(error);
            }
            this.pending.clear();
            log("[magic-context] embedding worker exited unexpectedly:", error);
            worker.kill();
        };
        worker.on("error", fail);
        worker.on("exit", (code) => fail(new Error(`embedding worker exited (${code})`)));
        worker.send({ entry: this.entry.href, data: this.data });
        return worker;
    }

    isRunning(): boolean {
        return this.worker !== null;
    }

    request(texts?: string[], signal?: AbortSignal): Promise<EmbeddingWorkerReply> {
        if (signal?.aborted) return Promise.reject(new Error("embedding request aborted"));
        return new Promise((resolve, reject) => {
            const worker = this.start();
            const id = this.nextId++;
            // Loading may download a model; inference must still have a finite deadline.
            const timer = setTimeout(() => {
                void this.stop(new Error("embedding worker request timed out"));
            }, this.timeoutMs);
            const abort = () => {
                clearTimeout(timer);
                this.pending.delete(id);
                signal?.removeEventListener("abort", abort);
                reject(new Error("embedding request aborted"));
                if (this.pending.size === 0) {
                    worker.unref();
                    worker.channel?.unref?.();
                }
            };
            signal?.addEventListener("abort", abort, { once: true });
            const cleanup = () => signal?.removeEventListener("abort", abort);
            this.pending.set(id, {
                timer,
                resolve: (reply) => {
                    cleanup();
                    resolve(reply);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            });
            worker.ref();
            worker.channel?.ref?.();
            try {
                worker.send({ id, texts }, (error) => {
                    if (error && this.worker === worker) void this.stop(error);
                });
            } catch (error) {
                void this.stop(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private async stop(error: Error): Promise<void> {
        const worker = this.worker;
        this.worker = null;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        if (worker && worker.exitCode === null && worker.signalCode === null) {
            worker.ref();
            worker.channel?.ref?.();
            await new Promise<void>((resolve) => {
                worker.once("exit", () => resolve());
                worker.kill();
            });
        }
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop(new Error("embedding worker disposed"));
    }
}
