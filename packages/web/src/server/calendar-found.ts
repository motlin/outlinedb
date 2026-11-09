/**
 * Upstream's Found Dates (`calendar.non-calendar-mirrors.wire`): for a 📆
 * Calendar day, every live node whose name or note has a `<time>` covering that
 * day (a range counts for each day it spans), except calendar level nodes,
 * mirror copies and the day's own descendants, in tree order.
 */

import {and, eq, like, or} from "drizzle-orm";
import {parseTimeAttrs} from "@outlinedb/shared";
import type {CacheService} from "@outlinedb/shared/cache";
import {nodeContent} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {Node} from "@outlinedb/shared/types";
import type {BacklinkCrumb} from "../node-types.js";
import {loadCalendarInfo, readCalendarSettings} from "./calendar-day.js";
import type {CalendarDayDeps} from "./calendar-day.js";

export interface FoundDate {
	id: string;
	/** The node's ancestors, root first, excluding the node. */
	crumbs: BacklinkCrumb[];
}

const TIME_OPEN_TAG = /<time\b([^>]*)>/giu;

/** Each `<time>` in `html` as its `[start, end]` day dateIds; a single date starts and ends on its day. */
function timeSpans(html: string | null): [number, number][] {
	if (html === null) {
		return [];
	}
	return [...html.matchAll(TIME_OPEN_TAG)].flatMap(([, attrText = ""]): [number, number][] => {
		try {
			const attrs = parseTimeAttrs(attrText);
			const start = attrs.startYear * 10_000 + attrs.startMonth * 100 + attrs.startDay;
			const end =
				attrs.endDay === undefined
					? start
					: (attrs.endYear ?? attrs.startYear) * 10_000 +
						(attrs.endMonth ?? attrs.startMonth) * 100 +
						attrs.endDay;
			return [[start, end]];
		} catch {
			// A <time> without start attributes names no date.
			return [];
		}
	});
}

/** Whether `before` and `after` carry different `<time>` dates, in order. */
export function timesDiffer(before: string, after: string): boolean {
	return JSON.stringify(timeSpans(before)) !== JSON.stringify(timeSpans(after));
}

/** Whether any `<time>` in `html` starts on or before `dateId` and ends on or after it. */
function coversDay(html: string | null, dateId: number): boolean {
	return timeSpans(html).some(([start, end]) => start <= dateId && dateId <= end);
}

/**
 * Live nodes whose name or note may hold a `<time>` in `year`: one that starts or ends in that year, or spans
 * years and so carries an `endYear`.
 */
function datedCandidates(deps: Pick<CalendarDayDeps, "db">, year: number) {
	const yearPattern = `%Year="${year}"%`;
	const spanPattern = '%endYear="%';
	return deps.db
		.select({id: nodeContent.id, name: nodeContent.name, note: nodeContent.note})
		.from(nodeContent)
		.where(
			and(
				eq(nodeContent.systemTo, FAR_FUTURE_DATE),
				or(
					like(nodeContent.name, yearPattern),
					like(nodeContent.note, yearPattern),
					like(nodeContent.name, spanPattern),
					like(nodeContent.note, spanPattern),
				),
			),
		)
		.all();
}

/** The node's ancestors root first, or undefined when the chain leaves the cache (an orphan). */
function ancestorsOf(cache: CacheService, node: Node): Node[] | undefined {
	const ancestors: Node[] = [];
	const seen = new Set<string>([node.id]);
	let parentId = node.parentId;
	while (parentId !== null) {
		const parent = seen.has(parentId) ? undefined : cache.getNode(parentId);
		if (parent === undefined) {
			return undefined;
		}
		seen.add(parent.id);
		ancestors.unshift(parent);
		parentId = parent.parentId;
	}
	return ancestors;
}

/** Whether a node's ancestor chain stays in the cache up to Home, as {@link ancestorsOf} checks, sharing the walks. */
function inTreeChecker(cache: CacheService): (node: Node) => boolean {
	const answers = new Map<string, boolean>();
	return (node) => {
		const climbed = [node.id];
		let parentId = node.parentId;
		let answer = true;
		while (parentId !== null) {
			const known = answers.get(parentId);
			if (known !== undefined) {
				answer = known;
				break;
			}
			const parent = climbed.includes(parentId) ? undefined : cache.getNode(parentId);
			if (parent === undefined) {
				answer = false;
				break;
			}
			climbed.push(parentId);
			parentId = parent.parentId;
		}
		for (const id of climbed) {
			answers.set(id, answer);
		}
		return answer;
	};
}

