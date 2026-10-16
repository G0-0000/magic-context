import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	registerConfiguredTodoLifecycle,
	resolveHistorianFromConfig,
} from "./index";
import { createTestDb } from "./test-utils.test";
import { registerMagicContextTools } from "./tools";

const INDEX_SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

describe("Pi recomp and wrapup historian output-cap config", () => {
	it("resolves configured and unset caps using the historian config", () => {
		const configured = MagicContextConfigSchema.parse({
			historian: { maxTokens: 65_536, pi: { model: "provider/model" } },
		});
		const unset = MagicContextConfigSchema.parse({
			historian: { pi: { model: "provider/model" } },
		});

		expect(resolveHistorianFromConfig(configured, "pi")?.maxOutputTokens).toBe(
			65_536,
		);
		expect(
			resolveHistorianFromConfig(unset, "pi")?.maxOutputTokens,
		).toBeUndefined();
	});

	it("uses the live-resolved cap for both command runtime dependency sets", () => {
		const bootWiring =
			INDEX_SOURCE.match(
				/historianMaxOutputTokens: bootProjectDeps\.historianConfig\?\.maxOutputTokens/g,
			) ?? [];
		const liveWiring =
			INDEX_SOURCE.match(
				/historianMaxOutputTokens: historian\?\.maxOutputTokens/g,
			) ?? [];

		expect(bootWiring).toHaveLength(2);
		expect(liveWiring).toHaveLength(2);
	});
});

describe("Pi todowrite registration from resolved config", () => {
	it.each([
		undefined,
		true,
		false,
	])("registers tool, command and overlay only when enabled is %s", (enabled) => {
		const config = MagicContextConfigSchema.parse(
			enabled === undefined ? {} : { todowrite: { enabled } },
		);
		const db = createTestDb();
		try {
			const tools: string[] = [];
			const commands: string[] = [];
			const handlers: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => tools.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
				on: (name: string) => handlers.push(name),
			} as never;
			registerMagicContextTools(pi, {
				db,
				todowriteEnabled: config.todowrite.enabled,
			});
			const overlay = registerConfiguredTodoLifecycle(pi, {
				configured: config.todowrite.enabled,
				overlay: config.todowrite.overlay,
				readLastTodoState: () => "",
			});
			expect(tools.includes("todowrite")).toBe(enabled === true);
			expect(commands.includes("todos")).toBe(enabled === true);
			expect(overlay !== undefined).toBe(enabled === true);
			expect(handlers.includes("session_start")).toBe(enabled === true);
		} finally {
			closeQuietly(db);
		}
	});
});

afterEach(() => {
	__test.resetLoggedPiConfigDirs();
});

describe("Pi config load logging", () => {
	it("dedupes /cd config warnings per directory", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-b",
				loadedFromPaths: [],
				warnings: ["Ignoring execute_threshold_percentage from project config"],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.filter((message) => message.includes("config loaded from:")),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"config: no magic-context.jsonc found, using schema defaults",
					),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes("Ignoring historian.model from project config"),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"Ignoring execute_threshold_percentage from project config",
					),
				),
			).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("surfaces the protected_tokens below-minimum warning through the config load log", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-belowmin",
				loadedFromPaths: [
					"/tmp/project-belowmin/.cortexkit/magic-context.jsonc",
				],
				warnings: [
					"protected_tokens is a token floor (minimum 4000, default derived from the context window); 20 looks like the old protected_tags count. Remove the key to use the default, or set a token count such as 16000.",
				],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.some((message) =>
					message.includes("protected_tokens is a token floor"),
				),
			).toBe(true);
			expect(
				messages.some((message) =>
					message.includes("20 looks like the old protected_tags count"),
				),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("Pi deferred compaction marker rehydration logging", () => {
	it("names sessions, caps the list, and reports active-session membership", () => {
		expect(
			__test.formatPiMarkerRehydrationLine(["active", "other"], "active"),
		).toBe(
			"[magic-context][pi] rehydrated 2 Pi deferred compaction marker session(s); sessionIds=active,other; activeSessionIncluded=true",
		);
		const many = Array.from({ length: 7 }, (_, index) => `session-${index}`);
		expect(__test.formatPiMarkerRehydrationLine(many, "not-listed")).toBe(
			"[magic-context][pi] rehydrated 7 Pi deferred compaction marker session(s); sessionIds=session-0,session-1,session-2,session-3,session-4 +2 more; activeSessionIncluded=false",
		);
	});
});
