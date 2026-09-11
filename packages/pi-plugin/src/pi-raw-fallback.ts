export class PiStorageBusyError extends Error {
	readonly code = "PI_STORAGE_BUSY";
	readonly recoverable = true;

	constructor(options?: { cause?: unknown }) {
		super("Magic Context storage is busy; send your message again", options);
		this.name = "PiStorageBusyError";
	}
}

/** Same four-serialized-bytes/token risk budget as OpenCode's serveRawFallback. */
export function assertPiRawFallbackFits(
	messages: readonly unknown[],
	contextLimit: number | undefined,
	log: (message: string) => void,
	cause: unknown,
): void {
	if (contextLimit === undefined) return;
	let bytes = 1;
	let serializationFailed = false;
	try {
		for (const message of messages) {
			const serialized = JSON.stringify(message);
			if (typeof serialized !== "string") {
				serializationFailed = true;
				break;
			}
			bytes += Buffer.byteLength(serialized) + 1;
			if (bytes > contextLimit * 4) break;
		}
	} catch {
		serializationFailed = true;
	}
	const proxyTokens = Math.ceil(bytes / 4);
	if (serializationFailed || proxyTokens > contextLimit) {
		log(
			`raw_fallback_over_context_limit proxy_bytes=${bytes} proxy_tokens=${proxyTokens} limit=${contextLimit} early_abort=true serialization_failed=${serializationFailed}`,
		);
		throw new PiStorageBusyError({ cause });
	}
}
