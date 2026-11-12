import {concatHtml, splitHtml} from "./rich-text.js";

/**
 * Pure planning for the `[[` inline link popup (upstream `editor-links.inline`, `Fm1`): where the bracket pair
 * is, when to close it, and what the pair becomes once a target is picked.
 */

export interface BracketMatch
{
	index: number;
	text: string;
}

const NO_MATCH: BracketMatch =
{
	index: -1,
	text: "",
};

/**
 * The `[[…]]` pair the caret sits in: the last `[[` before the caret and the first `]]` after it. A port of
 * `Fm1.getMatch`; `{index: -1, text: ""}` when either side is missing.
 */
export function bracketMatch(
	text: string,
	caret: number,
	pair =
	{
		left: "[[",
		right: "]]",
	},
): BracketMatch
{
	const start = text.slice(0, caret).lastIndexOf(pair.left);
	const end = text.slice(caret).indexOf(pair.right);
	if (start === -1 || end === -1)
	{
		return NO_MATCH;
	}
	return {
		index: start,
		text: text.slice(start, caret + end + pair.right.length),
	};
}

/** The text between the brackets: the popup's filter. */
export function innerText(match: BracketMatch): string
{
	return match.text.slice(2, -2);
}

/**
 * Typing the second `[` of `[[` inserts the closing `]]` at the caret, unless a `]]` already follows it.
 */
export function planAutoClose(
	text: string,
	caret: number,
):
{
	insertAt: number;
	text: "]]";
} | null
{
	const before = text.slice(0, caret);
	const after = text.slice(caret);
	return before.endsWith("[[") && !after.includes("]]")
		?
			{
				insertAt: caret,
				text: "]]",
			}
		: null;
}

function escapeHtml(text: string): string
{
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Replace the whole `[[…]]` range of `html` (stored name HTML; offsets count plain-text units) with the target's
 * name as a link, followed by one space, with the caret after that space.
 */
export function planLinkInsert(
	html: string,
	match: BracketMatch,
	label: string,
	href: string,
):
{
	html: string;
	caret: number;
}
{
	const {before, after} = splitHtml(html, match.index, match.index + match.text.length);
	const anchor = `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a> `;
	return {
		html: concatHtml(concatHtml(before, anchor), after),
		caret: match.index + label.length + 1,
	};
}

/**
 * The `insert_inline_link` command: `[[`, or ` [[` after a non-space character, inserted at the caret.
 */
export function planInsertInlineLink(
	text: string,
	caret: number,
):
{
	text: string;
	caret: number;
}
{
	const previous = text.slice(0, caret).at(-1);
	const insert = previous === undefined || /\s/u.test(previous) ? "[[" : " [[";
	return {
		text: text.slice(0, caret) + insert + text.slice(caret),
		caret: caret + insert.length,
	};
}
