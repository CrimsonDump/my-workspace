/**
 * what-model-sees — capture store.
 *
 * Listens (via index.ts) to pi's request pipeline and keeps a ring of
 * sanitized `RequestSnapshot`s: one per provider request. Snapshots are
 * persisted to disk (JSONL-free, one JSON file per request) and pruned.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	describeMessage,
	extractText,
	makeImageStats,
	roleStats,
	sanitizeMessages,
	sanitizeValue,
	totalMessageChars,
} from "./sanitize.ts";
import type {
	PromptOptionsInfo,
	RequestSnapshot,
	SnapshotStats,
	ToolMeta,
	UsageSummary,
} from "./types.ts";

const MEMORY_LIMIT = 100;
/** Global cap across every instance/session in the snapshot directory. */
const DISK_KEEP = 200;
/** Only re-scan the directory every N writes: pruning is O(files) stat calls. */
const PRUNE_EVERY = 10;

export interface PromptOptionsInput {
	cwd?: string;
	customPrompt?: string;
	forceSystemPrompt?: string;
	appendSystemPrompt?: string;
	selectedTools?: string[];
	hiddenTools?: string[];
	toolSnippets?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
	promptGuidelines?: string[];
	sections?: Record<string, string>;
	contextFiles?: Array<{ path: string; content?: string }>;
	skills?: Array<{ name?: string; description?: string; filePath?: string; sourceInfo?: { source?: string } }>;
}

export function sanitizePromptOptions(po: PromptOptionsInput | undefined | null): PromptOptionsInfo | null {
	if (!po) return null;
	return {
		cwd: po.cwd ?? "",
		customPrompt: po.customPrompt,
		forceSystemPrompt: po.forceSystemPrompt,
		appendSystemPrompt: po.appendSystemPrompt ?? "",
		selectedTools: [...(po.selectedTools ?? [])],
		hiddenTools: [...(po.hiddenTools ?? [])],
		toolSnippets: { ...(po.toolSnippets ?? {}) },
		toolGuidelines: { ...(po.toolGuidelines ?? {}) },
		promptGuidelines: [...(po.promptGuidelines ?? [])],
		sections: { ...(po.sections ?? {}) },
		contextFiles: (po.contextFiles ?? []).map((f) => ({
			path: f.path,
			chars: typeof f.content === "string" ? f.content.length : 0,
		})),
		skills: (po.skills ?? []).map((s) => ({
			name: s.name ?? "?",
			description: s.description ?? "",
			filePath: s.filePath ?? "",
			source: s.sourceInfo?.source ?? "",
		})),
	};
}

export interface BeginRequestInfo {
	model?: {
		provider?: string;
		id?: string;
		api?: string;
		contextWindow?: number;
	} | null;
	getAllTools: () => Array<{
		name: string;
		description?: string;
		exposure?: string;
		sourceInfo?: { source?: string; path?: string };
		namespace?: { name?: string };
		parameters?: unknown;
	}>;
	getActiveTools: () => string[];
}

