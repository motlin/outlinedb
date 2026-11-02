import {describe, expect, it, vi} from "vite-plus/test";
import
{
	adoptAfterCreate,
	adoptOnInsert,
	auditCalendarMonth,
	auditCalendarRoot,
	datesInName,
} from "../../src/internal/calendar-adopt.js";
import {DEFAULT_CALENDAR_LEVELS} from "../../src/internal/calendar-day.js";

const root =
{
	calendar:
	{
		root: true,
		level: undefined,
		dateId: undefined,
	},
};
const year =
{
	calendar:
	{
		level: "year",
		dateId: 20_260_000,
	},
};
const month =
{
	calendar:
	{
		level: "month",
		dateId: 20_261_000,
	},
};
const day =
{
	calendar:
	{
		level: "day",
		dateId: 20_261_015,
	},
};
const oct21 =
{
	year: 2026,
	month: 10,
	day: 21,
};
const levels = DEFAULT_CALENDAR_LEVELS;

describe("adoptOnInsert", () =>
{
	it("tags a dated row under a month as that day, as upstream mb1 does", () =>
	{
		expect(
			adoptOnInsert(
				{
					parentChain: [month, year, root],
					siblings: [],
					dates: [oct21],
					levels,
				},
			),
		).toStrictEqual(
			{
				set:
				{
					level: "day",
					value: "21",
					timestamp: new Date(2026, 9, 21).getTime(),
					dateId: 20_261_021,
				},
			},
		);
	});

	it("does nothing when a sibling already is that day", () =>
	{
		const sibling =
		{
			calendar:
			{
				level: "day",
				dateId: 20_261_021,
			},
		};

		expect(
			adoptOnInsert(
				{
					parentChain: [month, year, root],
					siblings: [sibling],
					dates: [oct21],
					levels,
				},
			),
		).toBeNull();
	});

	it("does nothing when the date does not fit the month", () =>
	{
		expect(
			adoptOnInsert(
				{
					parentChain: [month, year, root],
					siblings: [],
					dates: [
						{
							year: 2026,
							month: 11,
							day: 3,
						},
					],
					levels,
				},
			),
		).toBeNull();
	});

	it("does nothing under the root, under a day, or under a non-calendar parent", () =>
	{
		expect([
			adoptOnInsert(
				{
					parentChain: [root],
					siblings: [],
					dates: [oct21],
					levels,
				},
			),
			adoptOnInsert(
				{
					parentChain: [day, month, year, root],
					siblings: [],
					dates: [oct21],
					levels,
				},
			),
			adoptOnInsert(
				{
					parentChain: [
						{
							calendar: undefined,
						},
					],
					siblings: [],
					dates: [oct21],
					levels,
				},
			),
		]).toStrictEqual([null, null, null]);
	});

	it("only tests the first date, because upstream shifts one level per date", () =>
	{
		expect(
			adoptOnInsert(
				{
					parentChain: [month, year, root],
					siblings: [],
					dates: [
						{
							year: 2026,
							month: 11,
							day: 3,
						},
						oct21,
					],
					levels,
				},
			),
		).toBeNull();
	});
});

