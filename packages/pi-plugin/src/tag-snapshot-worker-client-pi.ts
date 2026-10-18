import { setImmediate as yieldImmediate } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { inRootAsyncContext } from "@magic-context/core/shared/sqlite";
import {
	createPiTagSnapshotCandidate,
	type PiFallbackTagRow,
	type PiSnapshotTag,
	type PiTagSnapshotCandidate,
} from "./tag-snapshot-pi";

export interface PiHydrationGeneration {
	revision: string;
	durable: number;
}

export interface PiHydrationRequest {
	path: string;
	sessionId: string;
	connectionEpoch: number;
	sessionEpoch: number;
	jobId: number;
	/** Internal fixture controls; production callers leave these unset. */
	test?: { pageDelayMs?: number; crash?: "before-end" | "after-end" };
}

export type PiHydrationStream = "tags" | "fallback";
export type PiHydrationMessage = {
	jobId: number;
	sessionId: string;
	connectionEpoch: number;
	sessionEpoch: number;
	sequence: number;
	generation: PiHydrationGeneration;
} & (
	| {
			type: "packet";
			stream: PiHydrationStream;
			bytes: ArrayBuffer;
			rows: number;
	  }
	| { type: "end"; stream: PiHydrationStream; rows: number }
	| {
			type: "done";
			maxReadTransactionMs: number;
			packetCount: number;
			packetBytes: number;
	  }
	| { type: "failed"; reason: string; code: "failed" | "stale" | "schema" }
);

export type PiHydrationOperation =
	| { type: "row"; value: PiSnapshotTag | PiFallbackTagRow }
	| {
			type: "field";
			key: string;
			value: unknown;
			append: boolean;
			totalLength?: number;
	  }
	| { type: "row-end" };

export class PiTagHydrationError extends Error {
	constructor(
		message: string,
		readonly code: "failed" | "stale" | "schema" | "deadline" = "failed",
	) {
		super(`Pi tag hydration: ${message}`);
		this.name = "PiTagHydrationError";
	}
}

export interface PiHydrationTelemetry {
	maxReadTransactionMs: number;
	maxAssemblyMs: number;
	packetCount: number;
	packetBytes: number;
	jobMs: number;
}

/** One credited packet at a time; incomplete arrays never leave this consumer. */
export function createPiHydrationPacketConsumer(
	request: PiHydrationRequest,
	cached: readonly PiSnapshotTag[] = [],
	byteLimit?: number,
) {
	const assembly = createPiTagSnapshotCandidate(cached, byteLimit);
	let sequence = 0;
	let generation: PiHydrationGeneration | undefined;
	let busy = false;
	let rejected = false;
	let stream: PiHydrationStream = "tags";
	let tagsEnded = false;
	let fallbackEnded = false;
	let fragment: Record<string, unknown> | undefined;
	let fragmentBytes = 0;
	const byteOffsets = new Map<string, number>();
	let streamRows = 0;
	let maxAssemblyMs = 0;
	let done = false;
	const fail = (message: string): never => {
		rejected = true;
		throw new PiTagHydrationError(message);
	};
	return {
		async consume(
			message: PiHydrationMessage,
		): Promise<PiTagSnapshotCandidate | null> {
			if (busy || rejected || done)
				return fail("packet after completion or without credit");
			if (
				message.jobId !== request.jobId ||
				message.sessionId !== request.sessionId ||
				message.connectionEpoch !== request.connectionEpoch ||
				message.sessionEpoch !== request.sessionEpoch ||
				message.sequence !== sequence++
			)
				return fail("packet sequence or lifetime mismatch");
			if (message.type === "failed") {
				rejected = true;
				throw new PiTagHydrationError(message.reason, message.code);
			}
			if (
				generation &&
				(generation.revision !== message.generation.revision ||
					generation.durable !== message.generation.durable)
			)
				return fail("packet generation mismatch");
			generation ??= message.generation;
			if (message.type === "done") {
				if (!tagsEnded || !fallbackEnded || fragment)
					return fail("completion before both streams ended");
				done = true;
				return assembly.finish();
			}
			if (message.stream !== stream || fallbackEnded)
				return fail("stream order mismatch");
			if (message.type === "end") {
				if (fragment || message.rows !== streamRows)
					return fail("incomplete row or stream count mismatch");
				assembly.end(stream);
				if (stream === "tags") {
					tagsEnded = true;
					stream = "fallback";
				} else fallbackEnded = true;
				streamRows = 0;
				return null;
			}
			if (
				!(message.bytes instanceof ArrayBuffer) ||
				message.bytes.byteLength > 65_536 ||
				message.rows > 256
			)
				return fail("packet exceeds credit limits");
			busy = true;
			let started = performance.now();
			let packetRows = 0;
			const append = (row: PiSnapshotTag | PiFallbackTagRow) => {
				if (stream === "tags") assembly.appendTag(row as PiSnapshotTag);
				else assembly.appendFallback(row as PiFallbackTagRow);
				streamRows++;
				packetRows++;
			};
			try {
				const bytes = new Uint8Array(message.bytes);
				const view = new DataView(message.bytes);
				for (let offset = 0; offset < bytes.length; ) {
					if (offset + 4 > bytes.length) return fail("truncated frame length");
					const length = view.getUint32(offset);
					offset += 4;
					if (length === 0 || offset + length > bytes.length)
						return fail("truncated frame");
					const operation = deserialize(
						bytes.subarray(offset, offset + length),
					) as PiHydrationOperation;
					offset += length;
					if (operation.type === "row") {
						if (fragment) return fail("whole row inside fragments");
						append(operation.value);
					} else if (operation.type === "field") {
						if (!fragment) fragmentBytes = 384;
						fragment ??= Object.create(null) as Record<string, unknown>;
						const value = operation.value;
						fragmentBytes +=
							typeof value === "string"
								? 24 + value.length * 2
								: value instanceof Uint8Array
									? value.length
									: 8;
						if (
							assembly.estimatedBytes + fragmentBytes >
							(byteLimit ?? 128 * 1024 * 1024)
						)
							return fail(
								"candidate memory limit exceeded during field assembly",
							);
						if (operation.append) {
							const prior = fragment[operation.key];
							if (
								typeof prior === "string" &&
								typeof operation.value === "string"
							)
								fragment[operation.key] = prior + operation.value;
							else if (
								prior instanceof Uint8Array &&
								operation.value instanceof Uint8Array
							) {
								const offset = byteOffsets.get(operation.key);
								if (
									offset === undefined ||
									offset + operation.value.length > prior.length
								)
									return fail("invalid binary field length");
								prior.set(operation.value, offset);
								byteOffsets.set(operation.key, offset + operation.value.length);
							} else return fail("invalid field fragment");
						} else if (value instanceof Uint8Array) {
							const length = operation.totalLength ?? value.length;
							if (
								length < value.length ||
								length > (byteLimit ?? 128 * 1024 * 1024)
							)
								return fail("binary field memory limit");
							const target = new Uint8Array(length);
							target.set(value);
							fragment[operation.key] = target;
							byteOffsets.set(operation.key, value.length);
						} else fragment[operation.key] = value;
					} else if (operation.type === "row-end") {
						if (!fragment) return fail("row end without fields");
						append(fragment as unknown as PiSnapshotTag);
						fragment = undefined;
						byteOffsets.clear();
					} else return fail("unknown frame");
					const elapsed = performance.now() - started;
					maxAssemblyMs = Math.max(maxAssemblyMs, elapsed);
					if (elapsed >= 4) {
						await yieldImmediate();
						started = performance.now();
					}
				}
				if (packetRows !== message.rows)
					return fail("packet row count mismatch");
				return null;
			} catch (error) {
				rejected = true;
				throw error;
			} finally {
				busy = false;
			}
		},
		get generation() {
			return generation;
		},
		get maxAssemblyMs() {
			return maxAssemblyMs;
		},
	};
}

