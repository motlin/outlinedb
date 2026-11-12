import {describe, expect, it} from "vite-plus/test";
import {CALENDAR_ID_NAMESPACE, calendarNodeId, uuidv5} from "../src/internal/calendar-ids.js";
import {calendarLayoutUndoWrites} from "../src/internal/calendar-layout-undo.js";
import type {SubtreeState} from "../src/internal/calendar-layout-undo.js";
import {calendarLevelMetadata, calendarLevelName} from "../src/internal/calendar-day.js";
import
{
	calendarLayoutCustomLevels,
	calendarLayoutNeedsConfirm,
	planCalendarLayout,
} from "../src/internal/calendar-layout.js";
import type {LayoutNode} from "../src/internal/calendar-layout.js";
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
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {findCalendarDays, findTaggedCalendarRoot} from "../src/cache/calendar-lookup.js";
import {CacheService} from "../src/cache/index.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";

describe("calendar ids", () =>
{
	// Expected values computed independently with Python's `uuid.uuid5`.
	describe("uuidv5", () =>
	{
		it("matches the RFC 4122 DNS-namespace example", () =>
		{
			expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
				"2ed6657d-e927-568b-95e1-2665a8aea6a2",
			);
		});
	});

	describe("calendarNodeId", () =>
	{
		it("is the uuidv5 of `${entropyKey}-calendar-${level}-${dateId}` in upstream's namespace", () =>
		{
			expect(CALENDAR_ID_NAMESPACE).toBe("3e19dffe-1c3b-4d76-8e57-0de20e69bdae");
			expect(calendarNodeId("k", "day", 20_261_017)).toBe("e7a88667-b0da-5b51-b5ca-0da96853dc1e");
			expect(calendarNodeId("k", "month", 20_261_000)).toBe("fec3b740-fe77-561b-a470-4abe9b1ecd66");
		});

		it("names a week `calendar-week-${year}-${dateId}`, the year being the date's, not the week start's", () =>
		{
			expect([
				calendarNodeId("k", "week", 20_261_011, 2026),
				calendarNodeId("k", "week", 20_261_227, 2027),
			]).toStrictEqual(["230a80db-d497-5344-89bd-f6bf3274ddf1", "f3ea7c80-7d8d-5b92-980e-6db0ea8914d5"]);
		});
	});
});

describe("calendar layout undo", () =>
{
	const CAL = "cal";
	const Y2026 = "y2026";
	const M10 = "m10";
	const D19 = "d19";
	const D20 = "d20";
	const ENTRY = "entry";
	const TIMED = "timed";
	const NOTES = "notes";
	const NEW_YEAR = "new-year";
	const LATE = "late";

	const level = (name: string, id: number) => (
	{
		calendar:
		{
			level: name,
			dateId: id,
		},
	});

	function state(
		children: Record<string, string[]>,
		metadata: Record<string, Record<string, unknown>> = {},
	): SubtreeState
	{
		return {
			children: new Map(Object.entries(children)),
			metadata: new Map(Object.entries(metadata)),
		};
	}

	/** 2026 > 10 > 19, 20 (one entry), plus a timed node and notes at the root. */
	const BEFORE = state(
		{
			[CAL]: [Y2026, TIMED, NOTES],
			[Y2026]: [M10],
			[M10]: [D19, D20],
			[D19]: [],
			[D20]: [ENTRY],
			[ENTRY]: [],
			[TIMED]: [],
			[NOTES]: [],
		},
		{
			[Y2026]: level("year", 20_260_000),
			[M10]: level("month", 20_261_000),
			[D19]: level("day", 20_261_019),
			[D20]: level("day", 20_261_020),
		},
	);

	const notCached = () => false;

	describe("calendarLayoutUndoWrites", () =>
	{
		it("moves, undeletes and edits the subtree back to how it was before the layout", () =>
		{
			// The layout dropped the month level and filed the timed node into its day.
			const now = state(
				{
					[CAL]: [Y2026, NOTES],
					[Y2026]: [D19, D20],
					[D19]: [],
					[D20]: [ENTRY, TIMED],
					[ENTRY]: [],
					[TIMED]: [],
					[NOTES]: [],
				},
				{
					[CAL]:
					{
						calendar:
						{
							levels:
							{
								year: true,
								day: true,
							},
						},
					},
					[Y2026]: level("year", 20_260_000),
					[D19]: level("day", 20_261_019),
					[D20]: level("day", 20_261_020),
				},
			);

			expect(calendarLayoutUndoWrites(CAL, BEFORE, now, notCached)).toStrictEqual([
				{
					op: "move",
					id: TIMED,
					parentId: CAL,
					index: 1,
					from:
					{
						parentId: D20,
						index: 1,
					},
				},
				{
					op: "undelete",
					id: M10,
					parentId: Y2026,
					index: 0,
				},
				{
					op: "move",
					id: D19,
					parentId: M10,
					index: 0,
					from:
					{
						parentId: Y2026,
						index: 1,
					},
				},
				{
					op: "move",
					id: D20,
					parentId: M10,
					index: 1,
					from:
					{
						parentId: Y2026,
						index: 1,
					},
				},
				{
					op: "edit",
					id: CAL,
					patches: [
						{
							op: "remove",
							path: ["calendar"],
						},
					],
					inverse: [
						{
							op: "add",
							path: ["calendar"],
							value:
							{
								levels:
								{
									year: true,
									day: true,
								},
							},
						},
					],
				},
			]);
		});

		it("deletes the level nodes the layout created once their children are back, deepest first", () =>
		{
			const before = state(
				{
					[CAL]: [D19],
					[D19]: [],
				},
				{
					[D19]: level("day", 20_261_019),
				},
			);
			const now = state(
				{
					[CAL]: [NEW_YEAR],
					[NEW_YEAR]: [D19],
					[D19]: [],
				},
				{
					[NEW_YEAR]: level("year", 20_260_000),
					[D19]: level("day", 20_261_019),
				},
			);

			expect(calendarLayoutUndoWrites(CAL, before, now, notCached)).toStrictEqual([
				{
					op: "move",
					id: D19,
					parentId: CAL,
					index: 0,
					from:
					{
						parentId: NEW_YEAR,
						index: 0,
					},
				},
				{
					op: "delete",
					id: NEW_YEAR,
					from:
					{
						parentId: CAL,
						index: 1,
					},
				},
			]);
		});

		it("keeps a node added since the layout, leaving it after the restored siblings", () =>
		{
			const before = state(
				{
					[CAL]: [D19, D20],
					[D19]: [],
					[D20]: [],
				},
			);
			const now = state(
				{
					[CAL]: [LATE, D20, D19],
					[LATE]: [],
					[D19]: [],
					[D20]: [],
				},
			);

			expect(calendarLayoutUndoWrites(CAL, before, now, notCached)).toStrictEqual([
				{
					op: "move",
					id: D19,
					parentId: CAL,
					index: 0,
					from:
					{
						parentId: CAL,
						index: 2,
					},
				},
				{
					op: "move",
					id: D20,
					parentId: CAL,
					index: 1,
					from:
					{
						parentId: CAL,
						index: 2,
					},
				},
			]);
		});

		it("leaves alone a node moved out of the calendar since, rather than undeleting it", () =>
		{
			const before = state(
				{
					[CAL]: [D19, NOTES],
					[D19]: [],
					[NOTES]: [],
				},
			);
			const now = state(
				{
					[CAL]: [D19],
					[D19]: [],
				},
			);

			expect(calendarLayoutUndoWrites(CAL, before, now, (id) => id === NOTES)).toStrictEqual([]);
		});

		it("refuses when a created level node now holds a node the calendar did not have before", () =>
		{
			const before = state(
				{
					[CAL]: [D19],
					[D19]: [],
				},
				{
					[D19]: level("day", 20_261_019),
				},
			);
			const now = state(
				{
					[CAL]: [NEW_YEAR],
					[NEW_YEAR]: [D19, LATE],
					[D19]: [],
					[LATE]: [],
				},
				{
					[NEW_YEAR]: level("year", 20_260_000),
					[D19]: level("day", 20_261_019),
				},
			);

			expect(() => calendarLayoutUndoWrites(CAL, before, now, notCached)).toThrow(
				`calendar layout: cannot undo, ${NEW_YEAR} still holds nodes added since the layout`,
			);
		});
	});
});

