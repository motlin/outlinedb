#!/usr/bin/env node
// Stage the end-of-run "Skipped today" decision page for the daily review.
//
// Reads the skip log for items whose last outcome since the run started is `skip`, looks each one up
// in the staged `overdue.json` (recurring review) and `due-items.json` (one-shot due tasks), and stages
// a checklist row per item (checked answers `did`, unchecked `skip`) at `<decisions-dir>/skipped-<today>.json`. Writes no page when
// nothing was skipped.
//
// Usage:
//   node stage-skipped-page.mts --run-started ISO [--today YYYY-MM-DD] [--skip-log path]
//     [--overdue path] [--due-items path] [--decisions-dir dir]
//
// Prints `{slug, items}` to stdout: each item's skip-log key, title, segment, source, and the staged
// `done` command that a Did it answer runs (the recurring row's `applyOp` or the due row's
// `ops.complete`). The walk records the outcome itself with `compute-overdue.mts --record`.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {takeValue} from "./cli-args.mts";
import {DEFAULT_SKIP_LOG_PATH, localTodayISO, parseSkipLog, stripMarkup} from "./compute-overdue.mts";
import type {SkipEntry} from "./compute-overdue.mts";
import {isObject, readJsonFile} from "./json.mts";
import {isMain} from "./is-main.mts";

/** Keys whose last skip-log outcome at or after `runStartedISO` is `skip`, in first-seen order. */
export function skippedThisRun(entries: readonly SkipEntry[], runStartedISO: string): string[]
{
	const started = Date.parse(runStartedISO);
	if (Number.isNaN(started))
	{
		throw new TypeError(`--run-started must be an ISO timestamp, got ${runStartedISO}`);
	}
	const last = new Map<string, string>();
	for (const entry of entries)
	{
		// An entry without a timestamp only knows its day, so it counts from that day's start.
		if (Date.parse(entry.at ?? `${entry.date}T00:00:00Z`) >= started)
		{
			last.set(entry.key, entry.outcome);
		}
	}
	return [...last].filter(([, outcome]) => outcome === "skip").map(([key]) => key);
}

export interface SkippedOverdueRow
{
	id?: string | undefined;
	name: string;
	section: string;
	overdueByDays: number;
	url: string | null;
	applyOp: string | null;
	isLlmTask?: boolean | undefined;
	missingLlmTag?: boolean | undefined;
}

export interface SkippedDueRow
{
	source: string;
	id?: string | undefined;
	title: string;
	overdueByDays: number | null;
	url: string | null;
	ops:
	{
		complete: string;
	};
}

interface Link
{
	label: string;
	href: string;
}

interface Card
{
	id: string;
	title: string;
	body: string[];
	links: Link[];
	options:
	{
		value: string;
		label: string;
		description: string;
	}[];
	default: string;
}

export interface SkippedManifestItem
{
	id: string;
	title: string;
	segment: "recurring" | "due" | null;
	source: string | null;
	done: string | null;
}