function safeJsonLen(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

const README = `# what-model-sees capture data

This directory holds sanitized copies of every provider request sent by pi in
this project/session, one JSON file per request (\`request-<pid>-<NNNNNN>.json\`).

⚠️ Sensitivity: snapshots contain the full conversation, system prompt, and file
contents that were in context — including anything private you discussed.
Keep this directory local; add it to .gitignore if it lives inside a repo.

Files are pruned automatically: the directory keeps the newest ${DISK_KEEP} snapshot
files in total, counting every instance and session that wrote here. Delete the
directory any time; it is rebuilt on demand. Disable capture with /seen off.
`;

export class CaptureStore {
	snapshots: RequestSnapshot[] = [];
	enabled = true;
	persistDir: string | null = null;
	/**
	 * Snapshot from a previous extension instance of the same session, loaded from
	 * disk so the first request after /reload can still be diffed against the
	 * state before the reload.
	 */
	baseline: RequestSnapshot | undefined;

	/** Unique per extension instance (survives nothing): /reload re-instantiates the
	 * store and resets the counter, so without this the new files would overwrite
	 * the previous instance's files with the same pid and index. */
	private readonly instanceId = Date.now().toString(36);
	private nextIndex = 1;
	private turnIndex: number | null = null;
	private runIndex = 0;
	private writesSincePrune = 0;
	private sessionId: string | undefined;
	private contextStash: unknown[] | null = null;
	private promptOptionsStash: PromptOptionsInfo | null = null;
	private readmeWritten = false;
	/** Snapshots written to disk before their response info arrived. */
	private dirty = new Set<RequestSnapshot>();

	setTurn(turnIndex: number): void {
		this.turnIndex = turnIndex;
	}

	setSessionId(id: string | undefined): void {
		this.sessionId = id;
	}

	nextRun(): void {
		this.runIndex++;
	}

	stashContext(messages: unknown[]): void {
		if (!this.enabled) return;
		this.contextStash = sanitizeMessages(messages, makeImageStats());
	}

	stashPromptOptions(po: PromptOptionsInput | undefined | null): void {
		if (!this.enabled) return;
		this.promptOptionsStash = sanitizePromptOptions(po);
	}

	beginRequest(payload: unknown, info: BeginRequestInfo): RequestSnapshot {
		const payloadImageStats = makeImageStats();
		const sanitizedPayload = sanitizeValue(payload, payloadImageStats);
		const messages = this.contextStash ?? [];
		this.contextStash = null;

		const rawLen = (() => {
			try {
				return JSON.stringify(payload)?.length ?? 0;
			} catch {
				return -1;
			}
		})();

		// System prompt text from the leading system message.
		let systemPromptText = "";
		const first = messages[0] as Record<string, unknown> | undefined;
		if (first && first.role === "system") {
			const contentText = extractText(first.content);
			const sections = Object.values((first.sections as Record<string, unknown>) ?? {}).filter(
				(v): v is string => typeof v === "string" && v.length > 0,
			);
			systemPromptText = [contentText, ...sections].filter(Boolean).join("\n\n");
		}

		const active = new Set(info.getActiveTools());
		const tools: ToolMeta[] = info
			.getAllTools()
			.filter((t) => active.has(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				exposure: t.exposure ?? "",
				source: t.sourceInfo?.source ?? "unknown",
				sourcePath: t.sourceInfo?.path,
				namespace: t.namespace?.name,
				schemaChars: (t.description?.length ?? 0) + safeJsonLen(t.parameters),
			}));

		const stats: SnapshotStats = {
			payloadBytesRaw: rawLen,
			payloadBytes: safeJsonLen(sanitizedPayload),
			systemChars: systemPromptText.length,
			toolDeclChars: tools.reduce((sum, t) => sum + t.schemaChars, 0),
			byRole: roleStats(messages),
			imageCount: payloadImageStats.count,
			imageBytes: payloadImageStats.bytes,
			totalMessageChars: totalMessageChars(messages),
		};

		const index = this.nextIndex++;
		const snapshot: RequestSnapshot = {
			index,
			timestamp: Date.now(),
			turnIndex: this.turnIndex,
			runIndex: this.runIndex,
			viaAgentLoop: messages.length > 0,
			provider: info.model?.provider,
			api: info.model?.api,
			model: info.model?.id,
			contextWindow: info.model?.contextWindow,
			payload: sanitizedPayload,
			messages,
			systemPromptText,
			promptOptions: this.promptOptionsStash,
			tools,
			timing: { sentAt: Date.now() },
			stats,
			dir: this.persistDir ?? undefined,
			file: this.fileName(index),
			sessionId: this.sessionId,
		};
		this.snapshots.push(snapshot);
		if (this.snapshots.length > MEMORY_LIMIT) {
			this.snapshots.splice(0, this.snapshots.length - MEMORY_LIMIT);
		}
		this.dirty.add(snapshot);
		void this.persist(snapshot);
		return snapshot;
	}

	/** Re-write snapshots whose response info arrived after their first write. */
	flush(): void {
		if (this.dirty.size === 0) return;
		const pending = [...this.dirty];
		this.dirty.clear();
		for (const snapshot of pending) {
			void this.persist(snapshot);
		}
	}

	attachStatus(status: number): void {
		const last = this.snapshots[this.snapshots.length - 1];
		if (last && last.responseStatus === undefined) {
			last.responseStatus = status;
			this.dirty.add(last);
		}
	}

	/** Mark the first assistant stream event on the latest snapshot (TTFT anchor). */
	markFirstToken(): void {
		const last = this.snapshots[this.snapshots.length - 1];
		if (last?.timing && last.timing.firstTokenAt === undefined) {
			last.timing.firstTokenAt = Date.now();
			this.dirty.add(last);
		}
	}

	/** Mark assistant-message completion on the latest snapshot. */
	markCompleted(): void {
		const last = this.snapshots[this.snapshots.length - 1];
		if (last?.timing && last.timing.completedAt === undefined) {
			last.timing.completedAt = Date.now();
			this.dirty.add(last);
		}
	}

	attachMeta(provider: string, api: string, model: string): void {
		const last = this.snapshots[this.snapshots.length - 1];
		if (!last) return;
		last.provider ??= provider;
		last.api ??= api;
		last.model ??= model;
	}

	attachUsage(usage: UsageSummary, provider?: string, api?: string, model?: string): void {
		const last = this.snapshots[this.snapshots.length - 1];
		if (!last) return;
		if (provider) last.provider ??= provider;
		if (api) last.api ??= api;
		if (model) last.model ??= model;
		if (!last.usage) {
			last.usage = usage;
			this.dirty.add(last);
		}
	}

	latest(): RequestSnapshot | undefined {
		return this.snapshots[this.snapshots.length - 1];
	}

	byNumber(n: number): RequestSnapshot | undefined {
		return this.snapshots.find((s) => s.index === n);
	}

	/** Snapshot immediately before the given one (by capture order). */
	prevOf(snapshot: RequestSnapshot): RequestSnapshot | undefined {
		const i = this.snapshots.indexOf(snapshot);
		if (i > 0) return this.snapshots[i - 1];
		// First request of this instance: fall back to the pre-reload baseline.
		if (i === 0 && this.baseline && this.baseline !== snapshot) return this.baseline;
		return undefined;
	}

	/** True when the snapshot came from a previous instance (not captured here). */
	isBaseline(snapshot: RequestSnapshot | undefined): boolean {
		return snapshot !== undefined && !this.snapshots.includes(snapshot);
	}

	get lastIndex(): number {
		return this.nextIndex - 1;
	}

	// -- persistence ---------------------------------------------------------

	private fileName(index: number): string {
		return `request-${process.pid}-${this.instanceId}-${String(index).padStart(6, "0")}.json`;
	}

	private async persist(snapshot: RequestSnapshot): Promise<void> {
		const dir = this.persistDir;
		if (!dir) return;
		try {
			await mkdir(dir, { recursive: true });
			if (!this.readmeWritten) {
				try {
					await writeFile(join(dir, "README.md"), README, { flag: "wx" });
				} catch {
					/* already exists */
				}
				this.readmeWritten = true;
			}
			const name = this.fileName(snapshot.index);
			await writeFile(join(dir, name), JSON.stringify({ version: 1, snapshot }));
			if (++this.writesSincePrune >= PRUNE_EVERY) {
				this.writesSincePrune = 0;
				await this.prune(dir);
			}
		} catch {
			/* persistence is best-effort */
		}
	}

	/**
	 * Global retention: keep the newest DISK_KEEP snapshot files in the directory,
	 * regardless of which process, instance, or session wrote them. The old
	 * per-instance prefix meant every /reload started a fresh 50-file budget that was
	 * never collected again, so the directory grew without bound.
	 */
	private async prune(dir: string): Promise<void> {
		try {
			const files = (await readdir(dir)).filter(
				(f) => f.startsWith("request-") && f.endsWith(".json"),
			);
			if (files.length <= DISK_KEEP) return;
			const timed = await Promise.all(
				files.map(async (f) => {
					try {
						return { f, mtime: (await stat(join(dir, f))).mtimeMs };
					} catch {
						return { f, mtime: 0 };
					}
				}),
			);
			timed.sort((a, b) => a.mtime - b.mtime); // oldest first
			for (const { f } of timed.slice(0, timed.length - DISK_KEEP)) {
				await rm(join(dir, f), { force: true });
			}
		} catch {
			/* ignore */
		}
	}
}

