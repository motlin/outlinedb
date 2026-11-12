import {codeBetweenBackticks, hasAttr, plainLength, plainText, splitHtml} from "./rich-text.js";

/** One plain-text unit stands for each date or mention pill, so offsets match `rich-text`'s characters. */
const PILL = "￼";

const BACKTICK = "`";
const TWO_SPACES = /[  ]{2}$/u;

function chars(html: string): string[]
{
	// oxlint-disable-next-line typescript/no-misused-spread -- rich-text counts code points, so each one is a character
	return [...plainText(html, PILL)];
}

interface Edit
{
	html: string;
	caret: number;
}

/** Upstream's `sd1` over the typed caret `s` (after the typed backtick), clamped to the text length. */
function convert(html: string, caret: number, open: number, close: number, addSpace: boolean): Edit
{
	const result = codeBetweenBackticks(html, open, close, addSpace);
	return {
		html: result,
		caret: Math.min(caret - 1 + (addSpace ? 1 : 0), plainLength(result)),
	};
}

/** The text between the nearest backticks around the caret becomes code (upstream's check after every input). */
function betweenBackticks({html, caret}: Edit): Edit | null
{
	const text = chars(html);
	const before = text.slice(0, caret);
	const after = text.slice(caret);
	const open = before.lastIndexOf(BACKTICK);
	const closeAt = after.indexOf(BACKTICK);
	if (open === -1 || closeAt === -1)
	{
		return null;
	}
	return convert(html, caret, open, closeAt + caret + 1, false);
}

/**
 * Upstream's `editor.input.inline-code`, run on the stored HTML after the browser inserted `typed` and left a
 * collapsed caret at plain-text offset `caret` (after the typed text). Typing a closing or opening backtick turns
 * the text between the backticks into code; two spaces typed at the end of code leave it; a caret between two
 * backticks wraps them on any input. Returns null when nothing changes.
 */
export function planInlineCodeInput(html: string, caret: number, typed: string): Edit | null
{
	let state: Edit | null = null;
	const text = chars(html);
	const before = text.slice(0, caret);
	const after = text.slice(caret);
	if (typed === BACKTICK && !hasAttr(html, caret - 1, caret, "code"))
	{
		let open = before.slice(0, caret - 1).lastIndexOf(BACKTICK);
		let close = caret;
		const closing = open !== -1;
		if (!closing)
		{
			const next = after.indexOf(BACKTICK);
			if (next === -1)
			{
				return null;
			}
			open = caret - 1;
			close = next + 1 + caret;
		}
		if (close - open <= 2)
		{
			return null;
		}
		state = convert(html, caret, open, close, closing && after[0] !== " ");
	}
	else if (TWO_SPACES.test(before.join("")) && hasAttr(html, caret - 1, caret, "code"))
	{
		const {before: head, after: tail} = splitHtml(html, caret - 2, caret);
		state =
		{
			html: `${head} ${tail}`,
			caret: caret - 1,
		};
	}
	const between = betweenBackticks(
		state ??
		{
			html,
			caret,
		},
	);
	return between ?? state;
}
