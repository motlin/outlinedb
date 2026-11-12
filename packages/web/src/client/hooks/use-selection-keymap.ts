import type {QueryClient} from "@tanstack/react-query";
import
{
	caretAfterArrowClear,
	emptySelection,
	expand,
	isEntry,
	leadId,
	selectIds,
	selectionDeletePlan,
	sortedIds,
} from "../item-selection.js";
import type {CaretTarget, FlatRow, SelectionKeyAction, SelectionState, TreeView} from "../item-selection.js";
import {goToNode} from "../navigation.js";
import {readChildren, readNode} from "../node-cache.js";
import {activePaneView, activeZoomedId, paneView, useOutlineStore} from "../stores/outline.js";
import {rowContent} from "../caret-dom.js";
import type {NavigateFn} from "../stores/outline.js";
import {nextPotentiallyVisibleSibling} from "../tree-ops.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {collectVisibleNodeIds} from "./use-visible-nodes.js";

/** Stands in for Home as the selection's zoom root; it is never a row, so it is never selected. */
export const HOME_ROOT = "home";

/** Upstream confirms deleting a selection that holds more than this many items, descendants included. */
const DELETE_CONFIRM_THRESHOLD = 20;

/** The outline as the selection model sees it, read from the store and cache at call time. */
export interface SelectionView
{
	tree: TreeView;
	/** The navigable rows in display order: the zoomed title (when zoomed), then every visible row. */
	rows: FlatRow[];
	/** What ⌘A selects: the zoomed node, or every top-level row at Home. */
	allIds: string[];
}

export function currentSelectionView(queryClient: QueryClient, paneId?: string): SelectionView
{
	const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} =
		paneId === undefined ? activePaneView() : paneView(paneId);
	const visible = collectVisibleNodeIds(
		queryClient,
		zoomedNodeId,
		expandedIds,
		showCompleted,
		animatingCompletionIds,
	);
	const zoomRootId = zoomedNodeId ?? HOME_ROOT;
	const realParent = (id: string): string | null => readNode(queryClient, id)?.parent_id ?? null;
	const parentOf = (id: string): string | null =>
	{
		if (id === HOME_ROOT)
		{
			return null;
		}
		const node = readNode(queryClient, id);
		if (node === undefined)
		{
			return null;
		}
		return node.parent_id ?? (zoomedNodeId === null ? HOME_ROOT : null);
	};
	const sibling = (id: string, step: -1 | 1): string | null =>
		nextPotentiallyVisibleSibling(readChildren(queryClient, realParent(id)) ?? [], id, step, showCompleted);
	const rowIds = zoomedNodeId === null ? visible : [zoomedNodeId, ...visible];
	return {
		tree:
		{
			zoomRootId,
			parentOf,
			visibleOrder: [zoomRootId, ...visible],
			nextPotentiallyVisibleSiblingOf: (id) => sibling(id, 1),
			previousPotentiallyVisibleSiblingOf: (id) => sibling(id, -1),
		},
		rows: rowIds.map((id) => (
		{
			id,
			parentId: realParent(id),
		})),
		allIds: zoomedNodeId === null ? visible.filter((id) => realParent(id) === null) : [zoomedNodeId],
	};
}

/** Select `ids` as a fresh selection; Home itself is never selectable. */
export function freshSelection(view: SelectionView, ids: readonly string[]): SelectionState
{
	return selectIds(
		emptySelection(),
		view.tree,
		ids.filter((id) => id !== HOME_ROOT),
	);
}

export function scrollRowIntoView(id: string | null): void
{
	if (id === null)
	{
		return;
	}
	rowContent(id)?.scrollIntoView(
		{
			block: "nearest",
		},
	);
}

