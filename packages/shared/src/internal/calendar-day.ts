import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek.js";
import weekOfYear from "dayjs/plugin/weekOfYear.js";
import {toTimeMarkup} from "../dates/date-markup.js";

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);

/** The calendar levels below the root, outermost first (upstream `nx()`). */
export const CALENDAR_LEVELS = ["year", "month", "week", "day"] as const;
export type CalendarLevel = (typeof CALENDAR_LEVELS)[number];

/** Upstream `GO`'s levels when the root has no `calendar.levels`. */
export const DEFAULT_CALENDAR_LEVELS: Readonly<Record<CalendarLevel, boolean>> =
{
	year: true,
	month: true,
	week: false,
	day: true,
};

export interface CalendarDate
{
	year: number;
	month: number;
	day: number;
}

/** Upstream's `metadata.calendar` for a level node, in upstream's key order. */
export interface CalendarLevelMetadata
{
	level: CalendarLevel;
	value: string;
	timestamp: number;
	dateId: number;
}

/** No `📆 Calendar` root (a node whose cached metadata has `calendar.root`) is in the cache. */
export class CalendarRootMissing extends Error
{
	constructor()
	{
		super("No calendar root is cached (run `cache import-api` to import node metadata)");
		this.name = "CalendarRootMissing";
	}
}

/** A `YYYYMMDD` day id as a date, or undefined when it is not a real calendar day. */
export function parseDateId(dateId: number): CalendarDate | undefined
{
	if (!Number.isInteger(dateId) || dateId < 10_000_101 || dateId > 99_991_231)
	{
		return undefined;
	}
	const year = Math.floor(dateId / 10_000);
	const month = Math.floor(dateId / 100) % 100;
	const day = dateId % 100;
	const date = new Date(year, month - 1, day);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
		?
			{
				year,
				month,
				day,
			}
		: undefined;
}

/**
 * The first day of the week holding `date` (upstream `DC1`'s timestamp):
 * Monday when `weekStartDay` is 1, else Sunday, as upstream only knows those two.
 */
export function calendarWeekStart(date: CalendarDate, weekStartDay = 0): CalendarDate
{
	const local = new Date(date.year, date.month - 1, date.day);
	const offset = (local.getDay() - (weekStartDay === 1 ? 1 : 0) + 7) % 7;
	const start = new Date(date.year, date.month - 1, date.day - offset);
	return {
		year: start.getFullYear(),
		month: start.getMonth() + 1,
		day: start.getDate(),
	};
}

/** The first day of the level's period holding `date`. */
function levelStart(level: CalendarLevel, date: CalendarDate, weekStartDay: number): CalendarDate
{
	if (level === "week")
	{
		return calendarWeekStart(date, weekStartDay);
	}
	return {
		year: date.year,
		month: level === "year" ? 1 : date.month,
		day: level === "day" ? date.day : 1,
	};
}

/** The level's `dateId`: `YYYY0000`, `YYYYMM00`, the week's first day `YYYYMMDD`, or the day's `YYYYMMDD`. */
export function calendarDateId(level: CalendarLevel, date: CalendarDate, weekStartDay = 0): number
{
	const start = levelStart(level, date, weekStartDay);
	const month = level === "year" ? 0 : start.month;
	const day = level === "day" || level === "week" ? start.day : 0;
	return start.year * 10_000 + month * 100 + day;
}

/** Upstream's week number: ISO weeks when weeks start on Monday, else Sunday weeks numbered from the one holding Jan 1. */
function weekNumber(date: CalendarDate, weekStartDay: number): number
{
	const local = dayjs(new Date(date.year, date.month - 1, date.day));
	return weekStartDay === 1 ? local.isoWeek() : local.week();
}

/** The level's unpadded `value`: the year, month, week number or day of the month. */
function levelValue(level: CalendarLevel, date: CalendarDate, weekStartDay: number): number
{
	const values: Record<CalendarLevel, () => number> =
	{
		year: () => date.year,
		month: () => date.month,
		week: () => weekNumber(date, weekStartDay),
		day: () => date.day,
	};
	return values[level]();
}

/** `timeZone` when it is an IANA zone this runtime knows, else undefined. */
export function knownTimeZone(timeZone: unknown): string | undefined
{
	if (typeof timeZone !== "string" || timeZone === "")
	{
		return undefined;
	}
	try
	{
		new Intl.DateTimeFormat(
			"en-US",
			{
				timeZone,
			},
		).format(0);
		return timeZone;
	}
	catch
	{
		return undefined;
	}
}

/** How far `timeZone`'s wall clock is ahead of UTC at `timestamp`, in milliseconds. */
function zoneOffset(timestamp: number, timeZone: string): number
{
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat(
			"en-US",
			{
				timeZone,
				hourCycle: "h23",
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				second: "numeric",
			},
		)
			.formatToParts(timestamp)
			.map(({type, value}) => [type, Number(value)]),
	);
	const wall = Date.UTC(
		parts.year ?? 0,
		(parts.month ?? 1) - 1,
		parts.day ?? 1,
		parts.hour ?? 0,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
	return wall - (timestamp - (((timestamp % 1000) + 1000) % 1000));
}

