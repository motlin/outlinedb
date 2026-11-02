import {beginDividerResize, cancelledDivider, minimumPaneWidth, resizedDivider} from "./pane-widths.js";
import type {DividerResize} from "./pane-widths.js";

/** Upstream `pZ`: the edge zone, in pixels, where a divider drag scrolls the workspace sideways. */
const EDGE_ZONE = 60;
/** Upstream `pn2`: the most a drag scrolls the workspace per frame. */
const EDGE_SPEED = 12;
const KEY_STEP = 10;
const KEY_STEP_SHIFT = 50;

export interface SeparatorDeps
{
	/** The `[data-pane-scroll-container]` the panes sit in. */
	scroller: HTMLElement;
	/** Every pane's width in workspace order, main first. */
	getWidths: () => number[];
	/** Upstream `Nn2.available()`. */
	available: () => number;
	/** Store every pane's width in workspace order, main first. */
	setWidths: (widths: number[]) => void;
	/** Tell the workspace a drag is under way: it shows the trailing spacer and skips persistence. */
	setResizing: (resizing: boolean) => void;
}

interface Drag
{
	pointerId: number;
	startX: number;
	pointerX: number;
	startScrollLeft: number;
	workspaceLeft: number;
	direction: number;
	previousScrollBehavior: string;
	resize: DividerResize;
	frame: number;
}

/**
 * Upstream `om1`'s separator effect for the pane at workspace `paneIndex`: a primary-button pointer drag on the
 * separator resizes the pane (and its right neighbour, see `resizedDivider`). The drag auto-scrolls the workspace near
 * its edges, commits on pointerup, and cancels (restoring widths and scroll) on Escape, pointercancel or window blur.
 * Returns the unbind, which also cancels a drag in progress.
 */
