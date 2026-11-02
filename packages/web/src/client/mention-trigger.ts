/** Pure planners for the `@` mention popup, ported from upstream's `editor.input.mention-autocomplete`. */

import {isPropping} from "./suggest/suggest-engine.js";

export const MENTION_CHIP_CLASS = "mention-input";

export interface MentionRange
{
	readonly start: number;
	readonly end: number;
}

/** Chip range for an `@` just typed at `atIndex`: a spaced symbol (at the start, after whitespace, or at the end). */
export function planMentionOpen(text: string, atIndex: number): MentionRange | null
{
	if (text[atIndex] !== "@")
	{
		return null;
	}
	if (isPropping(text[atIndex - 1]) && isPropping(text[atIndex + 1]))
	{
		return null;
	}
	return {
		start: atIndex,
		end: atIndex + 1,
	};
}

/** Range of a resting `@tag` that ends at the caret, to re-wrap as a chip after a deletion. */
export function planMentionRearm(text: string, caret: number): MentionRange | null
{
	const before = text.slice(0, caret);
	const at = before.lastIndexOf("@");
	if (at === -1 || /\s/u.test(before.slice(at)) || (at > 0 && isPropping(before[at - 1])))
	{
		return null;
	}
	if (isPropping(text[caret]))
	{
		return null;
	}
	return {
		start: at,
		end: caret,
	};
}

const MENTION_CHIP_PATTERN = new RegExp(`<span class="${MENTION_CHIP_CLASS}">([^<]*)</span>`, "gu");

/** Unwraps any mention chip span to its plain text so a live chip is never persisted. */
export function stripMentionChip(html: string): string
{
	return html.replaceAll(MENTION_CHIP_PATTERN, "$1");
}
