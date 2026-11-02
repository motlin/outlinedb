import {describe, expect, it} from "vite-plus/test";
import {findDatePhrase, guessDates, parseWithFormat, presetDate} from "../src/index.js";

const now = new Date(2026, 9, 1, 9, 0);
const isoDay =
{
	dateFormat: "YYYY-MM-DD ddd",
	now,
};

describe("guessDates", () =>
{
	it("parses natural language with chrono", () =>
	{
		expect(
			guessDates(
				"oct 15",
				{
					now,
				},
			),
		).toStrictEqual([new Date(2026, 9, 15)]);
	});

	it("returns nothing for unparseable text", () =>
	{
		expect(
			guessDates(
				"xyz",
				{
					now,
				},
			),
		).toStrictEqual([]);
	});

	it("parses the current date format strictly", () =>
	{
		expect(guessDates("2026-10-01 Thu", isoDay)).toStrictEqual([new Date(2026, 9, 1)]);
	});

	it("parses the date half of a timed pill label", () =>
	{
		expect(guessDates("14:30 on 2026-10-02 Fri", isoDay)).toStrictEqual([new Date(2026, 9, 2)]);
	});

	it("keeps a past lowercase short-month date in the current year, as upstream's case-insensitive moment parse does", () =>
	{
		const afterIt = new Date(2026, 9, 18, 9, 0);
		expect(
			guessDates(
				"oct 15",
				{
					now: afterIt,
				},
			),
		).toStrictEqual([new Date(2026, 9, 15)]);
	});

	it("rolls a past full-month date the format cannot read forward a year via chrono's forwardDate", () =>
	{
		const afterIt = new Date(2026, 9, 18, 9, 0);
		expect(
			guessDates(
				"October 15",
				{
					now: afterIt,
				},
			),
		).toStrictEqual([new Date(2027, 9, 15)]);
	});

	it("returns a range for two dates joined by a dash", () =>
	{
		expect(
			guessDates(
				"oct 5 - oct 9",
				{
					now,
				},
			),
		).toStrictEqual([new Date(2026, 9, 5), new Date(2026, 9, 9)]);
	});
});

