/**
 * Standalone test for wirematch.ts — runs against real snapshots on disk.
 * Usage: node --experimental-strip-types test-wirematch.ts <snapshot.json>...
 */
import { pairWireMessages, findWireTool } from "./wirematch.ts";
import { readFileSync } from "node:fs";

interface Wrapper {
	snapshot: {
		index: number;
		api?: string;
		messages: unknown[];
		payload: unknown;
		tools?: { name: string }[];
	};
}

const files = process.argv.slice(2);
let failures = 0;

for (const file of files) {
	const snap = (JSON.parse(readFileSync(file, "utf8")) as Wrapper).snapshot;
	const wireMsgs = Array.isArray((snap.payload as { messages?: unknown })?.messages)
		? ((snap.payload as { messages: unknown[] }).messages as unknown[])
		: [];
	const pair = pairWireMessages(snap as never);
	const matched = pair.matched.filter((m) => m !== undefined).length;
	const noted = pair.notes.filter((n) => n !== undefined).length;
	const status =
		matched === snap.messages.length && pair.wireOnly.length === 0
			? "OK  "
			: noted > 0 || pair.wireOnly.length > 0
				? "PART"
				: "FAIL";
	if (status === "FAIL") failures++;
	console.log(
		`${status} #${snap.index} api=${snap.api ?? "?"} 语义=${snap.messages.length} wire=${wireMsgs.length} 配对=${matched} 无对应=${noted} wire独有=${pair.wireOnly.length}`,
	);
	// sanity: matched wire roles should be consistent with semantic roles
	const roleMap: Record<string, string> = {
		user: "user",
		assistant: "assistant",
		system: "system",
		toolResult: "tool",
	};
	snap.messages.forEach((m, i) => {
		const w = pair.matched[i];
		if (w === undefined) return;
		const semRole = (m as { role?: string }).role ?? "?";
		const wireRole = (w as { role?: string }).role ?? "?";
		const expected = roleMap[semRole] ?? semRole;
		if (snap.api === "anthropic-messages" && semRole === "toolResult") return; // merged into user
		if (wireRole !== expected) {
			failures++;
			console.log(`     role mismatch at #${i + 1}: ${semRole} → ${wireRole} (expected ${expected})`);
		}
	});
	// tools: every declared tool should resolve to a wire tool entry
	for (const tool of snap.tools ?? []) {
		const w = findWireTool(snap.payload, tool.name);
		if (w === undefined) {
			failures++;
			console.log(`     tool not found in wire: ${tool.name}`);
		}
	}
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
