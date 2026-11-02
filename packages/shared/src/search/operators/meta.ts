import {normalizeForSearch} from "../normalize.js";
import {escapeRegExp, prepare, TermNode} from "../query-nodes.js";
import type {MatchResult, QueryNode, Range, SearchItem, SearchOperator} from "../query-nodes.js";

type Predicate = (item: SearchItem) => boolean;

interface MetaOptions
{
	revealsCompleted?: boolean;
	hasSearchTypeValue?: Predicate;
}

/** Port of upstream MetaMatchNode: matches on item metadata and reports `metaMatches` (whole-row highlight). */
export class MetaNode implements QueryNode
{
	constructor(
		private readonly predicate: Predicate,
		private readonly options: MetaOptions = {},
	)
	{
	}

	matches(item: SearchItem): MatchResult
	{
		const matches = this.predicate(item);
		return {
			matches,
			nameMatches: false,
			noteMatches: false,
			metaMatches: matches,
		};
	}

	ranges(): Range[]
	{
		return [];
	}

	revealsCompleted(): boolean
	{
		return this.options.revealsCompleted ?? false;
	}

	isEmpty(): boolean
	{
		return false;
	}

	hasSearchTypeValue(item: SearchItem): boolean
	{
		return this.options.hasSearchTypeValue?.(item) ?? true;
	}

	canMetaMatch(): boolean
	{
		return true;
	}
}

/** A term matched against the note only (`in:note:"words"`). */
class NoteTermNode extends TermNode
{
	override matches(item: SearchItem): MatchResult
	{
		const noteMatches = this.test(prepare(item).note);
		return {
			matches: noteMatches,
			nameMatches: false,
			noteMatches,
			metaMatches: false,
		};
	}
}

/** A term matched only on backlink items (`in:backlink:"words"`). */
class BacklinkTermNode extends TermNode
{
	override matches(item: SearchItem): MatchResult
	{
		return item.isBacklink
			? super.matches(item)
			:
				{
					matches: false,
					nameMatches: false,
					noteMatches: false,
					metaMatches: false,
				};
	}
}

const MATCH_NOTHING = new MetaNode(() => false);

/** An operator recognised by exact (lowercased) tokens. */
function exact(tokens: [string, ...string[]], predicate: Predicate, options?: MetaOptions): SearchOperator
{
	const node = new MetaNode(predicate, options);
	return {
		name: tokens[0],
		matchesToken: (token) => tokens.includes(token),
		create: () => node,
	};
}

/** An operator recognised by a prefix; `build` receives the lowercased value after the prefix. */
function prefixed(prefix: string, build: (value: string) => QueryNode): SearchOperator
{
	return {
		name: prefix,
		matchesToken: (token) => token.startsWith(prefix),
		create: (token) => build(token.slice(prefix.length)),
	};
}

function inHtml(pattern: RegExp): Predicate
{
	return (item) => pattern.test(item.nameHtml) || pattern.test(item.noteHtml);
}

function layout(...modes: string[]): Predicate
{
	return (item) => item.layoutMode !== null && modes.includes(item.layoutMode);
}

const SPAN_CLASS = /<span\b[^>]*\bclass="([^"]*)"/giu;

/** True when some `span.colored` in the name or note has a class accepted by `test`. */
function coloredSpan(test: (cls: string) => boolean): Predicate
{
	return (item) =>
		[item.nameHtml, item.noteHtml].some((html) =>
			[...html.matchAll(SPAN_CLASS)].some((match) =>
			{
				const classes = (match[1] ?? "").split(/\s+/u);
				return classes.includes("colored") && classes.some(test);
			}),
		);
}

const HREF = /<a\b[^>]*\bhref="([^"]*)"/giu;

function hrefs(item: SearchItem): string[]
{
	return [item.nameHtml, item.noteHtml].flatMap((html) => [...html.matchAll(HREF)].map((match) => match[1] ?? ""));
}

export const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "sky", "teal", "gray"];

const completed: Predicate = (item) => item.completedAt !== null;
const notUnderCompleted: Predicate = (item) => !item.ancestorCompleted;

export const isComplete = exact(
	["is:complete"],
	completed,
	{
		revealsCompleted: true,
		hasSearchTypeValue: notUnderCompleted,
	},
);
/** Local alias for upstream's `-is:complete`. */
export const isIncomplete = exact(["is:incomplete"], (item) => !completed(item) && notUnderCompleted(item));
export const isMirror = exact(["is:mirror"], (item) => item.isMirror);
export const isBacklink = exact(["is:backlink"], (item) => item.isBacklink);
export const isTodo = exact(["is:todo", "is:task"], layout("todo", "check"));
export const isDivider = exact(["is:divider"], layout("divider"));
export const hasNote = exact(["has:note"], (item) => item.noteHtml.trim().length > 0);
export const hasChildren = exact(["has:children"], (item) => item.childCount > 0);
// Upstream's regexes, verbatim: has:video and has:tweet test the name html, as the embeds do.
const YOUTUBE_LINK =
	/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch|v|embed|shorts)(?:\.php)?(?:\?.*v=|\/))([a-zA-Z0-9_-]+)/u;
