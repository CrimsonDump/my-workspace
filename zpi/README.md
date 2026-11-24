# zpi — pi sessions as zellij panes

把子 pi 会话编排进专属 zellij 会话（默认 `pi-agents`）：开新会话派活、
随时 attach 观察/接手、会话间互发消息、idle 自动回收。

## 工具（所有会话可用，包括 zpi 子会话自己）

| 工具 | 作用 |
|---|---|
| `zpi_open` | 在 pi-agents 里开 pane 跑新 pi，下发任务；每 tab 最多 8 个 pane，满了自动开新 tab；嵌套深度受 maxDepth 限制 |
| `zpi_send` | 消息注入。`target`（会话名/session id，必填）→ 发给该会话（zpi 亲生或 pi-agents 里的手动 pi 会话，含 shell 开的 "π - 名字" 和 `zellij run -- pi` 命令式两种形态）；`target="parent"` → 回话给派生本会话的会话（经 ZPI_PARENT 环境变量，无需名字）。目标运行中投递时智能中断：无工具在执行则先 Escape 打断当前轮、消息立即生效；有工具在执行则不中断、steering 等本轮安全落地 |
| `zpi_list` | 列出 pi-agents 管理域内全部会话：`[zpi]` 亲生（idle/任务/resume 句柄）、`[手动]` shell 开的、`[手动·命令式]` 直启的、`[其他]` 非 pi pane |
| `zpi_close` | 关闭域内任意 pi 会话的 pane（含手建的；关自己时走优雅退出）。pi 会话文件保留，可 `pi --session-id <id>` 恢复 |
| `/zpi` `/zpi tidy` | 状态一览 / 手动整理：堆叠各 tab pane、顺序重命名 tab、关闭空 tab |

## 生命周期

- pane 用 `zellij run -c --close-on-exit` 创建：**pi 进程退出 → pane 自动关**
- **正常收尾**：子会话完成任务后用 `zpi_send(target="parent")` 回报派生它的会话（spawn 时任务尾部自动追加这个约定）；输出写进任务指定的文件，消息里引用路径。**没有 done 工具**——回报后 pane 自然闲置，交给超时回收
- **回收机制**：idle 判定（双信号）：`zellij subscribe` 渲染事件（流式输出/spinner/用户打字都算）
  + 子会话心跳文件（`agent_start` / `agent_end` / `tool_execution_start` / `tool_call` / `tool_result` / `tool_execution_end` 时写入 `~/.pi/agent/zpi/hb/`，内容为最近事件名——zpi_send 靠它判断目标是否处于工具执行窗口，从而决定能否安全中断）
- 超过 `idleTimeoutMinutes`（默认 60 分钟）无活动 → watchdog 关闭 pane；
  名字带 `keep-` 前缀的豁免（idle 关闭豁免）；pi 会话文件始终保留可恢复，完成后 1 小时内也可 attach 进去继续追问
- watchdog 只在顶层交互会话（非 zpi 子会话、tui 模式）里运行；registry 全局共享，
  顶层的 watchdog 照看所有后代（子、孙……）。没有顶层会话存活时暂停回收，pane 照常跑

## 管理域与边界

- **手动动作（open/send/close/tidy）覆盖管理域（config 的 zellijSession）里所有 pi 会话**，不管谁生的
- **自动动作（idle watchdog 回收）只碰 zpi 亲生会话**（registry 在案的）；手动会话永远不自动收，归用户管
- 手动会话两种形态都识别：shell 里开 `pi`（标题 "π - 名字 - 目录"）和 `zellij run -- pi ...` 直启（标题即命令行）

## 嵌套

- 每个 zpi 子会话可以再 `zpi_open` 孙会话、`zpi_close` 任意会话——权限对称
- 防失控：环境变量 `ZPI_DEPTH` 逐层 +1，达到 `maxDepth`（默认 3）后拒绝再开；设 0 不限

## 配置 `~/.pi/agent/zpi/config.json`

```json
{
  "zellijSession": "pi-agents",
  "maxPanesPerTab": 8,
  "idleTimeoutMinutes": 60,
  "checkIntervalMinutes": 5,
  "keepPrefix": "keep-",
  "maxDepth": 3
}
```

## 已知的 zellij 0.45.1 坑（代码已防御）

- CLI 失败也返回退出码 0，且可能打印不存在的 pane id → 所有变更后用 `list-panes` 复核
- `run --no-focus` 跨会话静默失败 → 不使用；新增 pane 时若用户正 attached 可能跳焦
- `write-chars` 不带 `-p` 会写进焦点 pane（新会话里是浮动的 About 面板）→ 一律显式 pane id
- 新 zellij 会话自带浮动欢迎面板 → 创建后 `hide-floating-panes`

## 其他注意

- 消息按"单行按键注入"实现：换行会被折叠为 `⏎`，长内容请写文件后在消息里引用路径
- 注入会写进目标编辑器当前内容：如果父会话编辑器里有未发送的半截草稿，回报消息会和它拼在一起提交（上面 "j[zpi完成]…" 就是这个现象）——等待回报时别留草稿
- 多个编排会话共用 registry，atomic write 防损坏；watchdog 可能并发，重复关闭会被复核拦下
- zellij 会话被 kill 后 pane id 全变：registry 在每次 watchdog tick 时对账自愈；
  子 pi 会话用固定 `--session-id`，随时可恢复
- 用户在终端手动开的 pi 无法"搬进" pi-agents（进程不能迁移 tty）；
  要让新会话出生即在 pane 里，请通过任意运行中的 pi 调 `zpi_open`
