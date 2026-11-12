// Upstream's table layout model (`WF.Table`, `WF.Layouts.canRender`) as pure functions over plain trees. A table's
// children are rows, a row's children are cells, and a cell's own children are nested items the table hides.
import type {TableMetadata} from "../node-types.js";
import {canRenderLayout} from "./layouts.js";

export const TABLE_COLUMN =
{
	defaultWidth: 125,
	minWidth: 30,
} as const;
const TABLE_ROW_DEFAULT_NAME = "Row";
const TABLE_HEADERS_NAME = "Headers";

export function isTable(layoutMode: string | null | undefined): boolean
{
	return layoutMode === "table";
}

export function tableWidth(
	rows: readonly
	{
		children: readonly unknown[];
	}[],
): number
{
	return rows.reduce((width, row) => Math.max(width, row.children.length), 0);
}

export function padPlan(
	rows: readonly
	{
		id: string;
		children: readonly unknown[];
	}[],
	width: number,
):
{
	rowId: string;
	add: number;
}[]
{
	return rows
		.filter((row) => row.children.length < width)
		.map((row) => (
		{
			rowId: row.id,
			add: width - row.children.length,
		}));
}

interface LayoutHolder
{
	layoutMode: string | null | undefined;
}

/**
 * `WF.Layouts.canRender("table", item)`: `ancestors` runs nearest-first up to and including the render root (the
 * zoomed item or a pane root). A table renders only when no complex layout sits between it and that root.
 */
export function canRenderTable(ancestors: readonly LayoutHolder[], node: LayoutHolder, dashboardsFlag = false): boolean
{
	return canRenderLayout(
		"table",
		node,
		ancestors,
		{
			reachedRoot: true,
			dashboardsFlag,
		},
	);
}

export type TableRole = "row" | "cell" | "inner";

/** A node's role under the nearest renderable table above it: a table parent makes a row, a grandparent a cell. */
export function tableRole(ancestors: readonly LayoutHolder[], dashboardsFlag = false): TableRole | null
{
	for (let depth = 0; depth < ancestors.length; depth += 1)
	{
		const candidate = ancestors[depth];
		if (candidate !== undefined && canRenderTable(ancestors.slice(depth + 1), candidate, dashboardsFlag))
		{
			return depth === 0 ? "row" : depth === 1 ? "cell" : "inner";
		}
	}
	return null;
}

export interface TableTreeNode
{
	id: string;
	name?: string;
	note?: string;
	table?: TableMetadata | null;
	children: TableTreeNode[];
}

export type TableOp =
	|
	  {
			op: "expand";
			id: string;
	  }
	|
	  {
			op: "expandAll";
			ids: string[];
	  }
	|
	  {
			op: "create";
			parentId: string;
			name: string;
			index: number;
			cells: number;
			table?:
			{
				headers: true;
			};
	  }
	|
	  {
			op: "pad";
			rowId: string;
			add: number;
	  }
	|
	  {
			op: "meta";
			id: string;
			path: string[];
			value: unknown;
	  }
	|
	  {
			op: "delete";
			id: string;
	  };

/** `item.edit.table_on`: a Headers row (new or flagged), every row padded to the width, every row expanded. */
export function planTableOn(table: TableTreeNode): TableOp[]
{
	if (table.table?.skipHeaders === true)
	{
		return [];
	}
	if (table.children.length === 0)
	{
		return [
			{
				op: "expand",
				id: table.id,
			},
			{
				op: "create",
				parentId: table.id,
				name: TABLE_HEADERS_NAME,
				index: 0,
				cells: 2,
				table:
				{
					headers: true,
				},
			},
			{
				op: "create",
				parentId: table.id,
				name: TABLE_ROW_DEFAULT_NAME,
				index: 1,
				cells: 2,
			},
		];
	}
	const width = tableWidth(table.children);
	const [first] = table.children;
	const flagsFirst = first?.table?.headers === true || first?.name?.toLowerCase() === "headers";
	const ops: TableOp[] = [];
	if (first !== undefined && flagsFirst)
	{
		ops.push(
			{
				op: "meta",
				id: first.id,
				path: ["table", "headers"],
				value: true,
			},
		);
	}
	else
	{
		ops.push(
			{
				op: "create",
				parentId: table.id,
				name: TABLE_HEADERS_NAME,
				index: 0,
				cells: width,
				table:
				{
					headers: true,
				},
			},
		);
	}
	for (const pad of padPlan(table.children, width))
	{
		ops.push(
			{
				op: "pad",
				...pad,
			},
		);
	}
	ops.push(
		{
			op: "expandAll",
			ids: table.children.map((row) => row.id),
		},
	);
	return ops;
}

