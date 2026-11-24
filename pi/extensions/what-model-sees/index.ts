/**
 * what-model-sees — see exactly what the model sees.
 *
 * Captures every provider request pi sends (system prompt, AGENTS.md context
 * files, tool declarations, conversation, hook-injected messages, and the raw
 * provider payload), then lets you inspect it:
 *
 *   /seen            open the fullscreen viewer on the latest request
 *   /seen <n>        open request #n (this process)
 *   /seen diff       open the viewer on the diff tab
 *   /seen export [n] export request #n (default: latest) as HTML and open it
 *   /seen on|off     enable/disable capture (persists across restarts)
 *   /seen dir        show the disk capture directory
 *
 * Snapshots are sanitized: inline base64 images become placeholders and
 * secret-looking keys are redacted. See README.md for details.
 */
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptureStore, loadBaseline, readPersistedState } from "./capture.ts";
import { buildHtml } from "./html.ts";
import { SeenViewer } from "./viewer.ts";
import type { RequestSnapshot } from "./types.ts";

export default function (pi: ExtensionAPI) {
	const store = new CaptureStore();

	// -- capture wiring -------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Prefer the global session dir; fall back to the project config dir.
		const sessionDir = ctx.sessionManager.getSessionDir();
		store.persistDir = sessionDir ?? join(ctx.cwd, CONFIG_DIR_NAME, "what-model-sees");
		const sessionId = ctx.sessionManager.getSessionId();
		store.setSessionId(sessionId);
		const persisted = readPersistedState(ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>);
		if (persisted) store.enabled = persisted.enabled;
		// After /reload the in-memory store is empty: use the newest snapshot of
		// this same session from disk so the first request can still be diffed
		// against the state before the reload.
		if (store.enabled) {
			store.baseline = await loadBaseline(store.persistDir, sessionId);
		}
		// Older builds kept a "👁 seen N" status in the footer. Clear any leftover
		// once; capture state is visible through /seen itself.
		if (ctx.hasUI) ctx.ui.setStatus("seen", undefined);
	});

	pi.on("turn_start", async (event) => {
		store.setTurn(event.turnIndex);
	});

	pi.on("agent_start", async () => {
		store.nextRun();
	});

	pi.on("before_agent_start", async (event) => {
		store.stashPromptOptions(event.systemPromptOptions as never);
	});

	pi.on("context_with_system", async (event) => {
		store.stashContext(event.messages as unknown[]);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!store.enabled) return;
		store.beginRequest(event.payload, {
			model: ctx.model
				? {
						provider: ctx.model.provider,
						id: ctx.model.id,
						api: (ctx.model as { api?: string }).api,
						contextWindow: ctx.model.contextWindow,
					}
				: null,
			getAllTools: () => pi.getAllTools() as never,
			getActiveTools: () => pi.getActiveTools(),
		});
		// Never modify the payload: this extension is read-only.
	});

	pi.on("after_provider_response", async (event) => {
		if (store.enabled) store.attachStatus(event.status);
	});

	pi.on("provider_stream_event", async (event) => {
		if (store.enabled) store.attachMeta(event.provider, event.api, event.model);
	});

	// First assistant stream event ≈ time-to-first-token anchor.
	pi.on("message_start", async (event) => {
		if (!store.enabled) return;
		if ((event.message as { role?: string }).role === "assistant") store.markFirstToken();
	});

	pi.on("message_end", async (event) => {
		if (!store.enabled) return;
		const message = event.message as {
			role?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				totalTokens?: number;
				cost?: { total?: number };
			};
			provider?: string;
			api?: string;
			model?: string;
		};
		if (message.role !== "assistant") return;
		store.markCompleted();
		if (!message.usage) return;
		store.attachUsage(
			{
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				totalTokens: message.usage.totalTokens,
				costTotal: message.usage.cost?.total,
			},
			message.provider,
			message.api,
			message.model,
		);
	});

	// Response info (usage, HTTP status) arrives after the snapshot was first
	// written to disk — flush once the run settles and on shutdown.
	pi.on("agent_end", async () => {
		store.flush();
	});

	pi.on("session_shutdown", async () => {
		store.flush();
	});

	// -- export ---------------------------------------------------------------

	async function exportSnapshot(
		snapshot: RequestSnapshot,
		ctx: ExtensionCommandContext,
		open = true,
	): Promise<string | undefined> {
		try {
			const dir = snapshot.dir ?? store.persistDir;
			if (!dir) return undefined;
			await mkdir(dir, { recursive: true });
			const file = join(
				dir,
				`export-${String(snapshot.index).padStart(6, "0")}.html`,
			);
			await writeFile(file, buildHtml(snapshot, store.prevOf(snapshot)), "utf8");
			if (open && ctx.mode === "tui") {
				const opener =
					process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
				const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
				void pi.exec(opener, args).catch(() => {
					ctx.ui.notify(`已导出: ${file}`, "info");
				});
			}
			return file;
		} catch (error) {
			ctx.ui.notify(`导出失败: ${String(error)}`, "error");
			return undefined;
		}
	}

	// -- viewer ---------------------------------------------------------------

	async function openViewer(
		ctx: ExtensionCommandContext,
		startPos: number,
		startTab?: number,
	): Promise<void> {
		if (ctx.mode !== "tui") {
			// Non-TUI modes: fall back to HTML export.
			const latest = store.latest();
			if (!latest) {
				ctx.ui.notify("尚无捕获的请求", "warning");
				return;
			}
			const file = await exportSnapshot(latest, ctx, false);
			if (file) ctx.ui.notify(`已导出 HTML: ${file}`, "info");
			return;
		}
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				const viewer = new SeenViewer(
					{
						store,
						startPos,
						startTab,
						theme,
						rows: () => tui.terminal.rows ?? 40,
						fullscreen: true,
						onExport: (snapshot) => {
							void exportSnapshot(snapshot, ctx).then((file) => {
								if (file) ctx.ui.notify(`已导出: ${file}`, "info");
							});
						},
					},
					done,
				);
				return viewer;
			},
			// Fullscreen overlay: covers the transcript instead of sitting under it.
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			},
		);
	}

	// -- commands -------------------------------------------------------------

	const handleSeen = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const arg = args.trim();

		if (arg === "on" || arg === "off") {
			store.enabled = arg === "on";
			pi.appendEntry("wms-state", { enabled: store.enabled });
			ctx.ui.notify(`捕获已${store.enabled ? "启用" : "停用"}`, "info");
			return;
		}
		if (arg === "dir") {
			ctx.ui.notify(store.persistDir ?? "（未知）", "info");
			return;
		}
		if (store.snapshots.length === 0) {
			ctx.ui.notify(
				store.enabled ? "尚无捕获的请求 — 先发一条消息给模型" : "捕获已停用（/seen on 开启），且尚无快照",
				"warning",
			);
			return;
		}

		if (arg === "diff") {
			if (store.snapshots.length < 2) {
				ctx.ui.notify("只有 1 次请求，无 diff 可看", "warning");
				return;
			}
			await openViewer(ctx, store.snapshots.length - 1, 4); // 差异 tab（见 viewer.ts TABS 顺序）
			return;
		}

		if (arg === "export" || arg.startsWith("export ")) {
			const rest = arg.slice("export".length).trim();
			const snapshot = rest ? store.byNumber(Number.parseInt(rest, 10)) : store.latest();
			if (!snapshot || (rest && !Number.isFinite(Number.parseInt(rest, 10)))) {
				ctx.ui.notify(`未找到请求 #${rest}（本进程捕获范围 1-${store.lastIndex}）`, "warning");
				return;
			}
			const file = await exportSnapshot(snapshot, ctx);
			if (file) ctx.ui.notify(`已导出: ${file}`, "info");
			return;
		}

		if (/^\d+$/.test(arg)) {
			const n = Number.parseInt(arg, 10);
			const snapshot = store.byNumber(n);
			if (!snapshot) {
				ctx.ui.notify(`未找到请求 #${n}（本进程捕获范围 1-${store.lastIndex}；更早的请看磁盘快照）`, "warning");
				return;
			}
			await openViewer(ctx, store.snapshots.indexOf(snapshot));
			return;
		}

		if (arg !== "") {
			ctx.ui.notify("用法: /seen [n | diff | export [n] | on | off | dir]", "warning");
			return;
		}
		await openViewer(ctx, store.snapshots.length - 1);
	};

	const completions = () => [
		{ value: "diff", label: "diff", description: "查看与上次请求的差异" },
		{ value: "export", label: "export", description: "导出 HTML" },
		{ value: "on", label: "on", description: "开启捕获" },
		{ value: "off", label: "off", description: "关闭捕获" },
		{ value: "dir", label: "dir", description: "显示快照目录" },
	];

	pi.registerCommand("seen", {
		description: "What the model sees — 检查发给模型的完整请求",
		getArgumentCompletions: (prefix: string) => {
			const filtered = completions().filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: handleSeen,
	});

	// Long alias for discoverability.
	pi.registerCommand("what-model-sees", {
		description: "同 /seen — 检查发给模型的完整请求",
		handler: handleSeen,
	});
}
