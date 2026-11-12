// Reads a table's rows and cells out of the query cache, for the table commands and the cell menu.
import type {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../node-types.js";
import {readChildren, readNode} from "./node-cache.js";
import {dashboardsOn} from "./dashboard.js";
import {cachedAncestorLayouts} from "./layouts-cache.js";
import {tableRole} from "./table.js";
import type {TableRole, TableTreeNode} from "./table.js";
import {sortByPriority} from "./tree-position.js";

export function cachedTableRole(queryClient: QueryClient, nodeId: string): TableRole | null
{
	return tableRole(cachedAncestorLayouts(queryClient, nodeId).layouts, dashboardsOn());
}

export interface TableGrid
{
	table: NodeResponse;
	rows:
	{
		row: NodeResponse;
		cells: NodeResponse[];
	}[];
}

function sortedChildren(queryClient: QueryClient, parentId: string): NodeResponse[]
{
	return sortByPriority(readChildren(queryClient, parentId) ?? []);
}

/** The table's cached rows with their cells. */
export function readGrid(queryClient: QueryClient, tableId: string): TableGrid | null
{
	const table = readNode(queryClient, tableId);
	if (table === undefined)
	{
		return null;
	}
	return {
		table,
		rows: sortedChildren(queryClient, tableId).map((row) => (
		{
			row,
			cells: sortedChildren(queryClient, row.id),
		})),
	};
}

export interface CellLocation
{
	grid: TableGrid;
	rowIndex: number;
	colIndex: number;
}

/** Where a cell sits in its renderable table, or null when the node is not a table cell. */
export function locateCell(queryClient: QueryClient, cellId: string): CellLocation | null
{
	if (cachedTableRole(queryClient, cellId) !== "cell")
	{
		return null;
	}
	const cell = readNode(queryClient, cellId);
	const rowId = cell?.parent_id;
	const tableId = rowId === null || rowId === undefined ? undefined : readNode(queryClient, rowId)?.parent_id;
	if (tableId === null || tableId === undefined)
	{
		return null;
	}
	const grid = readGrid(queryClient, tableId);
	const rowIndex = grid?.rows.findIndex((entry) => entry.row.id === rowId) ?? -1;
	const colIndex = grid?.rows[rowIndex]?.cells.findIndex((entry) => entry.id === cellId) ?? -1;
	return grid === null || rowIndex < 0 || colIndex < 0
		? null
		:
			{
				grid,
				rowIndex,
				colIndex,
			};
}

function asTreeNode(node: NodeResponse, children: TableTreeNode[]): TableTreeNode
{
	return {
		id: node.id,
		name: node.name ?? "",
		note: node.note ?? "",
		table: node.table ?? null,
		children,
	};
}

/** The table as `planTableOn` / `planTableOff` read it: rows, cells, and a stand-in child for a cell with children. */
export function treeForPlan(grid: TableGrid): TableTreeNode
{
	return asTreeNode(
		grid.table,
		grid.rows.map(({row, cells}) =>
			asTreeNode(
				row,
				cells.map((cell) =>
					asTreeNode(
						cell,
						cell.hasChildren === true
							? [
									{
										id: `${cell.id}-child`,
										name: "",
										children: [],
									},
								]
							: [],
					),
				),
			),
		),
	);
}
