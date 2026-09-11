#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DebugHeapSnapshotResponse } from "../../plugin/src/shared/rpc-types";
import { TestHarness } from "../src/harness";

function rpcDiscoveryFile(dataDir: string): string {
	const root = join(dataDir, "cortexkit", "magic-context", "rpc");
	for (const project of readdirSync(root)) {
		const directory = join(root, project);
		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry);
			if (
				entry.startsWith("port-") &&
				entry.endsWith(".json") &&
				existsSync(path)
			)
				return path;
		}
	}
	throw new Error(
		`No hermetic Magic Context RPC discovery record under ${root}`,
	);
}

async function main(): Promise<void> {
	const requestedMessages = Number(process.argv[2] ?? 2_000);
	if (!Number.isSafeInteger(requestedMessages) || requestedMessages < 2_000) {
		throw new Error("message target must be an integer >= 2000");
	}
	const prompts = Math.ceil(requestedMessages / 2);
	const harness = await TestHarness.create({
		magicContextConfig: {
			debug_rpc: true,
			dreamer: { disable: true },
			sidekick: { disable: true },
			memory: { enabled: false },
			commit_cluster_trigger: { enabled: false },
		},
		modelContextLimit: 1_000_000,
	});

	try {
		const sessionId = await harness.createSession();
		for (let turn = 1; turn <= prompts; turn += 1) {
			await harness.sendPrompt(
				sessionId,
				`Hermetic heap-attribution turn ${turn}: retain this short unique marker ${crypto.randomUUID()}.`,
			);
			if (turn % 100 === 0) console.error(`drove ${turn * 2} messages`);
		}

		const discovery = JSON.parse(
			readFileSync(rpcDiscoveryFile(harness.opencode.env.dataDir), "utf8"),
		) as {
			port: number;
			token: string;
		};
		const response = await fetch(
			`http://127.0.0.1:${discovery.port}/rpc/debug.heapSnapshot`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${discovery.token}` },
				body: "{}",
				signal: AbortSignal.timeout(180_000),
			},
		);
		const result = (await response.json()) as DebugHeapSnapshotResponse & {
			error?: string;
		};
		if (!response.ok || result.error) {
			throw new Error(
				`heap snapshot RPC failed (${response.status}): ${result.error ?? "unknown"}`,
			);
		}
		const driven = result.holders.sessions.find(
			(session) => session.sessionId === sessionId,
		);
		if (!driven || driven.taggerAssignments < requestedMessages) {
			throw new Error(
				`long-session holder proof failed: expected >=${requestedMessages} assignments, got ${driven?.taggerAssignments ?? 0}`,
			);
		}
		console.log(
			JSON.stringify({ sessionId, requestedMessages, ...result }, null, 2),
		);
	} finally {
		await harness.dispose();
	}
}

if (import.meta.main) {
	await main();
}
