import {describe, expect, it} from "vite-plus/test";
import
{
	boardColumnsVisibleInSearch,
	boardRole,
	columnWidth,
	inlineBoardBleed,
	insertColumnSubject,
	rowEnterRole,
	insertColumnTarget,
	isBoard,
	nextWidth,
	saveColumnWidth,
} from "../src/client/board.js";

function fakeStorage(values: Record<string, string>)
{
	return {
		getItem: (key: string) => values[key] ?? null,
		setItem: () =>
		{
		},
	};
}

const throwingStorage =
{
	getItem: (): string | null =>
	{
		throw new Error("blocked");
	},
	setItem: () =>
	{
		throw new Error("blocked");
	},
};

describe("isBoard", () =>
{
	it("is true only for the board layout mode", () =>
	{
		expect([isBoard("board"), isBoard(null), isBoard("bullets"), isBoard("table")]).toStrictEqual([
			true,
			false,
			false,
			false,
		]);
	});
});

describe("boardRole", () =>
{
	it("classifies a row by its nearest board ancestor", () =>
	{
		expect([
			boardRole([
				{
					layoutMode: "board",
				},
			]),
			boardRole([
				{
					layoutMode: null,
				},
				{
					layoutMode: "board",
				},
			]),
			boardRole([
				{
					layoutMode: null,
				},
				{
					layoutMode: null,
				},
				{
					layoutMode: "board",
				},
			]),
			boardRole([
				{
					layoutMode: null,
				},
			]),
			boardRole([]),
		]).toStrictEqual(["column", "card", "inner", null, null]);
	});
});

describe("columnWidth", () =>
{
	it("reads the stored width, clamps it to 180 and defaults to 320", () =>
	{
		expect([
			columnWidth(
				"c1",
				fakeStorage(
					{
						"board.width.c1": "120",
					},
				),
			),
			columnWidth(
				"c1",
				fakeStorage(
					{
						"board.width.c1": "240",
					},
				),
			),
			columnWidth("c1", fakeStorage({})),
			columnWidth("c1", throwingStorage),
			columnWidth(
				"c1",
				fakeStorage(
					{
						"board.width.c1": "junk",
					},
				),
			),
		]).toStrictEqual([180, 240, 320, 320, 320]);
	});
});

describe("insertColumnTarget", () =>
{
	const base =
	{
		id: "x",
		parentId: "p",
		grandparentId: "g",
		index: 1,
		parentIndex: 2,
		childCount: 4,
	};
	it("places a column relative to a board, column or card", () =>
	{
		expect([
			insertColumnTarget(
				"left",
				{
					...base,
					role: "board",
					id: "board",
				},
			),
			insertColumnTarget(
				"right",
				{
					...base,
					role: "board",
					id: "board",
				},
			),
			insertColumnTarget(
				"left",
				{
					...base,
					role: "column",
					parentId: "board",
				},
			),
			insertColumnTarget(
				"right",
				{
					...base,
					role: "column",
					parentId: "board",
				},
			),
			insertColumnTarget(
				"left",
				{
					...base,
					role: "card",
					parentId: "colB",
					grandparentId: "board",
				},
			),
			insertColumnTarget(
				"right",
				{
					...base,
					role: "card",
					parentId: "colB",
					grandparentId: "board",
				},
			),
		]).toStrictEqual([
			{
				parentId: "board",
				index: 0,
			},
			{
				parentId: "board",
				index: 4,
			},
			{
				parentId: "board",
				index: 1,
			},
			{
				parentId: "board",
				index: 2,
			},
			{
				parentId: "board",
				index: 2,
			},
			{
				parentId: "board",
				index: 3,
			},
		]);
	});
});

describe("nextWidth", () =>
{
	it("adds the drag distance and never goes below the minimum", () =>
	{
		expect([nextWidth(320, -200, 180), nextWidth(320, 40, 180)]).toStrictEqual([180, 360]);
	});
});

describe("saveColumnWidth", () =>
{
	it("writes board.width.<id> and swallows storage failures", () =>
	{
		const writes: [string, string][] = [];
		saveColumnWidth(
			"bob",
			240,
			{
				setItem: (k, v) => void writes.push([k, v]),
			},
		);
		saveColumnWidth("bob", 240, throwingStorage);
		expect(writes).toStrictEqual([["board.width.bob", "240"]]);
	});
});

