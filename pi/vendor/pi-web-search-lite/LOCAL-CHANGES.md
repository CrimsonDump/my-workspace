# 本地改动（vendored fork）

源码 vendored 自 [setwhite/pi-extensions](https://github.com/setwhite/pi-extensions) 的 `packages/pi-web-search-lite`，版本 **0.14.0**（npm 包原样拷贝）。上游 MIT，LICENSE 保留。

本目录由 my-workspace 根 `package.json` 的 pi manifest 直接加载（`pi.vendor/pi-web-search-lite/src/index.ts`），不再 `pi install npm:pi-web-search-lite`。跟上游同步：`diff -ru <上游 checkout>/packages/pi-web-search-lite/src ./src`。

运行时依赖 undici（`^8.12.3`，与上游一致）声明在仓根 `package.json`，`install.sh` 会 `npm install`——本地 package 的依赖不经 pi 安装。

改动（相对上游 0.14.0，全部在 `src/extractors/html.ts`）：

1. **反爬拦截页判为失败**：最终 URL 含 `captcha`，或正文（≤100KB 的小页面）命中已知质询页特征（微信 `wappoc_appmsgcaptcha` / `secitptpage/verify` /「完成验证后即可继续访问」/「失效的验证页面」、Cloudflare「just a moment...」「checking your browser」「attention required! | cloudflare」、Google「unusual traffic from your computer network」等）时抛错，让提取链顺延 deepseek / jina——它们从各自服务端出口抓取，本地被拦时往往还能过。改动前验证码页会被当正文返回（内容超过 minChars），链条直接短路。大页面只在 URL 命中时判定，避免正文引用这些短语的文章被误伤。
2. **标题回退**：`<title>` 缺失或为空时，依次试 `og:title` / `twitter:title` meta（属性顺序两种都认）、微信的 `var msg_title = '...'`（微信文章页 `<title>` 为空，标题在 JS 变量里）。改动前这类页面标题会回退成 URL。

配置侧配套（不在本目录）：`userAgent` 推荐值改为移动端浏览器 UA——微信文章链接按 UA 的 mobile/desktop 信号放行，桌面 UA / 非浏览器 UA 都会拿到验证页（2026-11-25 实测；见仓 README 的 pi-web-search-lite 一节）。
