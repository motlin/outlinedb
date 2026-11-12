import {describe, expect, it} from "vite-plus/test";
import
{
	LEFT_BAR_TODAY_KEY,
	leftBarDragArmed,
	isValidLeftBarParent,
	planLeftBarDrop,
	planTodayDrop,
	pointInsideStrict,
	rowMovingStyle,
	starDropAfter,
} from "../src/client/left-bar-drop.js";
import type {LeftBarDropFacts} from "../src/client/left-bar-drop.js";

const ancestorsOf = (id: string): string[] =>
	(
	{
		b1: ["b", "root"],
		a1: ["a", "root"],
	})[id] ?? [];

function facts(overrides: Partial<LeftBarDropFacts>): LeftBarDropFacts
{
	return {
		rowRect:
		{
			top: 567,
			height: 30,
		},
		labelRect:
		{
			left: 60,
			width: 217,
		},
		point:
		{
			x: 100,
			y: 592,
		},
		item:
		{
			id: "A",
			parentId: "Box",
			index: 0,
			expanded: false,
			isSearch: false,
		},
		disableRootMoves: false,
		previousSibling: null,
		isValidParent: () => true,
		...overrides,
	};
}

describe("planLeftBarDrop", () =>
{
	it("drops into a collapsed row from its lower-right quadrant, ambiguously", () =>
	{
		expect(planLeftBarDrop(facts({}))).toStrictEqual(
			{
				parentId: "A",
				index: 0,
				ambiguous: true,
				bar:
				{
					top: 597,
					left: 84,
					width: 193,
				},
			},
		);
	});

	it("drops into the previous sibling from the upper-right quadrant", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						point:
						{
							x: 100,
							y: 572,
						},
						item:
						{
							id: "B",
							parentId: "Box",
							index: 1,
							expanded: false,
							isSearch: false,
						},
						previousSibling:
						{
							id: "A",
							expanded: false,
							childCount: 2,
						},
					},
				),
			),
		).toStrictEqual(
			{
				parentId: "A",
				index: 0,
				ambiguous: false,
				bar:
				{
					top: 567,
					left: 84,
					width: 193,
				},
			},
		);
	});

	it("appends into an expanded previous sibling", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						point:
						{
							x: 100,
							y: 572,
						},
						item:
						{
							id: "B",
							parentId: "Box",
							index: 1,
							expanded: false,
							isSearch: false,
						},
						previousSibling:
						{
							id: "A",
							expanded: true,
							childCount: 2,
						},
					},
				),
			),
		).toStrictEqual(
			{
				parentId: "A",
				index: 2,
				ambiguous: false,
				bar:
				{
					top: 567,
					left: 84,
					width: 193,
				},
			},
		);
	});

	it("falls back to before when the previous sibling is not a valid parent", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						point:
						{
							x: 100,
							y: 572,
						},
						item:
						{
							id: "B",
							parentId: "Box",
							index: 1,
							expanded: false,
							isSearch: false,
						},
						previousSibling:
						{
							id: "A",
							expanded: false,
							childCount: 2,
						},
						isValidParent: (id) => id !== "A",
					},
				),
			),
		).toStrictEqual(
			{
				parentId: "Box",
				index: 1,
				ambiguous: false,
				bar:
				{
					top: 567,
					left: 60,
					width: 217,
				},
			},
		);
	});

	it("drops into an expanded row from the whole lower half with a 12px indent", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						point:
						{
							x: 62,
							y: 592,
						},
						item:
						{
							id: "Box",
							parentId: "Sandbox",
							index: 4,
							expanded: true,
							isSearch: false,
						},
					},
				),
			),
		).toStrictEqual(
			{
				parentId: "Box",
				index: 0,
				ambiguous: false,
				bar:
				{
					top: 597,
					left: 72,
					width: 205,
				},
			},
		);
	});

	it("drops after a collapsed row from its lower-left quadrant", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						point:
						{
							x: 62,
							y: 592,
						},
					},
				),
			),
		).toStrictEqual(
			{
				parentId: "Box",
				index: 1,
				ambiguous: false,
				bar:
				{
					top: 597,
					left: 60,
					width: 217,
				},
			},
		);
	});

	it("drops before the first row from its whole upper half", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						point:
						{
							x: 100,
							y: 572,
						},
					},
				),
			),
		).toStrictEqual(
			{
				parentId: "Box",
				index: 0,
				ambiguous: false,
				bar:
				{
					top: 567,
					left: 60,
					width: 217,
				},
			},
		);
	});

	it("accepts only into on a depth-0 Starred row", () =>
	{
		const starred =
		{
			disableRootMoves: true,
		};
		expect([
			planLeftBarDrop(
				facts(
					{
						...starred,
						point:
						{
							x: 62,
							y: 572,
						},
					},
				),
			),
			planLeftBarDrop(
				facts(
					{
						...starred,
						point:
						{
							x: 62,
							y: 592,
						},
					},
				),
			),
			planLeftBarDrop(
				facts(
					{
						...starred,
						point:
						{
							x: 100,
							y: 592,
						},
					},
				),
			),
		]).toStrictEqual([
			null,
			null,
			{
				parentId: "A",
				index: 0,
				ambiguous: true,
				bar:
				{
					top: 597,
					left: 84,
					width: 193,
				},
			},
		]);
	});

	it("ignores search rows", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						item:
						{
							id: "A",
							parentId: "Box",
							index: 0,
							expanded: false,
							isSearch: true,
						},
					},
				),
			),
		).toBeNull();
	});

	it("returns null when the parent is the moving item itself", () =>
	{
		expect(
			planLeftBarDrop(
				facts(
					{
						isValidParent: (id) => id !== "A",
					},
				),
			),
		).toBeNull();
	});
});

