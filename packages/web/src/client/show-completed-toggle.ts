import {planHideCompletedFocus} from "./caret-navigation.js";
import type {Command} from "./keys/dispatch.js";

/** Upstream animates only the first rows when completed rows hide or show. */
const SLIDE_MAX_ROWS = 10;
/** The 120ms slide plus slack, after which the sliding rows settle. */
const SLIDE_SETTLE_MS = 220;

export interface ShowCompletedToggleInput
{
	showCompleted: boolean;
	editingId: string | null;
	/** Navigable rows (zoom title first) with completed rows shown or hidden, ignoring rows held for animation. */
	rowsFor: (showCompleted: boolean) => string[];
	isCompleted: (id: string) => boolean;
	actions:
	{
		setShowCompleted: (showCompleted: boolean) => void;
		beginCompletionAnimation: (ids: string[]) => void;
		startCompletionSlideUp: (ids: string[]) => void;
		endCompletionAnimation: (ids: string[]) => void;
		startCompletedSlideDown: (ids: string[]) => void;
		endCompletedSlideDown: (ids: string[]) => void;
		resumeEditing: (id: string, caretOffset: number) => void;
	};
}

/**
 * Upstream's show/hide completed: hiding slides up the first 10 visible done rows and
 * hides them when the slide ends, moving the caret off an edited row that hides; showing
 * reveals the rows and slides down the first 10 newly visible done rows.
 */
export function runShowCompletedToggle(input: ShowCompletedToggleInput): void
{
	const {showCompleted, editingId, rowsFor, isCompleted, actions} = input;
	if (showCompleted)
	{
		const before = rowsFor(true);
		const after = new Set(rowsFor(false));
		const hidden = new Set(before.filter((id) => !after.has(id)));
		const sliding = before.filter((id) => hidden.has(id) && isCompleted(id)).slice(0, SLIDE_MAX_ROWS);
		const focus = planHideCompletedFocus(before, hidden, editingId);
		if (sliding.length > 0)
		{
			actions.beginCompletionAnimation(sliding);
		}
		actions.setShowCompleted(false);
		if (focus !== null)
		{
			actions.resumeEditing(focus.nodeId, focus.caretOffset);
		}
		if (sliding.length > 0)
		{
			actions.startCompletionSlideUp(sliding);
			setTimeout(() =>
			{
				actions.endCompletionAnimation(sliding);
			}, SLIDE_SETTLE_MS);
		}
		return;
	}
	const before = new Set(rowsFor(false));
	actions.setShowCompleted(true);
	const revealed = rowsFor(true)
		.filter((id) => !before.has(id) && isCompleted(id))
		.slice(0, SLIDE_MAX_ROWS);
	if (revealed.length === 0)
	{
		return;
	}
	actions.startCompletedSlideDown(revealed);
	setTimeout(() =>
	{
		actions.endCompletedSlideDown(revealed);
	}, SLIDE_SETTLE_MS);
}

/**
 * Upstream's `show_or_hide_completed` command: unavailable while a search is in progress
 * (`WF.Search.isInProgress()`), so its combo is still claimed but does nothing.
 */
export function showCompletedCommand(toggle: () => void, isSearching: () => boolean): Command
{
	return {
		available: () => !isSearching(),
		execute: toggle,
	};
}
