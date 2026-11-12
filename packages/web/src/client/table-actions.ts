// Executes the table planners from table.ts against the outline: creates, deletes and moves go through the node
// mutations, and the caret follows the plan's focus. Pure over `TableDeps`, so tests drive it with fakes.
import type {QueryClient} from "@tanstack/react-query";
import {readGrid, treeForPlan} from "./table-cache.js";
import type {CellLocation, TableGrid} from "./table-cache.js";
import
{
	planTableBackspaceAtStart,
	planAddColumn,
	planAddRow,
	planCellDelete,
	planCellEnter,
	planCellMove,
	planDuplicateColumn,
	planTableOff,
	planTableOn,
	tableWidth,
} from "./table.js";
import type {CellDeletePlan, CellFocus, DeleteRow, TableOp} from "./table.js";

export interface TableDeps
{
	queryClient: QueryClient;
	create: (request: {id: string; parent_id: string; name: string; index: number}) => void;
	remove: (id: string) => void;
	move: (id: string, parentId: string, index: number) => void;
	duplicate: (ids: string[], parentId: string, index: number) => Promise<unknown>;
	setTable: (id: string, path: string[], value: unknown) => void;
	expand: (ids: readonly string[]) => void;
	focus: (id: string, caret: "start" | "end") => void;
	confirm: (message: string) => Promise<boolean>;
	/** Load (and cache) a parent's children, so a table that was never shown can still be read. */
	loadChildren: (parentId: string) => Promise<unknown>;
	/** Make the commands inside `fn` one undo step. */
	batch: (fn: () => void | Promise<void>) => Promise<void>;
	newId?: () => string;
}

const NESTED_DELETE_MESSAGE =
	"Some cells contain nested items. If you delete these cells, their nested items will be deleted too.";

function newId(deps: TableDeps): string
{
	return deps.newId?.() ?? crypto.randomUUID();
}

/** Creates a row of `cells` empty cells at `index`, returning their ids. */
function createRow(
	deps: TableDeps,
	tableId: string,
	name: string,
	index: number,
	cells: number,
	headers = false,
):
{
	rowId: string;
	cellIds: string[];
}
{
	const rowId = newId(deps);
	deps.create(
		{
			id: rowId,
			parent_id: tableId,
			name,
			index,
		},
	);
	if (headers)
	{
		deps.setTable(rowId, ["table", "headers"], true);
	}
	const cellIds = Array.from(
		{
			length: cells,
		},
		(_, cellIndex) =>
		{
			const id = newId(deps);
			deps.create(
				{
					id,
					parent_id: rowId,
					name: "",
					index: cellIndex,
				},
			);
			return id;
		},
	);
	return {
		rowId,
		cellIds,
	};
}

/** Appends `add` empty cells to a row that has `length` cells. */
function appendCells(deps: TableDeps, rowId: string, length: number, add: number): string[]
{
	return Array.from(
		{
			length: add,
		},
		(_, offset) =>
		{
			const id = newId(deps);
			deps.create(
				{
					id,
					parent_id: rowId,
					name: "",
					index: length + offset,
				},
			);
			return id;
		},
	);
}

function cellIdAt(grid: TableGrid, row: number, col: number): string | undefined
{
	return grid.rows[row]?.cells[col]?.id;
}

/** Runs the toggle-on or toggle-off op list for a table. */
function applyTableOps(deps: TableDeps, grid: TableGrid, ops: readonly TableOp[]): void
{
	for (const op of ops)
	{
		switch (op.op)
		{
			case "expand":
				deps.expand([op.id]);
				break;
			case "expandAll":
				deps.expand(op.ids);
				break;
			case "create":
				createRow(deps, op.parentId, op.name, op.index, op.cells, op.table?.headers === true);
				break;
			case "pad":
			{
				const entry = grid.rows.find((candidate) => candidate.row.id === op.rowId);
				appendCells(deps, op.rowId, entry?.cells.length ?? 0, op.add);
				break;
			}
			case "meta":
				deps.setTable(op.id, op.path, op.value);
				break;
			case "delete":
				deps.remove(op.id);
				break;
		}
	}
}

