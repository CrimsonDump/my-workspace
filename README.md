# my-pi-extensions

我的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent)（`@earendil-works/pi-coding-agent`）扩展集。无第三方依赖，只用 pi 内置模块和 Node 标准库。

## 安装

```bash
git clone https://github.com/CrimsonDump/my-pi-extensions ~/.pi/agent/extensions
# 或项目本地：clone 到 <project>/.pi/extensions（需项目信任）
```

放在自动发现位置后可用 `/reload` 热重载。

## 插件

| 插件 | 形态 | 一句话 |
|---|---|---|
| [`auto-mem.ts`](./auto-mem.ts) | 单文件 | 跨会话持久记忆：按项目 cwd 分桶的 MEMORY.md 注入 system prompt，`/memory` 命令开整理会话（改过时 / 合并 / 下沉归档） |
| [`expand-tool-output.ts`](./expand-tool-output.ts) | 单文件 | TUI 里把截断的工具输出原地展开到全量 |
| [`zpi/`](./zpi/) | 目录 | 把子 pi 会话编排进专属 zellij 会话：`zpi_open` / `zpi_send` / `zpi_list` / `zpi_close`，idle 自动回收，会话文件保留可恢复 |
| [`what-model-sees/`](./what-model-sees/) | 目录 | `/seen`：站在模型视角查看发出去的一切——system prompt、工具声明、完整对话、原始 wire payload，带 diff |

## 注意

- **auto-mem 依赖 zpi**：`/memory` 会读 zpi 的 config 并用 zellij 开 pane。单独取用 auto-mem 时记忆注入不受影响，但 `/memory` 命令不可用。
- 各插件的**运行时状态都在本目录之外**（`~/.pi/agent/zpi/`、`~/.pi/agent/memory/`、`<project>/.pi/what-model-sees/`），本 repo 只含代码，clone 即用。

## 环境要求

- pi coding agent（扩展 API 随版本演进，建议用较新版本）
- zpi 需要 [zellij](https://github.com/zellij-org/zellij)