/** Launch from source in Bun or beside emitted chunks in a packed package. */
export function startPiTagSnapshotWorker(
	request: PiHydrationRequest,
	options: {
		cached?: readonly PiSnapshotTag[];
		byteLimit?: number;
		deadlineMs?: number;
		entry?: URL;
		beforeAck?: (message: PiHydrationMessage) => Promise<void>;
	} = {},
) {
	const entry =
		options.entry ??
		new URL(
			import.meta.url.endsWith(".ts")
				? "./tag-snapshot-worker-pi.ts"
				: "./tag-snapshot-worker-pi.js",
			import.meta.url,
		);
	const started = performance.now();
	const consumer = createPiHydrationPacketConsumer(
		request,
		options.cached,
		options.byteLimit,
	);
	const worker = inRootAsyncContext(
		() => new Worker(entry, { workerData: request }),
	);
	let exited = false;
	let settled = false;
	let complete:
		| {
				candidate: PiTagSnapshotCandidate;
				generation: PiHydrationGeneration;
				telemetry: PiHydrationTelemetry;
		  }
		| undefined;
	let rejectResult: (error: Error) => void;
	const released = new Promise<void>((resolve) =>
		worker.once("exit", () => {
			exited = true;
			resolve();
		}),
	);
	const result = new Promise<NonNullable<typeof complete>>(
		(resolve, reject) => {
			rejectResult = reject;
			worker.on("message", async (message: PiHydrationMessage) => {
				if (settled) return;
				try {
					const candidate = await consumer.consume(message);
					if (candidate && message.type === "done") {
						complete = {
							candidate,
							generation: message.generation,
							telemetry: {
								maxReadTransactionMs: message.maxReadTransactionMs,
								maxAssemblyMs: consumer.maxAssemblyMs,
								packetCount: message.packetCount,
								packetBytes: message.packetBytes,
								jobMs: performance.now() - started,
							},
						};
					} else {
						await options.beforeAck?.(message);
						if (!settled)
							worker.postMessage({ type: "ack", sequence: message.sequence });
					}
				} catch (error) {
					abort(error instanceof Error ? error : new Error(String(error)));
				}
			});
			worker.once("error", (error) => abort(error));
			worker.once("exit", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (code === 0 && complete) resolve(complete);
				else
					reject(
						new PiTagHydrationError(
							`worker exited with code ${code} before a clean complete result`,
						),
					);
			});
		},
	);
	function abort(error: Error = new PiTagHydrationError("cancelled")) {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		rejectResult(error);
		if (!exited) void worker.terminate();
	}
	const timer = inRootAsyncContext(() =>
		setTimeout(
			() => abort(new PiTagHydrationError("job deadline exceeded", "deadline")),
			options.deadlineMs ?? 10_000,
		),
	);
	timer.unref();
	worker.unref();
	return { result, released, cancel: abort };
}
