/**
 * Pure model of upstream's calendar adoption: the `mb1` hook that tags a dated
 * row inserted under a month as that day, and an audit of the 📆 Calendar
 * nodes that upstream's strict `findDateItem` walk cannot see.
 */

import {parseTimeAttrs} from "../dates/date-markup.js";
import {CALENDAR_LEVELS, calendarDateId, calendarLevelMetadata} from "./calendar-day.js";
import type {CalendarDate, CalendarLevel, CalendarLevelMetadata} from "./calendar-day.js";

/** The slice of a node's cached `metadata.calendar` that adoption reads. */
export interface CalendarTag
{
	root?: boolean | undefined;
	level?: string | undefined;
	dateId?: number | undefined;
}

export interface CalendarTagged
{
	calendar?: CalendarTag | undefined;
}

export interface AdoptOnInsertInput
{
	/** The new parent first, then its ancestors up to the root. */
	parentChain: readonly CalendarTagged[];
	/** The new parent's other children. */
	siblings: readonly CalendarTagged[];
	/** The dates of the inserted row's text, in order. */
	dates: readonly CalendarDate[];
	levels: Readonly<Record<CalendarLevel, boolean>>;
	weekStartDay?: number;
}

/** Upstream `level.matches(item, date)`: the item is that level, and (with a date) in the same period. */
function matches(
	item: CalendarTagged | undefined,
	level: CalendarLevel,
	date: CalendarDate | undefined,
	weekStartDay: number,
): boolean
{
	const calendar = item?.calendar;
	if (calendar?.level !== level)
	{
		return false;
	}
	return date === undefined || calendar.dateId === calendarDateId(level, date, weekStartDay);
}

/**
 * Upstream `mb1`: the `calendar` metadata a row inserted (created, restored or
 * moved) under a calendar month gets, or null when it stays a plain row.
 * Reproduces upstream's quirk of consuming one level per date tried, so
 * effectively only the first date is tested correctly.
 */
export function adoptOnInsert(input: AdoptOnInsertInput):
{
	set: CalendarLevelMetadata;
} | null
{
	const {parentChain, siblings, dates, levels, weekStartDay = 0} = input;
	const parent = parentChain[0];
	if (parent?.calendar === undefined || parent.calendar.root === true)
	{
		return null;
	}
	const remaining = CALENDAR_LEVELS.filter((level) => levels[level]).toReversed();
	for (const date of dates)
	{
		const level = remaining.shift();
		if (level === undefined || matches(parent, level, undefined, weekStartDay))
		{
			continue;
		}
		if (siblings.some((sibling) => matches(sibling, level, date, weekStartDay)))
		{
			continue;
		}
		if (remaining.every((ancestorLevel, index) => matches(parentChain[index], ancestorLevel, date, weekStartDay)))
		{
			return {
				set: calendarLevelMetadata("day", date, weekStartDay),
			};
		}
	}
	return null;
}

export type CalendarAuditKind =
	| "untagged-day"
	| "bracket-day"
	| "nested-day"
	| "duplicate"
	| "untagged-year"
	| "untagged-month";

export interface CalendarAuditFinding
{
	kind: CalendarAuditKind;
	id: string;
	dateId: number;
}

export interface AuditNode extends CalendarTagged
{
	id: string;
	name?: string | null;
	/** One level of children, read only to find tagged days nested under a day that is not. */
	children?: readonly AuditNode[];
}

const BRACKET_DAY = /^\[(\d{4})-(\d{2})-(\d{2})\]$/u;
const TIME_NAME = /^<time\b([^>]*)>[^<]*<\/time>$/iu;

/** The date a row's name names: exactly one date-only `<time>`. */
function timeNameDate(name: string | null): CalendarDate | undefined
{
	const attrText = TIME_NAME.exec(name?.trim() ?? "")?.[1];
	if (attrText === undefined)
	{
		return undefined;
	}
	try
	{
		const {startYear, startMonth, startDay, ...rest} = parseTimeAttrs(attrText);
		return Object.keys(rest).length === 0
			?
				{
					year: startYear,
					month: startMonth,
					day: startDay,
				}
			: undefined;
	}
	catch
	{
		return undefined;
	}
}

function bracketNameDate(name: string | null): CalendarDate | undefined
{
	const match = BRACKET_DAY.exec(name?.trim() ?? "");
	return match === null
		? undefined
		:
			{
				year: Number(match[1]),
				month: Number(match[2]),
				day: Number(match[3]),
			};
}

const dayId = (date: CalendarDate) => calendarDateId("day", date);

/**
 * The children of a calendar month that upstream's strict day lookup cannot
 * use: date-only `<time>` days and `[YYYY-MM-DD]` days without `calendar`,
 * tagged days nested under one of those, and a second node for a dateId.
 */
