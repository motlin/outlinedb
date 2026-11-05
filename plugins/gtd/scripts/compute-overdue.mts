#!/usr/bin/env node
// Compute the overdue recurring-review items from a fetched review tree.
//
// This is the deterministic half of the daily review's Recurring Review.
// It parses each recurring leaf item's <time> element, finds the ones due on or
// before today, and stages the exact update that advances each item from its section's
// interval. The Phase 0 planner imports the shared date helpers from this module.
//
// Usage:
//   node compute-overdue.mts [tree.json] [--today YYYY-MM-DD] [--print] [--skip-log path] [--run-started ISO]
//   node compute-overdue.mts --record <itemId> --outcome <skip|done|lengthen|retire|...>
//
// Default tree path: .llm/gtd/review/tree.json. Default today: the local date.
// Without --print, emits the overdue rows as JSON to stdout.
//
// --run-started drops every row whose skip-log entry has any outcome at or after that timestamp, so a
// recompute after a midnight rollover never re-asks an item already answered this run.
//
// --record appends one outcome to the skip log so the next run knows how many times in a row an
// item was skipped. Each row then carries `skipStreak` plus a staged `lengthen` op that moves the
// item to the next longer cadence -- repeated skipping usually means the cadence is wrong.
//
// The section -> interval table mirrors plugins/gtd/skills/review-date-updates.md;
// this script is the executable source of truth for it.

