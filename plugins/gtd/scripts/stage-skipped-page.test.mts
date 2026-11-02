// Run: node --test plugins/gtd/scripts/stage-skipped-page.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildSkippedPage, skippedThisRun} from "./stage-skipped-page.mts";

const script = new URL("stage-skipped-page.mts", import.meta.url).pathname;

const RUN_STARTED = "2026-11-05T13:00:00.000Z";

const recurringRow =
{
	id: "rec-1",
	name: 'Water the plants <time startYear="2026" startMonth="11" startDay="1">Nov 1</time>',
	section: "Weekly Review",
	overdueByDays: 4,
	url: "https://workflowy.com/#/rec1",
	applyOp: "./bin/run.js node update --id rec-1 --name 'Water the plants'",
};

const dueRow =
{
	source: "workflowy",
	id: "due-1",
	title: "Renew passport",
	overdueByDays: 0,
	url: "https://workflowy.com/#/due1",
	ops:
	{
		complete: "./bin/run.js node complete --id due-1",
		reschedule: "x",
		drop: "y",
	},
};

const reminderRow =
{
	source: "reminders",
	id: undefined,
	title: "Call the dentist",
	overdueByDays: 2,
	url: null,
	ops:
	{
		complete: "osascript -e 'complete'",
		reschedule: "x",
		drop: "y",
	},
};

test("skippedThisRun keeps keys whose last outcome since the run start is skip", () =>
{
	const entries = [
		{
			key: "old-skip",
			outcome: "skip",
			date: "2026-11-04",
			at: "2026-11-04T13:00:00.000Z",
		},
		{
			key: "rec-1",
			outcome: "skip",
			date: "2026-11-05",
			at: "2026-11-05T13:05:00.000Z",
		},
		{
			key: "workflowy:due-1",
			outcome: "skip",
			date: "2026-11-05",
			at: "2026-11-05T13:06:00.000Z",
		},
		{
			key: "later-done",
			outcome: "skip",
			date: "2026-11-05",
			at: "2026-11-05T13:07:00.000Z",
		},
		{
			key: "later-done",
			outcome: "done",
			date: "2026-11-05",
			at: "2026-11-05T13:30:00.000Z",
		},
		{
			key: "never-skipped",
			outcome: "done",
			date: "2026-11-05",
			at: "2026-11-05T13:08:00.000Z",
		},
		{
			key: "rec-1",
			outcome: "skip",
			date: "2026-11-05",
			at: "2026-11-05T13:40:00.000Z",
		},
	];
	assert.deepStrictEqual(skippedThisRun(entries, RUN_STARTED), ["rec-1", "workflowy:due-1"]);
});

test("skippedThisRun counts an entry without a timestamp from the start of its day", () =>
{
	const entries = [
		{
			key: "undated-today",
			outcome: "skip",
			date: "2026-11-06",
		},
		{
			key: "undated-yesterday",
			outcome: "skip",
			date: "2026-11-04",
		},
	];
	assert.deepStrictEqual(skippedThisRun(entries, RUN_STARTED), ["undated-today"]);
});

test("skippedThisRun rejects a run start that is not a timestamp", () =>
{
	assert.throws(
		() => skippedThisRun([], "this morning"),
		{
			name: "TypeError",
			message: "--run-started must be an ISO timestamp, got this morning",
		},
	);
});

test("buildSkippedPage stages one Did it / Still skipped card per skipped item, grouped by segment", () =>
{
	const result = buildSkippedPage(
		{
			keys: ["rec-1", "workflowy:due-1", "reminders:Call the dentist", "workflowy:gone"],
			today: "2026-11-05",
			overdueRows: [recurringRow],
			dueRows: [dueRow, reminderRow],
		},
	);
	const options = [
		{
			value: "did",
			label: "Did it",
			description: "Mark it done now, the same way Done does in the walk",
		},
		{
			value: "skip",
			label: "Still skipped",
			description: "Leave it unchanged; it comes back next run",
		},
	];
	assert.deepStrictEqual(
		result,
		{
			page:
			{
				slug: "skipped-2026-11-05",
				title: "Skipped today",
				intro: "Everything you skipped during the daily review. Mark the ones you have since done.",
				groups: [
					{
						heading: "Recurring review",
						items: [
							{
								id: "rec-1",
								title: "Water the plants",
								body: ["Weekly Review", "overdue 4d"],
								links: [
									{
										label: "Open in Workflowy",
										href: "https://workflowy.com/#/rec1",
									},
								],
								options,
								default: "skip",
							},
						],
					},
					{
						heading: "Due tasks",
						items: [
							{
								id: "workflowy:due-1",
								title: "Renew passport",
								body: ["Workflowy", "due today"],
								links: [
									{
										label: "Open in Workflowy",
										href: "https://workflowy.com/#/due1",
									},
								],
								options,
								default: "skip",
							},
							{
								id: "reminders:Call the dentist",
								title: "Call the dentist",
								body: ["Apple Reminders", "overdue 2d"],
								links: [],
								options,
								default: "skip",
							},
						],
					},
					{
						heading: "Not in today's staged rows",
						items: [
							{
								id: "workflowy:gone",
								title: "workflowy:gone",
								body: ["No staged row matches this skip-log key; look it up before marking it done"],
								links: [],
								options,
								default: "skip",
							},
						],
					},
				],
			},
			items: [
				{
					id: "rec-1",
					title: "Water the plants",
					segment: "recurring",
					source: "workflowy",
					done: "./bin/run.js node update --id rec-1 --name 'Water the plants'",
				},
				{
					id: "workflowy:due-1",
					title: "Renew passport",
					segment: "due",
					source: "workflowy",
					done: "./bin/run.js node complete --id due-1",
				},
				{
					id: "reminders:Call the dentist",
					title: "Call the dentist",
					segment: "due",
					source: "reminders",
					done: "osascript -e 'complete'",
				},
				{
					id: "workflowy:gone",
					title: "workflowy:gone",
					segment: null,
					source: null,
					done: null,
				},
			],
		},
	);
});

