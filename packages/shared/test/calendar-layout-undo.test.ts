import {describe, expect, it} from "vite-plus/test";
import {calendarLayoutUndoWrites} from "../src/internal/calendar-layout-undo.js";
import type {SubtreeState} from "../src/internal/calendar-layout-undo.js";

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

const level = (name: string, dateId: number) => (
{
	calendar:
	{
		level: name,
		dateId,
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
