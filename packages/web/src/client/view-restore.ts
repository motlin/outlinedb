import type {QueryClient} from "@tanstack/react-query";
import {afterNextPaint} from "./after-paint.js";
import {activeNoteContent, editorElement, placeSelectionAtTextOffsets} from "./caret-dom.js";
import {currentSelectionView} from "./hooks/use-selection-keymap.js";
import {useOutlineStore} from "./stores/outline.js";
import {focusQuietlyNext} from "./quiet-focus.js";
import {planViewRestore, takeViewRestore, viewStateKey, viewStates} from "./view-state.js";

/**
 * Upstream's `Wq` in `fI`: once a restoring navigation (Back/Forward, popstate, a link click) shows `shownRootId`'s
 * view, put back the caret or range, the scroll and the cleared item selection saved when the location was left, or
 * focus the first visible child of a location never saved. `rowIds` are the rendered rows in display order, the zoomed
 * title first when zoomed. A no-op when no restore is owed to this view.
 */
export function restoreViewAfterSwap(shownRootId: string | null, rowIds: readonly string[]): void
{
	const owed = takeViewRestore(shownRootId);
	if (owed === undefined)
	{
		return;
	}
	const state = useOutlineStore.getState();
	const plan = planViewRestore(
		viewStates.get(viewStateKey(owed)),
		{
			query: owed.query,
			renderedIds: new Set(rowIds),
			firstVisibleChildId: rowIds.find((id) => id !== shownRootId) ?? null,
			zoomedId: shownRootId,
		},
	);
	if (plan.clearSelection)
	{
		state.clearItemSelection();
	}
	const {focus} = plan;
	if (focus !== null)
	{
		if (focus.field === "note")
		{
			state.focusNote(focus.nodeId, focus.start);
		}
		else
		{
			focusQuietlyNext(focus.nodeId);
			state.resumeEditing(focus.nodeId, focus.start);
		}
		if (focus.start !== focus.end)
		{
			void (async () =>
			{
				await afterNextPaint();
				const element = focus.field === "note" ? activeNoteContent() : editorElement(focus.nodeId);
				if (element !== null)
				{
					placeSelectionAtTextOffsets(element, focus.start, focus.end, focus.reversed);
				}
			})();
		}
	}
	if (state.panes.length === 0)
	{
		globalThis.scrollTo(0, plan.scrollY);
		setTimeout(() =>
		{
			globalThis.scrollTo(0, plan.scrollY);
		}, 0);
	}
}

/** `restoreViewAfterSwap` for the view the cache and store show now. */
export function restoreShownView(queryClient: QueryClient, shownRootId: string | null): void
{
	restoreViewAfterSwap(
		shownRootId,
		currentSelectionView(queryClient).rows.map((row) => row.id),
	);
}
