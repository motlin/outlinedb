import {placeSelectionAtTextOffsets, selectionTextOffsets} from "./caret-dom.js";
import {renderDatePills, serializeDatePills} from "./date-pills.js";
import {autoLink, decorateStoredLinks, storeAnchors} from "./link-render.js";
import type {DateSettings} from "./date-settings.js";
import {renderMentionPills, serializeMentionPills} from "./mention-pills.js";
import type {MentionAccount} from "./mention-pills.js";
import {addMonolithGuards} from "./monolith-guards.js";
import {renderTags, stripTagMarkup} from "./tag-render.js";

/** Stored name HTML as the name editor shows it: atomic date and mention pills and colored `.contentTag` spans. */
export function renderEditorHtml(html: string, dateSettings: DateSettings, account: MentionAccount = null): string
{
	return addMonolithGuards(
		renderTags(renderMentionPills(renderDatePills(autoLink(decorateStoredLinks(html)), dateSettings), account)),
	);
}

const ENTITIES: Readonly<Record<string, string>> =
{
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00A0",
};

function decodeEntities(text: string): string
{
	return text.replaceAll(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, ...groups: (string | undefined)[]) =>
	{
		const [decimal, hex, name] = groups;
		if (decimal !== undefined)
		{
			return String.fromCodePoint(Number(decimal));
		}
		if (hex !== undefined)
		{
			return String.fromCodePoint(Number.parseInt(hex, 16));
		}
		return ENTITIES[(name ?? "").toLowerCase()] ?? match;
	});
}

/**
 * Upstream shows a code block's name as plain text: every tag (formatting, links, colors, date pills) is dropped
 * but its text kept, and `\n` and spaces stay exactly as written. Tags, mentions and links are never rendered.
 */
export function renderCodeBlockHtml(html: string): string
{
	const text = decodeEntities(html.replaceAll(/<[^>]*>/gu, ""));
	const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	// A final newline needs a <br> after it to show as an empty last line.
	return text.endsWith("\n") ? `${escaped}<br>` : escaped;
}

/** The name editor's innerHTML back to stored HTML: tag spans unwrapped, date pills to canonical `<time>`. */
export function serializeEditorHtml(html: string): string
{
	// A trailing <br> is the editor's placeholder that keeps a final newline visible, never part of the name.
	return serializeMentionPills(serializeDatePills(stripTagMarkup(storeAnchors(html)))).replace(/<br\s*\/?>$/iu, "");
}

/** An IME composition is in progress, so the DOM under it must not be rewritten. */
export function isComposingInput(event: Event | undefined): boolean
{
	return event instanceof InputEvent && event.isComposing;
}

function tagSignature(root: ParentNode): string
{
	return [...root.querySelectorAll<HTMLElement>(".contentTag")]
		.map((tag) => `${tag.dataset.val ?? ""}\u0000${tag.textContent}`)
		.join("\u0001");
}

/**
 * Swap in `html`, the editor's text freshly rendered, when its tag spans differ from the
 * editor's, keeping the selection. Like upstream, which re-renders tags on every edit, a
 * tag colors on each keystroke while it is typed (`#w`, `#wo`, ...) and uncolors when broken.
 */
export function retagEditor(editor: HTMLElement, html: string): void
{
	const rendered = document.createElement("template");
	rendered.innerHTML = html;
	if (tagSignature(rendered.content) === tagSignature(editor))
	{
		return;
	}
	const {start, end} = selectionTextOffsets(editor);
	editor.innerHTML = html;
	placeSelectionAtTextOffsets(editor, start, end);
}
