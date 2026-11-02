// Pure helpers for splitting and joining Workflowy rich-text names at plain-text offsets.
// Inline formatting tags survive a split (closed in `before`, reopened in `after`) and
// identical tags meeting at a join are merged back together. A `<time>` or `<mention>` element (a
// date or mention pill) is atomic: one plain-text character that is never split.

import {colorFromCss, isColorName} from "../color-palette.js";
import type {ColorName} from "../color-palette.js";

const FORMAT_TAGS = new Set(["b", "i", "u", "s", "code", "a", "span"]);

type Token =
	|
	  {
			kind: "open";
			name: string;
			raw: string;
	  }
	|
	  {
			kind: "close";
			name: string;
			raw: string;
	  }
	|
	  {
			kind: "other";
			raw: string;
	  }
	|
	  {
			kind: "char";
			raw: string;
	  };

const TOKEN_PATTERN =
	/<time\b[^>]*>[\s\S]*?<\/time>|<mention\b[^>]*>[\s\S]*?<\/mention>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);|[\s\S]/gu;

function tokenize(html: string): Token[]
{
	const tokens: Token[] = [];
	for (const match of html.matchAll(TOKEN_PATTERN))
	{
		const raw = match[0];
		const name = match[2]?.toLowerCase();
		if (name === undefined)
		{
			tokens.push(
				{
					kind: "char",
					raw,
				},
			);
		}
		else if (!FORMAT_TAGS.has(name))
		{
			tokens.push(
				{
					kind: "other",
					raw,
				},
			);
		}
		else if (match[1] === "/")
		{
			tokens.push(
				{
					kind: "close",
					name,
					raw,
				},
			);
		}
		else
		{
			tokens.push(
				{
					kind: "open",
					name,
					raw,
				},
			);
		}
	}
	return tokens;
}

interface OpenTag
{
	name: string;
	raw: string;
}

function applyTag(stack: OpenTag[], token: Token): void
{
	if (token.kind === "open")
	{
		stack.push(
			{
				name: token.name,
				raw: token.raw,
			},
		);
	}
	else if (token.kind === "close")
	{
		const index = stack.findLastIndex((open) => open.name === token.name);
		if (index !== -1)
		{
			stack.splice(index, 1);
		}
	}
}

// Walks tokens until the plain-text character at `offset`, returning that token index and
// the tags open at that point.
function walkTo(
	tokens: Token[],
	offset: number,
):
{
	index: number;
	stack: OpenTag[];
}
{
	const stack: OpenTag[] = [];
	let count = 0;
	for (const [index, token] of tokens.entries())
	{
		if (token.kind === "char")
		{
			if (count === offset)
			{
				return {
					index,
					stack,
				};
			}
			count++;
		}
		applyTag(stack, token);
	}
	return {
		index: tokens.length,
		stack,
	};
}

const EMPTY_PAIR = /<(b|i|u|s|code|a|span)(?:\s[^>]*)?><\/\1>/giu;

function stripEmptyTags(html: string): string
{
	let previous: string;
	let current = html;
	do
	{
		previous = current;
		current = current.replaceAll(EMPTY_PAIR, "");
	}
	while (current !== previous);
	return current;
}

function joinRaw(tokens: Token[]): string
{
	return tokens.map((token) => token.raw).join("");
}

/** The raw token of the plain-text character at `offset` and `html` without it, or null past the end. */
export function plainCharAt(
	html: string,
	offset: number,
):
{
	raw: string;
	without: string;
} | null
{
	const tokens = tokenize(html);
	const {index} = walkTo(tokens, offset);
	const token = tokens[index];
	if (token === undefined)
	{
		return null;
	}
	return {
		raw: token.raw,
		without: joinRaw(tokens.toSpliced(index, 1)),
	};
}

export function plainLength(html: string): number
{
	return tokenize(html).filter((token) => token.kind === "char").length;
}

const NAMED_ENTITIES: Record<string, string> =
{
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00A0",
};

