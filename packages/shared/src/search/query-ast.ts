import {normalizeForSearch} from "./normalize.js";
import {SEARCH_OPERATORS} from "./operators/index.js";
import {mergeRanges, NO_MATCH, QUOTE_PAIRS, SubstringNode, TermNode} from "./query-nodes.js";
import type
{
	MatchResult,
	OperatorContext,
	ParseQueryOptions,
	QueryNode,
	Range,
	SearchItem,
	TokenContext,
} from "./query-nodes.js";

export {SEARCH_OPERATORS} from "./operators/index.js";
export type
{
	MatchResult,
	OperatorContext,
	ParseQueryOptions,
	QueryNode,
	Range,
	SearchItem,
	SearchOperator,
} from "./query-nodes.js";

const CJK_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

class NotNode implements QueryNode
{
	constructor(private readonly child: QueryNode)
	{
	}

	matches(item: SearchItem): MatchResult
	{
		const matches = !this.child.matches(item).matches && this.child.hasSearchTypeValue(item);
		return {
			matches,
			nameMatches: false,
			noteMatches: false,
			metaMatches: matches && this.child.canMetaMatch(),
		};
	}

	ranges(): Range[]
	{
		return [];
	}

	revealsCompleted(): boolean
	{
		return this.child.revealsCompleted();
	}

	isEmpty(): boolean
	{
		return this.child.isEmpty();
	}

	hasSearchTypeValue(): boolean
	{
		return true;
	}

	canMetaMatch(): boolean
	{
		return this.child.canMetaMatch();
	}
}

abstract class CompositeNode implements QueryNode
{
	constructor(protected readonly children: QueryNode[])
	{
	}

	abstract matches(item: SearchItem): MatchResult;

	ranges(text: string): Range[]
	{
		return mergeRanges(this.children.flatMap((child) => child.ranges(text)));
	}

	revealsCompleted(): boolean
	{
		return this.children.some((child) => child.revealsCompleted());
	}

	isEmpty(): boolean
	{
		return this.children.every((child) => child.isEmpty());
	}

	hasSearchTypeValue(item: SearchItem): boolean
	{
		return this.children.every((child) => child.hasSearchTypeValue(item));
	}

	canMetaMatch(): boolean
	{
		return this.children.some((child) => child.canMetaMatch());
	}
}

function orFlags(results: MatchResult[], matches: boolean): MatchResult
{
	return {
		matches,
		nameMatches: results.some((r) => r.nameMatches),
		noteMatches: results.some((r) => r.noteMatches),
		metaMatches: results.some((r) => r.metaMatches),
	};
}

class AndNode extends CompositeNode
{
	matches(item: SearchItem): MatchResult
	{
		const results: MatchResult[] = [];
		for (const child of this.children)
		{
			const result = child.matches(item);
			if (!result.matches)
			{
				return NO_MATCH;
			}
			results.push(result);
		}
		return orFlags(results, true);
	}
}

class OrNode extends CompositeNode
{
	matches(item: SearchItem): MatchResult
	{
		const results = this.children.map((child) => child.matches(item));
		return orFlags(
			results,
			results.some((r) => r.matches),
		);
	}
}

interface Token
{
	/** Token text without the leading "-". */
	text: string;
	negated: boolean;
	/** Inner text of a terminated quoted phrase, else null. */
	phrase: string | null;
}

function isWhitespace(ch: string | undefined): boolean
{
	return ch !== undefined && /\s/u.test(ch);
}

function wordEnd(query: string, start: number): number
{
	let end = start;
	while (end < query.length && !isWhitespace(query[end]))
	{
		end++;
	}
	return end;
}

function tokenize(query: string, context: TokenContext): Token[]
{
	const tokens: Token[] = [];
	let pos = 0;
	while (pos < query.length)
	{
		if (isWhitespace(query[pos]))
		{
			pos++;
			continue;
		}
		const negated = query[pos] === "-";
		const start = negated ? pos + 1 : pos;
		let end: number | null = null;
		let phrase: string | null = null;
		for (const operator of SEARCH_OPERATORS)
		{
			end = operator.parseToken?.(query, start, context) ?? null;
			if (end !== null)
			{
				break;
			}
		}
		const closer = QUOTE_PAIRS.get(query[start] ?? "");
		if (end === null && closer !== undefined)
		{
			const close = query.indexOf(closer, start + 1);
			if (close !== -1)
			{
				end = close + 1;
				phrase = query.slice(start + 1, close);
			}
		}
		end ??= wordEnd(query, start);
		tokens.push(
			{
				text: query.slice(start, end),
				negated,
				phrase,
			},
		);
		pos = end;
	}
	return tokens;
}

