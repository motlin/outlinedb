import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import {searchChrono} from "../../dates/chrono-v1.js";
import type {ChronoV1Components} from "../../dates/chrono-v1.js";
import {DATE_FORMATS_SHORT, parseTimeAttrs} from "../../dates/date-markup.js";
import type {TimeAttrs} from "../../dates/date-markup.js";
import type {SearchItem, SearchOperator, TokenContext} from "../query-nodes.js";
import {MetaNode} from "./meta.js";

dayjs.extend(customParseFormat);

const TIME_TAG = /<time\b([^>]*)>/giu;
const TIME_FORMAT = "HH:mm";

function rowDates(item: SearchItem): TimeAttrs[]
{
	return [item.nameHtml, item.noteHtml].flatMap((html) =>
		[...html.matchAll(TIME_TAG)].flatMap((match) =>
		{
			try
			{
				return [parseTimeAttrs(match[1] ?? "")];
			}
			catch
			{
				return [];
			}
		}),
	);
}

/** Port of upstream's date-attribute matcher: the start (hour defaulting to 0) or the end at 00:00. */
function rowTimestamps(attrs: TimeAttrs): number[]
{
	const start = new Date(
		attrs.startYear,
		attrs.startMonth - 1,
		attrs.startDay,
		attrs.startHour ?? 0,
		attrs.startMinute ?? 0,
	).getTime();
	if (attrs.endYear === undefined || attrs.endMonth === undefined || attrs.endDay === undefined)
	{
		return [start];
	}
	return [start, new Date(attrs.endYear, attrs.endMonth - 1, attrs.endDay).getTime()];
}

const hasDate = (item: SearchItem): boolean => /<time\b/iu.test(item.nameHtml) || /<time\b/iu.test(item.noteHtml);

function dateNode(test: ((timestamp: number) => boolean) | null): MetaNode
{
	return new MetaNode(
		(item) => test !== null && rowDates(item).some((attrs) => rowTimestamps(attrs).some(test)),
		{
			hasSearchTypeValue: hasDate,
		},
	);
}

const predefined = (candidate: string): boolean => (DATE_FORMATS_SHORT as readonly string[]).includes(candidate);

/** Upstream's `normalizeFormat`: a predefined format without spaces, else a numeric fallback in D/M order. */
function normalizeFormat(format: string): string
{
	if (predefined(format) && !format.includes(" "))
	{
		return format;
	}
	const found = format.split(" ").find(predefined);
	if (found !== undefined)
	{
		return found;
	}
	const day = format.search(/\bD[Do]?\b/u);
	const month = format.search(/\bM{1,4}\b/u);
	return day >= 0 && month >= 0 && day < month ? "DD/MM/YYYY" : "MM/DD/YYYY";
}

function product(lists: (string | null)[][]): (string | null)[][]
{
	return lists.reduce<(string | null)[][]>(
		(acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])),
		[[]],
	);
}

const SEGMENT_OPTIONS: Record<string, (string | null)[]> =
{
	Y: [null, "YY", "YYYY"],
	M: ["M", "MM"],
	D: ["D", "DD"],
};

/**
 * Port of upstream's strict `date:` value parse: every Y/YY/YYYY x M/MM x D/DD variant of the account format,
 * each with and without `@HH:mm`. Returns null when no variant parses.
 */
export function parseStrictDate(value: string, dateFormat: string): number | null
{
	const format = normalizeFormat(dateFormat);
	const separator = [".", "/", "-"].find((sep) => format.includes(sep));
	if (separator === undefined)
	{
		return null;
	}
	const segments = format.split(separator).map((part) => SEGMENT_OPTIONS[part[0] ?? ""] ?? [part]);
	const dateFormats = product(segments).map((parts) => parts.filter((part) => part !== null).join(separator));
	for (const candidate of dateFormats.flatMap((date) => [date, `${date}@${TIME_FORMAT}`]))
	{
		const parsed = dayjs(value, candidate, true);
		if (parsed.isValid())
		{
			return parsed.valueOf();
		}
	}
	return null;
}

export const past: SearchOperator =
{
	name: "date:past",
	matchesToken: (token) => token === "date:past",
	create(_token, _rawToken, context)
	{
		const today = new Date(context.now);
		today.setHours(0, 0, 0, 0);
		return dateNode((timestamp) => timestamp < today.getTime());
	},
};

export const future: SearchOperator =
{
	name: "date:future",
	matchesToken: (token) => token === "date:future",
	create: (_token, _rawToken, context) => dateNode((timestamp) => timestamp > context.now),
};

function strict(prefix: string, compare: (timestamp: number, target: number) => boolean): SearchOperator
{
	return {
		name: prefix,
		matchesToken: (token) => token.startsWith(prefix),
		create(token, _rawToken, context)
		{
			const target = parseStrictDate(token.slice(prefix.length), context.dateFormat);
			return dateNode(target === null ? null : (timestamp) => compare(timestamp, target));
		},
	};
}

