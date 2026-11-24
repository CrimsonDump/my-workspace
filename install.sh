#!/usr/bin/env bash
# my-workspace 一键安装：pi（extensions / skill-creator / pi-web-search-lite）+ zellij 配置。
# 幂等，可重复运行；已存在的配置会先备份。仓库放在哪个路径都行（pi package 按本仓绝对路径注册）。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }

# ---------- pi：本仓注册为本地 package（extensions + skill-creator） ----------
if command -v pi >/dev/null 2>&1; then
    say "pi：注册本仓为 package（$REPO）"
    pi install "$REPO"
else
    warn "没找到 pi 命令，先装 pi；装好后手动执行：pi install $REPO"
fi

# 本仓旧布局是把整个仓 clone 到 ~/.pi/agent/extensions；那里若还有实体内容会和 package 双重加载
if [ -d "$HOME/.pi/agent/extensions" ] && [ ! -L "$HOME/.pi/agent/extensions" ]; then
    warn "~/.pi/agent/extensions 还是实体目录。若里面是本仓旧 clone，移走或删掉以免双重加载：mv ~/.pi/agent/extensions ~/old-pi-extensions"
fi

# ---------- pi：pi-web-search-lite ----------
if command -v pi >/dev/null 2>&1; then
    if pi list 2>/dev/null | grep -q 'npm:pi-web-search-lite'; then
        say "pi：pi-web-search-lite 已在 package 列表"
    else
        say "pi：安装 npm:pi-web-search-lite（需能访问 npm registry，受限网络先配代理）"
        pi install npm:pi-web-search-lite || warn "安装失败；网络恢复后重跑本脚本即可"
    fi
fi

CFG="$HOME/.pi/agent/pi-web-search-lite/config.json"
if [ -f "$CFG" ]; then
    # 已有配置：只对齐 fetch 两项（本仓的推荐值），provider / proxy / apiKeys 一概不动
    if command -v node >/dev/null 2>&1; then
        node -e '
            const fs = require("fs"); const p = process.argv[1];
            const c = JSON.parse(fs.readFileSync(p, "utf8"));
            c.fetch = Object.assign({}, c.fetch, { extractors: ["html", "deepseek", "jina"], minChars: 50 });
            fs.writeFileSync(p, JSON.stringify(c, null, "\t") + "\n");
        ' "$CFG"
        say "pi-web-search-lite：fetch 已对齐（extractors html → deepseek → jina，minChars 50），其余配置未动"
    else
        warn "无 node，请手动把 $CFG 的 fetch 设为：{\"extractors\":[\"html\",\"deepseek\",\"jina\"],\"minChars\":50}"
    fi
else
    mkdir -p "$(dirname "$CFG")"
    cp "$REPO/pi/web-search-lite/config.template.json" "$CFG"
    say "pi-web-search-lite：已写入 $CFG"
    warn "还差一步：编辑 $CFG，填 deepseek 的 key（或 export DEEPSEEK_API_KEY，环境变量优先）、按机器填 proxy（直连机器留 \"\"）"
fi

# ---------- zellij ----------
ZD="$HOME/.config/zellij"
mkdir -p "$ZD"
cp "$REPO/zellij/zellij_se.sh" "$ZD/zellij_se.sh"

CS_INJECT=""
if [ -f "$ZD/config.kdl" ]; then
    BAK="$ZD/config.kdl.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$ZD/config.kdl" "$BAK"
    say "zellij：已有 config.kdl，备份到 $BAK"
    if grep -q '>>> zellij-claude-status' "$ZD/config.kdl" \
        && [ -f "$HOME/zellij-claude-status/scripts/install.py" ]; then
        CS_INJECT=1
    fi
fi
sed "s|<HOME>|$HOME|g" "$REPO/zellij/config.kdl" > "$ZD/config.kdl"
say "zellij：config.kdl 已安装，scrollback_editor → $ZD/zellij_se.sh"

if [ -n "$CS_INJECT" ]; then
    say "zellij：检测到 claude-status，跑它的 install.py 把 Alt q 等注入回来（它会再备份一次）"
    python3 "$HOME/zellij-claude-status/scripts/install.py"
fi

say "完成。pi 侧改动 /reload 即生效；zellij 侧配置热载，但 load_plugins 的改动要重启 zellij 会话才生效"