/** Tree order: compare the priority paths from the top level down; an ancestor comes before its descendants. */
function compareTreeOrder(a: number[], b: number[]): number {
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) {
			return delta;
		}
	}
	return a.length - b.length;
}

/**
 * The Found Dates of the day node `dayId` (dateId `dateId`), or none when the
 * calendar root turns Found Dates off. A `LIKE` prefilters the rows: a `<time>`
 * covering the day either starts or ends in its year, or spans years and so
 * carries an `endYear`.
 */
export function findFoundDates(
	deps: Pick<CalendarDayDeps, "db" | "cache">,
	dayId: string,
	dateId: number,
): FoundDate[] {
	if (!readCalendarSettings(deps).foundDates) {
		return [];
	}
	const candidates = datedCandidates(deps, Math.floor(dateId / 10_000)).filter(
		({name, note}) => coversDay(name, dateId) || coversDay(note, dateId),
	);
	const nodes = candidates.flatMap(({id}) => {
		const node = deps.cache.getNode(id);
		return node === undefined || node.mirror.isMirror ? [] : [node];
	});
	const calendarInfo = loadCalendarInfo(deps, nodes);
	return nodes
		.flatMap((node) => {
			const info = calendarInfo.get(node.id);
			if (node.id === dayId || info?.root === true || info?.level != null) {
				return [];
			}
			const ancestors = ancestorsOf(deps.cache, node);
			if (ancestors === undefined || ancestors.some(({id}) => id === dayId)) {
				return [];
			}
			return [{node, ancestors, path: [...ancestors, node].map(({priority}) => priority)}];
		})
		.toSorted((a, b) => compareTreeOrder(a.path, b.path))
		.map(({node, ancestors}) => ({
			id: node.id,
			crumbs: ancestors.map(({id, name}) => ({id, name: name ?? ""})),
		}));
}

/**
 * The days of `month` (1-12) in `year` that a live node's `<time>` covers, for the strip picker's Found Dates dots
 * (upstream `w10` over `WF.Date.fromItem`): calendar level nodes and nodes outside the tree do not count, and a
 * range counts for each day it spans.
 */
export function foundDaysInMonth(
	deps: Pick<CalendarDayDeps, "db" | "cache">,
	year: number,
	month: number,
): Set<number> {
	const first = year * 10_000 + month * 100 + 1;
	const last = year * 10_000 + month * 100 + new Date(Date.UTC(year, month, 0)).getUTCDate();
	const spansById = new Map(
		datedCandidates(deps, year).flatMap(({id, name, note}) => {
			const spans = [...timeSpans(name), ...timeSpans(note)].filter(
				([start, end]) => start <= last && end >= first,
			);
			return spans.length === 0 ? [] : [[id, spans] as const];
		}),
	);
	// A node whose days are all dotted already adds nothing, so only the rest pay for the tree checks.
	const unseen = (spans: readonly (readonly [number, number])[], days: ReadonlySet<number>) =>
		spans.some(([start, end]) => {
			for (let dateId = Math.max(start, first); dateId <= Math.min(end, last); dateId++) {
				if (!days.has(dateId % 100)) {
					return true;
				}
			}
			return false;
		});
	const inTree = inTreeChecker(deps.cache);
	const nodesById = deps.cache.getMultipleNodes([...spansById.keys()]);
	const calendarInfo = loadCalendarInfo(deps, [...nodesById.values()]);
	const days = new Set<number>();
	for (const [id, spans] of spansById) {
		const node = nodesById.get(id);
		const info = calendarInfo.get(id);
		if (node === undefined || info?.root === true || info?.level != null || !unseen(spans, days) || !inTree(node)) {
			continue;
		}
		for (const [start, end] of spans) {
			for (let dateId = Math.max(start, first); dateId <= Math.min(end, last); dateId++) {
				days.add(dateId % 100);
			}
		}
	}
	return days;
}