describe("planTodayDrop", () =>
{
	it("moves to the top of the day node", () =>
	{
		expect(
			planTodayDrop(
				["x", "y"],
				{
					id: "day",
				},
			),
		).toStrictEqual(
			{
				ids: ["x", "y"],
				parentId: "day",
				index: 0,
			},
		);
	});

	it("refuses to move the day into itself", () =>
	{
		expect(
			planTodayDrop(
				["day"],
				{
					id: "day",
				},
			),
		).toBeNull();
	});
});

describe("starDropAfter", () =>
{
	it("is lower from the midpoint down", () =>
	{
		expect([
			starDropAfter(
				{
					y: 100,
					height: 30,
				},
				115,
			),
			starDropAfter(
				{
					y: 100,
					height: 30,
				},
				114,
			),
		]).toStrictEqual([true, false]);
	});
});

describe("pointInsideStrict", () =>
{
	it("excludes the edges", () =>
	{
		const rect =
		{
			left: 0,
			top: 0,
			right: 10,
			bottom: 10,
		};
		expect([
			pointInsideStrict(rect, 5, 5),
			pointInsideStrict(rect, 0, 5),
			pointInsideStrict(rect, 5, 10),
		]).toStrictEqual([true, false, false]);
	});
});

describe("moving styles and validity", () =>
{
	it("styles rows by the grabbed item only", () =>
	{
		expect([
			rowMovingStyle("b1", "a", ancestorsOf),
			rowMovingStyle("a1", "a", ancestorsOf),
			rowMovingStyle("a", "a", ancestorsOf),
		]).toStrictEqual([
			{
				inside: false,
				dim: false,
			},
			{
				inside: true,
				dim: true,
			},
			{
				inside: true,
				dim: true,
			},
		]);
	});

	it("rejects a parent inside any dragging item", () =>
	{
		expect([
			isValidLeftBarParent("b1", ["a", "b"], ancestorsOf),
			isValidLeftBarParent("b", ["a", "b"], ancestorsOf),
			isValidLeftBarParent("c", ["a", "b"], ancestorsOf),
		]).toStrictEqual([false, false, true]);
	});
});

describe("leftBarDragArmed", () =>
{
	it("arms past 10px on either axis, not by distance", () =>
	{
		expect([
			leftBarDragArmed(3, 9),
			leftBarDragArmed(0, 11),
			leftBarDragArmed(-11, 0),
			leftBarDragArmed(8, 8),
			leftBarDragArmed(10, 10),
		]).toStrictEqual([false, true, true, false, false]);
		expect(LEFT_BAR_TODAY_KEY).toBe("left-bar-today");
	});
});
