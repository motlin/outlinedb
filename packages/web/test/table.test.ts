import {describe, expect, it} from "vite-plus/test";
import
{
	TABLE_COLUMN,
	applyTableSet,
	canRenderTable,
	clampWidth,
	isTable,
	padPlan,
	planAddColumn,
	planAddRow,
	planTableBackspaceAtStart,
	planCellDelete,
	planCellEnter,
	planCellKey,
	planCellMove,
	planDuplicateColumn,
	planTableOff,
	planTableOn,
	tableColumnWidth,
	tableRole,
	tableWidth,
} from "../src/client/table.js";
import type {TableTreeNode} from "../src/client/table.js";

function cell(id: string, name = "", children: TableTreeNode[] = []): TableTreeNode
{
	return {
		id,
		name,
		children,
	};
}

function row(id: string, cells: string[], extra: Partial<TableTreeNode> = {}): TableTreeNode
{
	return {
		id,
		name: "Row",
		children: cells.map((name, index) => cell(`${id}-${index}`, name)),
		...extra,
	};
}

describe("table model", () =>
{
	it("knows a table by its layout mode and its widths", () =>
	{
		expect(
			{
				table: isTable("table"),
				board: isTable("board"),
				none: isTable(null),
				width: tableWidth([
					{
						children: [1, 2, 3],
					},
					{
						children: [1],
					},
				]),
				defaults: TABLE_COLUMN,
			},
		).toStrictEqual(
			{
				table: true,
				board: false,
				none: false,
				width: 3,
				defaults:
				{
					defaultWidth: 125,
					minWidth: 30,
				},
			},
		);
	});

	it("plans padding for the short rows only", () =>
	{
		const rows = [
			row("name", ["Name", "Qty", "Notes"]),
			row("apple", ["Apple", "3", "red"]),
			row("pear", ["Pear", ""]),
		];
		expect(padPlan(rows, 3)).toStrictEqual([
			{
				rowId: "pear",
				add: 1,
			},
		]);
	});

	it("assigns row, cell and inner roles to the descendants of a renderable table", () =>
	{
		expect(
			{
				row: tableRole([
					{
						layoutMode: "table",
					},
				]),
				cell: tableRole([
					{
						layoutMode: null,
					},
					{
						layoutMode: "table",
					},
				]),
				inner: tableRole([
					{
						layoutMode: null,
					},
					{
						layoutMode: null,
					},
					{
						layoutMode: "table",
					},
				]),
				none: tableRole([
					{
						layoutMode: null,
					},
				]),
				inBoard: tableRole([
					{
						layoutMode: "table",
					},
					{
						layoutMode: "board",
					},
				]),
				nestedInCell: tableRole([
					{
						layoutMode: "table",
					},
					{
						layoutMode: null,
					},
					{
						layoutMode: null,
					},
					{
						layoutMode: "table",
					},
				]),
			},
		).toStrictEqual(
			{
				row: "row",
				cell: "cell",
				inner: "inner",
				none: null,
				inBoard: null,
				nestedInCell: "inner",
			},
		);
	});

	it("ports WF.Layouts.canRender: no complex layout between the table and its render root", () =>
	{
		const table =
		{
			layoutMode: "table",
		};
		expect(
			{
				zoomRoot: canRenderTable([], table),
				inBoard: canRenderTable(
					[
						{
							layoutMode: "board",
						},
					],
					table,
				),
				inCell: canRenderTable(
					[
						{
							layoutMode: null,
						},
						{
							layoutMode: "table",
						},
					],
					table,
				),
				plainParent: canRenderTable(
					[
						{
							layoutMode: null,
						},
					],
					table,
				),
				notATable: canRenderTable(
					[
						{
							layoutMode: null,
						},
					],
					{
						layoutMode: "board",
					},
				),
				dashboardFlagOff: canRenderTable(
					[
						{
							layoutMode: "dashboard",
						},
					],
					table,
					false,
				),
				dashboardFlagOn: canRenderTable(
					[
						{
							layoutMode: "dashboard",
						},
					],
					table,
					true,
				),
			},
		).toStrictEqual(
			{
				zoomRoot: true,
				inBoard: false,
				inCell: false,
				plainParent: true,
				notATable: false,
				dashboardFlagOff: true,
				dashboardFlagOn: false,
			},
		);
	});
});

