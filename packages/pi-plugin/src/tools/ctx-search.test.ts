import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
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
				category: "ARCHITECTURE",
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
			category: "ARCHITECTURE",
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
						category: "ARCHITECTURE",
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

	it("routes a bare query through strata and leaves classic search untouched on a miss", async () => {
		const db = createTestDb();
		const prefixDir = mkdtempSync(join(tmpdir(), "mc-pi-strata-"));
		const prefixPath = join(prefixDir, "prefix.json");
		writeFileSync(
			prefixPath,
			JSON.stringify([
				{ role: "system", content: "sys" },
				{ role: "assistant", content: "ack" },
			]),
		);
		let calls = 0;
		let mode = "hit";
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				calls++;
				const url = new URL(req.url);
				if (url.pathname === "/slots/0") return Response.json({ n_restored: 1 });
				return Response.json({
					choices: [
						{
							message: {
								content: mode === "hit" ? "答案一行\n#1032：概括" : "记忆库中无",
								reasoning_content: "skip",
							},
						},
					],
				});
			},
		});
		const spy = spyOn(searchModule, "unifiedSearch");
		const ctx = fakeContext("ses-search", "/repo/pi-strata") as never;
		const invoke = async (
			args: { query: string; sources?: ["memory"]; limit?: number; from?: string },
			resolve: boolean,
		) => {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				resolveProjectIdentity: () => "git:pi-strata",
				resolveStrataAsk: resolve
					? () => ({
							baseUrl: String(server.url).replace(/\/$/, ""),
							apiKey: "pi-strata-key",
							apiKeyEnv: null,
							model: "qwen-test",
								slotFile: "mc-mem-v1.bin",
								prefixPath,
								project: "git:pi-strata",
								maxTokens: 64,
							timeoutMs: 1500,
						})
					: () => null,
			});
			const result = await tool.execute(
				"strata-call",
				args,
				new AbortController().signal,
				undefined,
				ctx,
			);
			return result.content[0]?.text ?? "";
		};
		try {
			const baseline = await invoke({ query: "where is sqlite" }, false);
			expect(calls).toBe(0);
			const before = spy.mock.calls.length;
			const hit = await invoke({ query: "where is sqlite" }, true);
			expect(hit).toContain("答案一行");
			expect(hit).toContain("本答案由项目记忆缓存合成");
			expect(hit).not.toContain("Found ");
			expect(spy.mock.calls.length).toBe(before);
			mode = "miss";
			const missed = await invoke({ query: "where is sqlite" }, true);
			expect(missed).toBe(baseline);
			const networked = calls;
			await invoke({ query: "where is sqlite", sources: ["memory"] }, true);
			await invoke({ query: "where is sqlite", limit: 2 }, true);
			await invoke({ query: "where is sqlite", from: "2026-01-01" }, true);
			await invoke({ query: "#1035" }, true);
			expect(calls).toBe(networked);
		} finally {
			spy.mockRestore();
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
});
