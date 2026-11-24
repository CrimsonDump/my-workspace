/**
 * what-model-sees — snapshot diffing.
 *
 * Line diff for text (system prompt) plus a structural diff between two
 * request snapshots (tools, messages, sizes).
 */
import { describeMessage, formatChars } from "./sanitize.ts";
import type { RequestSnapshot } from "./types.ts";

export interface LineDiffEntry {
	type: "+" | "-" | " ";
	text: string;
}

export interface LineDiffResult {
	entries: LineDiffEntry[];
	added: number;
	removed: number;
	truncated: boolean;
}

/** LCS-based line diff with prefix/suffix trimming and a size guard. */
export function diffLines(aText: string, bText: string, maxEntries = 300): LineDiffResult {
	const a = aText.length === 0 ? [] : aText.split("\n");
	const b = bText.length === 0 ? [] : bText.split("\n");

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	const midA = a.slice(prefix, a.length - suffix);
	const midB = b.slice(prefix, b.length - suffix);

	let mid: LineDiffEntry[];
	if (midA.length * midB.length > 1_000_000) {
		// Too large for DP: mark the whole middle as a block replacement.
		mid = [
			...midA.map((text) => ({ type: "-" as const, text })),
			...midB.map((text) => ({ type: "+" as const, text })),
		];
	} else {
		mid = lcsDiff(midA, midB);
	}

	const added = mid.filter((e) => e.type === "+").length;
	const removed = mid.filter((e) => e.type === "-").length;

	// Keep a little context around changes; collapse the rest.
	const entries: LineDiffEntry[] = [];
	const CONTEXT = 2;
	let i = 0;
	let emitted = 0;
	let truncated = false;
	const emit = (e: LineDiffEntry) => {
		if (entries.length >= maxEntries) {
			truncated = true;
			return;
		}
		entries.push(e);
		emitted++;
	};
	// opening context
	for (const line of a.slice(Math.max(0, prefix - CONTEXT), prefix)) {
		emit({ type: " ", text: line });
	}
	while (i < mid.length && !truncated) {
		const entry = mid[i];
		if (entry.type === " ") {
			// run of unchanged lines inside the middle
			let j = i;
			while (j < mid.length && mid[j].type === " ") j++;
			const run = j - i;
			if (run > CONTEXT * 2 + 1) {
				for (const line of mid.slice(i, i + CONTEXT).map((e) => e.text)) emit({ type: " ", text: line });
				emit({ type: " ", text: `⋯ ${run - CONTEXT * 2} unchanged lines ⋯` });
				for (const e of mid.slice(j - CONTEXT, j)) emit({ type: " ", text: e.text });
			} else {
				for (const e of mid.slice(i, j)) emit({ type: " ", text: e.text });
			}
			i = j;
		} else {
			emit(entry);
			i++;
		}
	}
	if (!truncated) {
		for (const line of a.slice(a.length - suffix, a.length - suffix + CONTEXT)) {
			emit({ type: " ", text: line });
		}
	}
	void emitted;
	return { entries, added, removed, truncated };
}

function lcsDiff(a: string[], b: string[]): LineDiffEntry[] {
	const n = a.length;
	const m = b.length;
	// DP table (n+1) x (m+1)
	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? dp[(i + 1) * width + (j + 1)] + 1
					: Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
		}
	}
	const out: LineDiffEntry[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: " ", text: a[i] });
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
			out.push({ type: "-", text: a[i] });
			i++;
		} else {
			out.push({ type: "+", text: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ type: "-", text: a[i++] });
	while (j < m) out.push({ type: "+", text: b[j++] });
	return out;
}

// ---------------------------------------------------------------------------
// Snapshot diff
// ---------------------------------------------------------------------------

export interface MessageDelta {
	role: string;
	label: string;
	chars: number;
	preview: string;
}

export interface SnapshotDiff {
	hasPrev: boolean;
	systemChanged: boolean;
	systemDiff: LineDiffResult;
	toolsAdded: string[];
	toolsRemoved: string[];
	messagesCommon: number;
	messagesAppended: MessageDelta[];
	messagesRemoved: number;
	messagesReplaced: number;
	roleCharDelta: Record<string, number>;
	payloadCharDelta: number;
	systemCharDelta: number;
}

