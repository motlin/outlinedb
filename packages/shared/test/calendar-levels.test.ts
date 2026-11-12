import {describe, expect, it} from "vite-plus/test";
import
{
	dateId,
	dayTimestamp,
	friendlyPrefix,
	levelTooltips,
	navTooltips,
	nextOf,
	prevOf,
	stripModel,
} from "../src/dates/calendar-levels.js";

const now = new Date(2026, 9, 2, 10, 0);

describe("dateId", () =>
{
	it("keys a local date as YYYYMMDD, YYYYMM00 or YYYY0000 by calendar level", () =>
	{
		const date = new Date(2026, 8, 30);

		expect([dateId("day", date), dateId("month", date), dateId("year", date)]).toStrictEqual([
			20_260_930, 20_260_900, 20_260_000,
		]);
	});
});

describe("dayTimestamp", () =>
{
	it("is the local midnight of the date", () =>
	{
		expect(dayTimestamp(new Date(2026, 9, 2, 10, 30))).toBe(new Date(2026, 9, 2).getTime());
	});
});

describe("prevOf / nextOf", () =>
{
	it("steps a day, a week, or to the first of the adjacent month or year", () =>
	{
		const date = new Date(2026, 9, 15);

		expect(
			(["day", "week", "month", "year"] as const).map((level) => [
				prevOf(level, date).getTime(),
				nextOf(level, date).getTime(),
			]),
		).toStrictEqual([
			[new Date(2026, 9, 14).getTime(), new Date(2026, 9, 16).getTime()],
			[new Date(2026, 9, 8).getTime(), new Date(2026, 9, 22).getTime()],
			[new Date(2026, 8, 1).getTime(), new Date(2026, 10, 1).getTime()],
			[new Date(2025, 0, 1).getTime(), new Date(2027, 0, 1).getTime()],
		]);
	});

	it("does not overflow month ends", () =>
	{
		expect([prevOf("month", new Date(2026, 2, 31)), nextOf("month", new Date(2026, 0, 31))]).toStrictEqual([
			new Date(2026, 1, 1),
			new Date(2026, 1, 1),
		]);
	});
});

describe("levelTooltips", () =>
{
	it("names upstream's per-level arrow tooltips", () =>
	{
		expect(levelTooltips).toStrictEqual(
			{
				day: ["Previous day", "Next day"],
				week: ["Previous week", "Next week"],
				month: ["Previous month", "Next month"],
				year: ["Previous year", "Next year"],
			},
		);
	});
});

describe("navTooltips", () =>
{
	it("says Today, Yesterday or Tomorrow around today and the level tooltip elsewhere", () =>
	{
		expect([
			navTooltips("day", new Date(2026, 9, 1), now),
			navTooltips("day", new Date(2026, 9, 2), now),
			navTooltips("day", new Date(2026, 9, 3), now),
			navTooltips("day", new Date(2026, 9, 10), now),
			navTooltips("month", new Date(2026, 9, 1), now),
			navTooltips("month", new Date(2026, 10, 1), now),
			navTooltips("year", new Date(2026, 0, 1), now),
		]).toStrictEqual([
			["Previous day", "Today"],
			["Yesterday", "Tomorrow"],
			["Today", "Next day"],
			["Previous day", "Next day"],
			["Previous month", "Next month"],
			["Today", "Next month"],
			["Previous year", "Next year"],
		]);
	});
});

describe("friendlyPrefix", () =>
{
	it("names yesterday, today and tomorrow and nothing else", () =>
	{
		expect(
			[30, 1, 2, 3, 5].map((day) => friendlyPrefix(new Date(2026, day === 30 ? 8 : 9, day), now)),
		).toStrictEqual([null, "Yesterday", "Today", "Tomorrow", null]);
	});
});

describe("stripModel", () =>
{
	it("lays out 31 days from a day page, then 12 months from the last day's month", () =>
	{
		const model = stripModel("day", new Date(2026, 8, 30), now, 0);

		expect(
			{
				todayCard: model.todayCard,
				separator: model.separator,
				dayCount: model.days.length,
				firstThree: model.days.slice(0, 3),
				last: model.days.at(-1),
				labelled: model.days.filter((day) => day.label !== undefined).map((day) => day.day),
				months: model.months.map((month) => month.text),
				monthLabels: model.months.map((month) => month.label),
				firstMonth: model.months[0],
			},
		).toStrictEqual(
			{
				todayCard: false,
				separator: true,
				dayCount: 31,
				firstThree: [
					{
						ts: new Date(2026, 8, 30).getTime(),
						weekday: "We",
						day: 30,
						label: "Sep",
						isToday: false,
					},
					{
						ts: new Date(2026, 9, 1).getTime(),
						weekday: "Th",
						day: 1,
						label: "Oct",
						isToday: false,
					},
					{
						ts: new Date(2026, 9, 2).getTime(),
						weekday: "Fr",
						day: 2,
						isToday: true,
					},
				],
				last:
				{
					ts: new Date(2026, 9, 30).getTime(),
					weekday: "Fr",
					day: 30,
					isToday: false,
				},
				labelled: [30, 1],
				months: ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
				monthLabels: [
					"2026",
					undefined,
					undefined,
					"2027",
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
				],
				firstMonth:
				{
					ts: new Date(2026, 9, 1).getTime(),
					text: "Oct",
					label: "2026",
				},
			},
		);
	});

	it("adds a Today card when the first day is after today", () =>
	{
		expect([
			stripModel("day", new Date(2026, 9, 10), now, 0).todayCard,
			stripModel("day", new Date(2026, 9, 2), now, 0).todayCard,
		]).toStrictEqual([true, false]);
	});

	it("starts a week page at the week start", () =>
	{
		expect(
			[0, 1].map((weekStartDay) => stripModel("week", new Date(2026, 9, 15), now, weekStartDay).days[0]),
		).toStrictEqual([
			{
				ts: new Date(2026, 9, 11).getTime(),
				weekday: "Su",
				day: 11,
				label: "Oct",
				isToday: false,
			},
			{
				ts: new Date(2026, 9, 12).getTime(),
				weekday: "Mo",
				day: 12,
				label: "Oct",
				isToday: false,
			},
		]);
	});

	it("lists every day of a month page, labelling only the first, then the next 12 months", () =>
	{
		const model = stripModel("month", new Date(2026, 9, 1), now, 0);

		expect(
			{
				dayCount: model.days.length,
				labels: model.days.filter((day) => day.label !== undefined).map((day) => [day.day, day.label]),
				months: model.months.map((month) => month.text),
				separator: model.separator,
			},
		).toStrictEqual(
			{
				dayCount: 31,
				labels: [[1, "Oct"]],
				months: ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"],
				separator: true,
			},
		);
	});

	it("shows only Jan-Dec on a year page, without a separator", () =>
	{
		const model = stripModel("year", new Date(2026, 0, 1), now, 0);

		expect(
			{
				todayCard: model.todayCard,
				separator: model.separator,
				days: model.days,
				months: model.months.map((month) => month.text),
				labels: model.months.filter((month) => month.label !== undefined).map((month) => month.label),
			},
		).toStrictEqual(
			{
				todayCard: false,
				separator: false,
				days: [],
				months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
				labels: ["2026"],
			},
		);
	});
});
