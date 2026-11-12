// Run: node --test plugins/gtd/scripts/find-reminder-origin.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {findReminderOrigins, parseDispatchTo} from "./find-reminder-origin.mts";

const TITLE = "widget 1.2.3 is 24h old — OK to merge the widget branches";

function toolUseLine(sessionId: string, cwd: string, name: string, input: unknown): string
{
	return JSON.stringify(
		{
			type: "assistant",
			sessionId,
			cwd,
			timestamp: "2026-11-02T16:05:00.000Z",
			message:
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name,
						input,
					},
				],
			},
		},
	);
}

function toolResultLine(sessionId: string, cwd: string, text: string): string
{
	return JSON.stringify(
		{
			type: "user",
			sessionId,
			cwd,
			timestamp: "2026-11-03T16:05:00.000Z",
			message:
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_2",
						content: [
							{
								type: "text",
								text,
							},
						],
					},
				],
			},
		},
	);
}

function makeProjects(): string
{
	const root = mkdtempSync(join(tmpdir(), "find-reminder-origin-"));
	const origin = join(root, "-Users-alice-projects-widget");
	mkdirSync(
		join(origin, "aaaa", "subagents"),
		{
			recursive: true,
		},
	);
	writeFileSync(
		join(origin, "aaaa.jsonl"),
		[
			toolResultLine("aaaa", "/Users/alice/projects/widget", "unrelated"),
			toolUseLine(
				"aaaa",
				"/Users/alice/projects/widget",
				"mcp__imcp__reminders_create",
				{
					title: TITLE,
					notes: "Merging earlier breaks the 24-hour policy.",
				},
			),
		].join("\n"),
	);
	writeFileSync(
		join(origin, "aaaa", "subagents", "agent-1.jsonl"),
		toolUseLine(
			"aaaa",
			"/Users/alice/projects/widget",
			"Bash",
			{
				command: `echo "${TITLE}"`,
			},
		),
	);
	const reader = join(root, "-Users-alice-projects-daily");
	mkdirSync(reader);
	writeFileSync(
		join(reader, "bbbb.jsonl"),
		[
			toolResultLine(
				"bbbb",
				"/Users/alice/projects/daily",
				JSON.stringify(
					{
						name: TITLE,
					},
				),
			),
			toolUseLine(
				"bbbb",
				"/Users/alice/projects/daily",
				"SendMessage",
				{
					to: "widget",
					message: TITLE,
				},
			),
		].join("\n"),
	);
	return root;
}

test("findReminderOrigins returns only the main transcript whose tool call created the reminder", () =>
{
	const root = makeProjects();
	assert.deepStrictEqual(findReminderOrigins(root, TITLE), [
		{
			sessionId: "aaaa",
			cwd: "/Users/alice/projects/widget",
			transcript: join(root, "-Users-alice-projects-widget", "aaaa.jsonl"),
			tool: "mcp__imcp__reminders_create",
			createdAt: "2026-11-02T16:05:00.000Z",
		},
	]);
});

test("findReminderOrigins matches a Fantastical osascript Bash call", () =>
{
	const root = mkdtempSync(join(tmpdir(), "find-reminder-origin-"));
	const dir = join(root, "-Users-alice-projects-gadget");
	mkdirSync(dir);
	const command = `osascript -e 'tell application "Fantastical" to parse sentence "reminder ${TITLE} tomorrow at 11am" with add immediately'`;
	writeFileSync(
		join(dir, "cccc.jsonl"),
		toolUseLine(
			"cccc",
			"/Users/alice/projects/gadget",
			"Bash",
			{
				command,
			},
		),
	);
	assert.deepStrictEqual(findReminderOrigins(root, TITLE), [
		{
			sessionId: "cccc",
			cwd: "/Users/alice/projects/gadget",
			transcript: join(dir, "cccc.jsonl"),
			tool: "Bash",
			createdAt: "2026-11-02T16:05:00.000Z",
		},
	]);
});

test("findReminderOrigins ignores Bash calls that only search for the reminder", () =>
{
	const root = mkdtempSync(join(tmpdir(), "find-reminder-origin-"));
	const dir = join(root, "-Users-alice-projects-daily");
	mkdirSync(dir);
	writeFileSync(
		join(dir, "dddd.jsonl"),
		[
			toolUseLine(
				"dddd",
				"/Users/alice/projects/daily",
				"Bash",
				{
					command: `grep -rl "${TITLE}" ~/.claude/projects`,
				},
			),
			toolUseLine(
				"dddd",
				"/Users/alice/projects/daily",
				"Bash",
				{
					command: `node find-reminder-origin.mts --text "${TITLE}"`,
				},
			),
			toolUseLine(
				"dddd",
				"/Users/alice/projects/daily",
				"Bash",
				{
					command: `python3 - <<'EOF'\nprint("osascript Fantastical")\nEOF\nnode find-reminder-origin.mts --text "${TITLE}"`,
				},
			),
		].join("\n"),
	);
	assert.deepStrictEqual(findReminderOrigins(root, TITLE), []);
});

test("findReminderOrigins returns an empty list when nothing created the reminder", () =>
{
	const root = makeProjects();
	assert.deepStrictEqual(findReminderOrigins(root, "no such reminder"), []);
});

test("parseDispatchTo reads the name and ref from a dispatch-to line", () =>
{
	assert.deepStrictEqual(
		parseDispatchTo("Policy note.\ndispatch-to: widget-next [035346]\nmore"),
		{
			name: "widget-next",
			ref: "035346",
		},
	);
});

test("parseDispatchTo accepts a line without a ref", () =>
{
	assert.deepStrictEqual(
		parseDispatchTo("dispatch-to: widget"),
		{
			name: "widget",
			ref: null,
		},
	);
});

test("parseDispatchTo returns null when the notes carry no dispatch-to line", () =>
{
	assert.strictEqual(parseDispatchTo("just a note"), null);
	assert.strictEqual(parseDispatchTo(""), null);
});