function decodeEntity(raw: string): string
{
	const code = /^&#(x?)([0-9a-f]+);$/iu.exec(raw);
	if (code)
	{
		return String.fromCodePoint(Number.parseInt(code[2] ?? "", code[1] ? 16 : 10));
	}
	return NAMED_ENTITIES[raw.slice(1, -1).toLowerCase()] ?? raw;
}

/** Plain text of `html`, one character per plain-text unit: each `<time>` and `<mention>` pill becomes `pillChar`. */
export function plainText(html: string, pillChar: string): string
{
	return tokenize(html)
		.filter((token) => token.kind === "char")
		.map(({raw}) =>
			raw.startsWith("<time") || raw.startsWith("<mention")
				? pillChar
				: raw.startsWith("&")
					? decodeEntity(raw)
					: raw,
		)
		.join("");
}

const WHITESPACE_CHAR = /^(?:\s|&nbsp;|&#160;|&#xa0;)$/iu;

// Plain-text length with trailing whitespace (including nbsp) removed.
export function trimmedPlainLength(html: string): number
{
	const chars = tokenize(html).filter((token) => token.kind === "char");
	const lastText = chars.findLastIndex((token) => !WHITESPACE_CHAR.test(token.raw));
	return lastText + 1;
}

// Splits `html` at plain-text offsets; the text between `start` and `end` is dropped.
export function splitHtml(
	html: string,
	start: number,
	end: number,
):
{
	before: string;
	after: string;
}
{
	const tokens = tokenize(html);
	const head = walkTo(tokens, start);
	const tail = walkTo(tokens, end);
	const closes = head.stack
		.toReversed()
		.map((open) => `</${open.name}>`)
		.join("");
	const opens = tail.stack.map((open) => open.raw).join("");
	return {
		before: stripEmptyTags(joinRaw(tokens.slice(0, head.index)) + closes),
		after: stripEmptyTags(opens + joinRaw(tokens.slice(tail.index))),
	};
}

// Joins two rich-text strings, merging tags that close at the end of `a` and reopen
// identically at the start of `b`.
export function concatHtml(a: string, b: string): string
{
	const left = tokenize(a);
	const right = tokenize(b);
	for (;;)
	{
		const last = left.at(-1);
		const first = right[0];
		if (last?.kind !== "close" || first?.kind !== "open" || last.name !== first.name)
		{
			break;
		}
		const stack: OpenTag[] = [];
		for (const token of left.slice(0, -1))
		{
			applyTag(stack, token);
		}
		const matching = stack.findLast((open) => open.name === last.name);
		if (matching?.raw !== first.raw)
		{
			break;
		}
		left.pop();
		right.shift();
	}
	return joinRaw(left) + joinRaw(right);
}

// ---- Attribute-model inline formatting, like upstream's AttrString.toggleAttribute ----

export type InlineAttr = "b" | "i" | "u" | "s" | "code";

/** A maximal run of plain-text characters inside one tag; `raw` is its opening tag. */
export interface InlineSpan
{
	start: number;
	end: number;
	name: string;
	raw: string;
}

/** Plain-text characters (raw markup, so entities and `<time>` pills stay intact) plus tag spans. */
export interface InlineModel
{
	chars: string[];
	spans: InlineSpan[];
	tail: string;
}

export type ColorKind = "text" | "highlight";

export interface ColorChoice
{
	kind: ColorKind;
	color: ColorName;
}

/** Upstream's inline markup for a color attribute: `ColoredText` is `c-X`, `ColoredBackground` is `bc-X`. */
function colorRaw({kind, color}: ColorChoice): string
{
	return `<span class="colored ${kind === "text" ? "c" : "bc"}-${color}">`;
}

const COLOR_SPAN = /^<span class="colored (b?)c-([a-z]+)">$/u;

function colorOf(tag: OpenTag): ColorChoice | undefined
{
	const match = tag.name === "span" ? COLOR_SPAN.exec(tag.raw) : null;
	const color = match?.[2];
	return match === null || !isColorName(color)
		? undefined
		:
			{
				kind: match[1] === "b" ? "highlight" : "text",
				color,
			};
}

function attributeValue(raw: string, name: string): string | undefined
{
	return new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "iu").exec(raw)?.[1];
}

