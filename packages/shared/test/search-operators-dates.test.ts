import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {parseQuery} from "../src/search/index.js";
import {searchItem, SO_ROWS} from "./helpers/search-so-fixture.js";

const NOW = new Date(2026, 9, 1, 12).getTime();

function names(query: string, dateFormat?: string): string[]
{
	const node = parseQuery(
		query,
		dateFormat === undefined
			?
				{
					now: NOW,
				}
			:
				{
					now: NOW,
					dateFormat,
				},
	);
	return SO_ROWS.filter((row) => node.matches(row).matches).map((row) => row.nameHtml.split(" ")[0] ?? "");
}

describe("explicit date operators", () =>
{
	it("date:past and date:future compare row starts to today's start and now", () =>
	{
		expect([names("date:past"), names("date:future"), names("has:date")]).toStrictEqual([
			["Past"],
			["Future"],
			["Meeting", "Past", "Future"],
		]);
	});

	it("date:, date-before: and date-after: strictly parse the default YYYY-MM-DD format", () =>
	{
		expect([
			names("date:2026-10-01"),
			names("date:2026-10-1"),
			names("date:26-10-01"),
			names("date-before:2026-10-01"),
			names("date-after:2026-10-01"),
			names("date:10/1/2026"),
			names("date:garbage"),
		]).toStrictEqual([["Meeting"], ["Meeting"], ["Meeting"], ["Past"], ["Future"], [], []]);
	});

	it("date: honours a custom date format and an @HH:mm time", () =>
	{
		const timed = searchItem(
			'Timed <time startYear="2026" startMonth="10" startDay="1" startHour="9" startMinute="30">Oct 1 9:30</time>',
		);
		expect([
			names("date:10/1/2026", "MM/DD/YYYY"),
			parseQuery(
				"date:2026-10-01@09:30",
				{
					now: NOW,
				},
			).matches(timed),
			parseQuery(
				"date:2026-10-01",
				{
					now: NOW,
				},
			).matches(timed).matches,
		]).toStrictEqual([
			["Meeting"],
			{
				matches: true,
				nameMatches: false,
				noteMatches: false,
				metaMatches: true,
			},
			false,
		]);
	});

	it("date: matches a range end at midnight", () =>
	{
		const range = searchItem(
			'Trip <time startYear="2026" startMonth="10" startDay="5" endYear="2026" endMonth="10" endDay="9">Oct 5 - 9</time>',
		);
		expect([
			parseQuery(
				"date:2026-10-09",
				{
					now: NOW,
				},
			).matches(range).matches,
			parseQuery(
				"date:2026-10-07",
				{
					now: NOW,
				},
			).matches(range).matches,
		]).toStrictEqual([true, false]);
	});

	it("day-of-week: takes full lowercase English day names only", () =>
	{
		expect([names("day-of-week:thursday"), names("day-of-week:friday"), names("day-of-week:thu")]).toStrictEqual([
			["Meeting"],
			["Future"],
			[],
		]);
	});

	it("negating a date operator requires the row to contain a date", () =>
	{
		expect([names("-date:past"), names("-date:garbage")]).toStrictEqual([
			["Meeting", "Future"],
			["Meeting", "Past", "Future"],
		]);
	});
	it("bare natural-language dates match rows sharing a known date component", () =>
	{
		expect(
			[
				"today",
				"oct 1",
				"this month",
				"Thursday",
				"last month",
				"sep 15",
				"tomorrow",
				"next week",
				"yesterday",
			].map((query) => names(query)),
		).toStrictEqual([["Meeting"], ["Meeting"], ["Meeting"], ["Meeting"], ["Past"], ["Past"], [], [], []]);
	});

	it("a bare date claims a multi-word span, combines with terms, and negation requires a date", () =>
	{
		expect([names("oct 1 meeting"), names("next week -alpha"), names("-today"), names("#today")]).toStrictEqual([
			["Meeting"],
			[],
			["Past", "Future"],
			[],
		]);
	});
});

describe("bare dates use the upstream chrono v1 search instance", () =>
{
	const FRIDAY = new Date(2026, 9, 23, 20, 30);

	function row(month: number, day: number, time?: string): ReturnType<typeof searchItem>
	{
		const [hour, minute] = time === undefined ? [] : time.split(":");
		const timeAttrs = time === undefined ? "" : ` startHour="${hour}" startMinute="${minute}"`;
		const label = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${time === undefined ? "" : `@${time}`}`;
		return searchItem(
			`${label} <time startYear="2026" startMonth="${month}" startDay="${day}"${timeAttrs}>x</time>`,
		);
	}

	const rows = [
		...Array.from(
			{
				length: 33,
			},
			(_unused, offset) => new Date(2026, 9, 7 + offset),
		).map((date) => row(date.getMonth() + 1, date.getDate())),
		row(11, 23),
		row(10, 23, "15:00"),
		row(10, 24, "15:00"),
		row(10, 23, "22:00"),
	];

	function matched(
		query: string,
		options:
		{
			now?: Date;
			weekStartDay?: 0 | 1;
		} = {},
	): string[]
	{
		const node = parseQuery(
			query,
			{
				now: (options.now ?? FRIDAY).getTime(),
				...(options.weekStartDay === undefined
					? {}
					:
						{
							weekStartDay: options.weekStartDay,
						}),
			},
		);
		return rows.filter((each) => node.matches(each).matches).map((each) => each.nameHtml.split(" ")[0] ?? "");
	}

	const week = (from: number, to: number) =>
		Array.from(
			{
				length: to - from + 1,
			},
			(_unused, offset) => `10-${from + offset}`,
		);

	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("resolves a bare weekday matching today to today", () =>
	{
		expect(matched("friday")).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
	});

	it("resolves last friday to the previous week", () =>
	{
		expect(matched("last friday")).toStrictEqual(["10-16"]);
	});

	it("matches every row in a bare month name", () =>
	{
		expect(matched("oct")).toStrictEqual(
			rows.map((each) => each.nameHtml.split(" ")[0] ?? "").filter((label) => label.startsWith("10-")),
		);
	});

	it("pins in 1 month to the single day", () =>
	{
		expect(matched("in 1 month")).toStrictEqual(["11-23"]);
	});

	it("collapses a weekday range to its start", () =>
	{
		expect(matched("fri - mon")).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
	});

	it("matches the whole week, starting on the configured day", () =>
	{
		expect([
			matched("this week").filter((label) => !label.includes("@")),
			matched(
				"this week",
				{
					weekStartDay: 1,
				},
			).filter((label) => !label.includes("@")),
		]).toStrictEqual([week(18, 24), week(19, 25)]);
	});

	it("understands French and Japanese casual words", () =>
	{
		expect([matched("demain"), matched("明日")]).toStrictEqual([
			["10-24", "10-24@15:00"],
			["10-24", "10-24@15:00"],
		]);
	});

	it("has no weekend parser", () =>
	{
		expect(matched("weekend")).toStrictEqual([]);
	});

	it("keeps tomorrow as today in the first two hours of the day", () =>
	{
		expect(
			matched(
				"tomorrow",
				{
					now: new Date(2026, 9, 23, 0, 30),
				},
			),
		).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
	});

	it("pins the hour but not the minute for in 2 hours, so a date-only row and a 22:xx row match", () =>
	{
		expect(matched("in 2 hours")).toStrictEqual(["10-23", "10-23@22:00"]);
	});

	it("uses the query's now, not the system clock", () =>
	{
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 10, 2, 12));
		expect(matched("friday")).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
	});
});
