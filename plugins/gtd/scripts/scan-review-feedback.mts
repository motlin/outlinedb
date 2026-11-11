#!/usr/bin/env node
// Scan Claude Code transcripts for user feedback during daily-review runs.
//
// The daily review's meta-feedback LLM-task uses this to mine the prior run(s)
// for corrections and preferences worth folding back into the skills. Transcript
// JSONL files are huge, so this script does the heavy filtering and emits a
// compact extract — only the human-typed turns and a one-line summary of the
// assistant action each one was reacting to — keeping the giant tool I/O out of
// the prep subagent's context.
//
// Usage:
//   node scan-review-feedback.mts [--since YYYY-MM-DD|ISO] [--dir <transcripts>] [--marker <text>]
//
// Defaults: --since = 1 day ago, --dir = the workflowy project transcript dir,
// --marker = "gtd:review:daily" (only sessions that ran the daily review).
// Emits JSON: [{sessionId, file, startTs, turns: [{ts, text, prevAssistant}]}].

import {readdirSync, readFileSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {isObject} from "./json.mts";
import {isMain} from "./is-main.mts";

const MAX_TEXT = 2000;
/** Claude Code names a project transcript directory after the cwd with every non-alphanumeric character as a dash. */
export function projectDirFor(cwd: string): string {
	return join(homedir(), ".claude/projects", cwd.replaceAll(/[^A-Za-z0-9]/gu, "-"));
}

const DEFAULT_DIR = projectDirFor(process.cwd());

export interface FeedbackTurn {
	ts: unknown;
	source: "typed" | "ask";
	text: string;
	prevAssistant: string;
}

interface Session {
	sessionId: unknown;
	file: string;
	startTs: unknown;
	turns: FeedbackTurn[];
}

/** A property of a transcript value, or undefined when the value is not an object. */
function field(value: unknown, key: string): unknown {
	return isObject(value) ? value[key] : undefined;
}

// Transcript values are untyped, so these keep JavaScript's truthiness and string conversion explicit.
const isTruthy = (value: unknown): boolean => Boolean(value);
const describe = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

const isTextBlock = (b: unknown): boolean => field(b, "type") === "text";
const hasStringText = (b: unknown): boolean => isTextBlock(b) && typeof field(b, "text") === "string";
const blockText = (b: unknown): unknown => field(b, "text");

function contentBlocks(obj: unknown): unknown[] {
	const c = field(field(obj, "message"), "content");
	if (typeof c === "string") {
		return [{type: "text", text: c}];
	}
	if (Array.isArray(c)) {
		return c;
	}
	return [];
}

export function isHumanUserMessage(obj: unknown): boolean {
	if (!isObject(obj) || obj.type !== "user") {
		return false;
	}
	// Harness-injected (command-body / skill expansions), subagent sidechains, and
	// tool-result echoes are not human input even though they share type "user".
	if (obj.isMeta === true || obj.isSidechain === true) {
		return false;
	}
	if (obj.toolUseResult !== undefined) {
		return false;
	}
	const blocks = contentBlocks(obj);
	if (blocks.length === 0) {
		return false;
	}
	if (blocks.some((b) => field(b, "type") === "tool_result")) {
		return false;
	}
	if (!blocks.some(hasStringText)) {
		return false;
	}
	const text = blocks.filter(isTextBlock).map(blockText).join("\n").trim();
	if (!text) {
		return false;
	}
	// Slash-command stubs, local command echoes, and the interrupt marker are metadata.
	if (/^<command-(name|message|args)/u.test(text)) {
		return false;
	}
	if (text.startsWith("<local-command-stdout>")) {
		return false;
	}
	if (text.startsWith("[Request interrupted")) {
		return false;
	}
	return true;
}

export function userText(obj: unknown): string | null {
	const text = contentBlocks(obj).filter(hasStringText).map(blockText).join("\n").trim();
	return text || null;
}

const ASK_PREFIXES = ["The user answered:", "Your questions have been answered:"];

function toolResultText(obj: unknown): string | null {
	if (field(obj, "type") !== "user") {
		return null;
	}
	const block = contentBlocks(obj).find((b) => field(b, "type") === "tool_result");
	if (!isObject(block)) {
		return null;
	}
	const content = block.content ?? block.text;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.filter(hasStringText).map(blockText).join("\n");
	}
	return null;
}

// AskUserQuestion answers reach the transcript as tool_result blocks, so
// isHumanUserMessage rejects them — yet they carry real user decisions,
// including free-text typed into "Other". Match on the leading prefix only:
// tool output that merely quotes the phrase mid-stream is not an answer.
export function isAskUserQuestionAnswer(obj: unknown): boolean {
	const text = toolResultText(obj);
	if (typeof text !== "string") {
		return false;
	}
	const trimmed = text.trimStart();
	return ASK_PREFIXES.some((p) => trimmed.startsWith(p));
}

