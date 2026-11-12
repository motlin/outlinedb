import {placeCaretAtTextOffset, selectionTextOffsets} from "./caret-dom.js";
import {planInlineCodeInput} from "./inline-code-input.js";

/**
 * Upstream's `editor.input.inline-code` on a live editor: after a typed character with a collapsed caret, backticks
 * and double spaces may turn text into code. Re-renders the editor and places the caret, returning the new stored
 * HTML, or null when the input changed nothing (or was not plain typing).
 */
export function applyInlineCodeInput(
	editor: HTMLElement,
	event: Event | undefined,
	io:
	{
		read: () => string;
		render: (html: string) => string;
	},
): string | null
{
	if (!(event instanceof InputEvent) || event.isComposing || event.inputType !== "insertText" || !event.data)
	{
		return null;
	}
	const {start, end} = selectionTextOffsets(editor);
	if (start !== end)
	{
		return null;
	}
	const plan = planInlineCodeInput(io.read(), end, event.data);
	if (plan === null)
	{
		return null;
	}
	editor.innerHTML = io.render(plan.html);
	placeCaretAtTextOffset(editor, plan.caret);
	return plan.html;
}
