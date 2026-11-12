import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useCallback} from "react";
import
{
	IDLE_BULLET_DRAG,
	buildDropRows,
	bulletDragReducer,
	copyDropEffects,
	dragActionOf,
	dragItems,
	dropBulletDrag,
	dropClearsSelection,
	dropIndicatorFor,
	ghostCloneStyle,
	hidesSourceBullet,
	hitX,
	isFoundDateRow,
	isOutsideViewport,
	rotateOrigin,
} from "../bullet-drag-state.js";
import type
{
	BulletDragAction,
	DragAction,
	BulletDragState,
	CopyPlan,
	DropPlan,
	DropTargetFacts,
} from "../bullet-drag-state.js";
import {LEFT_BAR_TODAY_KEY, leftBarDragArmed, planTodayDrop, pointInsideStrict} from "../left-bar-drop.js";
import type {LeftBarDropPos} from "../left-bar-drop.js";
import {findOrEnsureCalendarNode} from "../today.js";
import {STRIP_DROP_EVENT, stripDropCellOf, stripDropKey} from "../calendar-strip-model.js";
import type {StripDropCell, StripDropDetail} from "../calendar-strip-model.js";
import {emptySelection, selectionOf} from "../item-selection.js";
import {canMoveUnderDashboard, dashboardsOn} from "../dashboard.js";
import {cachedCanRender} from "../layouts-cache.js";
import {readChildren, readNode, removeFoundDates} from "../node-cache.js";
import {resolveDropTarget} from "../outline-drop-target.js";
import type {DropRows, DropTarget} from "../outline-drop-target.js";
import {createEdgeAutoscroller, pickScroller, scrollerOf} from "../pointer-drag.js";
import type {AutoscrollScroller} from "../pointer-drag.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {paneView, useOutlineStore} from "../stores/outline.js";
import {rowHasChildren} from "../tree-ops.js";
import {sortByPriority} from "../tree-position.js";
import {leaveEditor} from "./use-drag-select.js";
import {copyNodesAt, moveNodesNow, syncNodeChanges} from "./use-nodes.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {HOME_ROOT, currentSelectionView} from "./use-selection-keymap.js";

const GHOST_CLONE_LIMIT = 5;
/** Half the 18px bullet: the ghost's bullet starts centered on the pointer. */
const GHOST_OFFSET_PX = 9;
const ROW_BULLET = "a.bullet[data-item-id]:not(.bullet--backlink-root)";
const ROTATE_ANIMATION_MS = 400;

const SVG_NS = "http://www.w3.org/2000/svg";

function childIdsOf(queryClient: QueryClient, id: string): string[]
{
	return sortByPriority(readChildren(queryClient, id === HOME_ROOT ? null : id) ?? []).map((child) => child.id);
}

function outlineRows(
	queryClient: QueryClient,
	container: Element,
	paneId: string,
):
{
	rows: DropRows;
	zoomRootId: string;
}
{
	const {tree} = currentSelectionView(queryClient, paneId);
	const {expandedIds, showCompleted} = paneView(paneId);
	const projectOf = (id: string): Element | null =>
		id === tree.zoomRootId
			? container.querySelector(".project.root")
			: (container.querySelector(`${ROW_BULLET}[data-item-id="${CSS.escape(id)}"]`)?.closest(".project") ?? null);
	const rows = buildDropRows(
		{
			order: tree.visibleOrder,
			parentOf: (id) => tree.parentOf(id),
			childIdsOf: (id) => childIdsOf(queryClient, id),
			isCollapsed: (id) =>
			{
				const node = readNode(queryClient, id);
				return (
					id !== tree.zoomRootId &&
					!expandedIds.has(id) &&
					node !== undefined &&
					rowHasChildren(node, showCompleted)
				);
			},
			left: (id) => projectOf(id)?.getBoundingClientRect().left ?? 0,
		},
	);
	return {
		rows,
		zoomRootId: tree.zoomRootId,
	};
}

/**
 * The row whose content lies under the point, in whichever pane it renders: upstream takes the first element inside
 * a `.name` or `.notes`, or inside a `.project` but not inside its `.children`.
 */
