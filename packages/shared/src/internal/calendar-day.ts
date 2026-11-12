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

/** Upstream's `metadata(date)`: the unpadded value and local midnight of the level's first day. */
export function calendarLevelMetadata(
	level: CalendarLevel,
	date: CalendarDate,
	weekStartDay = 0,
): CalendarLevelMetadata
{
	const start = levelStart(level, date, weekStartDay);
	return {
		level,
		value: String(levelValue(level, date, weekStartDay)),
		timestamp: new Date(start.year, start.month - 1, start.day).getTime(),
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
