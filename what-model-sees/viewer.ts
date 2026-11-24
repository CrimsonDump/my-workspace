/**
 * what-model-sees — fullscreen TUI viewer.
 *
 * Opened via `/seen` (see index.ts). Progressive disclosure: overview first,
 * drill into system prompt / tools / messages / diff / sources. Message and
 * tool details show the provider-format JSON actually sent on the wire.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CaptureStore } from "./capture.ts";
import { diffSnapshots } from "./difftool.ts";
import {
	describeMessage,
	estimateTokens,
	formatBytes,
	formatChars,
	formatSeconds,
	formatTime,
	formatTokens,
	formatTps,
	timingSummary,
} from "./sanitize.ts";
import type { RequestSnapshot, ToolMeta } from "./types.ts";
import {
	findWireTool,
	getWireTools,
	hasWirePayload,
	pairWireMessages,
	type WirePairing,
} from "./wirematch.ts";

const TABS = ["总览", "System", "工具", "消息", "差异", "来源"] as const;

/** One-line summary of what a request payload carries (its trigger / last message). */
function requestTrigger(s: RequestSnapshot): string {
	const msgs = s.messages as unknown[];
	if (msgs.length === 0) return "";
	const last = msgs[msgs.length - 1] as { role?: string };
	if (last.role === "user") {
		return `问: ${describeMessage(last).preview}`;
	}
	if (last.role === "custom") {
		return `✦注入: ${describeMessage(last).preview}`;
	}
	if (last.role === "toolResult") {
		const names: string[] = [];
		for (let k = msgs.length - 1; k >= 0; k--) {
			const m = msgs[k] as { role?: string; toolName?: string };
			if (m.role !== "toolResult") break;
			const n = m.toolName ?? "?";
			if (!names.includes(n)) names.push(n);
		}
		return `⚙ ${names.join(",")}`;
	}
	return "";
}

/** Pretty-print a JSON value as viewer lines, truncated after capLines lines. */
function indentJson(value: unknown, capLines: number): string[] {
	let json: string;
	try {
		json = JSON.stringify(value, null, 2) ?? "undefined";
	} catch {
		json = "[unserializable]";
	}
	const lines = json.split("\n");
	if (lines.length > capLines) {
		return [
			...lines.slice(0, capLines).map((l) => ` ${l}`),
			` … 已截断（共 ${lines.length} 行）· 完整内容: /seen export`,
		];
	}
	return lines.map((l) => ` ${l}`);
}

/** One-line summary of the request envelope (top-level payload params). */
function describeEnvelope(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return "";
	const p = payload as Record<string, unknown>;
	const bits: string[] = [];
	if (typeof p.model === "string") bits.push(p.model);
	for (const key of ["max_tokens", "max_completion_tokens", "temperature"] as const) {
		if (p[key] !== undefined) bits.push(`${key}=${String(p[key])}`);
	}
	if (p.stream === true) bits.push("stream");
	if (p.system !== undefined) {
		const chars =
			typeof p.system === "string" ? p.system.length : (JSON.stringify(p.system)?.length ?? 0);
		bits.push(`system=顶层参数(${chars} chars)`);
	}
	return bits.length > 0 ? bits.join(" · ") : "";
}

export interface SeenViewerOptions {
	store: CaptureStore;
	/** Start position inside store.snapshots. */
	startPos: number;
	startTab?: number;
	theme: Theme;
	/** Terminal rows (function so resizes are picked up). */
	rows: () => number;
	/** True when drawn as a fullscreen overlay (no inline chrome to leave room for). */
	fullscreen?: boolean;
	onExport: (snapshot: RequestSnapshot) => void;
}

interface Category {
	label: string;
	tokens: number;
	chars: number;
	color: "accent" | "warning" | "muted" | "success";
}

export class SeenViewer {
	private pos: number;
	private tab: number;
	private scroll = 0;
	private cursor = 0;
	private detail: { key: string; lines: string[] } | null = null;
	private cache: { key: string; lines: string[]; rawStart: number[] } | null = null;
	/** Content line (raw, pre-wrap) of the cursor row; set while building list tabs. */
	private cursorRawLine: number | null = null;
	/** Set after cursor moves; render() scrolls the cursor row into view once. */
	private pendingFollow = false;
	/** Tools in display order (grouped); cursor indexes this. */
	private toolDisplayOrder: ToolMeta[] = [];
	/** Lazily computed wire pairing for the current snapshot. */
	private wirePairCache: { key: string; pairing: WirePairing } | null = null;
	/** 消息 tab 的两级状态：先按 payload（请求）浏览，Enter 进入某次请求的消息列表。 */
	private msgMode: "payloads" | "messages" = "payloads";
	/** Vim-style search (`/`): typing buffer, active query, and jump requests. */
	private searchInput: string | null = null;
	private search: { query: string; matchLines: number[]; current: number } | null = null;
	private lastQuery = "";
	private pendingJump: "first" | "next" | "prev" | null = null;
	private lastViewportH = 24;

	constructor(
		private opts: SeenViewerOptions,
		private done: (result: undefined) => void,
	) {
		this.pos = Math.min(Math.max(opts.startPos, 0), Math.max(opts.store.snapshots.length - 1, 0));
		this.tab = opts.startTab ?? 0;
	}

	// ------------------------------------------------------------------ render

