/**
 * what-model-sees — deep sanitize/redact helpers.
 *
 * Everything captured passes through `sanitizeValue` so snapshots are
 * JSON-safe, memory-bounded, and free of secrets and inline base64 blobs.
 */
import { createHash } from "node:crypto";
import type { ImagePlaceholder, RequestSnapshot, RoleStat } from "./types.ts";

const REDACT_KEY_RE = /(api[-_]?key|authorization|secret|password|credential|cookie|access[-_]?token)/i;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
/** Keys that hold session-side data the model never sees; dropped from the semantic view. */
const DROP_MESSAGE_KEYS = new Set(["details", "nestedCalls", "usage", "durationMs", "diagnostics"]);
const MAX_DEPTH = 64;

export interface ImageStats {
	count: number;
	bytes: number;
}

export function makeImageStats(): ImageStats {
	return { count: 0, bytes: 0 };
}

function base64Bytes(b64: string): number {
	const clean = b64.replace(/[\r\n=]/g, "");
	return Math.floor((clean.length * 3) / 4);
}

function imagePlaceholder(b64: string, mimeType?: string): ImagePlaceholder {
	return {
		__seen: "image",
		mimeType,
		bytes: base64Bytes(b64),
		sha256: createHash("sha256").update(b64).digest("hex").slice(0, 16),
	};
}

function looksBase64(value: string): boolean {
	return value.length > 512 && value.length % 4 === 0 && BASE64_RE.test(value.slice(0, 512));
}

/**
 * Deep-clone a value into a JSON-safe, redacted form.
 * - secrets-looking keys are replaced with "[redacted]"
 * - inline base64 image data (all common provider shapes) becomes an ImagePlaceholder
 * - cycles / exotic values become marker strings
 */
export function sanitizeValue(
	value: unknown,
	imageStats?: ImageStats,
	depth = 0,
	seen?: Set<object>,
): unknown {
	if (value === null) return null;
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") return value;
	if (t === "undefined") return null;
	if (t === "bigint" || t === "function" || t === "symbol") {
		return `[${t}]`;
	}
	if (t !== "object") return String(value);
	if (depth > MAX_DEPTH) return "[depth]";
	seen ??= new Set();
	if (seen.has(value as object)) return "[circular]";
	seen.add(value as object);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => sanitizeValue(item, imageStats, depth + 1, seen));
		}
		const obj = value as Record<string, unknown>;

		// pi-ai ModelMessage image block: { type: "image", data, mimeType }
		if (obj.type === "image" && typeof obj.data === "string" && looksBase64(obj.data)) {
			imageStats && (imageStats.count++, (imageStats.bytes += base64Bytes(obj.data)));
			return imagePlaceholder(obj.data, typeof obj.mimeType === "string" ? obj.mimeType : undefined);
		}
		// Anthropic payload: { type: "image", source: { type: "base64", data, media_type } }
		if (
			obj.type === "image" &&
			obj.source &&
			typeof obj.source === "object" &&
			typeof (obj.source as Record<string, unknown>).data === "string"
		) {
			const src = obj.source as Record<string, unknown>;
			if (looksBase64(src.data as string)) {
				imageStats && (imageStats.count++, (imageStats.bytes += base64Bytes(src.data as string)));
				return imagePlaceholder(
					src.data as string,
					typeof src.media_type === "string" ? src.media_type : undefined,
				);
			}
		}
		// OpenAI shapes: image_url / input_image with data: URL or b64_json
		for (const key of ["image_url", "input_image"] as const) {
			const v = obj[key];
			if (v === undefined) continue;
			let url = "";
			if (typeof v === "string") url = v;
			else if (v && typeof v === "object") {
				const u = (v as Record<string, unknown>).url;
				if (typeof u === "string") url = u;
			}
			const marker = url.indexOf("base64,");
			if (marker >= 0) {
				const b64 = url.slice(marker + 7);
				const mime = url.slice(5, url.indexOf(";")) || undefined;
				imageStats && (imageStats.count++, (imageStats.bytes += base64Bytes(b64)));
				return { __seen: "image", mimeType: mime, bytes: base64Bytes(b64), sha256: createHash("sha256").update(b64).digest("hex").slice(0, 16), url: url.slice(0, marker + 7) + "…" };
			}
		}
		if (typeof obj.b64_json === "string" && looksBase64(obj.b64_json)) {
			imageStats && (imageStats.count++, (imageStats.bytes += base64Bytes(obj.b64_json)));
			return imagePlaceholder(obj.b64_json);
		}

		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(obj)) {
			if (REDACT_KEY_RE.test(key)) {
				out[key] = "[redacted]";
				continue;
			}
			// generic long-base64 payload in obvious keys
			if (
				typeof val === "string" &&
				(key === "data" || key === "url") &&
				val.length > 4096 &&
				looksBase64(val)
			) {
				imageStats && (imageStats.count++, (imageStats.bytes += base64Bytes(val)));
				out[key] = imagePlaceholder(val);
				continue;
			}
			out[key] = sanitizeValue(val, imageStats, depth + 1, seen);
		}
		return out;
	} finally {
		seen.delete(value as object);
	}
}

