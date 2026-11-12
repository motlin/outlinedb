import {useQueries} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useCallback, useState} from "react";
import type {CalendarDaysResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";

/** A calendar month, `month` 1-12. */
export interface CalendarMonth
{
	year: number;
	month: number;
}

/** Which days the picker dots: `found` (the strip's picker) adds existing days that Found Dates cover. */
export interface EventDayOptions
{
	found?: boolean;
}

export function calendarDaysUrl({year, month}: CalendarMonth, {found = false}: EventDayOptions = {}): string
{
	return `/api/v1/calendar/days?year=${year}&month=${month}${found ? "&found=1" : ""}`;
}

async function fetchCalendarDays(visible: CalendarMonth, options: EventDayOptions): Promise<number[]>
{
	const response = await fetch(calendarDaysUrl(visible, options));
	if (!response.ok)
	{
		throw new Error(`Failed to fetch calendar days: ${response.statusText}`);
	}
	return (await readJson<CalendarDaysResponse>(response)).days;
}

/** The query key for a month's dotted days; the strip's Found Dates variant is cached apart. */
export function calendarDaysKey({year, month}: CalendarMonth, {found = false}: EventDayOptions = {})
{
	return ["calendar-days", year, month, found] as const;
}

/** The months either side of `visible`, which the picker can page to next. */
export function adjacentMonths({year, month}: CalendarMonth): [CalendarMonth, CalendarMonth]
{
	return [
		month === 1
			?
				{
					year: year - 1,
					month: 12,
				}
			:
				{
					year,
					month: month - 1,
				},
		month === 12
			?
				{
					year: year + 1,
					month: 1,
				}
			:
				{
					year,
					month: month + 1,
				},
	];
}

/**
 * Load a month's dotted days into the cache before a picker shows it, so its
 * dots paint with the grid; a month still fresh in the cache is not refetched.
 */
export async function prefetchCalendarDays(
	queryClient: QueryClient,
	visible: CalendarMonth,
	options: EventDayOptions = {},
): Promise<void>
{
	// A failed prefetch is dropped: the picker fetches the month itself when it shows it.
	await queryClient
		.query(
			{
				queryKey: calendarDaysKey(visible, options),
				queryFn: async () => fetchCalendarDays(visible, options),
				retry: false,
			},
		)
		.catch(() => {});
}

/**
 * Load the current month and both neighbours into the cache when a name or note gains the caret, so a `!!` popup's
 * first frame already has its dots (upstream reads the in-memory tree synchronously).
 */
export function prefetchPickerMonths(queryClient: QueryClient, now: Date = new Date()): void
{
	const current =
	{
		year: now.getFullYear(),
		month: now.getMonth() + 1,
	};
	for (const month of [current, ...adjacentMonths(current)])
	{
		void prefetchCalendarDays(queryClient, month);
	}
}

/** The key {@link eventDayPredicate} looks a month up by: `year-month`, month 1-12. */
function monthKey({year, month}: CalendarMonth): string
{
	return `${year}-${month}`;
}

/** Whether a date is one of the loaded days of its own month; nothing is marked until a month's days load. */
export function eventDayPredicate(byMonth: ReadonlyMap<string, readonly number[]>): (date: Date) => boolean
{
	return (date) =>
		byMonth
			.get(
				monthKey(
					{
						year: date.getFullYear(),
						month: date.getMonth() + 1,
					},
				),
			)
			?.includes(date.getDate()) ?? false;
}

/**
 * The date picker's event dots (upstream DP10): which days of the visible month and both months either side have
 * journal content under 📆 Calendar, one query per month, so the grid's leading and trailing cells are dotted too.
 */
export function useCalendarEventDays({found = false}: EventDayOptions = {}):
{
	hasEvent: (date: Date) => boolean;
	onVisibleMonthChange: (visible: CalendarMonth) => void;
}
{
	const [visible, setVisible] = useState<CalendarMonth | null>(null);
	const months = visible === null ? [] : [visible, ...adjacentMonths(visible)];
	const results = useQueries(
		{
			queries: months.map((month) => (
			{
				queryKey: calendarDaysKey(
					month,
					{
						found,
					},
				),
				queryFn: async () =>
					fetchCalendarDays(
						month,
						{
							found,
						},
					),
			})),
		},
	);
	const byMonth = new Map<string, readonly number[]>();
	for (const [index, month] of months.entries())
	{
		const days = results[index]?.data;
		if (days)
		{
			byMonth.set(monthKey(month), days);
		}
	}
	const onVisibleMonthChange = useCallback((next: CalendarMonth) =>
	{
		setVisible((current) => (current?.year === next.year && current.month === next.month ? current : next));
	}, []);
	return {
		hasEvent: eventDayPredicate(byMonth),
		onVisibleMonthChange,
	};
}