function isEmptyCell(cell: TableTreeNode | undefined): boolean
{
	return cell !== undefined && (cell.name ?? "") === "" && (cell.note ?? "") === "" && cell.children.length === 0;
}

/** `item.edit.table_off`: drop trailing empty cells, then rows that are empty, unflagged and still named by default. */
export function planTableOff(table: TableTreeNode): TableOp[]
{
	const ops: TableOp[] = [];
	table.children.forEach((row, index) =>
	{
		let keep = row.children.length;
		while (keep > 0 && isEmptyCell(row.children[keep - 1]))
		{
			keep -= 1;
		}
		for (const cell of row.children.slice(keep))
		{
			ops.push(
				{
					op: "delete",
					id: cell.id,
				},
			);
		}
		const defaultName = index === 0 ? TABLE_HEADERS_NAME : TABLE_ROW_DEFAULT_NAME;
		if (keep === 0 && (row.note ?? "") === "" && row.table?.headers !== true && (row.name ?? "") === defaultName)
		{
			ops.push(
				{
					op: "delete",
					id: row.id,
				},
			);
		}
	});
	return ops;
}

export type Caret = "start" | "end";
export interface CellFocus
{
	row: number;
	col: number;
	caret: Caret;
}

export interface CellKeyContext
{
	row: number;
	col: number;
	rowCount: number;
	rowLens: readonly number[];
	caretAtStart: boolean;
	caretAtEnd: boolean;
}

const go = (row: number, col: number, caret: Caret) => (
{
	focus:
	{
		row,
		col,
		caret,
	},
});

/** What a key does in a cell: move the caret to another cell, swallow the key, or fall through (null). */
export function planCellKey(
	key: string,
	ctx: CellKeyContext,
):
	|
	  {
			focus: CellFocus;
	  }
	|
	  {
			claim: true;
	  }
	| null
{
	const {row, col} = ctx;
	const len = ctx.rowLens[row] ?? 0;
	const claim =
	{
		claim: true as const,
	};
	switch (key)
	{
		case "Tab":
			return col + 1 < len ? go(row, col + 1, "start") : claim;
		case "shift+Tab":
			return col > 0 ? go(row, col - 1, "end") : claim;
		case "ArrowLeft":
			if (!ctx.caretAtStart)
			{
				return null;
			}
			return col > 0 ? go(row, col - 1, "end") : claim;
		case "ArrowRight":
			if (!ctx.caretAtEnd)
			{
				return null;
			}
			return col + 1 < len ? go(row, col + 1, "start") : claim;
		case "ArrowUp":
			return row > 0 && (ctx.rowLens[row - 1] ?? 0) > col ? go(row - 1, col, "end") : claim;
		case "ArrowDown":
			return row + 1 < ctx.rowCount && (ctx.rowLens[row + 1] ?? 0) > col ? go(row + 1, col, "start") : claim;
		case "shift+ArrowUp":
		case "shift+ArrowDown":
			return claim;
		default:
			return null;
	}
}

