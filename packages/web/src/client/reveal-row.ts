import {afterNextPaint} from "./after-paint.js";
import {rowContent} from "./caret-dom.js";

interface VerticalBox
{
	top: number;
	bottom: number;
}

export interface RevealBuffer
{
	above: number;
	below: number;
}

/** Upstream's buffers around a single moved row (`WF.Scroll.reveal` after Move up/down). */
export const MOVE_REVEAL_BUFFER: RevealBuffer =
{
	above: 116,
	below: 120,
};
/** `WF.Caret.reveal` and `WF.Scroll.fit`: only keep the row in view. */
export const FIT_REVEAL_BUFFER: RevealBuffer =
{
	above: 0,
	below: 0,
};

/**
 * How far to scroll (positive = down) to bring `row` inside `view` shrunk by the buffers, as upstream's
 * `block: "nearest"`, `scrollMode: "if-needed"`: 0 when the row already sits inside it.
 */
export function revealDelta(row: VerticalBox, view: VerticalBox, {above, below}: RevealBuffer): number
{
	if (row.top < view.top + above)
	{
		return row.top - (view.top + above);
	}
	if (row.bottom > view.bottom - below)
	{
		return row.bottom - (view.bottom - below);
	}
	return 0;
}

/** Smoothly scrolls the row's pane scroller (else the page) just enough to reveal it; a no-op for an unrendered row. */
function revealRow(nodeId: string, buffer: RevealBuffer): void
{
	const name = rowContent(nodeId)?.closest<HTMLElement>(".name");
	if (name === null || name === undefined)
	{
		return;
	}
	const rect = name.getBoundingClientRect();
	const scroller = name.closest<HTMLElement>(".scroller");
	const box =
		scroller !== null && scroller.scrollHeight > scroller.clientHeight
			? scroller.getBoundingClientRect()
			:
				{
					top: 0,
					bottom: globalThis.innerHeight,
				};
	const delta = revealDelta(rect, box, buffer);
	if (delta === 0)
	{
		return;
	}
	if (scroller !== null && scroller.scrollHeight > scroller.clientHeight)
	{
		scroller.scrollBy(
			{
				top: delta,
				behavior: "smooth",
			},
		);
	}
	else
	{
		globalThis.scrollBy(
			{
				top: delta,
				behavior: "smooth",
			},
		);
	}
}

/** `revealRow` for each row once the move has re-rendered. */
export function revealRowsAfterPaint(nodeIds: readonly string[], buffer: RevealBuffer): void
{
	void (async () =>
	{
		await afterNextPaint();
		for (const nodeId of nodeIds)
		{
			revealRow(nodeId, buffer);
		}
	})();
}