/** Sanitize the `context_with_system` message list, dropping session-side fields. */
export function sanitizeMessages(messages: unknown[], imageStats?: ImageStats): unknown[] {
	return messages.map((m) => {
		if (m && typeof m === "object" && !Array.isArray(m)) {
			const rest = { ...(m as Record<string, unknown>) };
			for (const k of DROP_MESSAGE_KEYS) delete rest[k];
			return sanitizeValue(rest, imageStats);
		}
		return sanitizeValue(m, imageStats);
	});
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function estimateTokens(chars: number): number {
	return Math.round(chars / 4);
}

export function formatChars(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function formatBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${n}B`;
}

export function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (x: number) => String(x).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}

export function formatTps(tps: number): string {
	return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

/** TTFT is always expressed in seconds (e.g. "1.24s"). */
export function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(2)}s`;
}

export interface TimingSummary {
	/** ms from payload sent to first stream event (TTFT: network + server queue). */
	ttftMs?: number;
	/** ms from first token to completion (streaming generation). */
	generationMs?: number;
	/** ms from payload sent to completion (end to end). */
	totalMs?: number;
	/** Output tokens, when usage reported them. */
	outputTokens?: number;
	/** Output tokens per second over the generation window. */
	tps?: number;
}

/** Derive timing/speed stats from a snapshot's observed timestamps. */
export function timingSummary(s: RequestSnapshot): TimingSummary | null {
	const t = s.timing;
	if (!t) return null;
	const out: TimingSummary = {};
	if (t.firstTokenAt !== undefined) out.ttftMs = Math.max(0, t.firstTokenAt - t.sentAt);
	if (t.firstTokenAt !== undefined && t.completedAt !== undefined) {
		out.generationMs = Math.max(0, t.completedAt - t.firstTokenAt);
	}
	if (t.completedAt !== undefined) out.totalMs = Math.max(0, t.completedAt - t.sentAt);
	const output = s.usage?.output;
	if (output !== undefined && output > 0) {
		out.outputTokens = output;
		// Prefer the pure generation window; fall back to the total wall time when
		// no first-token mark exists (e.g. non-streaming or failed-then-finalized).
		const windowMs = (out.generationMs ?? 0) > 0 ? out.generationMs : out.totalMs;
		if (windowMs && windowMs > 0) out.tps = output / (windowMs / 1000);
	}
	if (out.ttftMs === undefined && out.totalMs === undefined && out.tps === undefined) return null;
	return out;
}

export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
			const text = (block as Record<string, unknown>).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

export interface MessageDescription {
	role: string;
	label: string;
	chars: number;
	preview: string;
	newlinePreview: string;
}

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.__seen === "image") {
			total += 16;
			continue;
		}
		if (typeof b.text === "string") total += b.text.length;
		if (b.type === "toolCall" || b.type === "tool_use") {
			try {
				total += JSON.stringify(b.arguments ?? b.input ?? {}).length;
			} catch {
				total += 32;
			}
		}
	}
	return total;
}