export function bindPaneSeparator(separator: HTMLElement, paneIndex: number, deps: SeparatorDeps): () => void
{
	const {scroller} = deps;
	let drag: Drag | null = null;

	function apply(current: Drag): void
	{
		const delta =
			current.pointerX -
			current.startX +
			scroller.scrollLeft -
			current.startScrollLeft -
			(scroller.getBoundingClientRect().left - current.workspaceLeft);
		deps.setWidths(resizedDivider(deps.getWidths(), current.resize, delta, deps.available()));
	}

	function finish(commit: boolean): void
	{
		const current = drag;
		if (current === null)
		{
			return;
		}
		drag = null;
		cancelAnimationFrame(current.frame);
		if (!commit)
		{
			deps.setWidths(cancelledDivider(deps.getWidths(), current.resize));
			scroller.scrollLeft = current.startScrollLeft;
		}
		scroller.style.scrollBehavior = current.previousScrollBehavior;
		try
		{
			separator.releasePointerCapture(current.pointerId);
		}
		catch
		{
			// The capture may already be gone (the element left the document).
		}
		deps.setResizing(false);
		if (commit)
		{
			globalThis.dispatchEvent(new Event("resize"));
		}
	}

	function step(): void
	{
		const current = drag;
		if (current === null)
		{
			return;
		}
		const rect = scroller.getBoundingClientRect();
		const fromRight = rect.right - current.pointerX;
		const fromLeft = current.pointerX - rect.left;
		if (current.direction > 0 && fromRight < EDGE_ZONE)
		{
			scroller.scrollLeft += EDGE_SPEED * Math.min(1, 1 - fromRight / EDGE_ZONE);
		}
		else if (
			current.direction < 0 &&
			fromLeft < EDGE_ZONE &&
			(deps.getWidths()[paneIndex] ?? 0) > minimumPaneWidth(deps.getWidths(), paneIndex, deps.available())
		)
		{
			scroller.scrollLeft -= EDGE_SPEED * Math.min(1, 1 - fromLeft / EDGE_ZONE);
		}
		apply(current);
		current.frame = requestAnimationFrame(step);
	}

	const onPointerDown = (event: PointerEvent): void =>
	{
		if (!event.isPrimary || event.button !== 0 || drag !== null)
		{
			return;
		}
		const resize = beginDividerResize(deps.getWidths(), paneIndex);
		if (resize === null)
		{
			return;
		}
		deps.setResizing(true);
		drag =
		{
			pointerId: event.pointerId,
			startX: event.clientX,
			pointerX: event.clientX,
			startScrollLeft: scroller.scrollLeft,
			workspaceLeft: scroller.getBoundingClientRect().left,
			direction: 0,
			previousScrollBehavior: scroller.style.scrollBehavior,
			resize,
			frame: 0,
		};
		scroller.style.scrollBehavior = "auto";
		separator.setPointerCapture(event.pointerId);
		separator.focus(
			{
				preventScroll: true,
			},
		);
		drag.frame = requestAnimationFrame(step);
		event.preventDefault();
		event.stopPropagation();
	};
	const onPointerMove = (event: PointerEvent): void =>
	{
		if (drag === null || event.pointerId !== drag.pointerId)
		{
			return;
		}
		drag.direction = Math.sign(event.clientX - drag.pointerX) || drag.direction;
		drag.pointerX = event.clientX;
		apply(drag);
	};
	const onPointerUp = (event: PointerEvent): void =>
	{
		if (drag === null || event.pointerId !== drag.pointerId)
		{
			return;
		}
		drag.pointerX = event.clientX;
		apply(drag);
		finish(true);
	};
	const onPointerCancel = (event: PointerEvent): void =>
	{
		if (drag !== null && event.pointerId === drag.pointerId)
		{
			finish(false);
		}
	};
	const onKeyDown = (event: KeyboardEvent): void =>
	{
		if (drag !== null && event.key === "Escape")
		{
			event.preventDefault();
			event.stopPropagation();
			finish(false);
		}
	};
	const onBlur = (): void =>
	{
		finish(false);
	};

	separator.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("pointermove", onPointerMove, true);
	document.addEventListener("pointerup", onPointerUp, true);
	document.addEventListener("pointercancel", onPointerCancel, true);
	document.addEventListener("keydown", onKeyDown, true);
	globalThis.addEventListener("blur", onBlur);
	return () =>
	{
		finish(false);
		separator.removeEventListener("pointerdown", onPointerDown);
		document.removeEventListener("pointermove", onPointerMove, true);
		document.removeEventListener("pointerup", onPointerUp, true);
		document.removeEventListener("pointercancel", onPointerCancel, true);
		document.removeEventListener("keydown", onKeyDown, true);
		globalThis.removeEventListener("blur", onBlur);
	};
}

export interface SeparatorKeyEvent
{
	key: string;
	shiftKey: boolean;
	preventDefault: () => void;
	stopPropagation: () => void;
	currentTarget:
	{
		scrollIntoView: (options: ScrollIntoViewOptions) => void;
	};
}

export interface SeparatorKeyDeps
{
	getWidths: () => number[];
	available: () => number;
	setWidths: (widths: number[]) => void;
}

/**
 * Upstream's separator `onKeyDown`: only ArrowLeft and ArrowRight (10px, 50px with Shift) and Home (the pane's
 * minimum) resize; they begin, apply and commit at once, then scroll the separator into view on the next frame and
 * dispatch a window `resize`. Every other key is left alone.
 */
export function handleSeparatorKey(event: SeparatorKeyEvent, paneIndex: number, deps: SeparatorKeyDeps): void
{
	if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home")
	{
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const widths = deps.getWidths();
	const resize = beginDividerResize(widths, paneIndex);
	if (resize === null)
	{
		return;
	}
	const available = deps.available();
	const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
	const delta =
		event.key === "Home"
			? minimumPaneWidth(widths, paneIndex, available) - resize.width
			: event.key === "ArrowLeft"
				? -step
				: step;
	deps.setWidths(resizedDivider(widths, resize, delta, available));
	const target = event.currentTarget;
	requestAnimationFrame(() =>
	{
		target.scrollIntoView(
			{
				block: "nearest",
				inline: "nearest",
			},
		);
	});
	globalThis.dispatchEvent(new Event("resize"));
}
