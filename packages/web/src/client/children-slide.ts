/** Whether a row shows its children, and whether a search decides that. */
export interface RowExpansion
{
	expanded: boolean;
	searching: boolean;
}

/**
 * The `.children` slide for a row whose expansion changed: down on expand, up on collapse. Entering or leaving a
 * search swaps the whole outline's expansion at once and does not slide, since a slide-up keeps every collapsed
 * row's children mounted and re-rendered, which froze the tab on Back out of a broad search.
 */
export function expansionSlide(previous: RowExpansion, next: RowExpansion): "down" | "up" | null
{
	if (previous.searching !== next.searching || previous.expanded === next.expanded)
	{
		return null;
	}
	return next.expanded ? "down" : "up";
}

/** How long a slide-down waits for `.children` to mount (a first expand fetches its rows) before it is dropped. */
export const SLIDE_WAIT_MS = 1000;

/**
 * What a pending slide does with the `.children` element it has (or lacks): `run` it, `wait` for the element to
 * mount (a first expand whose children are still loading), or `drop` it (nothing to slide, a slide-up without its
 * element, or the wait ran out).
 */
export function pendingSlideAction(
	slide: "down" | "up" | null,
	hasChildrenElement: boolean,
	waitedMs: number,
): "run" | "wait" | "drop"
{
	if (slide === null)
	{
		return "drop";
	}
	if (hasChildrenElement)
	{
		return "run";
	}
	return slide === "down" && waitedMs < SLIDE_WAIT_MS ? "wait" : "drop";
}
