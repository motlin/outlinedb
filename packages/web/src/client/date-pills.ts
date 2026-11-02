import
{
	canonicalTimeAttributes,
	domTimeAttributes,
	findDatePhrase,
	formatTimeLabel,
	parseTimeAttrs,
	parseTimeAttrsLoose,
	toTimeMarkup,
} from "@outlinedb/shared";
import type {DatePhrase, TimeAttrs} from "@outlinedb/shared";
import {plainCharAt, plainLength, plainText, splitHtml} from "./rich-text.js";
import type {DateSettings} from "./date-settings.js";

const BOM = "﻿";
const PILL_ATTRS =
	'data-monolith="true" contenteditable="false" class="explosive monolith-pill" title="⌥click to search"';
// <time> elements never nest, so a lazy match up to the first close tag is exact.
const TIME_PATTERN = /<time\b([^>]*)>[\s\S]*?<\/time>/giu;

/** Display-mode HTML: each stored `<time>` becomes upstream's non-editable monolith pill. */
export function renderDatePills(html: string, settings: DateSettings, now: Date = new Date()): string
{
	const rendered = html.replaceAll(TIME_PATTERN, (_match, attrText: string) =>
	{
		const parsed = parseTimeAttrsLoose(attrText);
		const label = formatTimeLabel(
			parsed,
			{
				dateFormat: settings.dateFormat,
				timeFormat: settings.timeFormat,
				now,
			},
		);
		const attrs = domTimeAttributes(parsed);
		return `<time ${`${PILL_ATTRS} ${attrs}`.trim()}>${BOM}<span class="content-wrapper">${label}</span>${BOM}</time>`;
	});
	// Upstream puts one U+FEFF guard between two adjacent pills (the outer guards come from addMonolithGuards).
	return rendered.replaceAll(/<\/time><time\b/gu, `</time>${BOM}<time`);
}

/**
 * Stored HTML from editor HTML: each `<time>` (a rendered pill or a raw element) becomes
 * canonical camelCase markup with markup-format inner text, and the pills' U+FEFF caret
 * guards are dropped. A `<time>` without a full start date keeps its text, attributes camelCased.
 */
export function serializeDatePills(html: string): string
{
	return html
		.replaceAll(TIME_PATTERN, (match, attrText: string) =>
		{
			try
			{
				return toTimeMarkup(parseTimeAttrs(attrText));
			}
			catch
			{
				return canonicalTimeAttributes(match);
			}
		})
		.replaceAll(BOM, "");
}

function deletePillAt(html: string, index: number): string | null
{
	const char = index < 0 ? null : plainCharAt(html, index);
	return char !== null && /^<(?:time|mention)\b/iu.test(char.raw) ? char.without : null;
}

/** Backspace right after a pill (at plain-text `offset`, a pill counting one) deletes the whole pill, else null. */
export function deletePillBeforeCaret(html: string, offset: number): string | null
{
	return deletePillAt(html, offset - 1);
}

/** Delete right before a pill (at plain-text `offset`, a pill counting one) deletes the whole pill, else null. */
export function deletePillAfterCaret(html: string, offset: number): string | null
{
	return deletePillAt(html, offset);
}

const BANG = /^[!！]$/u;
const EDGE = /^\s$/u;

/**
 * Upstream's `symbol.spaced` `!!` trigger: the two characters before `caret` in plain `text`
 * are `!` or `！`, preceded by whitespace or the start and followed by whitespace or the end.
 */
export function shouldTriggerDatePopup(text: string, caret: number): boolean
{
	const before = text[caret - 3];
	const after = text[caret];
	return (
		caret >= 2 &&
		BANG.test(text[caret - 1] ?? "") &&
		BANG.test(text[caret - 2] ?? "") &&
		(before === undefined || EDGE.test(before)) &&
		(after === undefined || EDGE.test(after))
	);
}

/** `<time>` attributes for a picked day, or for a range sorted start to end (months 1-based). */
export function timeAttrsFromDates(dates: Date[]): TimeAttrs
{
	const [start, end] = dates.toSorted((a, b) => a.getTime() - b.getTime());
	if (start === undefined)
	{
		throw new Error("timeAttrsFromDates needs at least one date");
	}
	const attrs: TimeAttrs =
	{
		startYear: start.getFullYear(),
		startMonth: start.getMonth() + 1,
		startDay: start.getDate(),
	};
	if (end !== undefined)
	{
		attrs.endYear = end.getFullYear();
		attrs.endMonth = end.getMonth() + 1;
		attrs.endDay = end.getDate();
	}
	return attrs;
}

/**
 * Stored HTML after inserting a date pill at plain-text `caretOffset` (a pill counting one),
 * plus one space only when nothing follows, and the caret offset right after it all.
 */
