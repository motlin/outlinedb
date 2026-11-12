// Caret offsets count plain-text units: a date pill (`<time>`) is one unit and the pills'
// U+FEFF caret guards count zero, matching `rich-text.ts` offsets into stored HTML.

const BOM = "﻿";

/**
 * Where row lookups search: the active pane (`[data-pane-active="true"]`, set only while a side pane is open), else the
 * whole document. A row visible in both panes resolves to the active pane's copy.
 */
function activePaneScope(): Pick<ParentNode, "querySelector">
{
	return document.querySelector('[data-pane-active="true"]') ?? document;
}

/** The contenteditable of the node being edited, when it is rendered in the active pane. */
export function editorElement(nodeId: string): HTMLElement | null
{
	return activePaneScope().querySelector<HTMLElement>(
		`.innerContentContainer.editing[data-node-id="${CSS.escape(nodeId)}"]`,
	);
}

/** The focused note's text container in the active pane, where its caret offsets count from. */
export function activeNoteContent(): HTMLElement | null
{
	const note = activePaneScope().querySelector<HTMLElement>(".notes > .content.active");
	return note?.querySelector<HTMLElement>(".innerContentContainer") ?? note ?? null;
}

/** The node's name content (`.innerContentContainer`) in the active pane, edited or not. */
export function rowContent(nodeId: string): HTMLElement | null
{
	return activePaneScope().querySelector<HTMLElement>(`.innerContentContainer[data-node-id="${CSS.escape(nodeId)}"]`);
}

function isPill(node: Node): node is Element
{
	return node instanceof Element && (node.localName === "time" || node.localName === "mention");
}

function unitsIn(node: Node): number
{
	if (node.nodeType === Node.TEXT_NODE)
	{
		return (node.textContent ?? "").replaceAll(BOM, "").length;
	}
	if (isPill(node))
	{
		// A pill cut by the range counts only once its label is inside it.
		return node.textContent.replaceAll(BOM, "") === "" ? 0 : 1;
	}
	let count = 0;
	for (const child of node.childNodes)
	{
		count += unitsIn(child);
	}
	return count;
}

/** Plain-text units in `element`'s content. */
export function textUnitLength(element: HTMLElement): number
{
	return unitsIn(element);
}

/** Number of plain-text units between the start of `element` and the DOM point (`container`, `offset`). */
export function unitsBefore(element: HTMLElement, container: Node, offset: number): number
{
	const before = document.createRange();
	before.selectNodeContents(element);
	before.setEnd(container, offset);
	return unitsIn(before.cloneContents());
}

/** Number of plain-text units between the start of `element` and the caret. */
export function caretTextOffset(element: HTMLElement): number
{
	const selection = globalThis.getSelection();
	if (!selection || selection.rangeCount === 0)
	{
		return textUnitLength(element);
	}
	const caret = selection.getRangeAt(0);
	if (!element.contains(caret.endContainer))
	{
		return textUnitLength(element);
	}
	return unitsBefore(element, caret.endContainer, caret.endOffset);
}

/**
 * Plain-text offsets of the selection's start and end within `element`; both are
 * the text length when the selection lies outside it.
 */
export function selectionTextOffsets(element: HTMLElement):
{
	start: number;
	end: number;
}
{
	const selection = globalThis.getSelection();
	const length = textUnitLength(element);
	if (!selection || selection.rangeCount === 0)
	{
		return {
			start: length,
			end: length,
		};
	}
	const range = selection.getRangeAt(0);
	if (!element.contains(range.startContainer) || !element.contains(range.endContainer))
	{
		return {
			start: length,
			end: length,
		};
	}
	return {
		start: unitsBefore(element, range.startContainer, range.startOffset),
		end: unitsBefore(element, range.endContainer, range.endOffset),
	};
}

/**
 * The selection's plain-text range within `element` with its direction (`reversed` when the focus is before the
 * anchor); a caret at the end when the selection lies outside it.
 */
export function selectionTextRange(element: HTMLElement):
{
	start: number;
	end: number;
	reversed: boolean;
}
{
	const selection = globalThis.getSelection();
	const length = textUnitLength(element);
	const {anchorNode, focusNode} = selection ?? {};
	if (!selection || !anchorNode || !focusNode || !element.contains(anchorNode) || !element.contains(focusNode))
	{
		return {
			start: length,
			end: length,
			reversed: false,
		};
	}
	const anchor = unitsBefore(element, anchorNode, selection.anchorOffset);
	const focus = unitsBefore(element, focusNode, selection.focusOffset);
	return {
		...orderOffsets(anchor, focus),
		reversed: focus < anchor,
	};
}

/** Raw index in `text` after `units` non-guard characters, or null when it has fewer. */
function rawIndex(text: string, units: number): number | null
{
	let remaining = units;
	for (let index = 0; index <= text.length; index++)
	{
		if (remaining === 0)
		{
			return index;
		}
		if (text[index] !== BOM)
		{
			remaining--;
		}
	}
	return null;
}

