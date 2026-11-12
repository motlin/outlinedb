import {useShallow} from "zustand/react/shallow";
import {isEntry} from "../item-selection.js";
import {dropHoverOf} from "../bullet-drag-state.js";
import type {DropHover} from "../bullet-drag-state.js";
import {paneExpandedIds} from "../pane-ids.js";
import {useOutlineStore} from "../stores/outline.js";
import type {ClickPosition} from "../stores/outline.js";

export interface RowState
{
	isPersistentlyExpanded: boolean;
	isEditingNote: boolean;
	isEditingName: boolean;
	/** Where the editing click landed, while the name is edited. */
	editingClickPosition: ClickPosition | null;
	isSlidingUp: boolean;
	isMoving: boolean;
	isAddedToSelection: boolean;
	/** Upstream tints the row and its nested `.children` while the row's item menu is open. */
	isHighlighted: boolean;
	isSlidingDown: boolean;
	dragHover: DropHover;
	showCompleted: boolean;
	alwaysVisibleControls: boolean;
}

/**
 * Everything a row of `paneId` reads from the outline store, in one selector: a screen of rows mounting in one task
 * subscribes once each, and each store write checks one selector per row. Each answer is the row's own, so moving the
 * editor re-renders the two rows it leaves and enters, not every row. Editing and the item selection show only in
 * the active pane, so a row visible in both panes edits in one.
 */
export function useRowState(nodeId: string, paneId: string, expansionKey: string = nodeId): RowState
{
	return useOutlineStore(
		useShallow((state) =>
		{
			const inActivePane = state.activePaneId === paneId;
			const isEditingName = inActivePane && state.editingId === nodeId;
			return {
				isPersistentlyExpanded: paneExpandedIds(state, paneId).has(expansionKey),
				isEditingNote: inActivePane && state.editingNoteId === nodeId,
				isEditingName,
				editingClickPosition: isEditingName ? state.editingClickPosition : null,
				isSlidingUp: state.slidingUpCompletionIds.has(nodeId),
				isMoving: state.movingIds.includes(nodeId) || state.draggingIds.includes(nodeId),
				isAddedToSelection: inActivePane && isEntry(state.itemSelection, nodeId),
				isHighlighted: state.itemMenuOpenId === nodeId,
				isSlidingDown: state.slidingDownCompletedIds.has(nodeId),
				dragHover: dropHoverOf(state.dropIndicator, nodeId, paneId),
				showCompleted: state.showCompleted,
				alwaysVisibleControls: state.alwaysVisibleControls,
			};
		}),
	);
}
