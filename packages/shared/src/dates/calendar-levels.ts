import {calendarDateId} from "../internal/calendar-day.js";
import type {CalendarLevel} from "../internal/calendar-day.js";

export {CALENDAR_LEVELS} from "../internal/calendar-day.js";
export type {CalendarLevel};

/** A calendar page level: year, month, week or day. */
export type CalendarPageLevel = CalendarLevel;

export type FriendlyDayName = "Yesterday" | "Today" | "Tomorrow";

export interface StripDay
{
	ts: number;
	weekday: string;
	day: number;
	label?: string;
	isToday: boolean;
}

export interface StripMonth
{
	ts: number;
	text: string;
	label?: string;
}

/** Upstream's day strip (`wS2`) cells for a calendar page, without the per-day content dots. */
export interface StripModel
{
	todayCard: boolean;
	days: StripDay[];
	months: StripMonth[];
	separator: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const STRIP_DAYS = 31;
const STRIP_MONTHS = 12;

/** Upstream's `[prev, next]` arrow tooltips per level. */
export const levelTooltips: Record<CalendarPageLevel, readonly [string, string]> =
{
	day: ["Previous day", "Next day"],
	week: ["Previous week", "Next week"],
	month: ["Previous month", "Next month"],
	year: ["Previous year", "Next year"],
};

/** Upstream's calendar `dateId` for a local date: `YYYYMMDD` (day, or a week's first day), `YYYYMM00` (month) or `YYYY0000` (year). */
export function dateId(level: CalendarLevel, date: Date, weekStartDay = 0): number
{
	return calendarDateId(
		level,
		{
			year: date.getFullYear(),
			month: date.getMonth() + 1,
			day: date.getDate(),
		},
		weekStartDay,
	);
}

/** The local midnight of the date. */
export function dayTimestamp(date: Date): number
{
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function weekStart(date: Date, weekStartDay: number): Date
{
	const offset = (date.getDay() - weekStartDay + 7) % 7;
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

/** The level's timestamp for a date: local midnight of its day, week start, month start or year start. */
function levelTimestamp(level: CalendarPageLevel, date: Date, weekStartDay: number): number
{
	const starts: Record<CalendarPageLevel, () => Date> =
	{
		day: () => new Date(dayTimestamp(date)),
		week: () => weekStart(date, weekStartDay),
		month: () => new Date(date.getFullYear(), date.getMonth(), 1),
		year: () => new Date(date.getFullYear(), 0, 1),
	};
	return starts[level]().getTime();
}

function step(level: CalendarPageLevel, date: Date, delta: 1 | -1): Date
{
	const steps: Record<CalendarPageLevel, () => Date> =
	{
		day: () => new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta),
		week: () => new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7 * delta),
		month: () => new Date(date.getFullYear(), date.getMonth() + delta, 1),
		year: () => new Date(date.getFullYear() + delta, 0, 1),
	};
	return steps[level]();
}

/** The previous page's date: a day or week earlier, or the first of the previous month or year. */
export function prevOf(level: CalendarPageLevel, date: Date): Date
{
	return step(level, date, -1);
}

/** The next page's date: a day or week later, or the first of the next month or year. */
export function nextOf(level: CalendarPageLevel, date: Date): Date
{
	return step(level, date, 1);
}

/** Upstream's strip arrow tooltips: "Today" when the arrow lands on now's level node, "Yesterday"/"Tomorrow" on today's day page. */
export function navTooltips(level: CalendarPageLevel, date: Date, now: Date, weekStartDay = 0): [string, string]
{
	const isTodayPage = level === "day" && dayTimestamp(date) === dayTimestamp(now);
	const nowTs = levelTimestamp(level, now, weekStartDay);
	const [prevTooltip, nextTooltip] = levelTooltips[level];
	const prev =
		levelTimestamp(level, prevOf(level, date), weekStartDay) === nowTs
			? "Today"
			: isTodayPage
				? "Yesterday"
				: prevTooltip;
	const next =
		levelTimestamp(level, nextOf(level, date), weekStartDay) === nowTs
			? "Today"
			: isTodayPage
				? "Tomorrow"
				: nextTooltip;
	return [prev, next];
}

/** Upstream's title prefix (`r10`) for a day page within a day of now, else null. */
export function friendlyPrefix(date: Date, now: Date): FriendlyDayName | null
{
	const ts = dayTimestamp(date);
	if (ts === dayTimestamp(prevOf("day", now)))
	{
		return "Yesterday";
	}
	if (ts === dayTimestamp(now))
	{
		return "Today";
	}
	if (ts === dayTimestamp(nextOf("day", now)))
	{
		return "Tomorrow";
	}
	return null;
}

function stripDates(
	level: CalendarPageLevel,
	date: Date,
	weekStartDay: number,
):
{
	days: Date[];
	months: Date[];
}
{
	const year = date.getFullYear();
	const month = date.getMonth();
	if (level === "year")
	{
		return {
			days: [],
			months: Array.from(
				{
					length: STRIP_MONTHS,
				},
				(_, index) => new Date(year, index, 1),
			),
		};
	}
	if (level === "month")
	{
		const dayCount = new Date(year, month + 1, 0).getDate();
		return {
			days: Array.from(
				{
					length: dayCount,
				},
				(_, index) => new Date(year, month, index + 1),
			),
			months: Array.from(
				{
					length: STRIP_MONTHS,
				},
				(_, index) => new Date(year, month + index + 1, 1),
			),
		};
	}
	const first = level === "week" ? weekStart(date, weekStartDay) : new Date(dayTimestamp(date));
	const days = Array.from(
		{
			length: STRIP_DAYS,
		},
		(_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + index),
	);
	const last = days[days.length - 1] ?? first;
	return {
		days,
		months: Array.from(
			{
				length: STRIP_MONTHS,
			},
			(_, index) => new Date(last.getFullYear(), last.getMonth() + index, 1),
		),
	};
}

/** Upstream's day strip cells (`wS2`) for a calendar page zoomed at `date`. */
export function stripModel(level: CalendarPageLevel, date: Date, now: Date, weekStartDay: number): StripModel
{
	const todayTs = dayTimestamp(now);
	const {days, months} = stripDates(level, date, weekStartDay);
	return {
		todayCard: days.length > 0 && (days[0]?.getTime() ?? 0) > todayTs,
		days: days.map((day, index) =>
		{
			const label =
				index === 0 || (level !== "month" && day.getDate() === 1) ? MONTHS[day.getMonth()] : undefined;
			return {
				ts: day.getTime(),
				weekday: WEEKDAYS[day.getDay()] ?? "",
				day: day.getDate(),
				...(label === undefined
					? {}
					:
						{
							label,
						}),
				isToday: day.getTime() === todayTs,
			};
		}),
		months: months.map((month, index) =>
		{
			const label = index === 0 || month.getMonth() === 0 ? String(month.getFullYear()) : undefined;
			return {
				ts: month.getTime(),
				text: MONTHS[month.getMonth()] ?? "",
				...(label === undefined
					? {}
					:
						{
							label,
						}),
			};
		}),
		separator: level !== "year" && months.length > 0,
	};
}
