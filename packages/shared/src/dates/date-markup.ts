import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import isoWeek from "dayjs/plugin/isoWeek.js";
import localizedFormat from "dayjs/plugin/localizedFormat.js";
import weekOfYear from "dayjs/plugin/weekOfYear.js";
import weekYear from "dayjs/plugin/weekYear.js";

dayjs.extend(advancedFormat);
dayjs.extend(weekOfYear);
dayjs.extend(isoWeek);
dayjs.extend(weekYear);
dayjs.extend(localizedFormat);

export interface TimeAttrs
{
	startYear: number;
	startMonth: number;
	startDay: number;
	startHour?: number;
	startMinute?: number;
	endYear?: number;
	endMonth?: number;
	endDay?: number;
	endHour?: number;
	endMinute?: number;
}

export interface PillLabelOptions
{
	dateFormat?: string;
	timeFormat?: string;
	now?: Date;
}

export const DATE_FORMATS_SHORT = [
	"ddd, MMM D",
	"ddd, MMM D, YYYY",
	"dddd, MMMM Do",
	"dddd [the] Do [of] MMMM",
	"Do [of] MMMM",
	"MMMM Do, YYYY",
	"MM/DD/YYYY",
	"DD/MM/YYYY",
	"DD.MM.YYYY",
	"YYYY-MM-DD",
] as const;

export const DATE_FORMATS_LONG = [
	"ddd, MMM D, YYYY",
	"ddd, MMM D, YYYY",
	"dddd, MMMM Do, YYYY",
	"dddd [the] Do [of] MMMM, YYYY",
	"Do [of] MMMM, YYYY",
	"MMMM Do, YYYY",
	"MM/DD/YYYY",
	"DD/MM/YYYY",
	"DD.MM.YYYY",
	"YYYY-MM-DD",
] as const;

export const TIME_FORMATS = ["h:mma", "HH:mm"] as const;

const MARKUP_DATE_FORMAT = "ddd, MMM D, YYYY";
const MARKUP_TIME_FORMAT = "h:mma";

// Canonical attribute order interleaves start/end per unit.
const ATTR_ORDER = [
	"startYear",
	"endYear",
	"startMonth",
	"endMonth",
	"startDay",
	"endDay",
	"startHour",
	"endHour",
	"startMinute",
	"endMinute",
] as const satisfies readonly (keyof TimeAttrs)[];

