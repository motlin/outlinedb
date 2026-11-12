import {MAIN_PANE_ID, canPlacePane} from "./pane-ids.js";

/** Upstream `UC4`: a header drag starts once the pointer travels this far. */
export const REORDER_THRESHOLD = 4;
/** Upstream `Vw`: the edge zone, in pixels, where a header drag scrolls the workspace sideways. */
const EDGE_ZONE = 75;
/** Upstream `cZ` / `al2`: the scroll step per frame at the zone's inner and outer edges. */
const MIN_SCROLL_STEP = 2;
const MAX_SCROLL_STEP = 10;

/** Elements in a pane header that keep their own pointer handling (upstream's ignore list plus native buttons). */
const DRAG_IGNORE =
	'input, textarea, select, option, label, button, [contenteditable="true"], [role="button"], [role="menuitem"], [data-pane-drag-ignore="true"]';

interface Box
{
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}

/** A pane header's box, keyed by its pane's id (`main` for the main pane). */
export interface HeaderBox
{
	paneId: string;
	rect: Box;
}

export interface DropLine
{
	left: number;
	top: number;
	height: number;
}

/** What the workspace draws while a header drag is under way. */
export interface ReorderView
{
	title: string;
	pointerX: number;
	pointerY: number;
	dropLine: DropLine | null;
}

/**
 * Upstream's header-drag drop target: over another pane's header, the left half inserts before that pane and the right
 * half after it; the drop line sits at that header's edge. Null over the dragged pane's own header, off every header,
 * or where `canPlacePane` refuses the place.
 */