/** Plain-text offset of `offset` units into node `nodeIndex`, given each node's unit length. */
export function offsetsFromPath(textLengths: readonly number[], nodeIndex: number, offset: number): number
{
	let total = offset;
	for (const length of textLengths.slice(0, nodeIndex))
	{
		total += length;
	}
	return total;
}

/** Orders a possibly reversed (focus before anchor) pair of offsets. */
export function orderOffsets(
	anchor: number,
	focus: number,
):
{
	start: number;
	end: number;
}
{
	return {
		start: Math.min(anchor, focus),
		end: Math.max(anchor, focus),
	};
}

/** Sets `range`'s start at `offset` plain-text units into `element`; false past its end. */
function setStartAtTextOffset(range: Range, element: HTMLElement, offset: number): boolean
{
	let remaining = offset;
	const visit = (node: Node): boolean =>
	{
		for (const child of node.childNodes)
		{
			if (isPill(child))
			{
				if (remaining === 0)
				{
					range.setStartBefore(child);
					return true;
				}
				remaining--;
				if (remaining === 0)
				{
					range.setStartAfter(child);
					return true;
				}
			}
			else if (child.nodeType === Node.TEXT_NODE)
			{
				const text = child.textContent ?? "";
				const index = rawIndex(text, remaining);
				if (index !== null)
				{
					range.setStart(child, index);
					return true;
				}
				remaining -= text.replaceAll(BOM, "").length;
			}
			else if (visit(child))
			{
				return true;
			}
		}
		return false;
	};
	return visit(element);
}

/** A collapsed range at `offset` plain-text units into `element`, clamped to its end. */
function rangeAtTextOffset(element: HTMLElement, offset: number): Range
{
	const range = document.createRange();
	const placed = setStartAtTextOffset(range, element, offset);
	if (!placed)
	{
		range.selectNodeContents(element);
	}
	range.collapse(placed);
	return range;
}

/** The box of plain-text units `start`..`end` of `element`, each clamped to its end. */
export function textRangeBox(element: HTMLElement, start: number, end: number): AnchorRect
{
	const range = rangeAtTextOffset(element, start);
	const boundary = rangeAtTextOffset(element, end);
	range.setEnd(boundary.endContainer, boundary.endOffset);
	return range.getBoundingClientRect();
}

/** A range over plain-text units `start`..`end` of `element` (either order), each clamped to its end. */
export function rangeAtTextOffsets(element: HTMLElement, start: number, end: number): Range
{
	const ordered = orderOffsets(start, end);
	const range = rangeAtTextOffset(element, ordered.start);
	if (ordered.end !== ordered.start)
	{
		const endBoundary = rangeAtTextOffset(element, ordered.end);
		range.setEnd(endBoundary.endContainer, endBoundary.endOffset);
	}
	return range;
}

/** Select plain-text units `start`..`end` of `element` (either order), each clamped to its end. */
export function placeSelectionAtTextOffsets(element: HTMLElement, start: number, end: number, reversed = false): void
{
	const ordered = orderOffsets(start, end);
	const range = rangeAtTextOffsets(element, ordered.start, ordered.end);
	const selection = globalThis.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	if (reversed && ordered.end !== ordered.start)
	{
		selection?.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
	}
}

/** Collapse the selection to `offset` plain-text units into `element`, clamped to its end. */
export function placeCaretAtTextOffset(element: HTMLElement, offset: number): void
{
	placeSelectionAtTextOffsets(element, offset, offset);
}

export interface AnchorRect
{
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

function isEmptyRect(rect: AnchorRect): boolean
{
	return rect.left === 0 && rect.top === 0 && rect.right === 0 && rect.bottom === 0 && rect.width === 0;
}

/**
 * Upstream's inline-picker anchor: the bottom-left of the first non-empty caret box among `candidates` (upstream's
 * `Caret.rect`: the text-offset range, then the selection's focus node), else of `fallback`.
 */
export function caretAnchor(
	candidates: readonly (AnchorRect | null)[],
	fallback: AnchorRect,
):
{
	x: number;
	y: number;
}
{
	const box = candidates.find((rect): rect is AnchorRect => rect !== null && !isEmptyRect(rect)) ?? fallback;
	return {
		x: box.left,
		y: box.bottom,
	};
}

/**
 * The caret's box candidates in `element`, in upstream's order: a range rebuilt at the caret's plain-text offset over
 * the text nodes (`DomEditableText.rectOf`, real even after a programmatic caret Chrome reports as an empty rect), then
 * the selection focus node's box when it is an element.
 */
export function caretBoxes(element: HTMLElement): (AnchorRect | null)[]
{
	const offsetRange = rangeAtTextOffset(element, caretTextOffset(element)).getBoundingClientRect();
	const focus = globalThis.getSelection()?.focusNode;
	return [offsetRange, focus instanceof Element ? focus.getBoundingClientRect() : null];
}