/** Whether keys typed into `target` go to text (a form field or an editor) rather than the item selection. */
export function isTextTarget(target: EventTarget | null): boolean
{
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

/** How many items deleting `ids` removes, descendants included; an unloaded subtree counts as too many to skip the confirm. */
function deletedItemCount(queryClient: QueryClient, ids: readonly string[]): number
{
	const count = (id: string): number =>
	{
		const children = readChildren(queryClient, id);
		if (children === undefined)
		{
			return readNode(queryClient, id)?.hasChildren === false ? 1 : Number.POSITIVE_INFINITY;
		}
		return children.reduce((sum, child) => sum + count(child.id), 1);
	};
	return ids.reduce((sum, id) => sum + count(id), 0);
}

function resumeAt(target: CaretTarget | null): void
{
	const {clearItemSelection, resumeEditing} = useOutlineStore.getState();
	if (target === null)
	{
		clearItemSelection();
		return;
	}
	resumeEditing(target.id, target.offset === "end" ? Number.MAX_SAFE_INTEGER : target.offset);
}

/**
 * Delete the selected items (`ordered`, in display order) as one undo step, confirming first when that removes more
 * than upstream's threshold of items (a cut passes `confirm: false`, as upstream's cut never asks). Editing resumes beside them, or, when the selected zoom root itself goes, the
 * view zooms out to its parent as upstream's `np` does.
 */
export function deleteSelectedItems(
	queryClient: QueryClient,
	ordered: readonly string[],
	deleteNode: (id: string) => void,
	navigate: NavigateFn,
	{
		confirm = true,
	}:
	{
		confirm?: boolean;
	} = {},
): void
{
	if (
		confirm &&
		deletedItemCount(queryClient, ordered) > DELETE_CONFIRM_THRESHOLD &&
		!globalThis.confirm(`Delete ${ordered.length} selected items and everything inside them?`)
	)
	{
		return;
	}
	const plan = selectionDeletePlan(
		ordered,
		currentSelectionView(queryClient).rows,
		activeZoomedId(useOutlineStore.getState()),
		(id) => readNode(queryClient, id)?.parent_id ?? null,
	);
	void runInUndoBatch(captureOutlineView, () =>
	{
		if (plan.kind === "zoom-out")
		{
			useOutlineStore.getState().clearItemSelection();
			goToNode(navigate, plan.parentId);
		}
		else
		{
			resumeAt(plan.target);
		}
		for (const id of ordered)
		{
			deleteNode(id);
		}
	});
}

/**
 * Run one of upstream's item-selection hotkeys (the global keymap dispatches them while items are selected and focus
 * is off every editor): ⇧↑/⇧↓ expand, ⌘A selects the zoom root, plain arrows clear the selection and edit beside it,
 * Backspace/Delete delete every selected item. Escape is the global search Escape's, which clears the selection as it
 * focuses search.
 */
export function runSelectionKey(
	action: SelectionKeyAction,
	queryClient: QueryClient,
	deleteNode: (id: string) => void,
	navigate: NavigateFn,
): void
{
	const state = useOutlineStore.getState();
	const view = currentSelectionView(queryClient);
	const selection = state.itemSelection;
	const ordered = sortedIds(selection, view.tree);
	switch (action)
	{
		case "EXPAND_UP":
		case "EXPAND_DOWN":
		{
			const next = expand(selection, view.tree, action === "EXPAND_UP" ? "up" : "down");
			if (!isEntry(next, HOME_ROOT))
			{
				state.setItemSelection(next);
				scrollRowIntoView(leadId(next));
			}
			break;
		}
		case "SELECT_ALL":
		{
			state.setItemSelection(freshSelection(view, view.allIds));
			break;
		}
		case "CLEAR_LEFT":
		case "CLEAR_RIGHT":
		case "CLEAR_UP":
		case "CLEAR_DOWN":
		{
			const dir = (
				{
					CLEAR_LEFT: "left",
					CLEAR_RIGHT: "right",
					CLEAR_UP: "up",
					CLEAR_DOWN: "down",
				} as const
			)[action];
			resumeAt(caretAfterArrowClear(dir, ordered, view.rows));
			break;
		}
		case "DELETE":
		{
			deleteSelectedItems(queryClient, ordered, deleteNode, navigate);
			break;
		}
	}
}