import {appendFileSync, mkdirSync, readFileSync} from "node:fs";
import {dirname} from "node:path";
import {isObject, parseJson, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";
import {takeValue} from "./cli-args.mts";
import {parseIsoDate} from "./iso-date.mts";

export type IntervalUnit = "d" | "m" | "y";

export interface Interval {
	amount: number;
	unit: IntervalUnit;
}

/** A fetched subtree's root, whose own fields the walks never read. */
export interface TreeRoot {
	children?: TreeNode[];
}

/** A Workflowy node as `node get --json` emits it; only the fields these scripts read are typed. */
export interface TreeNode extends TreeRoot {
	name: string;
	id?: string;
	shortId?: string | null;
	note?: string | null;
	modifiedAt?: string | null;
	completedAt?: string | number | null;
	priority?: number | null;
	mirror?: {isMirror?: boolean | null};
}

function optionalString(object: JsonObject, key: string, where: string): string | null | undefined {
	const value = object[key];
	if (value == null || typeof value === "string") {
		return value;
	}
	throw new TypeError(`${where}.${key} must be a string`);
}

/**
 * Narrow parsed JSON to a TreeNode, checking every typed field down the whole subtree. Fields the
 * scripts never read pass through untouched, and a null name (a blank Workflowy bullet) reads as "".
 */
export function toTreeNode(value: unknown, where = "node"): TreeNode {
	if (!isObject(value)) {
		throw new TypeError(`${where} must be a JSON object`);
	}
	const name = optionalString(value, "name", where) ?? "";
	const id = optionalString(value, "id", where) ?? undefined;
	const {completedAt, priority, mirror, children} = value;
	if (completedAt != null && typeof completedAt !== "string" && typeof completedAt !== "number") {
		throw new TypeError(`${where}.completedAt must be a string or number`);
	}
	if (priority != null && typeof priority !== "number") {
		throw new TypeError(`${where}.priority must be a number`);
	}
	if (mirror != null && !isObject(mirror)) {
		throw new TypeError(`${where}.mirror must be an object`);
	}
	const isMirror = mirror?.isMirror;
	if (isMirror != null && typeof isMirror !== "boolean") {
		throw new TypeError(`${where}.mirror.isMirror must be a boolean`);
	}
	if (children != null && !Array.isArray(children)) {
		throw new TypeError(`${where}.children must be an array`);
	}
	return {
		...value,
		name,
		id,
		shortId: optionalString(value, "shortId", where),
		note: optionalString(value, "note", where),
		modifiedAt: optionalString(value, "modifiedAt", where),
		completedAt,
		priority,
		mirror: mirror == null ? undefined : {...mirror, isMirror},
		children: children?.map((child, index) => toTreeNode(child, `${where}.children[${index}]`)),
	};
}

/** Read a JSON file that must hold one TreeNode. */
export function readTreeFile(path: string): TreeNode {
	return toTreeNode(parseJson(readFileSync(path, "utf8")), path);
}

const SECTION_INTERVALS: [string, Interval][] = [
	["Daily Review", {amount: 1, unit: "d"}],
	["Frequently Important", {amount: 1, unit: "d"}],
	["Low priority daily", {amount: 1, unit: "d"}],
	["Do goals for today", {amount: 1, unit: "d"}],
	["Weekly Review", {amount: 7, unit: "d"}],
	["Every 4 weeks", {amount: 28, unit: "d"}],
	["Monthly Review", {amount: 1, unit: "m"}],
	["Every 2 months", {amount: 2, unit: "m"}],
	["Every 6 months", {amount: 6, unit: "m"}],
	["Annual Review", {amount: 1, unit: "y"}],
];

const TIME_RE = /<time[^>]*startYear="(\d+)"[^>]*startMonth="(\d+)"[^>]*startDay="(\d+)"[^>]*>.*?<\/time>/u;

const pad = (n: number): string => String(n).padStart(2, "0");

export function parseTimeISO(name: string): string | null {
	const m = name.match(TIME_RE);
	return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : null;
}

/** Node text as a human reads it: no <time> element, no tags, no other HTML. */
export function stripMarkup(name: string): string {
	return name
		.replaceAll(/<time[^>]*>.*?<\/time>/gu, "")
		.replaceAll(/<[^>]+>/gu, "")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

export function workflowyUrl(shortId: string | null | undefined): string | null {
	return shortId ? `https://workflowy.com/#/${shortId}` : null;
}

const HREF_RE = /href="([^"]+)"/gu;
const BARE_URL_RE = /https?:\/\/[^\s"'<>)]+/gu;

const WORKFLOWY_HOST_RE = /^https?:\/\/([^/?#]*\.)?workflowy\.com(?=[/?#]|$)/iu;

/**
 * Every external http(s) URL reachable from a node's own text, in the order a reader meets them.
 *
 * Workflowy permalinks are dropped. The walk opens every link this returns, and a
 * `workflowy.com/#/…` link boots the Workflowy SPA for seconds to show a node whose text the
 * question already carries. Those links are common -- every `@mention ↗` is one -- so filtering
 * here is what keeps "open the links" from meaning "interrupt the user with a slow tab".
 */
export function extractLinks(...texts: (string | null | undefined)[]): string[] {
	const urls: string[] = [];
	for (const text of texts) {
		if (!text) {
			continue;
		}
		const str = text;
		for (const [, href] of str.matchAll(HREF_RE)) {
			if (href !== undefined) {
				urls.push(href);
			}
		}
		for (const m of str.matchAll(BARE_URL_RE)) {
			urls.push(m[0].replace(/[.,;:]+$/u, ""));
		}
	}
	return [...new Set(urls.filter((u) => /^https?:\/\//u.test(u) && !WORKFLOWY_HOST_RE.test(u)))];
}

/**
 * Everything the walk shows the user *before* asking what to do with an item: the note, when it
 * last moved, and the child titles. An item is unanswerable without its subtree -- "Inventory the
 * drives" with 71 children is a different question from the same title with none -- so the working
 * set carries the context rather than making the walk fetch it one item at a time.
 */
export interface ChildContext {
	title: string;
	note: string | null;
	childCount: number;
	url: string | null;
}

export interface NodeContext {
	note: string | null;
	modifiedAt: string | null;
	childCount: number;
	children: ChildContext[];
	links: string[];
}

export function nodeContext(node: TreeNode): NodeContext {
	// A recurring item that mirrors a bucket accumulates finished children. Reading those
	// aloud as live candidates is how the walk asks about work that is already done, so
	// completed children are dropped here and childCount reports the open count only.
	const kids = (node.children ?? []).filter((kid) => kid.completedAt == null);
	return {
		note: node.note ?? null,
		modifiedAt: node.modifiedAt ?? null,
		childCount: kids.length,
		children: kids.map((kid) => ({
			title: stripMarkup(kid.name),
			note: kid.note ?? null,
			childCount: (kid.children ?? []).length,
			url: workflowyUrl(kid.shortId),
		})),
		links: extractLinks(node.name, node.note),
	};
}

// Children that say Claude does the item: a CLI or script command, a slash command, or the words
// themselves. Such an item is an #llm-task in all but tag, so the walk must not ask it as a card.
const CLAUDE_RUNS_IT_RE =
	/\.\/bin\/run\.js|\bosascript\b|\bnode (?:plugins|scripts)\/|\bsqlite3\b|(?:^|[\s(])\/[a-z][\w-]*:[\w:-]+|\bClaude (?:does|runs|handles)\b/iu;
// `cd <dir> && claude` marks a directory launch, which runs without the tag on purpose.
const SESSION_LAUNCH_RE = /(?:&&|&amp;&amp;)\s*claude\b/u;

export const isLlmTaskName = (name: string): boolean => /#llm-task/u.test(name);

export function missingLlmTag(node: TreeNode): boolean {
	if (isLlmTaskName(node.name)) {
		return false;
	}
	const texts = (node.children ?? [])
		.filter((kid) => kid.completedAt == null)
		.map((kid) => `${kid.name} ${kid.note ?? ""}`);
	return !texts.some((text) => SESSION_LAUNCH_RE.test(text)) && texts.some((text) => CLAUDE_RUNS_IT_RE.test(text));
}

export function intervalForSection(sectionName: string): Interval | null {
	const name = sectionName;
	for (const [pattern, interval] of SECTION_INTERVALS) {
		if (name.includes(pattern)) {
			return interval;
		}
	}
	return null; // "Every few years" / unrecognized -> ask the user for the interval
}

interface HardDeadline {
	date: string;
	leadDays: number;
}

function hardDeadlineFor(node: TreeNode, date: string | null): HardDeadline | null {
	const markers = (node.children ?? []).filter((child) => stripMarkup(child.name).startsWith("Hard deadline:"));
	if (markers.length === 0) {
		return null;
	}
	const [marker] = markers;
	if (markers.length !== 1 || !marker) {
		throw new Error(`Multiple hard deadline markers on ${node.id}`);
	}
	const match = stripMarkup(marker.name).match(/^Hard deadline: (0|[1-9]\d*)d$/u);
	if (!match || !Number.isSafeInteger(Number(match[1]))) {
		throw new Error(`Expected Hard deadline: <nonnegative days>d on ${node.id}`);
	}
	if (!date) {
		throw new Error(`Hard deadline requires a dated item: ${node.id}`);
	}
	return {date, leadDays: Number(match[1])};
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A `Next: <Weekday>` child pins every advanced date to that weekday, e.g. chores saved for the weekend. */
function weekdayAnchorFor(node: TreeNode): string | null {
	const markers = (node.children ?? []).filter((child) => stripMarkup(child.name).startsWith("Next:"));
	if (markers.length === 0) {
		return null;
	}
	const [marker] = markers;
	if (markers.length !== 1 || !marker) {
		throw new Error(`Multiple Next: <weekday> markers on ${node.id}`);
	}
	const match = stripMarkup(marker.name).match(/^Next: (\w+)$/u);
	const weekday = WEEKDAYS.find((day) => day.toLowerCase() === match?.[1]?.toLowerCase());
	if (!weekday) {
		throw new Error(`Expected Next: <weekday> on ${node.id}`);
	}
	return weekday;
}

/**
 * Land an advance on the anchored weekday: the first match within the week ending at the plain
 * interval's date, and never on or before today. A weekly item done Wednesday comes back Saturday,
 * not ten days later; a daily item rolls forward to the next Saturday.
 */
export function anchorToWeekday(todayISO: string, interval: Interval, weekday: string): string {
	const target = addInterval(todayISO, interval);
	const windowStart = addInterval(target, {amount: -7, unit: "d"});
	let date = windowStart > todayISO ? windowStart : todayISO;
	const wanted = WEEKDAYS.indexOf(weekday);
	do {
		date = addInterval(date, {amount: 1, unit: "d"});
	} while (new Date(`${date}T00:00:00Z`).getUTCDay() !== wanted);
	return date;
}

function lastDayOfMonth(year: number, month1: number): number {
	// month1 is 1-based; day 0 of the next month is the last day of this one.
	return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function addInterval(iso: string, {amount, unit}: Interval): string {
	const {year: y, month: m, day: d} = parseIsoDate(iso);
	if (unit === "d") {
		const dt = new Date(Date.UTC(y, m - 1, d + amount));
		return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
	}
	if (unit === "m" || unit === "y") {
		const totalMonths = (unit === "y" ? amount * 12 : amount) + (m - 1);
		const year = y + Math.floor(totalMonths / 12);
		const month1 = (totalMonths % 12) + 1;
		// Clamp the day so e.g. Jan 31 + 1 month -> Feb 28, never rolling into March.
		const day = Math.min(d, lastDayOfMonth(year, month1));
		return `${year}-${pad(month1)}-${pad(day)}`;
	}
	throw new Error(`bad interval unit: ${String(unit)}`);
}

export function buildTimeElement(iso: string): string {
	const {year: y, month: m, day: d} = parseIsoDate(iso);
	const label = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(y, m - 1, d)));
	// Trailing space is required so Workflowy renders the element (see review-date-updates.md).
	return `<time startYear="${y}" startMonth="${m}" startDay="${d}">${label}</time> `;
}

export function swapTimeElement(name: string, newTimeElement: string): string {
	// Replace the existing element and collapse any duplicated trailing space.
	return `${name.replace(TIME_RE, newTimeElement.trimEnd()).replace(/\s+$/u, "")} `;
}

// The skip log is an append-only JSONL record of what happened to each item on each run. It is
// append-only on purpose: the walk dispatches its writes as concurrent background jobs, and a
// read-modify-write of a single JSON blob would silently lose outcomes when two land at once.
export const DEFAULT_SKIP_LOG_PATH = ".llm/gtd/review/skip-log.jsonl";

export interface SkipEntry {
	key: string;
	outcome: string;
	date: string;
	/** ISO timestamp of the write; absent on entries logged before timestamps existed. */
	at?: string;
}

export interface SkipStreak {
	skipStreak: number;
	skippedSince: string | null;
}

function parseSkipLog(text: string): SkipEntry[] {
	const entries: SkipEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		try {
			const entry = parseJson(line);
			if (!isObject(entry)) {
				continue;
			}
			const key = stringField(entry, "key");
			const outcome = stringField(entry, "outcome");
			const date = stringField(entry, "date");
			if (key && outcome && date) {
				const at = stringField(entry, "at");
				entries.push(at ? {key, outcome, date, at} : {key, outcome, date});
			}
		} catch {
			// A truncated line from an interrupted run costs one item's history, never the whole log.
		}
	}
	return entries;
}

/**
 * Fold the log into a per-item streak of consecutive runs that ended in `skip`.
 *
 * Outcomes collapse per day so re-running the review cannot inflate a streak, and the last
 * outcome recorded for a day wins so a correction overrides the entry it replaces.
 */
export function foldSkipLog(entries: readonly SkipEntry[] | null | undefined): Map<string, SkipStreak> {
	const byKey = new Map<string, Map<string, string>>();
	for (const {key, outcome, date} of entries ?? []) {
		let byDate = byKey.get(key);
		if (!byDate) {
			byDate = new Map();
			byKey.set(key, byDate);
		}
		byDate.set(date, outcome);
	}

	const streaks = new Map<string, SkipStreak>();
	for (const [key, byDate] of byKey) {
		// ISO YYYY-MM-DD keys sort chronologically.
		const dates = [...byDate.keys()].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		let skipStreak = 0;
		let skippedSince: string | null = null;
		for (const date of dates.toReversed()) {
			if (byDate.get(date) !== "skip") {
				break;
			}
			skipStreak++;
			skippedSince = date;
		}
		streaks.set(key, {skipStreak, skippedSince});
	}
	return streaks;
}

export function loadSkipStreaks(path = DEFAULT_SKIP_LOG_PATH): Map<string, SkipStreak> {
	try {
		return foldSkipLog(parseSkipLog(readFileSync(path, "utf8")));
	} catch {
		return new Map(); // No log yet means no history, which is not an error.
	}
}

/** Keys with any outcome recorded at or after `runStartedISO`: the items this run already answered. */
export function loadAnsweredKeys(runStartedISO: string, path = DEFAULT_SKIP_LOG_PATH): Set<string> {
	const started = Date.parse(runStartedISO);
	if (Number.isNaN(started)) {
		throw new TypeError(`--run-started must be an ISO timestamp, got ${runStartedISO}`);
	}
	try {
		return new Set(
			parseSkipLog(readFileSync(path, "utf8"))
				// An entry without a timestamp only knows its day, so it counts from that day's start.
				.filter((entry) => Date.parse(entry.at ?? `${entry.date}T00:00:00Z`) >= started)
				.map((entry) => entry.key),
		);
	} catch (error) {
		if (error instanceof TypeError) {
			throw error;
		}
		return new Set();
	}
}

export function recordOutcome(
	key: string,
	outcome: string,
	{
		date = localTodayISO(),
		at = new Date().toISOString(),
		path = DEFAULT_SKIP_LOG_PATH,
	}: {date?: string; at?: string; path?: string} = {},
): SkipEntry {
	const entry: SkipEntry = {key, outcome, date, at};
	mkdirSync(dirname(path), {recursive: true});
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
	return entry;
}

const UNIT_DAYS: Record<IntervalUnit, number> = {d: 1, m: 30, y: 365};

// Only for ordering the cadence ladder -- month and year lengths are approximations, and the real
// date math stays in addInterval.
export function intervalDays(interval: Interval | null): number {
	return interval === null ? Infinity : UNIT_DAYS[interval.unit] * interval.amount;
}

/**
 * The next rung up the cadence ladder: the section in this tree whose interval is the shortest one
 * still longer than `interval`. A recurring item's cadence IS its section, so lengthening the
 * cadence means moving the node, not editing a field.
 */
export interface SectionRef {
	name: string;
	id?: string;
}

export interface CadenceRung {
	name: string;
	id: string | undefined;
	interval: Interval;
}

export function nextLongerSection(
	sections: readonly SectionRef[] | null | undefined,
	interval: Interval | null,
): CadenceRung | null {
	if (interval === null) {
		return null;
	} // Unknown cadence -- ask the user rather than guessing a rung.
	const current = intervalDays(interval);
	const candidates = (sections ?? [])
		.filter((section) => !section.name.includes("🗃️ Routine Archive"))
		.flatMap((section): CadenceRung[] => {
			const sectionInterval = intervalForSection(section.name);
			// A section with no known interval cannot stage a date, so it is not a move target.
			return sectionInterval !== null && intervalDays(sectionInterval) > current
				? [{name: section.name, id: section.id, interval: sectionInterval}]
				: [];
		})
		.toSorted((a, b) => intervalDays(a.interval) - intervalDays(b.interval));
	return candidates[0] ?? null;
}

function shellSingleQuote(s: string): string {
	return `'${s.replaceAll("'", `'"'"'`)}'`;
}

function daysBetween(fromISO: string, toISO: string): number {
	const a = new Date(`${fromISO}T00:00:00Z`);
	const b = new Date(`${toISO}T00:00:00Z`);
	return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Stage the "this comes back too often" outcome: advance the date by the NEXT LONGER cadence and
 * move the item into that section. Repeated skipping usually means the cadence is wrong rather
 * than that the item is dead, so this is the alternative to deleting it.
 */
export interface LengthenOp {
	section: string;
	sectionId: string;
	interval: Interval;
	nextDate: string;
	newName: string;
	applyOp: string;
}

function buildLengthen(
	target: CadenceRung | null,
	child: TreeNode,
	todayISO: string,
	weekday: string | null,
): LengthenOp | null {
	if (!target?.id) {
		return null;
	} // Top of the ladder, or a section we cannot address by id.
	const nextDate = weekday
		? anchorToWeekday(todayISO, target.interval, weekday)
		: addInterval(todayISO, target.interval);
	const newName = swapTimeElement(child.name, buildTimeElement(nextDate));
	return {
		section: target.name,
		sectionId: target.id,
		interval: target.interval,
		nextDate,
		newName,
		applyOp: `./bin/run.js node update --id ${child.id} --name ${shellSingleQuote(newName)} && ./bin/run.js node move --node-id ${child.id} --parent-id ${target.id} -p bottom`,
	};
}

export interface OverdueRow extends NodeContext {
	section: string;
	sectionIndex: number;
	priority: number | null;
	id: string | undefined;
	shortId: string | null | undefined;
	name: string;
	due: string;
	hardDeadline: (HardDeadline & {nextDate: string | null}) | null;
	weekday: string | null;
	overdueByDays: number;
	isLlmTask: boolean;
	// Children say Claude runs it, but the name lacks #llm-task: tag it and run it as one.
	missingLlmTag: boolean;
	url: string | null;
	interval: Interval | null;
	needsInterval: boolean;
	nextDate: string | null;
	nextTimeElement: string | null;
	newName: string | null;
	applyOp: string | null;
	skipStreak: number;
	skippedSince: string | null;
	lengthen: LengthenOp | null;
}

export function computeOverdue(
	tree: TreeRoot,
	todayISO: string,
	{
		skipStreaks = new Map<string, SkipStreak>(),
		answeredKeys = new Set<string>(),
	}: {skipStreaks?: Map<string, SkipStreak>; answeredKeys?: ReadonlySet<string>} = {},
): OverdueRow[] {
	const sections = tree.children ?? [];
	const rows: OverdueRow[] = [];

	sections.forEach((section, sectionIndex) => {
		if (section.name.includes("🗃️ Routine Archive")) {
			return;
		}
		const interval = intervalForSection(section.name);
		// Every item in a section shares its cadence, so the rung above it is resolved once here.
		const lengthenTarget = nextLongerSection(sections, interval);

		const walk = (node: TreeNode): void => {
			for (const child of node.children ?? []) {
				// The keyed DAG owns the entire LLM Tasks subtree, so recurring review must not surface it.
				if (child.name.includes("LLM Tasks:")) {
					continue;
				}
				// A mirror reflects a node that lives elsewhere -- typically the ⏰/📌 task buckets
				// mirrored under "Set goals for today". Those reflections are one-shot Next Actions,
				// not recurring items, so neither the mirror nor anything beneath it is a row here.
				if (child.mirror?.isMirror) {
					continue;
				}
				// A finished item keeps its old <time>. Asking about it is asking about work
				// that is already done, so completion wins over the date.
				const isCompleted = child.completedAt != null;
				const date = parseTimeISO(child.name);
				const hardDeadline = isCompleted ? null : hardDeadlineFor(child, date);
				const weekday = isCompleted ? null : weekdayAnchorFor(child);
				if (weekday && hardDeadline) {
					throw new Error(`Next: <weekday> cannot combine with Hard deadline on ${child.id}`);
				}
				const due = hardDeadline
					? addInterval(hardDeadline.date, {amount: -hardDeadline.leadDays, unit: "d"})
					: date;
				if (due && due <= todayISO && !isCompleted && !(child.id !== undefined && answeredKeys.has(child.id))) {
					const needsInterval = interval === null;
					const nextStoredDate =
						interval === null
							? null
							: weekday
								? anchorToWeekday(todayISO, interval, weekday)
								: addInterval(hardDeadline ? hardDeadline.date : todayISO, interval);
					const nextDate =
						hardDeadline && nextStoredDate
							? addInterval(nextStoredDate, {amount: -hardDeadline.leadDays, unit: "d"})
							: nextStoredDate;
					let newName: string | null = null;
					let applyOp: string | null = null;
					if (nextStoredDate) {
						newName = swapTimeElement(child.name, buildTimeElement(nextStoredDate));
						applyOp = `./bin/run.js node update --id ${child.id} --name ${shellSingleQuote(newName)}`;
					}
					const streak = (child.id === undefined ? undefined : skipStreaks.get(child.id)) ?? null;
					rows.push({
						section: section.name,
						sectionIndex,
						priority: section.priority ?? null,
						id: child.id,
						shortId: child.shortId,
						name: child.name,
						due,
						hardDeadline: hardDeadline ? {...hardDeadline, nextDate: nextStoredDate} : null,
						weekday,
						overdueByDays: daysBetween(due, todayISO),
						isLlmTask: isLlmTaskName(child.name),
						missingLlmTag: missingLlmTag(child),
						url: workflowyUrl(child.shortId),
						...nodeContext(child),
						interval,
						needsInterval,
						nextDate,
						nextTimeElement: nextStoredDate ? buildTimeElement(nextStoredDate) : null,
						newName,
						applyOp,
						skipStreak: streak?.skipStreak ?? 0,
						skippedSince: streak?.skippedSince ?? null,
						lengthen: hardDeadline ? null : buildLengthen(lengthenTarget, child, todayISO, weekday),
					});
				}
				if ((child.children?.length ?? 0) > 0) {
					walk(child);
				}
			}
		};
		walk(section);
	});

	rows.sort((a, b) => a.sectionIndex - b.sectionIndex || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
	return rows;
}

export function localTodayISO(): string {
	const now = new Date();
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function main(argv: string[]): void {
	const args = argv.slice(2);
	let treePath = ".llm/gtd/review/tree.json";
	let today = localTodayISO();
	let print = false;
	let skipLogPath = DEFAULT_SKIP_LOG_PATH;
	let runStarted: string | null = null;
	let recordKey: string | null = null;
	let outcome: string | null = null;
	const argIterator = args[Symbol.iterator]();
	for (const arg of argIterator) {
		if (arg === "--today") {
			today = takeValue(argIterator, arg);
		} else if (arg === "--print") {
			print = true;
		} else if (arg === "--skip-log") {
			skipLogPath = takeValue(argIterator, arg);
		} else if (arg === "--run-started") {
			runStarted = takeValue(argIterator, arg);
		} else if (arg === "--record") {
			recordKey = takeValue(argIterator, arg);
		} else if (arg === "--outcome") {
			outcome = takeValue(argIterator, arg);
		} else if (!arg.startsWith("--")) {
			treePath = arg;
		}
	}

	if (recordKey) {
		if (!outcome) {
			throw new Error("--record requires --outcome");
		}
		const entry = recordOutcome(recordKey, outcome, {date: today, path: skipLogPath});
		process.stdout.write(`${JSON.stringify(entry)}\n`);
		return;
	}

	const tree = readTreeFile(treePath);
	const rows = computeOverdue(tree, today, {
		skipStreaks: loadSkipStreaks(skipLogPath),
		answeredKeys: runStarted ? loadAnsweredKeys(runStarted, skipLogPath) : new Set<string>(),
	});

	if (!print) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		return;
	}

	const bySection = new Map<string, OverdueRow[]>();
	for (const r of rows) {
		const items = bySection.get(r.section) ?? [];
		items.push(r);
		bySection.set(r.section, items);
	}
	for (const [section, items] of bySection) {
		process.stdout.write(`\n=== ${section} — ${items.length} overdue ===\n`);
		for (const row of items) {
			const tags = [
				row.isLlmTask ? "[#llm-task]" : "",
				row.missingLlmTag ? "⚠️ missing #llm-task" : "",
				row.hardDeadline
					? `⚠️ HARD deadline ${row.hardDeadline.date}; review ${row.hardDeadline.leadDays} days before`
					: "",
				row.childCount ? `(${row.childCount} children)` : "",
				!row.hardDeadline && row.skipStreak >= 2
					? `⏭️ skipped ${row.skipStreak}x → offer ${row.lengthen?.section ?? "a longer cadence"}`
					: "",
				row.needsInterval ? "⚠️ needs interval" : `→ ${row.nextDate}`,
			]
				.filter(Boolean)
				.join(" ");
			const display = row.name.replace(TIME_RE, "⟨time⟩").slice(0, 200);
			process.stdout.write(
				`  [${row.shortId}] due ${row.due} (overdue ${row.overdueByDays}d) ${tags}\n      ${display}\n`,
			);
		}
	}
	process.stdout.write(`\nTOTAL OVERDUE: ${rows.length} (${rows.filter((r) => r.isLlmTask).length} #llm-task)\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv);
}