describe("toggle on and off", () =>
{
	it("gives a childless item a Headers row and a Row of two cells", () =>
	{
		expect(
			planTableOn(
				{
					id: "t",
					children: [],
				},
			),
		).toStrictEqual([
			{
				op: "expand",
				id: "t",
			},
			{
				op: "create",
				parentId: "t",
				name: "Headers",
				index: 0,
				cells: 2,
				table:
				{
					headers: true,
				},
			},
			{
				op: "create",
				parentId: "t",
				name: "Row",
				index: 1,
				cells: 2,
			},
		]);
	});

	it("inserts a Headers row, pads and expands every row of an item with children", () =>
	{
		const a = row("a", ["x", "y"]);
		const b = row("b", ["z"]);
		expect(
			planTableOn(
				{
					id: "t",
					children: [a, b],
				},
			),
		).toStrictEqual([
			{
				op: "create",
				parentId: "t",
				name: "Headers",
				index: 0,
				cells: 2,
				table:
				{
					headers: true,
				},
			},
			{
				op: "pad",
				rowId: "b",
				add: 1,
			},
			{
				op: "expandAll",
				ids: ["a", "b"],
			},
		]);
	});

	it("flags an existing first row named Headers instead of creating one", () =>
	{
		const headers =
		{
			id: "h",
			name: "headers",
			children: [cell("p", "p"), cell("q", "q")],
		};
		expect(
			planTableOn(
				{
					id: "t",
					children: [headers, row("a", ["x"])],
				},
			),
		).toStrictEqual([
			{
				op: "meta",
				id: "h",
				path: ["table", "headers"],
				value: true,
			},
			{
				op: "pad",
				rowId: "a",
				add: 1,
			},
			{
				op: "expandAll",
				ids: ["h", "a"],
			},
		]);
	});

	it("skips the plan when the paste path set skipHeaders", () =>
	{
		expect(
			planTableOn(
				{
					id: "t",
					children: [row("a", ["x"])],
					table:
					{
						skipHeaders: true,
					},
				},
			),
		).toStrictEqual([]);
	});

	it("turns off by deleting empty trailing cells and empty Row rows, keeping a flagged Headers row", () =>
	{
		const headers =
		{
			id: "h",
			name: "Headers",
			table:
			{
				headers: true,
			},
			children: [cell("h0"), cell("h1")],
		};
		const empty = row("r", ["", ""]);
		expect(
			planTableOff(
				{
					id: "t",
					children: [headers, empty],
				},
			),
		).toStrictEqual([
			{
				op: "delete",
				id: "h0",
			},
			{
				op: "delete",
				id: "h1",
			},
			{
				op: "delete",
				id: "r-0",
			},
			{
				op: "delete",
				id: "r-1",
			},
			{
				op: "delete",
				id: "r",
			},
		]);
	});

	it("keeps trailing cells that hold text and rows with content", () =>
	{
		const full = row("a", ["x", ""]);
		expect(
			planTableOff(
				{
					id: "t",
					children: [full],
				},
			),
		).toStrictEqual([
			{
				op: "delete",
				id: "a-1",
			},
		]);
	});
});

describe("cell keyboard", () =>
{
	const ctx =
	{
		row: 1,
		col: 1,
		rowCount: 3,
		rowLens: [3, 3, 2],
		caretAtStart: true,
		caretAtEnd: true,
	};
	it.each([
		[
			"Tab",
			{
				...ctx,
				col: 0,
			},
			{
				focus:
				{
					row: 1,
					col: 1,
					caret: "start",
				},
			},
		],
		[
			"Tab",
			{
				...ctx,
				col: 2,
			},
			{
				claim: true,
			},
		],
		[
			"shift+Tab",
			ctx,
			{
				focus:
				{
					row: 1,
					col: 0,
					caret: "end",
				},
			},
		],
		[
			"shift+Tab",
			{
				...ctx,
				col: 0,
			},
			{
				claim: true,
			},
		],
		[
			"ArrowLeft",
			ctx,
			{
				focus:
				{
					row: 1,
					col: 0,
					caret: "end",
				},
			},
		],
		[
			"ArrowLeft",
			{
				...ctx,
				caretAtStart: false,
			},
			null,
		],
		[
			"ArrowRight",
			{
				...ctx,
				col: 0,
			},
			{
				focus:
				{
					row: 1,
					col: 1,
					caret: "start",
				},
			},
		],
		[
			"ArrowRight",
			{
				...ctx,
				col: 2,
			},
			{
				claim: true,
			},
		],
		[
			"ArrowUp",
			{
				...ctx,
				row: 2,
				col: 0,
			},
			{
				focus:
				{
					row: 1,
					col: 0,
					caret: "end",
				},
			},
		],
		[
			"ArrowUp",
			{
				...ctx,
				row: 0,
			},
			{
				claim: true,
			},
		],
		[
			"ArrowDown",
			{
				...ctx,
				row: 0,
			},
			{
				focus:
				{
					row: 1,
					col: 1,
					caret: "start",
				},
			},
		],
		[
			"ArrowDown",
			{
				...ctx,
				row: 2,
			},
			{
				claim: true,
			},
		],
		[
			"ArrowDown",
			{
				...ctx,
				row: 1,
				col: 2,
				rowLens: [3, 3, 2],
			},
			{
				claim: true,
			},
		],
		[
			"shift+ArrowUp",
			ctx,
			{
				claim: true,
			},
		],
		[
			"shift+ArrowDown",
			ctx,
			{
				claim: true,
			},
		],
		["x", ctx, null],
	])("%s", (key, input, expected) =>
	{
		expect(planCellKey(key, input)).toStrictEqual(expected);
	});
});

