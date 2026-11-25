# my-workspace

个人工作区配置，一个仓两块内容，`./install.sh` 一键装：

- **pi/** —— [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的扩展、技能、搜索工具配置
- **zellij/** —— zellij 终端复用器配置

这不是（只是）pi 插件仓：整个仓同时注册为一个 pi package（见 `package.json`，指向 `pi/extensions`、`pi/vendor/pi-web-search-lite`、`pi/skills`），zellij 部分由 install.sh 安装到 `~/.config/zellij/`。

## 安装

```bash
git clone https://github.com/CrimsonDump/my-workspace.git ~/my-workspace
cd ~/my-workspace && ./install.sh
```

install.sh 幂等、可重复运行，做的事：

1. `pi install <本仓绝对路径>` —— extensions + skill-creator + vendor 的 pi-web-search-lite 注册为本地 package。本地 package 从仓库路径直接加载、不拷贝，改完代码 `/reload` 即生效。
2. pi-web-search-lite（已 vendor 进本仓，见下）：若有旧的 `npm:pi-web-search-lite` 安装则自动移除（避免重复注册工具）；`npm install` 装 undici；写入 / 对齐配置。
3. zpi 运行时配置：`~/.pi/agent/zpi/config.json` 不存在时写入模板（`zellijSession=main` 等；已存在不动）。
4. pi 键位：`~/.pi/agent/keybindings.json` 软链到本仓 `pi/keybindings.json`（已有实体文件不动）。
5. zellij：已有 `~/.config/zellij/config.kdl` 先备份，再安装本仓版本和 `zellij_se.sh`；若检测到 zellij-claude-status（独立项目，不在本仓）就跑它的 `install.py` 把 Alt q 等注入回来。

装完一般还差一步：编辑 `~/.pi/agent/pi-web-search-lite/config.json`，填 DeepSeek key（或 `export DEEPSEEK_API_KEY`，环境变量优先于文件）、按机器填 proxy。

## pi

### 扩展（pi/extensions）

| 扩展 | 一句话 |
|---|---|
| [`auto-mem.ts`](./pi/extensions/auto-mem.ts) | 跨会话持久记忆：按项目 cwd 分桶的 MEMORY.md 注入 system prompt，`/memory` 开整理会话 |
| [`expand-tool-output.ts`](./pi/extensions/expand-tool-output.ts) | TUI 里把截断的工具输出原地展开到全量 |
| [`zpi/`](./pi/extensions/zpi/) | 把子 pi 会话编排进专属 zellij 会话：`zpi_open` / `zpi_send` / `zpi_list` / `zpi_close`，idle 自动回收，会话文件保留可恢复 |
| [`what-model-sees/`](./pi/extensions/what-model-sees/) | `/seen`：站在模型视角查看发出去的一切——system prompt、工具声明、完整对话、原始 wire payload，带 diff |

注意：**auto-mem 依赖 zpi**（`/memory` 读 zpi 配置并用 zellij 开 pane）；单独取用 auto-mem 时记忆注入不受影响，但 `/memory` 不可用。
zpi 的运行时配置 `~/.pi/agent/zpi/config.json`（`zellijSession=main` 等，模板在 `pi/zpi/config.template.json`，install.sh 首装写入）；其余运行时状态都在仓库之外（`~/.pi/agent/zpi/registry.json`、`~/.pi/agent/memory/`、`<project>/.pi/what-model-seens/`）。

### 技能（pi/skills）

- **skill-creator** —— 创建 / 迭代 / 评测 skill 的通用技能，自包含，无工作相关内容。

### 键位（pi/keybindings.json）

`~/.pi/agent/keybindings.json` 软链到本仓的 `pi/keybindings.json`（pi 只从 agent 目录读键位，package 带不动）。目前一条：外部编辑器 `app.editor.external` → `Ctrl+K`——对齐本机 CC 实际键位（`~/.claude/keybindings.json` 自定义的 `ctrl+k: chat:externalEditor`；CC 官方默认是 `Ctrl+G` / `ctrl+x ctrl+e`，其中 `Ctrl+G` 会被 zellij 的 locked 模式拦截，pi 也不支持和弦）。副作用：pi 里 `ctrl+k` 原本的「删到行尾」被盖掉（app 动作优先；删到行首 `ctrl+u` 仍在）。改完 `/reload` 生效。

### pi-web-search-lite（pi/vendor/pi-web-search-lite + pi/web-search-lite/config.template.json）

搜索（`web_search`）+ 抓网页（`web_fetch`）两件套。**源码 vendor 在本仓**（上游 [setwhite/pi-extensions](https://github.com/setwhite/pi-extensions) @ 0.14.0，MIT），本地改动见 [`pi/vendor/pi-web-search-lite/LOCAL-CHANGES.md`](./pi/vendor/pi-web-search-lite/LOCAL-CHANGES.md)：① 反爬拦截页（微信「环境异常」/ Cloudflare 质询页等）判为提取失败，让链条顺延 deepseek / jina（它们从服务端出口抓，本地被拦时往往能过）；② `<title>` 为空时标题回退 og:title / 微信 `var msg_title`。不再 `pi install npm:pi-web-search-lite`（install.sh 会自动移除旧安装）。

运行时依赖 undici 声明在仓根 `package.json`，install.sh 会 `npm install`（本地 package 的依赖不经 pi 安装）。

配置在 `~/.pi/agent/pi-web-search-lite/config.json`，本仓的推荐值：

- `provider`：deepseek
- `fetch.extractors`：`html → deepseek → jina`（html 被反爬拦住时，deepseek / jina 从服务端出口兜底）
- `fetch.minChars`：50
- `userAgent`：移动端浏览器 UA——**微信文章链接按 UA 的 mobile/desktop 信号放行**，桌面 UA / 非浏览器 UA 都会拿到验证页（2026-11-25 实测；副作用是其他站会拿到移动版页面，对正文提取无碍）
- `proxy`：出网受限的机器填代理（如 `http://127.0.0.1:10010`），直连机器留 `""`

install.sh 首次安装写入模板；已有配置时对齐 fetch 两项 + userAgent，key / proxy 不动。

## zellij

`zellij/config.kdl` 基于官方默认（`clear-defaults=true` 全量重写），定制点：

- **Alt 系快捷键**（中文输入法下 Ctrl 前缀后的单字母会被吃掉，常用动作都绑 Alt）：`Alt 1..9` 切 tab、`Alt i/o` 上/下 tab（MoveTab 挪到 tab 模式 `i/o`）、`Alt m` 全屏、`Alt x` 关 pane、`Alt n` 开 pane、`Alt f` 浮窗、`Alt hjkl`/方向键移焦点
- **删掉的官方默认绑定**：`Alt [ / ]`（鼠标上报的 ESC[ 前缀误触发）、scroll 模式的 `[ ] m c`、session 模式的 `[ ] f l`、pane 模式的 `;` 和 `Shift f`
- **选项**：`auto_layout false`、`advanced_mouse_actions false`、`pane_frame_style "titles"`、`scrollback_editor` 用 `zellij_se.sh`（先把 scrollback 拷到固定路径 `/tmp/scrollback` 再用 vim 打开）
- **load_plugins**：显式保留官方的 `zellij:link`（0.44+ 点击 pane 里的文件路径直接打开）。定义整个块会替换官方默认，所以必须带上。

claude-status 插件不在本仓（独立项目）；install.sh 装完基础配置后若检测到它，会自动重新注入。zellij 配置改动会热载，但 `load_plugins` / `plugins` 别名的改动需重启会话。

## 环境要求

- pi coding agent（扩展 API 随版本演进，建议较新版本）+ Node
- zellij 0.45+（`pane_frame_style` 等选项）