describe("auditCalendarMonth", () =>
{
	const time = (d: number) => `<time startYear="2026" startMonth="10" startDay="${d}">Oct ${d}, 2026</time>`;

	it("reports untagged, bracket and duplicate days in order", () =>
	{
		expect(
			auditCalendarMonth(
				{
					month:
					{
						id: "m10",
						...month,
					},
					levels,
					children: [
						{
							id: "t19",
							name: time(19),
							calendar:
							{
								level: "day",
								dateId: 20_261_019,
							},
						},
						{
							id: "u21",
							name: time(21),
						},
						{
							id: "b22",
							name: "[2026-10-22]",
						},
						{
							id: "u19",
							name: time(19),
						},
					],
				},
			),
		).toStrictEqual([
			{
				kind: "untagged-day",
				id: "u21",
				dateId: 20_261_021,
			},
			{
				kind: "bracket-day",
				id: "b22",
				dateId: 20_261_022,
			},
			{
				kind: "untagged-day",
				id: "u19",
				dateId: 20_261_019,
			},
			{
				kind: "duplicate",
				id: "u19",
				dateId: 20_261_019,
			},
		]);
	});

	it("reports a tagged day nested under an untagged day", () =>
	{
		expect(
			auditCalendarMonth(
				{
					month:
					{
						id: "m01",
						calendar:
						{
							level: "month",
							dateId: 20_260_100,
						},
					},
					levels,
					children: [
						{
							id: "outer",
							name: '<time startYear="2026" startMonth="1" startDay="15">Thu, Jan 15, 2026</time>',
							children: [
								{
									id: "inner",
									name: "link",
									calendar:
									{
										level: "day",
										dateId: 20_260_115,
									},
								},
							],
						},
					],
				},
			),
		).toStrictEqual([
			{
				kind: "untagged-day",
				id: "outer",
				dateId: 20_260_115,
			},
			{
				kind: "nested-day",
				id: "inner",
				dateId: 20_260_115,
			},
		]);
	});

	it("reports nothing for a clean month", () =>
	{
		expect(
			auditCalendarMonth(
				{
					month:
					{
						id: "m10",
						...month,
					},
					levels,
					children: [
						{
							id: "t19",
							name: time(19),
							calendar:
							{
								level: "day",
								dateId: 20_261_019,
							},
						},
					],
				},
			),
		).toStrictEqual([]);
	});
});

describe("auditCalendarRoot", () =>
{
	it("reports name-only year and month children of the root", () =>
	{
		expect(
			auditCalendarRoot(
				{
					children: [
						{
							id: "y",
							name: "2027",
						},
						{
							id: "m",
							name: "11",
						},
						{
							id: "ok",
							name: "2026",
							calendar:
							{
								level: "year",
								dateId: 20_260_000,
							},
						},
						{
							id: "other",
							name: "Notes",
						},
					],
				},
			),
		).toStrictEqual([
			{
				kind: "untagged-year",
				id: "y",
				dateId: 20_270_000,
			},
			{
				kind: "untagged-month",
				id: "m",
				dateId: 0,
			},
		]);
	});
});

describe("datesInName", () =>
{
	it("reads each <time> element's date and skips text without one", () =>
	{
		expect([
			datesInName(
				'<time startYear="2026" startMonth="10" startDay="21">Wed</time> and <time startYear="2026" startMonth="11" startDay="2">x</time>',
			),
			datesInName("[2026-10-21]"),
			datesInName(null),
		]).toStrictEqual([
			[
				oct21,
				{
					year: 2026,
					month: 11,
					day: 2,
				},
			],
			[],
			[],
		]);
	});
});

describe("adoptAfterCreate", () =>
{
	const context =
	{
		parentChain: [month, year, root],
		siblings: [],
		levels,
	};
	const name = '<time startYear="2026" startMonth="10" startDay="21">Wed, Oct 21, 2026</time>';
	const set =
	{
		level: "day",
		value: "21",
		timestamp: new Date(2026, 9, 21).getTime(),
		dateId: 20_261_021,
	};

	it("writes the calendar metadata through the adapter", async () =>
	{
		const setNodeMetaValues = vi.fn<(id: string, changes: unknown[]) => Promise<void>>(async () => {});

		const result = await adoptAfterCreate(
			{
				id: "new1",
				name,
				context,
				adapter:
				{
					setNodeMetaValues,
				},
			},
		);

		expect(
			{
				result,
				calls: setNodeMetaValues.mock.calls,
			},
		).toStrictEqual(
			{
				result:
				{
					status: "adopted",
					set,
				},
				calls: [
					[
						"new1",
						[
							{
								path: ["calendar"],
								value: set,
							},
						],
					],
				],
			},
		);
	});

	it("reports unadoptable without an adapter, and skips a non-calendar parent", async () =>
	{
		expect([
			await adoptAfterCreate(
				{
					id: "new1",
					name,
					context,
					adapter: undefined,
				},
			),
			await adoptAfterCreate(
				{
					id: "new1",
					name,
					context: undefined,
					adapter: undefined,
				},
			),
		]).toStrictEqual([
			{
				status: "unadoptable",
				set,
			},
			{
				status: "skipped",
			},
		]);
	});
});
