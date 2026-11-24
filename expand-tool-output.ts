/**
 * expand-tool-output — 启动时默认展开工具输出（相当于自动按一次 ctrl+o）。
 *
 * thinking 块的显示由 settings.json 的 hideThinkingBlock 控制（false = 显示），
 * 不需要本扩展处理。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setToolsExpanded(true);
	});
}
