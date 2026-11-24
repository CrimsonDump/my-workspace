/**
 * Behavior test for the list-tab scroll-follow fix in viewer.ts.
 * Run: node --experimental-strip-types test-scroll.ts
 * (resolves deps via NODE_PATH set by the runner)
 */
import { SeenViewer } from "./viewer.ts";
import type { RequestSnapshot } from "./types.ts";

// ---- fakes -----------------------------------------------------------------

const theme = {
	fg: (_c: string, text: string) => text,
	bold: (text: string) => text,
};

function mkSnapshot(i: number, nMsgs: number): RequestSnapshot {
	const messages = Array.from({ length: nMsgs }, (_, k) => ({
		role: k % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `message ${k + 1} of snapshot ${i}` }],
	}));
	return {
		index: i + 1,
		timestamp: Date.now(),
		turnIndex: i,
		runIndex: i,
		viaAgentLoop: true,
		provider: "test",
		api: "test",
		model: "test-model",
		payload: null, // no wire payload -> no #T row in messages mode
		messages,
		systemPromptText: "system prompt",
		promptOptions: null,
		tools: [],
		stats: {
			payloadBytesRaw: 100,
			payloadBytes: 100,
			systemChars: 14,
			toolDeclChars: 0,
			byRole: {},
			imageCount: 0,
			imageBytes: 0,
			totalMessageChars: 100,
		},
	} as RequestSnapshot;
}

const store = {
	snapshots: Array.from({ length: 12 }, (_, i) => mkSnapshot(i, 60 + i * 3)),
	prevOf: (s: RequestSnapshot) => {
		const i = store.snapshots.indexOf(s);
		return i > 0 ? store.snapshots[i - 1] : undefined;
	},
	isBaseline: () => false,
} as never;

for (const s of store.snapshots as RequestSnapshot[]) {
	s.tools = Array.from({ length: 30 }, (_, k) => ({
		name: `tool_${String(k).padStart(2, "0")}`,
		description: `description of tool ${k}`,
		exposure: "active",
		source: "builtin",
		schemaChars: 100,
	}));
}

// ---- helpers ----------------------------------------------------------------

const ROWS = 24; // header 2 + tabbar 1 + viewport ~20 + footer 1
let done: (r: undefined) => void = () => {};
const viewer = new SeenViewer(
	{ store, startPos: 0, startTab: 3, theme, rows: () => ROWS, fullscreen: true, onExport: () => {} },
	(r) => done(r),
);

function renderLines(): string[] {
	return viewer.render(120);
}

/** Index of the viewport line carrying the cursor marker (▸). */
function cursorViewportLine(lines: string[]): number {
	const HEADER = 3; // header(2) + tabbar(1)
	// viewport lines come after header, before footer(1)
	for (let i = HEADER; i < lines.length - 1; i++) {
		if (lines[i].includes("▸")) return i - HEADER;
	}
	return -1;
}

function step(key: string) {
	viewer.handleInput(key);
	return renderLines();
}

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name} ${extra}`);
	}
}

// ---- scenario 1: messages tab, walk down past the first screen ---------------

console.log("scenario 1: j-j-j in messages list follows cursor");
step("4"); // tab 3 (messages, payloads mode)
step("\r"); // enter messages list of current snapshot
let lines = step("j");
for (let n = 0; n < 40; n++) {
	lines = step("j");
	const cur = cursorViewportLine(lines);
	if (cur < 0 || cur >= 20) {
		check(`cursor visible after ${n + 2} downs`, false, `(viewport line ${cur})`);
		break;
	}
	if (n === 39) check("cursor visible after 41 downs", true);
}

// ---- scenario 2: G jumps to the last message ---------------------------------

console.log("scenario 2: G shows the last row");
lines = step("G");
let cur = cursorViewportLine(lines);
check("cursor visible after G", cur >= 0 && cur < 20, `(viewport line ${cur})`);
const lastIdx = 60 - 1; // snapshot 0 has 60 messages, cursor 0..59
// footer shows "N/M行" range; last message row must be rendered
check("last message row on screen", lines.some((l) => l.includes(`#${lastIdx + 1}`)), JSON.stringify(lines.slice(-2)));

// ---- scenario 3: k back up follows too ---------------------------------------

console.log("scenario 3: k back up keeps cursor visible");
for (let n = 0; n < 45; n++) {
	lines = step("k");
	cur = cursorViewportLine(lines);
	if (cur < 0 || cur >= 20) {
		check(`cursor visible after ${n + 1} ups`, false, `(viewport line ${cur})`);
		break;
	}
	if (n === 44) check("cursor visible after 45 ups", true);
}

// ---- scenario 4: payloads mode (top level of the messages tab) ---------------

console.log("scenario 4: payloads list follows cursor");
step("\x1b"); // back to payloads list
for (let n = 0; n < 15; n++) lines = step("j");
cur = cursorViewportLine(lines);
check("cursor visible after 15 downs in payloads", cur >= 0 && cur < 20, `(viewport line ${cur})`);
check("scrolled (scroll > 0)", lines.some((l) => l.includes("# 12")), JSON.stringify(lines.slice(-2)));

// ---- scenario 5: tools tab ---------------------------------------------------

console.log("scenario 5: tools tab follows cursor");
step("3"); // tab 2 (tools)
for (let n = 0; n < 15; n++) lines = step("j");
cur = cursorViewportLine(lines);
check("cursor visible in tools tab", cur >= 0 && cur < 20, `(viewport line ${cur})`);

// ---- scenario 6: enter detail, esc returns to visible cursor -----------------

console.log("scenario 6: esc from detail returns to cursor row");
step("\r"); // open detail of the selected tool
lines = step("\x1b"); // close it
cur = cursorViewportLine(lines);
check("cursor visible after esc from detail", cur >= 0 && cur < 20, `(viewport line ${cur})`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
