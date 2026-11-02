import {describe, expect, it} from "vite-plus/test";
import {calendarLevelMetadata, calendarLevelName} from "../src/internal/calendar-day.js";
import {calendarNodeId} from "../src/internal/calendar-ids.js";
import
{
	calendarLayoutCustomLevels,
	calendarLayoutNeedsConfirm,
	planCalendarLayout,
} from "../src/internal/calendar-layout.js";
import type {LayoutNode} from "../src/internal/calendar-layout.js";

const ENTROPY = "k";
const DATE_FORMAT = "YYYY-MM-DD ddd";

function time(year: number, month: number, day: number, hour?: number): string
{
	const at = hour === undefined ? "" : ` startHour="${hour}" startMinute="0"`;
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}"${at}>x</time>`;
}

function node(id: string, name: string, children: LayoutNode[] = [], extra: Partial<LayoutNode> = {}): LayoutNode
{
	return {
		id,
		name,
		note: "",
		children,
		...extra,
	};
}

function yearNode(id: string, value: number, children: LayoutNode[] = [], name = String(value)): LayoutNode
{
	return node(
		id,
		name,
		children,
		{
			calendar:
			{
				level: "year",
				dateId: value * 10_000,
			},
		},
	);
}

function monthNode(id: string, y: number, m: number, children: LayoutNode[] = [], name?: string): LayoutNode
{
	return node(
		id,
		name ?? String(m).padStart(2, "0"),
		children,
		{
			calendar:
			{
				level: "month",
				dateId: y * 10_000 + m * 100,
			},
		},
	);
}

function dayNode(id: string, y: number, m: number, d: number, children: LayoutNode[] = []): LayoutNode
{
	return node(
		id,
		time(y, m, d),
		children,
		{
			calendar:
			{
				level: "day",
				dateId: y * 10_000 + m * 100 + d,
			},
		},
	);
}

function root(children: LayoutNode[]): LayoutNode
{
	return node("cal", "📆 Calendar", children);
}

describe("calendarLayoutCustomLevels (upstream P10's warning scan)", () =>
{
	it("lists the year and month levels whose nodes were renamed or carry a note, skipping days and mirrors", () =>
	{
		const tree = root([
			yearNode("y2025", 2025, [
				monthNode("m2025-01", 2025, 1, [], "01"),
				monthNode("m2025-02", 2025, 2, [], "February plans"),
			]),
			yearNode("y2026", 2026, [], "2026"),
			node(
				"mirror",
				"2024 copy",
				[],
				{
					isMirror: true,
					calendar:
					{
						level: "year",
						dateId: 20_240_000,
					},
				},
			),
			dayNode("d", 2026, 1, 1),
		]);
		expect(calendarLayoutCustomLevels(tree, DATE_FORMAT)).toStrictEqual(["month"]);
		const noted = root([yearNode("y2026", 2026, [monthNode("m", 2026, 3)], "2026")]);
		noted.children[0] =
		{
			...noted.children[0],
			note: "goals",
		} as LayoutNode;
		expect(calendarLayoutCustomLevels(noted, DATE_FORMAT)).toStrictEqual(["year"]);
		expect(
			calendarLayoutCustomLevels(root([yearNode("y", 2026, [monthNode("m", 2026, 3)])]), DATE_FORMAT),
		).toStrictEqual([]);
	});
});

describe("calendarLayoutNeedsConfirm (upstream OS2)", () =>
{
	it("is true when a non-calendar, non-mirror root child or its descendant has a dated name or note", () =>
	{
		expect(calendarLayoutNeedsConfirm(root([yearNode("y", 2026), node("notes", "Notes")]))).toBe(false);
		expect(
			calendarLayoutNeedsConfirm(root([node("notes", "Notes", [node("call", `Call ${time(2026, 9, 1)}`)])])),
		).toBe(true);
		expect(
			calendarLayoutNeedsConfirm(
				root([
					node(
						"n",
						"Plain",
						[],
						{
							note: `due ${time(2026, 9, 1)}`,
						},
					),
				]),
			),
		).toBe(true);
		expect(
			calendarLayoutNeedsConfirm(
				root([
					node(
						"m",
						`Copy ${time(2026, 9, 1)}`,
						[],
						{
							isMirror: true,
						},
					),
				]),
			),
		).toBe(false);
	});
});