describe("calendar layout", () =>
{
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
});

describe("calendar levels", () =>
{
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
});

describe("calendar metadata indexes", () =>
{
	const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

	/** A migrated database that records every statement it runs against calendar_metadata. */
	function recordingDb()
	{
		const queries:
		{
			sql: string;
			params: unknown[];
		}[] = [];
		const sqlite = new DatabaseConstructor(":memory:");
		const database = drizzle(
			sqlite,
			{
				schema,
				logger:
				{
					logQuery(sql, params)
					{
						if (sql.includes(`from "calendar_metadata"`))
						{
							queries.push(
								{
									sql,
									params,
								},
							);
						}
					},
				},
			},
		);
		migrate(
			database,
			{
				migrationsFolder,
			},
		);
		return {
			sqlite,
			database,
			queries,
		};
	}

	/** The plan detail lines that scan calendar_metadata itself, not the node_content liveness subquery. */
	function calendarMetadataPlan(
		sqlite: DatabaseConstructor.Database,
		query:
		{
			sql: string;
			params: unknown[];
		},
	)
	{
		const plan:
		{
			detail: string;
		}[] = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as
		{
			detail: string;
		}[];
		return plan.map(({detail}) => detail).filter((detail) => detail.includes("calendar_metadata"));
	}

	describe("calendar_metadata live-row indexes", () =>
	{
		it("finds the tagged calendar root through the root index", () =>
		{
			const {sqlite, database, queries} = recordingDb();

			findTaggedCalendarRoot(
				{
					db: database,
				},
			);

			expect(queries.map((query) => calendarMetadataPlan(sqlite, query))).toStrictEqual([
				["SEARCH calendar_metadata USING INDEX calendar_metadata_root_idx (root=? AND system_to=?)"],
			]);
		});

		it("scans a month's tagged days through the day index", () =>
		{
			const {sqlite, database, queries} = recordingDb();
			sqlite
				.prepare(
					"INSERT INTO node_content (id, name, parent_id, system_from, system_to) VALUES (?, ?, NULL, ?, ?)",
				)
				.run("cal", "📆 Calendar", "2026-10-01 00:00:00.000", FAR_FUTURE_DATE);

			findCalendarDays(
				{
					db: database,
					cache: new CacheService(database),
				},
				[20_261_017],
			);

			expect(queries.map((query) => calendarMetadataPlan(sqlite, query))).toStrictEqual([
				["SEARCH calendar_metadata USING INDEX calendar_metadata_root_idx (root=? AND system_to=?)"],
				[
					"SEARCH calendar_metadata USING INDEX calendar_metadata_level_idx (level=? AND system_to=? AND date_id>? AND date_id<?)",
				],
			]);
		});
	});
});
