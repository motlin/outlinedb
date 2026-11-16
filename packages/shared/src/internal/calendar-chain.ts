/**
 * The level nodes upstream's Today (`C9`) walks from the calendar root down to a date, with the account's
 * deterministic ids. Server-only: the ids hash with `node:crypto`.
 */

import
{
	CALENDAR_LEVELS,
	DEFAULT_CALENDAR_LEVELS,
	calendarDateId,
	calendarLevelMetadata,
	calendarLevelName,
} from "./calendar-day.js";
import type {CalendarDate, CalendarLevel, CalendarLevelMetadata} from "./calendar-day.js";
import {calendarNodeId} from "./calendar-ids.js";

/** One level node on the way from the calendar root down to a date, as upstream's Today (`C9`) makes it. */
export interface CalendarChainSpec
{
	level: CalendarLevel;
	levelDateId: number;
	/** The account's deterministic id for the node, or undefined without an entropy key. */
	id: string | undefined;
	name: string;
	metadata:
	{
		restorableUniqueNode: true;
		calendar: CalendarLevelMetadata;
	};
}

/**
 * The level nodes, outermost first, that hold `date` down to `stopAt` among the levels the root shows (upstream `GO`:
 * the root's `calendar.levels`, a missing key off, else {@link DEFAULT_CALENDAR_LEVELS}).
 */
export function calendarChainSpecs(
	date: CalendarDate,
	{
		shown = DEFAULT_CALENDAR_LEVELS,
		stopAt,
		dateFormat,
		weekStartDay = 0,
		timeZone,
		entropyKey,
	}:
	{
		shown?: Readonly<Partial<Record<CalendarLevel, boolean>>> | undefined;
		stopAt: CalendarLevel;
		dateFormat: string;
		weekStartDay?: number;
		/** The account's IANA timezone, whose midnight each level's timestamp is; the host's without one. */
		timeZone?: string | undefined;
		entropyKey: string | undefined;
	},
): CalendarChainSpec[]
{
	return CALENDAR_LEVELS.slice(0, CALENDAR_LEVELS.indexOf(stopAt) + 1)
		.filter((level) => shown[level] === true)
		.map((level) =>
		{
			const levelDateId = calendarDateId(level, date, weekStartDay);
			return {
				level,
				levelDateId,
				id: entropyKey === undefined ? undefined : calendarNodeId(entropyKey, level, levelDateId, date.year),
				name: calendarLevelName(level, date, dateFormat, weekStartDay),
				metadata:
				{
					restorableUniqueNode: true,
					calendar: calendarLevelMetadata(level, date, weekStartDay, timeZone),
				},
			};
		});
}