/** Rebuild in-memory state markers (enabled flag) from session custom entries. */
export function readPersistedState(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
): { enabled: boolean } | null {
	let found: { enabled: boolean } | null = null;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "wms-state") {
			const data = entry.data as { enabled?: boolean } | undefined;
			if (data && typeof data.enabled === "boolean") found = { enabled: data.enabled };
		}
	}
	return found;
}

/** Helper: read a persisted snapshot back from disk (for tooling/tests). */
export async function loadSnapshotFile(path: string): Promise<RequestSnapshot | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as { version?: number; snapshot?: RequestSnapshot };
		return parsed.snapshot;
	} catch {
		return undefined;
	}
}

/**
 * Load the newest persisted snapshot belonging to `sessionId` so a reloaded
 * extension instance can diff its first request against the previous instance.
 * Returns undefined when nothing matches; never throws.
 */
export async function loadBaseline(
	dir: string | null,
	sessionId: string | undefined,
	attempts = 12,
): Promise<RequestSnapshot | undefined> {
	if (!dir || !sessionId) return undefined;
	try {
		const files = (await readdir(dir)).filter(
			(f) => f.startsWith("request-") && f.endsWith(".json"),
		);
		if (files.length === 0) return undefined;
		const timed = await Promise.all(
			files.map(async (f) => {
				try {
					return { f, mtime: (await stat(join(dir, f))).mtimeMs };
				} catch {
					return { f, mtime: 0 };
				}
			}),
		);
		timed.sort((a, b) => b.mtime - a.mtime);
		for (const { f } of timed.slice(0, attempts)) {
			const snapshot = await loadSnapshotFile(join(dir, f));
			if (snapshot && snapshot.sessionId === sessionId) return snapshot;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