	render(width: number): string[] {
		const chrome = this.opts.fullscreen ? 1 : 2;
		const rows = Math.max(this.opts.rows() - chrome, 12);
		const header = this.renderHeader(width);
		const tabBar = this.renderTabBar(width);
		const viewportH = Math.max(rows - header.length - tabBar.length - 1, 3);
		const content = this.getContent(width);
		const maxScroll = Math.max(0, content.length - viewportH);
		this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);
		this.lastViewportH = viewportH;
		this.resolveSearch(content, viewportH);
		this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);
		if (this.pendingFollow) {
			this.pendingFollow = false;
			this.ensureCursorVisible(viewportH);
			this.scroll = Math.min(Math.max(this.scroll, 0), maxScroll);
		}
		const out = [...header, ...tabBar];
		const matchMarker = this.opts.theme.fg("accent", "▸ ");
		for (let i = 0; i < viewportH; i++) {
			const idx = this.scroll + i;
			let line = content[idx] ?? "";
			if (this.search) {
				line = highlightSearchMatches(line, this.search.query);
				if (
					this.search.current >= 0 &&
					this.search.matchLines[this.search.current] === idx
				) {
					line = truncateToWidth(matchMarker + line, width);
				}
			}
			out.push(line);
		}
		out.push(...this.renderFooter(width, content.length, viewportH));
		return out;
	}

	invalidate(): void {
		/* render() recomputes from cache keys */
	}

	private get snap(): RequestSnapshot {
		return this.opts.store.snapshots[this.pos];
	}

	private get wirePairing(): WirePairing {
		const key = `${this.pos}:${this.snap.index}`;
		if (!this.wirePairCache || this.wirePairCache.key !== key) {
			this.wirePairCache = { key, pairing: pairWireMessages(this.snap) };
		}
		return this.wirePairCache.pairing;
	}

	private renderHeader(width: number): string[] {
		const t = this.opts.theme;
		const s = this.snap;
		const total = this.opts.store.snapshots.length;
		const countLabel =
			total > 1 ? `请求 #${s.index}（${this.pos + 1}/${total}）` : `请求 #${s.index}`;
		const line1 =
			t.fg("accent", t.bold(" what-model-sees ")) +
			t.fg("muted", "·") +
			` ${t.bold(countLabel)} · ` +
			`${s.provider ?? "?"}/${s.model ?? "?"}` +
			t.fg("dim", ` · ${formatTime(s.timestamp)}`);
		const bits: string[] = [];
		bits.push(
			`run ${s.runIndex ?? "?"} · turn ${s.turnIndex == null ? "?" : s.turnIndex + 1}`,
		);
		if (s.responseStatus !== undefined && s.responseStatus >= 300) {
			bits.push(t.fg("error", `HTTP ${s.responseStatus}`));
		}
		if (s.usage) {
			const inTok = (s.usage.input ?? 0) + (s.usage.cacheRead ?? 0) + (s.usage.cacheWrite ?? 0);
			bits.push(
				`in ${formatTokens(inTok)}${s.usage.cacheRead ? t.fg("dim", ` (缓存R ${formatTokens(s.usage.cacheRead)})`) : ""}${s.usage.cacheWrite ? t.fg("dim", ` (缓存W ${formatTokens(s.usage.cacheWrite)})`) : ""} · out ${formatTokens(s.usage.output ?? 0)}`,
			);
			if (s.usage.costTotal !== undefined && s.usage.costTotal > 0) {
				bits.push(`$${s.usage.costTotal.toFixed(4)}`);
			}
		}
		if (!s.viaAgentLoop) bits.push(t.fg("warning", "非主循环请求"));
		const line2 = " " + bits.join(t.fg("dim", " · "));
		return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
	}

	private renderTabBar(width: number): string[] {
		const t = this.opts.theme;
		const parts = TABS.map((label, i) => {
			const text = `${i + 1} ${label}`;
			return this.tab === i && !this.detail ? t.fg("accent", t.bold(text)) : t.fg("dim", text);
		});
		return [" " + parts.join(t.fg("dim", "  "))];
	}

	private renderFooter(width: number, contentLines: number, viewportH: number): string[] {
		const t = this.opts.theme;
		let hints: string;
		if (this.searchInput !== null) {
			hints = `/ ${this.searchInput}▏ · Enter 执行 · Esc 取消`;
		} else if (this.search) {
			hints =
				this.search.current >= 0
					? `/${this.search.query} · 匹配 ${this.search.current + 1}/${this.search.matchLines.length} · n/N 下一个/上一个`
					: `/${this.search.query} · 无匹配 · / 重新输入`;
		} else {
			hints = this.detail
				? "j/k 滚动 · Ctrl+d/u 半页 · / 搜索 n/N · , . 换请求 · Esc/q 返回"
				: "h/l 切标签 · j/k 滚动/光标 · Enter 详情 · / 搜索 · , . 换请求 · e 导出 · q 退出";
		}
		const range =
			contentLines === 0
				? ""
				: `${Math.min(this.scroll + viewportH, contentLines)}/${contentLines}行`;
		const left = t.fg("dim", ` ${hints}`);
		const right = t.fg("dim", `${range} `);
		const pad = Math.max(width - visibleWidth(left) - visibleWidth(right), 1);
		return [truncateToWidth(left + " ".repeat(pad) + right, width)];
	}

	private getContent(width: number): string[] {
		const key = `${this.pos}:${this.tab}:${this.msgMode}:${this.cursor}:${this.detail?.key ?? "-"}:${width}`;
		if (this.cache && this.cache.key === key) return this.cache.lines;
		const raw = this.buildLines(width);
		const lines: string[] = [];
		const rawStart: number[] = [];
		for (const line of raw) {
			rawStart.push(lines.length);
			lines.push(...wrapTextWithAnsi(line, width));
		}
		rawStart.push(lines.length);
		this.cache = { key, lines, rawStart };
		return lines;
	}

	private buildLines(width: number): string[] {
		if (this.detail) return this.detail.lines;
		const s = this.snap;
		const L: string[] = [];
		this.cursorRawLine = null;
		switch (this.tab) {
			case 0:
				L.push(...this.buildOverview(s, this.opts.store.prevOf(s)));
				return L;
			case 1:
				L.push(...this.buildSystem(s));
				return L;
			case 2:
				L.push(...this.buildTools(s, width));
				return L;
			case 3:
				if (this.msgMode === "payloads") L.push(...this.buildRequests(width));
				else L.push(...this.buildMessages(s, this.opts.store.prevOf(s)));
				return L;
			case 4:
				L.push(...this.buildDiff(s, this.opts.store.prevOf(s)));
				return L;
			case 5:
				L.push(...this.buildSources(s));
				return L;
			default:
				return L;
		}
	}

	// ------------------------------------------------------------- tab builders

	/** Categories with token estimates, calibrated to actual usage when available. */
	private categories(s: RequestSnapshot): { cats: Category[]; usedTokens: number; estimated: boolean } {
		const st = s.stats;
		const convRoles = [
			"user",
			"assistant",
			"custom",
			"bashExecution",
			"compactionSummary",
			"branchSummary",
		];
		const convChars = convRoles.reduce((sum, r) => sum + (st.byRole[r]?.chars ?? 0), 0);
		const cats: Category[] = [
			{ label: "系统提示", chars: st.systemChars, tokens: 0, color: "accent" },
			{ label: "工具声明", chars: st.toolDeclChars, tokens: 0, color: "warning" },
			{ label: "对话", chars: convChars, tokens: 0, color: "muted" },
			{ label: "工具结果", chars: st.byRole.toolResult?.chars ?? 0, tokens: 0, color: "success" },
		];
		for (const cat of cats) cat.tokens = estimateTokens(cat.chars);
		const estTotal = cats.reduce((sum, c) => sum + c.tokens, 0) || 1;
		if (s.usage) {
			const used = (s.usage.input ?? 0) + (s.usage.cacheRead ?? 0) + (s.usage.cacheWrite ?? 0);
			const scale = used / estTotal;
			for (const cat of cats) cat.tokens = Math.round(cat.tokens * scale);
			return { cats, usedTokens: used, estimated: false };
		}
		return { cats, usedTokens: estTotal, estimated: true };
	}

	/** Tab 0: every captured request payload, grouped by agent run. */
	private buildRequests(width: number): string[] {
		const t = this.opts.theme;
		const snaps = this.opts.store.snapshots;
		const L: string[] = [];
		L.push(
			` ${t.bold("消息 · payload 列表")} ${snaps.length} 个 · 每个 = 一次发给 provider 的请求（一轮生成）`,
		);
		L.push("");
		let prevRun: number | null = null;
		snaps.forEach((s, i) => {
			const run = s.runIndex;
			if (run !== prevRun) {
				prevRun = run;
				L.push("");
				L.push(` ${t.fg("dim", `── run ${run ?? "?"} ──`)}`);
			}
			const cursorMark = this.cursor === i ? t.fg("accent", "▸ ") : "  ";
			if (this.cursor === i) this.cursorRawLine = L.length;
			const id =
				i === this.pos
					? t.fg("accent", t.bold(`#${String(s.index).padStart(3)}`))
					: t.fg("dim", `#${String(s.index).padStart(3)}`);
			const rt = `r${s.runIndex ?? "?"}t${s.turnIndex ?? "?"}`;
			const prev = i > 0 ? snaps[i - 1] : undefined;
			const d = prev ? s.messages.length - prev.messages.length : 0;
			const delta = prev ? (d >= 0 ? `+${d}` : t.fg("warning", "重写")) : "";
			const perf: string[] = [];
			if (s.timing?.totalMs !== undefined) perf.push(formatSeconds(s.timing.totalMs));
			if (s.usage?.output !== undefined) perf.push(`${formatTokens(s.usage.output)}tok`);
			const perfS = perf.length > 0 ? t.fg("dim", perf.join("·")) : "";
			const st =
				s.responseStatus === undefined
					? t.fg("dim", "…")
					: s.responseStatus !== 200
						? t.fg("error", `⚠${s.responseStatus}`)
						: "";
			const trig = requestTrigger(s);
			L.push(
				truncateToWidth(
					` ${cursorMark}${id} ${t.fg("muted", rt.padEnd(8))} ${t.fg("muted", `消息${String(s.messages.length).padStart(4)}`)} ${t.fg("muted", String(delta).padEnd(4))} ${t.fg("dim", trig)} ${perfS} ${st}`,
					width,
				),
			);
		});
		return L;
	}

	private buildOverview(s: RequestSnapshot, prev: RequestSnapshot | undefined): string[] {
		const t = this.opts.theme;
		const L: string[] = [];
		const { cats, usedTokens, estimated } = this.categories(s);
		const windowTok = s.contextWindow ?? null;
		const est = estimated ? "~" : "";

		// -- context window headline + bar (free space included)
		if (windowTok) {
			const pct = (usedTokens / windowTok) * 100;
			const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "accent";
			L.push(
				` 上下文窗口  ${t.bold(`${est}${formatTokens(usedTokens)} / ${formatTokens(windowTok)} tok`)} · ${t.fg(pctColor, t.bold(`${pct.toFixed(pct < 10 ? 1 : 0)}%`))}`,
			);
			const barW = 56;
			let bar = "";
			let usedBlocks = 0;
			for (const cat of cats) {
				const blocks = Math.max(cat.tokens > 0 ? 1 : 0, Math.round((cat.tokens / windowTok) * barW));
				usedBlocks += blocks;
				bar += t.fg(cat.color, "█".repeat(blocks));
			}
			const freeBlocks = Math.max(0, barW - usedBlocks);
			bar += t.fg("dim", "─".repeat(freeBlocks));
			L.push(` ${bar}`);
		} else {
			L.push(` 上下文 ${est}${formatTokens(usedTokens)} tok（模型窗口大小未知）`);
			const total = cats.reduce((sum, c) => sum + c.tokens, 0) || 1;
			const barW = 56;
			let bar = "";
			for (const cat of cats) {
				const blocks = Math.max(cat.tokens > 0 ? 1 : 0, Math.round((cat.tokens / total) * barW));
				bar += t.fg(cat.color, "█".repeat(blocks));
			}
			L.push(` ${bar}`);
		}
		L.push("");

		// -- legend: aligned table, % of used
		const usedDenom = usedTokens || 1;
		const labelW = 10;
		const cf = s.promptOptions?.contextFiles ?? [];
		cats.forEach((cat, ci) => {
			const pctUsed = ((cat.tokens / usedDenom) * 100).toFixed(0);
			L.push(
				`   ${t.fg(cat.color, "██")} ${padVisible(t.fg(cat.color, cat.label), labelW)}${`${est}${formatTokens(cat.tokens)} tok`.padStart(10)}   ${pctUsed.padStart(3)}%`,
			);
			// Context files belong to the system prompt: nest them right below it.
			if (ci === 0 && cf.length > 0) {
				const scale = cats[0].tokens / Math.max(1, cats[0].chars / 4);
				cf.forEach((f, i) => {
					const tree = i === cf.length - 1 ? "└" : "├";
					const tok = Math.round(estimateTokens(f.chars) * scale);
					L.push(
						`       ${t.fg("dim", tree)} ${t.fg("muted", truncateToWidth(f.path, 34))}${`${est}${formatTokens(tok)} tok`.padStart(Math.max(10, 46 - Math.min(34, f.path.length)))}`,
					);
				});
			}
		});
		if (windowTok) {
			const free = Math.max(0, windowTok - usedTokens);
			L.push(
				`   ${t.fg("dim", "──")} ${t.fg("dim", padVisible("剩余空间", labelW))}${`${formatTokens(free)} tok`.padStart(10)}   ${((free / windowTok) * 100).toFixed(0).padStart(3)}%`,
			);
		}
		L.push("");

		// -- response timing: TPS · TTFT · E2E / output tokens
		const timing = timingSummary(s);
		if (timing) {
			const bits: string[] = [];
			if (timing.tps !== undefined) {
				bits.push(`${t.bold("TPS")} ${t.fg("success", `${formatTps(timing.tps)} tok/s`)}`);
			}
			if (timing.ttftMs !== undefined) {
				bits.push(`${t.bold("TTFT")} ${formatSeconds(timing.ttftMs)}`);
			}
			if (timing.totalMs !== undefined) {
				const outTok =
					timing.outputTokens !== undefined
						? `${t.fg("dim", " / ")}${formatTokens(timing.outputTokens)} tok`
						: "";
				bits.push(`${t.bold("E2E")} ${formatSeconds(timing.totalMs)}${outTok}`);
			} else if (timing.outputTokens !== undefined) {
				bits.push(`${formatTokens(timing.outputTokens)} tok`);
			}
			if (bits.length > 0) {
				L.push(` ${bits.join(t.fg("dim", " · "))}`);
				L.push("");
			}
		}

		// -- what changed since the previous request (the actionable part)
		const diff = diffSnapshots(prev, s);
		if (s.stats.imageCount > 0) {
			L.push(
				` ${t.bold("含图片")} ${s.stats.imageCount} 张（${formatBytes(s.stats.imageBytes)}，按像素算 token，不按字符）`,
			);
		}
		if (diff.hasPrev && prev) {
			const added = diff.messagesAppended;
			const toolResults = added.filter((m) => m.role === "toolResult");
			const newUsers = added.filter((m) => m.role === "user").length;
			const customs = added.filter((m) => m.role === "custom").length;
			const bits: string[] = [];
			if (toolResults.length > 0) {
				const names = [...new Set(toolResults.map((m) => m.label.replace(/^toolResult\(|\)$/g, "")))];
				bits.push(`${toolResults.length} 轮工具往返（${names.slice(0, 3).join(", ")}${names.length > 3 ? " 等" : ""}）`);
			}
			if (newUsers > 0) bits.push(`新提问 ${newUsers}`);
			if (customs > 0) bits.push(`hook 注入 ${customs}`);
			if (diff.messagesReplaced > 0) bits.push(`替换 ${diff.messagesReplaced}`);
			if (diff.messagesRemoved > 0) bits.push(`移除 ${diff.messagesRemoved}`);
			if (bits.length === 0) bits.push(t.fg("warning", "内容与上次相同（重试）"));

			// Context growth: real tokens when both requests reported usage.
			const prevUsed = prev.usage
				? (prev.usage.input ?? 0) + (prev.usage.cacheRead ?? 0) + (prev.usage.cacheWrite ?? 0)
				: null;
			let deltaNote: string;
			if (!estimated && prevUsed !== null) {
				const delta = usedTokens - prevUsed;
				deltaNote = `上下文 ${delta >= 0 ? "+" : "−"}${formatTokens(Math.abs(delta))} tok（${formatTokens(prevUsed)} → ${formatTokens(usedTokens)}）`;
			} else {
				const d = diff.payloadCharDelta;
				deltaNote = `体积 ${d >= 0 ? "+" : "−"}${formatChars(Math.abs(d))} chars`;
			}
			L.push(
				` ${t.bold(`较上次 #${prev.index}${this.opts.store.isBaseline(prev) ? "（reload 前）" : ""}`)}：${bits.join(" · ")} · ${t.fg("muted", deltaNote)}`,
			);

			// Cache-relevant changes: prompt/tool changes invalidate the cached prefix.
			const sysNote = diff.systemChanged
				? t.fg("warning", `已变（${diff.systemDiff.added}+/${diff.systemDiff.removed}− 行）`)
				: t.fg("success", "未变");
			const toolNote =
				diff.toolsAdded.length + diff.toolsRemoved.length > 0
					? t.fg("warning", `${diff.toolsAdded.length} 增 / ${diff.toolsRemoved.length} 减`)
					: t.fg("success", "未变");
			L.push(` ${t.fg("dim", "缓存前缀")}  系统提示 ${sysNote} · 工具声明 ${toolNote}`);
		}
		return L;
	}

	private buildSystem(s: RequestSnapshot): string[] {
		if (!s.systemPromptText) {
			return [this.opts.theme.fg("dim", "（无 system prompt）")];
		}
		return s.systemPromptText.split("\n");
	}

	private buildTools(s: RequestSnapshot, width: number): string[] {
		const t = this.opts.theme;
		const L: string[] = [];
		L.push(
			` ${t.bold("工具声明")} ${s.tools.length} 个 · ≈${formatChars(s.stats.toolDeclChars)} chars`,
		);
		L.push("");
		const groups = groupTools(s.tools);
		this.toolDisplayOrder = [];
		const maxName = Math.min(28, Math.max(8, ...s.tools.map((tool) => tool.name.length)) + 2);
		for (const g of groups) {
			L.push(` ${t.fg("dim", `── ${g.label} (${g.tools.length}) ──`)}`);
			for (const tool of g.tools) {
				const idx = this.toolDisplayOrder.length;
				this.toolDisplayOrder.push(tool);
				const cursorMark = this.cursor === idx ? t.fg("accent", "▸ ") : "  ";
				if (this.cursor === idx) this.cursorRawLine = L.length;
				const desc = truncateToWidth(
					tool.description.split("\n")[0] ?? "",
					Math.max(width - maxName - 30, 10),
				);
				L.push(
					` ${cursorMark}${t.bold(tool.name.padEnd(maxName))} ${t.fg("muted", formatChars(tool.schemaChars))}  ${t.fg("dim", desc)}`,
				);
			}
			L.push("");
		}
		return L;
	}

	private buildMessages(s: RequestSnapshot, prev: RequestSnapshot | undefined): string[] {
		const t = this.opts.theme;
		const L: string[] = [];
		const wire = Array.isArray((s.payload as { messages?: unknown })?.messages)
			? ((s.payload as { messages: unknown[] }).messages)
			: [];
		const pair = this.wirePairing;
		const wireTools = getWireTools(s.payload);
		L.push(
			` ${t.bold("消息")} ${s.messages.length} 条（从旧到新） · wire ${wire.length} 条${pair.wireOnly.length > 0 ? ` · ${t.fg("warning", `${pair.wireOnly.length} 条仅存在于 wire`)}` : ""}`,
		);
		// 请求信封：顶层参数只在完整 payload 里，摘要一行放在这里。
		const envelope = describeEnvelope(s.payload);
		if (envelope) L.push(` ${t.fg("dim", envelope)}`);
		L.push("");
		const diff = diffSnapshots(prev, s);
		const isNew = (i: number) => diff.hasPrev && i >= diff.messagesCommon;
		const maxLabel = Math.min(
			32,
			Math.max(12, ...s.messages.map((m) => describeMessage(m).label.length)) + 2,
		);
		// 伪条目 #T：发给 provider 的整份请求 JSON（即原 Payload 标签的内容）。
		// 光标 0 永远是它（存在时），消息从光标 1 起编号。
		if (hasWirePayload(s.payload)) {
			const cursorMark = this.cursor === 0 ? t.fg("accent", "▸ ") : "  ";
			if (this.cursor === 0) this.cursorRawLine = L.length;
			const label = padVisible(t.fg("warning", "完整 wire 请求"), maxLabel);
			const toolCount = wireTools ? wireTools.length : 0;
			L.push(
				` ${cursorMark}${t.fg("dim", "#T")} ${label} ${t.fg("muted", formatChars(s.stats.payloadBytes).padEnd(6))}   ${t.fg("dim", `信封 + messages ${wire.length} 条 + tools ${toolCount} 个 · Enter 看整份 JSON 文档（即原 Payload）`)}`,
			);
		}
		const off = hasWirePayload(s.payload) ? 1 : 0;
		s.messages.forEach((m, i) => {
			const d = describeMessage(m);
			const cursorMark = this.cursor === i + off ? t.fg("accent", "▸ ") : "  ";
			if (this.cursor === i + off) this.cursorRawLine = L.length;
			const newMark = isNew(i) ? t.fg("accent", "新 ") : "  ";
			const label = padVisible(roleStyledLabel(t, d.role, d.label), maxLabel);
			const errMark = d.preview.startsWith("✗") ? t.fg("error", "✗ ") : "";
			const preview = d.preview.startsWith("✗") ? d.preview.slice(2) : d.preview;
			L.push(
				` ${cursorMark}${t.fg("dim", `#${i + 1}`)} ${label} ${t.fg("muted", formatChars(d.chars).padEnd(6))} ${newMark}${errMark}${t.fg("dim", truncateToWidth(preview, 100))}`,
			);
		});
		return L;
	}

	private buildDiff(s: RequestSnapshot, prev: RequestSnapshot | undefined): string[] {
		const t = this.opts.theme;
		const L: string[] = [];
		if (!prev) {
			L.push(` ${t.fg("dim", "没有更早的快照可比较（这是本进程第一次捕获的请求）")}`);
			return L;
		}
		const diff = diffSnapshots(prev, s);
		L.push(
			` ${t.bold(`请求 #${s.index} 与 #${prev.index}${this.opts.store.isBaseline(prev) ? "（reload 前）" : ""} 的差异`)}`,
		);
		L.push("");
		L.push(
			` ${t.bold("System prompt")} ${
				diff.systemChanged
					? t.fg("warning", `已变化 (${diff.systemDiff.added}+ / ${diff.systemDiff.removed}- 行)`)
					: t.fg("success", "未变化")
			}`,
		);
		if (diff.systemChanged) {
			for (const entry of diff.systemDiff.entries) {
				if (entry.type === "+") {
					L.push(`   ${t.fg("success", `+ ${entry.text}`)}`);
				} else if (entry.type === "-") {
					L.push(`   ${t.fg("error", `- ${entry.text}`)}`);
				} else {
					L.push(`   ${t.fg("dim", `  ${entry.text}`)}`);
				}
			}
			if (diff.systemDiff.truncated) {
				L.push(`   ${t.fg("dim", " … (diff 已截断，导出 HTML 查看全部)")}`);
			}
		}
		L.push("");
		L.push(` ${t.bold("工具")}`);
		if (diff.toolsAdded.length > 0) {
			L.push(`   ${t.fg("success", `+ ${diff.toolsAdded.join(", ")}`)}`);
		}
		if (diff.toolsRemoved.length > 0) {
			L.push(`   ${t.fg("error", `- ${diff.toolsRemoved.join(", ")}`)}`);
		}
		if (diff.toolsAdded.length === 0 && diff.toolsRemoved.length === 0) {
			L.push(`   ${t.fg("dim", "未变化")}`);
		}
		L.push("");
		L.push(
			` ${t.bold("消息")} 公共前缀 ${diff.messagesCommon} · ${t.fg("success", `新增 ${diff.messagesAppended.length}`)}${
				diff.messagesReplaced > 0 ? ` · ${t.fg("warning", `替换 ${diff.messagesReplaced}`)}` : ""
			}${diff.messagesRemoved > 0 ? ` · ${t.fg("error", `移除 ${diff.messagesRemoved}`)}` : ""}`,
		);
		for (const m of diff.messagesAppended.slice(0, 50)) {
			L.push(
				`   ${t.fg("success", `+ ${m.label} ${formatChars(m.chars)}  ${truncateToWidth(m.preview, 80)}`)}`,
			);
		}
		if (diff.messagesAppended.length > 50) {
			L.push(`   ${t.fg("dim", ` … 还有 ${diff.messagesAppended.length - 50} 条`)}`);
		}
		L.push("");
		const deltas = Object.entries(diff.roleCharDelta);
		if (deltas.length > 0) {
			L.push(
				` ${t.bold("按角色字符变化")} ` +
					deltas
						.map(([role, d]) =>
							d >= 0
								? `${roleLabel(role)} ${t.fg("success", `+${formatChars(d)}`)}`
								: `${roleLabel(role)} ${t.fg("error", `-${formatChars(-d)}`)}`,
						)
						.join(t.fg("dim", " · ")),
			);
		}
		L.push(
			` ${t.bold("Payload")} ${
				diff.payloadCharDelta >= 0
					? t.fg("success", `+${formatChars(diff.payloadCharDelta)}`)
					: t.fg("error", `-${formatChars(-diff.payloadCharDelta)}`)
			} chars (${formatChars(prev.stats.payloadBytesRaw)} → ${formatChars(s.stats.payloadBytesRaw)})`,
		);
		return L;
	}

	private buildSources(s: RequestSnapshot): string[] {
		const t = this.opts.theme;
		const L: string[] = [];
		const po = s.promptOptions;
		if (po) {
			L.push(` ${t.bold("工作目录")} ${po.cwd}`);
			L.push("");
			L.push(` ${t.bold("上下文文件")}（各级 AGENTS.md / SYSTEM.md，内容进入系统提示）:`);
			if (po.contextFiles.length === 0) L.push(`   ${t.fg("dim", "（无")}`);
			for (const f of po.contextFiles) {
				L.push(`   ${t.fg("muted", f.path)} ${t.fg("dim", `${formatChars(f.chars)} chars`)}`);
			}
			L.push("");
			if (po.skills.length > 0) {
				L.push(` ${t.bold("技能")} ${po.skills.length} 个:`);
				for (const skill of po.skills) {
					L.push(
						`   ${t.bold(skill.name)} ${t.fg("dim", "—")} ${t.fg("muted", truncateToWidth(skill.description, 70))}`,
					);
					L.push(`     ${t.fg("dim", skill.filePath)}`);
				}
				L.push("");
			}
			if (po.hiddenTools.length > 0) {
				L.push(` ${t.fg("warning", "隐藏工具（active 但声明不发给模型）")} ${po.hiddenTools.join(", ")}`);
				L.push("");
			}
			if (Object.keys(po.sections).length > 0) {
				L.push(` ${t.bold("系统提示 sections")} ${Object.keys(po.sections).join(", ")}`);
			}
			if (po.promptGuidelines.length > 0) {
				L.push(` ${t.bold("promptGuidelines")} ${po.promptGuidelines.length} 条`);
			}
		} else {
			L.push(` ${t.fg("dim", "（无 before_agent_start 捕获 — 可能是非主循环的模型调用）")}`);
		}
		L.push("");
		L.push(` ${t.bold("工具来源")}:`);
		for (const g of groupTools(s.tools)) {
			const names = g.tools.map((tool) => tool.name).join(", ");
			L.push(
				`   ${t.fg("muted", g.label)} (${g.tools.length}): ${t.fg("dim", truncateToWidth(names, 90))}`,
			);
			if (g.sourcePath) L.push(`     ${t.fg("dim", g.sourcePath)}`);
		}
		if (s.dir) {
			L.push("");
			L.push(
				` ${t.bold("快照文件")} ${t.fg("dim", `${s.dir}/${s.file ?? `request-${process.pid}-?.json`}`)}`,
			);
		}
		return L;
	}

	// -------------------------------------------------------------- detail view

	/** Detail of the full wire request document (#T / 请求 tab Enter). */
	private openWireDetail(): void {
		const t = this.opts.theme;
		const s = this.snap;
		if (!hasWirePayload(s.payload)) return;
		const L: string[] = [];
		L.push(` ${t.bold("完整 wire 请求")} · ${s.api ?? "?"} · ${formatChars(s.stats.payloadBytes)} chars`);
		L.push("");
		L.push(
			` ${t.fg("dim", "发给 provider 的整份 JSON 文档（脱敏后）。system prompt = messages[0].content，tools 与 messages 平级。逐条浏览请回列表选具体消息。")}`,
		);
		L.push(` ${t.fg("dim", "── wire JSON ──")}`);
		L.push(...indentJson(s.payload, 8000));
		this.detail = { key: `wire:${this.pos}`, lines: L };
		this.scroll = 0;
	}

	private openDetail(): void {
		const t = this.opts.theme;
		const s = this.snap;
		this.clearSearch();
		if (this.tab === 3 && this.msgMode === "payloads") {
			// payload 列表：Enter 选中该次请求，进入它的消息列表。
			if (this.cursor >= this.opts.store.snapshots.length) return;
			this.pos = this.cursor;
			this.msgMode = "messages";
			this.cursor = 0;
			this.scroll = 0;
			this.clearSearch();
			return;
		} else if (this.tab === 3 && this.cursor === 0 && hasWirePayload(s.payload)) {
			this.openWireDetail();
		} else if (this.tab === 3) {
			const off = hasWirePayload(s.payload) ? 1 : 0;
			const mi = this.cursor - off;
			if (mi < 0 || mi >= s.messages.length) return;
			const m = s.messages[mi];
			const d = describeMessage(m);
			const pair = this.wirePairing;
			const wireMsg = pair.matched[mi];
			const note = pair.notes[mi];
			const L: string[] = [];
			L.push(
				` ${t.bold(`消息 #${mi + 1}`)} ${roleStyledLabel(t, d.role, d.label)} · ${formatChars(d.chars)} chars · ${s.api ?? "?"}`,
			);
			L.push("");
			if (wireMsg !== undefined) {
				L.push(` ${t.fg("dim", "── wire JSON（实际发给 provider 的样子，脱敏后）──")}`);
				L.push(...indentJson(wireMsg, 2000));
			} else {
				if (note) L.push(` ${t.fg("warning", note)}`);
				L.push(` ${t.fg("dim", "── 无 wire 对应，以下为 pi 语义格式 JSON（脱敏后）──")}`);
				L.push(...indentJson(m, 2000));
			}
			this.detail = { key: `msg:${this.pos}:${mi}`, lines: L };
			this.scroll = 0;
		} else if (this.tab === 2 && this.cursor < this.toolDisplayOrder.length) {
			const tool = this.toolDisplayOrder[this.cursor];
			const L: string[] = [];
			L.push(` ${t.bold(tool.name)} ${t.fg("dim", `· ${tool.source}${tool.sourcePath ? ` · ${tool.sourcePath}` : ""}`)}`);
			if (tool.namespace) L.push(` ${t.fg("dim", `namespace: ${tool.namespace}`)}`);
			if (tool.exposure) L.push(` ${t.fg("dim", `exposure: ${tool.exposure}`)}`);
			L.push("");
			L.push(` ${t.fg("dim", "── description ──")}`);
			for (const line of tool.description.split("\n")) L.push(` ${line}`);
			L.push("");
			const wireTool = findWireTool(s.payload, tool.name);
			if (wireTool !== undefined) {
				L.push(
					` ${t.fg("dim", `── wire 工具声明（provider 格式，估算 ${formatChars(tool.schemaChars)} chars）──`)}`,
				);
				L.push(...indentJson(wireTool, 2000));
			} else {
				L.push(` ${t.fg("warning", "此工具不在本次 wire 声明中（未激活或 deferred 未发现）")}`);
			}
			this.detail = { key: `tool:${this.pos}:${this.cursor}`, lines: L };
			this.scroll = 0;
		}
	}
	// ------------------------------------------------------------------- input

	handleInput(data: string): void {
		if (this.searchInput !== null) {
			this.handleSearchInput(data);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			if (this.detail) {
				this.detail = null;
				this.scroll = 0;
				this.clearSearch();
				this.pendingFollow = true; // jump back to the cursor row we left
			} else if (this.tab === 3 && this.msgMode === "messages") {
				this.msgMode = "payloads";
				this.cursor = this.pos;
				this.scroll = 0;
				this.clearSearch();
				this.pendingFollow = true;
			} else {
				this.done(undefined);
			}
			return;
		}
		if (matchesKey(data, "/")) {
			this.searchInput = this.lastQuery;
			return;
		}
		if (this.search) {
			if (matchesKey(data, "n")) {
				this.pendingJump = "next";
				return;
			}
			if (matchesKey(data, "N") || matchesKey(data, "shift+n")) {
				this.pendingJump = "prev";
				return;
			}
		}
		if (this.detail) {
			// Request switching works here too: it closes the detail and moves to
			// the same tab of the neighbouring snapshot.
			if (this.trySwitchSnapshot(data)) return;
			if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down") || data === "j") this.scroll++;
			else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 20);
			else if (matchesKey(data, "pageDown")) this.scroll += 20;
			else if (matchesKey(data, "ctrl+d")) this.scroll += this.halfPage();
			else if (matchesKey(data, "ctrl+u")) this.scroll = Math.max(0, this.scroll - this.halfPage());
			else if (matchesKey(data, "home") || data === "g") this.scroll = 0;
			else if (matchesKey(data, "end") || data === "G" || matchesKey(data, "shift+g"))
				this.scroll = Number.MAX_SAFE_INTEGER;
			return;
		}
		// tabs: digits, Tab, arrows, and vim h/l
		for (let i = 0; i < TABS.length; i++) {
			if (matchesKey(data, String(i + 1))) {
				this.switchTab(i);
				return;
			}
		}
		if (matchesKey(data, "tab")) {
			this.switchTab((this.tab + 1) % TABS.length);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.switchTab((this.tab + TABS.length - 1) % TABS.length);
			return;
		}
		if (matchesKey(data, "right") || data === "l") {
			this.switchTab((this.tab + 1) % TABS.length);
			return;
		}
		if (matchesKey(data, "left") || data === "h") {
			this.switchTab((this.tab + TABS.length - 1) % TABS.length);
			return;
		}
		// snapshot navigation: comma/period (punctuation must be matched literally)
		// plus [ ] as a discoverable alias.
		if (this.trySwitchSnapshot(data)) return;
		if (matchesKey(data, "e")) {
			this.opts.onExport(this.snap);
			return;
		}
		// scroll / cursor
		const isListTab = this.tab === 2 || this.tab === 3;
		if (matchesKey(data, "up") || data === "k") {
			if (isListTab) this.moveCursor(-1);
			else this.scroll = Math.max(0, this.scroll - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			if (isListTab) this.moveCursor(1);
			else this.scroll++;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			if (isListTab) this.moveCursor(-15);
			else this.scroll = Math.max(0, this.scroll - 15);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			if (isListTab) this.moveCursor(15);
			else this.scroll += 15;
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			if (isListTab) this.moveCursor(this.halfPage());
			else this.scroll += this.halfPage();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			if (isListTab) this.moveCursor(-this.halfPage());
			else this.scroll = Math.max(0, this.scroll - this.halfPage());
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.scroll = 0;
			if (isListTab) this.cursor = 0;
			return;
		}
		if (matchesKey(data, "end") || data === "G" || matchesKey(data, "shift+g")) {
			if (isListTab) {
				this.cursor = Number.MAX_SAFE_INTEGER;
				this.clampCursor();
				this.pendingFollow = true;
			} else {
				this.scroll = Number.MAX_SAFE_INTEGER;
			}
			return;
		}
		if (matchesKey(data, "enter")) {
			if (isListTab) this.openDetail();
			return;
		}
	}

	private switchTab(tab: number): void {
		this.tab = tab;
		this.scroll = 0;
		this.cursor = 0;
		if (tab === 3) {
			// 消息 tab 顶层是 payload 列表；光标停在当前快照上。
			this.msgMode = "payloads";
			this.cursor = this.pos;
			this.pendingFollow = true; // 当前请求可能不在第一屏
		}
		this.clearSearch();
	}

	/**
	 * Handle a request-switch key. Returns true when the key was consumed,
	 * including at the first/last snapshot so the caller does not treat it as
	 * something else.
	 */
	private trySwitchSnapshot(data: string): boolean {
		const prev = matchesKey(data, ",") || matchesKey(data, "[");
		const next = matchesKey(data, ".") || matchesKey(data, "]");
		if (!prev && !next) return false;
		this.detail = null;
		if (prev && this.pos > 0) {
			this.pos--;
			this.resetView();
		} else if (next && this.pos < this.opts.store.snapshots.length - 1) {
			this.pos++;
			this.resetView();
		}
		return true;
	}

	private moveCursor(delta: number): void {
		this.cursor = Math.max(0, this.cursor + delta);
		this.clampCursor();
		this.pendingFollow = true;
	}

	/**
	 * Scroll the cursor row into view. Runs in render() because the cursor's
	 * content line is only known once the list is built: cursor rows sit below
	 * header/group rows and may wrap, so the cursor index is not a screen row.
	 */
	private ensureCursorVisible(viewportH: number): void {
		if (this.detail || !this.cache || this.cursorRawLine === null) return;
		const line = this.cache.rawStart[this.cursorRawLine];
		if (line === undefined) return;
		if (line < this.scroll) this.scroll = Math.max(0, line - 2);
		else if (line >= this.scroll + viewportH) this.scroll = line - viewportH + 3;
	}

	private clampCursor(): void {
		const s = this.snap;
		const max =
			this.tab === 3
				? this.msgMode === "payloads"
					? Math.max(0, this.opts.store.snapshots.length - 1)
					: Math.max(0, s.messages.length - 1 + (hasWirePayload(s.payload) ? 1 : 0))
				: this.tab === 2
					? Math.max(0, this.toolDisplayOrder.length - 1)
					: 0;
		this.cursor = Math.min(this.cursor, max);
	}

	private resetView(): void {
		this.scroll = 0;
		this.cursor = this.tab === 3 && this.msgMode === "payloads" ? this.pos : 0;
		this.detail = null;
		this.clearSearch();
		this.pendingFollow = true; // 新请求的光标行可能不在第一屏
	}

	// ------------------------------------------------------------------ search

	/** Typing mode for `/`: collect the query until Enter/Esc. */
	private handleSearchInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.searchInput = null;
			return;
		}
		if (matchesKey(data, "enter")) {
			const query = this.searchInput;
			this.searchInput = null;
			if (query.length > 0) {
				this.lastQuery = query;
				this.search = { query, matchLines: [], current: -1 };
				this.pendingJump = "first";
			}
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.searchInput = this.searchInput.slice(0, -1);
			return;
		}
		const decoded = decodeSearchChar(data);
		if (decoded) {
			this.searchInput += decoded;
			return;
		}
		// Plain UTF-8 text (e.g. CJK from an IME): no escape prefix, no control bytes.
		if (!data.includes("\x1b") && data.length > 0) {
			const printable = [...data].every((ch) => {
				const cp = ch.codePointAt(0) ?? 0;
				return cp >= 32 && cp !== 127;
			});
			if (printable) this.searchInput += data;
		}
	}

	private clearSearch(): void {
		this.search = null;
		this.pendingJump = null;
	}

	private halfPage(): number {
		return Math.max(4, Math.floor(this.lastViewportH / 2));
	}

	/**
	 * Recompute match lines against the currently rendered content and resolve
	 * a pending jump (first/next/prev). Only a resolved jump recenters the
	 * scroll, so manual scrolling is never fought.
	 */
	private resolveSearch(lines: string[], viewportH: number): void {
		if (!this.search) return;
		const needle = this.search.query.toLowerCase();
		const matchLines: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (stripAnsi(lines[i]).toLowerCase().includes(needle)) matchLines.push(i);
		}
		this.search.matchLines = matchLines;
		if (matchLines.length === 0) {
			this.search.current = -1;
			this.pendingJump = null;
			return;
		}
		let jumped = false;
		if (this.pendingJump === "first") {
			// Search forward from the current view (vim behaviour), wrap to the top.
			const rel = matchLines.findIndex((l) => l >= this.scroll);
			this.search.current = rel >= 0 ? rel : 0;
			jumped = true;
		} else if (this.pendingJump === "next") {
			this.search.current = (this.search.current + 1) % matchLines.length;
			jumped = true;
		} else if (this.pendingJump === "prev") {
			this.search.current = (this.search.current - 1 + matchLines.length) % matchLines.length;
			jumped = true;
		}
		this.pendingJump = null;
		if (jumped) {
			const line = matchLines[Math.max(0, this.search.current)];
			this.scroll = Math.max(0, line - Math.floor(viewportH / 2));
		}
	}
}

