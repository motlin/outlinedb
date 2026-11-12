import {caretTextOffset, placeCaretAtTextOffset} from "./caret-dom.js";
import {deletePillAfterCaret, deletePillBeforeCaret} from "./date-pills.js";

/**
 * Backspace right after / Delete right before a date pill with a collapsed caret in `editor` removes the whole
 * pill (upstream monolith): `html` is the editor's stored markup, `render` turns markup back into editor HTML.
 * Re-renders the editor, keeps the caret where the pill was, and returns the new markup, or null when no pill is
 * adjacent.
 */
export function deleteAdjacentPill(
	editor: HTMLElement,
	html: string,
	direction: "backward" | "forward",
	render: (html: string) => string,
): string | null
{
	if (globalThis.getSelection()?.isCollapsed !== true)
	{
		return null;
	}
	const offset = caretTextOffset(editor);
	const next = direction === "backward" ? deletePillBeforeCaret(html, offset) : deletePillAfterCaret(html, offset);
	if (next === null)
	{
		return null;
	}
	editor.innerHTML = render(next);
	placeCaretAtTextOffset(editor, direction === "backward" ? offset - 1 : offset);
	return next;
}
