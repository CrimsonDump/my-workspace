#!/usr/bin/env bash
# my-workspace 一键安装：pi（extensions / skill-creator / vendor 的 pi-web-search-lite / zpi 运行时配置）+ zellij 配置。
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

# ---------- pi：pi-web-search-lite（本仓 vendor，取代原 npm 安装） ----------
# 迁移：老安装走 npm:pi-web-search-lite，与本仓 pi/vendor/ 副本会重复注册 web_search / web_fetch
if command -v pi >/dev/null 2>&1 && pi list 2>/dev/null | grep -q 'npm:pi-web-search-lite'; then
    say "pi：移除 npm:pi-web-search-lite（已由本仓 pi/vendor/ 取代）"
    pi remove npm:pi-web-search-lite || warn "移除失败；手动执行：pi remove npm:pi-web-search-lite"
fi

# 本地 package 的运行时依赖（undici）自己装；受限网络先配 HTTPS_PROXY
if command -v npm >/dev/null 2>&1; then
    say "npm：安装本仓依赖（undici）"
    (cd "$REPO" && npm install --no-audit --no-fund) \
        || warn "npm install 失败（受限网络带 HTTPS_PROXY 重试）；恢复后重跑：cd $REPO && npm install"
fi

CFG="$HOME/.pi/agent/pi-web-search-lite/config.json"
if [ -f "$CFG" ]; then
    # 已有配置：只对齐 fetch 两项 + userAgent（本仓的推荐值），provider / proxy / apiKeys 一概不动
    if command -v node >/dev/null 2>&1; then
        node -e '
            const fs = require("fs"); const p = process.argv[1];
            const c = JSON.parse(fs.readFileSync(p, "utf8"));
            c.fetch = Object.assign({}, c.fetch, { extractors: ["html", "deepseek", "jina"], minChars: 50 });
            c.userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
            fs.writeFileSync(p, JSON.stringify(c, null, "\t") + "\n");
        ' "$CFG"
        say "pi-web-search-lite：fetch + userAgent 已对齐（移动端 UA；微信文章链接按 mobile/desktop 放行），其余配置未动"
    else
        warn "无 node，请手动对齐 $CFG 的 fetch 与 userAgent（见 pi/web-search-lite/config.template.json）"
    fi
else
    mkdir -p "$(dirname "$CFG")"
    cp "$REPO/pi/web-search-lite/config.template.json" "$CFG"
    say "pi-web-search-lite：已写入 $CFG"
    warn "还差一步：编辑 $CFG，填 deepseek 的 key（或 export DEEPSEEK_API_KEY，环境变量优先）、按机器填 proxy（直连机器留 \"\"）"
fi

# ---------- pi：zpi 运行时配置（首装写入，已有则不动） ----------
ZCFG="$HOME/.pi/agent/zpi/config.json"
if [ ! -f "$ZCFG" ]; then
    mkdir -p "$(dirname "$ZCFG")"
    cp "$REPO/pi/zpi/config.template.json" "$ZCFG"
    say "zpi：已写入 $ZCFG（zellijSession=main；registry 等运行时状态仍在仓外）"
else
    say "zpi：$ZCFG 已存在，未动"
fi

# ---------- pi：keybindings（canonical 在本仓，软链进 agent 目录；改完 /reload 生效） ----------
KB="$HOME/.pi/agent/keybindings.json"
if [ "$(readlink -f "$KB" 2>/dev/null)" = "$(readlink -f "$REPO/pi/keybindings.json")" ]; then
    say "keybindings：软链已就位"
elif [ -e "$KB" ] || [ -L "$KB" ]; then
    warn "keybindings：$KB 已存在（$(readlink "$KB" 2>/dev/null || echo 实体文件)），未动；要改用本仓版本：mv $KB $KB.bak && ln -s $REPO/pi/keybindings.json $KB"
else
    ln -s "$REPO/pi/keybindings.json" "$KB"
    say "keybindings：已软链 → $REPO/pi/keybindings.json"
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