describe("structural cell edits", () =>
{
	const rows = [
		{
			id: "h",
			cells: [
				{
					id: "h0",
					empty: false,
					hasChildren: false,
				},
				{
					id: "h1",
					empty: false,
					hasChildren: false,
				},
			],
		},
		{
			id: "a",
			cells: [
				{
					id: "a0",
					empty: false,
					hasChildren: false,
				},
				{
					id: "a1",
					empty: false,
					hasChildren: true,
				},
			],
		},
		{
			id: "b",
			cells: [
				{
					id: "b0",
					empty: true,
					hasChildren: false,
				},
				{
					id: "b1",
					empty: true,
					hasChildren: false,
				},
			],
		},
	];

	it("Enter adds a row below padded to the width and focuses the same column", () =>
	{
		expect(
			planCellEnter(
				{
					rowLens: [2, 2, 1],
					row: 1,
					col: 1,
				},
			),
		).toStrictEqual(
			{
				createRowAt: 2,
				cells: 2,
				pad: [
					{
						rowIndex: 2,
						add: 1,
					},
				],
				focus:
				{
					row: 2,
					col: 1,
					caret: "start",
				},
			},
		);
		expect(
			planCellEnter(
				{
					rowLens: [2],
					row: 0,
					col: 3,
				},
			),
		).toStrictEqual(
			{
				createRowAt: 1,
				cells: 4,
				pad: [
					{
						rowIndex: 0,
						add: 2,
					},
				],
				focus:
				{
					row: 1,
					col: 3,
					caret: "start",
				},
			},
		);
	});

	it("deleting a header cell deletes the column without a confirmation", () =>
	{
		expect(
			planCellDelete(
				{
					rows,
					row: 0,
					col: 1,
					selectedIds: [],
				},
			),
		).toStrictEqual(
			{
				kind: "column",
				deleteIds: ["h1", "a1", "b1"],
				needsConfirm: false,
				focus:
				{
					row: 0,
					col: 0,
					caret: "start",
				},
			},
		);
	});

	it("deleting a body cell clears it and recreates it, asking when it holds children", () =>
	{
		expect(
			planCellDelete(
				{
					rows,
					row: 1,
					col: 1,
					selectedIds: [],
				},
			),
		).toStrictEqual(
			{
				kind: "cell",
				deleteIds: ["a1"],
				recreate:
				{
					rowId: "a",
					index: 1,
				},
				needsConfirm: true,
				focus:
				{
					row: 0,
					col: 1,
					caret: "start",
				},
			},
		);
	});

	it("deleting a body cell whose neighbours are all empty deletes the row", () =>
	{
		expect(
			planCellDelete(
				{
					rows,
					row: 2,
					col: 0,
					selectedIds: [],
				},
			),
		).toStrictEqual(
			{
				kind: "row",
				deleteIds: ["b"],
				needsConfirm: false,
				focus:
				{
					row: 1,
					col: 0,
					caret: "start",
				},
			},
		);
	});

	it("Backspace at the start deletes only an empty cell", () =>
	{
		expect(
			planTableBackspaceAtStart(
				{
					rows,
					row: 2,
					col: 1,
					name: "",
					note: "",
					hasChildren: false,
				},
			),
		).toStrictEqual(
			{
				kind: "row",
				deleteIds: ["b"],
				needsConfirm: false,
				focus:
				{
					row: 1,
					col: 1,
					caret: "start",
				},
			},
		);
		expect(
			planTableBackspaceAtStart(
				{
					rows,
					row: 1,
					col: 0,
					name: "x",
					note: "",
					hasChildren: false,
				},
			),
		).toStrictEqual(
			{
				claim: true,
			},
		);
	});

	it("duplicates a column, appends a column and appends a row", () =>
	{
		expect(
			{
				dup: planDuplicateColumn(
					rows.map((r) => (
					{
						id: r.id,
						cells: r.cells,
					})),
					0,
				),
				addColumn: planAddColumn([2, 2, 1]),
				addRow: planAddRow(2, 3),
			},
		).toStrictEqual(
			{
				dup: [
					{
						rowId: "h",
						copyId: "h0",
						toIndex: 1,
					},
					{
						rowId: "a",
						copyId: "a0",
						toIndex: 1,
					},
					{
						rowId: "b",
						copyId: "b0",
						toIndex: 1,
					},
				],
				addColumn:
				{
					add: [
						{
							rowIndex: 0,
							add: 1,
						},
						{
							rowIndex: 1,
							add: 1,
						},
						{
							rowIndex: 2,
							add: 2,
						},
					],
					focus:
					{
						row: 0,
						col: 2,
						caret: "start",
					},
				},
				addRow:
				{
					name: "Row",
					cells: 2,
					focus:
					{
						row: 3,
						col: 0,
						caret: "start",
					},
				},
			},
		);
	});
});