// ------------------------------------------------------------------ helpers

const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/** Strip SGR escape sequences so search matches plain text. */
function stripAnsi(line: string): string {
	return line.replace(ANSI_SGR_PATTERN, "");
}

const SEARCH_HL_START = "\x1b[30;103m"; // black on bright yellow (vim Search group)
const SEARCH_HL_END = "\x1b[0m";

/**
 * Highlight every case-insensitive occurrence of `needle` in `line` with a
 * yellow background, restoring any enclosing SGR style after each match so
 * surrounding colored text keeps its look. Returns the line unchanged when
 * it contains no match.
 */
function highlightSearchMatches(line: string, needle: string): string {
	if (!needle) return line;
	const needleLower = needle.toLowerCase();
	if (
		!line.toLowerCase().includes(needleLower) &&
		!stripAnsi(line).toLowerCase().includes(needleLower)
	) {
		return line;
	}
	// Tokenize: visible code points with their code-unit offsets (SGR runs are skipped).
	const chars: { ch: string; at: number }[] = [];
	const pushChars = (slice: string, from: number) => {
		let at = from;
		for (const ch of slice) {
			chars.push({ ch, at });
			at += ch.length;
		}
	};
	const seqRe = /\x1b\[[0-9;]*m/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = seqRe.exec(line)) !== null) {
		pushChars(line.slice(last, m.index), last);
		last = m.index + m[0].length;
	}
	pushChars(line.slice(last), last);
	// Non-overlapping case-insensitive occurrences, matched over code points.
	const needleCps = [...needleLower];
	const n = needleCps.length;
	const insertions: { at: number; kind: "start" | "end" }[] = [];
	for (let i = 0; i + n <= chars.length; i++) {
		let ok = true;
		for (let k = 0; k < n; k++) {
			if (chars[i + k].ch.toLowerCase() !== needleCps[k]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			insertions.push({ at: chars[i].at, kind: "start" });
			const endChar = chars[i + n - 1];
			insertions.push({ at: endChar.at + endChar.ch.length, kind: "end" });
			i += n - 1;
		}
	}
	if (insertions.length === 0) return line;
	insertions.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "end" ? -1 : 1));
	// Rebuild the line, inserting highlight codes at match boundaries and
	// tracking active SGR styles so each match end restores them.
	let result = "";
	let styles: string[] = [];
	let insIdx = 0;
	const flush = (limit: number) => {
		while (insIdx < insertions.length && insertions[insIdx].at <= limit) {
			const ins = insertions[insIdx++];
			result += ins.kind === "start" ? SEARCH_HL_START : SEARCH_HL_END + styles.join("");
		}
	};
	seqRe.lastIndex = 0;
	last = 0;
	while ((m = seqRe.exec(line)) !== null) {
		let at = last;
		for (const ch of line.slice(last, m.index)) {
			flush(at);
			result += ch;
			at += ch.length;
		}
		flush(m.index);
		if (m[0] === "\x1b[0m") styles = [];
		else styles.push(m[0]);
		result += m[0];
		last = m.index + m[0].length;
	}
	let at = last;
	for (const ch of line.slice(last)) {
		flush(at);
		result += ch;
		at += ch.length;
	}
	flush(Infinity);
	return result;
}

