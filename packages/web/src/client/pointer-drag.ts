/**
 * Drag maths shared by mouse and touch.
 *
 * The page started out on HTML5 drag-and-drop, which never fires from a touch
 * screen -- on a phone the gesture fell through to the browser's own handling
 * and selected the row's text instead of moving it. Pointer events cover both
 * inputs, at the cost of having to decide for ourselves when a press has become
 * a drag and when to scroll the page.
 */

export interface Point
{
	x: number;
	y: number;
}

/** Below this, a press is a tap. A fingertip wobbles more than a mouse does. */
export const DRAG_THRESHOLD_PX = 6;

export function isDragGesture(from: Point, to: Point): boolean
{
	return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD_PX;
}

/** How close to an edge the pointer has to get before the page starts moving. */
const EDGE_PX = 80;
const MAX_SPEED_PX = 18;

/**
 * Pixels to scroll this frame, given where the pointer is. Without this a tier
 * holding a hundred rows cannot be dragged out of on a phone: the destination
 * is always off screen and a finger that is holding a row cannot also scroll.
 */
export function autoScrollBy(pointerY: number, viewportHeight: number): number
{
	if (pointerY < EDGE_PX)
	{
		return -Math.round(MAX_SPEED_PX * ((EDGE_PX - pointerY) / EDGE_PX));
	}
	const fromBottom = viewportHeight - pointerY;
	if (fromBottom < EDGE_PX)
	{
		return Math.round(MAX_SPEED_PX * ((EDGE_PX - fromBottom) / EDGE_PX));
	}
	return 0;
}

export interface EdgeAutoscrollInput
{
	pointerY: number;
	scrollerTop: number;
	scrollerHeight: number;
	/** Where the drag began, relative to the scroller's top. */
	startY: number;
	haveScrolled: boolean;
	mobile: boolean;
}

const EDGE_ZONE_FRACTION = 0.15;
const DESKTOP_MAX_SPEED_PX_PER_S = 1250;
const MOBILE_MAX_SPEED_PX_PER_S = 1000;

/**
 * Upstream's outline autoscroll, in px/s. Each edge zone is 15% of the scroller
 * and speed rises quadratically toward the edge. A zone only arms once the
 * pointer has moved toward it from the drag start (or once anything has
 * scrolled), so grabbing a row that already sits in a zone does not lurch.
 */
export function edgeAutoscrollSpeed(input: EdgeAutoscrollInput): number
{
	const {pointerY, scrollerTop, scrollerHeight, startY, haveScrolled, mobile} = input;
	const zone = EDGE_ZONE_FRACTION * scrollerHeight;
	const maxSpeed = mobile ? MOBILE_MAX_SPEED_PX_PER_S : DESKTOP_MAX_SPEED_PX_PER_S;
	const offset = pointerY - scrollerTop;
	const speedAt = (distance: number): number => Math.round(maxSpeed * (1 - distance / zone) ** 2);
	if (offset < zone && (haveScrolled || offset < startY))
	{
		return -speedAt(Math.max(0, offset));
	}
	const fromBottom = scrollerHeight - offset;
	if (fromBottom < zone && (haveScrolled || offset > startY))
	{
		return speedAt(Math.max(0, fromBottom));
	}
	return 0;
}

export interface AutoscrollState
{
	scrollTop: number;
	/** Signed px/s from `edgeAutoscrollSpeed`. */
	speed: number;
	/** The previous frame's time, or null when the loop just (re)started, so the first step is 0. */
	lastFrameAt: number | null;
	haveScrolled: boolean;
}

/**
 * One frame of upstream's autoscroll loop (`N92`): move by `round(speed * secondsSinceLastFrame)`, never above the
 * top. Every executed tick arms `haveScrolled`, even when the position did not change.
 */
export function stepAutoscroll(
	state: AutoscrollState,
	now: number,
):
{
	scrollTop: number;
	haveScrolled: boolean;
}
{
	const delta = state.lastFrameAt === null ? 0 : Math.round((state.speed * (now - state.lastFrameAt)) / 1000);
	return {
		scrollTop: Math.max(0, state.scrollTop + delta),
		haveScrolled: true,
	};
}