const TWEET_LINK = /https?:\/\/(twitter|x)\.com\/(?:#!\/)?(\w+)\/status(es)?\/(\d+)/u;
export const hasFile = exact(
	["has:file"],
	(item) => item.fileType !== undefined && item.fileType !== null && !item.fileType.startsWith("image/"),
);
export const hasImage = exact(["has:image"], (item) => item.fileType?.startsWith("image/") === true);
export const hasVideo = exact(["has:video"], (item) => YOUTUBE_LINK.test(item.nameHtml));
export const hasTweet = exact(["has:tweet"], (item) => TWEET_LINK.test(item.nameHtml));
export const textBold = exact(["text:bold"], inHtml(/<b[\s>]/iu));
export const textItalic = exact(["text:italic"], inHtml(/<i[\s>]/iu));
export const textUnderline = exact(["text:underline"], inHtml(/<u[\s>]/iu));
export const textStrikethrough = exact(["text:strikethrough"], inHtml(/<s[\s>]/iu));
export const link = prefixed("link:", (value) =>
{
	const pattern = new RegExp(escapeRegExp(value), "iu");
	return new MetaNode((item) => hrefs(item).some((href) => pattern.test(href)));
});
export const isH1 = exact(["is:h1"], layout("h1"));
export const textH2 = exact(["text:h2"], layout("h2"));
export const textH3 = exact(["text:h3"], layout("h3"));
export const isParagraph = exact(["is:paragraph"], layout("p"));
export const id = prefixed("id:", (value) =>
{
	if (value.length === 0)
	{
		return MATCH_NOTHING;
	}
	const shortId = /^[0-9a-f]{12}$/u.test(value);
	return new MetaNode((item) =>
	{
		const itemId = item.id.toLowerCase();
		return itemId.startsWith(value) || (shortId && itemId.replaceAll("-", "").endsWith(value));
	});
});
export const hasDate = exact(["has:date"], inHtml(/<time\b/iu));
export const textCode = exact(["text:code"], inHtml(/<code[\s>]/iu));
export const textColored = exact(
	["text:colored"],
	coloredSpan((cls) => cls.startsWith("c-")),
);
export const textHighlighted = exact(
	["text:highlighted"],
	coloredSpan((cls) => cls.startsWith("bc-")),
);
export const textColor: SearchOperator =
{
	name: "text:<color>",
	matchesToken: (token) => token.startsWith("text:") && COLORS.includes(token.slice("text:".length)),
	create: (token) =>
	{
		const cls = `c-${token.slice("text:".length)}`;
		return new MetaNode(coloredSpan((c) => c === cls));
	},
};
export const highlightColor = prefixed("highlight:", (value) =>
	COLORS.includes(value) ? new MetaNode(coloredSpan((c) => c === `bc-${value}`)) : MATCH_NOTHING,
);
export const isCodeBlock = exact(["is:code-block"], layout("code-block"));
export const isQuote = exact(["is:quote"], layout("quote-block"));

const IN_NOTE = "in:note:";
const IN_NOTE_TOKEN = /in:note:"([\w\d\s]+)"/iuy;

export const inNote: SearchOperator =
{
	name: IN_NOTE,
	parseToken(query, start)
	{
		IN_NOTE_TOKEN.lastIndex = start;
		const match = IN_NOTE_TOKEN.exec(query);
		return match === null ? null : start + match[0].length;
	},
	matchesToken: (token) => /^in:note:"[\w\d\s]+"$/iu.test(token),
	create(token)
	{
		const term = normalizeForSearch(token.slice(IN_NOTE.length + 1, -1));
		return term.length === 0 ? MATCH_NOTHING : new NoteTermNode(term, true);
	},
};

const IN_BACKLINK = "in:backlink:";
const IN_BACKLINK_TOKEN = /in:backlink:"([^"\r\n]+)"/iuy;

export const inBacklink: SearchOperator =
{
	name: IN_BACKLINK,
	parseToken(query, start)
	{
		IN_BACKLINK_TOKEN.lastIndex = start;
		const match = IN_BACKLINK_TOKEN.exec(query);
		return match === null ? null : start + match[0].length;
	},
	matchesToken: (token) => /^in:backlink:"[^"\r\n]+"$/iu.test(token),
	create(token)
	{
		const term = normalizeForSearch(token.slice(IN_BACKLINK.length + 1, -1));
		return term.length === 0 ? MATCH_NOTHING : new BacklinkTermNode(term, true);
	},
};
