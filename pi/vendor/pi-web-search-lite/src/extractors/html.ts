/** 本地 HTML 提取：零依赖正则（剥注释与噪音标签 → 剥导航/页脚 → 块级标签转换行 → 去标签 → 解实体 → 压空白）。反爬拦截页判为失败，让链条顺延。 */

import type { ExtractedContent, Extractor } from "./types.ts";

/** 这些内容类型不押注在 HTML 提取上，直接抛错顺延。 */
const BINARY_CONTENT_TYPES = [
	/^image\//,
	/^audio\//,
	/^video\//,
	/^application\/(?:pdf|zip|octet-stream|x-7z-compressed)/,
];

/** 反爬拦截页特征（小写匹配）：URL 或正文命中即判为提取失败——deepseek / jina 从各自服务端出口抓取，本地被拦时它们往往还能过。 */
const ANTIBOT_URL_MARKERS = ["captcha"] as const;
const ANTIBOT_BODY_MARKERS = [
	"wappoc_appmsgcaptcha", // 微信「环境异常」验证页的跳转路径
	"secitptpage/verify", // 微信 verify 页的 PAGE_MID
	"完成验证后即可继续访问", // 微信「环境异常」页正文
	"失效的验证页面", // 微信「未知错误」页正文
	"请完成安全验证",
	"just a moment...", // Cloudflare 质询页
	"checking your browser", // Cloudflare 旧版质询页
	"attention required! | cloudflare", // Cloudflare 封禁页
	"unusual traffic from your computer network", // Google
] as const;
/** 正文标记只在小页面里找：大页面（文章正文引用了这些短语）不该误伤；URL 标记不受此限。 */
const ANTIBOT_MAX_BODY_CHARS = 100_000;

export function assertNotAntiBotPage(finalUrl: string, text: string): void {
	const url = finalUrl.toLowerCase();
	if (ANTIBOT_URL_MARKERS.some((marker) => url.includes(marker))) {
		throw new Error(`anti-bot page (URL marker): ${finalUrl}`);
	}
	if (text.length <= ANTIBOT_MAX_BODY_CHARS) {
		const body = text.toLowerCase();
		const marker = ANTIBOT_BODY_MARKERS.find((candidate) => body.includes(candidate));
		if (marker !== undefined) {
			throw new Error(`anti-bot page (body marker: ${marker}): ${finalUrl}`);
		}
	}
}

const BLOCK_TAGS =
	/<\/?(?:br|p|div|section|article|header|footer|main|aside|nav|figure|figcaption|dl|dt|dd|form|fieldset|li|ul|ol|tr|td|th|table|caption|h[1-6]|blockquote|pre|hr)\b[^>]*\/?>/gi;

export const htmlExtractor: Extractor = {
	id: "html",
	unavailableReason: () => null,
	async extract(url, ctx): Promise<ExtractedContent> {
		const response = await ctx.http.fetchText(url, { signal: ctx.signal });
		const contentType = response.contentType?.toLowerCase() ?? "";
		if (BINARY_CONTENT_TYPES.some((pattern) => pattern.test(contentType))) {
			throw new Error(`unsupported content type: ${contentType || "unknown"}`);
		}
		assertNotAntiBotPage(response.url, response.text);
		return {
			url: response.url,
			title: extractTitle(response.text),
			content: htmlToText(response.text),
		};
	},
};

/** `<title>` 文本：先去标签、解实体、压空白；没有时回退 meta / 微信变量。 */
export function extractTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (match) {
		const title = collapse(decodeEntities(match[1].replace(/<[^>]*>/g, " ")));
		if (title !== "") return title;
	}
	return metaTitle(html);
}

/** `<title>` 缺失或为空时的回退：og:title / twitter:title meta，再退微信的 `var msg_title`（微信文章页 `<title>` 为空，标题在 JS 变量里）。 */
function metaTitle(html: string): string | undefined {
	const meta =
		/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*?content=["']([^"']*)["']/i.exec(
			html,
		) ??
		/<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["'](?:og:title|twitter:title)["']/i.exec(
			html,
		);
	if (meta) {
		const title = collapse(decodeEntities(meta[1]));
		if (title !== "") return title;
	}
	const wechat = /var\s+msg_title\s*=\s*'((?:\\.|[^'\\])*)'/.exec(html);
	if (wechat) {
		const title = collapse(decodeEntities(wechat[1].replace(/\\(['\\])/g, "$1")));
		if (title !== "") return title;
	}
	return undefined;
}

export function htmlToText(html: string): string {
	const withoutNoise = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|head|title|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<(?:meta|link)\b[^>]*\/?>/gi, " ");
	// 导航、页脚、侧栏的函数名与版权声明都是噪音。整页正文正好全在这些标签里时退回未剥版本。
	const withoutChrome = withoutNoise.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
	const cleaned = renderFragment(withoutChrome);
	return cleaned === "" ? renderFragment(withoutNoise) : cleaned;
}

function renderFragment(html: string): string {
	const withBreaks = html.replace(BLOCK_TAGS, "\n");
	const stripped = withBreaks.replace(/<[^>]*>/g, " ");
	return collapse(decodeEntities(stripped));
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, dec: string) => codePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** 非法码点（0、代理区、超界）返回空串：宁可丢字，也不往正文里塞 NUL / 孤立代理。 */
function codePoint(value: number): string {
	if (value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

function collapse(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}
