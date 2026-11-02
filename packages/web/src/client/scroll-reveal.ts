/**
 * Upstream `WF.VirtualScrolling.scrollTo`: the scroll position that puts the middle of a row in the middle of the
 * viewport, clamped to the scrollable range. `rowTop` is the row's viewport-relative top.
 */
export function centeredScrollTop({
	rowTop,
	rowHeight,
	scrollY,
	viewportHeight,
	maxScroll,
}: {
	rowTop: number;
	rowHeight: number;
	scrollY: number;
	viewportHeight: number;
	maxScroll: number;
}): number
{
	const target = scrollY + rowTop + rowHeight / 2 - viewportHeight / 2;
	return Math.min(Math.max(target, 0), maxScroll);
}

/** Scroll the page, or the row's own scroller when it scrolls, so `element` sits in the middle of the view. */
export function scrollToCenter(element: HTMLElement): void
{
	const rect = element.getBoundingClientRect();
	const scroller = element.closest<HTMLElement>(".scroller");
	if (scroller !== null && scroller.scrollHeight > scroller.clientHeight)
	{
		const box = scroller.getBoundingClientRect();
		scroller.scrollTop = centeredScrollTop(
			{
				rowTop: rect.top - box.top,
				rowHeight: rect.height,
				scrollY: scroller.scrollTop,
				viewportHeight: scroller.clientHeight,
				maxScroll: scroller.scrollHeight - scroller.clientHeight,
			},
		);
		return;
	}
	const viewportHeight = globalThis.innerHeight;
	globalThis.scrollTo(
		{
			top: centeredScrollTop(
				{
					rowTop: rect.top,
					rowHeight: rect.height,
					scrollY: globalThis.scrollY,
					viewportHeight,
					maxScroll: Math.max(document.documentElement.scrollHeight - viewportHeight, 0),
				},
			),
		},
	);
}
