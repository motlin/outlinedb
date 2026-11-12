import {activeNoteContent, editorElement, textUnitLength, unitsBefore} from "./caret-dom.js";
import {serializeEditorHtml} from "./editor-html.js";
import {linkPopupTrigger} from "./link-popup-model.js";
import {editorHtmlToNote} from "./note-text.js";
import type {LinkPopupState} from "./stores/outline.js";

/** The anchor around `node`, when it lies inside `editor`. */
function enclosingAnchor(editor: HTMLElement, node: Node | null): HTMLAnchorElement | null
{
	const element = node instanceof Element ? node : (node?.parentElement ?? null);
	const anchor = element?.closest("a") ?? null;
	return anchor !== null && editor.contains(anchor) ? anchor : null;
}

/** Whether a selection reaches into any link of `editor`, as upstream's `gc.targetedIn`. */
function selectionTouchesLink(editor: HTMLElement, range: Range): boolean
{
	return (
		[...editor.querySelectorAll("a")].some((anchor) => range.intersectsNode(anchor)) ||
		enclosingAnchor(editor, range.startContainer) !== null ||
		enclosingAnchor(editor, range.endContainer) !== null
	);
}

/**
 * What ⌘K opens in the edited name or note of `nodeId`, read from the live selection: a new link over a selection
 * clear of links, or the link under a collapsed caret. Null when the key belongs to the Jump menu instead.
 */
export function readLinkPopupTarget(nodeId: string): LinkPopupState | null
{
	const selection = globalThis.getSelection();
	if (selection === null || selection.rangeCount === 0)
	{
		return null;
	}
	const range = selection.getRangeAt(0);
	const name = editorElement(nodeId);
	const note = activeNoteContent();
	const field = name?.contains(range.startContainer) === true ? "name" : "note";
	const editor = field === "name" ? name : note;
	if (editor === null || !editor.contains(range.startContainer) || !editor.contains(range.endContainer))
	{
		return null;
	}
	const anchor = range.collapsed ? enclosingAnchor(editor, range.startContainer) : null;
	const trigger = linkPopupTrigger(
		{
			collapsed: range.collapsed,
			selectionTouchesLink: !range.collapsed && selectionTouchesLink(editor, range),
			caretInLink: anchor !== null,
		},
	);
	if (trigger === null)
	{
		return null;
	}
	const html = field === "name" ? serializeEditorHtml(editor.innerHTML) : editorHtmlToNote(editor.innerHTML);
	const box = range.getBoundingClientRect();
	const position = [box.left + globalThis.scrollX, box.bottom + globalThis.scrollY] as const;
	if (anchor !== null)
	{
		const start = unitsBefore(editor, anchor, 0);
		return {
			nodeId,
			field,
			html,
			start,
			end: start + textUnitLength(anchor),
			text: anchor.textContent,
			href: anchor.getAttribute("href") ?? "",
			existing: true,
			position,
		};
	}
	const start = unitsBefore(editor, range.startContainer, range.startOffset);
	const end = unitsBefore(editor, range.endContainer, range.endOffset);
	return {
		nodeId,
		field,
		html,
		start,
		end,
		text: range.toString(),
		href: "",
		existing: false,
		position,
	};
}

/** What the toolbar's link button opens: a new link over its selection, and nothing when the selection touches a link. */
export function toolbarLinkTarget(nodeId: string): LinkPopupState | null
{
	const target = readLinkPopupTarget(nodeId);
	return target !== null && !target.existing ? target : null;
}
