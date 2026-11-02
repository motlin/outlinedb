// Port of upstream's search-helper insert logic (IM/sP/z62/Lu4/TM/L62): clicking a
// helper value toggles it, replaces any other member of its group, or replaces the
// word under the caret.

export interface HelperInsertResult
{
	query: string;
	caret: number;
}

const DATE_WORDS = [
	"today",
	"tomorrow",
	"yesterday",
	"this week",
	"next week",
	"last week",
	"this month",
	"next month",
	"last month",
];

const GROUPS: readonly (readonly string[])[] = [
	["changed:1h", "changed:1d", "changed:7d", "created:1h", "created:1d", "created:7d"],
	["changed-by:me", "changed-by:others"],
	DATE_WORDS,
];

interface Word
{
	text: string;
	index: number;
}

export function escapeRegExp(text: string): string
{
	return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function tokenMatch(query: string, value: string): RegExpMatchArray | null
{
	return query.match(new RegExp(String.raw`(\s|^)${escapeRegExp(value)}(\s|$)`, "iu"));
}

export function wordAt(query: string, caret: number): Word
{
	if (caret === 0 || query[caret - 1] === " ")
	{
		return {
			text: "",
			index: caret,
		};
	}
	let start = caret - 1;
	while (start > 0 && query[start - 1] !== " ")
	{
		start--;
	}
	let end = caret;
	while (end < query.length && query[end] !== " ")
	{
		end++;
	}
	return {
		text: query.slice(start, end),
		index: start,
	};
}

// Two-word date values ("next week") count as one word.
function wordWithDateAt(query: string, caret: number): Word
{
	const word = wordAt(query, caret);
	const next = query.slice(word.index).match(new RegExp(String.raw`^${escapeRegExp(word.text)}\s(\S+)(\s|$)`, "iu"));
	const pair = next ? `${word.text} ${next[1]}` : undefined;
	return pair !== undefined && DATE_WORDS.includes(pair)
		?
			{
				text: pair,
				index: word.index,
			}
		: word;
}

function replaceWordAt(query: string, caret: number, replacement: string): HelperInsertResult
{
	const word = wordWithDateAt(query, caret);
	const end = word.index + word.text.length;
	const before = query.slice(0, word.index);
	const after = query.slice(end + (query[end] === " " ? 1 : 0));
	return {
		query: `${before}${replacement}${after}`,
		caret: before.length + replacement.length,
	};
}

export interface ReplaceSearchWordOptions
{
	trailingSpace?: boolean;
	caretOffset?: number;
}

/** Upstream `WF.Search.replace`: swaps the word under the caret for `value`, with no toggle or group logic. */
export function replaceSearchWord(
	query: string,
	caret: number,
	value: string,
	{trailingSpace = true, caretOffset = 0}: ReplaceSearchWordOptions = {},
): HelperInsertResult
{
	const result = replaceWordAt(query, caret, trailingSpace ? `${value} ` : value);
	return {
		query: result.query,
		caret: result.caret + caretOffset,
	};
}

function removeOne(query: string, value: string, caret: number): HelperInsertResult
{
	const match = tokenMatch(query, value);
	if (match?.index === undefined)
	{
		return {
			query,
			caret,
		};
	}
	const start = match.index;
	const inToken = start + (match[1] ?? "").length + 1;
	const removedLength = wordWithDateAt(query, inToken).text.length + 1;
	const {query: removed} = replaceWordAt(query, inToken, "");
	if (caret <= start)
	{
		return {
			query: removed,
			caret,
		};
	}
	const inside = caret <= start + removedLength;
	return {
		query: removed,
		caret: inside ? start + (match[1] ? 1 : 0) : caret - removedLength,
	};
}

function removeAll(query: string, value: string, caret: number): HelperInsertResult
{
	let result =
	{
		query,
		caret,
	};
	while (tokenMatch(result.query, value))
	{
		const next = removeOne(result.query, value, result.caret);
		if (next.query === result.query)
		{
			break;
		}
		result = next;
	}
	return result;
}

function includesIgnoreCase(values: readonly string[], value: string): boolean
{
	const lower = value.toLowerCase();
	return values.some((candidate) => candidate.toLowerCase() === lower);
}

export function insertHelperValue(query: string, caret: number, value: string): HelperInsertResult
{
	const group = GROUPS.find((members) => includesIgnoreCase(members, value));
	const present = group ? group.filter((member) => tokenMatch(query, member)) : [];
	if (present.length > 0)
	{
		const cleared = present.reduce(
			(acc, member) => removeAll(acc.query, member, acc.caret),
			{
				query,
				caret,
			},
		);
		return includesIgnoreCase(present, value) ? cleared : insertHelperValue(cleared.query, cleared.caret, value);
	}
	if (tokenMatch(query, value))
	{
		return removeAll(query, value, caret);
	}
	return replaceWordAt(query, caret, value.endsWith(":") ? value : `${value} `);
}