const CANONICAL_ATTR_NAMES = new Map<string, string>(ATTR_ORDER.map((name) => [name.toLowerCase(), name]));
const TIME_OPEN_TAG = /<time\b[^>]*>/giu;
/** One attribute with its value consumed, so text inside a quoted value never matches as a name. */
const ATTRIBUTE = /(\s)([\w-]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/gu;

/**
 * Restore upstream's camelCase `<time>` attribute names (`startYear`, ...) in HTML read
 * back from the DOM, whose `innerHTML` serializes attribute names lowercased. Other tags,
 * other attributes, and attribute values are left alone.
 */
export function canonicalTimeAttributes(html: string): string
{
	return html.replaceAll(TIME_OPEN_TAG, (tag) =>
		tag.replaceAll(ATTRIBUTE, (match, space: string, name: string, value: string | undefined) =>
		{
			const canonical = CANONICAL_ATTR_NAMES.get(name.toLowerCase());
			return canonical === undefined ? match : `${space}${canonical}${value ?? ""}`;
		}),
	);
}

type Side = "start" | "end";

interface Moment
{
	date: dayjs.Dayjs;
	hasTime: boolean;
}

function momentOf(attrs: TimeAttrs, side: Side): Moment
{
	const year = side === "start" ? attrs.startYear : (attrs.endYear ?? attrs.startYear);
	const month = side === "start" ? attrs.startMonth : (attrs.endMonth ?? attrs.startMonth);
	const day = side === "start" ? attrs.startDay : (attrs.endDay ?? attrs.startDay);
	const hour = side === "start" ? attrs.startHour : attrs.endHour;
	const minute = side === "start" ? attrs.startMinute : attrs.endMinute;
	const hasTime = hour !== undefined;
	return {
		date: dayjs(new Date(year, month - 1, day, hour ?? 0, minute ?? 0)),
		hasTime,
	};
}

function hasEnd(attrs: TimeAttrs): boolean
{
	return attrs.endYear !== undefined || attrs.endMonth !== undefined || attrs.endDay !== undefined;
}

function moments(attrs: TimeAttrs): Moment[]
{
	return hasEnd(attrs) ? [momentOf(attrs, "start"), momentOf(attrs, "end")] : [momentOf(attrs, "start")];
}

function dateFormatFor(dateFormat: string, year: number, currentYear: number): string
{
	if (year === currentYear)
	{
		return dateFormat;
	}
	const index = (DATE_FORMATS_SHORT as readonly string[]).indexOf(dateFormat);
	if (index !== -1)
	{
		return DATE_FORMATS_LONG[index] ?? dateFormat;
	}
	return /[yY]/u.test(dateFormat) ? dateFormat : `${dateFormat}, YYYY`;
}

/**
 * Upstream's item-menu footer stamp: `Today at <time>` for the current day, else `<date> at <time>`, the date format
 * gaining a year when `date` is in another year than `now`.
 */
export function formatAccountTimestamp(
	date: Date,
	now: Date,
	formats:
	{
		dateFormat: string;
		timeFormat: string;
	},
): string
{
	const moment = dayjs(date);
	const time = moment.format(formats.timeFormat);
	if (moment.isSame(now, "day"))
	{
		return `Today at ${time}`;
	}
	return `${moment.format(dateFormatFor(formats.dateFormat, date.getFullYear(), now.getFullYear()))} at ${time}`;
}

/** Display label for a date pill, built from the attributes (inner text is ignored). */
export function formatPillLabel(attrs: TimeAttrs, options: PillLabelOptions = {}): string
{
	const dateFormat = options.dateFormat ?? DATE_FORMATS_SHORT[0];
	const timeFormat = options.timeFormat ?? TIME_FORMATS[0];
	const currentYear = (options.now ?? new Date()).getFullYear();
	return moments(attrs)
		.map(({date, hasTime}) =>
		{
			const dateText = date.format(dateFormatFor(dateFormat, date.year(), currentYear));
			return hasTime ? `${date.format(timeFormat)} on ${dateText}` : dateText;
		})
		.join(" - ");
}

/** Canonical `<time>` storage markup with interleaved attributes and markup-format inner text. */
export function toTimeMarkup(attrs: TimeAttrs): string
{
	const attrText = ATTR_ORDER.filter((key) => attrs[key] !== undefined)
		.map((key) => `${key}="${attrs[key]}"`)
		.join(" ");
	const text = moments(attrs)
		.map(({date, hasTime}) =>
			date.format(hasTime ? `${MARKUP_DATE_FORMAT} [at] ${MARKUP_TIME_FORMAT}` : MARKUP_DATE_FORMAT),
		)
		.join(" - ");
	return `<time ${attrText}>${text}</time>`;
}

/** The DOM attribute text of a displayed pill: known units only, lowercase names, canonical interleaved order. */
export function domTimeAttributes(attrs: Partial<TimeAttrs>): string
{
	return ATTR_ORDER.filter((key) => attrs[key] !== undefined)
		.map((key) => `${key.toLowerCase()}="${attrs[key]}"`)
		.join(" ");
}

const ATTR_BY_LOWER = new Map<string, keyof TimeAttrs>(ATTR_ORDER.map((key) => [key.toLowerCase(), key]));

const INVALID_DATE = "Invalid date";

/** Parse whatever numeric `<time>` attributes are present (either quote style); never throws. */
export function parseTimeAttrsLoose(attrText: string): Partial<TimeAttrs>
{
	const found: Partial<TimeAttrs> = {};
	for (const match of attrText.matchAll(/([A-Za-z]+)\s*=\s*(?:"(\d+)"|'(\d+)')/gu))
	{
		const [, name, double, single] = match;
		const value = double ?? single;
		const key = name === undefined ? undefined : ATTR_BY_LOWER.get(name.toLowerCase());
		if (key !== undefined && value !== undefined)
		{
			found[key] = Number(value);
		}
	}
	const result: Partial<TimeAttrs> = {};
	for (const key of ATTR_ORDER_START_FIRST)
	{
		const value = found[key];
		if (value !== undefined)
		{
			result[key] = value;
		}
	}
	return result;
}

const ATTR_ORDER_START_FIRST = [
	"startYear",
	"startMonth",
	"startDay",
	"startHour",
	"startMinute",
	"endYear",
	"endMonth",
	"endDay",
	"endHour",
	"endMinute",
] as const satisfies readonly (keyof TimeAttrs)[];

/** Parse `<time>` attribute text (camelCase or DOM-lowercased) into numeric attrs in canonical order. */
export function parseTimeAttrs(attrText: string): TimeAttrs
{
	const found = parseTimeAttrsLoose(attrText);
	const {startYear, startMonth, startDay} = found;
	if (startYear === undefined || startMonth === undefined || startDay === undefined)
	{
		throw new Error(`Missing startYear/startMonth/startDay in time attributes: ${attrText}`);
	}
	const result: TimeAttrs =
	{
		startYear,
		startMonth,
		startDay,
	};
	for (const key of ["startHour", "startMinute", "endYear", "endMonth", "endDay", "endHour", "endMinute"] as const)
	{
		const value = found[key];
		if (value !== undefined)
		{
			result[key] = value;
		}
	}
	return result;
}

function ordinal(n: number): string
{
	const mod100 = n % 100;
	const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

/** Format with dayjs, adding the `Wo` (ISO week ordinal) token that dayjs's plugins leave half-formatted. */
function formatWithTokens(date: dayjs.Dayjs, format: string): string
{
	const prepared = format
		.split(/(\[[^\]]*\])/u)
		.map((part) => (part.startsWith("[") ? part : part.replaceAll("Wo", `[${ordinal(date.isoWeek())}]`)))
		.join("");
	return date.format(prepared);
}

function looseSide(
	attrs: Partial<TimeAttrs>,
	side: Side,
	now: Date,
):
{
	date: dayjs.Dayjs;
	hasTime: boolean;
} | null
{
	const year = attrs[`${side}Year`];
	const month = attrs[`${side}Month`];
	const day = attrs[`${side}Day`];
	const hour = attrs[`${side}Hour`];
	const minute = attrs[`${side}Minute`];
	if (month === undefined)
	{
		return null;
	}
	const date = dayjs(now)
		.year(year ?? now.getFullYear())
		.month(month - 1)
		.date(day ?? now.getDate())
		.hour(hour ?? 0)
		.minute(minute ?? 0);
	return date.isValid()
		?
			{
				date,
				hasTime: hour !== undefined,
			}
		: null;
}

/**
 * Display label for a possibly incomplete `<time>`, mirroring upstream: unknown units come from
 * `now`, a side without a month is `Invalid date`, and the end side reads only `end*` keys.
 */
export function formatTimeLabel(attrs: Partial<TimeAttrs>, options: PillLabelOptions = {}): string
{
	const dateFormat = options.dateFormat ?? DATE_FORMATS_SHORT[0];
	const timeFormat = options.timeFormat ?? TIME_FORMATS[0];
	const now = options.now ?? new Date();
	const sides: Side[] = ATTR_ORDER.some((key) => key.startsWith("end") && attrs[key] !== undefined)
		? ["start", "end"]
		: ["start"];
	return sides
		.map((side) =>
		{
			const moment = looseSide(attrs, side, now);
			if (moment === null)
			{
				return INVALID_DATE;
			}
			try
			{
				const dateText = formatWithTokens(
					moment.date,
					dateFormatFor(dateFormat, moment.date.year(), now.getFullYear()),
				);
				return moment.hasTime ? `${moment.date.format(timeFormat)} on ${dateText}` : dateText;
			}
			catch
			{
				return INVALID_DATE;
			}
		})
		.join(" - ");
}

/** Formats `date` with a dayjs pattern such as the account's date or time format. */
export function formatDatePattern(date: Date, pattern: string): string
{
	return dayjs(date).format(pattern);
}
