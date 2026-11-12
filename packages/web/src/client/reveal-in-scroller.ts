interface VerticalBox
{
	top: number;
	bottom: number;
}

/** The scrollTop that brings `item` into `view` with `block: "nearest"`, leaving it unchanged when already visible. */
export function nearestScrollTop(item: VerticalBox, view: VerticalBox, scrollTop: number): number
{
	if (item.top < view.top)
	{
		return scrollTop - (view.top - item.top);
	}
	if (item.bottom > view.bottom)
	{
		return scrollTop + (item.bottom - view.bottom);
	}
	return scrollTop;
}

/**
 * Upstream MenuItem's `WF.Scroll.reveal(item, {block: "nearest", boundary: <the .scroller>})`: scroll
 * only the menu's own scroller to the item. `scrollIntoView` would also scroll the document, shifting
 * the outline rows under an open popup on every keystroke.
 */
export function revealInScroller(element: HTMLElement): void
{
	const scroller = element.closest<HTMLElement>(".scroller");
	if (scroller === null)
	{
		return;
	}
	scroller.scrollTop = nearestScrollTop(
		element.getBoundingClientRect(),
		scroller.getBoundingClientRect(),
		scroller.scrollTop,
	);
}