describe("planCalendarLayout (upstream JX4)", () =>
{
	it("turns month off: days move under their year in date order, emptied months are deleted", () =>
	{
		const tree = root([
			yearNode("y2026", 2026, [
				monthNode("m09", 2026, 9, [dayNode("d0910", 2026, 9, 10), dayNode("d0911", 2026, 9, 11)]),
				monthNode("m10", 2026, 10, [dayNode("d1001", 2026, 10, 1)]),
			]),
		]);
		expect(
			planCalendarLayout(
				tree,
				{
					year: true,
					day: true,
				},
				{
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
				},
			),
		).toStrictEqual([
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					year: true,
					day: true,
				},
			},
			{
				op: "move",
				id: "d0910",
				parentId: "y2026",
				index: 0,
				from:
				{
					parentId: "m09",
					index: 0,
				},
			},
			{
				op: "move",
				id: "d0911",
				parentId: "y2026",
				index: 1,
				from:
				{
					parentId: "m09",
					index: 0,
				},
			},
			{
				op: "move",
				id: "d1001",
				parentId: "y2026",
				index: 2,
				from:
				{
					parentId: "m10",
					index: 0,
				},
			},
			{
				op: "delete",
				id: "m09",
				from:
				{
					parentId: "y2026",
					index: 3,
				},
			},
			{
				op: "delete",
				id: "m10",
				from:
				{
					parentId: "y2026",
					index: 3,
				},
			},
		]);
	});

	it("turns month on: creates months, keeps custom nodes, converts a lone dated node into its day, files timed items", () =>
	{
		const tree = root([
			yearNode("y2026", 2026, [
				node("goals", "Goals"),
				dayNode("d0910", 2026, 9, 10),
				dayNode("d1001", 2026, 10, 1),
			]),
			node("dentist", `Dentist ${time(2026, 10, 1, 9)}`),
			node("notes", "Notes", [node("call", `Call ${time(2026, 9, 11)}`)]),
		]);
		const m09 = calendarNodeId(ENTROPY, "month", 20_260_900);
		const m10 = calendarNodeId(ENTROPY, "month", 20_261_000);
		const monthMeta = (m: number) => (
		{
			restorableUniqueNode: true,
			calendar: calendarLevelMetadata(
				"month",
				{
					year: 2026,
					month: m,
					day: 1,
				},
			),
		});
		expect(
			planCalendarLayout(
				tree,
				{
					year: true,
					month: true,
					day: true,
				},
				{
					currentLevels:
					{
						year: true,
						day: true,
					},
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
				},
			),
		).toStrictEqual([
			{
				op: "set-calendar",
				id: "call",
				calendar: calendarLevelMetadata(
					"day",
					{
						year: 2026,
						month: 9,
						day: 11,
					},
				),
			},
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					year: true,
					month: true,
					day: true,
				},
			},
			{
				op: "create",
				id: m09,
				parentId: "y2026",
				index: 1,
				name: "09",
				metadata: monthMeta(9),
			},
			{
				op: "move",
				id: "d0910",
				parentId: m09,
				index: 0,
				from:
				{
					parentId: "y2026",
					index: 2,
				},
			},
			{
				op: "move",
				id: "call",
				parentId: m09,
				index: 1,
				from:
				{
					parentId: "notes",
					index: 0,
				},
			},
			{
				op: "create",
				id: m10,
				parentId: "y2026",
				index: 2,
				name: "10",
				metadata: monthMeta(10),
			},
			{
				op: "move",
				id: "d1001",
				parentId: m10,
				index: 0,
				from:
				{
					parentId: "y2026",
					index: 3,
				},
			},
			{
				op: "move",
				id: "dentist",
				parentId: "d1001",
				index: 0,
				from:
				{
					parentId: "cal",
					index: 1,
				},
			},
		]);
	});

	it("strips a duplicate day's calendar metadata, leaves a placed day alone, and creates a missing day for a timed item", () =>
	{
		const tree = root([
			yearNode("y2026", 2026, [
				monthNode("m09", 2026, 9, [dayNode("d0910", 2026, 9, 10)]),
				monthNode("m09b", 2026, 9, [dayNode("dup", 2026, 9, 10, [node("x", "x")])]),
			]),
			node("trip", `Trip ${time(2026, 9, 12, 8)}`),
		]);
		const d0912 = calendarNodeId(ENTROPY, "day", 20_260_912);
		expect(
			planCalendarLayout(
				tree,
				{
					year: true,
					month: true,
					day: true,
				},
				{
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
				},
			),
		).toStrictEqual([
			{
				op: "set-calendar",
				id: "dup",
				calendar: null,
			},
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					year: true,
					month: true,
					day: true,
				},
			},
			{
				op: "create",
				id: d0912,
				parentId: "m09",
				index: 1,
				name: calendarLevelName(
					"day",
					{
						year: 2026,
						month: 9,
						day: 12,
					},
					DATE_FORMAT,
				),
				metadata:
				{
					restorableUniqueNode: true,
					calendar: calendarLevelMetadata(
						"day",
						{
							year: 2026,
							month: 9,
							day: 12,
						},
					),
				},
			},
			{
				op: "move",
				id: "trip",
				parentId: d0912,
				index: 0,
				from:
				{
					parentId: "cal",
					index: 1,
				},
			},
			{
				op: "move",
				id: "dup",
				parentId: "d0910",
				index: 0,
				from:
				{
					parentId: "m09b",
					index: 0,
				},
			},
			{
				op: "delete",
				id: "m09b",
				from:
				{
					parentId: "y2026",
					index: 1,
				},
			},
		]);
	});

	it("turns year off: kept nodes rise to the root, the deterministic month moves up instead of being recreated", () =>
	{
		const y = calendarNodeId(ENTROPY, "year", 20_260_000);
		const m = calendarNodeId(ENTROPY, "month", 20_260_900);
		const d = calendarNodeId(ENTROPY, "day", 20_260_910);
		const tree = root([
			yearNode(y, 2026, [node("goals", "Goals"), monthNode(m, 2026, 9, [dayNode(d, 2026, 9, 10)])]),
		]);
		expect(
			planCalendarLayout(
				tree,
				{
					month: true,
					day: true,
				},
				{
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
				},
			),
		).toStrictEqual([
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					month: true,
					day: true,
				},
			},
			{
				op: "move",
				id: "goals",
				parentId: "cal",
				index: 0,
				from:
				{
					parentId: y,
					index: 0,
				},
			},
			{
				op: "move",
				id: m,
				parentId: "cal",
				index: 1,
				from:
				{
					parentId: y,
					index: 0,
				},
			},
			{
				op: "delete",
				id: y,
				from:
				{
					parentId: "cal",
					index: 2,
				},
			},
		]);
	});

	it("drops the same-slot moves upstream sends for days past the first month, so an unchanged layout only resets levels", () =>
	{
		const tree = root([
			yearNode("y2026", 2026, [
				monthNode("m09", 2026, 9, [dayNode("d0910", 2026, 9, 10)]),
				monthNode("m10", 2026, 10, [dayNode("d1001", 2026, 10, 1), dayNode("d1002", 2026, 10, 2)]),
			]),
		]);
		expect(
			planCalendarLayout(
				tree,
				{
					year: true,
					month: true,
					day: true,
				},
				{
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
				},
			),
		).toStrictEqual([
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					year: true,
					month: true,
					day: true,
				},
			},
		]);
	});

	it("turns week on: creates each day's week (per weekStartDay) under its month in date order", () =>
	{
		const tree = root([
			yearNode("y2026", 2026, [
				monthNode("m10", 2026, 10, [dayNode("d1010", 2026, 10, 10), dayNode("d1012", 2026, 10, 12)]),
			]),
		]);
		const w1004 = calendarNodeId(ENTROPY, "week", 20_261_004, 2026);
		const w1011 = calendarNodeId(ENTROPY, "week", 20_261_011, 2026);
		const weekMeta = (day: number) => (
		{
			restorableUniqueNode: true,
			calendar: calendarLevelMetadata(
				"week",
				{
					year: 2026,
					month: 10,
					day,
				},
			),
		});
		expect(
			planCalendarLayout(
				tree,
				{
					year: true,
					month: true,
					week: true,
					day: true,
				},
				{
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
					weekStartDay: 0,
				},
			),
		).toStrictEqual([
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					year: true,
					month: true,
					week: true,
					day: true,
				},
			},
			{
				op: "create",
				id: w1004,
				parentId: "m10",
				index: 0,
				name: "Week 41",
				metadata: weekMeta(10),
			},
			{
				op: "move",
				id: "d1010",
				parentId: w1004,
				index: 0,
				from:
				{
					parentId: "m10",
					index: 1,
				},
			},
			{
				op: "create",
				id: w1011,
				parentId: "m10",
				index: 1,
				name: "Week 42",
				metadata: weekMeta(12),
			},
			{
				op: "move",
				id: "d1012",
				parentId: w1011,
				index: 0,
				from:
				{
					parentId: "m10",
					index: 2,
				},
			},
		]);
	});

	it("turns week off: days rise into their month and the emptied weeks are deleted", () =>
	{
		const tree = root([
			yearNode("y2026", 2026, [
				monthNode("m10", 2026, 10, [
					node(
						"w1004",
						"Week 41",
						[dayNode("d1010", 2026, 10, 10)],
						{
							calendar:
							{
								level: "week",
								dateId: 20_261_004,
							},
						},
					),
					node(
						"w1011",
						"Week 42",
						[dayNode("d1012", 2026, 10, 12)],
						{
							calendar:
							{
								level: "week",
								dateId: 20_261_011,
							},
						},
					),
				]),
			]),
		]);
		expect(
			planCalendarLayout(
				tree,
				{
					year: true,
					month: true,
					day: true,
				},
				{
					currentLevels:
					{
						year: true,
						month: true,
						week: true,
						day: true,
					},
					dateFormat: DATE_FORMAT,
					entropyKey: ENTROPY,
				},
			),
		).toStrictEqual([
			{
				op: "set-levels",
				id: "cal",
				levels:
				{
					year: true,
					month: true,
					day: true,
				},
			},
			{
				op: "move",
				id: "d1010",
				parentId: "m10",
				index: 0,
				from:
				{
					parentId: "w1004",
					index: 0,
				},
			},
			{
				op: "move",
				id: "d1012",
				parentId: "m10",
				index: 1,
				from:
				{
					parentId: "w1011",
					index: 0,
				},
			},
			{
				op: "delete",
				id: "w1004",
				from:
				{
					parentId: "m10",
					index: 2,
				},
			},
			{
				op: "delete",
				id: "w1011",
				from:
				{
					parentId: "m10",
					index: 2,
				},
			},
		]);
	});
});
