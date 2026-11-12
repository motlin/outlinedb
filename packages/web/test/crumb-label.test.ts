import {describe, expect, it} from "vite-plus/test";
import {crumbLabel} from "../src/client/crumb-label.js";

const SEP_4 = '<time startYear="2026" startMonth="9" startDay="4">Fri, Sep 4, 2026</time>';

describe("crumbLabel", () =>
{
	it("resolves stored mentions to plain names", () =>
	{
		const html = 'MP sys <mention id="-2" by="1" ts="1"> </mention> <mention id="-10" by="1" ts="1"> </mention> x';
		expect(
			crumbLabel(
				html,
				{
					now: new Date(2026, 9, 1),
				},
			),
		).toBe("MP sys Workflowy AI x");
	});

	it("resolves the current user's mention to the account full name", () =>
	{
		expect(
			crumbLabel(
				'hi <mention id="7" by="7" ts="1"> </mention>',
				{
					now: new Date(2026, 9, 1),
					account:
					{
						userId: 7,
						fullName: "Alice Smith",
					},
				},
			),
		).toBe("hi Alice Smith");
	});

	it("formats a day <time> with the default date format", () =>
	{
		expect(
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 9, 1),
				},
			),
		).toBe("2026-09-04 Fri");
	});

	it("adds no day prefix without calendar day info", () =>
	{
		expect(
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 8, 4),
				},
			),
		).toBe("2026-09-04 Fri");
	});

	it("prefixes Today for a calendar day node on the current day", () =>
	{
		expect(
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 8, 4),
					dayDateId: 20_260_904,
					dayPrefix: true,
				},
			),
		).toBe("Today, 2026-09-04 Fri");
	});

	it("prefixes Yesterday for a calendar day node on the previous day", () =>
	{
		expect(
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 8, 5),
					dayDateId: 20_260_904,
					dayPrefix: true,
				},
			),
		).toBe("Yesterday, 2026-09-04 Fri");
	});

	it("prefixes Tomorrow for a calendar day node on the next day", () =>
	{
		expect(
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 8, 3, 23, 59),
					dayDateId: 20_260_904,
					dayPrefix: true,
				},
			),
		).toBe("Tomorrow, 2026-09-04 Fri");
	});

	it("omits the prefix when dayPrefix is false or unset", () =>
	{
		expect([
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 8, 4),
					dayDateId: 20_260_904,
					dayPrefix: false,
				},
			),
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 8, 4),
					dayDateId: 20_260_904,
				},
			),
		]).toStrictEqual(["2026-09-04 Fri", "2026-09-04 Fri"]);
	});

	it("formats a time-of-day pill with the time format", () =>
	{
		expect(
			crumbLabel(
				'<time startYear="2026" startMonth="10" startDay="24" startHour="9" startMinute="0">x</time>',
				{
					now: new Date(2026, 9, 23),
					timeFormat: "HH:mm",
				},
			),
		).toBe("09:00 on 2026-10-24 Sat");
	});

	it("honors a custom date format", () =>
	{
		expect(
			crumbLabel(
				SEP_4,
				{
					now: new Date(2026, 9, 1),
					dateFormat: "ddd, MMM D",
				},
			),
		).toBe("Fri, Sep 4");
	});

	it("strips other tags and decodes entities", () =>
	{
		expect(
			crumbLabel(
				"<b>Alice</b> &amp; Bob",
				{
					now: new Date(2026, 9, 1),
				},
			),
		).toBe("Alice & Bob");
	});

	it("keeps month and year names as-is", () =>
	{
		expect(
			crumbLabel(
				"09",
				{
					now: new Date(2026, 9, 1),
				},
			),
		).toBe("09");
		expect(
			crumbLabel(
				"2026",
				{
					now: new Date(2026, 9, 1),
				},
			),
		).toBe("2026");
	});

	it("returns an empty string for an empty name", () =>
	{
		expect(
			crumbLabel(
				"",
				{
					now: new Date(2026, 9, 1),
				},
			),
		).toBe("");
	});
});

describe("crumbLabel with malformed <time>", () =>
{
	it("shows Invalid date for a time element with no units", () =>
	{
		expect(
			crumbLabel(
				"<time>z</time>",
				{
					now: new Date(2026, 9, 23, 10),
				},
			),
		).toBe("Invalid date");
	});
});