function styleValue(style: string, property: string): string | undefined
{
	for (const declaration of style.split(";"))
	{
		const [name, ...rest] = declaration.split(":");
		if (name?.trim().toLowerCase() === property)
		{
			return rest.join(":").trim();
		}
	}
	return undefined;
}

/**
 * Reads upstream's color attribute off a `<span>`: a `c-X` or `bc-X` class, or an inline `color` or
 * `background-color` that is exactly a palette shade. Such a span is re-emitted in the canonical class
 * form. Any other span stays opaque and keeps its raw tag.
 */
function canonicalSpan(raw: string): string
{
	const classes = attributeValue(raw, "class")?.split(/\s+/u) ?? [];
	for (const name of classes)
	{
		const match = /^(b?)c-([a-z]+)$/u.exec(name);
		if (match !== null && isColorName(match[2]))
		{
			return colorRaw(
				{
					kind: match[1] === "b" ? "highlight" : "text",
					color: match[2],
				},
			);
		}
	}
	const style = attributeValue(raw, "style");
	if (style !== undefined)
	{
		const background = colorFromCss(styleValue(style, "background-color") ?? "");
		if (background !== undefined)
		{
			return colorRaw(
				{
					kind: "highlight",
					color: background,
				},
			);
		}
		const text = colorFromCss(styleValue(style, "color") ?? "");
		if (text !== undefined)
		{
			return colorRaw(
				{
					kind: "text",
					color: text,
				},
			);
		}
	}
	return raw;
}

// Outermost first. `a` and `span` (colored text) are opaque: kept with their raw opening tag.
const NESTING_ORDER = ["code", "a", "span", "i", "u", "s", "b"];

// Non-format tags (other than `<time>` pills) ride along with the next character, or `tail`.
function charTags(html: string):
{
	chars: string[];
	tags: OpenTag[][];
	tail: string;
}
{
	const chars: string[] = [];
	const tags: OpenTag[][] = [];
	const stack: OpenTag[] = [];
	let pendingOther = "";
	for (const token of tokenize(html))
	{
		if (token.kind === "other")
		{
			pendingOther += token.raw;
		}
		else if (token.kind === "char")
		{
			chars.push(pendingOther + token.raw);
			pendingOther = "";
			tags.push(dedupeTags(stack));
		}
		else
		{
			applyTag(
				stack,
				token.kind === "open" && token.name === "span"
					?
						{
							...token,
							raw: canonicalSpan(token.raw),
						}
					: token,
			);
		}
	}
	return {
		chars,
		tags,
		tail: pendingOther,
	};
}

function isOpaque(name: string): boolean
{
	return name === "a" || name === "span";
}

function dedupeTags(stack: OpenTag[]): OpenTag[]
{
	const result: OpenTag[] = [];
	for (const open of stack)
	{
		if (isOpaque(open.name) || !result.some((other) => other.name === open.name))
		{
			result.push(
				isOpaque(open.name)
					? open
					:
						{
							name: open.name,
							raw: `<${open.name}>`,
						},
			);
		}
	}
	return result;
}

function sameTag(a: OpenTag, b: OpenTag): boolean
{
	return a.name === b.name && a.raw === b.raw;
}

export function parseInline(html: string): InlineModel
{
	const {chars, tags, tail} = charTags(html);
	const spans: InlineSpan[] = [];
	const open: InlineSpan[] = [];
	for (const [index, current] of tags.entries())
	{
		for (const span of open.splice(0))
		{
			if (current.some((tag) => sameTag(tag, span)))
			{
				open.push(span);
			}
			else
			{
				spans.push(span);
			}
		}
		for (const tag of current)
		{
			const running = open.find((span) => sameTag(span, tag));
			if (running)
			{
				running.end = index + 1;
			}
			else
			{
				open.push(
					{
						start: index,
						end: index + 1,
						name: tag.name,
						raw: tag.raw,
					},
				);
			}
		}
	}
	spans.push(...open);
	return {
		chars,
		spans: spans.toSorted((a, b) => a.start - b.start || b.end - a.end),
		tail,
	};
}