export function planDateInsertion(
	html: string,
	caretOffset: number,
	attrs: TimeAttrs,
	{
		addSpaceBefore = false,
	}:
	{
		addSpaceBefore?: boolean | undefined;
	} = {},
):
{
	html: string;
	caretOffset: number;
}
{
	const {before, after} = splitHtml(html, caretOffset, caretOffset);
	const previous = plainText(before, PILL_CHAR).at(-1);
	const lead = addSpaceBefore && previous !== undefined && !/\s/u.test(previous) ? " " : "";
	const space = plainLength(after) === 0 ? " " : "";
	return {
		html: `${before}${lead}${toTimeMarkup(attrs)}${space}${after}`,
		caretOffset: plainLength(before) + lead.length + 1 + space.length,
	};
}

/**
 * Stored HTML with the `pillIndex`-th `<time>` replaced by markup for `attrs` (dropping any
 * hours and minutes the old pill had, as upstream does), or removed when `attrs` is null.
 * Surrounding text, including the space before the pill, is kept and no space is added.
 */
export function replacePill(html: string, pillIndex: number, attrs: TimeAttrs | null): string
{
	let index = 0;
	return html.replaceAll(TIME_PATTERN, (match) =>
	{
		const current = index;
		index += 1;
		if (current !== pillIndex)
		{
			return match;
		}
		return attrs === null ? "" : toTimeMarkup(attrs);
	});
}

/**
 * `replacePill` for a live editor: the new stored HTML plus the plain-text caret offset (a pill
 * counting one) right after the replacement pill, or where the removed pill was. With no pill at
 * `pillIndex` the HTML is unchanged and the caret goes to the end.
 */
export function planPillReplacement(
	html: string,
	pillIndex: number,
	attrs: TimeAttrs | null,
):
{
	html: string;
	caretOffset: number;
}
{
	const match = [...html.matchAll(TIME_PATTERN)][pillIndex];
	if (match === undefined)
	{
		return {
			html,
			caretOffset: plainLength(html),
		};
	}
	return {
		html: replacePill(html, pillIndex, attrs),
		caretOffset: plainLength(html.slice(0, match.index)) + (attrs === null ? 0 : 1),
	};
}

// A `<time>` element (paired or self-closing) with at most one space before it.
const SPACED_TIME_PATTERN = /[ \u00A0]?<time\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/time>)/giu;

/** Upstream's `delete_dates`: stored HTML with every `<time>` removed, each with one preceding space. */
export function deleteDates(html: string): string
{
	return html.replaceAll(SPACED_TIME_PATTERN, "");
}

/** Per-node `delete_dates` edits: only the fields whose value changes. */
export function planDeleteDates(
	nodes: readonly
	{
		id: string;
		name: string;
		note: string;
	}[],
):
{
	id: string;
	name?: string;
	note?: string;
}[]
{
	const plan:
	{
		id: string;
		name?: string;
		note?: string;
	}[] = [];
	for (const {id, name, note} of nodes)
	{
		const edit:
		{
			id: string;
			name?: string;
			note?: string;
		} =
		{
			id,
		};
		const newName = deleteDates(name);
		const newNote = deleteDates(note);
		if (newName !== name)
		{
			edit.name = newName;
		}
		if (newNote !== note)
		{
			edit.note = newNote;
		}
		if (edit.name !== undefined || edit.note !== undefined)
		{
			plan.push(edit);
		}
	}
	return plan;
}

/** Whether stored HTML holds any `<time>` date. */
export function hasDates(html: string): boolean
{
	return /<time\b/iu.test(html);
}

/** Stands in for a date pill in `datePhraseText`, one character like the pill's caret unit. */
const PILL_CHAR = "\uFFFC";

/** Plain text of editor or stored HTML for date-phrase search: each pill is U+FFFC, entities decoded. */
export function datePhraseText(html: string): string
{
	return plainText(html, PILL_CHAR);
}

/**
 * Upstream's date autocomplete (`fK`): the natural-language date phrase the caret is in or at
 * the end of, searching only the text between the pills (U+FFFC in `text`) around the caret.
 * Offsets are plain-text units, a pill counting one.
 */
export function findDatePhraseAtCaret(
	text: string,
	caret: number,
	now: Date = new Date(),
	options:
	{
		dateFormat?: string;
		weekStartDay?: number;
	} = {},
): DatePhrase | undefined
{
	const segmentStart = text.lastIndexOf(PILL_CHAR, caret - 1) + 1;
	const nextPill = text.indexOf(PILL_CHAR, caret);
	const segment = text.slice(segmentStart, nextPill === -1 ? undefined : nextPill);
	const found = findDatePhrase(segment, caret - segmentStart, now, options);
	return (
		found &&
		{
			start: found.start + segmentStart,
			end: found.end + segmentStart,
			attrs: found.attrs,
		}
	);
}

/** Stored HTML with the autocompleted phrase replaced by its pill plus one space, and the caret after the space. */
export function applyDatePhrase(
	html: string,
	phrase: DatePhrase,
):
{
	html: string;
	caretOffset: number;
}
{
	const {before, after} = splitHtml(html, phrase.start, phrase.end);
	return {
		html: `${before}${toTimeMarkup(phrase.attrs)} ${after}`,
		caretOffset: plainLength(before) + 2,
	};
}
