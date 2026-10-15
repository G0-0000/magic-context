import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export interface PiImageContent {
	text: string;
	images: string[];
	imageTextPositions?: number[];
}

function imageKey(
	block: Record<string, unknown>,
	api?: string,
): string | undefined {
	const source = object(block.source);
	const file = object(block.providerFile);
	if (api === "ollama-chat" && typeof block.data === "string")
		return `bytes:${block.data}`;
	if (
		(file?.provider === "openai" && api?.endsWith("responses")) ||
		(file?.provider === "anthropic" && api === "anthropic-messages")
	)
		if (typeof file.id === "string") return `file:${file.id}`;
	if (
		file?.provider === "google" &&
		api?.startsWith("google-") &&
		typeof file.uri === "string"
	)
		return file.uri;
	if (typeof block.url === "string") return block.url;
	if (typeof block.image_url === "string") return block.image_url;
	const url = object(block.image_url)?.url;
	if (typeof url === "string") return url;
	if (typeof block.file_id === "string") return `file:${block.file_id}`;
	if (source?.type === "url" && typeof source.url === "string")
		return source.url;
	if (source?.type === "file" && typeof source.file_id === "string")
		return `file:${source.file_id}`;
	const data = source?.data ?? block.data;
	const mime = source?.media_type ?? block.mimeType;
	return typeof data === "string" && typeof mime === "string"
		? `data:${mime};base64,${data}`
		: undefined;
}

/** Normalize only the text and image content, never tool arguments or metadata. */
export function piImageContent(
	content: unknown,
	api?: string,
	runtimeReminder = false,
	keepBlankText = false,
	partitionImages = false,
): PiImageContent | undefined {
	if (typeof content === "string")
		return {
			text: new TextDecoder().decode(new TextEncoder().encode(content)),
			images: [],
		};
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	const images: string[] = [];
	const imageTextPositions: number[] = [];
	for (const value of content) {
		const block = object(value);
		if (!block) return undefined;
		// Oh My Pi adds a date/working-directory reminder after extensions prepare
		// context. Exclude only that leading runtime block, not conversation text.
		if (
			runtimeReminder &&
			value === content[0] &&
			typeof block.text === "string" &&
			/^<system-reminder>\nToday: \d{4}-\d{2}-\d{2}; current working directory: '[^\n]*'\. Do not repeat this information in your reply\.\n<\/system-reminder>$/.test(
				block.text,
			)
		)
			continue;
		const inline = object(block.inlineData);
		const file = object(block.fileData);
		const bedrock = object(block.image);
		const previousImages = images.length;
		if (
			inline &&
			typeof inline.data === "string" &&
			typeof inline.mimeType === "string"
		) {
			images.push(`data:${inline.mimeType};base64,${inline.data}`);
		} else if (file && typeof file.fileUri === "string") {
			images.push(file.fileUri);
		} else if (bedrock && typeof object(bedrock.source)?.bytes === "string") {
			images.push(
				`data:image/${bedrock.format};base64,${object(bedrock.source)?.bytes}`,
			);
		} else if (
			["text", "input_text", "output_text"].includes(String(block.type)) ||
			(block.type === undefined && typeof block.text === "string")
		) {
			if (typeof block.text !== "string") return undefined;
			if (keepBlankText || block.text.trim())
				texts.push(
					new TextDecoder().decode(new TextEncoder().encode(block.text)),
				);
		} else if (
			["image", "image_url", "input_image"].includes(String(block.type))
		) {
			const key = imageKey(block, api);
			if (key === undefined) return undefined;
			images.push(key);
		} else if (
			block.type !== "toolCall" &&
			block.type !== "tool_use" &&
			block.type !== "thinking" &&
			block.type !== "redacted_thinking" &&
			!block.functionCall &&
			!block.toolUse &&
			!block.cachePoint &&
			!block.reasoningContent
		) {
			return undefined;
		}
		if (images.length !== previousImages) imageTextPositions.push(texts.length);
	}
	return {
		text: texts.join("\n"),
		images,
		...(images.length && api !== "ollama-chat"
			? {
					imageTextPositions: partitionImages
						? images.map(() => texts.length)
						: imageTextPositions,
				}
			: {}),
	};
}

export interface PiImageBudgetPlan {
	messages: readonly unknown[];
	model: PiChatHistoryModel;
	count: number;
}

/** Oh My Pi budgets user/developer/tool-result images, never assistant output images. */
export function piImageBudgetPlan(
	messages: readonly unknown[],
	model: PiChatHistoryModel | undefined,
): PiImageBudgetPlan | undefined {
	if (
		!model?.input?.includes("image") ||
		object(model.compat)?.stripImageInput === true
	)
		return undefined;
	let count = 0;
	for (const value of messages) {
		const message = object(value);
		if (!["user", "developer", "toolResult"].includes(String(message?.role)))
			continue;
		if (Array.isArray(message?.content))
			count += message.content.filter(
				(value) => object(value)?.type === "image",
			).length;
	}
	if (!count) return undefined;
	// The receipt must not change if a later extension edits the returned messages.
	return {
		messages: structuredClone(messages),
		model: structuredClone(model),
		count,
	};
}

/**
 * Mirror Oh My Pi's oldest-first count clamp (18.10.4/18.11.0,
 * coding-agent/src/session/provider-image-budget.ts:69-124). When removal
 * empties a message, the host inserts an omission notice instead of losing the
 * turn. The observed image-count delta determines drops, not a catalog budget.
 */
export function piTrimOldestImages(
	plan: PiImageBudgetPlan,
	drops: number,
): unknown[] {
	return plan.messages.map((value) => {
		const message = object(value);
		if (
			!drops ||
			!message ||
			!["user", "developer", "toolResult"].includes(String(message.role)) ||
			!Array.isArray(message.content)
		)
			return value;
		let changed = false;
		const content = message.content.filter((value) => {
			if (drops && object(value)?.type === "image") {
				drops--;
				changed = true;
				return false;
			}
			return true;
		});
		return changed
			? {
					...message,
					content: content.length
						? content
						: [{ type: "text", text: "[image omitted: provider image limit]" }],
					...(message.role !== "toolResult"
						? { providerPayload: undefined }
						: {}),
				}
			: value;
	});
}

/** Count native input images, including images nested inside tool outputs. */
export function piWireImageCount(payload: unknown): number {
	const body = object(payload);
	const visit = (value: unknown): number => {
		if (Array.isArray(value))
			return value.reduce((n, item) => n + visit(item), 0);
		const block = object(value);
		if (!block) return 0;
		if (["image", "image_url", "input_image"].includes(String(block.type)))
			return 1;
		if (block.inlineData || block.fileData || block.image) return 1;
		return [
			block.content,
			block.output,
			block.parts,
			block.toolResult,
			block.functionResponse,
			block.response,
		].reduce<number>(
			(n, item) => n + visit(item),
			Array.isArray(block.images) ? block.images.length : 0,
		);
	};
	return visit(
		body?.messages ??
			body?.input ??
			body?.contents ??
			object(body?.request)?.contents,
	);
}
