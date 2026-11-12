/**
 * Codec between contenteditable note HTML and stored note text. Upstream stores line
 * breaks as literal `\n` and shows a note containing `<br>` as empty, so the editor's
 * `<br>`/`<div>`/`<p>` structure must never reach the API.
 */

import {renderDatePills, serializeDatePills} from "./date-pills.js";
import type {DateSettings} from "./date-settings.js";
import {anchorHref, renderLinks, storedAnchorTag} from "./link-render.js";
import {renderMentionPills, serializeMentionPills} from "./mention-pills.js";
import type {MentionAccount} from "./mention-pills.js";
import {placeCaretAtTextOffset} from "./caret-dom.js";
import {addMonolithGuards} from "./monolith-guards.js";
import {renderTags} from "./tag-render.js";

const TAG_PATTERN = /<(\/?)([a-z][\w-]*)([^>]*)>/giu;
const KEPT_ELEMENTS = new Set(["b", "i", "u", "s", "code", "a", "time", "mention"]);
const BLOCK_ELEMENTS = new Set(["div", "p"]);
const CLASS_PATTERN = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
const COLOR_CLASS_PATTERN = /^b?c-[\w-]+$/u;
const LEGACY_BREAK_PATTERN = /<br\s*\/?>/giu;

function isColorSpan(attributes: string): boolean
{
	const match = CLASS_PATTERN.exec(attributes);
	const classes = (match?.[1] ?? match?.[2] ?? "").split(/\s+/u);
	return classes.includes("colored") && classes.some((name) => COLOR_CLASS_PATTERN.test(name));
}

function decodeText(text: string): string
{
	return text.replaceAll("&nbsp;", " ").replaceAll(" ", " ");
}

function isKept(name: string, attributes: string): boolean
{
	return KEPT_ELEMENTS.has(name) || (name === "span" && isColorSpan(attributes));
}

/** Converts the note editor's innerHTML into stored note text (date pills back to canonical `<time>` markup). */
export function editorHtmlToNote(editorHtml: string): string
{
	const html = serializeDatePills(serializeMentionPills(editorHtml));
	let note = "";
	let cursor = 0;
	// For each open element, whether its open tag was emitted and so needs a close tag.
	const openElements:
	{
		name: string;
		kept: boolean;
	}[] = [];
	for (const match of html.matchAll(TAG_PATTERN))
	{
		note += decodeText(html.slice(cursor, match.index));
		cursor = match.index + match[0].length;
		const [tag, slash, rawName, attributes] = match;
		const name = (rawName ?? "").toLowerCase();
		const closing = slash === "/";
		if (name === "br")
		{
			// A block's trailing <br> is the browser's empty-line placeholder, not a line break.
			const placeholder = /^<\/(?:div|p)>/iu.test(html.slice(cursor)) || cursor === html.length;
			if (!placeholder)
			{
				note += "\n";
			}
		}
		else if (BLOCK_ELEMENTS.has(name))
		{
			if (!closing && note !== "")
			{
				note += "\n";
			}
		}
		else if (closing)
		{
			const index = openElements.findLastIndex((element) => element.name === name);
			if (index !== -1)
			{
				const [element] = openElements.splice(index, 1);
				if (element?.kept === true)
				{
					note += `</${name}>`;
				}
			}
		}
		else
		{
			const kept = isKept(name, attributes ?? "");
			if (kept)
			{
				note += name === "a" ? storedAnchorTag(anchorHref(tag)) : tag;
			}
			if (!tag.endsWith("/>"))
			{
				openElements.push(
					{
						name,
						kept,
					},
				);
			}
		}
	}
	return note + decodeText(html.slice(cursor));
}

/** Converts stored note text into the editor's initial HTML, repairing legacy `<br>` breaks. */
export function noteToEditorHtml(note: string): string
{
	return note.replaceAll(LEGACY_BREAK_PATTERN, "\n");
}

/**
 * The note `.content` element's inner HTML: `.innerContentContainer` around the note with its
 * #tags, @mentions, and links (stored and auto-detected) decorated like a name's, or nothing
 * for an empty note. `editorHtmlToNote` drops the decoration again, but stores an auto-link as a plain anchor.
 * Given `dateSettings`, stored `<time>` also renders as monolith pills, which the codec
 * serializes back to canonical `<time>` markup.
 */
export function noteContentHtml(
	note: string,
	dateSettings?: DateSettings,
	now?: Date,
	account: MentionAccount = null,
): string
{
	if (note === "")
	{
		return "";
	}
	const linked = renderLinks(noteToEditorHtml(note));
	const dated = dateSettings === undefined ? linked : renderDatePills(linked, dateSettings, now);
	const mentioned = renderMentionPills(dated, account);
	return `<span class="innerContentContainer">${addMonolithGuards(renderTags(mentioned))}</span>`;
}

