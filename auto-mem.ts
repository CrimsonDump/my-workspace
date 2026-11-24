/**
 * auto-mem — pi 跨会话持久记忆（Phase 1 + 2）
 *
 * 设计文档：~/auto-mem-design.md
 *
 * 每个 pi project（按启动 cwd）一个记忆桶 <agentDir>/memory/<bucket>/：
 *   MEMORY.md   活跃记忆，全文注入 system prompt 的 <memory> 段（cap：默认 20 行 / 4KB）
 *   ARCHIVE.md  下沉历史，不注入，append-only
 *
 * Phase 1：桶解析、<memory> 段注入（日期 / 指导 / 正文 / cap 截断 / 接近上限提示）、
 *          promptGuidelines 指针。
 * Phase 2：/memory 整理命令（zellij pane 开新会话：改过时 / 合并重复 / 下沉 / 升级提案）、
 *          超限自动 spawn + pending 标记防抖。
 * Phase 3（未做，默认关）：agent_end 背景抽取。
 *
 * 配置（settings.json 顶层 "autoMem" 键，全部可省略）：
 *   { "enabled": true, "maxLines": 20, "maxBytes": 4096, "autoReview": true }
 *
 * zellij 集成：整理会话开在 zpi 配置的 zellij 会话里（~/.pi/agent/zpi/config.json 的
 * zellijSession，缺省 main）。该 pane 不进 zpi 的 registry，不会被闲置回收；用
 * `run -c`（close-on-exit），review 的 pi 退出后 pane 自行关闭。
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRYPOINT = "MEMORY.md";
const PENDING_FLAG = ".review-pending";
const PENDING_TTL_MS = 6 * 60 * 60 * 1000; // 标记超过 6h 视为陈旧（review 中途被杀），允许重开
const REVIEW_ENV = "PI_AUTO_MEM_REVIEW"; // 整理会话自身置 1，其 tool_result 不再触发自动 spawn
const PANE_NAME = "memory-review";

/**
 * 桶名：与 pi sessions 同款公式（--path-with-dashes--），
 * memory/<bucket> 与 sessions/<bucket> 可以肉眼对上号。
 */
