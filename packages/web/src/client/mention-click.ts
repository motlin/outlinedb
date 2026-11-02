import {MENTION_PATTERN, resolveMentionName} from "./mention-pills.js";
import type {MentionAccount} from "./mention-pills.js";
import {plainLength} from "./rich-text.js";

/** The name a pill click searches for: the participants name for id 0 ("Everyone", not the pill's "everyone"), else the pill's own. */
function mentionSearchName(id: string, account: MentionAccount): string
{
	return id === "0" ? "Everyone" : resolveMentionName(id, account);
}

export function mentionSearchQuery(id: string, account: MentionAccount): string
{
	return `mentioned:"${mentionSearchName(id, account)}"`;
}

/** The stored HTML without its `ordinal`th `<mention>`, and the caret (plain-text units) where it was; null when there is none. */
export function removeMentionFromHtml(
	html: string,
	ordinal: number,
):
{
	html: string;
	caret: number;
} | null
{
	const match = [...html.matchAll(MENTION_PATTERN)][ordinal];
	if (match === undefined)
	{
		return null;
	}
	return {
		html: html.slice(0, match.index) + html.slice(match.index + match[0].length),
		caret: plainLength(html.slice(0, match.index)),
	};
}