describe("inlineBoardBleed", () =>
{
	it("measures the full-bleed strip from the page position", () =>
	{
		expect(
			inlineBoardBleed(
				{
					innerWidth: 1272,
					leftBarOffset: 0,
					scrollbar: 0,
					pageLeft: 0,
					pagePadLeft: 80,
					depth: 1,
				},
			),
		).toStrictEqual(
			{
				width: 1272,
				left: -80,
				paddingLeft: 90,
			},
		);
		expect(
			inlineBoardBleed(
				{
					innerWidth: 1272,
					leftBarOffset: 100,
					scrollbar: 15,
					pageLeft: 20,
					pagePadLeft: 80,
					depth: 3,
				},
			),
		).toStrictEqual(
			{
				width: 1157,
				left: -172,
				paddingLeft: 182,
			},
		);
	});
});

describe("boardColumnsVisibleInSearch", () =>
{
	it("keeps every column: matches, collapsed, or empty", () =>
	{
		expect(
			boardColumnsVisibleInSearch(
				[
					{
						id: "todo",
						childCount: 2,
					},
					{
						id: "doing",
						childCount: 1,
					},
					{
						id: "done",
						childCount: 0,
					},
				],
				{
					todo: true,
					doing: false,
					done: false,
				},
			),
		).toStrictEqual([
			{
				id: "todo",
				mode: "matches",
			},
			{
				id: "doing",
				mode: "collapsed",
			},
			{
				id: "done",
				mode: "empty",
			},
		]);
	});
});

describe("insertColumnSubject", () =>
{
	const nodes: Record<
		string,
		{
			parent_id: string | null;
			layoutMode: string | null;
		}
	> =
	{
		board:
		{
			parent_id: null,
			layoutMode: "board",
		},
		a:
		{
			parent_id: "board",
			layoutMode: null,
		},
		b:
		{
			parent_id: "board",
			layoutMode: null,
		},
		c:
		{
			parent_id: "board",
			layoutMode: null,
		},
		card:
		{
			parent_id: "c",
			layoutMode: null,
		},
		plain:
		{
			parent_id: null,
			layoutMode: null,
		},
	};
	const children: Record<string, string[]> =
	{
		board: ["a", "b", "c"],
		c: ["card"],
	};
	const tree =
	{
		node: (id: string) => nodes[id],
		childIds: (id: string) => children[id] ?? [],
		renders: () => true,
	};

	it("finds the role and positions, and refuses a plain row", () =>
	{
		expect([
			insertColumnSubject("board", tree),
			insertColumnSubject("b", tree),
			insertColumnSubject("card", tree),
			insertColumnSubject("plain", tree),
		]).toStrictEqual([
			{
				role: "board",
				id: "board",
				parentId: "",
				grandparentId: "",
				index: 0,
				parentIndex: 0,
				childCount: 3,
			},
			{
				role: "column",
				id: "b",
				parentId: "board",
				grandparentId: "",
				index: 1,
				parentIndex: 0,
				childCount: 0,
			},
			{
				role: "card",
				id: "card",
				parentId: "c",
				grandparentId: "board",
				index: 0,
				parentIndex: 2,
				childCount: 0,
			},
			null,
		]);
		expect(insertColumnTarget("right", insertColumnSubject("card", tree)!)).toStrictEqual(
			{
				parentId: "board",
				index: 3,
			},
		);
		expect(insertColumnTarget("left", insertColumnSubject("card", tree)!)).toStrictEqual(
			{
				parentId: "board",
				index: 2,
			},
		);
	});

	it("refuses a board, column and card whose board does not render", () =>
	{
		const gated = (rendering: string[]) => (
		{
			...tree,
			renders: (id: string) => rendering.includes(id),
		});
		expect([
			insertColumnSubject("board", gated([]))?.role ?? null,
			insertColumnSubject("b", gated([]))?.role ?? null,
			insertColumnSubject("card", gated([]))?.role ?? null,
			insertColumnSubject("board", gated(["board"]))?.role ?? null,
			insertColumnSubject("b", gated(["board"]))?.role ?? null,
			insertColumnSubject("card", gated(["board"]))?.role ?? null,
		]).toStrictEqual([null, null, null, "board", "column", "card"]);
	});
});

describe("rowEnterRole", () =>
{
	it("is column or card only under a renderable board or dashboard", () =>
	{
		expect([
			rowEnterRole(
				{
					parentRendersBoard: true,
					parentRendersDashboard: false,
				},
			),
			rowEnterRole(
				{
					parentRendersBoard: false,
					parentRendersDashboard: true,
				},
			),
			rowEnterRole(
				{
					parentRendersBoard: false,
					parentRendersDashboard: false,
				},
			),
		]).toStrictEqual(["column", "card", null]);
	});
});