function hitRow(
	x: number,
	y: number,
):
{
	rowId: string;
	paneId: string;
	container: Element;
	isRoot: boolean;
} | null
{
	for (const element of document.elementsFromPoint(x, y))
	{
		const project = element.closest(".project");
		if (project === null)
		{
			continue;
		}
		const children = element.closest(".children");
		const inContent = element.closest(".name, .notes") !== null;
		if (inContent || children === null || !project.contains(children))
		{
			const container = project.closest(".page, .outline-tree-container") ?? document.body;
			const paneId = project.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? MAIN_PANE_ID;
			const isRoot = project.classList.contains("root");
			const rowId = isRoot
				? ""
				: (project.querySelector(`:scope > .name > ${ROW_BULLET}`)?.getAttribute("data-item-id") ?? null);
			if (rowId !== null)
			{
				return {
					rowId,
					paneId,
					container,
					isRoot,
				};
			}
			return null;
		}
	}
	return null;
}

/** Upstream's `.pageContainer`: the span of every pane, or the whole window when no pane is open. */
function pageBounds():
{
	left: number;
	right: number;
}
{
	const panes = [...document.querySelectorAll("[data-pane-id]")];
	const first = panes[0];
	const last = panes.at(-1);
	if (first === undefined || last === undefined)
	{
		return {
			left: 0,
			right: document.documentElement.clientWidth,
		};
	}
	return {
		left: first.getBoundingClientRect().left,
		right: last.getBoundingClientRect().right,
	};
}

/** The calendar strip card under the pointer, which takes the drop instead of the outline. */
function stripCardAt(
	x: number,
	y: number,
):
{
	card: Element;
	cell: StripDropCell;
} | null
{
	for (const element of document.elementsFromPoint(x, y))
	{
		const hit = stripDropCellOf(element);
		if (hit !== null)
		{
			return hit;
		}
	}
	return null;
}

function targetFacts(queryClient: QueryClient, parentId: string, collapsed: boolean): DropTargetFacts
{
	const node = readNode(queryClient, parentId);
	const {showCompleted} = useOutlineStore.getState();
	return {
		childCount: childIdsOf(queryClient, parentId).length,
		wasLeaf: node !== undefined && !rowHasChildren(node, showCompleted),
		wasCollapsed: collapsed,
		defaultToBottom: node?.defaultToBottom === true,
	};
}

/**
 * Upstream's drop into a collapsed parent: an 18x18 bullet circle at the ghost swings half a turn around the
 * midpoint between it and the parent's bullet, then disappears.
 */
function animateUnderParent(ghostRect: DOMRect, parentId: string): void
{
	const parentBullet = document.querySelector(`${ROW_BULLET}[data-item-id="${CSS.escape(parentId)}"]`);
	if (!(parentBullet instanceof HTMLElement))
	{
		return;
	}
	const target = parentBullet.getBoundingClientRect();
	const style = getComputedStyle(parentBullet);
	const padding = (name: string): number => Number(style.getPropertyValue(name).replace("px", "")) || 0;
	const rotate = document.createElement("div");
	rotate.className = "moved-bullet-rotate";
	Object.assign(
		rotate.style,
		{
			position: "absolute",
			left: `${ghostRect.left + globalThis.scrollX}px`,
			top: `${ghostRect.top + globalThis.scrollY}px`,
			backgroundColor: style.backgroundColor,
			color: style.color,
			transformOrigin: rotateOrigin(
				{
					left: target.left,
					top: target.top,
					contentWidth: parentBullet.clientWidth - padding("padding-left") - padding("padding-right"),
					contentHeight: parentBullet.clientHeight - padding("padding-top") - padding("padding-bottom"),
				},
				ghostRect,
			),
		},
	);
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width", "18");
	svg.setAttribute("height", "18");
	svg.setAttribute("viewBox", "0 0 18 18");
	svg.setAttribute("fill", "currentColor");
	const circle = document.createElementNS(SVG_NS, "circle");
	circle.setAttribute("cx", "9");
	circle.setAttribute("cy", "9");
	circle.setAttribute("r", "3.5");
	svg.append(circle);
	rotate.append(svg);
	document.body.append(rotate);
	setTimeout(() =>
	{
		rotate.remove();
	}, ROTATE_ANIMATION_MS);
}

/**
 * Upstream's after-drop effects: expand a leaf, or keep a collapsed parent shut and flash it; flash the moved rows.
 * A drop out of Found Dates also clears the selection (`item.move-under.calendar_mirrors`).
 */