function buildToken(token: Token, context: OperatorContext): QueryNode | null
{
	if (token.phrase !== null)
	{
		const phrase = normalizeForSearch(token.phrase);
		return phrase.length === 0 ? null : new SubstringNode(phrase);
	}
	if (token.text.length === 0)
	{
		return null;
	}
	const lowered = token.text.toLowerCase();
	const operator = SEARCH_OPERATORS.find((op) => op.matchesToken(lowered, context));
	if (operator)
	{
		return operator.create(lowered, token.text, context);
	}
	const term = normalizeForSearch(token.text);
	if (term.length === 0)
	{
		return null;
	}
	return CJK_ONLY.test(term) ? new SubstringNode(term) : new TermNode(term, context.isLast);
}

function tokenContext(opts: ParseQueryOptions): TokenContext
{
	return {
		now: opts.now ?? Date.now(),
		dateFormat: opts.dateFormat ?? "YYYY-MM-DD",
		weekStartDay: opts.weekStartDay ?? 0,
	};
}

/** Parse a search query into an AST that matches SearchItems the way upstream Workflowy does. */
export function parseQuery(q: string, opts: ParseQueryOptions = {}): QueryNode
{
	const context = tokenContext(opts);
	const tokens = tokenize(q, context);
	const prefixLast = !isWhitespace(q.at(-1));
	let current: QueryNode[] = [];
	const groups: QueryNode[][] = [current];
	tokens.forEach((token, index) =>
	{
		if (!token.negated && token.phrase === null && token.text === "OR")
		{
			current = [];
			groups.push(current);
			return;
		}
		const node = buildToken(
			token,
			{
				...context,
				isLast: prefixLast && index === tokens.length - 1,
			},
		);
		if (node)
		{
			current.push(token.negated ? new NotNode(node) : node);
		}
	});
	const ands = groups.filter((group) => group.length > 0).map((group) => new AndNode(group));
	const [only, ...rest] = ands;
	return only && rest.length === 0 ? only : new OrNode(ands);
}

/** A nested `a > b > c` query: OR-groups of segments, each segment an ancestor (or, last, the row) filter. */
export interface NestedQuery
{
	groups: QueryNode[][];
	/** The last segment of every group, ORed: what upstream highlights (`iX1` keeps only the last segment). */
	highlight: QueryNode;
}

function tokenSource(token: Token): string
{
	return `${token.negated ? "-" : ""}${token.text}`;
}

const isOr = (token: Token): boolean => !token.negated && token.phrase === null && token.text === "OR";
const isNest = (token: Token): boolean => !token.negated && token.phrase === null && token.text === ">";

/**
 * Splits `q` into OR groups of `>`-separated segments. Returns null unless the query contains a standalone `>` token
 * outside a quoted phrase.
 */
export function parseNestedQuery(q: string, opts: ParseQueryOptions = {}): NestedQuery | null
{
	if (!q.includes(" > "))
	{
		return null;
	}
	const tokens = tokenize(q, tokenContext(opts));
	if (!tokens.some(isNest))
	{
		return null;
	}
	const groups = splitTokens(tokens, isOr).map((group) =>
		splitTokens(group, isNest).map((segment) => parseQuery(segment.map(tokenSource).join(" "), opts)),
	);
	return {
		groups,
		highlight: new OrNode(groups.flatMap((group) => group.slice(-1))),
	};
}

function splitTokens(tokens: Token[], isSeparator: (token: Token) => boolean): Token[][]
{
	const parts: Token[][] = [];
	let current: Token[] = [];
	for (const token of tokens)
	{
		if (isSeparator(token))
		{
			parts.push(current);
			current = [];
		}
		else
		{
			current.push(token);
		}
	}
	parts.push(current);
	return parts;
}

/**
 * Matches `item` against a nested query. `item.ancestors` lists its ancestors nearest first; walking up, each ancestor
 * that matches the current earlier segment consumes it (right to left), and non-matching ancestors are skipped. The
 * flags come from the last segment only.
 */
export function matchNested(nested: NestedQuery, item: SearchItem): MatchResult
{
	const results: MatchResult[] = [];
	for (const group of nested.groups)
	{
		const last = group.at(-1)?.matches(item);
		if (!last?.matches)
		{
			continue;
		}
		let index = group.length - 2;
		for (const ancestor of item.ancestors ?? [])
		{
			if (index < 0)
			{
				break;
			}
			if (group[index]?.matches(ancestor).matches === true)
			{
				index--;
			}
		}
		if (index < 0)
		{
			results.push(last);
		}
	}
	return orFlags(results, results.length > 0);
}
