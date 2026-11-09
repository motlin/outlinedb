import type {CacheService} from "@outlinedb/shared/cache";
import {findCalendarDay} from "@outlinedb/shared/calendar-lookup";
import type {CalendarDayDeps} from "@outlinedb/shared/calendar-lookup";

type Database = CalendarDayDeps["db"];

/** A `YYYY-MM-DD` date as the calendar's `YYYYMMDD` dateId, or undefined when it is not that shape. */
export function isoDateId(date: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(date);
	return match === null ? undefined : Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]);
}

/**
 * The journal entries already on each date, keyed by the `YYYY-MM-DD` date. A date's entries are the named
 * children of the 📆 Calendar day node workflowy.com would use, found by the same strict metadata walk it uses.
 * Rows that merely mention the date, and day nodes workflowy.com ignores, contribute nothing.
 */
export function loadExistingEntries(
	db: Database,
	cache: CacheService,
	dates: readonly string[],
): Record<string, string[]> {
	const existing: Record<string, string[]> = {};
	for (const date of dates) {
		const dateId = isoDateId(date);
		const dayId = dateId === undefined ? null : findCalendarDay({db, cache}, dateId);
		if (dayId === null) {
			continue;
		}
		const entries = cache.getChildren(dayId).flatMap(({name}) => (name === null || name === "" ? [] : [name]));
		if (entries.length > 0) {
			existing[date] = entries;
		}
	}
	return existing;
}