describe("row and column moves", () =>
{
	it("moves a body row up and down but never above row 1 or past the end", () =>
	{
		expect(
			{
				up3: planCellMove(
					"up",
					{
						row: 3,
						col: 0,
						rowCount: 4,
						width: 3,
					},
				),
				up2: planCellMove(
					"up",
					{
						row: 2,
						col: 0,
						rowCount: 4,
						width: 3,
					},
				),
				up1: planCellMove(
					"up",
					{
						row: 1,
						col: 0,
						rowCount: 4,
						width: 3,
					},
				),
				down: planCellMove(
					"down",
					{
						row: 3,
						col: 0,
						rowCount: 4,
						width: 3,
					},
				),
			},
		).toStrictEqual(
			{
				up3:
				{
					kind: "row",
					from: 3,
					to: 2,
				},
				up2:
				{
					kind: "row",
					from: 2,
					to: 1,
				},
				up1: null,
				down: null,
			},
		);
	});

	it("moves a header column right and left within the width", () =>
	{
		expect(
			{
				right: planCellMove(
					"down",
					{
						row: 0,
						col: 0,
						rowCount: 4,
						width: 3,
					},
				),
				left: planCellMove(
					"up",
					{
						row: 0,
						col: 1,
						rowCount: 4,
						width: 3,
					},
				),
				edge: planCellMove(
					"up",
					{
						row: 0,
						col: 0,
						rowCount: 4,
						width: 3,
					},
				),
				end: planCellMove(
					"down",
					{
						row: 0,
						col: 2,
						rowCount: 4,
						width: 3,
					},
				),
			},
		).toStrictEqual(
			{
				right:
				{
					kind: "column",
					from: 0,
					to: 1,
				},
				left:
				{
					kind: "column",
					from: 1,
					to: 0,
				},
				edge: null,
				end: null,
			},
		);
	});
});

describe("column widths", () =>
{
	it("reads the stored width, the default, and clamps to the minimum", () =>
	{
		expect(
			{
				stored: tableColumnWidth(
					{
						sizes:
						{
							c1: 200,
						},
					},
					"c1",
				),
				missing: tableColumnWidth(null, "c1"),
				clamped: clampWidth(125 - 200, 30),
			},
		).toStrictEqual(
			{
				stored: 200,
				missing: 125,
				clamped: 30,
			},
		);
	});
});

describe("table metadata patches", () =>
{
	it("applies tableSet paths to the cached metadata", () =>
	{
		expect(
			applyTableSet(
				{
					headers: true,
				},
				[
					{
						path: ["table", "sizes", "c1"],
						value: 200,
					},
					{
						path: ["table", "bg"],
						value: "red",
					},
				],
			),
		).toStrictEqual(
			{
				headers: true,
				sizes:
				{
					c1: 200,
				},
				bg: "red",
			},
		);
		expect(
			applyTableSet(
				{
					bg: "red",
				},
				[
					{
						path: ["table", "bg"],
						value: undefined,
					},
				],
			),
		).toStrictEqual({});
	});
});
