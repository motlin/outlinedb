import {CALENDAR_LEVELS, navTooltips, nextOf, prevOf} from "@outlinedb/shared";
import type {CalendarLevel} from "@outlinedb/shared";
import {MOVE_VERB, moveToastText} from "./move-to.js";
import type {MoveToToast} from "./move-to.js";
import type {CalendarTarget} from "./today.js";
import type {BlockMove} from "./tree-ops.js";

/** Upstream's strip levels: the calendar levels a page can be. */
export type StripLevel = CalendarLevel;

/** Upstream drag-to-scroll starts after this many pixels of horizontal movement. */
const DRAG_THRESHOLD = 4;

/** The local date a `YYYYMMDD` (day or week) / `YYYYMM00` / `YYYY0000` calendar dateId starts on. */
export function calendarPageDate(pageDateId: number): Date {
	const month = Math.floor(pageDateId / 100) % 100;
	return new Date(Math.floor(pageDateId / 10_000), Math.max(month, 1) - 1, Math.max(pageDateId % 100, 1));
}

/** A zoomed node's strip page: its level and first day, or null when it is no day, week, month or year page. */
export function stripPage(
	calendar: {level: string | null; dateId: number | null} | null | undefined,
): {level: StripLevel; date: Date} | null {
	const level = CALENDAR_LEVELS.find((candidate) => candidate === calendar?.level);
	const pageDateId = calendar?.dateId ?? null;
	return level === undefined || pageDateId === null ? null : {level, date: calendarPageDate(pageDateId)};
}

export interface StripArrow {
	tooltip: string;
	target: CalendarTarget;
}

/** The arrows' tooltips (upstream's Today / Yesterday / Tomorrow rules) and the adjacent page at the zoomed level. */
export function stripNav(
	level: StripLevel,
	date: Date,
	now: Date,
	weekStartDay: number,
): {prev: StripArrow; next: StripArrow} {
	const [prevTooltip, nextTooltip] = navTooltips(level, date, now, weekStartDay);
	return {
		prev: {tooltip: prevTooltip, target: {date: prevOf(level, date), level}},
		next: {tooltip: nextTooltip, target: {date: nextOf(level, date), level}},
	};
}

/** A month cell: that month node on month and year pages (`stopAt:"month"`, no child), else its first day's page. */
export function monthCellTarget(level: StripLevel, month: Date): CalendarTarget {
	return level === "day" ? {date: month} : {date: month, level: "month", createChild: false};
}

/**
 * Upstream's strip scroll on mount (`wS2`'s layout effects): a day, week or month page scrolls its own first-day cell
 * to the left edge (home without one), while a year page scrolls home and then to today's cell when the strip has
 * one. Upstream's remembered month-click offset (`u21`) is always overridden by these on mount, so a year page's Sep
 * click lands on Sep 1, not on the day under the clicked card.
 */
export function scrollStripOnMount(
	scroller: ScrollGeometry & {scrollLeft: number},
	{level, pageTs, todayTs}: {level: StripLevel; pageTs: number; todayTs: number},
): void {
	const pageDelta = level === "year" ? null : scrollDelta(scroller, pageTs);
	if (pageDelta !== null) {
		scroller.scrollLeft += pageDelta;
		return;
	}
	scroller.scrollLeft = 0;
	const todayDelta = level === "year" ? scrollDelta(scroller, todayTs) : null;
	if (todayDelta !== null) {
		scroller.scrollLeft += todayDelta;
	}
}

interface ScrollGeometry {
	getBoundingClientRect: () => {left: number};
	querySelector: (selector: string) => {getBoundingClientRect: () => {left: number}} | null;
}

/** How far to scroll so the `[data-ts]` cell sits at the scroller's left edge, or null without one. */
export function scrollDelta(scroller: ScrollGeometry, ts: number): number | null {
	const cell = scroller.querySelector(`[data-ts="${ts}"]`);
	return cell === null ? null : cell.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
}

/** Swallow the click that ends a drag, so no cell navigates. */
function swallowClick(event: Event): void {
	event.stopPropagation();
	event.preventDefault();
}

function mouseX(event: Event): number {
	return "clientX" in event && typeof event.clientX === "number" ? event.clientX : 0;
}

function mouseButton(event: Event): number {
	return "button" in event && typeof event.button === "number" ? event.button : -1;
}