/** `toggle_table` / Turn into Table: structure the rows once the layout is written. */
export async function structureTable(deps: TableDeps, tableId: string, on: boolean): Promise<void>
{
	await deps.loadChildren(tableId);
	const rows = readGrid(deps.queryClient, tableId)?.rows ?? [];
	await Promise.all(rows.map(async ({row}) => deps.loadChildren(row.id)));
	const grid = readGrid(deps.queryClient, tableId);
	if (grid === null)
	{
		return;
	}
	const tree = treeForPlan(grid);
	await deps.batch(() =>
	{
		applyTableOps(deps, grid, on ? planTableOn(tree) : planTableOff(tree));
	});
}

/** Enter in a cell: a new row below with the caret in the same column. */
export async function cellEnter(deps: TableDeps, location: CellLocation): Promise<void>
{
	const {grid, rowIndex, colIndex} = location;
	const plan = planCellEnter(
		{
			rowLens: grid.rows.map((entry) => entry.cells.length),
			row: rowIndex,
			col: colIndex,
		},
	);
	await deps.batch(() =>
	{
		const created = createRow(deps, grid.table.id, "Row", plan.createRowAt, plan.cells);
		for (const pad of plan.pad)
		{
			const entry = grid.rows[pad.rowIndex];
			if (entry !== undefined)
			{
				appendCells(deps, entry.row.id, entry.cells.length, pad.add);
			}
		}
		const target = created.cellIds[plan.focus.col];
		if (target !== undefined)
		{
			deps.focus(target, "start");
		}
	});
}

function deleteRows(grid: TableGrid, nested: (id: string) => boolean): DeleteRow[]
{
	return grid.rows.map(({row, cells}) => (
	{
		id: row.id,
		cells: cells.map((cell) => (
		{
			id: cell.id,
			empty: (cell.name ?? "") === "" && (cell.note ?? "") === "" && cell.hasChildren !== true,
			hasChildren: nested(cell.id),
		})),
	}));
}

/** Runs a delete plan, asking first when the plan says nested items would go. */
async function runCellDelete(deps: TableDeps, grid: TableGrid, plan: CellDeletePlan): Promise<void>
{
	if (plan.needsConfirm && !(await deps.confirm(NESTED_DELETE_MESSAGE)))
	{
		return;
	}
	// A column delete shifts the cells after it left by one, so the focus index names the cell that was one to its right.
	const deletedCol =
		plan.kind === "column" ? (grid.rows[0]?.cells.findIndex((cell) => cell.id === plan.deleteIds[0]) ?? -1) : -1;
	const focusCol = deletedCol >= 0 && plan.focus.col >= deletedCol ? plan.focus.col + 1 : plan.focus.col;
	const focusId = cellIdAt(grid, plan.focus.row, focusCol);
	await deps.batch(() =>
	{
		if (plan.kind === "cell")
		{
			const entry = grid.rows.find((candidate) => candidate.row.id === plan.recreate.rowId);
			for (const id of plan.deleteIds)
			{
				deps.remove(id);
			}
			if (entry !== undefined)
			{
				deps.create(
					{
						id: newId(deps),
						parent_id: entry.row.id,
						name: "",
						index: plan.recreate.index,
					},
				);
			}
		}
		else
		{
			for (const id of plan.deleteIds)
			{
				deps.remove(id);
			}
		}
		if (focusId !== undefined)
		{
			deps.focus(focusId, plan.focus.caret);
		}
	});
}

/** ⇧⌘⌫ in a cell. */
export async function cellDelete(
	deps: TableDeps,
	location: CellLocation,
	selectedIds: readonly string[],
): Promise<void>
{
	const {grid, rowIndex, colIndex} = location;
	const plan = planCellDelete(
		{
			rows: deleteRows(grid, (id) =>
				grid.rows.some((entry) => entry.cells.some((cell) => cell.id === id && cell.hasChildren === true)),
			),
			row: rowIndex,
			col: colIndex,
			selectedIds,
		},
	);
	await runCellDelete(deps, grid, plan);
}