function nestingRank(tag: OpenTag): number
{
	return NESTING_ORDER.indexOf(tag.name);
}

/** Serializes `model` with canonical nesting: `code > a > span > i > u > s > b`, outermost first. */
export function serializeInline(model: InlineModel): string
{
	const tags = model.chars.map((_, index) =>
		model.spans
			.filter((span) => span.start <= index && index < span.end)
			.map(({name, raw}) => (
			{
				name,
				raw,
			}))
			.toSorted((a, b) => nestingRank(a) - nestingRank(b)),
	);
	return serializeTags(model.chars, tags, model.tail);
}

function serializeTags(chars: string[], tags: OpenTag[][], tail: string): string
{
	let html = "";
	let stack: OpenTag[] = [];
	for (const [index, raw] of chars.entries())
	{
		const wanted = (tags[index] ?? []).toSorted((a, b) => nestingRank(a) - nestingRank(b));
		let common = 0;
		for (const [position, tag] of wanted.entries())
		{
			const current = stack[position];
			if (current === undefined || !sameTag(current, tag))
			{
				break;
			}
			common = position + 1;
		}
		html += closeTags(stack.slice(common));
		html += wanted
			.slice(common)
			.map((tag) => tag.raw)
			.join("");
		stack = wanted;
		html += raw;
	}
	return html + closeTags(stack) + tail;
}

function closeTags(stack: OpenTag[]): string
{
	return stack
		.toReversed()
		.map((tag) => `</${tag.name}>`)
		.join("");
}

function withAttr(tags: OpenTag[], attr: InlineAttr): boolean
{
	return tags.some((tag) => tag.name === attr);
}

/** True when every character in `start..end` carries `attr` (false for an empty range). */
export function hasAttr(html: string, start: number, end: number, attr: InlineAttr): boolean
{
	const {tags} = charTags(html);
	const range = tags.slice(start, end);
	return range.length > 0 && range.length === end - start && range.every((current) => withAttr(current, attr));
}

/** True when any `attr` span overlaps `start..end` (upstream's `spans.touched`), so a collapsed caret inside or at a span's end counts. */
export function touchesAttr(html: string, start: number, end: number, attr: InlineAttr): boolean
{
	return parseInline(html).spans.some(
		(span) =>
			span.name === attr &&
			((start <= span.start && span.start < end) ||
				(start < span.end && span.end <= end) ||
				(span.start <= start && start < span.end) ||
				(span.start < end && end <= span.end)),
	);
}

const COLORED_SPAN = /class="[^"]*(?:\bcolored\b|\bc-|\bbc-)|style="(?:[^"]*[\s;])?(?:background-)?color\s*:/u;

/** True when a colored (text color or highlight) span overlaps `start..end`. */
export function touchesColor(html: string, start: number, end: number): boolean
{
	return parseInline(html).spans.some(
		(span) =>
			span.name === "span" &&
			COLORED_SPAN.test(span.raw) &&
			((start <= span.start && span.start < end) ||
				(start < span.end && span.end <= end) ||
				(span.start <= start && start < span.end) ||
				(span.start < end && end <= span.end)),
	);
}

/** The colors that cover every character of `start..end` (the caret's character when collapsed), by kind. */
export function colorAt(
	html: string,
	start: number,
	end: number,
):
{
	text?: ColorName;
	highlight?: ColorName;
}
{
	const {tags} = charTags(html);
	const range = tags.slice(start, Math.max(end, start + 1));
	const result:
	{
		text?: ColorName;
		highlight?: ColorName;
	} = {};
	for (const kind of ["text", "highlight"] as const)
	{
		const first = range[0]?.map(colorOf).find((choice) => choice?.kind === kind);
		if (
			first !== undefined &&
			range.every((current) =>
				current.some((tag) => colorOf(tag)?.kind === kind && colorOf(tag)?.color === first.color),
			)
		)
		{
			result[kind] = first.color;
		}
	}
	return result;
}