function firstLine(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Human-readable description of a sanitized message, preserving provenance. */
export function describeMessage(message: unknown): MessageDescription {
	if (!message || typeof message !== "object") {
		return { role: "?", label: "?", chars: 0, preview: "", newlinePreview: "" };
	}
	const m = message as Record<string, unknown>;
	const role = typeof m.role === "string" ? m.role : "?";
	const content = m.content ?? m.summary ?? m.command ?? "";
	let chars = contentChars(content);
	const text = extractText(content);
	let label = role;
	let preview = firstLine(text);
	let newlinePreview = text;

	switch (role) {
		case "user": {
			const images = Array.isArray(content)
				? content.filter(
						(b) => b && typeof b === "object" && (b as Record<string, unknown>).__seen === "image",
					).length
				: 0;
			if (images > 0) preview = `${preview} [${images} image${images > 1 ? "s" : ""}]`.trim();
			break;
		}
		case "assistant": {
			const calls: string[] = [];
			if (Array.isArray(content)) {
				for (const block of content) {
					const b = block as Record<string, unknown>;
					if (b.type === "toolCall" || b.type === "tool_use") {
						calls.push(typeof b.name === "string" ? b.name : "?");
					}
				}
			}
			if (calls.length > 0 && !preview) preview = `⚙ ${calls.join(", ")}`;
			else if (calls.length > 0) preview = `${preview} ⚙ ${calls.join(", ")}`;
			break;
		}
		case "toolResult": {
			const toolName = typeof m.toolName === "string" ? m.toolName : "?";
			label = `toolResult(${toolName})`;
			if (m.isError === true) preview = `✗ ${preview}`;
			break;
		}
		case "system": {
			label = "system";
			// pi-ai system messages carry most text in named sections, and tool
			// declarations in toolsAdded; count both so sizes are honest.
			const sections = m.sections as Record<string, unknown> | undefined;
			if (sections && typeof sections === "object") {
				const names: string[] = [];
				let sectionChars = 0;
				for (const [name, value] of Object.entries(sections)) {
					if (typeof value === "string" && value.length > 0) {
						names.push(name);
						sectionChars += value.length;
					}
				}
				chars += sectionChars;
				if (!preview && names.length > 0) {
					preview = `sections: ${names.join(", ")}`;
				}
				// Detail view: show each section's actual text, not just its name.
				const sectionBlocks: string[] = [];
				for (const name of names) {
					const value = sections[name];
					if (typeof value === "string") {
						sectionBlocks.push(`── [section:${name}] ──\n${value}`);
					}
				}
				newlinePreview = [newlinePreview, ...sectionBlocks].filter(Boolean).join("\n\n");
			}
			const toolCount = Array.isArray(m.toolsAdded) ? m.toolsAdded.length : 0;
			if (toolCount > 0) preview = `${preview} (声明 ${toolCount} 工具)`.trim();
			break;
		}
		case "custom": {
			const customType = typeof m.customType === "string" ? m.customType : "?";
			label = `custom✦${customType}`;
			break;
		}
		case "bashExecution": {
			preview = `! ${firstLine(String(m.command ?? ""), 60)} → exit ${String(m.exitCode ?? "?")}`;
			newlinePreview = `$ ${String(m.command ?? "")}\n${String(m.output ?? "")}`;
			break;
		}
		case "compactionSummary": {
			label = "compactionSummary";
			preview = `compacted ~${formatTokens(Number(m.tokensBefore ?? 0))} tok`;
			newlinePreview = text;
			break;
		}
		case "branchSummary": {
			label = "branchSummary";
			break;
		}
	}
	return { role, label, chars, preview, newlinePreview };
}

/** Aggregate per-role stats over sanitized messages. */
export function roleStats(messages: unknown[]): Record<string, RoleStat> {
	const byRole: Record<string, RoleStat> = {};
	for (const m of messages) {
		const d = describeMessage(m);
		const entry = (byRole[d.role] ??= { count: 0, chars: 0 });
		entry.count++;
		entry.chars += d.chars;
	}
	return byRole;
}

export function totalMessageChars(messages: unknown[]): number {
	return messages.reduce((sum, m) => sum + describeMessage(m).chars, 0);
}