export function auditCalendarMonth(input: {
	month: AuditNode;
	children: readonly AuditNode[];
	levels: Readonly<Record<CalendarLevel, boolean>>;
}): CalendarAuditFinding[]
{
	const findings: CalendarAuditFinding[] = [];
	const seen = new Set<number>();
	for (const child of input.children)
	{
		const tagged = child.calendar?.level === "day" ? child.calendar.dateId : undefined;
		let dateId = tagged;
		if (tagged === undefined && child.calendar === undefined)
		{
			const timeDate = timeNameDate(child.name ?? null);
			const bracketDate = timeDate === undefined ? bracketNameDate(child.name ?? null) : undefined;
			const date = timeDate ?? bracketDate;
			if (date !== undefined)
			{
				dateId = dayId(date);
				findings.push(
					{
						kind: timeDate === undefined ? "bracket-day" : "untagged-day",
						id: child.id,
						dateId,
					},
				);
			}
			for (const nested of child.children ?? [])
			{
				if (nested.calendar?.level === "day" && nested.calendar.dateId !== undefined)
				{
					findings.push(
						{
							kind: "nested-day",
							id: nested.id,
							dateId: nested.calendar.dateId,
						},
					);
				}
			}
		}
		if (dateId !== undefined)
		{
			if (seen.has(dateId))
			{
				findings.push(
					{
						kind: "duplicate",
						id: child.id,
						dateId,
					},
				);
			}
			seen.add(dateId);
		}
	}
	return findings;
}

/** Name-only year (`2027`) and month (`11`) children of the calendar root, which upstream never uses as levels. */
export function auditCalendarRoot(input: {children: readonly AuditNode[]}): CalendarAuditFinding[]
{
	return input.children.flatMap((child): CalendarAuditFinding[] =>
	{
		const name = child.name?.trim() ?? "";
		if (child.calendar !== undefined)
		{
			return [];
		}
		if (/^\d{4}$/u.test(name))
		{
			return [
				{
					kind: "untagged-year",
					id: child.id,
					dateId: Number(name) * 10_000,
				},
			];
		}
		return /^\d{1,2}$/u.test(name)
			? [
					{
						kind: "untagged-month",
						id: child.id,
						dateId: 0,
					},
				]
			: [];
	});
}

/** What {@link adoptOnInsert} reads from the cache about the parent a row was inserted under. */
export interface CalendarParentContext
{
	parentChain: readonly CalendarTagged[];
	siblings: readonly CalendarTagged[];
	levels: Readonly<Record<CalendarLevel, boolean>>;
	weekStartDay?: number;
}

/** The dates of each `<time>` element in a row's text, in order. */
export function datesInName(name: string | null | undefined): CalendarDate[]
{
	const dates: CalendarDate[] = [];
	for (const match of (name ?? "").matchAll(/<time\b([^>]*)>/giu))
	{
		try
		{
			const {startYear, startMonth, startDay} = parseTimeAttrs(match[1] ?? "");
			dates.push(
				{
					year: startYear,
					month: startMonth,
					day: startDay,
				},
			);
		}
		catch
		{
			// A <time> without start attributes holds no date.
		}
	}
	return dates;
}

export type AdoptAfterCreateResult =
	|
	  {
			status: "skipped";
	  }
	|
	  {
			status: "adopted";
			set: CalendarLevelMetadata;
	  }
	|
	  {
			status: "unadoptable";
			set: CalendarLevelMetadata;
	  };

/** The stderr warning for a dated row written under a calendar month without internal auth. */
export function calendarAdoptWarning(name: string): string
{
	return `warning: ${name} was created under a 📆 Calendar month without calendar metadata; workflowy.com will not use it as that day. Run ./bin/run.js calendar day --date YYYY-MM-DD --ensure instead.`;
}

/**
 * After a public-API create or move of `{id, name}` under a calendar parent, tag it the way upstream's `mb1` hook
 * does for web edits. "unadoptable" means it needed adopting but there is no internal adapter to write the metadata;
 * "skipped" means nothing was to be adopted (not a calendar parent, no date, or the day already exists).
 */
export async function adoptAfterCreate(input: {
	id: string;
	name: string;
	context: CalendarParentContext | undefined;
	adapter:
		|
		  {
				setNodeMetaValues(
					id: string,
					changes:
					{
						path: string[];
						value: unknown;
					}[],
				): Promise<void>;
		  }
		| undefined;
}): Promise<AdoptAfterCreateResult>
{
	const {id, name, context, adapter} = input;
	if (context === undefined)
	{
		return {
			status: "skipped",
		};
	}
	const adoption = adoptOnInsert(
		{
			...context,
			dates: datesInName(name),
		},
	);
	if (adoption === null)
	{
		return {
			status: "skipped",
		};
	}
	if (adapter === undefined)
	{
		return {
			status: "unadoptable",
			set: adoption.set,
		};
	}
	await adapter.setNodeMetaValues(id, [
		{
			path: ["calendar"],
			value: adoption.set,
		},
	]);
	return {
		status: "adopted",
		set: adoption.set,
	};
}
