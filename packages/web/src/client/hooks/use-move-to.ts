import {stripHtmlTags} from "@outlinedb/shared/html";
import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useStableNavigate} from "./use-stable-navigate.js";
import {caretAnchor, caretBoxes, caretTextOffset, editorElement, rowContent} from "../caret-dom.js";
import type {AnchorRect} from "../caret-dom.js";
import {editingAfterMoveOut} from "../caret-navigation.js";
import {DEFAULT_CALENDAR_LEVELS, canMoveUnderCalendar, executeMoveTo, viewMovedTarget} from "../move-to.js";
import type {LoadedMoveTarget} from "../move-to.js";
import {goToNode} from "../navigation.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {readNode} from "../node-cache.js";
import {activePaneView, useOutlineStore} from "../stores/outline.js";
import type {CaretReturn} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {fetchAncestors, fetchChildren, fetchNode, sendBlockMoves, useMoveNodes} from "./use-nodes.js";
import {activeCommandRegistry} from "./use-global-keymap.js";
import {currentNavigableIds} from "./use-visible-nodes.js";

const NO_RECT: AnchorRect = {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0};

/** The picker anchor in page coordinates: the caret box in `editor` when editing, else the row's `.name`. */
export function moveToAnchor(itemId: string, editor: HTMLElement | null): {x: number; y: number} {
	const row = rowContent(itemId)?.closest(".name")?.getBoundingClientRect();
	const {x, y} = caretAnchor(editor === null ? [] : caretBoxes(editor), row ?? NO_RECT);
	return {x: x + window.scrollX, y: y + window.scrollY};
}

export async function loadMoveTarget(id: string): Promise<LoadedMoveTarget> {
	const node = await fetchNode(id);
	const [children, ancestors] = await Promise.all([fetchChildren(id), fetchAncestors(id)]);
	const parents = new Map(ancestors.map((ancestor) => [ancestor.id, ancestor.parent_id]));
	return {
		target: {id, name: stripHtmlTags(node.name ?? ""), defaultToBottom: node.defaultToBottom === true},
		childCount: children.length,
		parentOf: (nodeId) => parents.get(nodeId) ?? null,
	};
}

/** Upstream's caret after a move: from the moved row to the previous visible row (or out of editing). */
export function leaveRow(queryClient: QueryClient, itemId: string): void {
	const outline = useOutlineStore.getState();
	if (outline.editingId !== itemId) {
		return;
	}
	const next = editingAfterMoveOut(currentNavigableIds(queryClient), itemId, activePaneView().zoomedNodeId);
	if (next === null) {
		outline.stopEditing();
	} else {
		outline.resumeEditing(next.nodeId, next.caretOffset);
	}
}

/**
 * Upstream Move To (`⌃⌘M`, bullet menu `Move To...`): clear the item selection, open the location picker at the caret
 * (or the first item's row), move the items (document order) into the chosen location as one block without expanding
 * it, and move the caret to the previous visible row.
 */
export function useMoveTo(): (itemIds: readonly string[]) => Promise<void> {
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	const {mutate: moveNodes} = useMoveNodes();

	return async (itemIds) => {
		const items = itemIds.filter((id) => readNode(queryClient, id) !== undefined);
		const [first] = items;
		if (first === undefined) {
			return;
		}
		const store = useOutlineStore.getState();
		const paneId = store.activePaneId === MAIN_PANE_ID ? null : store.activePaneId;
		store.clearItemSelection();
		const editor = store.editingId === first ? editorElement(first) : null;
		const returnTo: CaretReturn | undefined =
			editor === null ? undefined : {nodeId: first, offset: caretTextOffset(editor)};
		await executeMoveTo({
			items,
			pick: async () =>
				store.openLocationPicker(
					{forItemId: first, headerText: "Move To..."},
					moveToAnchor(first, editor),
					returnTo,
				),
			loadTarget: loadMoveTarget,
			allowed: (itemId, targetId) =>
				canMoveUnderCalendar(
					readNode(queryClient, itemId) ?? {},
					readNode(queryClient, targetId) ?? {},
					DEFAULT_CALENDAR_LEVELS,
				),
			leaveItem: () => {
				leaveRow(queryClient, first);
			},
			moveNodes: (moves) => {
				void runInUndoBatch(captureOutlineView, async () => sendBlockMoves(moves, moveNodes));
			},
			showToast: ({text, timeout, actions, type}) => {
				useOutlineStore.getState().showAppMessage(text, {timeout, actions, type});
			},
			view: (targetId) => {
				viewMovedTarget(targetId, paneId, {
					zoomPane: (pane, target) => {
						useOutlineStore.getState().zoomPane(pane, target);
					},
					zoomMain: (target) => {
						goToNode(navigate, target);
					},
				});
			},
			undo: () => {
				activeCommandRegistry().undo?.execute({items: [], zoomedId: null});
			},
		});
	};
}
