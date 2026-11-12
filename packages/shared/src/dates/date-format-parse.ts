import dayjs from "dayjs";
import type {Dayjs} from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import {DATE_FORMATS_SHORT} from "./date-markup.js";

dayjs.extend(customParseFormat);

export const DEFAULT_DATE_FORMAT: string = DATE_FORMATS_SHORT[0];

export interface ParsedDate
{
	start: Date;
	end?: Date;
}

/** Upstream's `jd4`: true when the format puts the day before the month. */
function isDayFirst(format: string): boolean
{
	const core = format.replace(/^d+[,\s]*/u, "");
	const day = core.indexOf("D");
	const month = core.indexOf("M");
	if (day === -1)
	{
		return false;
	}
	if (month === -1)
	{
		return true;
	}
	return day < month;
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CANONICAL_NAMES = new Map(
	[...MONTHS, ...WEEKDAYS].flatMap((name) => [
		[name.toLowerCase(), name],
		[name.slice(0, 3).toLowerCase(), name.slice(0, 3)],
	]),
);

/** dayjs matches month and weekday names case-sensitively; upstream's moment does not, so canonicalize their case first. */
function canonicalizeNames(term: string): string
{
	return term.replaceAll(/\p{L}+/gu, (word) => CANONICAL_NAMES.get(word.toLowerCase()) ?? word);
}

const PADDED_MONTH = /\bMM(?!M)\b/u;
const PADDED_DAY = /\bDD(?!D)\b/u;

/**
 * Port of upstream's `vi1` (`WF.Date.parse`): a strict dayjs parse with the current date
 * format, then the same fallback chain — strip a leading weekday, keep only the D/M/Y
 * core, allow two-digit and missing years, single-digit month/day, bare `d/m` or `m/d`
 * per the format's order, and a ` - ` split for ranges. Formats without a year take
 * `now`'s year.
 */
export function parseWithFormat(
	term: string,
	dateFormat: string = DEFAULT_DATE_FORMAT,
	now = new Date(),
): ParsedDate | undefined
{
	const parsed = parseDayjs(term, dateFormat, now);
	if (!parsed)
	{
		return undefined;
	}
	return parsed.end
		?
			{
				start: parsed.start.toDate(),
				end: parsed.end.toDate(),
			}
		:
			{
				start: parsed.start.toDate(),
			};
}

function twoDigitYear(result: Dayjs): Dayjs
{
	return result.isValid() && result.year() < 100 ? result.add(2000, "year") : result;
}

function parseDayjs(
	input: string,
	dateFormat: string,
	now: Date,
):
	|
	  {
			start: Dayjs;
			end?: Dayjs;
	  }
	| undefined
{
	const term = canonicalizeNames(input.trim());
	const strict = (text: string, format: string): Dayjs =>
	{
		const result = dayjs(text, format, true);
		return result.isValid() && !/Y/u.test(format) ? result.year(now.getFullYear()) : result;
	};
	const relaxedPadding = (text: string, format: string): Dayjs =>
	{
		let result = strict(text, format);
		if (!result.isValid())
		{
			result = strict(text, format.replace(PADDED_MONTH, "M"));
		}
		if (!result.isValid())
		{
			result = strict(text, format.replace(PADDED_DAY, "D"));
		}
		if (!result.isValid())
		{
			result = strict(text, format.replace(PADDED_MONTH, "M").replace(PADDED_DAY, "D"));
		}
		return result;
	};

	let format = dateFormat;
	let result = strict(term, format);
	if (!result.isValid() && format.startsWith("dd "))
	{
		format = format.slice(3).trim();
		result = strict(term, format);
	}
	if (!result.isValid() && format.startsWith("ddd "))
	{
		format = format.slice(4).trim();
		result = strict(term, format);
	}
	if (!result.isValid() && format.startsWith("ddd,"))
	{
		format = format.slice(4).trim();
		result = strict(term, format);
		if (!result.isValid())
		{
			result = strict(term.slice(4).trim(), format);
		}
	}
	if (!result.isValid())
	{
		const core = format
			.replaceAll(/\[.*?\]/gu, (literal) => "_".repeat(literal.length))
			.match(/[DMY].*[DMY]|[DMY]/u);
		if (core?.index !== undefined)
		{
			const coreFormat = format.slice(core.index, core.index + core[0].length);
			if (coreFormat !== format)
			{
				format = coreFormat;
				result = strict(term, format);
			}
		}
	}
	if (!result.isValid() && format.endsWith("YYYY"))
	{
		result = strict(term, format.slice(0, -2));
	}
	if (!result.isValid())
	{
		if (format.endsWith("YYYY"))
		{
			format = format.slice(0, -3);
		}
		result = twoDigitYear(relaxedPadding(term, format));
	}
	if (!result.isValid())
	{
		const yearless = dateFormat.replaceAll(/[./-]?Y{1,4}[./-]?/gu, "").trim();
		if (yearless)
		{
			result = relaxedPadding(term, yearless);
		}
	}
	if (!result.isValid())
	{
		const numeric = term.match(/^(\d{1,2})([/.])(\d{1,2})(?:\2\d{2,4})?$/u);
		if (numeric)
		{
			const separator = numeric[2] ?? "/";
			const [first, second] = isDayFirst(dateFormat) ? ["D", "M"] : ["M", "D"];
			const short = `${first}${separator}${second}`;
			const padded = `${first.repeat(2)}${separator}${second.repeat(2)}`;
			result = strict(term, `${short}${separator}Y`);
			if (!result.isValid())
			{
				result = strict(term, short);
			}
			if (!result.isValid())
			{
				result = strict(term, `${padded}${separator}Y`);
			}
			if (!result.isValid())
			{
				result = strict(term, padded);
			}
			result = twoDigitYear(result);
		}
	}
	if (result.isValid())
	{
		return {
			start: result,
		};
	}
	if (term.includes(" - "))
	{
		const [first, second, ...rest] = term.split(" - ");
		if (first !== undefined && second !== undefined && rest.length === 0)
		{
			const start = parseDayjs(first, dateFormat, now);
			const end = parseDayjs(second, dateFormat, now);
			if (start && end)
			{
				return {
					start: start.start,
					end: end.start,
				};
			}
		}
	}
	return undefined;
}