interface DragScroller extends EventTarget {
	scrollLeft: number;
	style: {cursor: string};
}

/**
 * Upstream's popover outside-click dismissal: a pointerdown on any target that `inside` rejects calls `dismiss`. It listens in the
 * capture phase so handlers that stop propagation cannot keep the popup open. Returns the detach function.
 */
export function attachOutsideDismiss(
	doc: EventTarget,
	inside: (target: EventTarget | null) => boolean,
	dismiss: () => void,
): () => void {
	const onDown = (event: Event) => {
		if (!inside(event.target)) {
			dismiss();
		}
	};
	doc.addEventListener("pointerdown", onDown, {capture: true});
	return () => {
		doc.removeEventListener("pointerdown", onDown, {capture: true});
	};
}

/**
 * Upstream's mouse drag-to-scroll: a left-button drag past 4px scrolls the
 * strip with `cursor: grabbing`, and the click that ends it is swallowed so no
 * cell navigates. Returns the cleanup.
 */
export function attachDragScroll(scroller: DragScroller, doc: EventTarget): () => void {
	let down = false;
	let dragging = false;
	let startX = 0;
	let startScroll = 0;
	const onDown = (event: Event) => {
		if (mouseButton(event) === 0) {
			down = true;
			dragging = false;
			startX = mouseX(event);
			startScroll = scroller.scrollLeft;
		}
	};
	const onMove = (event: Event) => {
		if (!down) {
			return;
		}
		const dx = mouseX(event) - startX;
		if (!dragging && Math.abs(dx) > DRAG_THRESHOLD) {
			dragging = true;
		}
		if (dragging) {
			scroller.scrollLeft = startScroll - dx;
			scroller.style.cursor = "grabbing";
		}
	};
	const onUp = () => {
		if (dragging) {
			scroller.addEventListener("click", swallowClick, {capture: true, once: true});
		}
		down = false;
		dragging = false;
		scroller.style.cursor = "";
	};
	scroller.addEventListener("mousedown", onDown);
	doc.addEventListener("mousemove", onMove);
	doc.addEventListener("mouseup", onUp);
	return () => {
		scroller.removeEventListener("mousedown", onDown);
		doc.removeEventListener("mousemove", onMove);
		doc.removeEventListener("mouseup", onUp);
	};
}

/** Upstream autoscrolls the strip while a drag's pointer is within this many pixels of either edge. */
const DROP_AUTOSCROLL_ZONE = 80;
const DROP_AUTOSCROLL_MIN = 2;
const DROP_AUTOSCROLL_RANGE = 8;
const STRIP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MOVE_TOAST_TIMEOUT = 5000;

/**
 * Upstream's strip autoscroll during an item drag, in px per frame: `2 + min(1, depth/80) * 8` toward the edge
 * the pointer is within 80px of (negative is left), else 0.
 */
export function stripAutoscrollSpeed(clientX: number, rect: {left: number; right: number}): number {
	const speed = (inset: number) =>
		DROP_AUTOSCROLL_MIN +
		Math.min(1, (DROP_AUTOSCROLL_ZONE - inset) / DROP_AUTOSCROLL_ZONE) * DROP_AUTOSCROLL_RANGE;
	const fromLeft = clientX - rect.left;
	const fromRight = rect.right - clientX;
	if (fromLeft < DROP_AUTOSCROLL_ZONE) {
		return -speed(fromLeft);
	}
	return fromRight < DROP_AUTOSCROLL_ZONE ? speed(fromRight) : 0;
}

/** A strip card items can be dropped on: a day card (the Today card too) or a month card, by its `data-ts`. */
export interface StripDropCell {
	kind: "day" | "month";
	ts: number;
}

/** The element attribute marking a strip card as a drop target; its value is the cell kind. */
const STRIP_DROP_ATTRIBUTE = "data-strip-drop";
/** The event a bullet drag dispatches on the strip card it was released over. */
export const STRIP_DROP_EVENT = "calendar-strip-drop";

export interface StripDropDetail {
	itemIds: readonly string[];
	cell: StripDropCell;
}

/** The store key of a hovered strip card, unique across day and month cells that share a timestamp. */
export function stripDropKey(cell: StripDropCell): string {
	return `${cell.kind}:${cell.ts}`;
}

