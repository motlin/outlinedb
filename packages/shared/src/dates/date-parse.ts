import {editorChrono} from "./chrono-v1.js";
import type {ChronoV1Components, ChronoV1Result} from "./chrono-v1.js";
import {DEFAULT_DATE_FORMAT, parseWithFormat} from "./date-format-parse.js";
import type {ParsedDate} from "./date-format-parse.js";
import type {TimeAttrs} from "./date-markup.js";

export {parseWithFormat} from "./date-format-parse.js";
export type {ParsedDate} from "./date-format-parse.js";

export interface GuessDatesOptions
{
	dateFormat?: string;
	now?: Date;
	/** 0 = Sunday (default), 1 = Monday. */
	weekStartDay?: number;
}

export interface PresetDateOptions
{
	/** 0 = Sunday (default), 1 = Monday. */
	weekStartDay?: number;
	now?: Date;
}

export type DatePreset = "today" | "tomorrow" | "next week";

function startOfDay(date: Date): Date
{
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Guess the date (or `[start, end]` range) a picker input means, as local midnights:
 * `parseWithFormat` first, also on the date half of a `<time> on <date>` pill label,
 * then chrono, accepted only when it finds exactly one result. `[]` when nothing parses.
 */
export function guessDates(term: string, options: GuessDatesOptions = {}): Date[]
{
	const {dateFormat = DEFAULT_DATE_FORMAT, now = new Date(), weekStartDay} = options;
	const timed = term.trim().match(/^\S+ on (.+)$/u);
	const parsed =
		parseWithFormat(term, dateFormat, now) ?? (timed?.[1] ? parseWithFormat(timed[1], dateFormat, now) : undefined);
	if (parsed)
	{
		return parsed.end ? [parsed.start, parsed.end] : [parsed.start];
	}

	const results = editorChrono(
		{
			now,
			dateFormat,
			...(weekStartDay === undefined
				? {}
				:
					{
						weekStartDay,
					}),
		},
	)(term);
	const [result, ...others] = results;
	if (!result || others.length > 0)
	{
		return [];
	}
	const start = startOfDay(result.start.date());
	return result.end ? [start, startOfDay(result.end.date())] : [start];
}

/** The date a picker preset applies; "next week" is the first day of next week per `weekStartDay`. */
export function presetDate(preset: DatePreset, options: PresetDateOptions = {}): Date
{
	const {weekStartDay = 0, now = new Date()} = options;
	const today = startOfDay(now);
	if (preset === "today")
	{
		return today;
	}
	if (preset === "tomorrow")
	{
		return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
	}
	const daysIntoWeek = (today.getDay() - weekStartDay + 7) % 7;
	return new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysIntoWeek + 7);
}

export interface DatePhrase
{
	/** Offset in the searched text where the date phrase starts. */
	start: number;
	/** Offset where the phrase (or a trailing range separator, or the caret past it) ends. */
	end: number;
	attrs: TimeAttrs;
}

function escapeRegExp(text: string): string
{
	return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function componentParts(component: ChronoV1Components):
{
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
}
{
	const date = component.date();
	const parts =
	{
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
	};
	return component.isCertain("hour")
		?
			{
				...parts,
				hour: date.getHours(),
				minute: date.getMinutes(),
			}
		: parts;
}

function startAttrs(component: ChronoV1Components): TimeAttrs
{
	const {year, month, day, hour, minute} = componentParts(component);
	const attrs: TimeAttrs =
	{
		startYear: year,
		startMonth: month,
		startDay: day,
	};
	return hour === undefined
		? attrs
		:
			{
				...attrs,
				startHour: hour,
				startMinute: minute,
			};
}

function endAttrs(component: ChronoV1Components): Partial<TimeAttrs>
{
	const {year, month, day, hour, minute} = componentParts(component);
	const attrs: Partial<TimeAttrs> =
	{
		endYear: year,
		endMonth: month,
		endDay: day,
	};
	return hour === undefined
		? attrs
		:
			{
				...attrs,
				endHour: hour,
				endMinute: minute,
			};
}

function datePhraseIn(text: string, caret: number, parse: (text: string) => ChronoV1Result[]): DatePhrase | undefined
{
	for (const result of parse(text))
	{
		const phrase = result.text.trim();
		const index = result.index + result.text.length - result.text.trimStart().length;
		const phraseEnd = index + phrase.length;
		const caretInPhrase = caret >= index && caret <= phraseEnd;
		const end = Math.max(caret, phraseEnd);
		const tail = text.slice(index, end);
		const start = startAttrs(result.start);
		if (result.end)
		{
			if (caretInPhrase && /\s?-\s?|\sto\s/u.test(tail))
			{
				return {
					start: index,
					end,
					attrs:
					{
						...start,
						...endAttrs(result.end),
					},
				};
			}
			continue;
		}
		if (new RegExp(String.raw`^${escapeRegExp(phrase)}(?:\sto\s|\s?-)\s?$`, "u").test(tail))
		{
			const next = result.start.date();
			next.setDate(next.getDate() + 1);
			return {
				start: index,
				end,
				attrs:
				{
					...start,
					endYear: next.getFullYear(),
					endMonth: next.getMonth() + 1,
					endDay: next.getDate(),
				},
			};
		}
		if (caretInPhrase)
		{
			return {
				start: index,
				end,
				attrs: start,
			};
		}
	}
	return undefined;
}

/**
 * Upstream's date autocomplete (`z42`): the chrono date phrase in `text` that the collapsed
 * `caret` sits in or at the end of, trying the whole text and then the text up to the caret.
 * A range needs an explicit `-` or ` to `; a single date followed by a trailing `-` or ` to `
 * becomes a range ending one day later, its end then covering the separator.
 */
export function findDatePhrase(
	text: string,
	caret: number,
	now: Date = new Date(),
	options: Omit<GuessDatesOptions, "now"> = {},
): DatePhrase | undefined
{
	const {dateFormat, weekStartDay} = options;
	const parse = editorChrono(
		{
			now,
			...(dateFormat === undefined
				? {}
				:
					{
						dateFormat,
					}),
			...(weekStartDay === undefined
				? {}
				:
					{
						weekStartDay,
					}),
		},
	);
	return datePhraseIn(text, caret, parse) ?? datePhraseIn(text.slice(0, caret), caret, parse);
}