export const on = strict("date:", (timestamp, target) => timestamp === target);
export const before = strict("date-before:", (timestamp, target) => timestamp < target);
export const after = strict("date-after:", (timestamp, target) => timestamp > target);

const DAY_OF_WEEK = "day-of-week:";
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const dayOfWeek: SearchOperator =
{
	name: DAY_OF_WEEK,
	matchesToken: (token) =>
		token.startsWith(DAY_OF_WEEK) && DAY_NAMES.includes(token.slice(DAY_OF_WEEK.length).trim()),
	create(token)
	{
		const day = DAY_NAMES.indexOf(token.slice(DAY_OF_WEEK.length).trim());
		return dateNode((timestamp) => new Date(timestamp).getDay() === day);
	},
};

const UNITS = ["year", "month", "day", "hour", "minute"] as const;
type Unit = (typeof UNITS)[number];

/** The slice of chrono's ParsingComponents that upstream's overlap test reads. */
interface Components
{
	isCertain(unit: Unit): boolean;
	get(unit: Unit): number | null;
}

interface DateRange
{
	start: Components;
	end: Components;
}

function knownComponents(known: Partial<Record<Unit, number>>): Components
{
	return {
		isCertain: (unit) => known[unit] !== undefined,
		get: (unit) => known[unit] ?? null,
	};
}

/** Upstream's `II`: a row `<time>` as known components, the end defaulting to the start. */
function rowRange(attrs: TimeAttrs): DateRange
{
	const start = knownComponents(
		{
			year: attrs.startYear,
			month: attrs.startMonth,
			day: attrs.startDay,
			hour: attrs.startHour,
			minute: attrs.startMinute,
		},
	);
	if (attrs.endYear === undefined)
	{
		return {
			start,
			end: start,
		};
	}
	return {
		start,
		end: knownComponents(
			{
				year: attrs.endYear,
				month: attrs.endMonth,
				day: attrs.endDay,
				hour: attrs.endHour,
				minute: attrs.endMinute,
			},
		),
	};
}

/** Upstream's `TI`: both ends of the range know the unit. */
const rangeKnows = (range: DateRange, unit: Unit): boolean => range.start.isCertain(unit) && range.end.isCertain(unit);

/**
 * Upstream's `ta4`/`la4`: compare `point` against one bound unit by unit, skipping units the range or point leaves
 * unknown; a strict inequality on an earlier unit settles the comparison.
 */
function withinBound(point: Components, range: DateRange, bound: "start" | "end"): boolean
{
	let settled = false;
	for (const unit of UNITS)
	{
		if (!rangeKnows(range, unit) || !point.isCertain(unit))
		{
			continue;
		}
		const value = point.get(unit) ?? 0;
		const edge = range[bound].get(unit) ?? 0;
		if (bound === "start" ? edge > value : edge < value)
		{
			return settled;
		}
		settled ||= edge !== value;
	}
	return true;
}

/** Upstream's `PI`. */
const pointInRange = (point: Components, range: DateRange): boolean =>
	withinBound(point, range, "start") && withinBound(point, range, "end");

const overlaps = (search: DateRange, row: DateRange): boolean =>
	UNITS.some((unit) => rangeKnows(search, unit) && rangeKnows(row, unit)) &&
	(pointInRange(search.start, row) ||
		pointInRange(row.start, search) ||
		pointInRange(search.end, row) ||
		pointInRange(row.end, search));

function chronoComponents(components: ChronoV1Components): Components
{
	return {
		isCertain: (unit) => components.isCertain(unit),
		get: (unit) => components.get(unit) ?? null,
	};
}

/**
 * The search range of the upstream chrono v1 search instance's result at offset 0 of `text`, if any. That instance
 * already pins relative phrases to whole days and weeks (`G02`, `q02`, `K02`), so no extra pinning is needed here.
 */
function leadingDate(
	text: string,
	context: TokenContext,
):
{
	text: string;
	range: DateRange;
} | null
{
	const result = searchChrono(
		{
			now: new Date(context.now),
			weekStartDay: context.weekStartDay,
			dateFormat: context.dateFormat,
		},
	)(text).find((candidate) => candidate.index === 0 && !/a[0-9]{1,2}/u.test(candidate.text));
	if (result === undefined)
	{
		return null;
	}
	const start = chronoComponents(result.start);
	return {
		text: result.text,
		range:
		{
			start,
			end: result.end ? chronoComponents(result.end) : start,
		},
	};
}

export const bareDate: SearchOperator =
{
	name: "bare-date",
	parseToken(query, start, context)
	{
		const result = leadingDate(query.slice(start), context);
		return result === null ? null : start + result.text.length;
	},
	matchesToken: (token, context) => leadingDate(token, context) !== null,
	create(token, _rawToken, context)
	{
		const search = leadingDate(token, context)?.range ?? null;
		return new MetaNode(
			(item) => search !== null && rowDates(item).some((attrs) => overlaps(search, rowRange(attrs))),
			{
				hasSearchTypeValue: hasDate,
			},
		);
	},
};
