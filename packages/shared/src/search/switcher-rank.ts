import {normalizeForSearch} from "./normalize.js";

/** Upstream's jump-menu ranking (`wf-search-index.worker.js`): a static per-node score times a text factor. */

const DAY_SEC = 86_400;
const RECENCY_WINDOW_DAYS = 360;
const RECENCY_LO = 0.1;
const RECENCY_HI = 10;
const STARRED_FACTOR = 20;

export interface StaticScoreInput
{
	depth: number;
	childCount: number;
	completed: boolean;
	/** Absolute epoch seconds of the last edit, or null when never modified. */
	lastModifiedSec: number | null;
	joinedSec: number;
	nowSec: number;
	layoutMode: string | null;
	starred: boolean;
	/** The raw name HTML: upstream's tag and markup boosts read the markup itself, attributes included. */
	name: string;
}

/**
 * Upstream `_b`. Upstream stores `lm` relative to the join date, so the absolute
 * `lastModifiedSec` is shifted by `joinedSec` before comparing against the window.
 */
function recencyFactor(lastModifiedSec: number | null, joinedSec: number, nowSec: number): number
{
	if (lastModifiedSec === null || lastModifiedSec === 0)
	{
		return RECENCY_LO;
	}
	const lm = lastModifiedSec - joinedSec;
	const age = Math.floor(nowSec - joinedSec);
	const windowStart = age - RECENCY_WINDOW_DAYS * DAY_SEC;
	if (lm < windowStart)
	{
		return RECENCY_LO;
	}
	const progress = (lm - windowStart) / ((age - windowStart) / 100);
	return RECENCY_LO + ((RECENCY_HI - RECENCY_LO) / 100) * progress;
}

/** Upstream `Ne`: a `#tag` or `@tag` doubles the score. */
function tagFactor(text: string): number
{
	return /#[\d\w]+/u.test(text) || /@[\d\w]+/u.test(text) ? 2 : 1;
}

/** Upstream `De`: bold, underline or italic markup doubles the score. */
function markupFactor(text: string): number
{
	return /<b>.*<\/b>/u.test(text) || /<u>.*<\/u>/u.test(text) || /<i>.*<\/i>/u.test(text) ? 2 : 1;
}

/** Upstream's name-index boost: tags, mentions and bold/underline/italic markup, read from the raw HTML. */
export function nameBoost(name: string): number
{
	return tagFactor(name) * markupFactor(name);
}

/** Product of upstream's static criteria: depth, children, completion, recency, layout and star. */
export function baseScore(input: Omit<StaticScoreInput, "name">): number
{
	const depthFactor = 1 / (1 + input.depth / 10);
	const childFactor = input.childCount === 0 ? 0.1 : input.childCount > 5 ? 2 : 1;
	const completedFactor = input.completed ? 1 : 2;
	const recency = recencyFactor(input.lastModifiedSec, input.joinedSec, input.nowSec);
	const layoutFactor = input.layoutMode === "h1" || input.layoutMode === "h2" ? 2 : 1;
	const starredFactor = input.starred ? STARRED_FACTOR : 1;
	return depthFactor * childFactor * completedFactor * recency * layoutFactor * starredFactor;
}

/** A name hit's static score: `baseScore` times the name boost. The note's tags and markup only boost the note index. */
export function staticScore(input: StaticScoreInput): number
{
	return baseScore(input) * nameBoost(input.name);
}

/** Upstream `y0`. */
function nameTextFactor(query: string, name: string): number
{
	return name.length === 0 ? 0 : (query.length / name.length) * 10;
}

/** Upstream `Le`, for a name hit that also hits the note. */
function noteTextFactor(query: string, note: string): number
{
	return note.length === 0 ? 0 : (query.length / note.length) * 0.1;
}

/**
 * Query-dependent factor: name hits weigh 100x note hits, and a hit in both multiplies the two.
 * Callers score Home as Infinity so it always ranks first.
 */
export function textFactor(query: string, name: string, note: string, nameHit: boolean, noteHit: boolean): number
{
	// A note-only hit scores 0 (see below); `noteHit` only matters next to a name hit.
	if (nameHit && noteHit)
	{
		return nameTextFactor(query, name) * noteTextFactor(query, note);
	}
	if (nameHit)
	{
		return nameTextFactor(query, name);
	}
	// Deliberate parity: upstream calls `Le` with one argument for a note-only hit, which returns 0, so every
	// note-only row ranks after every name hit.
	return 0;
}

export interface ResolveJoinedSecInput
{
	/** The `/api/v1/account` answer, or null when the internal API is not configured (503). */
	account:
	{
		joinedAt: string;
	} | null;
	earliestCreatedSec: number;
}

/** The account join date in epoch seconds, falling back to the earliest cached `created_at`. */
export function resolveJoinedSec({account, earliestCreatedSec}: ResolveJoinedSecInput): number
{
	return account ? Math.floor(Date.parse(account.joinedAt) / 1000) : earliestCreatedSec;
}

const NAMED_ENTITIES: Record<string, string> =
{
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00A0",
	copy: "\u00A9",
	reg: "\u00AE",
	hellip: "\u2026",
	mdash: "\u2014",
	ndash: "\u2013",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201C",
	rdquo: "\u201D",
	bull: "\u2022",
	middot: "\u00B7",
	deg: "\u00B0",
	euro: "\u20AC",
};

/** Decodes named and numeric HTML entities in one pass; an unknown or invalid entity stays as written. */
export function decodeHtmlEntities(text: string): string
{
	return text.replaceAll(
		/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(\w+));/gu,
		(whole, dec?: string, hex?: string, name?: string) =>
		{
			if (name !== undefined)
			{
				return NAMED_ENTITIES[name] ?? whole;
			}
			const code = dec === undefined ? Number.parseInt(hex ?? "", 16) : Math.trunc(Number(dec));
			return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : whole;
		},
	);
}

/**
 * Upstream `zb`: the text whose length ranks a hit. Tags drop, then NFD + mark strip + lowercase (which also drops
 * U+FE0F and splits Hangul into jamo), then entities decode. Nothing is trimmed.
 */
export function indexText(raw: string): string
{
	return decodeHtmlEntities(normalizeForSearch(raw.replaceAll(/<[^>]*>/gu, "")));
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Upstream `JF2`: a multi-month `<time startMonth startYear endMonth endYear>` range adds its missing three-letter
 * month names to the text (all twelve for a span of a year or more), so a month name finds the range.
 */
export function withMonthNames(raw: string): string
{
	const extra: string[] = [];
	for (const [tag] of raw.matchAll(/<time\b[^>]*>/gu))
	{
		const attr = (name: string): number | null =>
		{
			const value = new RegExp(`\\b${name}="(\\d+)"`, "u").exec(tag)?.[1];
			return value === undefined ? null : Number(value);
		};
		const startMonth = attr("startMonth");
		const startYear = attr("startYear");
		const endMonth = attr("endMonth");
		const endYear = attr("endYear");
		if (startMonth === null || startYear === null || endMonth === null || endYear === null)
		{
			continue;
		}
		const span = (endYear - startYear) * 12 + (endMonth - startMonth);
		if (span <= 0)
		{
			continue;
		}
		const months =
			span >= 11
				? MONTH_NAMES
				: Array.from(
						{
							length: span + 1,
						},
						(_, i) => MONTH_NAMES[(startMonth - 1 + i) % 12] ?? "",
					);
		extra.push(...months);
	}
	return extra.length === 0 ? raw : `${raw} ${extra.join(" ")}`;
}
