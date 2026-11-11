#!/usr/bin/env node
// Merge every dated task the daily review is responsible for into one ordered working set.
//
// This is the deterministic half of the Recurring Review's due-items segment. Three sources
// carry dated one-shot tasks -- the Workflowy ⏰ Tasks (due dates) buckets, Things 3, and Apple
// Reminders -- and each one models dates differently. This normalizes all three into a single
// schema, drops anything not yet due, orders the survivors by due date, and stages the exact
// shell command for each outcome so the walk never builds one by hand.
//
// Recurring review items are NOT collected here: they always come back on an interval, so
// compute-overdue.mts owns them. This script owns tasks that should be done once and go away.
//
// Usage:
//   node collect-due-items.mts --workflowy roots.json --things things.json \
//     --reminders reminders.json [--recurring tree.json] [--today YYYY-MM-DD] [--print] [--skip-log path]
//
// Rows carry `skipStreak` folded from the shared skip log that compute-overdue.mts --record
// writes, so the walk can offer a longer horizon to a task it keeps re-asking about.
//
// Every input is optional; a missing source contributes nothing rather than failing.

import {readFileSync} from "node:fs";
import {
	addInterval,
	buildTimeElement,
	DEFAULT_SKIP_LOG_PATH,
	extractLinks,
	isLlmTaskName,
	loadSkipStreaks,
	missingLlmTag,
	nodeContext,
	parseTimeISO,
	stripMarkup,
	swapTimeElement,
	toTreeNode,
	workflowyUrl,
} from "./compute-overdue.mts";
import type {NodeContext, SkipStreak, TreeNode, TreeRoot} from "./compute-overdue.mts";
import {bottomTier, readLadder} from "./asap-tiers.mts";
import {expectArray, expectObject, parseJson, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {takeValue} from "./cli-args.mts";
import {parseIsoDate} from "./iso-date.mts";
import {isMain} from "./is-main.mts";

export type DueSource = "workflowy" | "things" | "reminders";

export interface WorkflowyRootInput {
	rootKey: string;
	root: TreeNode;
}

export interface ThingsTask {
	id: string;
	title: string;
	due?: string | null;
	list?: string | null;
	notes?: string | null;
	activationDate?: string | null;
}

export interface ThingsInput {
	due?: ThingsTask[];
	today?: ThingsTask[];
	anytime?: ThingsTask[];
	someday?: ThingsTask[];
}

export interface Reminder {
	title: string;
	dueDate?: string | null;
	list?: string | null;
	notes?: string | null;
}

export interface RemindersInput {
	overdue?: Reminder[];
	dueToday?: Reminder[];
	dueTomorrow?: Reminder[];
}

export interface DueOps {
	complete: string;
	reschedule: string;
	drop: string;
	moveToAsap?: string;
}

export interface DueRow extends NodeContext {
	source: DueSource;
	rootKey: string | null;
	id: string | undefined;
	title: string;
	name: string;
	due: string | null;
	dueSource: "deadline" | "scheduled" | null;
	overdueByDays: number | null;
	needsDate: boolean;
	// True when the item carries `#llm-task`: Claude runs it, so it never belongs on a batch page.
	isLlmTask: boolean;
	// Children say Claude runs it, but the name lacks #llm-task. Only Workflowy tasks have children.
	missingLlmTag: boolean;
	group: string;
	url: string | null;
	ops: DueOps;
}

export interface RecurringCounterpart {
	id: string | undefined;
	title: string;
	path: string;
	nextDate: string | null;
	url: string | null;
}

export interface DueSources {
	workflowy?: WorkflowyRootInput[] | null;
	things?: ThingsInput | null;
	reminders?: RemindersInput | null;
	recurring?: TreeRoot | null;
}

const DUE_BUCKET_PREFIX = "⏰";
const TASKS_WRAPPER_PREFIX = "✅";
const ASAP_BUCKET_PREFIX = "📌";
// Legacy containers from before due dates lived on the nodes themselves. Tasks nest one level
// deeper inside these, so the collector descends through them until the data is migrated.
const TIMEFRAME_NAMES = new Set(["Today", "This week", "This month"]);
// Only Workflowy tasks have a subtree. A Things or Reminders task is its title plus its note, and
// it still fills the same context shape so the walk prints one block without branching on source.
function noteOnlyContext(title: string, notes: string | null | undefined): NodeContext {
	return {note: notes ?? null, modifiedAt: null, childCount: 0, children: [], links: extractLinks(title, notes)};
}

const pad = (n: number): string => String(n).padStart(2, "0");

function shellSingleQuote(s: string): string {
	return `'${s.replaceAll("'", `'"'"'`)}'`;
}

function daysBetween(fromISO: string, toISO: string): number {
	const a = new Date(`${fromISO}T00:00:00Z`);
	const b = new Date(`${toISO}T00:00:00Z`);
	return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function addDaysISO(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month1: number): number {
	return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

// file-tasks proposes a timeframe; the node stores a date. This is the conversion between them,
// and it is the only place that mapping lives.
export function resolveTimeframe(label: string, todayISO: string): string {
	const {year: y, month: m, day: d} = parseIsoDate(todayISO);
	if (/^today$/iu.test(label)) {
		return todayISO;
	}
	if (/^this week$/iu.test(label)) {
		// End of the working week: the upcoming Friday, or today when today already is Friday.
		const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
		const until = (5 - dow + 7) % 7;
		const dt = new Date(Date.UTC(y, m - 1, d + until));
		return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
	}
	if (/^this month$/iu.test(label)) {
		return `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`;
	}
	// The long horizons exist for tasks the walk keeps re-asking about: pushing one out by a
	// quarter is the honest alternative to nudging it a week at a time forever.
	if (/^next month$/iu.test(label)) {
		return addInterval(todayISO, {amount: 1, unit: "m"});
	}
	if (/^next quarter$/iu.test(label)) {
		return addInterval(todayISO, {amount: 3, unit: "m"});
	}
	throw new Error(`unknown timeframe: ${label}`);
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

// AppleScript's `date "..."` parses a plain human date. Workflowy's `<time>` element is HTML and
// means nothing to it, so the two sources need different substitutions for the same placeholder.
function appleScriptDate(iso: string): string {
	const {year: y, month: m, day: d} = parseIsoDate(iso);
	const monthName = MONTH_NAMES[m - 1];
	if (monthName === undefined) {
		throw new Error(`Invalid month in date: ${iso}`);
	}
	return `${monthName} ${d}, ${y}`;
}

/**
 * Fill a row's `reschedule` template for the new date, choosing the representation the row's
 * source actually understands. Callers pass an ISO date and never format it themselves — picking
 * the wrong one silently writes a garbage date rather than failing.
 */
export function applyReschedule(item: {source: DueSource; ops: {reschedule: string}}, iso: string): string {
	const replacement = item.source === "workflowy" ? buildTimeElement(iso) : appleScriptDate(iso);
	return item.ops.reschedule.split("{{date}}").join(replacement);
}

function workflowyOps(node: TreeNode, due: string | null, asapTargetId: string | null | undefined): DueOps {
	// The reschedule op is a template: substitute {{date}} with buildTimeElement(iso) to get the
	// runnable command. Keeping the element out of the template means the weekday label is always
	// computed, never typed.
	const rescheduledName = due ? swapTimeElement(node.name, "{{date}}") : `${node.name.replace(/\s+$/u, "")} {{date}}`;
	const ops: DueOps = {
		complete: `./bin/run.js node complete --id ${node.id}`,
		reschedule: `./bin/run.js node update --id ${node.id} --name ${shellSingleQuote(rescheduledName)}`,
		drop: `./bin/run.js node delete --id ${node.id}`,
	};

	// Not every overdue task actually has a deadline. Without this outcome the walk can only push
	// the date forward, so an undeadlined task resurfaces every run forever. Moving it to the asap
	// bucket is the real fix, and the date has to come off because that bucket holds none.
	if (asapTargetId) {
		const undatedName = node.name
			.replaceAll(/<time[^>]*>.*?<\/time>/gu, "")
			.replaceAll(/\s+/gu, " ")
			.trim();
		ops.moveToAsap = `./bin/run.js node update --id ${node.id} --name ${shellSingleQuote(undatedName)} && ./bin/run.js node move --node-id ${node.id} --parent-id ${asapTargetId} -p bottom`;
	}

	return ops;
}

export function fromWorkflowy(roots: WorkflowyRootInput[] | null | undefined, todayISO: string): DueRow[] {
	const items: DueRow[] = [];

	for (const {rootKey, root} of roots ?? []) {
		const wrapper = (root.children ?? []).find((c) => c.name.startsWith(TASKS_WRAPPER_PREFIX));
		const containers = wrapper ? (wrapper.children ?? []) : (root.children ?? []);
		const bucket = containers.find((c) => c.name.startsWith(DUE_BUCKET_PREFIX));
		if (!bucket) {
			continue;
		}
		const asapBucket = containers.find((c) => c.name.startsWith(ASAP_BUCKET_PREFIX));
		// A task with no real deadline is not urgent, so it joins the bottom rung of the asap
		// ladder rather than the top of the bucket. A bucket still carrying category containers
		// has no ladder yet, and falls back to the bucket root until file-tasks migrates it.
		const asapTarget = asapBucket ? (bottomTier(readLadder(asapBucket))?.id ?? asapBucket.id) : null;

		// Only the bucket's own children (and those of a legacy timeframe container) are tasks.
		// A task's children are sub-steps, notes, and provenance -- never tasks in their own right.
		const taskGroups: {group: string | null; nodes: TreeNode[]}[] = [];
		for (const child of bucket.children ?? []) {
			if (TIMEFRAME_NAMES.has(child.name.trim())) {
				taskGroups.push({group: child.name.trim(), nodes: child.children ?? []});
			} else {
				taskGroups.push({group: null, nodes: [child]});
			}
		}

		for (const {group, nodes} of taskGroups) {
			for (const node of nodes) {
				if (node.completedAt != null && node.completedAt !== "" && node.completedAt !== 0) {
					continue;
				}
				const due = parseTimeISO(node.name);
				items.push({
					source: "workflowy",
					rootKey,
					id: node.id,
					title: stripMarkup(node.name),
					name: node.name,
					due,
					dueSource: due ? "deadline" : null,
					overdueByDays: due ? daysBetween(due, todayISO) : null,
					needsDate: due === null,
					isLlmTask: isLlmTaskName(node.name),
					missingLlmTag: missingLlmTag(node),
					group: group ?? bucket.name,
					url: workflowyUrl(node.shortId),
					...nodeContext(node),
					ops: workflowyOps(node, due, asapTarget),
				});
			}
		}
	}

	return items;
}

function thingsOps(id: string): DueOps {
	const complete = `tell application "Things3" to set status of to do id "${id}" to completed`;
	const drop = `tell application "Things3" to set status of to do id "${id}" to canceled`;
	const reschedule = `tell application "Things3" to set due date of to do id "${id}" to date "{{date}}"`;
	return {
		complete: `osascript -e ${shellSingleQuote(complete)}`,
		reschedule: `osascript -e ${shellSingleQuote(reschedule)}`,
		drop: `osascript -e ${shellSingleQuote(drop)}`,
	};
}

export function fromThings(things: ThingsInput | null | undefined, todayISO: string): DueRow[] {
	if (!things) {
		return [];
	}
	const seen = new Set<string>();
	const items: DueRow[] = [];

	// `due` first so a task carrying a real deadline keeps that framing even when it also sits
	// in the Today list.
	const tagged: {task: ThingsTask; dueSource: "deadline" | "scheduled"}[] = [
		...(things.due ?? []).map((task) => ({task, dueSource: "deadline" as const})),
		...(things.today ?? []).map((task) => ({
			task,
			dueSource: task.due ? ("deadline" as const) : ("scheduled" as const),
		})),
	];

	for (const {task, dueSource} of tagged) {
		if (seen.has(task.id)) {
			continue;
		}
		seen.add(task.id);
		// A Today-list task without a deadline is not undated work. Things putting it in Today is
		// itself the due signal, so it dates to when Things activated it -- a repeating chore left
		// over from Tuesday is Tuesday's chore -- or to today when that is unknown or later.
		const activated = task.activationDate && task.activationDate < todayISO ? task.activationDate : todayISO;
		const due = task.due ?? activated;
		items.push({
			source: "things",
			rootKey: null,
			id: task.id,
			title: task.title,
			name: task.title,
			due,
			dueSource,
			overdueByDays: daysBetween(due, todayISO),
			needsDate: false,
			isLlmTask: isLlmTaskName(task.title),
			missingLlmTag: false,
			group: task.list ?? "Things",
			url: `things:///show?id=${task.id}`,
			...noteOnlyContext(task.title, task.notes),
			ops: thingsOps(task.id),
		});
	}

	return items;
}

function remindersOps(title: string): DueOps {
	// iMCP exposes no write tools and reminders carry no stable id here, so every op matches on
	// title through AppleScript -- the same bridge overview.md already documents.
	const target = `reminders of list "Reminders" whose completed is false and name is "${title}"`;
	const script = (body: string): string =>
		`osascript -e ${shellSingleQuote(`tell application "Reminders"\nset matches to (${target})\nif (count of matches) > 0 then ${body}\nend tell`)}`;
	return {
		complete: script("set completed of (item 1 of matches) to true"),
		reschedule: script('set due date of (item 1 of matches) to date "{{date}}"'),
		drop: script("delete (item 1 of matches)"),
	};
}

export function fromReminders(reminders: RemindersInput | null | undefined, todayISO: string): DueRow[] {
	if (!reminders) {
		return [];
	}
	// dueTomorrow is deliberately excluded: the walk is for what is due now, not a preview.
	return [...(reminders.overdue ?? []), ...(reminders.dueToday ?? [])].map((r): DueRow => {
		const due = r.dueDate ? r.dueDate.slice(0, 10) : null;
		return {
			source: "reminders",
			rootKey: null,
			id: r.title,
			title: r.title,
			name: r.title,
			due,
			dueSource: due ? "deadline" : null,
			overdueByDays: due ? daysBetween(due, todayISO) : null,
			needsDate: false,
			isLlmTask: isLlmTaskName(r.title),
			missingLlmTag: false,
			group: r.list ?? "Reminders",
			url: null,
			...noteOnlyContext(r.title, r.notes),
			ops: remindersOps(r.title),
		};
	});
}

// Ids are only unique within their own system, so the shared skip log namespaces them by source.
export function skipKey(item: {source: string; id: string | undefined}): string {
	return `${item.source}:${item.id}`;
}

const titleKey = (row: {title: string}): string =>
	stripMarkup(row.title).normalize("NFKC").toLowerCase().replaceAll(/\s+/gu, " ").trim();

export function attachRecurringCounterparts<Row extends {source: string; id?: string; title: string}>(
	rows: Row[],
	tree: TreeRoot,
): (Row & {recurringCounterparts: RecurringCounterpart[]})[] {
	const byTitle = new Map<string, RecurringCounterpart[]>();
	function walk(node: TreeNode, ancestors: string[]): void {
		if (
			(node.completedAt != null && node.completedAt !== "" && node.completedAt !== 0) ||
			node.mirror?.isMirror ||
			node.name.includes("🗃️ Routine Archive")
		) {
			return;
		}
		const title = stripMarkup(node.name);
		const path = [...ancestors, title];
		const counterpart: RecurringCounterpart = {
			id: node.id,
			title,
			path: path.join(" > "),
			nextDate: parseTimeISO(node.name),
			url: workflowyUrl(node.shortId ?? node.id),
		};
		const key = titleKey(counterpart);
		if (key) {
			byTitle.set(key, [...(byTitle.get(key) ?? []), counterpart]);
		}
		for (const child of node.children ?? []) {
			walk(child, path);
		}
	}
	for (const section of tree.children ?? []) {
		walk(section, ["Personal", "🔄 Review"]);
	}
	return rows.map((row) => ({
		...row,
		recurringCounterparts: (byTitle.get(titleKey(row)) ?? []).filter(
			(candidate) => row.source !== "workflowy" || candidate.id !== row.id,
		),
	}));
}

export function groupCrossSourceDuplicates<Row extends {source: string; title: string}>(
	rows: Row[],
): (Row & {duplicateCopies?: Row[]})[] {
	const workflowyByTitle = new Map<string, Row[]>();
	for (const row of rows) {
		if (row.source !== "workflowy") {
			continue;
		}
		const key = titleKey(row);
		workflowyByTitle.set(key, [...(workflowyByTitle.get(key) ?? []), row]);
	}
	const copiesBySurvivor = new Map<Row, Row[]>();
	const groupedCopies = new Set<Row>();
	for (const row of rows) {
		if (row.source === "workflowy") {
			continue;
		}
		const key = titleKey(row);
		const matches = workflowyByTitle.get(key) ?? [];
		// A title shared by multiple Workflowy tasks cannot identify a survivor.
		const [survivor] = matches;
		if (!key || matches.length !== 1 || !survivor) {
			continue;
		}
		copiesBySurvivor.set(survivor, [...(copiesBySurvivor.get(survivor) ?? []), row]);
		groupedCopies.add(row);
	}
	return rows
		.filter((row) => !groupedCopies.has(row))
		.map((row) => {
			const duplicateCopies = copiesBySurvivor.get(row);
			return duplicateCopies ? {...row, duplicateCopies} : row;
		});
}

export function collectDueItems(
	sources: DueSources,
	todayISO: string,
	{
		skipStreaks = new Map<string, SkipStreak>(),
		horizonDays = 0,
	}: {skipStreaks?: Map<string, SkipStreak>; horizonDays?: number} = {},
) {
	let rows: (DueRow & {
		skipStreak: number;
		skippedSince: string | null;
		recurringCounterparts?: RecurringCounterpart[];
	})[] = [
		...fromWorkflowy(sources.workflowy, todayISO),
		...fromThings(sources.things, todayISO),
		...fromReminders(sources.reminders, todayISO),
	].map((row) => {
		const streak = skipStreaks.get(skipKey(row)) ?? null;
		return {...row, skipStreak: streak?.skipStreak ?? 0, skippedSince: streak?.skippedSince ?? null};
	});

	if (sources.recurring) {
		rows = attachRecurringCounterparts(rows, sources.recurring);
	}

	// A positive horizon also admits items due soon; their overdueByDays comes out negative.
	const lastDueISO = addDaysISO(todayISO, horizonDays);
	// Undated items sort last: they still need handling, but a real deadline outranks a maybe.
	return groupCrossSourceDuplicates(rows.filter((r) => r.due === null || r.due <= lastDueISO)).toSorted((a, b) => {
		if (a.due === null && b.due === null) {
			return 0;
		}
		if (a.due === null) {
			return 1;
		}
		if (b.due === null) {
			return -1;
		}
		return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
	});
}

function localTodayISO(): string {
	const now = new Date();
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readJSON(path: string | null): unknown {
	return path ? parseJson(readFileSync(path, "utf8")) : null;
}

/** An optional string field: absent and null read as null, anything else that is not a string is rejected. */
function optionalString(object: JsonObject, key: string, where: string): string | null {
	const value = object[key];
	if (value == null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new TypeError(`${where}.${key} must be a string`);
	}
	return value;
}

function requiredString(object: JsonObject, key: string, where: string): string {
	const value = stringField(object, key);
	if (value === undefined) {
		throw new TypeError(`${where}.${key} must be a string`);
	}
	return value;
}

function toWorkflowyRoots(value: unknown): WorkflowyRootInput[] | null {
	if (value === null) {
		return null;
	}
	return expectArray(value, "--workflowy").map((entry, index) => {
		const where = `--workflowy[${index}]`;
		const object = expectObject(entry, where);
		return {
			rootKey: requiredString(object, "rootKey", where),
			root: toTreeNode(object.root, `${where}.root`),
		};
	});
}

function toThingsTasks(value: unknown, where: string): ThingsTask[] | undefined {
	if (value == null) {
		return undefined;
	}
	return expectArray(value, where).map((entry, index) => {
		const at = `${where}[${index}]`;
		const object = expectObject(entry, at);
		return {
			id: requiredString(object, "id", at),
			title: requiredString(object, "title", at),
			due: optionalString(object, "due", at),
			list: optionalString(object, "list", at),
			notes: optionalString(object, "notes", at),
			activationDate: optionalString(object, "activationDate", at),
		};
	});
}

function toThingsInput(value: unknown): ThingsInput | null {
	if (value === null) {
		return null;
	}
	const object = expectObject(value, "--things");
	return {
		due: toThingsTasks(object.due, "--things.due"),
		today: toThingsTasks(object.today, "--things.today"),
	};
}

function toReminders(value: unknown, where: string): Reminder[] | undefined {
	if (value == null) {
		return undefined;
	}
	return expectArray(value, where).map((entry, index) => {
		const at = `${where}[${index}]`;
		const object = expectObject(entry, at);
		return {
			title: requiredString(object, "title", at),
			dueDate: optionalString(object, "dueDate", at),
			list: optionalString(object, "list", at),
			notes: optionalString(object, "notes", at),
		};
	});
}

function toRemindersInput(value: unknown): RemindersInput | null {
	if (value === null) {
		return null;
	}
	const object = expectObject(value, "--reminders");
	return {
		overdue: toReminders(object.overdue, "--reminders.overdue"),
		dueToday: toReminders(object.dueToday, "--reminders.dueToday"),
	};
}

function main(argv: string[]): void {
	const args = argv.slice(2);
	const paths: Record<"workflowy" | "things" | "reminders" | "recurring", string | null> = {
		workflowy: null,
		things: null,
		reminders: null,
		recurring: null,
	};
	let today = localTodayISO();
	let print = false;
	let skipLogPath = DEFAULT_SKIP_LOG_PATH;
	let horizonDays = 0;
	const argIterator = args[Symbol.iterator]();
	for (const arg of argIterator) {
		if (arg === "--today") {
			today = takeValue(argIterator, arg);
		} else if (arg === "--print") {
			print = true;
		} else if (arg === "--skip-log") {
			skipLogPath = takeValue(argIterator, arg);
		} else if (arg === "--horizon-days") {
			horizonDays = Number(takeValue(argIterator, arg));
		} else if (arg === "--workflowy") {
			paths.workflowy = takeValue(argIterator, arg);
		} else if (arg === "--things") {
			paths.things = takeValue(argIterator, arg);
		} else if (arg === "--reminders") {
			paths.reminders = takeValue(argIterator, arg);
		} else if (arg === "--recurring") {
			paths.recurring = takeValue(argIterator, arg);
		}
	}

	const rows = collectDueItems(
		{
			workflowy: toWorkflowyRoots(readJSON(paths.workflowy)),
			things: toThingsInput(readJSON(paths.things)),
			reminders: toRemindersInput(readJSON(paths.reminders)),
			recurring: paths.recurring ? toTreeNode(readJSON(paths.recurring), paths.recurring) : null,
		},
		today,
		{skipStreaks: loadSkipStreaks(skipLogPath), horizonDays},
	);

	if (!print) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		return;
	}

	for (const r of rows) {
		const days = r.overdueByDays ?? 0;
		const lateness = days < 0 ? `in ${-days}d` : `overdue ${days}d`;
		const when = r.due ? `due ${r.due} (${lateness})` : "⚠️ no date";
		const streak = r.skipStreak >= 2 ? ` ⏭️ skipped ${r.skipStreak}x` : "";
		process.stdout.write(`  [${r.source}] ${when}${streak} — ${r.title.slice(0, 90)}\n`);
	}
	const undated = rows.filter((r) => r.needsDate).length;
	process.stdout.write(`\nTOTAL DUE: ${rows.length}${undated ? ` (${undated} missing a date)` : ""}\n`);
}

export {buildTimeElement};

if (isMain(import.meta.url)) {
	main(process.argv);
}
