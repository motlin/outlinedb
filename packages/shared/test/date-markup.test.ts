import {describe, expect, it} from "vite-plus/test";
import
{
	canonicalTimeAttributes,
	formatPillLabel,
	formatTimeLabel,
	parseTimeAttrs,
	parseTimeAttrsLoose,
	toTimeMarkup,
} from "../src/index.js";

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