function bucketFor(cwd: string): string {
  const b = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${b || "root"}--`;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

interface AutoMemConfig {
  enabled: boolean;
  maxLines: number;
  maxBytes: number;
  autoReview: boolean;
}

function loadConfig(pi: ExtensionAPI): AutoMemConfig {
  const raw =
    (pi.getSettings() as { autoMem?: Partial<AutoMemConfig> }).autoMem ?? {};
  return {
    enabled: raw.enabled !== false,
    maxLines:
      typeof raw.maxLines === "number" && raw.maxLines > 0
        ? Math.floor(raw.maxLines)
        : 20,
    maxBytes:
      typeof raw.maxBytes === "number" && raw.maxBytes > 0
        ? Math.floor(raw.maxBytes)
        : 4096,
    autoReview: raw.autoReview !== false,
  };
}

// ---------------------------------------------------------------------------
// 读取与注入（Phase 1）
// ---------------------------------------------------------------------------

function localDate(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf-8");

interface MemoryState {
  content: string; // 注入的正文（可能被截断）
  lineCount: number; // 原始行数
  byteCount: number; // 原始字节数
  nearLimit: boolean; // ≥80% 上限
  truncated: boolean; // 超限已截断
}

function readMemory(file: string, cfg: AutoMemConfig): MemoryState {
  let raw = "";
  try {
    raw = readFileSync(file, "utf-8").replace(/\r\n/g, "\n").trimEnd();
  } catch {
    raw = ""; // 不存在 / 读不了 → 当空
  }
  if (!raw.trim()) {
    return { content: "", lineCount: 0, byteCount: 0, nearLimit: false, truncated: false };
  }
  const lines = raw.split("\n");
  const lineCount = lines.length;
  const byteCount = byteLen(raw);
  const truncated = lineCount > cfg.maxLines || byteCount > cfg.maxBytes;
  const nearLimit =
    !truncated &&
    (lineCount >= Math.ceil(cfg.maxLines * 0.8) ||
      byteCount >= Math.ceil(cfg.maxBytes * 0.8));

  let content = raw;
  if (truncated) {
    // 先按行截，再按字节从尾部整行回退（不在行中间切）
    let kept = lines.slice(0, cfg.maxLines);
    let used = kept.reduce((n, l) => n + byteLen(l) + 1, 0);
    while (used > cfg.maxBytes && kept.length > 0) {
      used -= byteLen(kept[kept.length - 1] ?? "") + 1;
      kept = kept.slice(0, -1);
    }
    content = kept.join("\n");
  }
  return { content, lineCount, byteCount, nearLimit, truncated };
}

function buildSection(
  cfg: AutoMemConfig,
  memDir: string,
  sessionsDir: string,
  mem: MemoryState,
): string {
  const L: string[] = [];
  L.push("# Auto Memory");
  L.push("");
  L.push(`今天：${localDate()}。你有跨会话的持久记忆，目录：\`${memDir}\`。`);
  L.push("读写用内置 write / edit 工具（write 会自动创建父目录，不要 mkdir / ls 确认）。");
  L.push("");
  L.push("## 什么时候记");
  L.push('- 用户明确说"记住 / 以后都 / 别再…"：立即记');
  L.push('- 用户纠正你的做法，或明确认可一个非显然的做法（"对，就这样"）：记');
  L.push('- 了解到用户的偏好、知识边界（"这块我不熟"）：记');
  L.push("- 项目里进行中的事、决策及其动机、排期——无法从代码和 git 推导的：记");
  L.push("- 外部系统的位置和用途（看板、dashboard、群）：记");
  L.push("");
  L.push("## 什么不要记（用户明确要求记也先问：哪部分是 surprising 的）");
  L.push("- 代码结构、约定、架构、文件路径——读代码就有");
  L.push("- git 历史、谁改了什么——git log 权威");
  L.push("- 修过的 bug 和解法——修复在代码和 commit message 里");
  L.push("- AGENTS.md / CLAUDE.md 已写明的事");
  L.push("- 只在本会话有意义的临时状态");
  L.push("");
  L.push("## 条目格式");
  L.push("- 默认单行：`- **标题** (YYYY-MM-DD): 内容。`；");
  L.push('  仅"不解释会做错"的规则条目补 `**Why:**` / `**How to apply:**`');
  L.push(`  （全文上限仅 ${cfg.maxLines} 行，省着用）；review 确认过仍成立的追加 \`确认 YYYY-MM-DD\``);
  L.push("- 相对日期转绝对日期；写前先查重（更新旧条目优于新增重复）；发现过时就地改或删");
  L.push("");
  L.push("## 指令文件边界");
  L.push("各级 AGENTS.md / AGENTS.override.md / CLAUDE.md / SYSTEM.md 是用户维护的指令文件，默认不要修改。");
  L.push("想沉淀的东西写到 MEMORY.md。仅当用户在本会话明确要求修改指令文件时才改，改完明说改了什么。");
  L.push("");
  L.push("## 想不起来时");
  L.push("- 上方即全部活跃记忆。历史下沉在同目录 ARCHIVE.md（不进上下文，需要时 grep）。");
  L.push(`- 最后手段：grep \`${sessionsDir}/\` 下的会话 jsonl（窄词，别整读）。`);
  L.push("");
  L.push("## MEMORY.md 当前内容");
  L.push("");
  if (!mem.content) {
    L.push("（暂无记忆）");
  } else {
    L.push(mem.content);
    if (mem.nearLimit) {
      L.push("");
      L.push(
        `> 接近上限（${mem.lineCount}/${cfg.maxLines} 行）。写新条目前先合并、删过时的，或把长期不碰的下沉到 ARCHIVE.md（append）。`,
      );
    }
    if (mem.truncated) {
      L.push("");
      L.push(
        `> ⚠️ 已截断（${mem.lineCount} 行 / ${mem.byteCount}B，超上限 ${cfg.maxLines} 行 / ${cfg.maxBytes}B）。` +
          "请当场整理或运行 /memory：合并重复、删过时条目、长期不碰的下沉 ARCHIVE.md。",
      );
    }
  }
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 整理会话（Phase 2）：/memory 命令 + 超限自动 spawn
// ---------------------------------------------------------------------------

function zpiZellijSession(): string {
  try {
    const cfg = JSON.parse(
      readFileSync(join(getAgentDir(), "zpi", "config.json"), "utf-8"),
    ) as { zellijSession?: string };
    if (typeof cfg.zellijSession === "string" && cfg.zellijSession.trim()) {
      return cfg.zellijSession;
    }
  } catch {
    /* 没有 zpi 配置 → 用默认 */
  }
  return "main";
}

