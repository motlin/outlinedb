import chrono from "chrono-node-v1";
import type {ParsedComponents as V1Components, ParsedResult as V1Result, Refiner} from "chrono-node-v1";
import dayjs from "dayjs";
import type {Dayjs} from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek.js";
import {parseWithFormat} from "./date-format-parse.js";

dayjs.extend(isoWeek);

/**
 * Upstream's chrono instances, built on chrono-node v1: `editorChrono` is `Hr` (the `!!` picker, pill edit,
 * inline date autocomplete) and `searchChrono` is `$r` (search bare-date tokens). Upstream reads `weekStartDay`
 * and the wall clock inside its refiners; here both are options.
 */
export interface ChronoV1Components
{
	knownValues: Record<string, number>;
	get(component: string): number | undefined;
	isCertain(component: string): boolean;
	date(): Date;
}

export interface ChronoV1Result
{
	index: number;
	text: string;
	tags: Record<string, boolean>;
	start: ChronoV1Components;
	end?: ChronoV1Components | null | undefined;
}

export interface ChronoV1Options
{
	now: Date;
	/** 0 = Sunday (default), 1 = Monday. */
	weekStartDay?: number;
	/** The account date format, used by upstream's `wa1` re-parse. */
	dateFormat?: string;
}

const {Chrono, Refiner: RefinerClass, options: chronoOptions} = chrono;

function makeRefiner(refine: (text: string, results: V1Result[]) => V1Result[]): Refiner
{
	const refiner = new RefinerClass();
	refiner.refine = refine;
	return refiner;
}

/** Upstream's `Zv`: pin year, month and day to those of `date`. */
function pinDate(components: V1Components, date: Dayjs): void
{
	components.assign("year", date.year());
	components.assign("month", date.month() + 1);
	components.assign("day", date.date());
}

/** Upstream's `bp`: make a unit certain at its current value. */
function pinUnit(components: V1Components, unit: string): void
{
	components.assign(unit, components.get(unit));
}

function startOfWeek(date: Dayjs, weekStartDay: number): Dayjs
{
	return weekStartDay === 1 ? date.startOf("isoWeek") : date.startOf("week");
}

function endOfWeek(date: Dayjs, weekStartDay: number): Dayjs
{
	return weekStartDay === 1 ? date.endOf("isoWeek") : date.endOf("week");
}

function hasTag(result: V1Result, name: string): boolean
{
	return Object.keys(result.tags).some((tag) => tag.includes(name));
}

/** `Na1`: in `A to B` where A is later than B, B lands in the year after A (or A's year when the month does not go backwards). */
const rangeYearRefiner = makeRefiner((text, results) =>
{
	for (let index = 1; index < results.length; index++)
	{
		const before = results[index - 1];
		const after = results[index];
		if (!before || !after || before.end || after.end)
		{
			continue;
		}
		const between = text.slice(before.index + before.text.length, after.index);
		if (/^\s*(to|-)\s*$/iu.test(between) && before.start.date().getTime() > after.start.date().getTime())
		{
			const year = before.start.get("year");
			after.start.imply("year", before.start.get("month") > after.start.get("month") ? year + 1 : year);
		}
	}
	return results;
});

/** `O02`: results of 3 chars or fewer (but "now") are dropped. */
const shortTextRefiner = makeRefiner((_text, results) =>
	results.filter((result) => !(result.text.length <= 3 && result.text.toLowerCase() !== "now")),
);

/** `B02`: results ending with `)` are dropped. */
const closingParenRefiner = makeRefiner((_text, results) => results.filter((result) => !result.text.endsWith(")")));

/** `U02`: a Chinese time range loses its end unless the time is followed by `~`. */
const chineseTimeRangeRefiner = makeRefiner((text, results) =>
	results.map((result) =>
	{
		if (!result.end || !result.tags.ZHTimeExpressionParser || result.tags.ENMergeDateRangeRefiner)
		{
			return result;
		}
		const rest = text.slice(result.index);
		const time = /\d{1,2}:\d{2}/u.exec(rest);
		const following = time && rest[time.index + time[0].length];
		if (!following || (following !== "~" && following !== "〜"))
		{
			result.end = null;
		}
		return result;
	}),
);

function createTomorrowRefiner(now: Date): Refiner
{
	return makeRefiner((_text, results) =>
		results.map((result) =>
		{
			if (!/tomorrow|tmr|morgen|mañana|demain|明日/u.test(result.text.toLowerCase()))
			{
				return result;
			}
			const today = dayjs(now).startOf("day");
			if (dayjs(result.start.date()).startOf("day").isSame(today, "day"))
			{
				pinDate(result.start, today.add(1, "day"));
			}
			return result;
		}),
	);
}

function createWeekStartRefiner(now: Date, weekStartDay: number): Refiner
{
	return makeRefiner((text, results) =>
	{
		if (!text.includes("week"))
		{
			return results;
		}
		return results.map((result) =>
		{
			if (!/(this|last|next) week/u.test(result.text))
			{
				return result;
			}
			const anchor = result.text === "this week" ? dayjs(now) : dayjs(result.start.date());
			pinDate(result.start, startOfWeek(anchor, weekStartDay));
			return result;
		});
	});
}

/**
 * `wa1`: text that also parses with the account date format takes that format's year, month and day. The sides of a
 * range only take the year: the merge refiner may have swapped them (`oct 20 - oct 15`), and upstream keeps the swap.
 */