export function askAnswerText(obj: unknown): string | null {
	if (!isAskUserQuestionAnswer(obj)) {
		return null;
	}
	const text = (toolResultText(obj) ?? "").trim();
	return text || null;
}

export function assistantSummary(obj: unknown): string {
	if (field(obj, "type") !== "assistant") {
		return "";
	}
	const blocks = contentBlocks(obj);
	const parts: string[] = [];
	for (const b of blocks) {
		if (field(b, "type") === "tool_use") {
			const input = field(b, "input");
			const cmd = field(input, "command") ?? field(input, "description") ?? field(input, "prompt") ?? "";
			parts.push(`${String(field(b, "name"))}${isTruthy(cmd) ? `(${describe(cmd).slice(0, 80)})` : ""}`);
		}
	}
	if (parts.length > 0) {
		return `ran ${parts.join(", ")}`;
	}
	const text = blocks.filter(isTextBlock).map(blockText).join(" ").trim();
	return text ? `said "${text.slice(0, 120)}"` : "";
}

export function hasCommandInvocation(raw: string, marker: string): boolean {
	return raw.includes(`<command-name>/${marker}</command-name>`);
}

function cap(text: string): string {
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export function extractFeedback(
	objs: unknown[],
	{cutoff = null}: {cutoff?: number | null} = {},
): {turns: FeedbackTurn[]} {
	// Filter individual turns by timestamp rather than dropping whole sessions:
	// a session opened days before the window still accumulates new feedback.
	// Undated turns are kept — a missing timestamp is not evidence of staleness.
	const withinWindow = (ts: unknown): boolean => cutoff === null || !isTruthy(ts) || Date.parse(String(ts)) >= cutoff;
	const turns: FeedbackTurn[] = [];
	let lastAssistant = "";
	for (const obj of objs) {
		if (field(obj, "type") === "assistant") {
			const s = assistantSummary(obj);
			if (s) {
				lastAssistant = s;
			}
			continue;
		}
		const ts = field(obj, "timestamp") ?? null;
		if (!withinWindow(ts)) {
			continue;
		}
		if (isHumanUserMessage(obj)) {
			turns.push({ts, source: "typed", text: cap(userText(obj) ?? ""), prevAssistant: lastAssistant});
		} else if (isAskUserQuestionAnswer(obj)) {
			turns.push({ts, source: "ask", text: cap(askAnswerText(obj) ?? ""), prevAssistant: lastAssistant});
		}
	}
	return {turns};
}

function parseLines(raw: string): unknown[] {
	const objs: unknown[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(t);
			objs.push(value);
		} catch {
			// Skip malformed lines rather than aborting the whole scan.
		}
	}
	return objs;
}

function sinceMillis(since: string | null): number {
	// Accept YYYY-MM-DD or full ISO; default to 24h ago.
	if (since === null || since === "") {
		return Date.now() - 86_400_000;
	}
	const ms = Date.parse(since.length === 10 ? `${since}T00:00:00` : since);
	return Number.isNaN(ms) ? Date.now() - 86_400_000 : ms;
}

function main(argv: string[]): void {
	const args = argv.slice(2);
	let since: string | null = null;
	let dir = DEFAULT_DIR;
	let marker = "gtd:review:daily";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--since") {
			since = args[++i] ?? null;
		} else if (args[i] === "--dir") {
			dir = args[++i] ?? dir;
		} else if (args[i] === "--marker") {
			marker = args[++i] ?? marker;
		}
	}
	const cutoff = sinceMillis(since);

	const sessions: Session[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) {
			continue;
		}
		const path = join(dir, name);
		if (statSync(path).mtimeMs < cutoff) {
			continue;
		}
		const raw = readFileSync(path, "utf8");
		if (!hasCommandInvocation(raw, marker)) {
			continue;
		}
		const objs = parseLines(raw);
		const startTs =
			field(
				objs.find((o) => Boolean(field(o, "timestamp"))),
				"timestamp",
			) ?? null;
		const {turns} = extractFeedback(objs, {cutoff});
		if (turns.length === 0) {
			continue;
		}
		sessions.push({
			sessionId: field(objs[0], "sessionId") ?? name.replace(".jsonl", ""),
			file: path,
			startTs,
			turns,
		});
	}
	sessions.sort((a, b) => String(a.startTs).localeCompare(String(b.startTs)));
	process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
}

if (isMain(import.meta.url)) {
	main(process.argv);
}
