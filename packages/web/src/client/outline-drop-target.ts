// Upstream's drop finder (`XL4` + `Tt2`): from the row just above the drag ghost
// and the pointer x, pick the parent and index a dropped row lands at.

export const PROJECT_INDENT_WIDTH = 36;

const INDENT_THRESHOLD = 0.7 * PROJECT_INDENT_WIDTH;

export interface DropRows
{
	/** The row's `.project` left edge in px. */
	left(id: string): number;
	parentOf(id: string): string | null;
	/** Index among ALL of the parent's children, moving rows included. */
	indexOf(id: string): number;
	isRendered(id: string): boolean;
	nextInDocument(id: string): string | null;
	previousInDocument(id: string): string | null;
	isCollapsed(id: string): boolean;
	isDescendantOf(id: string, ancestorId: string): boolean;
}

export interface DropTargetInput
{
	readonly x: number;
	readonly rows: DropRows;
	readonly predecessorId: string | null;
	readonly movingIds: ReadonlySet<string>;
	readonly zoomRootId: string;
	/** Upstream's `can_move_under`: false refuses a drop whose parent is `parentId`. */
	readonly canMoveUnder?: (parentId: string) => boolean;
}

export interface DropTarget
{
	readonly parentId: string;
	readonly index: number;
	/** The parent is collapsed, so the drop index falls back to the parent's default insert position. */
	readonly ambiguous: boolean;
}

export function resolveDropTarget({
	x,
	rows,
	predecessorId,
	movingIds,
	zoomRootId,
	canMoveUnder,
}: DropTargetInput): DropTarget | null
{
	if (predecessorId === null)
	{
		return null;
	}
	const isMovingOrInside = (id: string): boolean =>
		movingIds.has(id) || [...movingIds].some((movingId) => rows.isDescendantOf(id, movingId));
	// Hovering inside the dragged subtree is never a valid target.
	if (!movingIds.has(predecessorId) && isMovingOrInside(predecessorId))
	{
		return null;
	}
	const skipped = (id: string): boolean => !rows.isRendered(id) || isMovingOrInside(id);

	let pred: string | null = predecessorId;
	while (pred !== null && pred !== zoomRootId && skipped(pred))
	{
		pred = rows.previousInDocument(pred);
	}

	let succ = rows.nextInDocument(predecessorId);
	while (succ !== null && skipped(succ))
	{
		succ = rows.nextInDocument(succ);
	}

	const target = findTarget(x, pred, succ, rows, zoomRootId);
	if (target === null || isMovingOrInside(target.parentId) || canMoveUnder?.(target.parentId) === false)
	{
		return null;
	}
	return {
		...target,
		ambiguous: rows.isCollapsed(target.parentId),
	};
}

function findTarget(
	x: number,
	pred: string | null,
	succ: string | null,
	rows: DropRows,
	zoomRootId: string,
): Omit<DropTarget, "ambiguous"> | null
{
	let index = 0;
	if (pred === null)
	{
		if (succ === null)
		{
			return null;
		}
		const parentId = rows.parentOf(succ);
		return parentId === null
			? null
			:
				{
					parentId,
					index: rows.indexOf(succ),
				};
	}
	for (let current: string | null = pred; current !== null; current = rows.parentOf(current))
	{
		if (current === zoomRootId)
		{
			return {
				parentId: current,
				index,
			};
		}
		const left = rows.left(current);
		if (x > left + INDENT_THRESHOLD)
		{
			return {
				parentId: current,
				index,
			};
		}
		// Can't move past the successor: a deeper successor is this row's visible child.
		if (succ !== null && rows.left(succ) > left)
		{
			return {
				parentId: current,
				index,
			};
		}
		index = rows.indexOf(current) + 1;
	}
	return null;
}
