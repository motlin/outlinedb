/**
 * Upstream's left-bar drop targets during a bullet drag: the four-quadrant row planner (`jv4` handler `G`), the Today
 * row's move-to-top plan, and the Starred reorder's half test. Pure; the components and `useBulletDrag` feed it facts.
 */

/** A body-level 4px bar's geometry, in viewport coordinates (the bar adds the scroll offset). */
export interface LeftBarBar
{
	readonly top: number;
	readonly left: number;
	readonly width: number;
}

export interface LeftBarDropPos
{
	readonly parentId: string;
	readonly index: number;
	/** The parent is collapsed in the left bar, so the drop falls back to its default slot. */
	readonly ambiguous: boolean;
	readonly bar: LeftBarBar;
}

export interface LeftBarDropFacts
{
	readonly rowRect:
	{
		readonly top: number;
		readonly height: number;
	};
	readonly labelRect:
	{
		readonly left: number;
		readonly width: number;
	};
	readonly point:
	{
		readonly x: number;
		readonly y: number;
	};
	readonly item:
	{
		readonly id: string;
		readonly parentId: string;
		readonly index: number;
		readonly expanded: boolean;
		readonly isSearch: boolean;
	};
	/** Starred depth-0 rows accept only a drop into them. */
	readonly disableRootMoves: boolean;
	/** The previous potentially visible sibling, with its children count. */
	readonly previousSibling:
	{
		readonly id: string;
		readonly expanded: boolean;
		readonly childCount: number;
	} | null;
	readonly isValidParent: (parentId: string) => boolean;
}

const INTO_PREVIOUS_INDENT = 24;
const RIGHT_THRESHOLD = 24;
const EXPANDED_INDENT = 12;

/**
 * Where a drop over this left-bar row lands, or null when the row accepts nothing here (search rows, a depth-0 Starred
 * row's other modes, a parent inside the moving items); the caller then keeps the previous position. The half test uses
 * the viewport y, deliberately not upstream's `pageY` (which breaks when the document is scrolled).
 */
export function planLeftBarDrop({
	rowRect,
	labelRect,
	point,
	item,
	disableRootMoves,
	previousSibling,
	isValidParent,
}: LeftBarDropFacts): LeftBarDropPos | null
{
	if (item.isSearch)
	{
		return null;
	}
	const upper = point.y < rowRect.top + rowRect.height / 2;
	const right = point.x > labelRect.left + RIGHT_THRESHOLD;
	const make = (parentId: string, index: number, ambiguous: boolean, indent: number): LeftBarDropPos | null =>
		isValidParent(parentId)
			?
				{
					parentId,
					index,
					ambiguous,
					bar:
					{
						top: upper ? rowRect.top : rowRect.top + rowRect.height,
						left: labelRect.left + indent,
						width: labelRect.width - indent,
					},
				}
			: null;
	if (!upper && (item.expanded || right))
	{
		return make(item.id, 0, !item.expanded, item.expanded ? EXPANDED_INDENT : INTO_PREVIOUS_INDENT);
	}
	if (disableRootMoves)
	{
		return null;
	}
	if (!upper)
	{
		return make(item.parentId, item.index + 1, false, 0);
	}
	if (item.index !== 0 && right && previousSibling !== null && isValidParent(previousSibling.id))
	{
		return make(
			previousSibling.id,
			previousSibling.expanded ? previousSibling.childCount : 0,
			false,
			INTO_PREVIOUS_INDENT,
		);
	}
	return make(item.parentId, item.index, false, 0);
}

/** The Today row's drop: the items go to the top of today's day node; the day itself cannot move into itself. */
export function planTodayDrop(
	ids: readonly string[],
	day:
	{
		readonly id: string;
	},
):
{
	ids: readonly string[];
	parentId: string;
	index: number;
} | null
{
	return ids.includes(day.id)
		? null
		:
			{
				ids,
				parentId: day.id,
				index: 0,
			};
}

/** Upstream `B52`: the lower half of a starred row's wrapper drops after it. */
export function starDropAfter(
	rect:
	{
		readonly y: number;
		readonly height: number;
	},
	clientY: number,
): boolean
{
	return clientY - rect.y >= rect.height / 2;
}

/** Upstream's `WF.Moving.target` rect test: strict inequalities. */
export function pointInsideStrict(
	rect:
	{
		readonly left: number;
		readonly top: number;
		readonly right: number;
		readonly bottom: number;
	},
	x: number,
	y: number,
): boolean
{
	return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
}

/** Upstream dims and bolds rows by the grabbed item only: a row that is it, or inside it. */
export function rowMovingStyle(
	rowId: string,
	grabbedId: string,
	ancestorsOf: (id: string) => readonly string[],
):
{
	inside: boolean;
	dim: boolean;
}
{
	const inside = rowId === grabbedId || ancestorsOf(rowId).includes(grabbedId);
	return {
		inside,
		dim: inside,
	};
}

/** Drop validity checks every moving item: not itself and not a descendant of any. */
export function isValidLeftBarParent(
	parentId: string,
	draggingIds: readonly string[],
	ancestorsOf: (id: string) => readonly string[],
): boolean
{
	return !draggingIds.includes(parentId) && !ancestorsOf(parentId).some((id) => draggingIds.includes(id));
}

/** The Today row's `stripDropKey` in the store, which the calendar strip's channel already carries. */
export const LEFT_BAR_TODAY_KEY = "left-bar-today";

/** Upstream arms a left-bar row press once either axis moved more than 10px. */
export function leftBarDragArmed(dx: number, dy: number): boolean
{
	return Math.max(Math.abs(dx), Math.abs(dy)) > 10;
}

/** Upstream's star reorder indicator: a 4px #ccc line at the wrapper's top (upper half) or just below it (lower half). */
export function starIndicatorClass(lower: boolean): string
{
	return `ml-l absolute bg-[#ccc] rounded-2xs pointer-events-none h-xs w-full${lower ? "" : " top-0"}`;
}