/**
 * Decides whether the note editor's HTML needs saving against the last saved note. A blank
 * (whitespace-only) note saves as `""`; an unchanged note is skipped.
 */
export function planNoteSave(
	initial: string,
	html: string,
):
{
	save: boolean;
	note: string;
}
{
	const converted = editorHtmlToNote(html);
	const note = converted.trim() === "" ? "" : converted;
	return {
		save: note !== initial,
		note,
	};
}

export interface NoteKeyInput
{
	key: string;
	shift: boolean;
	/** The note's plain text. */
	text: string;
	/** Selection offsets into `text`. */
	start: number;
	end: number;
	/** The caret is on the note's first / last line. */
	onFirstLine: boolean;
	onLastLine: boolean;
}

export type NoteKeyPlan =
	|
	  {
			kind: "native";
	  }
	|
	  {
			kind: "noop";
	  }
	|
	  {
			kind: "insert";
			text: string;
			caret: number;
	  }
	|
	  {
			kind: "focusName";
			caret: 0 | "end";
	  }
	|
	  {
			kind: "focusNextRowName";
	  }
	|
	  {
			kind: "clearAndFocusName";
	  }
	|
	  {
			kind: "appendSentinelThenNative";
	  };

/**
 * Upstream's in-note key handling: Enter and Tab insert text (never split or indent rows),
 * Backspace in a blank note returns to the name, and arrows leave the note at its edges.
 */
export function planNoteKey({key, shift, text, start, end, onFirstLine, onLastLine}: NoteKeyInput): NoteKeyPlan
{
	const collapsed = start === end;
	const atStart = collapsed && start === 0;
	const atEnd = collapsed && end === text.length;
	switch (key)
	{
		case "Enter":
		{
			if (shift)
			{
				return {
					kind: "focusName",
					caret: "end",
				};
			}
			// A trailing newline renders no line, so a second one holds the new empty line open.
			return {
				kind: "insert",
				text: end === text.length ? "\n\n" : "\n",
				caret: start + 1,
			};
		}
		case "Tab":
		{
			return shift
				?
					{
						kind: "noop",
					}
				:
					{
						kind: "insert",
						text: "\t",
						caret: start + 1,
					};
		}
		case "Backspace":
		{
			if (text.trim() === "")
			{
				return {
					kind: "clearAndFocusName",
				};
			}
			// Upstream appends a trailing "\n" first, so the native delete keeps the last line rendered.
			return collapsed && !text.endsWith("\n")
				?
					{
						kind: "appendSentinelThenNative",
					}
				:
					{
						kind: "native",
					};
		}
		case "ArrowUp":
		{
			return !shift && atStart && onFirstLine
				?
					{
						kind: "focusName",
						caret: 0,
					}
				:
					{
						kind: "native",
					};
		}
		case "ArrowDown":
		{
			return !shift && atEnd && onLastLine
				?
					{
						kind: "focusNextRowName",
					}
				:
					{
						kind: "native",
					};
		}
		case "ArrowLeft":
		{
			return !shift && atStart
				?
					{
						kind: "focusName",
						caret: "end",
					}
				:
					{
						kind: "native",
					};
		}
		case "ArrowRight":
		{
			return !shift && atEnd
				?
					{
						kind: "focusNextRowName",
					}
				:
					{
						kind: "native",
					};
		}
		default:
		{
			return {
				kind: "native",
			};
		}
	}
}

/**
 * Wraps text nodes typed directly into the note `.content` in `.innerContentContainer`, like upstream, and
 * restores the caret to the same text offset.
 */
export function wrapBareNoteText(element: HTMLElement): void
{
	if (element.querySelector(".innerContentContainer") !== null || element.firstChild === null)
	{
		return;
	}
	const selection = globalThis.getSelection();
	let offset: number | null = null;
	if (selection !== null && selection.rangeCount > 0)
	{
		const range = selection.getRangeAt(0);
		if (element.contains(range.startContainer))
		{
			const before = document.createRange();
			before.selectNodeContents(element);
			before.setEnd(range.startContainer, range.startOffset);
			offset = before.toString().length;
		}
	}
	const wrapper = document.createElement("span");
	wrapper.className = "innerContentContainer";
	wrapper.append(...element.childNodes);
	element.append(wrapper);
	if (offset !== null)
	{
		placeCaretAtTextOffset(wrapper, offset);
	}
}
