// Upstream's mouse-driven bullet drag (`LP4` mousedown, `jL4`/`_t2` dragging), as a pure state machine.
// The hook in `hooks/use-bullet-drag.ts` feeds it window mouse events and renders what it decides.

import {isEntry, sortedIds} from "./item-selection.js";
import type {SelectionState, TreeView} from "./item-selection.js";
import type {DropRows, DropTarget} from "./outline-drop-target.js";
import {defaultIndexIn} from "./tree-ops.js";

/** A class only upstream's Found Dates container (`calendar_mirrors`) carries. */
const FOUND_DATES_CLASS = "[&_>.name>.itemMenu]:hidden";

interface RowElement
{
	readonly parentElement:
	{
		closest(selector: string):
		{
			readonly classList:
			{
				contains(name: string): boolean;
			};
		} | null;
	} | null;
}

/** Whether the `.project` `row` is a Found Dates row: a mirror of a node elsewhere, listed under a day page. */
export function isFoundDateRow(row: RowElement): boolean
{
	return row.parentElement?.closest(".project")?.classList.contains(FOUND_DATES_CLASS) === true;
}

/** The hit point stays this far inside the page's horizontal edges. */
const HIT_INSET_PX = 6;

/** A press becomes a drag once the pointer has moved this far (Euclidean) from the mousedown point. */
const DRAG_START_THRESHOLD_PX = 3;

/** Where the drop line goes: inside a parent (first slot) or under the row before the slot. */
export type DropIndicator =
	|
	  {
			readonly kind: "in";
			readonly parentId: string;
			readonly paneId: string;
	  }
	|
	  {
			readonly kind: "at";
			readonly rowId: string;
			readonly paneId: string;
	  };

interface Point
{
	readonly x: number;
	readonly y: number;
}

interface Slot
{
	readonly parentId: string;
	readonly index: number;
}

/** What a press does: Alt duplicates, Shift mirrors (Alt wins), no modifier moves (upstream `qD4`). */
export type DragAction = "move" | "duplicate" | "mirror";

export function dragActionOf(modifiers: {readonly altKey: boolean; readonly shiftKey: boolean}): DragAction
{
	if (modifiers.altKey)
	{
		return "duplicate";
	}
	return modifiers.shiftKey ? "mirror" : "move";
}

/** Upstream `L = !(isSelection || action === "duplicate")`: the source bullet hides for a single move or mirror. */
export function hidesSourceBullet(action: DragAction, selection: boolean): boolean
{
	return !(selection || action === "duplicate");
}

export interface BulletDragState
{
	readonly action: DragAction;
	/** Whether the press dragged the selection. */
	readonly selection: boolean;
	readonly phase: "idle" | "armed" | "dragging";
	readonly sourceId: string | null;
	readonly origin: Point | null;
	/** Where the dragged row sits now; dropping back there moves nothing. */
	readonly home: Slot | null;
	/** What the press would drag: the whole selection when the pressed row is an entry, else the row. */
	readonly itemIds: readonly string[];
	readonly draggingIds: readonly string[];
	readonly indicator: DropIndicator | null;
	readonly ghostTransform: string | null;
	/** The last target found; it survives the pointer leaving the window. */
	readonly target: DropTarget | null;
}

export type BulletDragAction =
	|
	  {
			readonly type: "start";
			readonly id: string;
			readonly x: number;
			readonly y: number;
			readonly itemIds: readonly string[];
			readonly home: Slot | null;
			readonly action?: DragAction;
			readonly selection?: boolean;
	  }
	|
	  {
			readonly type: "move";
			readonly x: number;
			readonly y: number;
	  }
	|
	  {
			readonly type: "hover";
			readonly target: DropTarget | null;
			readonly indicator: DropIndicator | null;
	  }
	|
	  {
			readonly type: "leave";
	  }
	|
	  {
			readonly type: "cancel";
	  };

export interface MoveEffect
{
	readonly ids: readonly string[];
	readonly parentId: string;
	readonly index: number;
}

export const IDLE_BULLET_DRAG: BulletDragState =
{
	action: "move",
	selection: false,
	phase: "idle",
	sourceId: null,
	origin: null,
	home: null,
	itemIds: [],
	draggingIds: [],
	indicator: null,
	ghostTransform: null,
	target: null,
};