/** Backspace at the start of a cell: delete it only when it is wholly empty; a non-empty cell does nothing. */
export async function cellBackspace(
	deps: TableDeps,
	location: CellLocation,
	cell:
	{
		name: string;
		note: string;
		hasChildren: boolean;
	},
): Promise<void>
{
	const {grid, rowIndex, colIndex} = location;
	const plan = planTableBackspaceAtStart(
		{
			rows: deleteRows(grid, (id) =>
				grid.rows.some((entry) => entry.cells.some((c) => c.id === id && c.hasChildren === true)),
			),
			row: rowIndex,
			col: colIndex,
			...cell,
		},
	);
	if ("kind" in plan)
	{
		await runCellDelete(deps, grid, plan);
	}
}

/** ⇧⌘D: copy the cell's column right next to it. */
export async function duplicateColumn(deps: TableDeps, location: CellLocation): Promise<void>
{
	const {grid, colIndex} = location;
	const copies = planDuplicateColumn(
		grid.rows.map((entry) => (
		{
			id: entry.row.id,
			cells: entry.cells,
		})),
		colIndex,
	);
	await deps.batch(async () =>
	{
		await Promise.all(copies.map(async (copy) => deps.duplicate([copy.copyId], copy.rowId, copy.toIndex)));
	});
}

/** The header "+": one more column everywhere, caret in the new header cell. */
export async function addColumn(deps: TableDeps, tableId: string): Promise<void>
{
	const grid = readGrid(deps.queryClient, tableId);
	if (grid === null || grid.rows.length === 0)
	{
		return;
	}
	const plan = planAddColumn(grid.rows.map((entry) => entry.cells.length));
	await deps.batch(() =>
	{
		let headerId: string | undefined;
		for (const pad of plan.add)
		{
			const entry = grid.rows[pad.rowIndex];
			if (entry !== undefined)
			{
				const created = appendCells(deps, entry.row.id, entry.cells.length, pad.add);
				if (pad.rowIndex === 0)
				{
					headerId = created.at(-1);
				}
			}
		}
		if (headerId !== undefined)
		{
			deps.focus(headerId, "start");
		}
	});
}

/** The add-row button: a Row at the bottom padded to the table width, caret in its first cell. */
export async function addRow(deps: TableDeps, tableId: string): Promise<void>
{
	const grid = readGrid(deps.queryClient, tableId);
	if (grid === null)
	{
		return;
	}
	const plan = planAddRow(
		Math.max(
			tableWidth(
				grid.rows.map((entry) => (
				{
					children: entry.cells,
				})),
			),
			1,
		),
		grid.rows.length,
	);
	await deps.batch(() =>
	{
		const created = createRow(deps, tableId, plan.name, grid.rows.length, plan.cells);
		const [first] = created.cellIds;
		if (first !== undefined)
		{
			deps.focus(first, "start");
		}
	});
}

/** ⌘⇧↑/↓ on a cell: move its row, or (header cell) its column. */
export async function moveCell(deps: TableDeps, location: CellLocation, direction: "up" | "down"): Promise<boolean>
{
	const {grid, rowIndex, colIndex} = location;
	const width = tableWidth(
		grid.rows.map((entry) => (
		{
			children: entry.cells,
		})),
	);
	const plan = planCellMove(
		direction,
		{
			row: rowIndex,
			col: colIndex,
			rowCount: grid.rows.length,
			width,
		},
	);
	if (plan === null)
	{
		return false;
	}
	await deps.batch(() =>
	{
		if (plan.kind === "row")
		{
			const entry = grid.rows[plan.from];
			if (entry !== undefined)
			{
				deps.move(entry.row.id, grid.table.id, plan.to);
			}
			return;
		}
		for (const entry of grid.rows)
		{
			const cell = entry.cells[plan.from];
			if (cell !== undefined)
			{
				deps.move(cell.id, entry.row.id, plan.to);
			}
		}
	});
	return true;
}