describe("guessDates (chrono v1 editor instance)", () =>
{
	const friday = new Date(2026, 9, 23, 20, 30);
	// The account the upstream probe ran on: WF.Date.parse read "10/15" but not "oct 15".
	const dateFormat = "MM/DD/YYYY";
	const isoDays = (
		term: string,
		options:
		{
			weekStartDay?: number;
			now?: Date;
		} = {},
	) =>
		guessDates(
			term,
			{
				now: friday,
				dateFormat,
				...options,
			},
		).map(
			(date) =>
				`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
		);

	it.each([
		["last friday", ["2026-10-16"]],
		["friday", ["2026-10-23"]],
		["next sunday", ["2026-10-25"]],
		["at 3pm", ["2026-10-23"]],
		["this morning", ["2026-10-23"]],
		["october", ["2026-10-01"]],
		["fri - mon", ["2026-10-23", "2026-10-26"]],
		["oct 20 - oct 15", ["2027-10-15", "2027-10-20"]],
		["this week", ["2026-10-18"]],
		["next week", ["2026-10-25"]],
		["last week", ["2026-10-11"]],
		["demain", ["2026-10-24"]],
		["lunes", ["2026-10-26"]],
		["tmr", []],
		["fri", []],
		["3pm", []],
		["sat)", []],
		["weekend", []],
		["end of month", []],
	])("guesses %s", (term, expected) =>
	{
		expect(isoDays(term)).toStrictEqual(expected);
	});

	it.each([
		["this week", ["2026-10-19"]],
		["next week", ["2026-10-26"]],
		["last week", ["2026-10-12"]],
	])("starts %s on Monday when weekStartDay is 1", (term, expected) =>
	{
		expect(
			isoDays(
				term,
				{
					weekStartDay: 1,
				},
			),
		).toStrictEqual(expected);
	});

	it("treats tomorrow just after midnight as the next day", () =>
	{
		expect(
			isoDays(
				"tomorrow",
				{
					now: new Date(2026, 9, 23, 0, 30),
				},
			),
		).toStrictEqual(["2026-10-24"]);
	});
});

describe("parseWithFormat", () =>
{
	it("drops the leading weekday from the format", () =>
	{
		expect(parseWithFormat("Oct 15", "ddd, MMM D", now)).toStrictEqual(
			{
				start: new Date(2026, 9, 15),
			},
		);
	});

	it("matches month and weekday names case-insensitively", () =>
	{
		expect(parseWithFormat("thu, oct 15", "ddd, MMM D", now)).toStrictEqual(
			{
				start: new Date(2026, 9, 15),
			},
		);
		expect(parseWithFormat("15th of OCTOBER", "Do [of] MMMM", now)).toStrictEqual(
			{
				start: new Date(2026, 9, 15),
			},
		);
	});

	it("accepts single-digit month and day without a year for a padded numeric format", () =>
	{
		expect(parseWithFormat("3/5", "MM/DD/YYYY", now)).toStrictEqual(
			{
				start: new Date(2026, 2, 5),
			},
		);
	});

	it("reads two-digit years as 20xx", () =>
	{
		expect(parseWithFormat("03/05/25", "MM/DD/YYYY", now)).toStrictEqual(
			{
				start: new Date(2025, 2, 5),
			},
		);
	});

	it("orders day before month for a day-first format", () =>
	{
		expect(parseWithFormat("3/5", "DD/MM/YYYY", now)).toStrictEqual(
			{
				start: new Date(2026, 4, 3),
			},
		);
	});

	it("splits a dashed range", () =>
	{
		expect(parseWithFormat("2026-10-05 - 2026-10-09", "YYYY-MM-DD", now)).toStrictEqual(
			{
				start: new Date(2026, 9, 5),
				end: new Date(2026, 9, 9),
			},
		);
	});

	it("returns undefined when nothing matches", () =>
	{
		expect(parseWithFormat("xyz", "YYYY-MM-DD", now)).toBeUndefined();
	});
});

describe("presetDate", () =>
{
	it("returns today", () =>
	{
		expect(
			presetDate(
				"today",
				{
					now,
				},
			),
		).toStrictEqual(new Date(2026, 9, 1));
	});

	it("returns tomorrow", () =>
	{
		expect(
			presetDate(
				"tomorrow",
				{
					now,
				},
			),
		).toStrictEqual(new Date(2026, 9, 2));
	});

	it("returns the first day of next week starting Sunday by default", () =>
	{
		expect([
			presetDate(
				"next week",
				{
					now,
				},
			),
			presetDate(
				"next week",
				{
					now,
					weekStartDay: 0,
				},
			),
		]).toStrictEqual([new Date(2026, 9, 4), new Date(2026, 9, 4)]);
	});

	it("returns the first day of next week starting Monday", () =>
	{
		expect(
			presetDate(
				"next week",
				{
					now,
					weekStartDay: 1,
				},
			),
		).toStrictEqual(new Date(2026, 9, 5));
	});
});

describe("findDatePhrase (chrono v1 editor instance)", () =>
{
	const friday = new Date(2026, 9, 23, 20, 30);
	const oct23 =
	{
		startYear: 2026,
		startMonth: 10,
		startDay: 23,
	};

	it("keeps casual-time words, because upstream's CasualTime filter does nothing", () =>
	{
		expect(findDatePhrase("call this morning", 17, friday)?.attrs).toStrictEqual(oct23);
	});

	it("carries the hour of a time-only phrase on the same day", () =>
	{
		expect(findDatePhrase("meet at 3pm", 11, friday)?.attrs).toStrictEqual(
			{
				...oct23,
				startHour: 15,
				startMinute: 0,
			},
		);
	});

	it("understands French casual words", () =>
	{
		expect(findDatePhrase("demain", 6, friday)?.attrs).toStrictEqual(
			{
				startYear: 2026,
				startMonth: 10,
				startDay: 24,
			},
		);
	});

	it("ignores phrases of three characters or fewer", () =>
	{
		expect(findDatePhrase("lunch fri", 9, friday)).toBeUndefined();
	});

	it("resolves last friday to the previous week", () =>
	{
		expect(findDatePhrase("trip last friday", 16, friday)?.attrs).toStrictEqual(
			{
				startYear: 2026,
				startMonth: 10,
				startDay: 16,
			},
		);
	});

	it("takes the week start from the options", () =>
	{
		expect(
			findDatePhrase(
				"this week",
				9,
				friday,
				{
					weekStartDay: 1,
				},
			)?.attrs,
		).toStrictEqual(
			{
				startYear: 2026,
				startMonth: 10,
				startDay: 19,
			},
		);
	});
});