export function bulletDragReducer(state: BulletDragState, action: BulletDragAction): BulletDragState
{
	switch (action.type)
	{
		case "start":
		{
			return {
				...IDLE_BULLET_DRAG,
				phase: "armed",
				sourceId: action.id,
				origin:
				{
					x: action.x,
					y: action.y,
				},
				home: action.home,
				itemIds: action.itemIds,
				action: action.action ?? "move",
				selection: action.selection ?? false,
			};
		}
		case "move":
		{
			if (state.origin === null || state.sourceId === null)
			{
				return state;
			}
			const dx = action.x - state.origin.x;
			const dy = action.y - state.origin.y;
			if (state.phase === "armed" && Math.hypot(dx, dy) < DRAG_START_THRESHOLD_PX)
			{
				return state;
			}
			return {
				...state,
				phase: "dragging",
				draggingIds: state.phase === "dragging" ? state.draggingIds : state.itemIds,
				ghostTransform: `translate3d(${dx}px, ${dy}px, 0px)`,
			};
		}
		case "hover":
		{
			return state.phase === "dragging"
				?
					{
						...state,
						target: action.target,
						indicator: action.indicator,
					}
				: state;
		}
		case "leave":
		{
			return state.phase === "dragging"
				?
					{
						...state,
						indicator: null,
					}
				: state;
		}
		case "cancel":
		{
			break;
		}
	}
	return IDLE_BULLET_DRAG;
}

export interface DragItemsInput
{
	readonly sourceId: string;
	readonly selection: SelectionState;
	readonly tree: TreeView;
	/** Every child of `id` in order, rendered or not. */
	readonly childIdsOf: (id: string) => readonly string[];
}

export interface DragItems
{
	/** The rows to drag, in document order. */
	readonly ids: readonly string[];
	/** Where the rows sit as one contiguous sibling block, or null when they do not. */
	readonly home: Slot | null;
	/** Whether the press dragged the selection: the source bullet then stays visible. */
	readonly selection: boolean;
}

/** Upstream drags the whole selection when the pressed bullet's row is `.addedToSelection`, otherwise just the row. */
export function dragItems({sourceId, selection, tree, childIdsOf}: DragItemsInput): DragItems
{
	const fromSelection = isEntry(selection, sourceId);
	const ids = fromSelection ? sortedIds(selection, tree) : [sourceId];
	const [firstId] = ids;
	const parentId = firstId === undefined ? null : tree.parentOf(firstId);
	if (firstId === undefined || parentId === null || ids.some((id) => tree.parentOf(id) !== parentId))
	{
		return {
			ids,
			home: null,
			selection: fromSelection,
		};
	}
	const siblings = childIdsOf(parentId);
	const index = siblings.indexOf(firstId);
	const contiguous = ids.every((id, offset) => siblings[index + offset] === id);
	return {
		ids,
		home: contiguous
			?
				{
					parentId,
					index,
				}
			: null,
		selection: fromSelection,
	};
}

/** A drop keeps the selection, except one into a collapsed parent, which clears it on the next tick. */
export function dropClearsSelection(plan: DropPlan): boolean
{
	return plan.move !== null && plan.flashParentId !== null;
}

/** What the hook knows about the drop target's parent at release. */
export interface DropTargetFacts
{
	/** Every child of the target parent, the dragged rows included. */
	readonly childCount: number;
	readonly wasLeaf: boolean;
	readonly wasCollapsed: boolean;
	/** Upstream `metadata.priority.defaultToBottom`: a drop with no exact slot lands at the bottom. */
	readonly defaultToBottom: boolean;
}

export interface DropPlanInput extends DropTargetFacts
{
	readonly target: DropTarget;
	/** The dragged rows in document order. */
	readonly draggingIds: readonly string[];
	readonly home: Slot | null;
}

/** Upstream's drop (`jL4` mouseup): one block move, then expand a leaf or flash and animate into a collapsed parent. */
export interface DropPlan
{
	readonly move: MoveEffect | null;
	readonly expandId: string | null;
	readonly flashParentId: string | null;
	readonly animate: boolean;
	/** The dragged rows to flash `.moving`: upstream flashes them on every release with a target, even a no-op. */
	readonly flashIds: readonly string[];
}

const NO_DROP: DropPlan =
{
	move: null,
	expandId: null,
	flashParentId: null,
	animate: false,
	flashIds: [],
};

