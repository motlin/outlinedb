import {describe, expect, it} from "vite-plus/test";
import
{
	canonicalTimeAttributes,
	formatPillLabel,
	formatTimeLabel,
	parseTimeAttrs,
	parseTimeAttrsLoose,
	toTimeMarkup,
	findDatePhrase,
	guessDates,
	parseWithFormat,
	presetDate,
} from "../src/index.js";

describe("date markup", () =>
{
	const now = new Date(2026, 9, 1);
	const custom =
	{
		dateFormat: "YYYY-MM-DD ddd",
		timeFormat: "HH:mm",
		now,
	};

	describe("formatPillLabel", () =>
	{
		it("formats a current-year date with a custom format", () =>
		{
			expect(
				formatPillLabel(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 1,
					},
					{
						dateFormat: "YYYY-MM-DD ddd",
						now,
					},
				),
			).toBe("2026-10-01 Thu");
		});

		it("formats a current-year date with defaults", () =>
		{
			expect(
				formatPillLabel(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 1,
					},
					{
						now,
					},
				),
			).toBe("Thu, Oct 1");
		});

		it("uses the long twin of a built-in format for another year", () =>
		{
			expect(
				formatPillLabel(
					{
						startYear: 2025,
						startMonth: 3,
						startDay: 5,
					},
					{
						now,
					},
				),
			).toBe("Wed, Mar 5, 2025");
		});

		it("uses a custom format containing a year as-is for another year", () =>
		{
			expect(
				formatPillLabel(
					{
						startYear: 2025,
						startMonth: 3,
						startDay: 5,
					},
					custom,
				),
			).toBe("2025-03-05 Wed");
		});

		it("appends the year to a custom format without one for another year", () =>
		{
			expect(
				formatPillLabel(
					{
						startYear: 2025,
						startMonth: 3,
						startDay: 5,
					},
					{
						dateFormat: "MMM D",
						now,
					},
				),
			).toBe("Mar 5, 2025");
		});

		it("formats a date with time as time on date", () =>
		{
			const attrs =
			{
				startYear: 2026,
				startMonth: 10,
				startDay: 2,
				startHour: 14,
				startMinute: 30,
			};
			expect(formatPillLabel(attrs, custom)).toBe("14:30 on 2026-10-02 Fri");
			expect(
				formatPillLabel(
					attrs,
					{
						now,
					},
				),
			).toBe("2:30pm on Fri, Oct 2");
		});

		it("formats a range", () =>
		{
			const attrs =
			{
				startYear: 2026,
				startMonth: 10,
				startDay: 5,
				endYear: 2026,
				endMonth: 10,
				endDay: 9,
			};
			expect(formatPillLabel(attrs, custom)).toBe("2026-10-05 Mon - 2026-10-09 Fri");
		});
	});

	describe("toTimeMarkup", () =>
	{
		it("writes a range with interleaved attributes and markup text", () =>
		{
			expect(
				toTimeMarkup(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 12,
						endYear: 2026,
						endMonth: 10,
						endDay: 16,
					},
				),
			).toBe(
				'<time startYear="2026" endYear="2026" startMonth="10" endMonth="10" startDay="12" endDay="16">Mon, Oct 12, 2026 - Fri, Oct 16, 2026</time>',
			);
		});

		it("writes a single date with time", () =>
		{
			expect(
				toTimeMarkup(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 2,
						startHour: 14,
						startMinute: 30,
					},
				),
			).toBe(
				'<time startYear="2026" startMonth="10" startDay="2" startHour="14" startMinute="30">Fri, Oct 2, 2026 at 2:30pm</time>',
			);
		});
	});

	describe("parseTimeAttrs", () =>
	{
		it("parses lowercase DOM-derived attributes", () =>
		{
			expect(
				parseTimeAttrs('startyear="2026" startmonth="10" startday="2" starthour="14" startminute="30"'),
			).toStrictEqual(
				{
					startYear: 2026,
					startMonth: 10,
					startDay: 2,
					startHour: 14,
					startMinute: 30,
				},
			);
		});

		it("parses canonical camelCase attributes and round-trips markup", () =>
		{
			const attrs =
			{
				startYear: 2026,
				startMonth: 10,
				startDay: 12,
				endYear: 2026,
				endMonth: 10,
				endDay: 16,
			};
			const markup = toTimeMarkup(attrs);
			expect(parseTimeAttrs(markup.slice("<time ".length, markup.indexOf(">")))).toStrictEqual(attrs);
		});
	});

	describe("canonicalTimeAttributes", () =>
	{
		it("restores upstream's camelCase <time> attribute names that DOM innerHTML lowercased", () =>
		{
			const markup = toTimeMarkup(
				{
					startYear: 2026,
					startMonth: 10,
					startDay: 2,
					startHour: 14,
					startMinute: 30,
				},
			);
			const lowered = markup.replaceAll(
				/\s((?:start|end)\w+)=/gu,
				(_match, name: string) => ` ${name.toLowerCase()}=`,
			);
			expect(canonicalTimeAttributes(`Due ${lowered} <b class="startyear">x</b>`)).toBe(
				`Due ${markup} <b class="startyear">x</b>`,
			);
		});

		it("leaves other attributes and already-canonical markup untouched", () =>
		{
			const html =
				'<time startYear="2026" endyear="2027" startMonth="1" startDay="2" data-x="a startyear=b">t</time>';
			expect(canonicalTimeAttributes(html)).toBe(
				'<time startYear="2026" endYear="2027" startMonth="1" startDay="2" data-x="a startyear=b">t</time>',
			);
		});
	});

	describe("formatTimeLabel", () =>
	{
		const loose =
		{
			dateFormat: "YYYY-MM-DD ddd",
			timeFormat: "HH:mm",
			now: new Date(2026, 9, 23, 10),
		};

		it("takes unknown units from now and marks a missing month invalid", () =>
		{
			expect([
				formatTimeLabel(
					{
						startYear: 2026,
						startMonth: 10,
					},
					loose,
				),
				formatTimeLabel(
					{
						startMonth: 3,
						startDay: 5,
					},
					loose,
				),
				formatTimeLabel({}, loose),
				formatTimeLabel(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 23,
						startHour: 9,
						endHour: 17,
					},
					loose,
				),
				formatTimeLabel(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 23,
						endDay: 25,
					},
					loose,
				),
				formatTimeLabel(
					{
						startYear: 2026,
						startMonth: 10,
						startDay: 23,
						startHour: 14,
					},
					loose,
				),
			]).toStrictEqual([
				"2026-10-23 Fri",
				"2026-03-05 Thu",
				"Invalid date",
				"09:00 on 2026-10-23 Fri - Invalid date",
				"2026-10-23 Fri - Invalid date",
				"14:00 on 2026-10-23 Fri",
			]);
		});

		it("matches upstream for dayjs plugin tokens and never throws on unknown ones", () =>
		{
			const attrs =
			{
				startYear: 2025,
				startMonth: 3,
				startDay: 5,
			};
			const tokens = ["w", "wo", "W", "Wo", "gggg", "GGGG", "k", "LT", "LL", "[Week] w"];
			const labels = Object.fromEntries(
				tokens.map((token) => [
					token,
					formatTimeLabel(
						attrs,
						{
							dateFormat: token,
							now: new Date(2025, 5, 1),
						},
					),
				]),
			);
			expect(labels).toStrictEqual(
				{
					w: "10",
					wo: "10th",
					W: "10",
					Wo: "10th",
					gggg: "2025",
					GGGG: "2025",
					k: "24",
					LT: "12:00 AM",
					LL: "March 5, 2025",
					"[Week] w": "Week 10",
				},
			);
			expect(() =>
				formatTimeLabel(
					attrs,
					{
						dateFormat: "zzz",
						now: new Date(2025, 5, 1),
					},
				),
			).not.toThrow();
		});
	});

	describe("parseTimeAttrsLoose", () =>
	{
		it("returns whatever units are present without throwing", () =>
		{
			expect(parseTimeAttrsLoose("")).toStrictEqual({});
			expect(parseTimeAttrsLoose("startyear='2026' startMonth='10'")).toStrictEqual(
				{
					startYear: 2026,
					startMonth: 10,
				},
			);
			expect(parseTimeAttrsLoose('startyear="2026" startMonth="10"')).toStrictEqual(
				{
					startYear: 2026,
					startMonth: 10,
				},
			);
		});
	});
});

describe("date parse", () =>
{
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
});
