/**
 * what-model-sees — shared types.
 */

/** Marker that replaces inline base64 image data in captured snapshots. */
export interface ImagePlaceholder {
	__seen: "image";
	mimeType?: string;
	/** Approximate decoded byte size. */
	bytes: number;
	sha256: string;
}

export interface UsageSummary {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costTotal?: number;
}

export interface ToolMeta {
	name: string;
	description: string;
	exposure: string;
	source: string;
	sourcePath?: string;
	/** MCP server or tool namespace, when the tool belongs to one. */
	namespace?: string;
	/** Estimated chars of the declaration (description + JSON schema). */
	schemaChars: number;
}

export interface ContextFileInfo {
	path: string;
	chars: number;
}

export interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	source: string;
}

/** Sanitized projection of `systemPromptOptions` (context file *contents* dropped). */
export interface PromptOptionsInfo {
	cwd: string;
	customPrompt?: string;
	forceSystemPrompt?: string;
	appendSystemPrompt: string;
	selectedTools: string[];
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	sections: Record<string, string>;
	contextFiles: ContextFileInfo[];
	skills: SkillInfo[];
}

export interface RoleStat {
	count: number;
	chars: number;
}

export interface SnapshotStats {
	/** JSON length of the raw (unredacted) provider payload, in chars. */
	payloadBytesRaw: number;
	/** JSON length of the sanitized provider payload, in chars. */
	payloadBytes: number;
	systemChars: number;
	toolDeclChars: number;
	byRole: Record<string, RoleStat>;
	imageCount: number;
	imageBytes: number;
	totalMessageChars: number;
}

export interface RequestTiming {
	/** Epoch ms when the payload was sent (`before_provider_request`). */
	sentAt: number;
	/** Epoch ms of the first assistant stream event (`message_start`) — TTFT anchor. */
	firstTokenAt?: number;
	/** Epoch ms when the assistant message finalized (`message_end`). */
	completedAt?: number;
}

export interface RequestSnapshot {
	/** 1-based, monotonic per process. */
	index: number;
	timestamp: number;
	turnIndex: number | null;
	runIndex: number | null;
	/** False for model calls that bypass the agent loop (nested tool calls, etc.). */
	viaAgentLoop: boolean;
	provider?: string;
	api?: string;
	model?: string;
	contextWindow?: number;
	/** Sanitized wire-level payload actually sent to the provider. */
	payload: unknown;
	/** Sanitized context messages (context_with_system view, provenance-preserving). */
	messages: unknown[];
	/** System prompt text reconstructed from the leading system message. */
	systemPromptText: string;
	promptOptions: PromptOptionsInfo | null;
	tools: ToolMeta[];
	responseStatus?: number;
	usage?: UsageSummary;
	/** Wall-clock timing of the request/response cycle, when observed. */
	timing?: RequestTiming;
	stats: SnapshotStats;
	/** Directory the snapshot was persisted to, when persistence is active. */
	dir?: string;
	/** File name of the persisted snapshot (within dir). */
	file?: string;
	/** Session this request belonged to (used to match a reload baseline). */
	sessionId?: string;
}
