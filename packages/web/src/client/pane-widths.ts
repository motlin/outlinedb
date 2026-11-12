/**
 * Upstream's pane workspace width maths (`Nn2`: `available`, `minimum`, `normalize`, `resolve`, `beginResize`,
 * `resizeDivider`, `finishResize`). Widths are pixels, listed in workspace order with the main pane first. Each pane
 * renders at `width: <px>; min-width: 350px`, and the workspace scrolls sideways once the widths outgrow it.
 */

/** Upstream `Nn2.min`: no pane gets narrower than this. */
export const MIN_PANE_WIDTH = 350;

/** Upstream's `t.width < 530`: a pane narrower than this moves every header action with a menu row into its kebab. */
export const NARROW_PANE_WIDTH = 530;
/** Upstream `Nn2.gutter`: the margin to the right of the workspace. */
export const PANE_GUTTER = 8;
/** Upstream `Nn2.normalize`'s fallback for a pane with no usable width. */
export const DEFAULT_PANE_WIDTH = 380;

/** Upstream `Nn2.normalize`: a finite width floored at the minimum, else the 380px fallback. */
export function paneWidth(width: unknown): number
{
	return typeof width === "number" && Number.isFinite(width) ? Math.max(MIN_PANE_WIDTH, width) : DEFAULT_PANE_WIDTH;
}

/** Upstream `Nn2.available`: the measured workspace width, else the window beside the left bar and the gutter. */
export function availablePaneWidth(workspaceWidth: number | null, innerWidth: number, leftOffset: number): number
{
	return workspaceWidth ?? Math.max(0, innerWidth - leftOffset - PANE_GUTTER);
}

function sumExcept(widths: readonly number[], skip: number): number
{
	return widths.reduce((sum, width, index) => (index === skip ? sum : sum + width), 0);
}

/** Upstream `Nn2.minimum`: 350, except the last pane, which must leave the others plus itself filling the workspace. */
export function minimumPaneWidth(widths: readonly number[], index: number, available: number): number
{
	if (index !== widths.length - 1)
	{
		return MIN_PANE_WIDTH;
	}
	return Math.max(MIN_PANE_WIDTH, available - sumExcept(widths, index));
}

/**
 * Upstream `Nn2.resolve`: size the panes in `newIndexes` (an equal share of `available` each) and keep the others,
 * unless together they leave the workspace unfilled or `fitWorkspace` asks for a refit. Then every pane is scaled in
 * proportion, smallest first, so the row fills `available`. Each width stays at or above the minimum.
 */
export function resolveWidths(
	widths: readonly number[],
	newIndexes: readonly number[],
	available: number,
	fitWorkspace: boolean,
): number[]
{
	if (widths.length === 0)
	{
		return [];
	}
	const next = [...widths];
	const fresh = new Set(newIndexes);
	const share = available / next.length;
	const allNew = next.every((_width, index) => fresh.has(index));
	for (const index of fresh)
	{
		if (index >= 0 && index < next.length)
		{
			next[index] = paneWidth(share);
		}
	}
	const unfilled = next.reduce((sum, width) => sum + width, 0) < available;
	if (!allNew && !unfilled && !fitWorkspace)
	{
		return next;
	}
	const scaled = [...next];
	let remaining = available;
	let total = next.reduce((sum, width) => sum + width, 0);
	const smallestFirst = next.map((_width, index) => index).toSorted((a, b) => (next[a] ?? 0) - (next[b] ?? 0));
	for (const index of smallestFirst)
	{
		const width = next[index] ?? 0;
		const resolved = paneWidth((remaining * width) / total);
		remaining -= resolved;
		total -= width;
		scaled[index] = resolved;
	}
	return scaled;
}

/** What a divider resize remembers from its start (upstream `state.resize`): the pane and its right neighbour. */
export interface DividerResize
{
	index: number;
	width: number;
	rightWidth: number | null;
}

/** Upstream `Nn2.beginResize`; null for a pane that is not in the workspace. */
export function beginDividerResize(widths: readonly number[], index: number): DividerResize | null
{
	const width = widths[index];
	if (width === undefined)
	{
		return null;
	}
	return {
		index,
		width,
		rightWidth: widths[index + 1] ?? null,
	};
}

/**
 * Upstream `Nn2.resizeDivider`: the pane's width is its start width plus `delta`, at least its minimum. Growing
 * changes nothing else, so the workspace overflows; shrinking lets the right neighbour grow to keep the row filling it.
 */
export function resizedDivider(
	widths: readonly number[],
	resize: DividerResize,
	delta: number,
	available: number,
): number[]
{
	const current = widths[resize.index];
	if (!Number.isFinite(delta) || current === undefined)
	{
		return [...widths];
	}
	const width = Math.max(minimumPaneWidth(widths, resize.index, available), resize.width + delta);
	const next = [...widths];
	next[resize.index] = width;
	const neighbour = widths[resize.index + 1];
	if (width - current > 0 || resize.rightWidth === null || neighbour === undefined)
	{
		return next;
	}
	next[resize.index + 1] = Math.max(neighbour, available - sumExcept(next, resize.index + 1));
	return next;
}

/** Upstream `finishResize(id, false)`: both start widths back. */
export function cancelledDivider(widths: readonly number[], resize: DividerResize): number[]
{
	const next = [...widths];
	next[resize.index] = resize.width;
	if (resize.rightWidth !== null)
	{
		next[resize.index + 1] = resize.rightWidth;
	}
	return next;
}
