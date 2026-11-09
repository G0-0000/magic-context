import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeNormalizedHash,
	insertMemory,
	updateMemoryContent,
	updateMemoryStatus,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type {
	GitCommitSearchResult,
	MessageSearchResult,
	UnifiedSearchResult,
} from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import * as storageDb from "@magic-context/core/features/magic-context/storage-db";
import * as logger from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { statusChangesPathFor } from "@magic-context/core/tools/ctx-search/flow-render";
import { STRATA_ASK_FOOTER, STRATA_ASK_T4 } from "@magic-context/core/tools/ctx-search/strata-ask";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxSearchTool, resolvePiStrataAsk } from "./ctx-search";

describe("createCtxSearchTool", () => {
	it("hosted reranking reaches Pi output and cancellation without exposing the key", async () => {
		const originalSearch = searchModule.unifiedSearch;
		// Repeated comparisons must not change retrieval counters and reorder tied hits.
		const search = spyOn(searchModule, "unifiedSearch").mockImplementation(
			(database, session, project, query, options) =>
				originalSearch(database, session, project, query, {
					...options,
					countRetrievals: false,
					measurementDisabled: true,
				}),
		);
		const db = createTestDb();
		const key = "FAKE_PI_RERANK_KEY_765";
		let mode = "success";
		let calls = 0;
		let started: (() => void) | undefined;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				calls++;
				expect(req.headers.get("Authorization")).toBe(`Bearer ${key}`);
				const { documents } = (await req.json()) as { documents: string[] };
				if (mode === "abort") {
					started?.();
					return new Promise<Response>(() => {});
				}
				if (mode === "failure") return new Response(key, { status: 401 });
				return Response.json({
					results: documents.map((_, index) => ({
						index,
						relevance_score: index,
					})),
				});
			},
		});
		const query = "why does prompt cache budget stay stable";
		for (let i = 0; i < 3; i++)
			insertMemory(db, {
				projectPath: "git:rerank",
				category: "RESEARCH",
				content: `prompt cache budget stable memory ${i}`,
			});
		const deps = {
			db,
			resolveProjectIdentity: () => "git:rerank",
			embeddingEnabled: false,
			memoryEnabled: true,
			rerankConnectionFile: "/nonexistent/rerank-test-765",
		};
		const config = {
			provider: "remote" as const,
			endpoint: String(server.url),
			model: "reranker",
			api_key: key,
			timeout_ms: 1500,
			top_n: 20,
		};
		const ctx = fakeContext("ses-search") as never;
		const invoke = async (
			tool: ReturnType<typeof createCtxSearchTool>,
			signal = new AbortController().signal,
		) => {
			const result = await tool.execute(
				"rerank-call",
				{ query, sources: ["memory"] },
				signal,
				undefined,
				ctx,
			);
			return result.content[0]?.text;
		};
		try {
			const baseline = await invoke(createCtxSearchTool(deps));
			expect(baseline).toBe(
				await invoke(
					createCtxSearchTool({
						...deps,
						rerankConfig: { provider: "off", timeout_ms: 1500, top_n: 20 },
					}),
				),
			);
			expect(calls).toBe(0);
			const tool = createCtxSearchTool({ ...deps, rerankConfig: config });
			const success = await invoke(tool);
			expect(success).not.toContain("Reranking skipped");
			expect(success).not.toBe(baseline);
			mode = "failure";
			expect(await invoke(tool)).toBe(
				`${baseline}\nReranking skipped: http_401`,
			);
			mode = "abort";
			const seen = new Promise<void>((resolve) => {
				started = resolve;
			});
			const controller = new AbortController();
			const pending = invoke(tool, controller.signal);
			await seen;
			controller.abort(new Error(key));
			const aborted = await pending;
			expect(aborted).toBe(`${baseline}\nReranking skipped: aborted`);
			expect(aborted).not.toContain(key);
			expect(calls).toBe(3);
		} finally {
			search.mockRestore();
			server.stop(true);
			closeQuietly(db);
		}
	});
	it("returns a typed tool error for an invalid date", async () => {
		const db = createTestDb();
		try {
			const tool = createCtxSearchTool({ db });
			const result = await tool.execute(
				"call-date",
				{ query: "needle", to: "not-a-date" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toBe(
				"Error: Invalid 'to' date; use YYYY-MM-DD or a full ISO datetime.",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("prints ctx_expand ranges and footer for message search hits", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "message",
						content: "prior conversation detail",
						score: 0.87,
						messageOrdinal: 12,
						role: "user",
						matchType: "fts",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-1",
				{ query: "prior detail", sources: ["message"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ordinal=12 range=9-15 role=user");
			expect(text).toContain(
				"Use ctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("accepts note sources and renders note anchors", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _sessionId, _project, _query, options) => {
				expect(options?.sources).toEqual(["note"]);
				return [
					{
						source: "note",
						content:
							"Decision: keep the compatibility shim for one more release.",
						score: 0.91,
						noteId: 5,
						status: "ready",
						createdAt: Date.now() - 24 * 60 * 60 * 1000,
						anchorOrdinal: 21,
						sourceSessionId: "ses-search",
					},
				] as UnifiedSearchResult[];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-2",
				{ query: "compatibility shim", sources: ["note"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#5 status=ready");
			expect(text).toContain("@msg 21");
			expect(text).toContain(
				"Use ctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("omits note anchors and footer hints for foreign-session smart notes", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "note",
						content:
							"Foreign session note should not expose an expandable anchor.",
						score: 0.72,
						noteId: 6,
						status: "ready",
						createdAt: Date.now(),
						anchorOrdinal: 22,
						sourceSessionId: "ses-other",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-3",
				{ query: "foreign anchor", sources: ["note"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#6 status=ready");
			expect(text).not.toContain("@msg 22");
			expect(text).not.toContain(
				"Use ctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("explains when an id-shaped memory hit is already visible (Pi parity)", async () => {
		const db = createTestDb();
		const { insertMemory } = await import(
			"@magic-context/core/features/magic-context/memory"
		);
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const memory = insertMemory(db, {
			projectPath: projectIdentity,
			category: "RESEARCH",
			content: "Visible Pi memory for direct lookup.",
		});
		db.prepare(
			"INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)",
		).run("ses-visible", JSON.stringify([memory.id]));
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-visible",
				{ query: `#${memory.id}`, sources: ["memory"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-visible", process.cwd()) as never,
			);

			expect(result.content[0]?.text).toBe(
				`No hidden results found for "#${memory.id}".\n\nMemories: 1 match found, all already visible in your project-memory block (ids ${memory.id}).`,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves a `#1234` query directly without calling unifiedSearch (Pi parity)", async () => {
		const db = createTestDb();
		// Dynamically import `insertMemory` to seed a memory for this test,
		// then verify that an ID-shaped query uses `resolveMemoriesByIdsForSearch`
		// instead of `unifiedSearch`.
		const { insertMemory } = await import(
			"@magic-context/core/features/magic-context/memory"
		);
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const memory = insertMemory(db, {
			projectPath: projectIdentity,
			category: "USER_DIRECTIVES",
			content: "Direct id hit for the short-circuit.",
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				throw new Error("unifiedSearch must not run for ID-shaped queries");
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-id",
				{ query: `#${memory.id}` },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("[1] [memory]");
			expect(text).toContain(`id=${memory.id}`);
			expect(text).toContain("Direct id hit for the short-circuit.");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("treats empty sources and limit 0 as the omitted defaults so required-all filler matches a clean search", async () => {
		const spy = spyOn(searchModule, "unifiedSearch");
		const run = async (args: {
			query: string;
			sources?: Array<"memory" | "message" | "git_commit" | "primer" | "note">;
			limit?: number;
		}) => {
			const db = createTestDb();
			try {
				const projectIdentity = resolveProjectIdentity(process.cwd());
				for (const [content, label] of [
					["Needle alpha", "first"],
					["Needle alpha alpha", "second"],
					["Needle alpha alpha alpha", "third"],
				]) {
					insertMemory(db, {
						projectPath: projectIdentity,
						category: "RESEARCH",
						content: `${content} ${label} result.`,
					});
				}
				const tool = createCtxSearchTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				});
				const result = await tool.execute(
					"call-search",
					args,
					new AbortController().signal,
					undefined,
					fakeContext("ses-search", process.cwd()) as never,
				);
				return result.content[0]?.text ?? "";
			} finally {
				closeQuietly(db);
			}
		};

		try {
			const clean = await run({ query: "Needle alpha" });
			const filler = await run({
				query: "Needle alpha",
				sources: [],
				limit: 0,
			});
			expect(filler).toBe(clean);
			expect(clean).toContain("Found 3 results");
			for (const label of ["first", "second", "third"]) {
				expect(clean).toContain(`${label} result`);
			}

			const cleanOpts = spy.mock.calls[0]?.[4] as {
				sources?: unknown;
				limit?: number;
			};
			const fillerOpts = spy.mock.calls[1]?.[4] as {
				sources?: unknown;
				limit?: number;
			};
			expect(fillerOpts.sources).toEqual(cleanOpts.sources);
			expect(fillerOpts.limit).toEqual(cleanOpts.limit);
			expect(fillerOpts.sources).toBeUndefined();
			expect(fillerOpts.limit).toBe(10);
		} finally {
			spy.mockRestore();
		}
	});

	it("fuses selected mixed sources and preserves them on fallback", async () => {
		const db = createTestDb();
		const evidence = insertMemory(db, { projectPath: "git:pi-mixed", category: "RESEARCH", content: "真实记忆 | 内容" });
		db.prepare("INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)").run("ses-search", JSON.stringify([evidence.id]));
		const dir = mkdtempSync(join(tmpdir(), "mc-pi-strata-mixed-"));
		const prefixPath = join(dir, "prefix.json");
		writeFileSync(prefixPath, JSON.stringify([
			{ role: "system", content: "sys" },
			{ role: "user", content: "mem" },
			{ role: "assistant", content: "ack" },
		]));
		let mode: "hit" | "miss" | "json-miss" | "invalid" | "failed" | "400" | "409" = "hit";
		let requests = 0;
		let content = "";
		const server = Bun.serve({
			port: 0, hostname: "127.0.0.1",
			async fetch(req) {
				requests++;
				content = ((await req.json()) as { messages: Array<{ content: string }> }).messages[0]!.content;
				if (mode === "failed" || mode === "400" || mode === "409") {
					return new Response(null, { status: mode === "failed" ? 404 : Number(mode) });
				}
				return Response.json({
					choices: [{ message: { content: mode === "hit" ? JSON.stringify({ answer: "融合答案", memoryIds: [evidence.id], externalRefs: ["note:7"] }) : mode === "json-miss" ? JSON.stringify({ answer: "记忆库中无", memoryIds: [], externalRefs: [] }) : mode === "invalid" ? "旧格式" : "记忆库中无" } }],
					session: { splice: { resume_ok: true } },
				});
			},
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(async (_db, _session, _project, _query, options) => [{
			source: "message", content: options?.sources?.includes("memory") ? "full archive marker" : "selected archive marker", score: 1,
			messageOrdinal: 3, messageId: "m3", role: "user", sessionId: "ses-search", messageTimeMs: null,
		}]);
		const common = {
			db, memoryEnabled: true, embeddingEnabled: false,
			resolveProjectIdentity: () => "git:pi-mixed",
		};
		const tool = createCtxSearchTool({
			...common,
			resolveStrataAsk: () => ({
				baseUrl: String(server.url).replace(/\/$/, ""), apiKey: "pi-strata-key",
				apiKeyEnv: null, model: "qwen-test", slotFile: "mc-mem-v1.bin", prefixPath,
				project: "git:pi-mixed", maxTokens: 64, timeoutMs: 1500, transientBudgetTokens: 1000,
				contextDocsBudgetTokens: 4000,
			}),
		});
		const ctx = fakeContext("ses-search", "/repo/pi-mixed") as never;
		const query = "where is sqlite";
		const sources: Array<"message" | "memory" | "note"> = ["message", "memory", "note", "memory"];
		const args = { query, sources, limit: 2 };
		const invoke = async (target: ReturnType<typeof createCtxSearchTool>, params: typeof args) =>
			(await target.execute("mixed", params, new AbortController().signal, undefined, ctx)).content[0]?.text;
		try {
			const baseline = await invoke(createCtxSearchTool(common), { query, sources: ["message", "note"], limit: 2 });
			const fullBaseline = await invoke(createCtxSearchTool(common), args);
			expect(baseline).toContain("selected archive marker");
			expect(fullBaseline).toContain("full archive marker");
			expect(baseline).not.toBe(fullBaseline);
			spy.mockClear();
			expect(await invoke(tool, args)).toBe(`答案：\n融合答案\n\n依据记忆：\n| 记忆编号 | 记忆缩略 |\n| --- | --- |\n| #${evidence.id} | 真实记忆 \\| 内容 |\n${STRATA_ASK_FOOTER}（取非记忆原文时，sources 须排除 memory，例如 sources:['note']）`);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual(["message", "note"]);
			expect(spy.mock.calls[0]?.[4]?.limit).toBe(2);
			expect(content).toContain("selected archive marker");
			expect(content).toContain(`问题：${query}`);
			expect(args).toEqual({ query, sources: ["message", "memory", "note", "memory"], limit: 2 });
			const beforeInvalid = requests;
			spy.mockClear();
			const invalid = await invoke(tool, { query, sources: ["memory", "unknown"], limit: 2 } as never);
			expect(invalid).toContain("full archive marker");
			expect(requests).toBe(beforeInvalid);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual(["memory", "unknown"]);
			for (mode of ["miss", "json-miss", "invalid", "failed"] as const) {
				spy.mockClear();
				expect(await invoke(tool, args)).toBe(baseline);
				expect(spy).toHaveBeenCalledTimes(1);
				expect(spy.mock.calls[0]?.[4]?.sources).toEqual(["message", "note"]);
			}
			for (mode of ["400", "409"] as const) {
				rmSync(`${prefixPath}.sidecar-stale.json`, { force: true });
				spy.mockClear();
				const before = requests;
				expect(await invoke(tool, args)).toBe(fullBaseline);
				expect(requests).toBe(before + 1);
				expect(spy).toHaveBeenCalledTimes(2);
				expect(spy.mock.calls[0]?.[4]?.sources).toEqual(["message", "note"]);
				expect(spy.mock.calls[1]?.[4]?.sources).toEqual(sources);
				expect(spy.mock.calls[1]?.[4]?.limit).toBe(2);
			}
			rmSync(`${prefixPath}.sidecar-stale.json`, { force: true });
			writeFileSync(statusChangesPathFor(prefixPath, "mc-mem-v1.bin"), "{broken\n");
			const before = requests;
			spy.mockClear();
			expect(await invoke(tool, args)).toBe(fullBaseline);
			expect(requests).toBe(before);
			expect(spy).toHaveBeenCalledTimes(2);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual(["message", "note"]);
			expect(spy.mock.calls[1]?.[4]?.sources).toEqual(sources);
			expect(args).toEqual({ query, sources: ["message", "memory", "note", "memory"], limit: 2 });
		} finally {
			spy.mockRestore();
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("fuses once with non-memory classic and handles memory-only answered, miss and failure", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-"));
		const prefixPath = join(prefixDir, "prefix.json");
		const prefix = JSON.stringify([
			{ role: "system", content: "sys" },
			{ role: "user", content: "mem" },
			{ role: "assistant", content: "ack" },
		]);
		writeFileSync(prefixPath, prefix);
		let calls = 0;
		let mode: "hit" | "miss" | "json-miss" | "invalid" | "failed" = "hit";
		let chatMessages: Array<{ role: string; content: string }> = [];
		const server = Bun.serve({
			port: 0, hostname: "127.0.0.1",
			async fetch(req) {
				calls++;
				if (mode === "failed") return new Response(null, { status: 404 });
				chatMessages = ((await req.json()) as { messages: Array<{ role: string; content: string }> }).messages;
				return Response.json({
					choices: [{ message: { content: mode === "hit" ? JSON.stringify({ answer: "答案一行", memoryIds: [] }) : mode === "json-miss" ? JSON.stringify({ answer: "记忆库中无", memoryIds: [] }) : mode === "invalid" ? "旧格式" : "记忆库中无", reasoning_content: "skip" } }],
					session: { splice: { resume_ok: true } },
				});
			},
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockResolvedValue([{
			source: "message", content: "sqlite archive marker", score: 1,
			messageOrdinal: 3, messageId: "m3", role: "user", sessionId: "ses-search", messageTimeMs: null,
		}]);
		const fusionSources = ["git_commit", "primer", "note", "message"] as const;
		const ctx = fakeContext("ses-search", "/repo/pi-strata") as never;
		const invoke = async (
			args: { query: string; sources?: Array<"memory" | "message" | "git_commit" | "primer" | "note">; limit?: number; from?: string; to?: string },
			resolve = true,
		) => {
			const tool = createCtxSearchTool({
				db, memoryEnabled: false, embeddingEnabled: false,
				resolveProjectIdentity: () => "git:pi-strata",
				resolveStrataAsk: resolve ? () => ({
					baseUrl: String(server.url).replace(/\/$/, ""), apiKey: "pi-strata-key",
					apiKeyEnv: null, model: "qwen-test", slotFile: "mc-mem-v1.bin", prefixPath,
					project: "git:pi-strata", maxTokens: 64, timeoutMs: 1500, transientBudgetTokens: 1000,
					contextDocsBudgetTokens: 4000,
				}) : () => null,
			});
			const result = await tool.execute("strata-call", args, new AbortController().signal, undefined, ctx);
			return result.content[0]?.text ?? "";
		};
		const query = "where is sqlite";
		try {
			const baseline = await invoke({ query, sources: [...fusionSources] }, false);
			const memoryBaseline = await invoke({ query, sources: ["memory"] }, false);
			expect(calls).toBe(0);
			spy.mockClear();
			const hit = await invoke({ query });
			expect(hit).toBe(`答案：\n答案一行\n\n依据记忆：\n无可核验的记忆依据\n${STRATA_ASK_FOOTER}`);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual([...fusionSources]);
			expect(chatMessages[0]?.content).toContain("sqlite archive marker");
			expect(chatMessages[0]?.content).toContain(`问题：${query}`);
			expect(readFileSync(prefixPath, "utf8")).toBe(prefix);
			spy.mockClear();
			mode = "miss";
			expect(await invoke({ query })).toBe(baseline);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual([...fusionSources]);
			spy.mockClear();
			mode = "failed";
			expect(await invoke({ query })).toBe(baseline);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual([...fusionSources]);
			spy.mockClear();
			mode = "hit";
			expect(await invoke({ query, sources: ["memory"] })).toBe(`答案：\n答案一行\n\n依据记忆：\n无可核验的记忆依据\n${STRATA_ASK_FOOTER}`);
			expect(spy).toHaveBeenCalledTimes(0);
			expect(chatMessages[0]?.content).toBe(STRATA_ASK_T4.replace("{status}", "").replace("{q}", query));
			mode = "miss";
			expect(await invoke({ query, sources: ["memory", "memory"] })).toBe(`记忆库中无\n${STRATA_ASK_FOOTER}`);
			expect(spy).toHaveBeenCalledTimes(0);
			mode = "json-miss";
			expect(await invoke({ query, sources: ["memory"] })).toBe(`记忆库中无\n${STRATA_ASK_FOOTER}`);
			mode = "invalid";
			expect(await invoke({ query, sources: ["memory"] })).toBe(memoryBaseline);
			expect(spy).toHaveBeenCalledTimes(1);
			spy.mockClear();
			mode = "failed";
			expect(await invoke({ query, sources: ["memory"] })).toBe(memoryBaseline);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual(["memory"]);
			mode = "hit";
			spy.mockClear();
			expect(await invoke({ query, limit: 2 })).toBe(`答案：\n答案一行\n\n依据记忆：\n无可核验的记忆依据\n${STRATA_ASK_FOOTER}`);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[4]?.sources).toEqual([...fusionSources]);
			expect(spy.mock.calls[0]?.[4]?.limit).toBe(2);
			expect(await invoke({ query, sources: ["memory"], limit: 2 })).toBe(`答案：\n答案一行\n\n依据记忆：\n无可核验的记忆依据\n${STRATA_ASK_FOOTER}`);
			expect(spy).toHaveBeenCalledTimes(1);
			const networked = calls;
			await invoke({ query, sources: [] });
			await invoke({ query, sources: ["note"] });
			await invoke({ query, from: "2026-01-01" });
			await invoke({ query: "#1035" });
			await invoke({ query, sources: ["memory", "note"], from: "2026-01-01" });
			await invoke({ query, sources: ["memory", "note"], to: "2026-02-01" });
			await invoke({ query: "#1035", sources: ["memory", "note"] });
			expect(calls).toBe(networked);
			expect(readFileSync(prefixPath, "utf8")).toBe(prefix);
		} finally {
			spy.mockRestore();
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("sends retained removals and corrections on both routes whether or not the slot contains the old entries", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-retained-"));
		const prefixPath = join(prefixDir, "prefix.json");
		const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
		const messages: string[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const body = (await req.json()) as { messages: Array<{ content: string }> };
				messages.push(body.messages[0]!.content);
				return Response.json({ choices: [{ message: { content: JSON.stringify({ answer: "记忆答案", memoryIds: [] }) } }] });
			},
		});
		const currentDb = spyOn(storageDb, "openCurrentDatabase").mockReturnValue(db);
		try {
			const project = "git:pi-retained";
			const archived = insertMemory(db, {
				projectPath: project, category: "RESEARCH", content: "where is sqlite archived old",
			});
			const updated = insertMemory(db, {
				projectPath: project, category: "RESEARCH", content: "where is sqlite updated old",
			});
			updateMemoryStatus(db, archived.id, "archived");
			const current = "where is sqlite updated new";
			updateMemoryContent(db, updated.id, current, computeNormalizedHash(current));
			const ts = "2026-01-01T00:00:00.000Z";
			const row = (op: string, id: number) => JSON.stringify({
				op, id, ts, ...(op === "remove" ? { kind: "archive" } : {}),
			});
			const added = [row("add", archived.id), row("add", updated.id)];
			const changed = [row("remove", archived.id), row("update", updated.id)];
			const routed = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				resolveProjectIdentity: () => project,
				resolveStrataAsk: () => ({
					baseUrl: String(server.url).replace(/\/$/, ""), apiKey: "pi-strata-key", apiKeyEnv: null,
					model: "qwen-test", slotFile: "mc-mem-v1.bin", prefixPath, project,
					maxTokens: 64, timeoutMs: 1500, transientBudgetTokens: 1000,
					contextDocsBudgetTokens: 4000,
				}),
			});
			const ctx = fakeContext("ses-search", "/repo/pi-retained") as never;
			const query = "where is sqlite";
			const oldEntries = `#${archived.id} [RESEARCH] 〔${ts}〕：\n${archived.content}\n\n#${updated.id} [RESEARCH] 〔${ts}〕：\n${updated.content}`;
			for (const [oldSlot, addRecordedLate] of [
				[oldEntries, false], [oldEntries, true],
				["no memory entries", false], ["no memory entries", true],
			] as const) {
				const rows = addRecordedLate ? [...changed, ...added] : [...added, ...changed];
				writeFileSync(ledgerPath, `${rows.join("\n")}\n`);
				writeFileSync(prefixPath, JSON.stringify([
					{ role: "system", content: "sys" },
					{ role: "user", content: oldSlot },
					{ role: "assistant", content: "ack" },
				]));
				const before = messages.length;
				for (const params of [{ query, sources: ["memory"] as Array<"memory"> }, { query }]) {
					const result = await routed.execute("retained", params, new AbortController().signal, undefined, ctx);
					expect(result.content[0]?.text).toBe(`答案：\n记忆答案\n\n依据记忆：\n无可核验的记忆依据\n${STRATA_ASK_FOOTER}`);
				}
				expect(messages).toHaveLength(before + 2);
				for (const message of messages.slice(before)) {
					expect(message).toContain(`讣：#${archived.id} 已删除/已归档`);
					expect(message).toContain(`正：#${updated.id} 已修改为：「${current}」，上文旧文作废`);
					expect(message).not.toContain("增：");
				}
			}
		} finally {
			currentDb.mockRestore();
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("falls back with real Pi memory hits for torn ledgers and restored edits", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-status-"));
		const prefixPath = join(prefixDir, "prefix.json");
		const ledgerPath = statusChangesPathFor(prefixPath, "mc-mem-v1.bin");
		let calls = 0;
		let status = 409;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				calls++;
				return status === 409
					? Response.json({ error: { type: "splice_stale" } }, { status })
					: Response.json({ error: { message: "splice_render_mismatch" } }, { status });
			},
		});
		const originalSearch = searchModule.unifiedSearch;
		const search = spyOn(searchModule, "unifiedSearch").mockImplementation(
			(database, session, project, text, options) =>
				originalSearch(database, session, project, text, {
					...options,
					countRetrievals: false,
					measurementDisabled: true,
				}),
		);
		// Pi uses openCurrentDatabase for status reads. Supply the actual test
		// store at that seam; memory lookup and classic search remain real.
		const currentDb = spyOn(storageDb, "openCurrentDatabase").mockReturnValue(db);
		const common = {
			db,
			memoryEnabled: true,
			embeddingEnabled: false,
			resolveProjectIdentity: () => "git:pi-status",
		};
		const ctx = fakeContext("ses-search", "/repo/pi-status") as never;
		const query = "where is sqlite";
		const invoke = async (
			tool: ReturnType<typeof createCtxSearchTool>,
			sources?: Array<"memory" | "message" | "git_commit" | "primer" | "note">,
		) => {
			const result = await tool.execute(
				"status-fallback",
				sources ? { query, sources } : { query },
				new AbortController().signal,
				undefined,
				ctx,
			);
			return result.content[0]?.text ?? "";
		};
		try {
			const memory = insertMemory(db, {
				projectPath: "git:pi-status",
				category: "RESEARCH",
				content: "where is sqlite stale_before_restore",
			});
			writeFileSync(prefixPath, JSON.stringify([
				{ role: "system", content: "sys" },
				{ role: "user", content: `#${memory.id} [RESEARCH] 〔${new Date(memory.updatedAt).toISOString()}〕：\n${memory.content}` },
				{ role: "assistant", content: "ack" },
			]));
			const ts = "2026-01-01T00:00:00.000Z";
			updateMemoryStatus(db, memory.id, "archived");
			const add = JSON.stringify({ op: "add", id: memory.id, ts });
			const remove = JSON.stringify({ op: "remove", id: memory.id, kind: "archive", ts });
			writeFileSync(ledgerPath, `${remove}\n`);
			updateMemoryStatus(db, memory.id, "active");
			const content = "where is sqlite pirestorededit";
			updateMemoryContent(db, memory.id, content, computeNormalizedHash(content));
			const classic = createCtxSearchTool(common);
			const baselineMemory = await invoke(classic, ["memory"]);
			const baselineAll = await invoke(classic);
			expect(baselineMemory).toContain(`id=${memory.id}`);
			expect(baselineMemory).toContain("pirestorededit");
			expect(baselineAll).toContain("pirestorededit");
			const routed = createCtxSearchTool({
				...common,
				resolveStrataAsk: () => ({
					baseUrl: String(server.url).replace(/\/$/, ""),
					apiKey: "pi-strata-key",
					apiKeyEnv: null,
					model: "qwen-test",
					slotFile: "mc-mem-v1.bin",
					prefixPath,
					project: "git:pi-status",
					maxTokens: 64,
					timeoutMs: 1500,
					transientBudgetTokens: 1000,
					contextDocsBudgetTokens: 4000,
				}),
			});
			const ledgers = [
				`${JSON.stringify({ op: "update", id: memory.id, ts })}\n{"op":"rem`,
				`${remove}\n`,
				`${add}\n${remove}\n`,
				`${remove}\n${add}\n`,
			];
			for (const [index, ledger] of ledgers.entries()) {
				writeFileSync(ledgerPath, ledger);
				currentDb.mockClear();
				search.mockClear();
				const memoryOnly = await invoke(routed, ["memory"]);
				expect(memoryOnly).toBe(baselineMemory);
				expect(memoryOnly).not.toContain("讣");
				expect(search).toHaveBeenCalledTimes(1);
				expect(search.mock.calls[0]?.[4]?.sources).toEqual(["memory"]);
				search.mockClear();
				const fused = await invoke(routed);
				expect(fused).toBe(baselineAll);
				expect(fused).not.toContain("讣");
				expect(search).toHaveBeenCalledTimes(2);
				expect(search.mock.calls[0]?.[4]?.sources).toEqual([
					"git_commit", "primer", "note", "message",
				]);
				expect(search.mock.calls[1]?.[4]?.sources).toBeUndefined();
				expect(currentDb).toHaveBeenCalledTimes(index === 0 ? 0 : 2);
			}
			// A dashboard restore with no update row is unsafe even if the
			// slot never contained the memory.
			writeFileSync(prefixPath, JSON.stringify([
				{ role: "system", content: "sys" },
				{ role: "user", content: "no memory entries" },
				{ role: "assistant", content: "ack" },
			]));
			writeFileSync(ledgerPath, `${add}\n${remove}\n`);
			expect(await invoke(routed, ["memory"])).toBe(baselineMemory);
			expect(await invoke(routed)).toBe(baselineAll);
			expect(calls).toBe(0);
			rmSync(ledgerPath, { force: true });
			writeFileSync(`${prefixPath}.pending-write.json`, "{}");
			expect(await invoke(routed, ["memory"])).toBe(baselineMemory);
			expect(await invoke(routed)).toBe(baselineAll);
			expect(calls).toBe(0);
			rmSync(`${prefixPath}.pending-write.json`);
			for (status of [409, 400]) {
				rmSync(`${prefixPath}.sidecar-stale.json`, { force: true });
				expect(await invoke(routed)).toBe(baselineAll);
			}
			expect(calls).toBe(2);
		} finally {
			currentDb.mockRestore();
			search.mockRestore();
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("logs a failing timestamp side-query and returns classic without calling Strata", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-"));
		const prefixPath = join(prefixDir, "prefix.json");
		writeFileSync(prefixPath, JSON.stringify([{ role: "system", content: "sys" }]));
		let calls = 0;
		const server = Bun.serve({
			port: 0, hostname: "127.0.0.1",
			fetch() { calls++; return new Response(null, { status: 404 }); },
		});
		const search = spyOn(searchModule, "unifiedSearch").mockResolvedValue([{
			source: "message", content: "sqlite archive", score: 1,
			messageOrdinal: 3, messageId: "m3", role: "user", sessionId: "ses-search", messageTimeMs: null,
		}]);
		const originalPrepare = db.prepare.bind(db);
		const prepare = spyOn(db, "prepare").mockImplementation((sql) => {
			if (sql.includes("SELECT message_ordinal, message_time_ms")) throw new Error("side-query failed");
			return originalPrepare(sql);
		});
		const logged = spyOn(logger, "log").mockImplementation(() => {});
		const common = { db, memoryEnabled: true, embeddingEnabled: false, resolveProjectIdentity: () => "git:pi-strata" };
		const ctx = fakeContext("ses-search", "/repo/pi-strata") as never;
		const query = "where is sqlite";
		try {
			const baseline = await createCtxSearchTool(common).execute(
				"classic", { query, sources: ["git_commit", "primer", "note", "message"] },
				new AbortController().signal, undefined, ctx,
			);
			search.mockClear();
			const tool = createCtxSearchTool({
				...common,
				resolveStrataAsk: () => ({
					baseUrl: String(server.url).replace(/\/$/, ""), apiKey: "key", apiKeyEnv: null,
					model: "test", slotFile: "mc-mem-v1.bin", prefixPath, project: "git:pi-strata",
					maxTokens: 64, timeoutMs: 1500, transientBudgetTokens: 1000,
					contextDocsBudgetTokens: 4000,
				}),
			});
			const result = await tool.execute("fusion", { query }, new AbortController().signal, undefined, ctx);
			expect(result.content[0]?.text).toBe(baseline.content[0]?.text);
			expect(search).toHaveBeenCalledTimes(1);
			search.mockImplementation(async (_db, _session, _project, _query, options) =>
				options?.sources ? [{
					source: "message", content: "sqlite archive", score: 1,
					messageOrdinal: 3, messageId: "m3", role: "user", sessionId: "ses-search", messageTimeMs: null,
				}] : [{
					source: "memory", content: "sqlite memory hit", score: 1,
					memoryId: 123, category: "RESEARCH", matchType: "fts",
				}],
			);
			for (const marker of ["sidecar-stale", "pending-write"]) {
				const markerPath = `${prefixPath}.${marker}.json`;
				writeFileSync(markerPath, marker === "sidecar-stale"
					? JSON.stringify({ reason: "skipped_recovery", at: "now" }) : "{}");
				search.mockClear();
				const marked = await tool.execute("fusion", { query }, new AbortController().signal, undefined, ctx);
				expect(marked.content[0]?.text).toContain("sqlite memory hit");
				expect(search).toHaveBeenCalledTimes(2);
				expect(search.mock.calls[1]?.[4]?.sources).toBeUndefined();
				rmSync(markerPath);
			}
			writeFileSync(statusChangesPathFor(prefixPath, "mc-mem-v1.bin"), '{"op":"rem');
			search.mockClear();
			const torn = await tool.execute("fusion", { query }, new AbortController().signal, undefined, ctx);
			expect(torn.content[0]?.text).toContain("sqlite memory hit");
			expect(search).toHaveBeenCalledTimes(2);
			expect(search.mock.calls[1]?.[4]?.sources).toBeUndefined();
			expect(calls).toBe(0);
			expect(logged).toHaveBeenCalledWith("[ctx_search] transient-material fallback: side-query failed");
		} finally {
			logged.mockRestore();
			prepare.mockRestore();
			search.mockRestore();
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not call the network when the resolved identity is not the bound project", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-"));
		const prefixPath = join(prefixDir, "prefix.json");
		writeFileSync(prefixPath, JSON.stringify([{ role: "system", content: "sys" }]));
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				calls++;
				return Response.json({ n_restored: 1 });
			},
		});
		const connection = {
			baseUrl: String(server.url).replace(/\/$/, ""),
			apiKey: "pi-strata-key",
			apiKeyEnv: null,
			model: "qwen-test",
			slotFile: "mc-mem-v1.bin",
			prefixPath,
			project: "git:bound",
			maxTokens: 64,
			timeoutMs: 1500,
			transientBudgetTokens: 1000,
			contextDocsBudgetTokens: 4000,
		};
		const tool = createCtxSearchTool({
			db,
			memoryEnabled: false,
			embeddingEnabled: false,
			resolveProjectIdentity: () => "git:other",
			resolveStrataAsk: () => connection,
		});
		try {
			const result = await tool.execute(
				"strata-mismatch",
				{ query: "where is sqlite" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", "/repo/other") as never,
			);
			expect(result.content[0]?.text ?? "").toContain("No hidden results found");
			expect(result.content[0]?.text ?? "").not.toContain("本答案由项目记忆缓存合成");
			expect(calls).toBe(0);
		} finally {
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("treats a substitution failure as disabled with zero network", async () => {
		const db = createTestDb();
		const home = mkdtempSync(join(tmpdir(), "mc-pi-strata-home-"));
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-"));
		const prefixPath = join(prefixDir, "prefix.json");
		writeFileSync(prefixPath, JSON.stringify([{ role: "system", content: "sys" }]));
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch() {
				calls++;
				return Response.json({ n_restored: 1 });
			},
		});
		mkdirSync(join(home, ".config", "cortexkit"), { recursive: true });
		writeFileSync(
			join(home, ".config", "cortexkit", "magic-context.jsonc"),
			JSON.stringify({
				memory: {
					strata_ask: {
						enabled: true,
						base_url: String(server.url).replace(/\/$/, ""),
						api_key: "still-valid",
						model: "qwen-test",
						slot_file: "mc-mem-v1.bin",
						prefix_path: `${prefixPath}{env:MC_PI_STRATA_MISSING_LANG}`,
						project: "git:bound",
					},
				},
			}),
		);
		const previousHome = process.env.HOME;
		const previousXdg = process.env.XDG_CONFIG_HOME;
		const previousLang = process.env.MC_PI_STRATA_MISSING_LANG;
		delete process.env.MC_PI_STRATA_MISSING_LANG;
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		const tool = createCtxSearchTool({
			db,
			memoryEnabled: false,
			embeddingEnabled: false,
			resolveProjectIdentity: () => "git:bound",
			resolveStrataAsk: (cwd) => resolvePiStrataAsk(cwd),
		});
		try {
			const result = await tool.execute(
				"strata-subst",
				{ query: "where is sqlite" },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", "/repo/pi-subst") as never,
			);
			expect(result.content[0]?.text ?? "").toContain("No hidden results found");
			expect(result.content[0]?.text ?? "").not.toContain("本答案由项目记忆缓存合成");
			expect(calls).toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previousXdg;
			if (previousLang === undefined) delete process.env.MC_PI_STRATA_MISSING_LANG;
			else process.env.MC_PI_STRATA_MISSING_LANG = previousLang;
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("appends reserved hits on fusion answered and miss, never on classic fallback (Pi parity)", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-reserved-"));
		const prefixPath = join(prefixDir, "prefix.json");
		writeFileSync(prefixPath, JSON.stringify([
			{ role: "system", content: "sys" },
			{ role: "user", content: "mem" },
			{ role: "assistant", content: "ack" },
		]));
		const messageResult: MessageSearchResult = {
			source: "message",
			content: "reserved snippet body",
			score: 1,
			messageOrdinal: 7,
			messageId: "m7",
			role: "user",
			sessionId: "ses-reserved-full",
			messageTimeMs: 1767225600000,
		};
		const gitResult: GitCommitSearchResult = {
			source: "git_commit",
			content: "reserved commit subject",
			score: 1,
			sha: "sha-reserved-1",
			shortSha: "sres1",
			author: null,
			committedAtMs: 1767225600000,
			matchType: "fts",
		};
		const APPENDIX = [
			"保留命中：",
			"- [message] ses-rese 2026-01-01T00:00:00.000Z reserved snippet body",
			'  ctx_expand(sessionId: "ses-reserved-full", message: 7)',
			"- [git_commit] sres1 2026-01-01T00:00:00.000Z reserved commit subject",
		].join("\n");
		let mode: "hit" | "miss" | "409" = "hit";
		let chatMessages: Array<{ role: string; content: string }> = [];
		const server = Bun.serve({
			port: 0, hostname: "127.0.0.1",
			async fetch(req) {
				chatMessages = ((await req.json()) as { messages: Array<{ role: string; content: string }> }).messages;
				if (mode === "409") return new Response(null, { status: 409 });
				return Response.json({
					choices: [{ message: { content: mode === "hit" ? JSON.stringify({ answer: "保留答案", memoryIds: [] }) : "记忆库中无" } }],
					session: { splice: { resume_ok: true } },
				});
			},
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _session, _project, _query, options) => {
				if (options?.sources) {
					options.collectReservedCandidates?.({
						messages: [messageResult],
						gitCommits: [gitResult],
						currentSessionMessages: [],
					});
				} else {
					expect(options?.collectReservedCandidates).toBeUndefined();
				}
				return [messageResult, gitResult];
			},
		);
		const ctx = fakeContext("ses-search", "/repo/pi-reserved") as never;
		const query = "where is sqlite";
		const invoke = async (resolve: boolean) => {
			const tool = createCtxSearchTool({
				db, memoryEnabled: false, embeddingEnabled: false,
				resolveProjectIdentity: () => "git:pi-reserved",
				resolveStrataAsk: resolve ? () => ({
					baseUrl: String(server.url).replace(/\/$/, ""), apiKey: "pi-strata-key",
					apiKeyEnv: null, model: "qwen-test", slotFile: "mc-mem-v1.bin", prefixPath,
					project: "git:pi-reserved", maxTokens: 64, timeoutMs: 1500, transientBudgetTokens: 1000,
					contextDocsBudgetTokens: 4000,
				}) : () => null,
			});
			const result = await tool.execute("reserved", { query }, new AbortController().signal, undefined, ctx);
			return result.content[0]?.text ?? "";
		};
		try {
			const classicText = await invoke(false);
			expect(await invoke(true)).toBe(
				`答案：\n保留答案\n\n依据记忆：\n无可核验的记忆依据\n${STRATA_ASK_FOOTER}\n\n${APPENDIX}`,
			);
			expect(chatMessages[0]?.content).not.toContain("保留命中：");
			mode = "miss";
			expect(await invoke(true)).toBe(`${classicText}\n\n${APPENDIX}`);
			mode = "409";
			expect(await invoke(true)).toBe(classicText);
			const collectors = spy.mock.calls.map(
				(call) => (call[4] as { collectReservedCandidates?: unknown } | undefined)?.collectReservedCandidates,
			);
			expect(collectors.filter(Boolean)).toHaveLength(3);
			expect(collectors[collectors.length - 1]).toBeUndefined();
		} finally {
			spy.mockRestore();
			server.stop(true);
			rmSync(prefixDir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});