/**
 * Plan a drop. The index counts every child, the dragged rows included, so any slot from the block's first row
 * through the one just after its last leaves it where it is. A collapsed (ambiguous) target has no exact slot,
 * so the rows land at its default end.
 */
export function planDrop({
	target,
	draggingIds,
	home,
	childCount,
	wasLeaf,
	wasCollapsed,
	defaultToBottom,
}: DropPlanInput): DropPlan
{
	const index = target.ambiguous
		? defaultIndexIn(
				{
					defaultToBottom,
				},
				childCount,
			)
		: target.index;
	const unchanged =
		home !== null &&
		target.parentId === home.parentId &&
		index >= home.index &&
		index <= home.index + draggingIds.length;
	if (draggingIds.length === 0)
	{
		return NO_DROP;
	}
	if (unchanged)
	{
		return {
			...NO_DROP,
			flashIds: draggingIds,
		};
	}
	return {
		flashIds: draggingIds,
		move:
		{
			ids: draggingIds,
			parentId: target.parentId,
			index,
		},
		expandId: wasLeaf ? target.parentId : null,
		flashParentId: wasCollapsed ? target.parentId : null,
		animate: wasCollapsed,
	};
}

/** A duplicate or mirror drop (upstream `RC4`): copies land at the hovered slot, whatever the row's own slot. */
export interface CopyPlan
{
	readonly kind: "duplicate" | "mirror";
	readonly ids: readonly string[];
	readonly parentId: string;
	readonly index: number;
	/** The SOURCE rows flash `.moving`; the copies never do. */
	readonly flashIds: readonly string[];
	/** A selection drag selects the copies; otherwise the caret goes to the first copy. */
	readonly after:
		|
		  {
				readonly kind: "select";
		  }
		|
		  {
				readonly kind: "caret";
		  };
}

export interface CopyDropInput
{
	readonly action: DragAction;
	readonly target: DropTarget;
	readonly draggingIds: readonly string[];
	readonly selection: boolean;
}

/**
 * Plan a copy drop. Unlike a move there is no ambiguous-slot default, no no-op check and no leaf expand: the copy goes
 * at exactly the hovered index, so dropping on the row's own slot puts the copy before the original.
 */
export function planCopyDrop({action, target, draggingIds, selection}: CopyDropInput): CopyPlan | null
{
	if (action === "move" || draggingIds.length === 0)
	{
		return null;
	}
	return {
		kind: action,
		ids: draggingIds,
		parentId: target.parentId,
		index: target.index,
		flashIds: draggingIds,
		after: selection
			?
				{
					kind: "select",
				}
			:
				{
					kind: "caret",
				},
	};
}

export interface CopyDropEffects
{
	/** The new rows to select (a selection drag), or null. */
	readonly select: readonly string[] | null;
	/** The new row that gets the caret at offset 0, or null (a copy inside a collapsed parent stays unfocused). */
	readonly caretId: string | null;
	/** The SOURCE rows that flash `.moving` for 500ms. */
	readonly flashIds: readonly string[];
}

/** What follows a copy drop once the copies exist (upstream `W92`, `AppItemSelect.select`, `Nu1`). */
export function copyDropEffects(
	copy: CopyPlan,
	newIds: readonly string[],
	isRendered: (id: string) => boolean,
): CopyDropEffects
{
	const [first] = newIds;
	if (copy.after.kind === "select")
	{
		return {
			select: newIds,
			caretId: null,
			flashIds: copy.flashIds,
		};
	}
	return {
		select: null,
		caretId: first !== undefined && isRendered(first) ? first : null,
		flashIds: copy.flashIds,
	};
}

/** Release the drag, planning the drop from the facts about the hovered target's parent. */
export function dropBulletDrag(
	state: BulletDragState,
	factsOf: (parentId: string) => DropTargetFacts,
):
{
	state: BulletDragState;
	plan: DropPlan;
	copy: CopyPlan | null;
}
{
	const {phase, target, home, draggingIds, action, selection} = state;
	if (phase !== "dragging" || target === null)
	{
		return {
			state: IDLE_BULLET_DRAG,
			plan: NO_DROP,
			copy: null,
		};
	}
	const copy = planCopyDrop(
		{
			action,
			target,
			draggingIds,
			selection,
		},
	);
	return {
		state: IDLE_BULLET_DRAG,
		plan:
			copy === null
				? planDrop(
						{
							target,
							draggingIds,
							home,
							...factsOf(target.parentId),
						},
					)
				: NO_DROP,
		copy,
	};
}

