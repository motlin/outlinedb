import {resolveLayoutMode} from "./components/layout-mode.js";

/** Upstream `WF.Board.is`: the node's layout renders as a board. */
export function isBoard(layoutMode: string | null | undefined): boolean
{
	return resolveLayoutMode(layoutMode).projectClasses.includes("board");
}

export type BoardRole = "column" | "card" | "inner";

/** `ancestors` is nearest-first: a board parent makes a column, a board grandparent a card, deeper an inner row. */
export function boardRole(
	ancestors: readonly
	{
		layoutMode: string | null;
	}[],
): BoardRole | null
{
	const depth = ancestors.findIndex((ancestor) => isBoard(ancestor.layoutMode));
	if (depth === -1)
	{
		return null;
	}
	return depth === 0 ? "column" : depth === 1 ? "card" : "inner";
}

const DEFAULT_COLUMN_WIDTH = 320;
export const MIN_COLUMN_WIDTH = 180;

export interface WidthStorage
{
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
}

const widthKey = (columnId: string) => `board.width.${columnId}`;

/** Local-only column width (the public API does not return `metadata.board.width`). */
export function columnWidth(columnId: string, storage: Pick<WidthStorage, "getItem">): number
{
	try
	{
		const stored = Number(storage.getItem(widthKey(columnId)));
		return Number.isFinite(stored) && stored > 0 ? Math.max(MIN_COLUMN_WIDTH, stored) : DEFAULT_COLUMN_WIDTH;
	}
	catch
	{
		return DEFAULT_COLUMN_WIDTH;
	}
}

export function saveColumnWidth(columnId: string, width: number, storage: Pick<WidthStorage, "setItem">): void
{
	try
	{
		storage.setItem(widthKey(columnId), String(width));
	}
	catch
	{
		// Storage can be blocked; the width then lasts only for this render.
	}
}

export function nextWidth(initial: number, dx: number, min: number): number
{
	return Math.max(min, initial + dx);
}

export interface InsertColumnSubject
{
	role: "board" | "column" | "card";
	id: string;
	parentId: string;
	grandparentId: string;
	index: number;
	parentIndex: number;
	childCount: number;
}

/** Where `insert_board_column_left/right` creates the new column. */
export function insertColumnTarget(
	kind: "left" | "right",
	subject: InsertColumnSubject,
):
{
	parentId: string;
	index: number;
}
{
	const right = kind === "right";
	if (subject.role === "board")
	{
		return {
			parentId: subject.id,
			index: right ? subject.childCount : 0,
		};
	}
	if (subject.role === "column")
	{
		return {
			parentId: subject.parentId,
			index: subject.index + (right ? 1 : 0),
		};
	}
	return {
		parentId: subject.grandparentId,
		index: subject.parentIndex + (right ? 1 : 0),
	};
}

export interface InlineBleedInput
{
	innerWidth: number;
	leftBarOffset: number;
	scrollbar: number;
	pageLeft: number;
	pagePadLeft: number;
	depth: number;
}

/** Upstream `AC` inline branch: the strip spans the viewport, shifted left past the page and nesting indent. */
export function inlineBoardBleed(input: InlineBleedInput):
{
	width: number;
	left: number;
	paddingLeft: number;
}
{
	const left = -(input.pageLeft + input.pagePadLeft) - (input.depth - 1) * 36;
	return {
		width: input.innerWidth - input.leftBarOffset - input.scrollbar,
		left,
		paddingLeft: 10 + Math.abs(left),
	};
}

export type ColumnSearchMode = "matches" | "collapsed" | "empty";

/** Upstream `potentially_visible.board_columns`: every column stays; unmatched ones collapse. */
export function boardColumnsVisibleInSearch(
	columns: readonly
	{
		id: string;
		childCount: number;
	}[],
	matchesById: Readonly<Record<string, boolean>>,
):
{
	id: string;
	mode: ColumnSearchMode;
}[]
{
	return columns.map((column) => (
	{
		id: column.id,
		mode: matchesById[column.id] === true ? "matches" : column.childCount === 0 ? "empty" : "collapsed",
	}));
}

/** What the insert-column commands read about the tree. */
export interface BoardTreeReader
{
	node: (id: string) =>
		|
		  {
				parent_id: string | null;
				layoutMode: string | null;
		  }
		| undefined;
	childIds: (parentId: string) => readonly string[];
	/** Upstream `Board.is`: the node is a board that renders (not nested in another complex layout). */
	renders: (id: string) => boolean;
}

/** The board, column or card the item is, with the positions `insertColumnTarget` needs; null for a plain row. */
export function insertColumnSubject(itemId: string, tree: BoardTreeReader): InsertColumnSubject | null
{
	const item = tree.node(itemId);
	if (item === undefined)
	{
		return null;
	}
	const parentId = item.parent_id;
	const parent = parentId === null ? undefined : tree.node(parentId);
	const grandparentId = parent?.parent_id ?? null;
	const grandparent = grandparentId === null ? undefined : tree.node(grandparentId);
	const childCount = tree.childIds(itemId).length;
	if (isBoard(item.layoutMode) && tree.renders(itemId))
	{
		return {
			role: "board",
			id: itemId,
			parentId: parentId ?? "",
			grandparentId: "",
			index: 0,
			parentIndex: 0,
			childCount,
		};
	}
	if (parentId !== null && parent !== undefined && isBoard(parent.layoutMode) && tree.renders(parentId))
	{
		return {
			role: "column",
			id: itemId,
			parentId,
			grandparentId: grandparentId ?? "",
			index: tree.childIds(parentId).indexOf(itemId),
			parentIndex: 0,
			childCount,
		};
	}
	if (
		parentId !== null &&
		grandparentId !== null &&
		grandparent !== undefined &&
		isBoard(grandparent.layoutMode) &&
		tree.renders(grandparentId)
	)
	{
		return {
			role: "card",
			id: itemId,
			parentId,
			grandparentId,
			index: tree.childIds(parentId).indexOf(itemId),
			parentIndex: tree.childIds(grandparentId).indexOf(parentId),
			childCount,
		};
	}
	return null;
}

/** Enter's row role: a child of a renderable board is a column, a child of a renderable dashboard is a card. */
export function rowEnterRole(parent: {
	parentRendersBoard: boolean;
	parentRendersDashboard: boolean;
}): "column" | "card" | null
{
	return parent.parentRendersBoard ? "column" : parent.parentRendersDashboard ? "card" : null;
}
