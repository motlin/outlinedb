// Pasting into a note (upstream `MD4`): the text goes in place with its newlines, never as rows.
import {buildNoteHtml, hasRichContent} from "./html.js";
import {escapeHtml} from "./lines.js";

/** Stored-HTML to insert at the note's selection. */
export function notePasteHtml({text, html, plain = false}: {text: string; html?: string; plain?: boolean}): string
{
	if (!plain && html !== undefined && hasRichContent(html))
	{
		return buildNoteHtml(html);
	}
	return escapeHtml(text.replaceAll("\u00A0", " ")).replaceAll(/\n{3,}/gu, "\n\n");
}
