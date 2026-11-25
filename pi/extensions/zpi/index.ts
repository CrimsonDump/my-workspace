/**
 * zpi — orchestrate pi sessions as panes in a dedicated zellij session.
 *
 * Every session (top-level or zpi-spawned) gets the same toolkit:
 *   - zpi_open:  spawn a child pi in a pane of the configured zellij session,
 *                with tab packing (max N panes per tab) and a nesting depth guard
 *   - zpi_send:  inject a message into a target session's pane (registry name,
 *                or omitted/"parent" = the session that spawned this one);
 *                works mid-run, pi queues it as steering input
 *   - zpi_list:  list zpi sessions with live status
 *   - zpi_close: close any zpi session's pane (pi session file survives)
 *   - /zpi:      status;  /zpi tidy: restack panes, rename tabs, drop empty tabs
 *
 * Every tool is available to every session — zpi has no "child" role, only
 * identity attributes: ZPI_SESSION_ID (registry-tracked), ZPI_PARENT
 * (spawner pane ref), ZPI_DEPTH (nesting level). Concretely:
 *   - Registry-tracked sessions write an activity heartbeat.
 *   - The idle watchdog runs in every interactive session and closes tracked
 *     panes after config.idleTimeoutMinutes (keep- prefix exempt). Children
 *     report results via zpi_send (the spawn-time task tail says so); there
 *     is deliberately no "done" tool — pane reaping is the watchdog's job.
 *
 * zellij 0.45.1 facts this code relies on (all verified empirically):
 *   - The CLI reports exit 0 on failure and may print phantom pane ids
 *     ("run --no-focus" across sessions does exactly that) -> every mutation
 *     is re-verified with `action list-panes`.
 *   - write-chars without -p goes to the *focused* pane, which in a fresh
 *     session is a floating "About Zellij" plugin -> always target -p <id>.
 *   - `zellij run -c --close-on-exit` closes the pane when its command exits,
 *     which aligns pane lifetime with the child pi process.
 *   - `zellij subscribe -p <ids...> -f json` streams pane_update events for
 *     any pane of any session; any render (streaming, spinner, user typing)
 *     counts as activity.
 *
 * Prompt economy: tool descriptions carry only the call contract (what it
 * does, how to fill params). Trigger rules live in promptGuidelines.
 * Mechanisms and per-event details (attach commands, depth limits, domain
 * listings, recovery paths) are delivered in results and error texts at the
 * moment they matter — see pi-web-search-lite's result envelope for the
 * pattern this follows.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Config & registry
// ---------------------------------------------------------------------------

interface ZpiConfig {
	zellijSession: string;
	maxPanesPerTab: number;
	idleTimeoutMinutes: number;
	checkIntervalMinutes: number;
	keepPrefix: string;
	maxDepth: number; // 0 = unlimited nesting
}

const DEFAULT_CONFIG: ZpiConfig = {
	zellijSession: "pi-agents",
	maxPanesPerTab: 8,
	idleTimeoutMinutes: 60,
	checkIntervalMinutes: 5,
	keepPrefix: "keep-",
	maxDepth: 3,
};

const ZPI_DIR = path.join(os.homedir(), ".pi", "agent", "zpi");
const CONFIG_PATH = path.join(ZPI_DIR, "config.json");
const REGISTRY_PATH = path.join(ZPI_DIR, "registry.json");
const HEARTBEAT_DIR = path.join(ZPI_DIR, "hb");

function loadConfig(): ZpiConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<ZpiConfig>;
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

interface ZpiEntry {
	sessionId: string; // pi session id (also the resume handle)
	name: string; // display name & zellij pane name
	task: string;
	paneId: string; // e.g. "terminal_5"
	tabId: number;
	cwd: string;
	model?: string;
	spawnedAt: number; // epoch ms
	lastActivity: number; // epoch ms
	closedAt?: number;
	closedReason?: string;
}

function loadRegistry(): ZpiEntry[] {
	try {
		return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8")) as ZpiEntry[];
	} catch {
		return [];
	}
}

/** Atomic write so concurrent sessions cannot corrupt the file. */
function saveRegistry(entries: ZpiEntry[]): void {
	fs.mkdirSync(ZPI_DIR, { recursive: true });
	const tmp = `${REGISTRY_PATH}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entries, null, "\t"));
	fs.renameSync(tmp, REGISTRY_PATH);
}

// ---------------------------------------------------------------------------
// zellij CLI helpers
// ---------------------------------------------------------------------------

interface ZjResult {
	code: number;
	stdout: string;
	stderr: string;
}

function zj(args: string[]): Promise<ZjResult> {
	return new Promise((resolve) => {
		const child = spawn("zellij", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

interface PaneInfo {
	id: string;
	type: string; // "terminal" | "plugin"
	title: string;
}

interface TabInfo {
	id: number;
	position: number;
	name: string;
}

async function listPanes(zs: string): Promise<PaneInfo[]> {
	const r = await zj(["-s", zs, "action", "list-panes"]);
	const panes: PaneInfo[] = [];
	for (const line of r.stdout.split("\n")) {
		const m = line.match(/^(\S+)\s{2,}(\S+)\s{2,}(.*)$/);
		if (m) panes.push({ id: m[1], type: m[2], title: m[3].trim() });
	}
	return panes;
}

async function listTabs(zs: string): Promise<TabInfo[]> {
	const r = await zj(["-s", zs, "action", "list-tabs"]);
	const tabs: TabInfo[] = [];
	for (const line of r.stdout.split("\n")) {
		const m = line.match(/^(\d+)\s{2,}(\d+)\s{2,}(.*)$/);
		if (m) tabs.push({ id: Number(m[1]), position: Number(m[2]), name: m[3].trim() });
	}
	return tabs.sort((a, b) => a.position - b.position);
}

async function zellijSessionExists(name: string): Promise<boolean> {
	const r = await zj(["list-sessions", "--short", "--no-formatting"]);
	return r.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.includes(name);
}

async function ensureZellijSession(zs: string): Promise<void> {
	if (await zellijSessionExists(zs)) return;
	await zj(["attach", zs, "--create-background", "--", "sleep", "infinity"]);
	if (!(await zellijSessionExists(zs))) {
		throw new Error(`Failed to create zellij session "${zs}" (is zellij >= 0.40 installed and on PATH?)`);
	}
	// Dismiss the floating welcome pane that new sessions open with.
	await zj(["-s", zs, "action", "hide-floating-panes"]);
}

/** Read a session's last heartbeat event name, if a heartbeat exists. */
function lastHeartbeatEvent(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	try {
		return fs.readFileSync(path.join(HEARTBEAT_DIR, sessionId), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

// 心跳事件处于工具执行窗口内：此刻中断会杀掉在途工具（SIGTERM，副作用停在半途）
const MID_TOOL_EVENTS = new Set(["tool_execution_start", "tool_call", "tool_result"]);

/**
 * Inject a message into a pane: type the text, then press Enter (byte 13).
 *
 * Smart interrupt: 先 Escape 中断目标当前轮使消息立即生效；仅当心跳显示
 * 有工具调用正在执行（或读不到心跳，状态不可知）时不中断，作为 steering
 * 等当前轮安全结束后生效。
 */
async function injectMessage(
	zs: string,
	paneId: string,
	message: string,
	opts?: { sessionId?: string }, // 目标的 registry id，用于查心跳；无则保守 steering
): Promise<void> {
	const hb = lastHeartbeatEvent(opts?.sessionId);
	if (hb !== undefined && !MID_TOOL_EVENTS.has(hb)) {
		// Escape = app.interrupt：此刻无工具在执行，中断安全
		await zj(["-s", zs, "action", "write", "27", "-p", paneId]);
		// 等 pi 处理完中断再提交，否则 Enter 可能落进垂死的轮里、被当成 steering
		await new Promise((res) => setTimeout(res, 400));
	}
	await zj(["-s", zs, "action", "write-chars", "-p", paneId, message]);
	await zj(["-s", zs, "action", "write", "13", "-p", paneId]);
}

// ---------------------------------------------------------------------------
// Activity tracking (render subscription + child heartbeat files)
// ---------------------------------------------------------------------------

const lastActivity = new Map<string, number>(); // paneId -> epoch ms

let subscriber: ChildProcess | null = null;
let subscriberKey = "";

function restartSubscriber(zs: string, paneIds: string[]): void {
	const key = `${zs}|${paneIds.join(",")}`;
	if (key === subscriberKey) return;
	subscriberKey = key;
	if (subscriber) {
		subscriber.kill("SIGTERM");
		subscriber = null;
	}
	if (paneIds.length === 0) return;
	subscriber = spawn("zellij", ["-s", zs, "subscribe", "-f", "json", "-p", ...paneIds], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	subscriber.on("error", () => {
		subscriber = null;
		subscriberKey = "";
	});
	subscriber.on("close", () => {
		subscriber = null;
		subscriberKey = ""; // allow a later restart to retry
	});
	let buf = "";
	subscriber.stdout?.on("data", (d) => {
		buf += d.toString();
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const ev = JSON.parse(line) as { event?: string; is_initial?: boolean; pane_id?: string };
				if (ev.event === "pane_update" && ev.pane_id && ev.is_initial === false) {
					lastActivity.set(ev.pane_id, Date.now());
				}
			} catch {
				/* ignore malformed lines */
			}
		}
	});
}

function heartbeatMtime(sessionId: string): number {
	try {
		return fs.statSync(path.join(HEARTBEAT_DIR, sessionId)).mtimeMs;
	} catch {
		return 0;
	}
}

/** A closed session no longer beats; drop its file so hb/ stays clean. */
function removeHeartbeat(sessionId: string): void {
	try {
		fs.unlinkSync(path.join(HEARTBEAT_DIR, sessionId));
	} catch {
		/* already gone */
	}
}

/** Periodic reconcile: drop dead panes, close idle ones, keep subscriber fresh. */
async function watchdogTick(cfg: ZpiConfig): Promise<void> {
	const zs = cfg.zellijSession;
	if (!(await zellijSessionExists(zs))) return;
	const entries = loadRegistry();
	const panes = await listPanes(zs);
	const now = Date.now();
	let changed = false;

	for (const e of entries) {
		if (e.closedAt) continue;
		const alive = panes.find((p) => p.id === e.paneId && p.type === "terminal");
		if (!alive) {
			e.closedAt = now;
			e.closedReason = "pane gone (pi exited or user closed it)";
			removeHeartbeat(e.sessionId);
			changed = true;
			continue;
		}
		if (e.name.startsWith(cfg.keepPrefix)) continue;
		const act = Math.max(
			lastActivity.get(e.paneId) ?? 0,
			heartbeatMtime(e.sessionId),
			e.lastActivity,
			e.spawnedAt,
		);
		e.lastActivity = act;
		if (now - act > cfg.idleTimeoutMinutes * 60_000) {
			await zj(["-s", zs, "action", "close-pane", "-p", e.paneId]);
			const still = (await listPanes(zs)).find((p) => p.id === e.paneId);
			if (!still) {
				e.closedAt = now;
				e.closedReason = `idle > ${cfg.idleTimeoutMinutes}m`;
				removeHeartbeat(e.sessionId);
				changed = true;
			}
		} else {
			changed = true; // persist freshened lastActivity
		}
	}

	if (changed) saveRegistry(entries);
	const activeIds = entries.filter((e) => !e.closedAt).map((e) => e.paneId);
	restartSubscriber(zs, activeIds);
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function slugify(text: string): string {
	const s = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	return s || "agent";
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 6);
}

function defaultName(task: string): string {
	const s = task.replace(/\s+/g, " ").trim().slice(0, 20);
	return s || "agent";
}

async function pickOrCreateTab(zs: string, entries: ZpiEntry[], maxPerTab: number): Promise<number> {
	const tabs = await listTabs(zs);
	const countPerTab = new Map<number, number>();
	for (const e of entries) {
		if (e.closedAt) continue;
		countPerTab.set(e.tabId, (countPerTab.get(e.tabId) ?? 0) + 1);
	}
	for (const t of tabs) {
		if ((countPerTab.get(t.id) ?? 0) < maxPerTab) return t.id;
	}
	const name = `agents-${tabs.length + 1}`;
	const r = await zj(["-s", zs, "action", "new-tab", "--name", name]);
	const id = Number(r.stdout.trim());
	if (!Number.isFinite(id)) {
		throw new Error(`Failed to create tab "${name}": ${r.stderr.trim() || "no tab id returned"}`);
	}
	return id;
}

interface OpenOptions {
	name: string;
	task: string;
	cwd: string;
	model?: string;
	parentRef?: string; // "<parentZellijSession>:<parentPaneId>" if the parent lives in zellij
	depth: number; // nesting depth assigned to the child
}

async function openAgent(cfg: ZpiConfig, opts: OpenOptions): Promise<ZpiEntry> {
	const zs = cfg.zellijSession;
	await ensureZellijSession(zs);

	const sessionId = `zpi-${slugify(opts.name)}-${randomSuffix()}`;
	const entries = loadRegistry();
	const tabId = await pickOrCreateTab(zs, entries, cfg.maxPanesPerTab);

	const piArgs = ["pi", "--session-id", sessionId, "-n", opts.name];
	if (opts.model) piArgs.push("--model", opts.model);
	const reportTail = opts.parentRef
		? '任务完成后用 zpi_send(target="parent") 把最终结果摘要回报派生你的会话；内容较长时先写入文件、在消息里引用路径，需要中途沟通也用它。'
		: "任务完成后直接给出最终结果摘要即可。";
	piArgs.push(
		"--",
		`${opts.task}\n\n(${reportTail} 本 pane 闲置超时后会自动回收，pi 会话文件保留，可 pi --session-id 恢复。)`,
	);

	const envCmd: string[] = [`ZPI_SESSION_ID=${sessionId}`, `ZPI_DEPTH=${String(opts.depth)}`];
	if (opts.parentRef) {
		envCmd.push(`ZPI_PARENT=${opts.parentRef}`);
		// 父会话本身是 zpi 会话时，传其 id 让子会话回报时也能读到父心跳（智能中断）
		if (process.env.ZPI_SESSION_ID) envCmd.push(`ZPI_PARENT_SID=${process.env.ZPI_SESSION_ID}`);
	}

	const r = await zj([
		"-s",
		zs,
		"run",
		"--tab-id",
		String(tabId),
		"-n",
		opts.name,
		"--cwd",
		opts.cwd,
		"-c",
		"--",
		// absolute path: a PATH shadowing "env" (e.g. a sourced ~/.local/bin/env
		// path-setup script) would silently swallow the command and kill the pane
		"/usr/bin/env",
		...envCmd,
		...piArgs,
	]);

	// zellij may print a phantom pane id on failure (exit codes lie), so
	// verify the pane actually exists; creation can also lag slightly.
	const claimed = r.stdout.trim();
	let pane: PaneInfo | undefined;
	for (let i = 0; i < 10 && !pane; i++) {
		await new Promise((res) => setTimeout(res, 300));
		const panes = await listPanes(zs);
		pane = panes.find((p) => p.type === "terminal" && (p.id === claimed || p.title === opts.name));
	}
	if (!pane) {
		throw new Error(
			`Pane for "${opts.name}" did not appear (zellij said "${claimed || "nothing"}"; stderr: ${r.stderr.trim() || "none"})`,
		);
	}

	const now = Date.now();
	const entry: ZpiEntry = {
		sessionId,
		name: opts.name,
		task: opts.task,
		paneId: pane.id,
		tabId,
		cwd: opts.cwd,
		model: opts.model,
		spawnedAt: now,
		lastActivity: now,
	};
	entries.push(entry);
	saveRegistry(entries);
	lastActivity.set(pane.id, now);
	restartSubscriber(zs, entries.filter((e) => !e.closedAt).map((e) => e.paneId));
	return entry;
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

/** Messages are delivered as typed keystrokes: force a single sane line. */
function sanitizeMessage(message: string): string {
	const oneLine = message.replace(/\s*\n\s*/g, " ⏎ ").replace(/\s+/g, " ").trim();
	if (!oneLine) throw new Error("Message is empty");
	return oneLine.length > 4000 ? `${oneLine.slice(0, 4000)}…` : oneLine;
}

function tryFindEntry(entries: ZpiEntry[], target: string): ZpiEntry | undefined {
	const t = target.trim();
	const active = entries.filter((e) => !e.closedAt);
	return (
		active.find((e) => e.sessionId === t) ??
		active.find((e) => e.name === t) ??
		active.find((e) => e.name.startsWith(t))
	);
}

/**
 * Manual (non-zpi) pi sessions come in two shapes:
 *  - shell-borne: the user runs `pi` inside a shell pane; pi then sets a
 *    dynamic "π - <name> - <dir>" pane title
 *  - command-borne: spawned via `zellij run -- pi ...`; zellij pins the
 *    pane title to the command line itself
 */
function findManualPiPane(panes: PaneInfo[], target: string): PaneInfo | undefined {
	const t = target.trim();
	if (!t) return undefined;
	return panes.find((p) => {
		if (p.type !== "terminal") return false;
		if (p.title.startsWith(`π - ${t}`) || p.title === t) return true;
		if (p.title === "pi" || p.title.startsWith("pi ")) {
			// Command-borne: match the target against the command tokens
			// (e.g. the --session-id or -n values).
			return t.length >= 3 && p.title.split(/\s+/).some((tok) => tok === t || tok.includes(t));
		}
		return false;
	});
}

/** ZELLIJ_PANE_ID is a bare number ("7"); list-panes reports "terminal_7". */
function normalizePaneId(id: string): string {
	return /^\d+$/.test(id) ? `terminal_${id}` : id;
}

/** One-line summary of the management domain for error messages. */
function domainSummary(panes: PaneInfo[], entries: ZpiEntry[]): string {
	const zsNames = entries.filter((e) => !e.closedAt).map((e) => e.name);
	const manual = panes
		.filter((p) => p.type === "terminal" && p.title.startsWith("π - "))
		.map((p) => p.title.slice(4));
	const parts: string[] = [];
	if (zsNames.length) parts.push(`zpi: ${zsNames.join(", ")}`);
	if (manual.length) parts.push(`手动: ${manual.join(" | ")}`);
	return parts.join("；") || "无";
}

/** Parse ZPI_PARENT into { zs, paneId }; null when absent/malformed. */
function parentRef(): { zs: string; paneId: string } | null {
	const raw = process.env.ZPI_PARENT ?? "";
	const [zs, id] = raw.split(":");
	if (!zs || !id) return null;
	return { zs, paneId: normalizePaneId(id) };
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

function taskPreview(task: string): string {
	const s = task.replace(/\s+/g, " ").trim();
	return s.length > 48 ? `${s.slice(0, 48)}…` : s;
}

function entryIdleMs(e: ZpiEntry): number {
	const act = Math.max(
		lastActivity.get(e.paneId) ?? 0,
		heartbeatMtime(e.sessionId),
		e.lastActivity,
		e.spawnedAt,
	);
	return Date.now() - act;
}

// ---------------------------------------------------------------------------
// /zpi status & tidy
// ---------------------------------------------------------------------------

async function statusText(cfg: ZpiConfig): Promise<string> {
	const zs = cfg.zellijSession;
	if (!(await zellijSessionExists(zs))) {
		return `zpi: zellij session "${zs}" is not running`;
	}
	const entries = loadRegistry().filter((e) => !e.closedAt);
	const panes = await listPanes(zs);
	const parts: string[] = [];
	for (const e of entries) {
		const alive = panes.some((p) => p.id === e.paneId && p.type === "terminal");
		parts.push(`${alive ? "●" : "✗"} ${e.name} (${formatDuration(entryIdleMs(e))} idle)`);
	}
	for (const p of panes) {
		if (p.type !== "terminal") continue;
		if (p.title.startsWith("π - ")) {
			parts.push(`◐ ${p.title.slice(4)} (手动)`);
		} else if (p.title === "pi" || p.title.startsWith("pi ")) {
			parts.push(`◐ ${p.title} (手动)`);
		}
	}
	return `zpi (${zs}): ${parts.join(", ") || "无会话"}`;
}

async function tidy(cfg: ZpiConfig): Promise<string> {
	const zs = cfg.zellijSession;
	if (!(await zellijSessionExists(zs))) {
		return `zellij session "${zs}" is not running; nothing to tidy.`;
	}
	const entries = loadRegistry();
	const panes = await listPanes(zs);
	const tabs = await listTabs(zs);
	const actions: string[] = [];
	const now = Date.now();

	// 1. Reconcile: mark entries whose pane disappeared.
	for (const e of entries) {
		if (!e.closedAt && !panes.some((p) => p.id === e.paneId && p.type === "terminal")) {
			e.closedAt = now;
			e.closedReason = "pane gone (detected during tidy)";
			removeHeartbeat(e.sessionId);
			actions.push(`标记 "${e.name}" 已关闭（pane 不存在）`);
		}
	}

	// 2. Stack each tab's panes and rename tabs sequentially.
	const active = entries.filter((e) => !e.closedAt);
	const byTab = new Map<number, ZpiEntry[]>();
	for (const e of active) {
		const list = byTab.get(e.tabId) ?? [];
		list.push(e);
		byTab.set(e.tabId, list);
	}
	let index = 1;
	for (let i = 0; i < tabs.length; i++) {
		const t = tabs[i];
		const group = byTab.get(t.id);
		if (!group || group.length === 0) {
			if (i > 0) {
				// The first tab also hosts the base "sleep infinity" pane; keep it.
				await zj(["-s", zs, "action", "close-tab-by-id", String(t.id)]);
				actions.push(`关闭空 tab ${t.id} (${t.name})`);
			}
			continue;
		}
		await zj(["-s", zs, "action", "stack-panes", "--", ...group.map((e) => e.paneId)]);
		const newName = `agents-${index++}`;
		if (t.name !== newName) {
			await zj(["-s", zs, "action", "rename-tab-by-id", String(t.id), newName]);
		}
		actions.push(`tab ${newName}: 堆叠 ${group.length} 个 pane`);
	}

	saveRegistry(entries);
	restartSubscriber(zs, active.map((e) => e.paneId));
	return actions.length ? `整理完成:\n${actions.map((a) => `- ${a}`).join("\n")}` : "没有需要整理的内容。";
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const trackedId = process.env.ZPI_SESSION_ID; // registry identity, if zpi-spawned
	const cfg = loadConfig();

	fs.mkdirSync(ZPI_DIR, { recursive: true });
	fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
	if (!fs.existsSync(CONFIG_PATH)) {
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, "\t"));
	}

	// --- registry-tracked sessions: activity heartbeat -------------------------

	if (trackedId) {
		const hbPath = path.join(HEARTBEAT_DIR, trackedId);
		// 心跳内容 = 最近事件名：zpi_send 据此判断目标是否处于工具执行窗口（智能中断）；
		// mtime 照常随写入更新，watchdog 的 idle 判定不受影响
		const beat = (event: string) => {
			try {
				fs.writeFileSync(hbPath, event);
			} catch {
				// best-effort
			}
		};
		pi.on("agent_start", () => beat("agent_start"));
		pi.on("agent_end", () => beat("agent_end"));
		pi.on("tool_execution_start", () => beat("tool_execution_start"));
		pi.on("tool_call", () => beat("tool_call"));
		pi.on("tool_result", () => beat("tool_result"));
		pi.on("tool_execution_end", () => beat("tool_execution_end"));
	}

	// --- zpi_send: unified messaging (target or parent) -----------------------

	pi.registerTool({
		name: "zpi_send",
		label: "向 zpi 会话发消息",
		// 只留调用契约；智能中断/steering 机制见 injectMessage 注释与 README——模型无参数可控它，无需预付
		description: "向另一个 pi 会话投递消息（目标运行中也能送达生效）。单行投递，长内容先写文件、只引用路径。",
		promptSnippet: "向其他 pi 会话投递消息",
		parameters: Type.Object({
			target: Type.String({
				minLength: 1,
				description: '会话名或 session id（zpi_list 查），或 "parent"（仅被 zpi_open 派生的会话可用）',
			}),
			message: Type.String({ description: "消息内容（单行）" }),
		}),
		async execute(_toolCallId, params) {
			try {
				const message = sanitizeMessage(params.message);
				const t = (params.target ?? "").trim();

				if (t === "" || t === "parent") {
					// Parent path: the spawner usually is NOT in the registry
					// (it is a hand-opened session), so use the ZPI_PARENT ref.
					const ref = parentRef();
					if (!ref) {
						return {
							content: [
								{
									type: "text",
									text: '本会话没有 "parent" 可用（ZPI_PARENT 未设置，或派生本会话的会话不在 zellij 里）。请用 target 指定一个 zpi 会话名（zpi_list 可查）。',
								},
							],
						};
					}
					const panes = await listPanes(ref.zs);
					if (!panes.some((p) => p.id === ref.paneId && p.type === "terminal")) {
						return {
							content: [
								{
									type: "text",
									text: `父会话 pane ${ref.paneId} 已不存在（zellij ${ref.zs}）。无法投递。`,
								},
							],
						};
					}
					await injectMessage(ref.zs, ref.paneId, message, { sessionId: process.env.ZPI_PARENT_SID });
					return {
						content: [{ type: "text", text: `已送达父会话 (${ref.zs}:${ref.paneId})。` }],
					};
				}

				// Registry path first, then hand-opened pi panes in the domain.
				const zs = cfg.zellijSession;
				const entries = loadRegistry();
				const entry = tryFindEntry(entries, t);
				const panes = await listPanes(zs);
				if (entry) {
					if (!panes.some((p) => p.id === entry.paneId && p.type === "terminal")) {
						return {
							content: [
								{
									type: "text",
									text: `Pane ${entry.paneId} of "${entry.name}" no longer exists. The pi session file survives; resume with: pi --session-id ${entry.sessionId}`,
								},
							],
						};
					}
					await injectMessage(zs, entry.paneId, message, { sessionId: entry.sessionId });
					entry.lastActivity = Date.now();
					saveRegistry(entries);
					return { content: [{ type: "text", text: `已送达 "${entry.name}" (${entry.paneId})。` }] };
				}
				const manual = findManualPiPane(panes, t);
				if (!manual) {
					return {
						content: [
							{
								type: "text",
								text: `没有匹配 "${t}" 的会话。当前: ${domainSummary(panes, entries)}`,
							},
						],
					};
				}
				await injectMessage(zs, manual.id, message);
				return {
					content: [{ type: "text", text: `已送达手动会话 "${manual.title}" (${manual.id})。` }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `zpi_send failed: ${err instanceof Error ? err.message : String(err)}` }],
				};
			}
		},
	});

	// --- zpi_list --------------------------------------------------------------

	pi.registerTool({
		name: "zpi_list",
		label: "列出 zpi 会话",
		description: "列出全部 agent 会话及实时状态：是否在跑、闲置多久、任务、恢复句柄。",
		promptSnippet: "列出所有 pi 会话及实时状态",
		// zpi_close 的触发规则并到这里：guidelines 按工具注入，一条说两件事比两条便宜
		promptGuidelines: ["确认其他会话状态用 zpi_list 查，别凭记忆猜；回收或终止后台会话用 zpi_close。"],
		parameters: Type.Object({}),
		async execute() {
			const zs = cfg.zellijSession;
			const entries = loadRegistry();
			const active = entries.filter((e) => !e.closedAt);
			const exists = await zellijSessionExists(zs);
			if (!exists) {
				return { content: [{ type: "text", text: `zellij session "${zs}" 未运行。` }] };
			}
			const panes = await listPanes(zs);
			const lines: string[] = [];
			for (const p of panes) {
				if (p.type !== "terminal") continue;
				const e = active.find((x) => x.paneId === p.id);
				if (e) {
					lines.push(
						`- ${e.name} [zpi·idle ${formatDuration(entryIdleMs(e))}] pane=${e.paneId} tab=${e.tabId} session=${e.sessionId}`,
						`  task: ${taskPreview(e.task)}`,
					);
				} else if (p.title.startsWith("π")) {
					lines.push(`- ${p.title.slice(4)} [手动] pane=${p.id}`);
				} else if (p.title === "pi" || p.title.startsWith("pi ")) {
					lines.push(`- ${p.title} [手动·命令式] pane=${p.id}`);
				} else {
					lines.push(`- [其他] pane=${p.id} title="${p.title}"`);
				}
			}
			const text =
				lines.length > 0
					? [`zellij session: ${zs}`, ...lines].join("\n")
					: `zellij session "${zs}" 里当前没有会话。`;
			return { content: [{ type: "text", text }] };
		},
	});

	// --- zpi_open (available in every session, depth-guarded) -------------------

	pi.registerTool({
		name: "zpi_open",
		label: "新开 zpi 会话",
		// 触发规则归 guidelines；attach 命令/会话名/深度上限详情在结果与拒绝错误里按次交付
		description: "新开一个 pi 子会话（zellij pane）并派发任务，立即开始工作；可嵌套但有深度上限。",
		promptSnippet: "新开一个 pi 子会话（zellij pane）并派发任务",
		promptGuidelines: ["想并行 / 开 subagent / 用户要开新会话时用 zpi_open。"],
		parameters: Type.Object({
			task: Type.String({ description: "任务提示词：写清目标、约束、收尾要求" }),
			name: Type.Optional(Type.String({ description: "短名；keep- 前缀豁免闲置自动回收" })),
			cwd: Type.Optional(Type.String({ description: "工作目录（默认当前）" })),
			model: Type.Optional(Type.String({ description: "provider/model" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const myDepth = Number(process.env.ZPI_DEPTH ?? "0") || 0;
			if (cfg.maxDepth > 0 && myDepth >= cfg.maxDepth) {
				return {
					content: [
						{
							type: "text",
							text: `已达到 zpi 嵌套上限（当前深度 ${myDepth}，maxDepth=${cfg.maxDepth}），拒绝继续开新会话。如需调整：~/.pi/agent/zpi/config.json 的 maxDepth（0 = 不限）。`,
						},
					],
				};
			}
			const name = (params.name?.trim() || defaultName(params.task)).replace(/\s+/g, " ").slice(0, 32);
			const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			if (!fs.existsSync(cwd)) {
				return { content: [{ type: "text", text: `cwd 不存在: ${cwd}` }] };
			}
			const ref =
				process.env.ZELLIJ_SESSION_NAME && process.env.ZELLIJ_PANE_ID
					? `${process.env.ZELLIJ_SESSION_NAME}:${process.env.ZELLIJ_PANE_ID}`
					: undefined;
			try {
				const entry = await openAgent(cfg, {
					name,
					task: params.task,
					cwd,
					model: params.model?.trim() || undefined,
					parentRef: ref,
					depth: myDepth + 1,
				});
				const zs = cfg.zellijSession;
				const lines = [
					`已开启 agent "${entry.name}"：zellij ${zs}，tab ${entry.tabId}，pane ${entry.paneId}，pi 会话 ${entry.sessionId}（嵌套深度 ${myDepth + 1}）。`,
					`任务已下发，子会话立即开始工作。`,
					``,
					`给用户：`,
					`- 观察并接手: zellij attach ${zs} （pane 标题即 "${entry.name}"，Ctrl+p d 可挂起离开）`,
					`- 只读观察: zellij watch ${zs}`,
					`- 若 pane 已被回收，可恢复: pi --session-id ${entry.sessionId}`,
				];
				lines.push(
					``,
					`可用 zpi_send(target="${entry.name}") 向它发消息${ref ? "；它完成任务后会用 zpi_send 回报本会话" : ""}。pane 闲置 ${cfg.idleTimeoutMinutes} 分钟后自动回收（keep- 前缀豁免），pi 会话文件保留可恢复。`,
				);
				return { content: [{ type: "text", text: lines.join("\n") }] };
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `zpi_open failed: ${err instanceof Error ? err.message : String(err)}` },
					],
				};
			}
		},
	});

	// --- zpi_close (available in every session) ---------------------------------

	pi.registerTool({
		name: "zpi_close",
		label: "关闭 zpi 会话",
		// 目标匹配机制（亲生 vs 手动 π 标题）不进描述：找不到时错误文本会列出全部可选目标
		description: "关闭一个 agent 会话的 pane；历史保留，可 pi --session-id 恢复。",
		promptSnippet: "关闭某个 pi 会话的 zellij pane",
		parameters: Type.Object({
			target: Type.String({ description: "要关闭的会话名或 session id" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const zs = cfg.zellijSession;
			const t = params.target.trim();
			const entries = loadRegistry();
			const entry = tryFindEntry(entries, t);
			const panes = await listPanes(zs);
			let paneId: string | undefined;
			if (entry) {
				if (!panes.some((p) => p.id === entry.paneId && p.type === "terminal")) {
					return {
						content: [
							{
								type: "text",
								text: `Pane ${entry.paneId} of "${entry.name}" 已不存在；会话文件可恢复: pi --session-id ${entry.sessionId}`,
							},
						],
					};
				}
				paneId = entry.paneId;
			} else {
				const manual = findManualPiPane(panes, t);
				if (!manual) {
					return {
						content: [
							{ type: "text", text: `没有匹配 "${t}" 的会话。当前: ${domainSummary(panes, entries)}` },
						],
					};
				}
				paneId = manual.id;
			}

			// Closing our own pane: go through graceful shutdown instead.
			const own = process.env.ZELLIJ_PANE_ID ? normalizePaneId(process.env.ZELLIJ_PANE_ID) : null;
			if (own && paneId === own) {
				if (entry && !entry.closedAt) {
					entry.closedAt = Date.now();
					entry.closedReason = "self-closed via zpi_close";
					removeHeartbeat(entry.sessionId);
					saveRegistry(entries);
				}
				const shutdown = (ctx as { shutdown?: () => void }).shutdown;
				if (typeof shutdown === "function") shutdown.call(ctx);
				else await zj(["-s", zs, "action", "close-pane", "-p", paneId]);
				return { content: [{ type: "text", text: "已请求优雅关闭本会话。" }] };
			}

			await zj(["-s", zs, "action", "close-pane", "-p", paneId]);
			const still = (await listPanes(zs)).some((p) => p.id === paneId);
			if (still) {
				return { content: [{ type: "text", text: `关闭 pane ${paneId} 失败（pane 仍在）。` }] };
			}
			if (entry && !entry.closedAt) {
				entry.closedAt = Date.now();
				entry.closedReason = "closed via zpi_close";
				removeHeartbeat(entry.sessionId);
				saveRegistry(entries);
			}
			return {
				content: [
					{
						type: "text",
						text: entry
							? `已关闭 "${entry.name}"。之后可用 pi --session-id ${entry.sessionId} 恢复。`
							: `已关闭手动会话 pane ${paneId}。`,
					},
				],
			};
		},
	});

	// --- /zpi command ------------------------------------------------------------

	pi.registerCommand("zpi", {
		description: "zpi agent panes: 默认显示状态；/zpi tidy 整理 tab 与 pane",
		handler: async (args, ctx) => {
			if (args.trim() === "tidy") {
				ctx.ui.notify(await tidy(cfg), "info");
			} else {
				ctx.ui.notify(await statusText(cfg), "info");
			}
		},
	});

	// --- idle watchdog: every interactive session -------------------------------

	let watchdogTimer: ReturnType<typeof setInterval> | null = null;
	let ticking = false;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const c = loadConfig();
		const tick = async () => {
			if (ticking) return;
			ticking = true;
			try {
				await watchdogTick(c);
			} finally {
				ticking = false;
			}
		};
		watchdogTimer = setInterval(() => void tick(), Math.max(1, c.checkIntervalMinutes) * 60_000);
		void tick();
	});

	pi.on("session_shutdown", async () => {
		if (watchdogTimer) clearInterval(watchdogTimer);
		if (subscriber) subscriber.kill("SIGTERM");
	});
}