test("buildSkippedPage omits empty groups and Claude's own #llm-task rows, staging no groups when nothing else was skipped", () =>
{
	const llmRow =
	{
		id: "llm-1",
		name: "Check the routes #llm-task",
		section: "🔄 Weekly Review",
		overdueByDays: 3,
		url: null,
		applyOp: "x",
		isLlmTask: true,
	};
	const untaggedRow =
	{
		...llmRow,
		id: "llm-2",
		name: "Run the sync",
		isLlmTask: false,
		missingLlmTag: true,
	};
	assert.deepStrictEqual(
		buildSkippedPage(
			{
				keys: ["llm-1", "llm-2"],
				today: "2026-11-05",
				overdueRows: [llmRow, untaggedRow],
				dueRows: [],
			},
		),
		{
			page:
			{
				slug: "skipped-2026-11-05",
				title: "Skipped today",
				intro: "Everything you skipped during the daily review. Mark the ones you have since done.",
				groups: [],
			},
			items: [],
		},
	);
});

function withDirectory(body: (directory: string) => void): void
{
	const directory = mkdtempSync(join(tmpdir(), "stage-skipped-page-test-"));
	try
	{
		body(directory);
	}
	finally
	{
		rmSync(
			directory,
			{
				recursive: true,
				force: true,
			},
		);
	}
}

function run(args: string[])
{
	const result = spawnSync(
		process.execPath,
		[script, ...args],
		{
			encoding: "utf8",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

test("the CLI writes the decision page and prints the Did it manifest", () =>
{
	withDirectory((directory) =>
	{
		const skipLog = join(directory, "skip-log.jsonl");
		writeFileSync(
			skipLog,
			`${JSON.stringify(
				{
					key: "rec-1",
					outcome: "skip",
					date: "2026-11-05",
					at: "2026-11-05T13:05:00.000Z",
				},
			)}\n`,
		);
		const overdue = join(directory, "overdue.json");
		writeFileSync(overdue, JSON.stringify([recurringRow]));
		const decisions = join(directory, "decisions");
		const result = run([
			"--run-started",
			RUN_STARTED,
			"--today",
			"2026-11-05",
			"--skip-log",
			skipLog,
			"--overdue",
			overdue,
			"--due-items",
			join(directory, "missing-due-items.json"),
			"--decisions-dir",
			decisions,
		]);
		const expected = buildSkippedPage(
			{
				keys: ["rec-1"],
				today: "2026-11-05",
				overdueRows: [recurringRow],
				dueRows: [],
			},
		);
		assert.deepStrictEqual(
			result,
			{
				status: 0,
				stdout: `${JSON.stringify(
					{
						slug: "skipped-2026-11-05",
						items: expected.items,
					},
					null,
					2,
				)}\n`,
				stderr: "",
			},
		);
		assert.deepStrictEqual(
			JSON.parse(readFileSync(join(decisions, "skipped-2026-11-05.json"), "utf8")),
			expected.page,
		);
	});
});

test("the CLI writes no page when nothing was skipped this run", () =>
{
	withDirectory((directory) =>
	{
		const decisions = join(directory, "decisions");
		const result = run([
			"--run-started",
			RUN_STARTED,
			"--today",
			"2026-11-05",
			"--skip-log",
			join(directory, "missing-skip-log.jsonl"),
			"--decisions-dir",
			decisions,
		]);
		assert.deepStrictEqual(
			{
				...result,
				pageExists: existsSync(join(decisions, "skipped-2026-11-05.json")),
			},
			{
				status: 0,
				stdout: `${JSON.stringify(
					{
						slug: "skipped-2026-11-05",
						items: [],
					},
					null,
					2,
				)}\n`,
				stderr: "",
				pageExists: false,
			},
		);
	});
});

test("the CLI requires --run-started", () =>
{
	assert.deepStrictEqual(
		run(["--today", "2026-11-05"]),
		{
			status: 2,
			stdout: "",
			stderr: "--run-started <ISO timestamp> is required\n",
		},
	);
});
