import {activeNoteContent, editorElement, selectionTextRange} from "./caret-dom.js";
import {viewStateKey, viewStates} from "./view-state.js";
import type {SavedEditing} from "./view-state.js";
import type {Loc} from "./nav-stack.js";

/** The body class upstream's `RQ2` skips saving under (`animationsAreInProgress`). */
const ZOOMING = "item--zooming-in-progress";

/**
 * Upstream's `saveClientViewState`, taken when a location is left rather than every 500ms: the caret or range of the
 * row being edited (its name or its note) and the window scroll, stored under `current`.
 */
export function captureViewState(
	current: Loc | null,
	editing:
	{
		editingId: string | null;
		editingNoteId: string | null;
	},
): void
{
	if (current === null || document.body.classList.contains(ZOOMING))
	{
		return;
	}
	let saved: SavedEditing | null = null;
	if (editing.editingNoteId !== null)
	{
		const note = activeNoteContent();
		if (note !== null)
		{
			saved =
			{
				nodeId: editing.editingNoteId,
				field: "note",
				...selectionTextRange(note),
			};
		}
	}
	else if (editing.editingId !== null)
	{
		const name = editorElement(editing.editingId);
		if (name !== null)
		{
			saved =
			{
				nodeId: editing.editingId,
				field: "name",
				...selectionTextRange(name),
			};
		}
	}
	viewStates.set(
		viewStateKey(current),
		{
			editing: saved,
			scrollY: globalThis.scrollY,
		},
	);
}
