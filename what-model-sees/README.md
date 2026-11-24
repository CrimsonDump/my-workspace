# what-model-sees

站在模型的角度，看到塞给模型的**所有东西**：system prompt（含各级 AGENTS.md / SYSTEM.md）、
工具与 MCP 声明、完整对话（包括 hook 注入的消息、compaction 摘要、`!` 命令输出）、
以及发给 provider 的原始 wire payload。

## 安装

```bash
# 全局安装（所有项目可用）
mkdir -p ~/.pi/agent/extensions
cp -r what-model-sees ~/.pi/agent/extensions/

# 或项目本地（需项目信任）
mkdir -p .pi/extensions
cp -r what-model-sees .pi/extensions/

# 或临时加载
pi -e ./what-model-sees/index.ts
```

无第三方依赖，只用 pi 内置模块和 Node 标准库。改动代码后用 `/reload` 热重载。

## 用法

| 命令 | 作用 |
|---|---|
| `/seen` | 全屏查看器，打开最近一次请求 |
| `/seen 12` | 查看第 12 次请求 |
| `/seen diff` | 直接打开 Diff 标签 |
| `/seen export [n]` | 导出 HTML（并在 TUI 模式下用浏览器打开） |
| `/seen on` / `off` | 开/关捕获（状态持久化，重启后保留） |
| `/seen dir` | 显示快照落盘目录 |

查看器按键：

```
h j k l          h/l 切标签，j/k 滚动（在 消息/工具 标签上移动光标）；方向键同样有效
Ctrl+d / Ctrl+u  半页滚动（vim 风格）
/                搜索当前标签内容（大小写不敏感，匹配黄底高亮），Enter 执行
n / N            下一个 / 上一个匹配（当前匹配行有 ▸ 标记）
Enter            查看光标处 消息/工具的 wire JSON（provider 实际收到的格式）
, . 或 [ ]       上一个 / 下一个请求快照
,e / e           导出当前请求的 HTML
q / Esc          退出（详情视图中先返回列表）
```

页头显示 `请求 #N（3/60）`，括号内是当前快照在本进程捕获列表中的位置。

## 总览里的性能行

```
TPS 42.5 tok/s · TTFT 0.87s · E2E 3.93s / 902 tok
```

- **TTFT** — 载荷发出到首个流式事件（含网络与服务端排队），单位秒
- **TPS** — 输出 token ÷ 纯生成窗口（不含 TTFT）
- **E2E** — 载荷发出到流结束的总耗时；`/ 902 tok` 是本次输出 token 数
- 缺数据的字段自动省略，不显示占位符

## reload 前后的对比

捕获存储随扩展实例重建，所以 `/reload` 后内存里没有“上一次”。插件会在
`session_start` 时从磁盘加载**同一会话**最新的快照作为基线（按 `sessionId` 匹配，
不会误用其它会话的文件），因此 reload 后的第一次请求仍能对比：

```
较上次 #82（reload 前）：1 次新提问 · 上下文 +285 tok（7.0k → 7.3k）
缓存前缀  系统提示 已变（3+/1− 行） · 工具声明 未变
```

注意：`/reload` 本身不改变提示词——它只是重新读取同样的输入源。只有输入变了
（AGENTS.md 被编辑、扩展注册的工具/提示片段变化、设置变化）才会出现“已变”。

## 标签总览

`1 总览 · 2 System · 3 工具 · 4 消息 · 5 差异 · 6 来源`（顺序与原版一致）

- **消息**是两级结构：顶层是 **payload 列表**（本进程全部请求，按 run 分组，每行 = 一次发给 provider 的请求：`#序号 r run/t turn · 消息数 · 增减 · 触发内容（问:新提问 / ⚙工具往返 / ✦注入）· 耗时·输出token`）；**Enter** 进入该次请求的消息列表，**Esc** 返回。会话 = 逐次全量重放，所以消息数单调增长。
- 消息列表（第二级）保留 pi 语义视图（能看到注入来源：`custom✦` = 扩展/hook 注入等）；**Enter 详情显示的却是 wire JSON** —— 从本次 payload 里捞出的、实际发给 provider 的那条消息，不是重新推导的。
- 列表第一行是伪条目 **`#T 完整 wire 请求`**：Enter 展示发给 provider 的整份 JSON 文档（信封 + messages + tools，即原 Payload 标签的全部内容）；system prompt 就是其中 `messages[0].content`，tools 与 messages 平级。- 无 wire 对应的消息（anthropic 的 system 顶层参数、空补丁）会在详情里说明原因；仅存在于 wire 的合成消息（compat 桥接）计入头部计数。
- **工具** Enter 详情同样展示 wire 格式的完整声明（含参数 schema）。

每次 provider 请求（`before_provider_request`）产生一个快照：

- **wire payload** — 发给 provider 的实际 JSON（脱敏后），唯一真相
- **语义视图** — `context_with_system` 的完整消息列表，保留注入来源
  （`custom✦类型` = 扩展/hook 注入、`bashExecution` = `!` 命令、
  `compactionSummary`、中途 system patch 等）
- **system prompt 拆解** — `before_agent_start.systemPromptOptions`：
  各级上下文文件路径与大小、技能、sections、append/force/custom prompt
- **工具元数据** — 来源（builtin / 扩展 / MCP server）、schema 大小
- **响应信息** — HTTP 状态、usage（含 cache read/write、成本）、耗时与输出速度
  （首 token 延迟 / TTFT、生成速度 tok/s，见总览标签）

## 隐私与脱敏

- 内联 base64 图片替换为占位符（大小 + sha256 前 16 位）
- 键名匹配 `apiKey/token/secret/password/...` 的值替换为 `[redacted]`
- 快照落盘在 session 目录（或项目 `.pi/what-model-sees/`），**整个目录共保留最新 200 个**（不再按进程分别计数，`/reload` 不会累积）
- ⚠️ 快照仍包含完整对话与上下文文件内容，属于敏感数据，勿提交到仓库或外传

## 已知限制（v1）

TPS 统计：输出 token ÷ 生成窗口（首 token → 完成）；thinking 模型的 thinking token 计入输出 token。
非流式/失败后补全的响应退化为按总耗时计算；无消息事件的请求（嵌套模型调用、缓存预热）不计速度。

- 快照按进程计数；跨重启的历史请求请读磁盘上的 `request-<pid>-*.json`
- continuation 型 provider（如 Codex WebSocket）的 wire payload 可能只含增量；
  语义视图（消息标签）仍是完整的
- `before_agent_start` 的 prompt options 反映"当前 handler 链已应用的修改"，
  更晚加载的扩展仍可能改变最终 prompt —— 最终真相以 Wire 标签为准
