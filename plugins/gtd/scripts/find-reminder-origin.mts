#!/usr/bin/env node
// Find the Claude Code session that created a reminder, for /gtd:dispatch.
//
// A session that wants to resume work later sets a reminder (iMCP
// reminders_create, or a Fantastical osascript through Bash). When it fires,
// /gtd:dispatch sends the reminder back to that session. This script finds it by
// searching the transcripts under ~/.claude/projects for a tool call whose input
// contains the reminder text.
//
// Only main transcripts count: subagent transcripts (`<session>/subagents/`) are
// skipped. Only reminder-creating calls match: sessions that merely saw the
// reminder (a reminders_fetch result, a grep, an earlier dispatch) do not.
//
// Usage:
//   find-reminder-origin.mts --text "<reminder title>" [--notes "<reminder notes>"] [--projects <dir>]
//
// Prints JSON: {"dispatchTo": {name, ref} | null, "origins": [...]}. When the
// notes carry a `dispatch-to:` line, the search is skipped and origins is empty.

import {readFileSync, readdirSync, statSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {takeValue} from "./cli-args.mts";
import {arrayField, isObject, parseJson, stringField} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface DispatchTo {
	name: string;
	ref: string | null;
}

export interface ReminderOrigin {
	sessionId: string;
	cwd: string;
	transcript: string;
	tool: string;
	createdAt: string;
}

const DISPATCH_TO_RE = /^dispatch-to:\s*(\S+)(?:\s+\[([0-9a-f]+)\])?\s*$/mu;

export function parseDispatchTo(notes: string): DispatchTo | null {
	const m = notes.match(DISPATCH_TO_RE);
	if (!m?.[1]) {
		return null;
	}
	return {name: m[1], ref: m[2] ?? null};
}

// A tool call creates the reminder when it is an iMCP-style reminders_create whose
// input holds the text, or a Bash command with one line that runs osascript
// against Fantastical or Reminders and holds the text. Anything else that
// mentions the text (a grep, this script, a SendMessage) is a search or a
// dispatch.
function createsReminder(name: string, input: unknown, text: string): boolean {
	if (name.endsWith("reminders_create")) {
		return containsText(input, text);
	}
	const command = isObject(input) ? stringField(input, "command") : undefined;
	if (name !== "Bash" || command === undefined) {
		return false;
	}
	return command
		.split("\n")
		.some((line) => line.includes(text) && line.includes("osascript") && /Fantastical|Reminders/u.test(line));
}

// The longest run of the text that JSON encodes verbatim, for a cheap substring
// prefilter before parsing any line.
function prefilter(text: string): string {
	// eslint-disable-next-line no-control-regex -- JSON escapes control characters, so they split verbatim runs
	const runs = text.split(/["\\\u0000-\u001F]/u);
	return runs.reduce((a, b) => (b.length > a.length ? b : a), "");
}

function containsText(value: unknown, text: string): boolean {
	if (typeof value === "string") {
		return value.includes(text);
	}
	if (Array.isArray(value)) {
		return value.some((v) => containsText(v, text));
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).some((v) => containsText(v, text));
	}
	return false;
}

function originInTranscript(transcript: string, text: string, needle: string): ReminderOrigin | null {
	const contents = readFileSync(transcript, "utf8");
	if (!contents.includes(needle)) {
		return null;
	}
	for (const line of contents.split("\n")) {
		if (!line.includes(needle)) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = parseJson(line);
		} catch {
			continue;
		}
		if (!isObject(parsed) || parsed.type !== "assistant" || !isObject(parsed.message)) {
			continue;
		}
		for (const block of arrayField(parsed.message, "content")) {
			if (!isObject(block) || block.type !== "tool_use") {
				continue;
			}
			const name = stringField(block, "name");
			if (name !== undefined && createsReminder(name, block.input, text)) {
				return {
					sessionId: stringField(parsed, "sessionId") ?? "",
					cwd: stringField(parsed, "cwd") ?? "",
					transcript,
					tool: name,
					createdAt: stringField(parsed, "timestamp") ?? "",
				};
			}
		}
	}
	return null;
}

export function findReminderOrigins(projectsDir: string, text: string): ReminderOrigin[] {
	const needle = prefilter(text);
	const origins: ReminderOrigin[] = [];
	for (const project of readdirSync(projectsDir)) {
		const projectDir = join(projectsDir, project);
		if (!statSync(projectDir).isDirectory()) {
			continue;
		}
		for (const entry of readdirSync(projectDir)) {
			if (!entry.endsWith(".jsonl")) {
				continue;
			}
			const origin = originInTranscript(join(projectDir, entry), text, needle);
			if (origin) {
				origins.push(origin);
			}
		}
	}
	return origins.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function main(): void {
	let text = "";
	let notes = "";
	let projectsDir = join(homedir(), ".claude", "projects");
	const args = process.argv.slice(2)[Symbol.iterator]();
	for (const arg of args) {
		if (arg === "--text") {
			text = takeValue(args, arg);
		} else if (arg === "--notes") {
			notes = takeValue(args, arg);
		} else if (arg === "--projects") {
			projectsDir = takeValue(args, arg);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (text === "") {
		throw new Error("--text is required");
	}
	const dispatchTo = parseDispatchTo(notes);
	const origins = dispatchTo ? [] : findReminderOrigins(projectsDir, text);
	console.log(JSON.stringify({dispatchTo, origins}, null, 2));
}

if (isMain(import.meta.url)) {
	main();
}
