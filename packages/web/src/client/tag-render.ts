import {findTags} from "@outlinedb/shared/tags";
import {plainLength as caretUnitLength} from "./rich-text.js";
import {escapeRegExp} from "./search/helper-insert.js";

const ENTITIES: Readonly<Record<string, string>> =
{
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&nbsp;": " ",
};

const ENTITY_PATTERN = /^&(?:amp|lt|gt|quot|#39|nbsp);/u;
const HTML_TAG_PATTERN = /<[^>]*>/gu;
const UNTAGGABLE_ELEMENT_PATTERN = /^<(\/?)(a|code)(?=[\s>/])/iu;

interface TextSegment
{
	html: string;
	/** Offset of this segment's first plain character within the concatenated plain text. */
	plainStart: number;
	/** `htmlOffsets[i]` is the html offset of plain character i; one extra entry marks the end. */
	htmlOffsets: number[];
	taggable: boolean;
}

type Token =
	|
	  {
			kind: "markup";
			html: string;
	  }
	|
	  {
			kind: "text";
			segment: TextSegment;
	  };

/** Plain text of an HTML text run, with each plain character's html offset (plus one end entry). */
export function decodeSegment(html: string):
{
	plain: string;
	htmlOffsets: number[];
}
{
	let plain = "";
	const htmlOffsets: number[] = [];
	let index = 0;
	while (index < html.length)
	{
		const entity = ENTITY_PATTERN.exec(html.slice(index))?.[0];
		htmlOffsets.push(index);
		if (entity === undefined)
		{
			plain += html.charAt(index);
			index += 1;
		}
		else
		{
			plain += ENTITIES[entity] ?? entity;
			index += entity.length;
		}
	}
	htmlOffsets.push(index);
	return {
		plain,
		htmlOffsets,
	};
}

function tokenize(html: string):
{
	tokens: Token[];
	plain: string;
}
{
	const tokens: Token[] = [];
	let plain = "";
	let untaggableDepth = 0;
	let cursor = 0;
	const pushText = (text: string): void =>
	{
		if (text === "")
		{
			return;
		}
		const decoded = decodeSegment(text);
		tokens.push(
			{
				kind: "text",
				segment:
				{
					html: text,
					plainStart: plain.length,
					htmlOffsets: decoded.htmlOffsets,
					taggable: untaggableDepth === 0,
				},
			},
		);
		plain += decoded.plain;
	};
	for (const match of html.matchAll(HTML_TAG_PATTERN))
	{
		pushText(html.slice(cursor, match.index));
		tokens.push(
			{
				kind: "markup",
				html: match[0],
			},
		);
		const element = UNTAGGABLE_ELEMENT_PATTERN.exec(match[0]);
		if (element)
		{
			untaggableDepth = element[1] === "/" ? Math.max(0, untaggableDepth - 1) : untaggableDepth + 1;
		}
		cursor = match.index + match[0].length;
	}
	pushText(html.slice(cursor));
	return {
		tokens,
		plain,
	};
}

function escapeAttribute(value: string): string
{
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderSegment(
	segment: TextSegment,
	tags: readonly
	{
		index: number;
		tag: string;
	}[],
): string
{
	const plainLength = segment.htmlOffsets.length - 1;
	let out = "";
	let htmlCursor = 0;
	for (const {index, tag} of tags)
	{
		const start = index - segment.plainStart;
		const end = start + tag.length;
		if (start < 0 || end > plainLength)
		{
			continue;
		}
		const htmlStart = segment.htmlOffsets[start] ?? 0;
		const htmlAfterFirst = segment.htmlOffsets[start + 1] ?? htmlStart;
		const htmlEnd = segment.htmlOffsets[end] ?? htmlAfterFirst;
		out += `${segment.html.slice(
			htmlCursor,
			htmlStart,
		)}<span class="contentTag explosive" title="Filter ${escapeAttribute(tag)}" data-val="${escapeAttribute(tag.toLowerCase())}">${segment.html.slice(
			htmlStart,
			htmlAfterFirst,
		)}<span class="contentTagText">${segment.html.slice(htmlAfterFirst, htmlEnd)}</span><span class="contentTagNub"></span></span>`;
		htmlCursor = htmlEnd;
	}
	return out + segment.html.slice(htmlCursor);
}

/**
 * Wrap every #tag and @mention in stored rich-text HTML with upstream's
 * `.contentTag` markup. Text inside `<a>` and `<code>` is never tagged, and a
 * tag split across formatting elements is left as-is.
 */
export function renderTags(html: string): string
{
	const {tokens, plain} = tokenize(html);
	const tags = findTags(plain);
	if (tags.length === 0)
	{
		return html;
	}
	return tokens
		.map((token) =>
		{
			if (token.kind === "markup")
			{
				return token.html;
			}
			return token.segment.taggable ? renderSegment(token.segment, tags) : token.segment.html;
		})
		.join("");
}

/** Upstream's Flyout margin-top under the tag-color teaser. */
const TEASER_FLYOUT_MARGIN = 4;

/**
 * Where the tag-color teaser sits for a hovered tag: upstream anchors its Flyout at
 * `[right - 1, top - 6 + (height - 15) / 2]` and the Flyout adds a 4px top margin.
 */
export function teaserPosition(tag: {top: number; right: number; height: number}):
{
	left: number;
	top: number;
}
{
	return {
		left: tag.right - 1,
		top: tag.top - 6 + (tag.height - 15) / 2 + TEASER_FLYOUT_MARGIN,
	};
}

/**
 * Upstream tag click: remove `tag` from the search query when it is already there
 * (whole word, case-insensitive), otherwise append it; a non-empty result keeps
 * exactly one trailing space.
 */
export function toggleTagInQuery(query: string, tag: string): string
{
	const pattern = new RegExp(`(^|\\s)${escapeRegExp(tag)}(?=$|\\s)`, "giu");
	const next = pattern.test(query) ? query.replaceAll(pattern, "") : `${query.trimEnd()} ${tag}`;
	const trimmed = next.trim();
	return trimmed === "" ? "" : `${trimmed} `;
}

/** Plain offsets of the tags `renderTags` wraps: whole tags inside taggable text (not `<a>`/`<code>`). */
export function renderedTagStarts(html: string): number[]
{
	const {tokens, plain} = tokenize(html);
	const segments = tokens.flatMap((token) =>
		token.kind === "text" && token.segment.taggable ? [token.segment] : [],
	);
	return findTags(plain)
		.filter(({index, tag}) =>
			segments.some(
				(segment) =>
					index >= segment.plainStart &&
					index + tag.length <= segment.plainStart + segment.htmlOffsets.length - 1,
			),
		)
		.map(({index}) => index);
}

/** Upstream's tag-delete gesture: Meta-click on mac, Meta- or Alt-click elsewhere. */
export function isTagDeleteClick(
	event:
	{
		metaKey: boolean;
		altKey: boolean;
	},
	isMac: boolean,
): boolean
{
	return event.metaKey || (!isMac && event.altKey);
}

/** End of `tag` at `start` plus any following spaces and tabs, or undefined when `tag` is not there. */
function tagRemovalEnd(plain: string, start: number, tag: string): number | undefined
{
	if (plain.slice(start, start + tag.length) !== tag)
	{
		return undefined;
	}
	let end = start + tag.length;
	while (plain[end] === " " || plain[end] === "\t")
	{
		end += 1;
	}
	return end;
}

/** Upstream tag explode: remove `tag` at `start` plus following `[ \t]*`; the caret lands at `start`. */
export function removeTagAt(
	text: string,
	start: number,
	tag: string,
):
{
	text: string;
	caret: number;
}
{
	const end = tagRemovalEnd(text, start, tag);
	return {
		text: end === undefined ? text : text.slice(0, start) + text.slice(end),
		caret: start,
	};
}

/** `removeTagAt` on stored rich-text HTML: plain offsets map through each text run, markup stays intact. */
export function removeTagFromHtml(html: string, plainStart: number, tag: string): string
{
	const {tokens, plain} = tokenize(html);
	const plainEnd = tagRemovalEnd(plain, plainStart, tag);
	if (plainEnd === undefined)
	{
		return html;
	}
	return tokens
		.map((token) =>
		{
			if (token.kind === "markup")
			{
				return token.html;
			}
			const {html: text, plainStart: segmentStart, htmlOffsets} = token.segment;
			const from = Math.max(plainStart - segmentStart, 0);
			const to = Math.min(plainEnd - segmentStart, htmlOffsets.length - 1);
			if (from >= to)
			{
				return text;
			}
			return text.slice(0, htmlOffsets[from]) + text.slice(htmlOffsets[to]);
		})
		.join("");
}

/**
 * The editor caret offset of the tag at `plainStart`. Tag offsets count a `<time>` pill's
 * label character by character; caret offsets (`caret-dom.ts`) count each pill as one unit.
 */
export function tagCaretUnits(html: string, plainStart: number): number
{
	let htmlBefore = "";
	for (const token of tokenize(html).tokens)
	{
		if (token.kind === "markup")
		{
			htmlBefore += token.html;
			continue;
		}
		const {html: text, plainStart: segmentStart, htmlOffsets} = token.segment;
		if (plainStart < segmentStart + htmlOffsets.length - 1)
		{
			return caretUnitLength(htmlBefore + text.slice(0, htmlOffsets[Math.max(plainStart - segmentStart, 0)]));
		}
		htmlBefore += text;
	}
	return caretUnitLength(html);
}

const SPAN_PATTERN = /<(\/?)span\b([^>]*)>/giu;
const TAG_MARKUP_CLASS = /\bclass="[^"]*\bcontentTag(?:Text|Nub)?\b/u;

/**
 * Undo `renderTags`: unwrap every `.contentTag`, `.contentTagText`, and `.contentTagNub` span,
 * keeping their text and any other spans. Reads the live editor's innerHTML, so a tag span the
 * browser grew while typing still unwraps to its plain text.
 */
export function stripTagMarkup(html: string): string
{
	if (!html.includes("contentTag"))
	{
		return html;
	}
	// For each open span, whether it is tag markup (and so dropped along with its close tag).
	const open: boolean[] = [];
	return html.replaceAll(SPAN_PATTERN, (tag, slash: string, attributes: string) =>
	{
		if (slash === "/")
		{
			return open.pop() === true ? "" : tag;
		}
		const isTagMarkup = TAG_MARKUP_CLASS.test(attributes);
		open.push(isTagMarkup);
		return isTagMarkup ? "" : tag;
	});
}