function runDropEffects(
	plan: DropPlan,
	ghostRect: DOMRect | null,
	fromFoundDates: boolean,
	parentId: string | null,
): void
{
	const {move, expandId, flashParentId, animate, flashIds} = plan;
	const {expand, flashMoving, setItemSelection} = useOutlineStore.getState();
	if (move !== null)
	{
		if (expandId !== null)
		{
			expand(expandId);
		}
		if (dropClearsSelection(plan) || fromFoundDates)
		{
			setTimeout(() =>
			{
				setItemSelection(emptySelection());
			}, 0);
		}
		if (animate && ghostRect !== null)
		{
			animateUnderParent(ghostRect, move.parentId);
		}
	}
	if (flashIds.length === 0)
	{
		return;
	}
	flashMoving(flashParentId === null ? [...flashIds] : [flashParentId, ...flashIds]);
	globalThis.dispatchEvent(
		new CustomEvent(
			"moving.end",
			{
				detail:
				{
					itemIds: flashIds,
					parentId,
				},
			},
		),
	);
}

/** Whether a row for `id` is on screen: a copy inside a collapsed parent is not. */
function isRowRendered(id: string): boolean
{
	const row = document.querySelector(`${ROW_BULLET}[data-item-id="${CSS.escape(id)}"]`)?.closest(".project");
	if (row === null || row === undefined)
	{
		return false;
	}
	const rect = row.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

/**
 * Upstream's duplicate/mirror drop (`RC4`): one undo step writes the copies at the hovered slot, then the copies take
 * the selection (a selection drag) or the caret (otherwise), and the ORIGINAL rows flash.
 */
async function runCopyDrop(queryClient: QueryClient, copy: CopyPlan, releasedParentId: string | null): Promise<void>
{
	const parentId = copy.parentId === HOME_ROOT ? null : copy.parentId;
	const store = useOutlineStore.getState();
	const newIds = await runInUndoBatch(captureOutlineView, async () =>
		copyNodesAt(queryClient, copy.kind, copy.ids, parentId, copy.index),
	).catch((error: unknown) =>
	{
		store.addErrorNotification(
			`Failed to ${copy.kind === "mirror" ? "mirror" : "duplicate"}: ${error instanceof Error ? error.message : "error"}`,
		);
		return;
	});
	if (newIds === undefined)
	{
		return;
	}
	await syncNodeChanges(queryClient);
	const effects = copyDropEffects(copy, newIds, isRowRendered);
	if (effects.select !== null)
	{
		useOutlineStore.getState().setItemSelection(selectionOf(effects.select));
	}
	else if (effects.caretId !== null)
	{
		useOutlineStore.getState().focusName(effects.caretId, 0);
	}
	useOutlineStore.getState().flashMoving([...effects.flashIds]);
	globalThis.dispatchEvent(
		new CustomEvent(
			"moving.end",
			{
				detail:
				{
					itemIds: effects.flashIds,
					parentId: releasedParentId,
				},
			},
		),
	);
}

function scrollerBounds(scroller: Element):
{
	top: number;
	height: number;
}
{
	if (scroller === document.scrollingElement || scroller === document.documentElement)
	{
		return {
			top: 0,
			height: globalThis.innerHeight,
		};
	}
	const {top, height} = scroller.getBoundingClientRect();
	return {
		top,
		height: scroller instanceof HTMLElement ? scroller.offsetHeight : height,
	};
}

function scrollerAdapter(scroller: Element): AutoscrollScroller
{
	return {
		getScrollTop: () => scroller.scrollTop,
		setScrollTop: (value) =>
		{
			scroller.scrollTop = value;
		},
		bounds: () => scrollerBounds(scroller),
	};
}

function swallowClick(clickEvent: MouseEvent): void
{
	clickEvent.preventDefault();
	clickEvent.stopPropagation();
}

/** The click a released drag fires on the rows under the pointer would put a caret there; upstream leaves focus on body. */
function swallowNextClick(): void
{
	globalThis.addEventListener(
		"click",
		swallowClick,
		{
			capture: true,
			once: true,
		},
	);
	setTimeout(() =>
	{
		globalThis.removeEventListener(
			"click",
			swallowClick,
			{
				capture: true,
			},
		);
	}, 0);
}

function makeGhost(bullet: HTMLElement, x: number, y: number, count: number): HTMLElement
{
	const ghost = document.createElement("div");
	ghost.className = "dragging";
	Object.assign(
		ghost.style,
		{
			position: "fixed",
			zIndex: "200",
			top: `${y - GHOST_OFFSET_PX}px`,
			left: `${x - GHOST_OFFSET_PX}px`,
			pointerEvents: "none",
			transform: "translate3d(0px, 0px, 0px)",
		},
	);
	for (let index = 0; index < Math.min(count, GHOST_CLONE_LIMIT); index++)
	{
		const clone = bullet.cloneNode(true);
		if (!(clone instanceof HTMLElement))
		{
			continue;
		}
		delete clone.dataset.preDragClick;
		Object.assign(clone.style, ghostCloneStyle(index));
		ghost.append(clone);
	}
	return ghost;
}

/** What one press-and-drag moves, and where the pointer's hit test is anchored. */
interface OutlineDragParams
{
	nodeId: string;
	items:
	{
		ids: readonly string[];
		home:
		{
			parentId: string;
			index: number;
		} | null;
		selection: boolean;
	};
	dragAction: DragAction;
	fromFoundDates: boolean;
	startX: number;
	startY: number;
	/** The pressed bullet (ghost source, hidden while dragging), or null for a left-bar row: no ghost, nothing hidden. */
	bullet: HTMLElement | null;
	/** The row whose top anchors the hit test, or the left-bar label rect's top when given. */
	sourceRow: Element | null;
	originTop: number | null;
	/** Armed presses ignore moves until this returns true (the left bar's 10px max-axis rule). */
	armedBy?: (dx: number, dy: number) => boolean;
	/** The element whose scroller autoscrolls first. */
	scrollFrom: Element;
}

/** The drop target a stored left-bar position stands for. */
function leftBarTargetOf(drop: LeftBarDropPos | null): DropTarget | null
{
	return drop === null
		? null
		:
			{
				parentId: drop.parentId,
				index: drop.index,
				ambiguous: drop.ambiguous,
			};
}

/** The Today row's rect, when the pointer is strictly inside it. */
function todayRowAt(x: number, y: number): boolean
{
	const row = document.querySelector("[data-left-bar-today]");
	return row !== null && pointInsideStrict(row.getBoundingClientRect(), x, y);
}

/** Upstream's Today row `accept`: the items go to the top of today's day node, with no toast or navigation. */
async function dropOnToday(queryClient: QueryClient, ids: readonly string[]): Promise<void>
{
	await runInUndoBatch(captureOutlineView, async () =>
	{
		const day = await findOrEnsureCalendarNode(
			{
				date: new Date(),
				createChild: false,
			},
			fetch,
		);
		const plan =
			day === null
				? null
				: planTodayDrop(
						ids,
						{
							id: day.dayId,
						},
					);
		if (plan !== null)
		{
			moveNodesNow(
				queryClient,
				{
					ids: [...plan.ids],
					parent_id: plan.parentId,
					index: plan.index,
				},
			);
		}
	});
	globalThis.dispatchEvent(
		new CustomEvent(
			"moving.end",
			{
				detail:
				{
					itemIds: ids,
					parentId: undefined,
				},
			},
		),
	);
}

/**
 * Upstream's mouse-driven drag machine, shared by a bullet press and a left-bar row press: a threshold arms it, each
 * move re-resolves the drop target (strip card, Today row, left-bar slot, or outline row), release moves the rows
 * through the API, and Escape cancels.
 */
function startOutlineDrag(queryClient: QueryClient, params: OutlineDragParams): void
{
	const
	{
		nodeId,
		items,
		dragAction,
		fromFoundDates,
		startX,
		startY,
		bullet,
		sourceRow,
		originTop,
		armedBy,
		scrollFrom,
	} = params;
	let state: BulletDragState = bulletDragReducer(
		IDLE_BULLET_DRAG,
		{
			type: "start",
			id: nodeId,
			x: startX,
			y: startY,
			itemIds: items.ids,
			home: items.home,
			action: dragAction,
			selection: items.selection,
		},
	);
	let ghost: HTMLElement | null = null;
	let began = false;
	let rowTop = 0;
	let pointer =
	{
		x: startX,
		y: startY,
	};
	const {setBulletDrag, setLeftBarDrop} = useOutlineStore.getState();

	let stripHit:
	{
		card: Element;
		cell: StripDropCell;
	} | null = null;
	let todayHit = false;

	const dispatch = (action: BulletDragAction) =>
	{
		state = bulletDragReducer(state, action);
		setBulletDrag(
			state.draggingIds,
			state.indicator,
			stripHit === null ? (todayHit ? LEFT_BAR_TODAY_KEY : null) : stripDropKey(stripHit.cell),
		);
	};

	const begin = () =>
	{
		began = true;
		leaveEditor();
		if (bullet !== null)
		{
			delete bullet.dataset.preDragClick;
		}
		rowTop = originTop ?? sourceRow?.getBoundingClientRect().top ?? startY;
		document.body.classList.add("moving");
		if (bullet !== null)
		{
			ghost = makeGhost(bullet, startX, startY, state.draggingIds.length);
			document.body.append(ghost);
			// A selection drag, or an Alt (duplicate) drag, leaves the source bullet visible.
			if (hidesSourceBullet(dragAction, items.selection))
			{
				bullet.style.visibility = "hidden";
			}
		}
		setBulletDrag(state.draggingIds, null);
	};

	const hover = (x: number, y: number) =>
	{
		// Upstream `WF.Moving.target`: a strip card or the Today row under the pointer itself takes the drop.
		stripHit = dragAction === "move" ? stripCardAt(x, y) : null;
		todayHit = stripHit === null && dragAction === "move" && todayRowAt(x, y);
		if (stripHit !== null || todayHit)
		{
			dispatch(
				{
					type: "hover",
					target: null,
					indicator: null,
				},
			);
			return;
		}
		// Upstream `G92`: over the left bar the last left-bar row position is the target; the outline is not hit-tested.
		const {leftBarHovered, leftBarDrop} = useOutlineStore.getState();
		if (leftBarHovered)
		{
			dispatch(
				{
					type: "hover",
					target: leftBarTargetOf(leftBarDrop),
					indicator: null,
				},
			);
			return;
		}
		const x2 = hitX(x, pageBounds());
		const hitY = rowTop + (y - startY) - 1;
		const hit = hitRow(x2, hitY);
		if (hit === null)
		{
			return;
		}
		const {rows, zoomRootId} = outlineRows(queryClient, hit.container, hit.paneId);
		const predecessorId = hit.isRoot ? zoomRootId : hit.rowId;
		const target = resolveDropTarget(
			{
				x: x2,
				rows,
				predecessorId,
				movingIds: new Set(state.draggingIds),
				zoomRootId,
				canMoveUnder: (parentId) =>
				{
					const grandparentId = readNode(queryClient, parentId)?.parent_id;
					return canMoveUnderDashboard(
						grandparentId != null && cachedCanRender(queryClient, grandparentId, "dashboard")
							? "dashboard"
							: null,
						dashboardsOn(),
					);
				},
			},
		);
		const indicator = dropIndicatorFor(
			target,
			target === null ? [] : childIdsOf(queryClient, target.parentId),
			hit.paneId,
		);
		dispatch(
			{
				type: "hover",
				target,
				indicator,
			},
		);
	};

	const onMove = (moveEvent: MouseEvent) =>
	{
		if (state.phase === "armed" && armedBy !== undefined)
		{
			// Upstream: once pressed, each move is preventDefaulted, but nothing starts until the threshold.
			moveEvent.preventDefault();
			if (!armedBy(moveEvent.clientX - startX, moveEvent.clientY - startY))
			{
				return;
			}
		}
		const wasDragging = state.phase === "dragging";
		state = bulletDragReducer(
			state,
			{
				type: "move",
				x: moveEvent.clientX,
				y: moveEvent.clientY,
			},
		);
		if (state.phase !== "dragging")
		{
			return;
		}
		if (!wasDragging)
		{
			begin();
		}
		if (ghost !== null)
		{
			ghost.style.transform = state.ghostTransform ?? "";
		}
		pointer =
		{
			x: moveEvent.clientX,
			y: moveEvent.clientY,
		};
		if (
			isOutsideViewport(
				pointer,
				{
					width: globalThis.innerWidth,
					height: globalThis.innerHeight,
				},
			)
		)
		{
			dispatch(
				{
					type: "leave",
				},
			);
		}
		else
		{
			hover(pointer.x, pointer.y);
		}
		const picked = pickScroller(
			moveEvent.target instanceof Element ? moveEvent.target : scrollFrom,
			currentScroller,
		);
		if (picked.changed)
		{
			currentScroller = picked.scroller;
			autoscroll.update(pointer.y, scrollerAdapter(currentScroller));
		}
		else
		{
			autoscroll.update(pointer.y);
		}
	};

	let currentScroller = scrollerOf(scrollFrom);
	const autoscroll = createEdgeAutoscroller(
		{
			scroller: scrollerAdapter(currentScroller),
			startY,
			mobile: document.body.classList.contains("is-mobile"),
			raf: (callback) => requestAnimationFrame(callback),
			cancelRaf: (handle) =>
			{
				cancelAnimationFrame(handle);
			},
			now: () => performance.now(),
			afterScroll: () =>
			{
				hover(pointer.x, pointer.y);
			},
		},
	);

	// Upstream's window mouseleave keeps autoscrolling from the exit point and only clears the indicator.
	const onLeaveWindow = (outEvent: MouseEvent) =>
	{
		if (outEvent.relatedTarget === null && state.phase === "dragging")
		{
			pointer =
			{
				x: outEvent.clientX,
				y: outEvent.clientY,
			};
			autoscroll.update(pointer.y);
			dispatch(
				{
					type: "leave",
				},
			);
		}
	};

	const finish = () =>
	{
		globalThis.removeEventListener("mousemove", onMove, true);
		globalThis.removeEventListener("mouseup", onUp, true);
		globalThis.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("mouseout", onLeaveWindow, true);
		autoscroll.dispose();
		if (began)
		{
			ghost?.remove();
			if (bullet !== null)
			{
				bullet.style.visibility = "";
			}
			document.body.classList.remove("moving");
		}
		setBulletDrag([], null);
		setLeftBarDrop(null);
	};

	const onUp = () =>
	{
		let overLeftBar = false;
		if (state.phase === "dragging")
		{
			// The strip or Today row may have autoscrolled under a still pointer.
			stripHit = dragAction === "move" ? stripCardAt(pointer.x, pointer.y) : null;
			todayHit = stripHit === null && dragAction === "move" && todayRowAt(pointer.x, pointer.y);
			const {leftBarHovered, leftBarDrop} = useOutlineStore.getState();
			overLeftBar = leftBarHovered && stripHit === null && !todayHit;
			if (overLeftBar)
			{
				// The row's own mousemove runs after this window listener, so take its freshest slot.
				state = bulletDragReducer(
					state,
					{
						type: "hover",
						target: leftBarTargetOf(leftBarDrop),
						indicator: null,
					},
				);
			}
		}
		if (todayHit)
		{
			const ids = state.draggingIds;
			swallowNextClick();
			state = IDLE_BULLET_DRAG;
			todayHit = false;
			finish();
			void dropOnToday(queryClient, ids);
			return;
		}
		if (stripHit !== null)
		{
			const detail: StripDropDetail =
			{
				itemIds: state.draggingIds,
				cell: stripHit.cell,
			};
			const {card} = stripHit;
			swallowNextClick();
			state = IDLE_BULLET_DRAG;
			stripHit = null;
			finish();
			card.dispatchEvent(
				new CustomEvent(
					STRIP_DROP_EVENT,
					{
						bubbles: true,
						detail,
					},
				),
			);
			return;
		}
		const collapsed = state.target?.ambiguous === true;
		const releasedParentId = state.target?.parentId ?? null;
		const {plan, copy} = dropBulletDrag(state, (targetId) => targetFacts(queryClient, targetId, collapsed));
		const ghostRect = overLeftBar ? null : (ghost?.querySelector(ROW_BULLET)?.getBoundingClientRect() ?? null);
		if (state.phase === "dragging")
		{
			swallowNextClick();
		}
		state = IDLE_BULLET_DRAG;
		finish();
		if (copy !== null)
		{
			void runCopyDrop(queryClient, copy, releasedParentId);
			return;
		}
		if (plan.move !== null)
		{
			if (fromFoundDates)
			{
				removeFoundDates(queryClient, plan.move.ids);
			}
			moveNodesNow(
				queryClient,
				{
					ids: [...plan.move.ids],
					parent_id: plan.move.parentId === HOME_ROOT ? null : plan.move.parentId,
					index: plan.move.index,
				},
			);
		}
		runDropEffects(plan, ghostRect, fromFoundDates, releasedParentId);
	};

	const onKeyDown = (keyEvent: KeyboardEvent) =>
	{
		if (keyEvent.key !== "Escape" || state.phase !== "dragging")
		{
			return;
		}
		keyEvent.preventDefault();
		keyEvent.stopPropagation();
		if (bullet !== null)
		{
			delete bullet.dataset.preDragClick;
		}
		state = bulletDragReducer(
			state,
			{
				type: "cancel",
			},
		);
		finish();
	};

	globalThis.addEventListener("mousemove", onMove, true);
	globalThis.addEventListener("mouseup", onUp, true);
	globalThis.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("mouseout", onLeaveWindow, true);
}

/** Upstream's left-bar row press: a drag of just that row, armed at 10px, with the hit test anchored on its label. */
export function startLeftBarRowDrag(
	queryClient: QueryClient,
	nodeId: string,
	event:
	{
		clientX: number;
		clientY: number;
		currentTarget: Element;
	},
): void
{
	const node = readNode(queryClient, nodeId);
	if (node === undefined)
	{
		return;
	}
	const label = event.currentTarget.querySelector("[data-expanded]") ?? event.currentTarget;
	const parentId = node.parent_id ?? HOME_ROOT;
	const index = childIdsOf(queryClient, node.parent_id ?? HOME_ROOT).indexOf(nodeId);
	startOutlineDrag(
		queryClient,
		{
			nodeId,
			items:
			{
				ids: [nodeId],
				home:
					index === -1
						? null
						:
							{
								parentId,
								index,
							},
				selection: false,
			},
			dragAction: "move",
			fromFoundDates: false,
			startX: event.clientX,
			startY: event.clientY,
			bullet: null,
			sourceRow: null,
			originTop: label.getBoundingClientRect().top,
			armedBy: leftBarDragArmed,
			scrollFrom: event.currentTarget,
		},
	);
}

/**
 * Upstream's mouse-driven bullet drag: a press on the bullet arms it, a 3px move starts it (ghost, hidden
 * source bullet, `.moving` rows), each move re-resolves the drop target, release moves the row through the API,
 * and Escape cancels. A press released before the threshold is a click, which zooms.
 */
export function useBulletDrag(nodeId: string): (event: React.MouseEvent<HTMLElement>) => void
{
	const queryClient = useQueryClient();

	return useCallback(
		(event: React.MouseEvent<HTMLElement>) =>
		{
			// Arm the click first, as upstream does, so a ⌘/Ctrl or other-button press still reaches the click handler.
			event.currentTarget.dataset.preDragClick = "true";
			// ⌘/Ctrl-click keeps the link's href.
			if (event.button !== 0 || event.ctrlKey || event.metaKey)
			{
				return;
			}
			event.preventDefault();
			const bullet = event.currentTarget;
			// Alt duplicates and Shift mirrors (Alt wins); the calendar strip takes moves only.
			const dragAction = dragActionOf(event);
			const sourceRow = bullet.closest(".project");
			const node = readNode(queryClient, nodeId);
			if (node === undefined || sourceRow === null)
			{
				return;
			}
			// Upstream (whats-new 2025.20): a found item dragged onto the day moves the original there.
			const fromFoundDates = isFoundDateRow(sourceRow);
			const items = dragItems(
				{
					sourceId: nodeId,
					selection: useOutlineStore.getState().itemSelection,
					tree: currentSelectionView(queryClient).tree,
					childIdsOf: (id) => childIdsOf(queryClient, id),
				},
			);
			startOutlineDrag(
				queryClient,
				{
					nodeId,
					items,
					dragAction,
					fromFoundDates,
					startX: event.clientX,
					startY: event.clientY,
					bullet,
					sourceRow,
					originTop: null,
					scrollFrom: bullet,
				},
			);
		},
		[nodeId, queryClient],
	);
}
