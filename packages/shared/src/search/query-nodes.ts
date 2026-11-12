import {stripHtmlTags} from "../html/strip-tags.js";
import {normalizeForSearch, normalizeWithOffsets} from "./normalize.js";

/** A node as seen by the upstream-style search matcher (port of WF.Search.parseQuery). */
export interface SearchItem
{
	id: string;
	nameHtml: string;
	noteHtml: string;
	completedAt: number | null;
	createdAt: number | null;
	modifiedAt: number | null;
	layoutMode: string | null;
	childCount: number;
	isMirror: boolean;
	/** A backlink item (a mirror of a source under a target's references root), or the references root itself. */
	isBacklink: boolean;
	ancestorCompleted: boolean;
	/** The MIME type of the item's live (not deleted) attachment; absent or null without one. */
	fileType?: string | null;
	ancestors?: SearchItem[];
}

export interface MatchResult
{
	matches: boolean;
	nameMatches: boolean;
	noteMatches: boolean;
	metaMatches: boolean;
}

export type Range = [number, number];

export interface QueryNode
{
	matches(item: SearchItem): MatchResult;
	/** Highlight ranges on plain text: merged, sorted, in original-string offsets. */
	ranges(text: string): Range[];
	revealsCompleted(): boolean;
	isEmpty(): boolean;
	/** Whether the item carries the kind of value this node tests; negation only matches when true. */
	hasSearchTypeValue(item: SearchItem): boolean;
	canMetaMatch(): boolean;
}

export interface ParseQueryOptions
{
	now?: number;
	dateFormat?: string;
	/** 0 = Sunday (default), 1 = Monday. */
	weekStartDay?: 0 | 1;
}

/** What tokenizing a query depends on besides its text. */
export interface TokenContext
{
	now: number;
	dateFormat: string;
	weekStartDay: 0 | 1;
}

export interface OperatorContext extends TokenContext
{
	/** True when this token is the last one and the query has no trailing whitespace. */
	isLast: boolean;
}

/** A search operator (has:, is:, date:, ...). Registered in upstream insertion order in operators/index.ts. */
export interface SearchOperator
{
	name: string;
	/** Optionally claim a token longer than a whitespace-delimited word, starting at `start`. Returns its end offset. */
	parseToken?(query: string, start: number, context: TokenContext): number | null;
	/** Called with the lowercased token (without a leading "-"). */
	matchesToken(token: string, context: TokenContext): boolean;
	create(token: string, rawToken: string, context: OperatorContext): QueryNode;
}

export const NO_MATCH: MatchResult =
{
	matches: false,
	nameMatches: false,
	noteMatches: false,
	metaMatches: false,
};

export const QUOTE_PAIRS: ReadonlyMap<string, string> = new Map([
	['"', '"'],
	["«", "»"],
	["“", "”"],
	["❝", "❞"],
	["〝", "〞"],
]);

const WORD_CHAR = /[\p{L}\p{Nd}]/u;

interface PreparedText
{
	name: string;
	note: string;
}

const preparedCache = new WeakMap<SearchItem, PreparedText>();

export function prepare(item: SearchItem): PreparedText
{
	let prepared = preparedCache.get(item);
	if (!prepared)
	{
		prepared =
		{
			name: normalizeForSearch(stripHtmlTags(item.nameHtml)),
			note: normalizeForSearch(stripHtmlTags(item.noteHtml)),
		};
		preparedCache.set(item, prepared);
	}
	return prepared;
}

export function escapeRegExp(s: string): string
{
	return s.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function mergeRanges(ranges: Range[]): Range[]
{
	const sorted = ranges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: Range[] = [];
	for (const [start, end] of sorted)
	{
		const last = merged.at(-1);
		if (last && start <= last[1])
		{
			last[1] = Math.max(last[1], end);
		}
		else
		{
			merged.push([start, end]);
		}
	}
	return merged;
}

/** Matches text against a regexp with the match itself in capture group 2 (group 1 is the leading boundary). */
export abstract class TextNode implements QueryNode
{
	protected abstract readonly regexp: RegExp;

	matches(item: SearchItem): MatchResult
	{
		const {name, note} = prepare(item);
		const nameMatches = this.test(name);
		const noteMatches = this.test(note);
		return {
			matches: nameMatches || noteMatches,
			nameMatches,
			noteMatches,
			metaMatches: false,
		};
	}

	ranges(text: string): Range[]
	{
		const normalized = normalizeWithOffsets(text);
		const result: Range[] = [];
		for (const match of normalized.text.matchAll(this.regexp))
		{
			const start = match.index + (match[1]?.length ?? 0);
			const end = start + (match[2]?.length ?? 0);
			const originalStart = normalized.starts[start];
			const originalEnd = normalized.ends[end - 1];
			if (originalStart !== undefined && originalEnd !== undefined)
			{
				result.push([originalStart, originalEnd]);
			}
		}
		return mergeRanges(result);
	}

	revealsCompleted(): boolean
	{
		return false;
	}

	isEmpty(): boolean
	{
		return false;
	}

	hasSearchTypeValue(): boolean
	{
		return true;
	}

	canMetaMatch(): boolean
	{
		return false;
	}

	protected test(text: string): boolean
	{
		this.regexp.lastIndex = 0;
		return this.regexp.test(text);
	}
}

/** A word: must start at a word boundary, and end at one unless it is a prefix (the last token). */
export class TermNode extends TextNode
{
	protected readonly regexp: RegExp;

	constructor(term: string, prefix: boolean)
	{
		super();
		const leading = WORD_CHAR.test(term.at(0) ?? "") ? String.raw`(^|[^\p{L}\p{Nd}])` : "()";
		const trailing = !prefix && WORD_CHAR.test(term.at(-1) ?? "") ? String.raw`(?=$|[^\p{L}\p{Nd}])` : "";
		this.regexp = new RegExp(`${leading}(${escapeRegExp(term)})${trailing}`, "gu");
	}
}

/** A literal substring with no word boundaries (quoted phrases, CJK-only terms). */
export class SubstringNode extends TextNode
{
	protected readonly regexp: RegExp;

	constructor(text: string)
	{
		super();
		this.regexp = new RegExp(`()(${escapeRegExp(text)})`, "gu");
	}
}
