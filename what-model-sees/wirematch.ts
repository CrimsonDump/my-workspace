/**
 * what-model-sees — semantic↔wire message pairing.
 *
 * The 消息 tab lists `snapshot.messages` (pi's semantic view, provenance
 * preserved); the wire payload is what the provider actually received. The
 * two lists are not identical: serializers flatten system messages, rename
 * roles (toolResult→tool), merge consecutive tool results (anthropic), and
 * compat shims may insert bridge messages that only exist on the wire.
 *
 * Instead of re-deriving the wire shape per message (which would drift from
 * what was really sent), we pair each semantic message with the actual wire
 * JSON from `payload.messages`. Order is preserved by every transport, so a
 * two-pointer walk with a small look-ahead window resynchronizes cheaply.
 */
import type { RequestSnapshot } from "./types.ts";

export interface WirePairing {
	/** Parallel to snapshot.messages: the wire message actually sent for it (undefined = none). */
	matched: (unknown | undefined)[];
	/** Parallel to snapshot.messages: why a message has no wire counterpart, when it doesn't. */
	notes: (string | undefined)[];
	/** Wire messages with no semantic counterpart (compat bridges, tool-declaration system messages), in wire order. */
	wireOnly: unknown[];
}

/** Look-ahead window when resynchronizing after a mismatch. */
const WINDOW = 4;

/** Semantic role → expected wire role (openai-completions family). */
const OPENAI_ROLE: Record<string, string> = {
	user: "user",
	assistant: "assistant",
	system: "system",
	toolResult: "tool",
};

function roleOf(message: unknown): string {
	return typeof (message as { role?: unknown })?.role === "string"
		? (message as { role: string }).role
		: "";
}

/** True when an anthropic user message carries tool_result content blocks. */
function isAnthropicToolResultMessage(message: unknown): boolean {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_result",
	);
}

function payloadMessages(payload: unknown): unknown[] {
	const messages = (payload as { messages?: unknown })?.messages;
	return Array.isArray(messages) ? messages : [];
}

/**
 * Pair every semantic message with the wire message that carried it.
 *
 * Strategy per api: openai-completions-style role renaming for the general
 * case; anthropic-messages merges consecutive tool results into one user
 * message and moves system text to the top-level `system` param.
 */
export function pairWireMessages(snapshot: RequestSnapshot): WirePairing {
	const sem = snapshot.messages;
	const wire = payloadMessages(snapshot.payload);
	const api = snapshot.api ?? "";
	const anthropic = api === "anthropic-messages";
	const roleMap = anthropic
		? { ...OPENAI_ROLE, toolResult: "user", system: "__none__" }
		: OPENAI_ROLE;

	const matched: (unknown | undefined)[] = new Array(sem.length).fill(undefined);
	const notes: (string | undefined)[] = new Array(sem.length).fill(undefined);
	const wireOnly: unknown[] = [];

	let wi = 0;
	for (let si = 0; si < sem.length; si++) {
		const semRole = roleOf(sem[si]);
		const expected = roleMap[semRole] ?? semRole;

		// anthropic: system lives in the top-level `system` param, not in messages.
		if (expected === "__none__") {
			notes[si] = "system 在 anthropic API 中是顶层参数（payload.system），不在 messages 里";
			continue;
		}

		// anthropic: consecutive tool results merge into one user message.
		if (anthropic && semRole === "toolResult") {
			if (wi < wire.length && isAnthropicToolResultMessage(wire[wi])) {
				matched[si] = wire[wi];
				const nextSemRole = si + 1 < sem.length ? roleOf(sem[si + 1]) : "";
				if (nextSemRole !== "toolResult") wi++;
			} else {
				notes[si] = "未在 wire 中找到对应的 tool_result 消息";
			}
			continue;
		}

		// General case: scan a small window ahead for the expected wire role.
		let found = -1;
		for (let k = 0; k < WINDOW && wi + k < wire.length; k++) {
			if (roleOf(wire[wi + k]) === expected) {
				found = wi + k;
				break;
			}
		}
		if (found >= 0) {
			for (let k = wi; k < found; k++) wireOnly.push(wire[k]);
			matched[si] = wire[found];
			wi = found + 1;
		} else {
			notes[si] =
				semRole === "system"
					? "此 system 消息未产生 wire 消息（内容为空的补丁，或被 provider 折叠）"
					: "此消息未出现在 wire 中（内容为空或被序列化器跳过）";
		}
	}
	for (; wi < wire.length; wi++) wireOnly.push(wire[wi]);

	return { matched, notes, wireOnly };
}

/** Find the wire tool declaration (payload.tools entry) for a tool name, in provider format. */
export function findWireTool(payload: unknown, name: string): unknown {
	const tools = (payload as { tools?: unknown })?.tools;
	if (!Array.isArray(tools)) return undefined;
	return tools.find((tool) => {
		if (typeof tool !== "object" || tool === null) return false;
		const candidate = tool as { name?: unknown; function?: { name?: unknown } };
		return candidate.name === name || candidate.function?.name === name;
	});
}

/** The request-level tools array, or null when the wire request declares none. */
export function getWireTools(payload: unknown): unknown[] | null {
	const tools = (payload as { tools?: unknown })?.tools;
	return Array.isArray(tools) && tools.length > 0 ? tools : null;
}

/** True when the snapshot carries a wire request document worth a #T row. */
export function hasWirePayload(payload: unknown): boolean {
	return typeof payload === "object" && payload !== null;
}