/** The strip card at or around `element`, or null when it is not one. */
export function stripDropCellOf(element: Element): {card: Element; cell: StripDropCell} | null {
	const card = element.closest(`[${STRIP_DROP_ATTRIBUTE}]`);
	const ts = Number(card?.closest("[data-ts]")?.getAttribute("data-ts") ?? Number.NaN);
	const kind = card?.getAttribute(STRIP_DROP_ATTRIBUTE);
	if (card === null || Number.isNaN(ts) || (kind !== "day" && kind !== "month")) {
		return null;
	}
	return {card, cell: {kind, ts}};
}

/** Upstream's drop page: a day card's day; a month card's month node on month and year pages, else its 1st day. */
export function stripDropTarget(level: StripLevel, cell: StripDropCell): CalendarTarget {
	const date = new Date(cell.ts);
	return {date, level: cell.kind === "month" && level !== "day" ? "month" : "day", createChild: false};
}

/**
 * Upstream's strip drop (`C9(date, {createChild:false}).moveUnder(items)`): find or create the dropped-on page,
 * clear the selection, move the items to its end as one block, and toast `Moved to '<day>'` (or `Moved to Oct 2026`
 * for a month) with View and Undo. Returns whether the items moved.
 */
export async function runStripDrop({
	items,
	level,
	cell,
	dayName,
	ensure,
	clearSelection,
	moveNodes,
	showToast,
	view,
	undo,
}: {
	/** The dragged item ids in document order. */
	items: readonly string[];
	level: StripLevel;
	cell: StripDropCell;
	/** A day's name as its page title shows it (the account date format). */
	dayName: (date: Date) => string;
	/** Find or create the page; null when it cannot. */
	ensure: (target: CalendarTarget) => Promise<{id: string; childCount: number} | null>;
	clearSelection: () => void;
	moveNodes: (moves: BlockMove[]) => void;
	showToast: (toast: MoveToToast) => void;
	view: (id: string) => void;
	undo: () => void;
}): Promise<boolean> {
	const target = stripDropTarget(level, cell);
	const {date} = target;
	const page = await ensure(target);
	if (page === null) {
		return false;
	}
	const text =
		target.level === "month"
			? `Moved to ${STRIP_MONTHS[date.getMonth()]} ${date.getFullYear()}`
			: moveToastText("ok", MOVE_VERB, dayName(date));
	if (items.includes(page.id)) {
		showToast({
			text: moveToastText("cant", MOVE_VERB, dayName(date)),
			timeout: MOVE_TOAST_TIMEOUT,
			actions: [],
			type: "failure",
		});
		return false;
	}
	clearSelection();
	moveNodes([{ids: [...items], parentId: page.id, index: page.childCount}]);
	showToast({
		text,
		timeout: MOVE_TOAST_TIMEOUT,
		actions: [
			{
				label: "View",
				shortcut: "shift+return",
				run: () => {
					view(page.id);
				},
			},
			{label: "Undo", run: undo},
		],
	});
	return true;
}

/**
 * Upstream's strip autoscroll during an item drag: while `isDragging()` and the pointer is over the strip's rows
 * near an edge, a rAF loop scrolls it at `stripAutoscrollSpeed`. Returns the cleanup.
 */
export function attachDropAutoscroll(scroller: HTMLElement, isDragging: () => boolean): () => void {
	let pointer: {x: number; y: number} | null = null;
	let frame: number | null = null;
	const speed = () => {
		if (pointer === null || !isDragging()) {
			return 0;
		}
		const rect = scroller.getBoundingClientRect();
		return pointer.y < rect.top || pointer.y > rect.bottom ? 0 : stripAutoscrollSpeed(pointer.x, rect);
	};
	const tick = () => {
		const current = speed();
		if (current === 0) {
			frame = null;
			return;
		}
		scroller.scrollLeft += current;
		frame = requestAnimationFrame(tick);
	};
	const onMove = (event: MouseEvent) => {
		pointer = {x: event.clientX, y: event.clientY};
		if (frame === null && speed() !== 0) {
			frame = requestAnimationFrame(tick);
		}
	};
	globalThis.addEventListener("mousemove", onMove, true);
	return () => {
		globalThis.removeEventListener("mousemove", onMove, true);
		if (frame !== null) {
			cancelAnimationFrame(frame);
		}
	};
}
