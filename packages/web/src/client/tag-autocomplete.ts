import {getEndingTagText} from "@outlinedb/shared/tags";
import {splitHtml} from "./rich-text.js";

/**
 * Pure tag-autocomplete rules, mirroring upstream's tagging controller and `autocompleteTagText`.
 */

const SEGMENT = String.raw`[^(),.!?;:/[\]\s]`;

/** `[#@]` followed by `seg(:seg?)*`; the body may be empty so a bare `#` keeps the popup attached. */
const QUERY_PATTERN = new RegExp(String.raw`^[#@](?:${SEGMENT}+(?::${SEGMENT}*)*)?$`, "iu");

export interface AutocompleteResult {
	tag: string;
}

export interface AcceptedText {
	text: string;
	caret: number;
}

/** The editor the autocomplete runs in: its item, which field, and that field's live plain text. */
export interface LiveField {
	item: string;
	field: "name" | "note";
	text: string;
}

/** The autocomplete endpoint's query, carrying the live field so the server counts it as upstream does. */
export function autocompleteSearch({
	root,
	prefix,
	item,
	field,
	text,
}: {root: string; prefix: string} & LiveField): string {
	return new URLSearchParams({root, prefix, limit: "8", fallback: "1", item, [field]: text}).toString();
}

export function attach(textBeforeCaret: string): {start: number} | null {
	const ending = getEndingTagText(textBeforeCaret);
	return ending === undefined ? null : {start: textBeforeCaret.length - ending.length};
}

export function currentQuery(plain: string, start: number, caret: number): string | null {
	if (caret <= start) {
		return null;
	}
	const query = plain.slice(start, caret);
	return QUERY_PATTERN.test(query) ? query : null;
}

/** Results that still match a longer query, so the list holds steady while the next query loads. */
export function narrowResults(results: readonly AutocompleteResult[], query: string): AutocompleteResult[] {
	const lowered = query.toLowerCase();
	return results.filter((result) => result.tag.toLowerCase().startsWith(lowered));
}

export function shouldShow(results: readonly AutocompleteResult[], query: string): boolean {
	if (results.length === 0) {
		return false;
	}
	return !(results.length === 1 && results[0]?.tag === query);
}

export function applyAccept(plain: string, start: number, caret: number, chosen: string): AcceptedText {
	let end = start;
	while (end < caret && plain[end]?.toLowerCase() === chosen[end - start]?.toLowerCase()) {
		end++;
	}
	const next = plain[end];
	const needsSpace = (next === undefined || !/\s/u.test(next)) && !chosen.endsWith(":");
	const inserted = needsSpace ? `${chosen} ` : chosen;
	return {text: plain.slice(0, start) + inserted + plain.slice(end), caret: start + inserted.length};
}

/** Stored rich `html` with plain-text units `[start, end)` replaced by the accepted tag text. */
export function spliceAcceptedTag(html: string, edit: {start: number; end: number; inserted: string}): string {
	const {before, after} = splitHtml(html, edit.start, edit.end);
	const escaped = edit.inserted.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return before + escaped + after;
}
