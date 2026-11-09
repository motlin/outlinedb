import {parseNestedQuery, parseQuery} from "@outlinedb/shared/search";
import type {QueryNode} from "@outlinedb/shared/search";
import {isFeatureOn} from "./features.js";
import {decodeSegment} from "./tag-render.js";

/** A half-open `[start, end)` range of plain-text offsets. */
export type PlainRange = readonly [number, number];

const HTML_TAG_PATTERN = /<[^>]*>/gu;
const OPEN = '<span class="contentMatch">';
const CLOSE = "</span>";

/** The plain text of `html`: markup dropped, entities decoded. */
function htmlPlainText(html: string): string {
	return html
		.split(HTML_TAG_PATTERN)
		.map((text) => decodeSegment(text).plain)
		.join("");
}

/** Wraps one text run's characters that fall inside `ranges`, given the run's first plain offset. */
function highlightRun(html: string, plainStart: number, ranges: readonly PlainRange[]): string {
	const {plain, htmlOffsets} = decodeSegment(html);
	const plainEnd = plainStart + plain.length;
	let out = "";
	let cursor = 0;
	for (const [start, end] of ranges) {
		const from = Math.max(start, plainStart) - plainStart;
		const to = Math.min(end, plainEnd) - plainStart;
		if (from >= to) {
			continue;
		}
		const htmlFrom = htmlOffsets[from] ?? html.length;
		const htmlTo = htmlOffsets[to] ?? html.length;
		out += `${html.slice(cursor, htmlFrom)}${OPEN}${html.slice(htmlFrom, htmlTo)}${CLOSE}`;
		cursor = htmlTo;
	}
	return out + html.slice(cursor);
}

/**
 * Upstream's search `.contentMatch` highlight: wraps the sorted, disjoint plain-text `ranges` of `html` in
 * `<span class="contentMatch">`, split at element boundaries so existing markup survives.
 */
export function highlightHtml(html: string, ranges: readonly PlainRange[]): string {
	if (ranges.length === 0) {
		return html;
	}
	let out = "";
	let plainOffset = 0;
	let cursor = 0;
	const pushText = (text: string): void => {
		out += highlightRun(text, plainOffset, ranges);
		plainOffset += decodeSegment(text).plain.length;
	};
	for (const match of html.matchAll(HTML_TAG_PATTERN)) {
		pushText(html.slice(cursor, match.index));
		out += match[0];
		cursor = match.index + match[0].length;
	}
	pushText(html.slice(cursor));
	return out;
}

let parsed: {query: string; nested: boolean; node: QueryNode} | null = null;

/** The parsed `query`, kept for the last query so every rendered row shares one parse. */
function parsedQuery(query: string): QueryNode {
	const nested = isFeatureOn("nested_search");
	if (parsed === null || parsed.query !== query || parsed.nested !== nested) {
		parsed = {query, nested, node: (nested ? parseNestedQuery(query)?.highlight : undefined) ?? parseQuery(query)};
	}
	return parsed.node;
}

/** Highlights the text matches of the committed search `query` in rendered `html`; unchanged when not searching. */
export function highlightSearchMatches(html: string, query: string): string {
	if (query === "" || html === "") {
		return html;
	}
	const node = parsedQuery(query);
	if (node.isEmpty()) {
		return html;
	}
	return highlightHtml(html, node.ranges(htmlPlainText(html)));
}