/** The indicator for a target: inside the parent for slot 0, else under the child before the slot. */
export function dropIndicatorFor(
	target: DropTarget | null,
	childIds: readonly string[],
	paneId: string,
): DropIndicator | null
{
	if (target === null)
	{
		return null;
	}
	if (target.index === 0)
	{
		return {
			kind: "in",
			parentId: target.parentId,
			paneId,
		};
	}
	const rowId = childIds[target.index - 1];
	return rowId === undefined
		? null
		:
			{
				kind: "at",
				rowId,
				paneId,
			};
}

/** How the drop line marks a row: `in` (inside, `.drag-hovered-in`), `at` (under, `.drag-hovered-at`), or not at all. */
export type DropHover = "in" | "at" | null;

export function dropHoverOf(indicator: DropIndicator | null, id: string, paneId: string): DropHover
{
	if (indicator?.paneId !== paneId)
	{
		return null;
	}
	if (indicator.kind === "in" && indicator.parentId === id)
	{
		return "in";
	}
	return indicator.kind === "at" && indicator.rowId === id ? "at" : null;
}

/** Upstream `G92`: a pointer outside the window clears the indicator (the stored target survives). */
export function isOutsideViewport(
	point: Point,
	size:
	{
		readonly width: number;
		readonly height: number;
	},
): boolean
{
	return point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height;
}

/** The hit point's x: the pointer clamped to the page, inset 6px from each edge. */
export function hitX(
	pointerX: number,
	bounds:
	{
		readonly left: number;
		readonly right: number;
	},
): number
{
	return Math.min(Math.max(pointerX, bounds.left + HIT_INSET_PX), bounds.right - HIT_INSET_PX);
}

/** The ghost bullet's `transform-origin` for the rotate animation, from the parent bullet's content box. */
export function rotateOrigin(
	bullet:
	{
		readonly left: number;
		readonly top: number;
		readonly contentWidth: number;
		readonly contentHeight: number;
	},
	ghost:
	{
		readonly left: number;
		readonly top: number;
	},
): string
{
	const x = (bullet.left + bullet.contentWidth - ghost.left) / 2;
	const y = (bullet.top + bullet.contentHeight - ghost.top) / 2;
	return `${x}px ${y}px`;
}

const GHOST_CLONE_LIMIT = 5;

/** Inline style of the `index`th stacked ghost bullet; the clone copies a visible bullet, so no `visibility`. */
export function ghostCloneStyle(index: number):
{
	left: string;
	top: string;
	opacity: string;
	zIndex: string;
}
{
	return {
		left: "0",
		top: `${index * 10}px`,
		opacity: String(1 - index / GHOST_CLONE_LIMIT),
		zIndex: String(GHOST_CLONE_LIMIT - index),
	};
}

export interface DropRowsInput
{
	/** Rendered rows in document order, the zoom root first. */
	readonly order: readonly string[];
	readonly parentOf: (id: string) => string | null;
	/** Every child of `id` in order, rendered or not. */
	readonly childIdsOf: (id: string) => readonly string[];
	readonly isCollapsed: (id: string) => boolean;
	readonly left: (id: string) => number;
}

/** The resolver's view of the outline, from the rendered row order and the cached tree. */
export function buildDropRows({order, parentOf, childIdsOf, isCollapsed, left}: DropRowsInput): DropRows
{
	const position = new Map(order.map((id, index) => [id, index]));
	const step = (id: string, delta: number): string | null =>
	{
		const at = position.get(id);
		return at === undefined ? null : (order[at + delta] ?? null);
	};
	return {
		left,
		parentOf,
		indexOf: (id) =>
		{
			const parentId = parentOf(id);
			return parentId === null ? 0 : childIdsOf(parentId).indexOf(id);
		},
		isRendered: (id) => position.has(id),
		nextInDocument: (id) => step(id, 1),
		previousInDocument: (id) => step(id, -1),
		isCollapsed,
		isDescendantOf: (id, ancestorId) =>
		{
			for (let current = parentOf(id); current !== null; current = parentOf(current))
			{
				if (current === ancestorId)
				{
					return true;
				}
			}
			return false;
		},
	};
}
