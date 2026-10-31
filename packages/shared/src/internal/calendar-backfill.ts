import {calendarLevelMetadata} from "./calendar-day.js";
import type {CalendarDate} from "./calendar-day.js";

/** One calendar node's `calendar.level` and `calendar.value`. */
export interface CalendarLevelValue {
	level?: string | undefined;
	value?: unknown;
}

const DATED_LEVELS = ["year", "month", "day"] as const;
type DatedLevel = (typeof DATED_LEVELS)[number];

function isDatedLevel(level: string | undefined): level is DatedLevel {
	return DATED_LEVELS.some((dated) => dated === level);
}

/**
 * Upstream `u10` + `m.timestamp`: the timestamp of a calendar node rebuilt
 * from the `value`s of its chain (the node first, then each calendar ancestor
 * up to the root), starting from 1970-01-01. Undefined when the node itself
 * is not a year, month or day. Unlike upstream, which stops at a week
 * ancestor and so dates a day under a week to January 1970, week ancestors
 * are walked past; a value that is not a number is skipped like upstream's
 * missing value.
 */
export function backfilledCalendarTimestamp(chain: readonly CalendarLevelValue[]): number | undefined {
	const [own] = chain;
	if (own === undefined || !isDatedLevel(own.level)) {
		return undefined;
	}
	const date: CalendarDate = {year: 1970, month: 1, day: 1};
	for (const {level, value} of chain.toReversed()) {
		const number =
			(typeof value === "string" && value !== "") || typeof value === "number" ? Number(value) : Number.NaN;
		if (!isDatedLevel(level) || !Number.isInteger(number)) {
			continue;
		}
		date[level] = number;
	}
	return calendarLevelMetadata(own.level, date).timestamp;
}

/**
 * Upstream `h10`: a level node's `dateId` from its `timestamp`, read at local
 * noon of that day so a DST shift cannot move it to the day before.
 * Undefined for an unknown level.
 */
export function backfilledCalendarDateId(level: string | undefined, timestamp: number): number | undefined {
	const noon = new Date(timestamp + 12 * 60 * 60 * 1000);
	const year = noon.getFullYear() * 10_000;
	const month = (noon.getMonth() + 1) * 100;
	const dateIds: Record<string, number> = {
		year,
		month: year + month,
		day: year + month + noon.getDate(),
		week: year + month + noon.getDate(),
	};
	return level === undefined ? undefined : dateIds[level];
}