/** Enter in a cell: a new row below, same column, every row padded to `max(width, rowLen, col + 1)`. */
export function planCellEnter(input: {rowLens: readonly number[]; row: number; col: number}):
{
	createRowAt: number;
	cells: number;
	pad:
	{
		rowIndex: number;
		add: number;
	}[];
	focus: CellFocus;
}
{
	const width = Math.max(
		input.rowLens.reduce((max, len) => Math.max(max, len), 0),
		input.rowLens[input.row] ?? 0,
		input.col + 1,
	);
	return {
		createRowAt: input.row + 1,
		cells: width,
		pad: input.rowLens.flatMap((len, rowIndex) =>
			len < width
				? [
						{
							rowIndex,
							add: width - len,
						},
					]
				: [],
		),
		focus:
		{
			row: input.row + 1,
			col: input.col,
			caret: "start",
		},
	};
}

export interface DeleteCell
{
	id: string;
	empty: boolean;
	hasChildren: boolean;
}
export interface DeleteRow
{
	id: string;
	cells: readonly DeleteCell[];
}

export type CellDeletePlan =
	|
	  {
			kind: "column";
			deleteIds: string[];
			needsConfirm: boolean;
			focus: CellFocus;
	  }
	|
	  {
			kind: "row";
			deleteIds: string[];
			needsConfirm: boolean;
			focus: CellFocus;
	  }
	|
	  {
			kind: "cell";
			deleteIds: string[];
			recreate:
			{
				rowId: string;
				index: number;
			};
			needsConfirm: boolean;
			focus: CellFocus;
	  };

/** ⇧⌘⌫ in a cell: a header cell removes its column; a body cell clears itself or removes a row left empty. */
export function planCellDelete(input: {
	rows: readonly DeleteRow[];
	row: number;
	col: number;
	selectedIds: readonly string[];
}): CellDeletePlan
{
	const {rows, row, col, selectedIds} = input;
	if (row === 0)
	{
		const header = rows[0];
		return {
			kind: "column",
			deleteIds: rows.flatMap((r) => (r.cells[col] === undefined ? [] : [r.cells[col].id])),
			needsConfirm: false,
			focus:
			{
				row: 0,
				col: Math.max(0, Math.min(col, (header?.cells.length ?? 2) - 2)),
				caret: "start",
			},
		};
	}
	const current = rows[row];
	const cells = current?.cells ?? [];
	const above: CellFocus =
	{
		row: row - 1,
		col,
		caret: "start",
	};
	const othersEmpty = cells.every((c, index) => index === col || c.empty || selectedIds.includes(c.id));
	if (current !== undefined && othersEmpty)
	{
		return {
			kind: "row",
			deleteIds: [current.id],
			needsConfirm: cells.some((c) => c.hasChildren),
			focus: above,
		};
	}
	return {
		kind: "cell",
		deleteIds: cells[col] === undefined ? [] : [cells[col].id],
		recreate:
		{
			rowId: current?.id ?? "",
			index: col,
		},
		needsConfirm: cells[col]?.hasChildren === true,
		focus: above,
	};
}

/** Backspace at offset 0 deletes the cell only when it is wholly empty; otherwise the key does nothing. */
export function planTableBackspaceAtStart(input: {
	rows: readonly DeleteRow[];
	row: number;
	col: number;
	name: string;
	note: string;
	hasChildren: boolean;
}):
	| CellDeletePlan
	|
	  {
			claim: true;
	  }
{
	if (input.name !== "" || input.note !== "" || input.hasChildren)
	{
		return {
			claim: true,
		};
	}
	return planCellDelete(
		{
			rows: input.rows,
			row: input.row,
			col: input.col,
			selectedIds: [],
		},
	);
}

/** ⇧⌘D: copy the cell at `col` of every row to `col + 1`. */
export function planDuplicateColumn(
	rows: readonly
	{
		id: string;
		cells: readonly
		{
			id: string;
		}[];
	}[],
	col: number,
):
{
	rowId: string;
	copyId: string;
	toIndex: number;
}[]
{
	return rows.flatMap((row) =>
		row.cells[col] === undefined
			? []
			: [
					{
						rowId: row.id,
						copyId: row.cells[col].id,
						toIndex: col + 1,
					},
				],
	);
}