/**
 * Decode a printable character typed while in search mode. Handles Kitty
 * CSI-u sequences (plain or shifted) so typing works in terminals that use
 * the disambiguate mode; plain UTF-8 data is handled by the caller.
 */
function decodeSearchChar(data: string): string | undefined {
	const m = data.match(/^\x1b\[(\d+)(?::(\d*))?(?:;(\d+))?(?::\d+)?u$/);
	if (!m) return undefined;
	const mod = m[3] ? Number.parseInt(m[3], 10) - 1 : 0;
	if (mod !== 0 && mod !== 1) return undefined; // plain or shift only
	let cp = Number.parseInt(m[1]!, 10);
	if (mod === 1 && m[2] && m[2].length > 0) cp = Number.parseInt(m[2], 10); // prefer the shifted codepoint
	if (!Number.isFinite(cp) || cp < 32) return undefined;
	try {
		return String.fromCodePoint(cp);
	} catch {
		return undefined;
	}
}

function padVisible(styled: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(styled));
	return styled + " ".repeat(pad);
}

interface ToolGroup {
	label: string;
	tools: ToolMeta[];
	sourcePath?: string;
}

function groupTools(tools: ToolMeta[]): ToolGroup[] {
	const groups = new Map<string, ToolGroup>();
	for (const tool of tools) {
		let label: string;
		let sourcePath: string | undefined;
		if (tool.namespace) {
			label = tool.namespace;
		} else if (tool.name.startsWith("mcp__")) {
			label = `mcp__${tool.name.split("__")[1] ?? "?"}`;
		} else if (tool.source === "builtin") {
			label =
				tool.sourcePath && tool.sourcePath !== "builtin:read" && tool.sourcePath.startsWith("builtin:")
					? `内置(${tool.sourcePath.slice("builtin:".length)})`
					: "builtin";
		} else {
			label = `扩展 ${tool.sourcePath?.split("/").pop() ?? tool.source}`;
			sourcePath = tool.sourcePath;
		}
		const group = groups.get(label) ?? { label, tools: [], sourcePath };
		group.tools.push(tool);
		groups.set(label, group);
	}
	return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function roleLabel(role: string): string {
	switch (role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "toolResult":
			return "toolResult";
		case "system":
			return "system";
		case "custom":
			return "custom(hook)";
		case "bashExecution":
			return "bash(!)";
		case "compactionSummary":
			return "compaction";
		case "branchSummary":
			return "branchSummary";
		default:
			return role;
	}
}

function roleStyledLabel(t: Theme, role: string, label: string): string {
	switch (role) {
		case "user":
			return t.fg("accent", label);
		case "assistant":
			return t.fg("muted", label);
		case "toolResult":
			return t.fg("success", label);
		case "system":
			return t.fg("warning", label);
		case "custom":
			return t.fg("warning", t.bold(label));
		default:
			return t.fg("muted", label);
	}
}