/** Upstream scrolls the nearest `.vertical-scrollable-container`, otherwise the page. */
export function scrollerOf(element: Element): Element
{
	return element.closest(".vertical-scrollable-container") ?? document.scrollingElement ?? document.documentElement;
}

/** Re-pick the scroller from the element under the pointer, reporting whether it differs from `current`. */
export function pickScroller(
	target: Element,
	current: Element,
):
{
	scroller: Element;
	changed: boolean;
}
{
	const scroller = scrollerOf(target);
	return {
		scroller,
		changed: scroller !== current,
	};
}

export interface AutoscrollScroller
{
	getScrollTop(): number;
	setScrollTop(value: number): void;
	bounds():
	{
		top: number;
		height: number;
	};
}

export interface EdgeAutoscrollerOptions
{
	scroller: AutoscrollScroller;
	startY: number;
	mobile: boolean;
	raf: (callback: (now: number) => void) => number;
	cancelRaf: (handle: number) => void;
	now: () => number;
	/** Runs after a frame moved the scroller, so the drop target can follow the content under the pointer. */
	afterScroll: () => void;
}

/** Upstream's pointer-edge autoscroll loop, with its scheduling and scroller injected. */
export function createEdgeAutoscroller(options: EdgeAutoscrollerOptions)
{
	const {startY, mobile, raf, cancelRaf, now, afterScroll} = options;
	let {scroller} = options;
	const startOffset = startY - scroller.bounds().top;
	let pointerY = startY;
	let haveScrolled = false;
	let frame: number | null = null;
	let lastFrameAt: number | null = null;

	const speed = () =>
	{
		const {top, height} = scroller.bounds();
		return edgeAutoscrollSpeed(
			{
				pointerY,
				scrollerTop: top,
				scrollerHeight: height,
				startY: startOffset,
				haveScrolled,
				mobile,
			},
		);
	};

	const stop = () =>
	{
		if (frame !== null)
		{
			cancelRaf(frame);
			frame = null;
		}
		lastFrameAt = null;
	};

	const tick = () =>
	{
		const current = speed();
		if (current === 0)
		{
			frame = null;
			lastFrameAt = null;
			return;
		}
		const time = now();
		const before = scroller.getScrollTop();
		const next = stepAutoscroll(
			{
				scrollTop: before,
				speed: current,
				lastFrameAt,
				haveScrolled,
			},
			time,
		);
		lastFrameAt = time;
		haveScrolled = next.haveScrolled;
		if (next.scrollTop !== before)
		{
			scroller.setScrollTop(next.scrollTop);
			afterScroll();
		}
		frame = raf(tick);
	};

	return {
		update(y: number, nextScroller?: AutoscrollScroller)
		{
			pointerY = y;
			if (nextScroller !== undefined)
			{
				stop();
				scroller = nextScroller;
			}
			if (frame === null && speed() !== 0)
			{
				frame = raf(tick);
			}
		},
		dispose: stop,
	};
}

export interface LadderDropTarget
{
	tier: string;
	beforeNodeId: string;
}

export function dropAtPoint(x: number, y: number, moving: Set<string>): LadderDropTarget | undefined
{
	const element = document.elementFromPoint(x, y);
	const target = element?.closest<HTMLElement>("[data-tier]");
	if (!target?.dataset.tier)
	{
		return undefined;
	}
	const zone = target.classList.contains("ladder-zone") ? target : target.nextElementSibling;
	const rows = [...(zone?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [])];
	const before = rows.find((row) =>
	{
		if (row.dataset.nodeId === undefined || moving.has(row.dataset.nodeId))
		{
			return false;
		}
		const bounds = row.getBoundingClientRect();
		return y < bounds.top + bounds.height / 2;
	});
	return {
		tier: target.dataset.tier,
		beforeNodeId: before?.dataset.nodeId ?? "",
	};
}