/** The add-column "+": one more column in every row, caret in the new header cell. */
export function planAddColumn(rowLens: readonly number[]):
{
	add:
	{
		rowIndex: number;
		add: number;
	}[];
	focus: CellFocus;
}
{
	const width = rowLens.reduce((max, len) => Math.max(max, len), 0) + 1;
	return {
		add: rowLens.map((len, rowIndex) => (
		{
			rowIndex,
			add: width - len,
		})),
		focus:
		{
			row: 0,
			col: rowLens[0] ?? 0,
			caret: "start",
		},
	};
}

/** The add-row button: a `Row` of `width` empty cells at the bottom, caret in its first cell. */
export function planAddRow(
	width: number,
	rowCount: number,
):
{
	name: string;
	cells: number;
	focus: CellFocus;
}
{
	return {
		name: TABLE_ROW_DEFAULT_NAME,
		cells: width,
		focus:
		{
			row: rowCount,
			col: 0,
			caret: "start",
		},
	};
}

/** ⌘⇧↑/↓: a body cell moves its row (never above row 1), a header cell moves its column. */
export function planCellMove(
	direction: "up" | "down",
	input:
	{
		row: number;
		col: number;
		rowCount: number;
		width: number;
	},
):
{
	kind: "row" | "column";
	from: number;
	to: number;
} | null
{
	const step = direction === "up" ? -1 : 1;
	if (input.row === 0)
	{
		const to = input.col + step;
		return to < 0 || to >= input.width
			? null
			:
				{
					kind: "column",
					from: input.col,
					to,
				};
	}
	const to = input.row + step;
	return to < 1 || to >= input.rowCount
		? null
		:
			{
				kind: "row",
				from: input.row,
				to,
			};
}

export function tableColumnWidth(table: TableMetadata | null | undefined, headerCellId: string): number
{
	return table?.sizes?.[headerCellId] ?? TABLE_COLUMN.defaultWidth;
}

export function clampWidth(width: number, min: number): number
{
	return Math.max(min, width);
}

function isRecord(value: unknown): value is Record<string, unknown>
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setIn(source: Record<string, unknown>, keys: readonly string[], value: unknown): Record<string, unknown>
{
	const [key, ...rest] = keys;
	if (key === undefined)
	{
		return source;
	}
	const {[key]: current, ...others} = source;
	if (rest.length === 0)
	{
		return value === undefined
			? others
			:
				{
					...others,
					[key]: value,
				};
	}
	const child = setIn(isRecord(current) ? current : {}, rest, value);
	return {
		...others,
		[key]: child,
	};
}

function sizesOf(value: unknown): Record<string, number> | undefined
{
	if (!isRecord(value))
	{
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
	);
}

/** `metadata.table` after `{path, value}` changes (paths start with `"table"`); an undefined value removes the key. */
export function applyTableSet(
	table: TableMetadata | null | undefined,
	changes: readonly
	{
		path: readonly string[];
		value: unknown;
	}[],
): TableMetadata
{
	let next: Record<string, unknown> =
	{
		...table,
	};
	for (const {path, value} of changes)
	{
		next = setIn(next, path.slice(1), value);
	}
	const sizes = sizesOf(next.sizes);
	return {
		...(typeof next.headers === "boolean"
			?
				{
					headers: next.headers,
				}
			: {}),
		...(typeof next.skipHeaders === "boolean"
			?
				{
					skipHeaders: next.skipHeaders,
				}
			: {}),
		...(sizes === undefined
			? {}
			:
				{
					sizes,
				}),
		...(typeof next.bg === "string"
			?
				{
					bg: next.bg,
				}
			: {}),
	};
}