export function reorderDrop(
	state:
	{
		panes: readonly
		{
			id: string;
		}[];
	},
	paneId: string,
	headers: readonly HeaderBox[],
	x: number,
	y: number,
):
{
	insertionIndex: number;
	dropLine: DropLine;
} | null
{
	const ids = headers.map((header) => header.paneId);
	const from = ids.indexOf(paneId);
	const target = headers.find(({rect}) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
	if (from === -1 || target === undefined || target.paneId === paneId)
	{
		return null;
	}
	const {rect} = target;
	const after = x >= rect.left + rect.width / 2;
	const slot = ids.indexOf(target.paneId) + (after ? 1 : 0);
	const insertionIndex = from < slot ? slot - 1 : slot;
	return canPlacePane(state, paneId, insertionIndex)
		?
			{
				insertionIndex,
				dropLine:
				{
					left: after ? rect.right : rect.left,
					top: rect.top,
					height: rect.height,
				},
			}
		: null;
}

/**
 * Upstream's edge scroll during a header drag: within 75px of the workspace's left or right edge, and level with the
 * dragged header, scroll sideways 2-10px a frame, faster nearer the edge; else 0.
 */
export function autoScrollSpeed(x: number, y: number, workspace: Box, sourceHeader: Box): number
{
	if (x < workspace.left || x > workspace.right || y < sourceHeader.top || y > sourceHeader.bottom)
	{
		return 0;
	}
	const step = (distance: number) =>
		MIN_SCROLL_STEP + ((EDGE_ZONE - distance) / EDGE_ZONE) * (MAX_SCROLL_STEP - MIN_SCROLL_STEP);
	const fromLeft = x - workspace.left;
	const fromRight = workspace.right - x;
	if (fromLeft < EDGE_ZONE)
	{
		return -step(fromLeft);
	}
	return fromRight < EDGE_ZONE ? step(fromRight) : 0;
}

/** Upstream blocks native drag-and-drop out of a pane header, so a header drag never drags its text or links. */
function preventHeaderDragStart(event: DragEvent): void
{
	if (event.target instanceof Element && event.target.closest(".wf-pane-header") !== null)
	{
		event.preventDefault();
	}
}

export interface PaneReorderDeps
{
	getState: () =>
	{
		panes: readonly
		{
			id: string;
		}[];
	};
	/** The ghost chip's text for pane `paneId`. */
	title: (paneId: string) => string;
	movePane: (paneId: string, index: number) => void;
	/** The drag view to draw, or null once the drag ends. */
	onView: (view: ReorderView | null) => void;
}

interface Drag
{
	pointerId: number;
	paneId: string;
	title: string;
	startX: number;
	startY: number;
	sourceHeader: HTMLElement;
	active: boolean;
	insertionIndex: number | null;
	scrollSpeed: number;
	scrollFrame: number | null;
	lastEvent: PointerEvent;
	previousScrollBehavior: string;
}

/**
 * Upstream's pane header drag on workspace `workspace`: a primary mouse press on a `.wf-pane-header` (not on its
 * controls) that travels 4px drags that pane; each move tints the source header, finds the drop place and edge-scrolls
 * the workspace; release moves the pane there and swallows the click; Escape, window blur or pointercancel abort.
 * Returns the cleanup.
 */
export function bindPaneReorder(workspace: HTMLElement, deps: PaneReorderDeps): () => void
{
	let drag: Drag | null = null;
	let disposed = false;
	let suppressClick = false;
	let suppressTimer: ReturnType<typeof setTimeout> | null = null;

	const headerBoxes = (): HeaderBox[] =>
		[...workspace.querySelectorAll<HTMLElement>(".wf-pane-header")].flatMap((header) =>
		{
			const paneId = header.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
			return paneId === undefined
				? []
				: [
						{
							paneId,
							rect: header.getBoundingClientRect(),
						},
					];
		});

	const onPointerDown = (event: PointerEvent) =>
	{
		if (drag !== null || !event.isPrimary || event.pointerType === "touch" || event.button !== 0)
		{
			return;
		}
		const {target} = event;
		if (!(target instanceof Element))
		{
			return;
		}
		const header = target.closest<HTMLElement>(".wf-pane-header");
		if (header === null || !workspace.contains(header) || target.closest(DRAG_IGNORE) !== null)
		{
			return;
		}
		const paneId = header.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
		const {panes} = deps.getState();
		if (paneId === undefined || (paneId !== MAIN_PANE_ID && !panes.some((pane) => pane.id === paneId)))
		{
			return;
		}
		drag =
		{
			pointerId: event.pointerId,
			paneId,
			title: deps.title(paneId).trim() || "Untitled",
			startX: event.clientX,
			startY: event.clientY,
			sourceHeader: header,
			active: false,
			insertionIndex: null,
			scrollSpeed: 0,
			scrollFrame: null,
			lastEvent: event,
			previousScrollBehavior: workspace.style.scrollBehavior,
		};
	};

	const onPointerMove = (event: PointerEvent) =>
	{
		const current = drag;
		if (current === null || event.pointerId !== current.pointerId)
		{
			return;
		}
		current.lastEvent = event;
		if (!current.active)
		{
			if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < REORDER_THRESHOLD)
			{
				return;
			}
			current.active = true;
			current.sourceHeader.classList.add("!bg-secondary");
			workspace.style.scrollBehavior = "auto";
		}
		event.preventDefault();
		const drop = reorderDrop(deps.getState(), current.paneId, headerBoxes(), event.clientX, event.clientY);
		current.insertionIndex = drop?.insertionIndex ?? null;
		deps.onView(
			{
				title: current.title,
				pointerX: event.clientX,
				pointerY: event.clientY,
				dropLine: drop?.dropLine ?? null,
			},
		);
		current.scrollSpeed = autoScrollSpeed(
			event.clientX,
			event.clientY,
			workspace.getBoundingClientRect(),
			current.sourceHeader.getBoundingClientRect(),
		);
		if (current.scrollSpeed !== 0 && current.scrollFrame === null)
		{
			current.scrollFrame = requestAnimationFrame(() =>
			{
				current.scrollFrame = null;
				if (drag !== current || !current.active)
				{
					return;
				}
				const before = workspace.scrollLeft;
				workspace.scrollLeft += current.scrollSpeed;
				if (workspace.scrollLeft === before)
				{
					current.scrollSpeed = 0;
					return;
				}
				onPointerMove(current.lastEvent);
			});
		}
	};

	const end = (event?: PointerEvent) =>
	{
		const current = drag;
		if (current === null || (event !== undefined && event.pointerId !== current.pointerId))
		{
			return;
		}
		if (current.scrollFrame !== null)
		{
			cancelAnimationFrame(current.scrollFrame);
		}
		current.sourceHeader.classList.remove("!bg-secondary");
		workspace.style.scrollBehavior = current.previousScrollBehavior;
		drag = null;
		if (!disposed)
		{
			deps.onView(null);
		}
	};

	const onPointerUp = (event: PointerEvent) =>
	{
		const current = drag;
		if (current === null || event.pointerId !== current.pointerId)
		{
			return;
		}
		const {active, paneId, insertionIndex} = current;
		if (active)
		{
			event.preventDefault();
		}
		end(event);
		if (!active)
		{
			return;
		}
		if (insertionIndex !== null)
		{
			deps.movePane(paneId, insertionIndex);
		}
		// The click that follows the release lands on whatever is under the pointer; swallow it.
		suppressClick = true;
		if (suppressTimer !== null)
		{
			clearTimeout(suppressTimer);
		}
		suppressTimer = setTimeout(() =>
		{
			suppressClick = false;
			suppressTimer = null;
		});
	};

	const onClick = (event: MouseEvent) =>
	{
		if (suppressClick)
		{
			suppressClick = false;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
		}
	};

	const onKeyDown = (event: KeyboardEvent) =>
	{
		if (event.key === "Escape" && drag !== null)
		{
			if (drag.active)
			{
				event.preventDefault();
			}
			end();
		}
	};

	const onBlur = () =>
	{
		end();
	};
	const onPointerCancel = (event: PointerEvent) =>
	{
		end(event);
	};

	workspace.addEventListener("pointerdown", onPointerDown);
	workspace.addEventListener("click", onClick, true);
	workspace.addEventListener("dragstart", preventHeaderDragStart);
	document.addEventListener("pointermove", onPointerMove);
	document.addEventListener("pointerup", onPointerUp);
	document.addEventListener("pointercancel", onPointerCancel);
	document.addEventListener("keydown", onKeyDown, true);
	globalThis.addEventListener("blur", onBlur);
	return () =>
	{
		disposed = true;
		end();
		if (suppressTimer !== null)
		{
			clearTimeout(suppressTimer);
		}
		workspace.removeEventListener("pointerdown", onPointerDown);
		workspace.removeEventListener("click", onClick, true);
		workspace.removeEventListener("dragstart", preventHeaderDragStart);
		document.removeEventListener("pointermove", onPointerMove);
		document.removeEventListener("pointerup", onPointerUp);
		document.removeEventListener("pointercancel", onPointerCancel);
		document.removeEventListener("keydown", onKeyDown, true);
		globalThis.removeEventListener("blur", onBlur);
	};
}