function zj(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn("zellij", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => res({ code: -1, stdout: out, stderr: String(e) }));
    child.on("close", (code) => res({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

async function zellijSessionExists(name: string): Promise<boolean> {
  const r = await zj(["list-sessions", "--short", "--no-formatting"]);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .includes(name);
}

async function paneExists(zs: string, name: string): Promise<boolean> {
  const r = await zj(["-s", zs, "action", "list-panes"]);
  return r.stdout.split("\n").some((l) => {
    const m = l.match(/^(\S+)\s{2,}(\S+)\s{2,}(.*)$/);
    return m !== null && m[2] === "terminal" && m[3].trim() === name;
  });
}

/** 在 zpi 的 zellij 会话里开一个 pane 跑整理 pi 会话（spawn 模式抄 zpi，实测可用） */
async function spawnReviewSession(
  zs: string,
  cwd: string,
  prompt: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!(await zellijSessionExists(zs))) {
      await zj(["attach", zs, "--create-background", "--", "sleep", "infinity"]);
      if (!(await zellijSessionExists(zs))) {
        return { ok: false, error: `zellij 会话 "${zs}" 不存在且创建失败` };
      }
      await zj(["-s", zs, "action", "hide-floating-panes"]);
    }
    const r = await zj([
      "-s", zs,
      "run",
      "-n", PANE_NAME,
      "--cwd", cwd,
      "-c", // close-on-exit：review 的 pi 退出后 pane 自行关闭
      "--",
      "/usr/bin/env", // 防止 PATH 里同名脚本截胡（zpi 同款教训）
      `${REVIEW_ENV}=1`,
      "pi",
      "--name", PANE_NAME,
      "--",
      prompt,
    ]);
    if (r.code !== 0) {
      return { ok: false, error: `zellij run 退出码 ${r.code}: ${r.stderr.trim().slice(0, 200) || "无输出"}` };
    }
    // zellij 退出码不可靠（phantom pane id），实测 pane 是否真的出现了
    for (let i = 0; i < 10; i++) {
      if (await paneExists(zs, PANE_NAME)) return { ok: true };
      await new Promise((res) => setTimeout(res, 300));
    }
    return { ok: false, error: "pane 未出现（zellij 报成功但 3 秒内无 memory-review pane）" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function pendingFlagPath(memDir: string): string {
  return join(memDir, PENDING_FLAG);
}

/** 防抖标记是否新鲜（存在且 < TTL） */
function pendingIsFresh(memDir: string): boolean {
  try {
    const st = statSync(pendingFlagPath(memDir));
    return Date.now() - st.mtimeMs < PENDING_TTL_MS;
  } catch {
    return false;
  }
}

function setPending(memDir: string): void {
  try {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(pendingFlagPath(memDir), new Date().toISOString());
  } catch {
    /* 标记写不进去就裸跑，最多多开一个 review */
  }
}

function clearPending(memDir: string): void {
  try {
    unlinkSync(pendingFlagPath(memDir));
  } catch {
    /* 本来就没有 */
  }
}

/** notify 的安全包装：print/JSON 模式没有 UI，退到 stderr */
function notify(
  ctx: { hasUI: boolean; ui: { notify: (m: string, l: "info" | "warn" | "error") => void } },
  msg: string,
  level: "info" | "warn" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(msg, level);
  } else {
    console.error(`[auto-mem] ${msg}`);
  }
}

function buildReviewPrompt(
  cfg: AutoMemConfig,
  cwd: string,
  memDir: string,
  sessionsDir: string,
  trigger: string,
): string {
  const today = localDate();
  const memFile = join(memDir, ENTRYPOINT);
  return `# Memory Review（${trigger}）

你在整理 pi 的持久记忆。工作目录：${cwd}。今天：${today}。

- 活跃记忆：${memFile}（上限 ${cfg.maxLines} 行 / ${cfg.maxBytes}B；内容也注入在你 system prompt 的 <memory> 段，但以读文件为准）
- 下沉历史：${join(memDir, "ARCHIVE.md")}（不存在则本轮新建）
- 本目录历史会话：${sessionsDir}/ 下的 *.jsonl（需要证据时 grep 窄词，别整读；排除刚创建的那份）
- 各级 AGENTS.md / CLAUDE.md 已在你的上下文里（project_context），升级提案先对照它们避免重复

先读 MEMORY.md（和 ARCHIVE.md），再按下面四步整理。a / b / d 直接落盘；c 只出提案。

## a. 改过时（直接落盘）
按日期升序逐条判断"还成立吗"（裸日期 / 最早"确认"日期的优先）：
- 过时或错误：能修正就改，彻底失效就删
- 仍成立：行内追加 \`确认 ${today}\`（已有更早确认日期的更新为今天）
需要证据时：grep 最近会话 jsonl、读代码、git log。

## b. 合并重复（直接落盘）
同主题多条合并为一条：日期取最新，仍有价值的旧信息并入正文。

## c. 升级提案（只出提案，禁止落盘，等用户批准）
逐条评估是否该离开 MEMORY.md，列出提案清单（编号、内容 → 去向、理由）：
- 反复出现、稳定的用户偏好 → ~/.claude/CLAUDE.md 的合适章节（用户级，CC 和 pi 都加载它）
- 项目约定 / 规则 → ${join(cwd, "AGENTS.md")}（不存在可提议新建）
- 耐久的项目知识 → 项目 docs/（带日期）
- 外部系统指针 → 对应 skill（machines / colleagues / host-network 等，~/.pi/agent/skills/）
最后明确说："回复批准哪几条（如：批准 1、3），我再动手改对应文件。"用户批准后才可以写指令文件 / skill——这是唯一例外，改完明说改了什么。不批准的留在 MEMORY.md。

## d. 下沉（直接落盘）
长期没被确认、价值存疑但不舍得删的：
- 从 MEMORY.md 删除该条
- append 到 ARCHIVE.md 末尾（只 append，绝不改写已有内容）
纯占位 / 测试 / 无信息量的条目直接删，不要下沉。

## 完成动作
1. 输出变更摘要：改 N 条 / 并 N 条 / 下沉 N 条 / 提案 N 条（编号列出来等批准）
2. 删除防抖标记：${pendingFlagPath(memDir)}（存在的话）
3. 复查 MEMORY.md ≤ ${cfg.maxLines} 行 / ${cfg.maxBytes}B；仍超就再紧凑一轮（优先下沉）

若 MEMORY.md 为空：说明情况、删除防抖标记、结束，不做其他动作。`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const cfg = loadConfig(pi);
      if (!cfg.enabled) return;

      const agentDir = getAgentDir();
      const cwd = ctx.cwd;
      const bucket = bucketFor(cwd);
      const memDir = join(agentDir, "memory", bucket);
      const sessionsDir = join(agentDir, "sessions", bucket);
      const mem = readMemory(join(memDir, ENTRYPOINT), cfg);

      event.systemPromptOptions.sections.memory = buildSection(
        cfg,
        memDir,
        sessionsDir,
        mem,
      );
      event.systemPromptOptions.promptGuidelines.push(
        "You have a persistent memory across sessions — see the <memory> section.",
      );
    } catch {
      // 记忆注入失败不影响会话
    }
  });

  // /memory：手动开整理会话
  pi.registerCommand("memory", {
    description: "整理本项目记忆：改过时、合并重复、下沉 ARCHIVE.md、出升级提案（zellij 开新会话）",
    handler: async (_args, ctx) => {
      try {
        const cfg = loadConfig(pi);
        if (!cfg.enabled) {
          notify(ctx, "auto-mem 已在 settings.json 里禁用", "warn");
          return;
        }
        const agentDir = getAgentDir();
        const cwd = ctx.cwd;
        const bucket = bucketFor(cwd);
        const memDir = join(agentDir, "memory", bucket);
        const sessionsDir = join(agentDir, "sessions", bucket);

        clearPending(memDir); // 手动触发总是开新的
        const zs = zpiZellijSession();
        const prompt = buildReviewPrompt(cfg, cwd, memDir, sessionsDir, "手动 /memory 触发");
        const r = await spawnReviewSession(zs, cwd, prompt);
        if (r.ok) {
          notify(ctx, `已开启 memory-review 整理会话（zellij: ${zs}）`);
        } else {
          notify(ctx, `整理会话开启失败：${r.error ?? "未知错误"}`, "error");
        }
      } catch (e) {
        notify(ctx, `auto-mem /memory 出错：${String(e)}`, "error");
      }
    },
  });

  // 超限自动 spawn：write/edit 落到本桶 MEMORY.md 后查 cap，超限且无新鲜防抖标记 → 开 review
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (process.env[REVIEW_ENV]) return; // 整理会话自身不再触发（避免 review 递归）
      const cfg = loadConfig(pi);
      if (!cfg.enabled || !cfg.autoReview) return;
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const target = (event.input as { path?: unknown; file_path?: unknown })?.path
        ?? (event.input as { file_path?: unknown })?.file_path;
      if (typeof target !== "string") return;

      const agentDir = getAgentDir();
      const cwd = ctx.cwd;
      const bucket = bucketFor(cwd);
      const memDir = join(agentDir, "memory", bucket);
      const memFile = join(memDir, ENTRYPOINT);
      if (resolve(target) !== resolve(memFile)) return;

      const mem = readMemory(memFile, cfg);
      if (!mem.truncated) return; // 只在超限时
      if (pendingIsFresh(memDir)) return; // 防抖：已有 review 在跑 / 刚跑过

      setPending(memDir);
      const zs = zpiZellijSession();
      const sessionsDir = join(agentDir, "sessions", bucket);
      const prompt = buildReviewPrompt(cfg, cwd, memDir, sessionsDir, "MEMORY.md 超限自动触发");
      const r = await spawnReviewSession(zs, cwd, prompt);
      notify(
        ctx,
        r.ok
          ? `MEMORY.md 超限，已在 zellij(${zs}) 开启 memory-review 整理会话`
          : `MEMORY.md 超限，自动整理会话开启失败（${r.error ?? "未知错误"}）；请手动运行 /memory`,
        r.ok ? "info" : "warn",
      );
      // spawn 失败也保留 pending（防重试风暴），TTL 6h 后自动解封
    } catch {
      // 不影响会话
    }
  });
}
