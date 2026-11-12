import {DATE_FORMATS_SHORT, TIME_FORMATS, formatPillLabel} from "@outlinedb/shared";
import type {TimeAttrs} from "@outlinedb/shared";

export interface DateSettings
{
	dateFormat: string;
	timeFormat: string;
	/** 0 = Sunday (upstream's default, stored as an absent key), 1 = Monday. */
	weekStartDay: number;
}

/** The date fields of `/api/v1/preferences`; null means unset. */
export interface DatePreferences
{
	dateFormat: string | null;
	timeFormat: string | null;
	weekStartDay: number | null;
}

/** Upstream's defaults for an account that never changed Settings > Dates. */
export const DEFAULT_DATE_SETTINGS: DateSettings =
{
	dateFormat: DATE_FORMATS_SHORT[0],
	timeFormat: TIME_FORMATS[0],
	weekStartDay: 0,
};

function nonEmpty(value: string | null, fallback: string): string
{
	return value === null || value === "" ? fallback : value;
}

export function resolveDateSettings(preferences: DatePreferences): DateSettings
{
	return {
		dateFormat: nonEmpty(preferences.dateFormat, DEFAULT_DATE_SETTINGS.dateFormat),
		timeFormat: nonEmpty(preferences.timeFormat, DEFAULT_DATE_SETTINGS.timeFormat),
		weekStartDay: preferences.weekStartDay ?? DEFAULT_DATE_SETTINGS.weekStartDay,
	};
}

export interface FormatOption
{
	value: string;
	label: string;
}

function todayAttrs(now: Date): TimeAttrs
{
	return {
		startYear: now.getFullYear(),
		startMonth: now.getMonth() + 1,
		startDay: now.getDate(),
		startHour: now.getHours(),
		startMinute: now.getMinutes(),
	};
}

/** Settings > Dates "Date format" options, each labelled with today rendered in it. */
export function dateFormatOptions(now: Date = new Date()): FormatOption[]
{
	const {startHour: _hour, startMinute: _minute, ...date} = todayAttrs(now);
	return DATE_FORMATS_SHORT.map((value) => (
	{
		value,
		label: formatPillLabel(
			date,
			{
				dateFormat: value,
				now,
			},
		),
	}));
}

/** Settings > Dates "Time format" options, each labelled with the current time rendered in it. */
export function timeFormatOptions(now: Date = new Date()): FormatOption[]
{
	// A timed pill label is "<time> on <date>", and no time format contains " on ".
	return TIME_FORMATS.map((value) => (
	{
		value,
		label:
			formatPillLabel(
				todayAttrs(now),
				{
					timeFormat: value,
					now,
				},
			).split(" on ")[0] ?? value,
	}));
}

/** The PATCH for a Start of week choice: Sunday removes the key, as upstream does. */
export function weekStartPatch(day: 0 | 1):
{
	weekStartDay: number | null;
}
{
	return {
		weekStartDay: day === 0 ? null : 1,
	};
}