/**
 * Upstream's `caret.toggle` over the exclusive ColoredText/ColoredBackground group. `null` clears both kinds. A
 * `kind` + `color` already covering the whole range is removed. Otherwise both kinds are cleared on the range
 * and the new one set.
 */
export function toggleColor(html: string, start: number, end: number, kind: ColorKind, color: ColorName | null): string
{
	const {chars, tags, tail} = charTags(html);
	const whole =
		color !== null &&
		end > start &&
		tags.slice(start, end).length === end - start &&
		tags
			.slice(start, end)
			.every((current) => current.some((tag) => colorOf(tag)?.kind === kind && colorOf(tag)?.color === color));
	const toggled = tags.map((current, index) =>
	{
		if (index < start || index >= end)
		{
			return current;
		}
		const without = current.filter((tag) => colorOf(tag) === undefined);
		return color === null || whole
			? without
			: [
					...without,
					{
						name: "span",
						raw: colorRaw(
							{
								kind,
								color,
							},
						),
					},
				];
	});
	return serializeTags(chars, toggled, tail);
}

/** The characters of a `<time>` or `<mention>` pill's text, each as a plain-text unit. */
function pillTextChars(raw: string): string[]
{
	return tokenize(raw.replaceAll(/<[^>]*>/gu, ""))
		.filter((token) => token.kind === "char")
		.map((token) => token.raw);
}

const PILL_CHAR = /<(?:time|mention)\b/u;

/** Removes `attr` from `start..end` when the whole range has it, otherwise sets it on the whole range. */
export function toggleAttr(html: string, start: number, end: number, attr: InlineAttr): string
{
	const remove = hasAttr(html, start, end, attr);
	const {chars, tags, tail} = charTags(html);
	const toggled = tags.map((current, index) =>
	{
		if (index < start || index >= end)
		{
			return current;
		}
		// Code is atomic upstream: setting it drops the links inside the range.
		const without = current.filter((tag) => tag.name !== attr && !(attr === "code" && !remove && tag.name === "a"));
		return remove
			? without
			: [
					...without,
					{
						name: attr,
						raw: `<${attr}>`,
					},
				];
	});
	if (remove || attr !== "code")
	{
		return serializeTags(chars, toggled, tail);
	}
	// ... and it turns the dates and mentions inside the range back into their text.
	const expandedChars: string[] = [];
	const expandedTags: OpenTag[][] = [];
	for (const [index, raw] of chars.entries())
	{
		const unit = index >= start && index < end && PILL_CHAR.test(raw) ? pillTextChars(raw) : [raw];
		for (const char of unit)
		{
			expandedChars.push(char);
			expandedTags.push(toggled[index] ?? []);
		}
	}
	return serializeTags(expandedChars, expandedTags, tail);
}

export interface ItemField
{
	id: string;
	field: "name" | "note";
	html: string;
}

/**
 * Upstream `toggleAttributeForItems`: the fields lacking `attr` get it (all fields lose it when none lacks it), each
 * over its whole text. Empty fields are skipped.
 */
export function planItemsAttrToggle(fields: readonly ItemField[], attr: InlineAttr): ItemField[]
{
	const filled = fields.filter(({html}) => plainLength(html) > 0);
	const lacking = filled.filter(({html}) => !hasAttr(html, 0, plainLength(html), attr));
	return (lacking.length > 0 ? lacking : filled).map((entry) => (
	{
		...entry,
		html: toggleAttr(entry.html, 0, plainLength(entry.html), attr),
	}));
}

/** Upstream's item-selection `toggle_code`: every non-empty field flips on its own. */
export function planItemsCodeToggle(fields: readonly ItemField[]): ItemField[]
{
	return fields
		.filter(({html}) => plainLength(html) > 0)
		.map((entry) => (
		{
			...entry,
			html: toggleAttr(entry.html, 0, plainLength(entry.html), "code"),
		}));
}

