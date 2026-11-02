import {stripHtmlTags} from "../html/strip-tags.js";
import {normalizeForSearch, normalizeWithOffsets} from "./normalize.js";

/** Upstream's switcher word characters: letters, digits, `#` and `@`. */
const WORD_REGEXP = /[\p{L}\p{N}#@]+/giu;
const START_OF_WORD_CHUNK = String.raw`([^\p{L}\p{N}#@]|^)`;

export interface FieldMatch
{
	score: number;
	html: string;
}

export interface SwitcherRowInput
{
	name: string;
	note: string;
	starLabel: string | null;
}

export interface SwitcherRowMatch
{
	labelHtml: string;
	searchHtml: string | null;
}

/** Normalise the query and split it into upstream's switcher words. */
export function splitIntoWords(query: string): string[]
{
	return normalizeForSearch(query).match(WORD_REGEXP) ?? [];
}

function escapeHtml(text: string): string
{
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function wordRegExp(word: string): RegExp
{
	// Words only hold letters, digits, # and @, so they need no regexp escaping.
	return new RegExp(`${START_OF_WORD_CHUNK}(${word})`, "giu");
}

/** `text` HTML-escaped with each `[start, end)` range wrapped in `<b><u>`. */
export function highlight(text: string, ranges: [number, number][]): string
{
	const marked = Array.from(
		{
			length: text.length,
		},
		() => false,
	);
	for (const [start, end] of ranges)
	{
		marked.fill(true, start, end);
	}
	let html = "";
	let i = 0;
	while (i < text.length)
	{
		let j = i;
		while (j < text.length && marked[j] === marked[i])
		{
			j++;
		}
		const chunk = escapeHtml(text.slice(i, j));
		html += marked[i] ? `<b><u>${chunk}</u></b>` : chunk;
		i = j;
	}
	return html;
}

/**
 * Match every word at a word start in `text` (upstream `C21`). Score is hits / text length;
 * each hit is wrapped in `<b><u>` on the HTML-escaped original text. Any missed word scores 0.
 */
export function matchField(words: readonly string[], text: string): FieldMatch
{
	const normalized = normalizeWithOffsets(text);
	const ranges: [number, number][] = [];
	for (const word of words)
	{
		const regexp = wordRegExp(word);
		let hit = false;
		for (const match of normalized.text.matchAll(regexp))
		{
			hit = true;
			const [, prefix = "", hitText = ""] = match;
			const start = match.index + prefix.length;
			const end = start + hitText.length;
			ranges.push([normalized.starts[start] ?? 0, normalized.ends[end - 1] ?? text.length]);
		}
		if (!hit)
		{
			return {
				score: 0,
				html: escapeHtml(text),
			};
		}
	}
	return {
		score: text.length === 0 ? 0 : ranges.length / text.length,
		html: highlight(text, ranges),
	};
}

/**
 * Match a switcher row (upstream `QN2`): the name's plain text, then the raw name, then the note,
 * then the star label. Returns null when the query has words and no field matches them all.
 */
export function matchSwitcherRow(row: SwitcherRowInput, query: string): SwitcherRowMatch | null
{
	const words = splitIntoWords(query);
	const plainName = stripHtmlTags(row.name);
	const label = matchField(words, plainName);
	const nameScore = label.score || matchField(words, row.name).score;
	const noteScore = matchField(words, stripHtmlTags(row.note)).score;
	const search = row.starLabel === null ? null : matchField(words, row.starLabel);
	if (words.length > 0 && nameScore === 0 && noteScore === 0 && (search?.score ?? 0) === 0)
	{
		return null;
	}
	return {
		labelHtml: label.html,
		searchHtml: search?.html ?? null,
	};
}
