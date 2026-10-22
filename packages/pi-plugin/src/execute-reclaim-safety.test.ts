import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "../../plugin/src/features/magic-context/storage";
import * as executeModule from "../../plugin/src/hooks/magic-context/execute-reclaim";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { rideHarness } from "./deferred-ride-evidence.test";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const digest = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");

function piHarness() {
	const h = rideHarness(true, "small");
	let rebuilds = 0;
	const restore = __test.setPipelineResultObserverForTests((id, result) => {
		if (id === h.id && result.bustedThisPass) rebuilds++;
	});
	return {
		...h,
		get rebuilds() {
			return rebuilds;
		},
		finish: () => h.finishHistorian(),
		close: () => {
			restore();
			h.close();
		},
	};
}

test("state-write failure preserves Pi bytes when a last-good replay is unavailable", async () => {
	const { dropSlot } = await import(
		"../../plugin/src/hooks/magic-context/lkg-slot"
	);
	const h = piHarness();
	const messages: string[] = [];
	try {
		const warm = await h.pass(40);
		h.queue();
		dropSlot(h.id);
		const before = h.rebuilds;
		const originalPrepare = h.db.prepare.bind(h.db);
		const failure = Object.assign(new Error("database is locked"), {
			code: "SQLITE_BUSY",
			errno: 5,
		});
		const spy = spyOn(h.db, "prepare").mockImplementation(((sql: string) => {
			const statement = originalPrepare(sql);
			if (
				sql.includes(
					"UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?",
				)
			) {
				return new Proxy(statement, {
					get(target, key) {
						if (key === "run")
							return (...args: unknown[]) => {
								if (String(args[0]).includes('"heldPasses":1')) throw failure;
								return (target.run as (...values: unknown[]) => unknown)(
									...args,
								);
							};
						const value = Reflect.get(target, key);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			}
			return statement;
		}) as typeof h.db.prepare);
		let served: unknown;
		try {
			served = await h.pass(76);
		} catch (e) {
			messages.push(`${(e as Error).name}: ${(e as Error).message}`);
		} finally {
			spy.mockRestore();
		}
		console.log(
			"PI_STATE_WRITE_FAILURE",
			JSON.stringify({
				messages,
				busts: h.rebuilds - before,
				pending: getPendingOps(h.db, h.id).length,
			}),
		);
		expect(messages).toHaveLength(0);
		expect(served).toEqual(warm);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(h.rebuilds).toBe(before);
	} finally {
		await h.finish();
		h.close();
	}
});

test("native marker failure prevents execute admissions until authorization succeeds", async () => {
	const db = createTestDb();
	const fake = createFakePi();
	const id = "native-deferred-drop";
	const nativeModel = {
		id: "native-upgrade-codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		contextWindow: 100000,
		maxTokens: 4096,
	};
	const raw: Array<
		| ReturnType<typeof userMessage>
		| ReturnType<typeof assistantMessage>
		| ReturnType<typeof toolResultMessage>
	> = [userMessage("first", 1)];
	for (let i = 0; i < 6; i++) {
		raw.push(
			assistantMessage("visible answer", 2 + i * 4, {
				api: nativeModel.api,
				provider: nativeModel.provider,
				model: nativeModel.id,
				content: [
					{
						type: "toolCall",
						id: `call-${i}|fc-${i}`,
						name: "read",
						arguments: { path: `original-${i}` },
					},
				],
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: nativeModel.provider,
					dt: true,
					items: [
						{
							type: "function_call",
							id: `fc-${i}`,
							call_id: `call-${i}`,
							name: "read",
							arguments: JSON.stringify({ path: `original-${i}` }),
						},
					],
				},
			}),
			toolResultMessage(
				`call-${i}|fc-${i}`,
				`Output ${i}: ${"source text ".repeat(200)}`,
				3 + i * 4,
			),
			userMessage("continue", 4 + i * 4),
		);
	}
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		scheduler: { executeThresholdPercentage: 75 },
	});
	const pass = async (percent: number) => {
		updateSessionMeta(db, id, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = structuredClone(raw);
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("The registered context handler is missing");
		const result = (await handler(
			{ messages } as never,
			{
				...fakeContext(
					id,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				model: nativeModel,
				getContextUsage: () => ({
					percent,
					tokens: percent * 1000,
					contextWindow: 100000,
				}),
			} as never,
		)) as { messages: unknown[] } | undefined;
		if (!result) throw new Error("Missing native context result");
		return result.messages;
	};
	let busts = 0;
	const restore = __test.setPipelineResultObserverForTests(
		(session, result) => {
			if (session === id && result.bustedThisPass) busts++;
		},
	);
	const admissions: Array<{ estimate: number; allowed: boolean }> = [];
	const original = executeModule.originateExecuteReclaim;
	const spy = spyOn(
		executeModule,
		"originateExecuteReclaim",
	).mockImplementation((args) => {
		const allowed = original(args);
		if (args.sessionId === id)
			admissions.push({ estimate: args.reclaimableTokens, allowed });
		return allowed;
	});
	try {
		const warm = await pass(40);
		expect(JSON.stringify(warm)).not.toContain(
			"__magic_context_remove_tool_arc__",
		);
		const tag = getTagsBySession(db, id).find(
			(t) => t.type === "tool" && t.messageId === "call-0|fc-0",
		);
		if (!tag) throw new Error("Missing native tool tag");
		queuePendingOp(db, id, tag.tagNumber, "drop");
		db.exec(
			`CREATE TRIGGER fail_native_write BEFORE UPDATE OF trailing_blank_decisions ON session_meta WHEN COALESCE(json_extract(NEW.trailing_blank_decisions,'$.piNative.toolInputs'),'{}') != COALESCE(json_extract(NULLIF(OLD.trailing_blank_decisions,''),'$.piNative.toolInputs'),'{}') BEGIN SELECT RAISE(FAIL,'native persistence failure'); END;`,
		);
		admissions.length = 0;
		const before = busts;
		const removedJsonBytes: number[] = [];
		for (let i = 0; i < 6; i++) {
			const served = await pass(76);
			removedJsonBytes.push(
				Buffer.byteLength(JSON.stringify(warm)) -
					Buffer.byteLength(JSON.stringify(served)),
			);
			expect(JSON.stringify(served)).toBe(JSON.stringify(warm));
		}
		console.log(
			"NATIVE_DEFER_ESTIMATE",
			JSON.stringify({
				admissions,
				removedJsonBytes,
				busts: busts - before,
				pending: getPendingOps(db, id).length,
			}),
		);
		expect(getPendingOps(db, id)).toHaveLength(1);
		expect(admissions).toHaveLength(6);
		expect(admissions.filter((a) => a.allowed)).toHaveLength(0);
		expect(admissions.every((a) => a.estimate === 0)).toBe(true);
		expect(busts).toBe(before);
		db.exec("DROP TRIGGER fail_native_write");
		expect(await pass(76)).toEqual(warm);
		expect(await pass(76)).toEqual(warm);
		const replay = JSON.stringify(
			db
				.prepare(
					"SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?",
				)
				.get(id),
		);
		expect(replay).not.toContain("__magic_context_remove_tool_arc__");
		expect(await pass(76)).not.toEqual(warm);
		expect(getPendingOps(db, id)).toHaveLength(0);
		expect(busts).toBe(before + 1);
	} finally {
		spy.mockRestore();
		restore();
		clearContextHandlerSession(id);
		db.close();
	}
});

test("failure to clear execute state serves the prepared drop and stable defer", async () => {
	const h = piHarness();
	try {
		const warm = await h.pass(40);
		h.queue();
		expect(await h.pass(76)).toEqual(warm);
		expect(await h.pass(77)).toEqual(warm);
		h.db.exec(
			`CREATE TRIGGER fail_execute_clear BEFORE UPDATE OF trailing_blank_decisions ON session_meta WHEN json_extract(OLD.trailing_blank_decisions,'$.executeReclaim.heldPasses')>0 AND json_extract(NEW.trailing_blank_decisions,'$.executeReclaim.heldPasses')=0 BEGIN SELECT RAISE(ABORT,'execute clear write failed'); END;`,
		);
		const before = h.rebuilds;
		let failure: unknown;
		let served: unknown;
		try {
			served = await h.pass(79);
		} catch (error) {
			failure = error;
		}
		const row = h.db
			.prepare(
				"SELECT trailing_blank_decisions FROM session_meta WHERE session_id=?",
			)
			.get(h.id) as { trailing_blank_decisions: string };
		const state = JSON.parse(row.trailing_blank_decisions).executeReclaim;
		const pending = getPendingOps(h.db, h.id).length;
		expect(failure).toBeUndefined();
		expect(served).not.toEqual(warm);
		expect(pending).toBe(0);
		expect(state.heldPasses).toBe(3);
		h.db.exec("DROP TRIGGER fail_execute_clear");
		const deferred = await h.pass(40);
		const marker = "File 2: preserving the content and order matters.";
		expect(JSON.stringify(warm)).toContain(marker);
		expect(JSON.stringify(deferred)).not.toContain(marker);
		console.log(
			"FAILED_CLEAR_WIRE",
			JSON.stringify({
				error: failure instanceof Error ? failure.name : undefined,
				pending,
				observerRebuilds: h.rebuilds - before,
				state,
				deferChanged: digest(warm) !== digest(deferred),
			}),
		);
		expect(deferred).toEqual(served);
		expect(h.rebuilds).toBe(before + 1);
	} finally {
		await h.finish();
		h.close();
	}
});