/**
 * Upstream's `toggleAttributeForItems` for the latest color: the non-empty fields lacking `latest` over their whole
 * text get it (all of them lose it when none lacks it).
 */
export function planItemsColorToggle(fields: readonly ItemField[], latest: ColorChoice): ItemField[]
{
	const filled = fields.filter(({html}) => plainLength(html) > 0);
	const lacking = filled.filter(({html}) =>
	{
		const at = colorAt(html, 0, plainLength(html));
		return at[latest.kind] !== latest.color;
	});
	return (lacking.length > 0 ? lacking : filled).map((entry) => (
	{
		...entry,
		html: toggleColor(entry.html, 0, plainLength(entry.html), latest.kind, latest.color),
	}));
}

/** "Remove color" over items: both color kinds come off the whole text of every non-empty field that has one. */
export function planItemsColorClear(fields: readonly ItemField[]): ItemField[]
{
	return fields
		.filter(({html}) => plainLength(html) > 0 && touchesColor(html, 0, plainLength(html)))
		.map((entry) => (
		{
			...entry,
			html: toggleColor(entry.html, 0, plainLength(entry.html), "text", null),
		}));
}

export function planInlineToggle(
	html: string,
	sel:
	{
		start: number;
		end: number;
	},
	attr: InlineAttr,
):
{
	html: string;
	sel:
	{
		start: number;
		end: number;
	};
}
{
	const toggled = toggleAttr(html, sel.start, sel.end, attr);
	// Setting code can turn pills into their longer text, which moves the end of the selection.
	const grown = plainLength(toggled) - plainLength(html);
	return {
		html: toggled,
		sel:
		{
			start: sel.start,
			end: sel.end + grown,
		},
	};
}

/**
 * Upstream's `sd1`: the text strictly between the backticks at `open` and `close` (plain-text offsets) becomes
 * code, both backticks are removed, and `addSpace` appends a plain space.
 */
export function codeBetweenBackticks(html: string, open: number, close: number, addSpace: boolean): string
{
	const {chars, tags, tail} = charTags(html);
	const resultChars: string[] = [];
	const resultTags: OpenTag[][] = [];
	for (const [index, raw] of chars.entries())
	{
		if (index === open || index === close - 1)
		{
			continue;
		}
		const inside = index > open && index < close - 1;
		resultChars.push(raw);
		resultTags.push(
			inside
				? [
						...(tags[index] ?? []).filter((tag) => tag.name !== "code" && tag.name !== "a"),
						{
							name: "code",
							raw: "<code>",
						},
					]
				: (tags[index] ?? []),
		);
		if (addSpace && index === close - 2)
		{
			resultChars.push(" ");
			resultTags.push([]);
		}
	}
	return serializeTags(resultChars, resultTags, tail);
}

const ESCAPES: Record<string, string> =
{
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
};

/**
 * Inserts the typed `char` at plain-text `pos`. It inherits the simple formatting of the
 * preceding character, and each pending attribute toggles on top of that.
 */
export function pendingFormatApply(
	html: string,
	pos: number,
	attrs: ReadonlySet<InlineAttr>,
	char: string,
	color?: ColorChoice,
): string
{
	const {chars, tags, tail} = charTags(html);
	let inherited = (tags[pos - 1] ?? []).filter((tag) => !isOpaque(tag.name));
	for (const attr of attrs)
	{
		inherited = withAttr(inherited, attr)
			? inherited.filter((tag) => tag.name !== attr)
			: [
					...inherited,
					{
						name: attr,
						raw: `<${attr}>`,
					},
				];
	}
	if (color !== undefined)
	{
		inherited = [
			...inherited,
			{
				name: "span",
				raw: colorRaw(color),
			},
		];
	}
	const escaped = char.replaceAll(/[&<>]/gu, (match) => ESCAPES[match] ?? match);
	return serializeTags(chars.toSpliced(pos, 0, escaped), tags.toSpliced(pos, 0, inherited), tail);
}