function createFormatRefiner(now: Date, dateFormat: string | undefined): Refiner
{
	const apply = (components: V1Components, rawText: string, keepMonthDay: boolean): void =>
	{
		let text = rawText;
		if (components.isCertain("hour"))
		{
			text = text
				.replace(/\d{1,2}(:\d{2})?(am|pm)\s/iu, "")
				.replace(/\d{1,2}:\d{2}\s/u, "")
				.replace("on ", "")
				.replace("at ", "");
		}
		const parsed = parseWithFormat(text, dateFormat, now)?.start;
		if (!parsed)
		{
			return;
		}
		const month = parsed.getMonth() + 1;
		const day = parsed.getDate();
		const changed = components.get("month") !== month || components.get("day") !== day;
		if (components.isCertain("year"))
		{
			components.assign("year", parsed.getFullYear());
		}
		else if (changed)
		{
			const thisYear = now.getFullYear();
			const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			components.imply(
				"year",
				new Date(thisYear, month - 1, day).getTime() >= startOfToday.getTime() ? thisYear : thisYear + 1,
			);
		}
		if (keepMonthDay)
		{
			return;
		}
		if (components.isCertain("month"))
		{
			components.assign("month", month);
		}
		else
		{
			components.imply("month", month);
		}
		if (components.isCertain("day"))
		{
			components.assign("day", day);
		}
		else
		{
			components.imply("day", day);
		}
	};
	return makeRefiner((_text, results) =>
	{
		for (const result of results)
		{
			if (result.end)
			{
				const [first, second] = result.text.split("-");
				if (first)
				{
					apply(result.start, first.trim(), true);
				}
				if (second)
				{
					apply(result.end, second.trim(), true);
				}
			}
			else
			{
				apply(result.start, result.text, false);
			}
		}
		return results;
	});
}

/** `wK`: pin year, month and day, and collapse the range to its start. */
function pinDay(result: V1Result): V1Result
{
	for (const unit of ["year", "month", "day"])
	{
		pinUnit(result.start, unit);
	}
	result.end = result.start.clone();
	return result;
}

function wholeWeek(result: V1Result, weekStartDay: number): V1Result
{
	const copy = result.clone();
	const date = dayjs(copy.start.date());
	copy.end = copy.start.clone();
	pinDate(copy.start, startOfWeek(date, weekStartDay));
	pinDate(copy.end, endOfWeek(date, weekStartDay));
	return copy;
}

function createWeekRangeRefiner(weekStartDay: number): Refiner
{
	return makeRefiner((_text, results) =>
		results.map((result) =>
		{
			if (!result.text.includes("week"))
			{
				return result;
			}
			return hasTag(result, "RelativeDateFormatParser") ? wholeWeek(result, weekStartDay) : pinDay(result);
		}),
	);
}

const weekdayPinRefiner = makeRefiner((_text, results) =>
	results.map((result) => (hasTag(result, "WeekdayParser") ? pinDay(result) : result)),
);

const deadlinePinRefiner = makeRefiner((_text, results) =>
	results.map((result) =>
	{
		if (!hasTag(result, "DeadlineFormatParser"))
		{
			return result;
		}
		for (const unit of ["hour", "minute"])
		{
			if (result.text.includes(unit))
			{
				pinUnit(result.start, unit);
				if (result.end)
				{
					pinUnit(result.end, unit);
				}
			}
		}
		return pinDay(result);
	}),
);

const bareRelativePinRefiner = makeRefiner((_text, results) =>
	results.map((result) =>
		Object.keys(result.tags).length === 0 && Object.keys(result.start.knownValues).length === 0
			? pinDay(result)
			: result,
	),
);

function createChrono(refiners: Refiner[]): (text: string, now: Date) => V1Result[]
{
	const instance = new Chrono(
		chronoOptions.mergeOptions([
			chronoOptions.en.casual,
			chronoOptions.de(
				{
					strict: true,
				},
			),
			chronoOptions.es.casual,
			chronoOptions.fr.casual,
			chronoOptions.ja.casual,
			chronoOptions.zh,
			chronoOptions.commonPostProcessing,
		]),
	);
	const mergeIndex = instance.refiners.findIndex((each) => "mergeResult" in each && "isAbleToMerge" in each);
	if (mergeIndex !== -1)
	{
		instance.refiners.splice(mergeIndex, 0, rangeYearRefiner);
	}
	instance.refiners.push(...refiners);
	return (text, now) =>
		instance.parse(
			text,
			now,
			{
				forwardDate: true,
			},
		);
}

/** Upstream's `Hr`: the picker, pill-edit and autocomplete parser. */
export function editorChrono(options: ChronoV1Options): (text: string) => ChronoV1Result[]
{
	const {now, weekStartDay = 0, dateFormat} = options;
	const parse = createChrono([
		chineseTimeRangeRefiner,
		shortTextRefiner,
		closingParenRefiner,
		createFormatRefiner(now, dateFormat),
		createWeekStartRefiner(now, weekStartDay),
		createTomorrowRefiner(now),
	]);
	return (text) => parse(text, now);
}

/** Upstream's `$r`: the search bare-date parser. */
export function searchChrono(options: ChronoV1Options): (text: string) => ChronoV1Result[]
{
	const {now, weekStartDay = 0, dateFormat} = options;
	const parse = createChrono([
		createWeekStartRefiner(now, weekStartDay),
		createWeekRangeRefiner(weekStartDay),
		weekdayPinRefiner,
		deadlinePinRefiner,
		bareRelativePinRefiner,
		createFormatRefiner(now, dateFormat),
	]);
	return (text) => parse(text, now);
}