const OPTIONS = [
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

const SOURCE_LABELS: Record<string, string> =
{
	workflowy: "Workflowy",
	things: "Things 3",
	reminders: "Apple Reminders",
};

function lateness(days: number | null): string
{
	if (days === null)
	{
		return "no date";
	}
	if (days === 0)
	{
		return "due today";
	}
	return days > 0 ? `overdue ${days}d` : `due in ${-days}d`;
}

/** The checklist row's one muted line: where the item lives and how late it is. */
function subtitle(where: string, days: number | null): string
{
	return `${where} · ${lateness(days)}`;
}

function workflowyLink(url: string | null): Link[]
{
	return url
		? [
				{
					label: "Open in Workflowy",
					href: url,
				},
			]
		: [];
}

function card(id: string, title: string, body: string[], links: Link[]): Card
{
	return {
		id,
		title,
		body,
		links,
		options: OPTIONS,
		default: "skip",
	};
}

/** The skip-log keys a due row can be recorded under; a reminder has no id, so it is keyed by title. */
function dueKeys(row: SkippedDueRow): string[]
{
	const keys = [`${row.source}:${row.id}`];
	if (row.source === "reminders")
	{
		keys.push(`reminders:${row.title}`);
	}
	return keys;
}

export function buildSkippedPage({
	keys,
	today,
	overdueRows,
	dueRows,
}: {
	keys: readonly string[];
	today: string;
	overdueRows: readonly SkippedOverdueRow[];
	dueRows: readonly SkippedDueRow[];
})
{
	// Claude runs #llm-task rows (tagged or not yet tagged) itself; a skip there means it was blocked, not
	// that the user owes it, so those rows never become a card for the user.
	const claudeRuns = new Set(overdueRows.filter((row) => row.isLlmTask || row.missingLlmTag).map((row) => row.id));
	const overdueByKey = new Map(overdueRows.filter((row) => row.id).map((row) => [row.id, row]));
	const dueByKey = new Map(dueRows.flatMap((row) => dueKeys(row).map((key) => [key, row] as const)));

	const recurring: Card[] = [];
	const due: Card[] = [];
	const unmatched: Card[] = [];
	const items: SkippedManifestItem[] = [];

	for (const key of keys)
	{
		if (claudeRuns.has(key))
		{
			continue;
		}
		const overdue = overdueByKey.get(key);
		const dueRow = dueByKey.get(key);
		if (overdue)
		{
			const title = stripMarkup(overdue.name);
			recurring.push(
				card(key, title, [subtitle(overdue.section, overdue.overdueByDays)], workflowyLink(overdue.url)),
			);
			items.push(
				{
					id: key,
					title,
					segment: "recurring",
					source: "workflowy",
					done: overdue.applyOp,
				},
			);
		}
		else if (dueRow)
		{
			const body = [subtitle(SOURCE_LABELS[dueRow.source] ?? dueRow.source, dueRow.overdueByDays)];
			due.push(card(key, dueRow.title, body, workflowyLink(dueRow.url)));
			items.push(
				{
					id: key,
					title: dueRow.title,
					segment: "due",
					source: dueRow.source,
					done: dueRow.ops.complete,
				},
			);
		}
		else
		{
			const body = ["No staged row matches this skip-log key; look it up before marking it done"];
			unmatched.push(card(key, key, body, []));
			items.push(
				{
					id: key,
					title: key,
					segment: null,
					source: null,
					done: null,
				},
			);
		}
	}

	const groups = [
		{
			heading: "Recurring review",
			items: recurring,
		},
		{
			heading: "Due tasks",
			items: due,
		},
		{
			heading: "Not in today's staged rows",
			items: unmatched,
		},
	].filter((group) => group.items.length > 0);

	return {
		page:
		{
			slug: `skipped-${today}`,
			title: "Skipped today",
			intro: "Everything you skipped during the daily review. Check the ones you have since done.",
			layout: "checklist",
			groups,
		},
		items,
	};
}

function readRows<Row>(path: string): Row[]
{
	if (!existsSync(path))
	{
		return [];
	}
	const value = readJsonFile(path);
	return Array.isArray(value) ? value.filter((row): row is Row => isObject(row)) : [];
}

function main(argv: string[]): void
{
	let runStarted: string | null = null;
	let today = localTodayISO();
	let skipLogPath = DEFAULT_SKIP_LOG_PATH;
	let overduePath = ".llm/gtd/review/overdue.json";
	let dueItemsPath = ".llm/gtd/review/due-items.json";
	let decisionsDir = ".llm/gtd/review/decisions";
	const argIterator = argv.slice(2)[Symbol.iterator]();
	for (const arg of argIterator)
	{
		if (arg === "--run-started")
		{
			runStarted = takeValue(argIterator, arg);
		}
		else if (arg === "--today")
		{
			today = takeValue(argIterator, arg);
		}
		else if (arg === "--skip-log")
		{
			skipLogPath = takeValue(argIterator, arg);
		}
		else if (arg === "--overdue")
		{
			overduePath = takeValue(argIterator, arg);
		}
		else if (arg === "--due-items")
		{
			dueItemsPath = takeValue(argIterator, arg);
		}
		else if (arg === "--decisions-dir")
		{
			decisionsDir = takeValue(argIterator, arg);
		}
	}
	if (runStarted === null)
	{
		process.stderr.write("--run-started <ISO timestamp> is required\n");
		process.exit(2);
	}

	const entries = existsSync(skipLogPath) ? parseSkipLog(readFileSync(skipLogPath, "utf8")) : [];
	const {page, items} = buildSkippedPage(
		{
			keys: skippedThisRun(entries, runStarted),
			today,
			overdueRows: readRows<SkippedOverdueRow>(overduePath),
			dueRows: readRows<SkippedDueRow>(dueItemsPath),
		},
	);
	if (items.length > 0)
	{
		mkdirSync(
			decisionsDir,
			{
				recursive: true,
			},
		);
		writeFileSync(join(decisionsDir, `${page.slug}.json`), `${JSON.stringify(page, null, 2)}\n`);
	}
	process.stdout.write(
		`${JSON.stringify(
			{
				slug: page.slug,
				items,
			},
			null,
			2,
		)}\n`,
	);
}

if (isMain(import.meta.url))
{
	main(process.argv);
}