/**
 * Midnight starting `date` in `timeZone` (the account's zone, as upstream's browser writes it), or in the host's zone
 * without one.
 */
export function calendarMidnight(date: CalendarDate, timeZone?: string): number
{
	if (timeZone === undefined)
	{
		return new Date(date.year, date.month - 1, date.day).getTime();
	}
	const wall = Date.UTC(date.year, date.month - 1, date.day);
	// A second pass corrects a guess that landed across a DST change.
	const guess = wall - zoneOffset(wall, timeZone);
	return wall - zoneOffset(guess, timeZone);
}

/** The calendar day `timestamp` falls on in `timeZone`, or in the host's zone without one. */
export function calendarDateAt(timestamp: number, timeZone?: string): CalendarDate
{
	if (timeZone === undefined)
	{
		const local = new Date(timestamp);
		return {
			year: local.getFullYear(),
			month: local.getMonth() + 1,
			day: local.getDate(),
		};
	}
	const zoned = new Date(timestamp + zoneOffset(timestamp, timeZone));
	return {
		year: zoned.getUTCFullYear(),
		month: zoned.getUTCMonth() + 1,
		day: zoned.getUTCDate(),
	};
}

/**
 * Upstream's `metadata(date)`: the unpadded value and midnight of the level's first day, in `timeZone` (the account's)
 * or else the host's zone.
 */
export function calendarLevelMetadata(
	level: CalendarLevel,
	date: CalendarDate,
	weekStartDay = 0,
	timeZone?: string,
): CalendarLevelMetadata
{
	const start = levelStart(level, date, weekStartDay);
	return {
		level,
		value: String(levelValue(level, date, weekStartDay)),
		timestamp: calendarMidnight(start, timeZone),
		dateId: calendarDateId(level, date, weekStartDay),
	};
}

/** `dateFormat` without its `[...]` literals. */
function formatTokens(dateFormat: string): string
{
	return dateFormat.replaceAll(/\[[^\]]*\]/gu, "");
}

/** The token of `dateFormat` upstream names a year or month with (`WX4`/`OX4`). */
function levelToken(level: "year" | "month", dateFormat: string): string
{
	const format = formatTokens(dateFormat);
	const tokens = level === "year" ? ["YYYY", "YY"] : ["MMMM", "MMM", "MM", "M"];
	return tokens.find((token) => format.includes(token)) ?? (level === "year" ? "YYYY" : "M");
}

/** Moment's English ordinal (`localeData().ordinal`): 1st, 2nd, 3rd, 4th, 11th, 21st. */
function ordinal(value: number): string
{
	const tens = Math.floor((value % 100) / 10);
	const suffixes = ["th", "st", "nd", "rd"];
	return `${value}${tens === 1 ? "th" : (suffixes[value % 10] ?? "th")}`;
}

/** Upstream `DC1.formatted`: the week number shaped by the format's week token (`jX4`), else `Week N`. */
function weekName(value: number, dateFormat: string): string
{
	const format = formatTokens(dateFormat);
	const token = ["wo", "ww", "w", "WW", "W"].find((candidate) => format.includes(candidate));
	if (token === undefined)
	{
		return `Week ${value}`;
	}
	if (token === "wo")
	{
		return ordinal(value);
	}
	return token === "ww" || token === "WW" ? String(value).padStart(2, "0") : String(value);
}

/** A level node's name: year and month from the account date format, the week by number, the day as a `<time>`. */
export function calendarLevelName(
	level: CalendarLevel,
	date: CalendarDate,
	dateFormat: string,
	weekStartDay = 0,
): string
{
	if (level === "day")
	{
		return toTimeMarkup(
			{
				startYear: date.year,
				startMonth: date.month,
				startDay: date.day,
			},
		);
	}
	if (level === "week")
	{
		return weekName(weekNumber(date, weekStartDay), dateFormat);
	}
	const month = level === "year" ? 1 : date.month;
	return dayjs(new Date(date.year, month - 1, 1)).format(levelToken(level, dateFormat));
}

/**
 * Where upstream (`C9`) inserts a new level node: after every non-calendar
 * child and every same-level child with an earlier date, stopping at the first
 * same-level child that is not earlier. Other levels are passed over.
 */
export function calendarInsertIndex(
	children: (
		|
		  {
				level: string;
				dateId: number;
		  }
		| undefined
	)[],
	level: CalendarLevel,
	dateId: number,
): number
{
	let index = 0;
	for (const [position, calendar] of children.entries())
	{
		if (calendar === undefined)
		{
			index = position + 1;
		}
		else if (calendar.level === level)
		{
			if (calendar.dateId >= dateId)
			{
				break;
			}
			index = position + 1;
		}
	}
	return index;
}
