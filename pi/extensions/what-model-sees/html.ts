/**
 * what-model-sees — self-contained HTML export.
 *
 * One file per request: overview stats, full system prompt, tool
 * declarations, every message, the sanitized wire payload, and a colored
 * diff against the previous request. No external assets, no JS.
 */
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
import type { RequestSnapshot } from "./types.ts";
import { pairWireMessages } from "./wirematch.ts";

function esc(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function prettyJson(value: unknown, capLines = 20000): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
	const lines = text.split("\n");
	if (lines.length > capLines) {
		return `${lines.slice(0, capLines).join("\n")}\n… truncated (${lines.length} lines total)`;
	}
	return text;
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { background: #16181d; color: #d7dae0; font: 14px/1.55 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; margin: 0; padding: 0 0 60px; }
.wrap { max-width: 110ch; margin: 0 auto; padding: 0 20px; }
h1 { font-size: 16px; margin: 24px 0 4px; color: #8ab4f8; }
h2 { font-size: 14px; margin: 28px 0 8px; color: #8ab4f8; border-bottom: 1px solid #2a2d34; padding-bottom: 6px; }
.meta { color: #9aa0a6; font-size: 12px; margin-bottom: 12px; }
.meta b { color: #d7dae0; }
pre { background: #1d2026; border: 1px solid #2a2d34; border-radius: 6px; padding: 10px 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 8px 0; }
details { margin: 8px 0; border: 1px solid #2a2d34; border-radius: 6px; background: #1d2026; }
details > summary { cursor: pointer; padding: 8px 12px; color: #bdc1c6; list-style: none; user-select: none; }
details > summary::before { content: "▸ "; color: #9aa0a6; }
details[open] > summary::before { content: "▾ "; }
details > .body { padding: 0 12px 10px; }
.tag { display: inline-block; border-radius: 4px; padding: 0 6px; font-size: 11px; margin-right: 4px; }
.t-user { background: #26304a; color: #8ab4f8; }
.t-assistant { background: #2b2f36; color: #bdc1c6; }
.t-toolResult { background: #1f3324; color: #81c995; }
.t-system { background: #3d3222; color: #fdd663; }
.t-custom { background: #3d3222; color: #fdd663; font-weight: bold; }
.t-other { background: #2b2f36; color: #9aa0a6; }
.err { color: #f28b82; }
.ok { color: #81c995; }
.warn { color: #fdd663; }
.dim { color: #9aa0a6; }
.bar { display: flex; height: 14px; border-radius: 4px; overflow: hidden; margin: 6px 0; max-width: 720px; }
.bar span { display: block; height: 100%; }
table { border-collapse: collapse; margin: 8px 0; }
td, th { border: 1px solid #2a2d34; padding: 4px 10px; text-align: left; font-size: 12.5px; }
th { color: #9aa0a6; font-weight: normal; }
.dadd { color: #81c995; background: #1f3324; display: block; }
.ddel { color: #f28b82; background: #3d2226; display: block; }
.dctx { color: #9aa0a6; display: block; }
footer { color: #9aa0a6; font-size: 11.5px; margin-top: 30px; }
`;

function formatTiming(timing: {
	tps?: number;
	outputTokens?: number;
	ttftMs?: number;
	generationMs?: number;
	totalMs?: number;
}): string {
	const bits: string[] = [];
	if (timing.tps !== undefined) bits.push(`<b>TPS</b> ${formatTps(timing.tps)} tok/s`);
	if (timing.ttftMs !== undefined) bits.push(`<b>TTFT</b> ${formatSeconds(timing.ttftMs)}`);
	if (timing.totalMs !== undefined) {
		const outTok = timing.outputTokens !== undefined ? ` / ${formatTokens(timing.outputTokens)} tok` : "";
		bits.push(`<b>E2E</b> ${formatSeconds(timing.totalMs)}${outTok}`);
	} else if (timing.outputTokens !== undefined) {
		bits.push(`${formatTokens(timing.outputTokens)} tok`);
	}
	return bits.join(" · ");
}

export function buildHtml(s: RequestSnapshot, prev: RequestSnapshot | undefined): string {
	const st = s.stats;
	const parts: string[] = [];

	parts.push(`<!doctype html><html><head><meta charset="utf-8"><title>what-model-sees #${s.index}</title><style>${CSS}</style></head><body><div class="wrap">`);

	// -- header
	const inTok = s.usage ? (s.usage.input ?? 0) + (s.usage.cacheRead ?? 0) + (s.usage.cacheWrite ?? 0) : undefined;
	parts.push(
		`<h1>what-model-sees — request #${s.index}${prev ? ` <span class="dim">of run</span>` : ""}</h1>`,
	);
	parts.push(
		`<div class="meta"><b>${esc(s.provider ?? "?")}/${esc(s.model ?? "?")}</b> · ${esc(s.api ?? "?")} · ${esc(formatTime(s.timestamp))} · turn ${s.turnIndex == null ? "?" : s.turnIndex + 1} · run ${s.runIndex ?? "?"}${
			s.responseStatus !== undefined ? ` · HTTP ${s.responseStatus}` : ""
		}${s.usage ? ` · in ${formatTokens(inTok ?? 0)} (cache R ${formatTokens(s.usage.cacheRead ?? 0)} / W ${formatTokens(s.usage.cacheWrite ?? 0)}) · out ${formatTokens(s.usage.output ?? 0)}${s.usage.costTotal !== undefined ? ` · $${s.usage.costTotal.toFixed(4)}` : ""}` : ""}${s.contextWindow ? ` · ctx ${Math.round(((inTok ?? estimateTokens(st.systemChars + st.toolDeclChars + st.totalMessageChars)) / s.contextWindow) * 100)}% of ${formatTokens(s.contextWindow)}` : ""}</div>`,
	);

	// -- overview bar
	const timing = timingSummary(s);
	const convRoles = ["user", "assistant", "custom", "bashExecution", "compactionSummary", "branchSummary"];
	const convChars = convRoles.reduce((sum, r) => sum + (st.byRole[r]?.chars ?? 0), 0);
	const segments = [
		{ label: "系统提示", chars: st.systemChars, color: "#8ab4f8" },
		{ label: "工具声明", chars: st.toolDeclChars, color: "#fdd663" },
		{ label: "对话", chars: convChars, color: "#bdc1c6" },
		{ label: "工具结果", chars: st.byRole.toolResult?.chars ?? 0, color: "#81c995" },
	];
	const totalChars = segments.reduce((sum, seg) => sum + seg.chars, 0) || 1;
	parts.push(`<h2>上下文构成（估算 ≈${formatTokens(estimateTokens(totalChars))} tok）</h2>`);
	parts.push(`<div class="bar">`);
	for (const seg of segments) {
		const pct = (seg.chars / totalChars) * 100;
		parts.push(`<span style="width:${pct}%;background:${seg.color}" title="${esc(seg.label)} ${formatChars(seg.chars)} chars"></span>`);
	}
	parts.push(`</div>`);
	parts.push(
		`<table><tr><th>部分</th><th>chars</th><th>≈tokens</th></tr>${segments
			.map(
				(seg) =>
					`<tr><td>${esc(seg.label)}</td><td>${formatChars(seg.chars)}</td><td>≈${formatTokens(estimateTokens(seg.chars))}</td></tr>`,
			)
			.join("")}<tr><td>消息数</td><td colspan="2">${Object.values(st.byRole).reduce((n, r) => n + r.count, 0)} 条（${Object.entries(st.byRole).map(([r, v]) => `${esc(r)} ${v.count}`).join(" · ")}）</td></tr>${st.imageCount > 0 ? `<tr><td>内嵌图片</td><td colspan="2">${st.imageCount} 张 ≈ ${formatBytes(st.imageBytes)}（快照中为占位符）</td></tr>` : ""}${timing ? `<tr><td>输出速度</td><td colspan="2">${formatTiming(timing)}</td></tr>` : ""}<tr><td>wire payload</td><td colspan="2">原始 ${formatChars(st.payloadBytesRaw)} chars · 脱敏后 ${formatChars(st.payloadBytes)} chars</td></tr></table>`,
	);

	// -- context files
	if (s.promptOptions) {
		const po = s.promptOptions;
		parts.push(`<h2>System prompt 来源（${formatChars(st.systemChars)} chars）</h2><table>`);
		for (const f of po.contextFiles) {
			parts.push(`<tr><td>${esc(f.path)}</td><td>${formatChars(f.chars)} chars</td></tr>`);
		}
		parts.push(
			`<tr><td>基础指令+规则+技能提示</td><td>${formatChars(Math.max(0, st.systemChars - po.contextFiles.reduce((n, f) => n + f.chars, 0)))} chars</td></tr>`,
		);
		if (po.appendSystemPrompt) parts.push(`<tr><td>appendSystemPrompt</td><td>${formatChars(po.appendSystemPrompt.length)} chars</td></tr>`);
		if (po.customPrompt) parts.push(`<tr><td>customPrompt (--system-prompt / SYSTEM.md)</td><td>已设置</td></tr>`);
		if (po.forceSystemPrompt) parts.push(`<tr><td class="warn">forceSystemPrompt</td><td class="warn">⚠ 完全替换系统提示</td></tr>`);
		parts.push(`</table>`);
		if (po.skills.length > 0) {
			parts.push(`<h2>技能 (${po.skills.length})</h2><table>`);
			for (const skill of po.skills) {
				parts.push(`<tr><td><b>${esc(skill.name)}</b></td><td>${esc(skill.description)}</td><td class="dim">${esc(skill.filePath)}</td></tr>`);
			}
			parts.push(`</table>`);
		}
		if (po.hiddenTools.length > 0) {
			parts.push(`<h2 class="warn">隐藏工具（active 但声明不发给模型）</h2><p>${esc(po.hiddenTools.join(", "))}</p>`);
		}
	}

	// -- diff
	if (prev) {
		const diff = diffSnapshots(prev, s);
		parts.push(`<h2>较上次请求 #${prev.index} 的差异</h2><pre>`);
		parts.push(
			`System prompt: ${diff.systemChanged ? `<span class="warn">已变化 (${diff.systemDiff.added}+ / ${diff.systemDiff.removed}-)</span>` : '<span class="ok">未变化</span>'}\n工具: ${diff.toolsAdded.length > 0 ? `+${esc(diff.toolsAdded.join(", "))}` : ""}${diff.toolsRemoved.length > 0 ? ` -${esc(diff.toolsRemoved.join(", "))}` : ""}${diff.toolsAdded.length + diff.toolsRemoved.length === 0 ? "未变化" : ""}\n消息: 公共前缀 ${diff.messagesCommon} · 新增 ${diff.messagesAppended.length} · 替换 ${diff.messagesReplaced} · 移除 ${diff.messagesRemoved}\npayload: ${diff.payloadCharDelta >= 0 ? "+" : "-"}${formatChars(Math.abs(diff.payloadCharDelta))} chars`,
		);
		parts.push(`</pre>`);
		if (diff.systemChanged) {
			parts.push(`<details><summary>system prompt 行级 diff</summary><div class="body"><pre style="background:transparent;border:0;padding:0">`);
			for (const entry of diff.systemDiff.entries) {
				const cls = entry.type === "+" ? "dadd" : entry.type === "-" ? "ddel" : "dctx";
				const mark = entry.type === "+" ? "+" : entry.type === "-" ? "-" : " ";
				parts.push(`<span class="${cls}">${mark} ${esc(entry.text)}</span>`);
			}
			parts.push(`</pre></div></details>`);
		}
	}

	// -- system prompt
	parts.push(`<h2>System prompt 全文</h2><pre>${esc(s.systemPromptText || "（无）")}</pre>`);

	// -- tools
	parts.push(`<h2>工具声明 (${s.tools.length})</h2>`);
	for (const tool of s.tools) {
		parts.push(
			`<details><summary><b>${esc(tool.name)}</b> <span class="dim">${esc(tool.namespace ?? tool.source)}${tool.sourcePath ? ` · ${esc(tool.sourcePath)}` : ""} · ≈${formatChars(tool.schemaChars)} chars</span></summary><div class="body"><p class="dim">${esc(tool.description)}</p></div></details>`,
		);
	}

	// -- messages
	const pair = pairWireMessages(s);
	parts.push(`<h2>消息 (${s.messages.length})</h2>`);
	s.messages.forEach((m, i) => {
		const d = describeMessage(m);
		const cls = ["user", "assistant", "toolResult", "system", "custom"].includes(d.role) ? `t-${d.role}` : "t-other";
		const wireMsg = pair.matched[i];
		const note = pair.notes[i];
		const wireBlock =
			wireMsg !== undefined
				? `<p class="dim">wire JSON（实际发给 provider 的样子）：</p><pre>${esc(prettyJson(wireMsg, 4000))}</pre>`
				: `<p class="warn">${esc(note ?? "无 wire 对应")}</p><p class="dim">pi 语义格式 JSON：</p><pre>${esc(prettyJson(m, 4000))}</pre>`;
		parts.push(
			`<details><summary><span class="tag ${cls}">#${i + 1} ${esc(d.label)}</span> <span class="dim">${formatChars(d.chars)} chars</span> ${esc(d.preview.slice(0, 100))}</summary><div class="body">${wireBlock}</div></details>`,
		);
	});

	// -- wire payload
	parts.push(
		`<h2>wire payload（脱敏后）</h2><details open><summary>发送给 provider 的实际 JSON</summary><div class="body"><pre>${esc(prettyJson(s.payload))}</pre></div></details>`,
	);

	parts.push(
		`<footer>generated by what-model-sees · request #${s.index} · ${new Date().toISOString()} · 图片与密钥已脱敏</footer>`,
	);
	parts.push(`</div></body></html>`);
	return parts.join("");
}