export function diffSnapshots(prev: RequestSnapshot | undefined, next: RequestSnapshot): SnapshotDiff {
	if (!prev) {
		return {
			hasPrev: false,
			systemChanged: false,
			systemDiff: { entries: [], added: 0, removed: 0, truncated: false },
			toolsAdded: [],
			toolsRemoved: [],
			messagesCommon: 0,
			messagesAppended: [],
			messagesRemoved: 0,
			messagesReplaced: 0,
			roleCharDelta: {},
			payloadCharDelta: 0,
			systemCharDelta: 0,
		};
	}

	const systemDiff = diffLines(prev.systemPromptText, next.systemPromptText);

	const prevToolNames = new Set(prev.tools.map((t) => t.name));
	const nextToolNames = new Set(next.tools.map((t) => t.name));
	const toolsAdded = next.tools.filter((t) => !prevToolNames.has(t.name)).map((t) => t.name);
	const toolsRemoved = prev.tools.filter((t) => !nextToolNames.has(t.name)).map((t) => t.name);

	const aStrs = prev.messages.map((m) => safeJson(m));
	const bStrs = next.messages.map((m) => safeJson(m));
	let common = 0;
	while (common < aStrs.length && common < bStrs.length && aStrs[common] === bStrs[common]) common++;
	let suffix = 0;
	while (
		suffix < aStrs.length - common &&
		suffix < bStrs.length - common &&
		aStrs[aStrs.length - 1 - suffix] === bStrs[bStrs.length - 1 - suffix]
	) {
		suffix++;
	}
	const tailA = aStrs.length - common - suffix;
	const tailB = bStrs.length - common - suffix;
	const messagesReplaced = Math.min(tailA, tailB);
	const messagesRemoved = tailA - messagesReplaced;
	const messagesAppended: MessageDelta[] = next.messages
		.slice(common + messagesReplaced)
		.map((m) => {
			const d = describeMessage(m);
			return { role: d.role, label: d.label, chars: d.chars, preview: d.preview };
		});

	const roleCharDelta: Record<string, number> = {};
	for (const [role, stat] of Object.entries(next.stats.byRole)) {
		const before = prev.stats.byRole[role]?.chars ?? 0;
		const delta = stat.chars - before;
		if (delta !== 0) roleCharDelta[role] = delta;
	}
	for (const [role, stat] of Object.entries(prev.stats.byRole)) {
		if (!(role in next.stats.byRole)) roleCharDelta[role] = -stat.chars;
	}

	return {
		hasPrev: true,
		systemChanged: systemDiff.added > 0 || systemDiff.removed > 0,
		systemDiff,
		toolsAdded,
		toolsRemoved,
		messagesCommon: common,
		messagesAppended,
		messagesRemoved,
		messagesReplaced,
		roleCharDelta,
		payloadCharDelta: next.stats.payloadBytesRaw - prev.stats.payloadBytesRaw,
		systemCharDelta: next.stats.systemChars - prev.stats.systemChars,
	};
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return `[unserializable:${String(value)}]`;
	}
}

/** Compact one-line summary of a snapshot diff, used in the overview tab. */
export function summarizeDiff(diff: SnapshotDiff): string {
	if (!diff.hasPrev) return "";
	const parts: string[] = [];
	if (diff.systemChanged) {
		parts.push(`系统提示 ${formatDelta(diff.systemCharDelta)} chars（行 ${diff.systemDiff.added}+/${diff.systemDiff.removed}-）`);
	}
	if (diff.toolsAdded.length > 0) parts.push(`工具 +${diff.toolsAdded.length}`);
	if (diff.toolsRemoved.length > 0) parts.push(`工具 -${diff.toolsRemoved.length}`);
	if (diff.messagesAppended.length > 0) parts.push(`消息 +${diff.messagesAppended.length}`);
	if (diff.messagesReplaced > 0) parts.push(`替换 ${diff.messagesReplaced}`);
	if (diff.messagesRemoved > 0) parts.push(`移除 ${diff.messagesRemoved}`);
	if (parts.length === 0) parts.push("无可见变化");
	parts.push(`Payload ${formatDelta(diff.payloadCharDelta)}`);
	return parts.join(" · ");
}

export function formatDelta(n: number): string {
	return n >= 0 ? `+${formatChars(n)}` : `-${formatChars(-n)}`;
}
