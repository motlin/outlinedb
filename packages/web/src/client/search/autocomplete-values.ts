// Port of upstream's search box autocomplete data (`WF.SearchBox.autocomplete`): the operator option table
// (`zw.autocomplete`) and the `#`/`@` tag rows. Local-only operators are left out, as in search-operators.

import {formatDatePattern} from "@outlinedb/shared";
import type {FaIconKey} from "../components/fa-icons.js";

export type AutocompleteIcon = FaIconKey | {swatch: "text" | "background"; color: string};

export interface AutocompleteRow {
	type: "row";
	label: string;
	value: string;
	icon?: AutocompleteIcon;
	/** Replaces the plain "value plus a space" insertion (upstream's per-option `onSelect`). */
	insert?: {suffix: string; trailingSpace: boolean; caretOffset: number};
}

export interface AutocompleteHeader {
	type: "header";
	label: string;
}

export interface AutocompleteOptions {
	now: Date;
	dateFormat: string;
	timeFormat: string;
}

interface Option {
	value: string;
	label: string;
	icon?: AutocompleteIcon;
	displayOrder: number;
	insert?: AutocompleteRow["insert"];
}

const COLORS = ["red", "orange", "yellow", "green", "teal", "sky", "blue", "purple", "pink", "gray"] as const;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DEFAULT_ORDER = 999;
const YEAR_PART = /[./-]?Y{2,4}[./-]?/u;

function option(value: string, extra: Partial<Omit<Option, "value">> = {}): Option {
	return {value, label: value, displayOrder: DEFAULT_ORDER, ...extra};
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Upstream `strictAutocompleteValues`: today without the year, with the time, and in full. */
function dateAutocompleteValues(now: Date, dateFormat: string, timeFormat: string): string[] {
	const short = dateFormat.replace(YEAR_PART, "");
	return [
		formatDatePattern(now, short),
		`${formatDatePattern(now, short)}@${formatDatePattern(now, timeFormat)}`,
		formatDatePattern(now, dateFormat),
	];
}

function optionTable({now, dateFormat, timeFormat}: AutocompleteOptions): Record<string, Option[]> {
	const calendar = "fal:calendar-days";
	const relative = (): Option[] =>
		[
			["1h", "1 hour"],
			["1d", "1 day"],
			["7d", "1 week"],
		].map(([value, label]) => option(value ?? "", {label: label ?? "", icon: calendar}));
	return {
		"is:": [
			option("complete", {icon: "fal:check"}),
			option("mirror", {icon: "fal:diamond"}),
			option("todo", {icon: "fal:list-check"}),
			option("divider", {icon: "fal:horizontal-rule"}),
			option("h1", {icon: "fal:h1"}),
			option("h2", {icon: "fal:h2"}),
			option("h3", {icon: "fal:h3"}),
			option("paragraph", {icon: "fal:paragraph"}),
			option("code-block", {icon: "fal:rectangle-code"}),
			option("quote", {icon: "fal:block-quote"}),
		],
		"has:": [
			option("note", {icon: "fal:pencil", displayOrder: 1}),
			option("children", {icon: "fal:list-ul", displayOrder: 2}),
			option("date", {icon: calendar}),
			option("file", {icon: "fal:file"}),
			option("image", {icon: "fal:image"}),
			option("video", {icon: "fab:youtube"}),
			option("tweet", {icon: "fab:twitter"}),
		],
		"text:": [
			...COLORS.map((color) => option(color, {icon: {swatch: "text", color}, displayOrder: 1})),
			option("colored", {icon: "fal:paint-brush", displayOrder: 2}),
			option("highlighted", {icon: "fal:highlighter", displayOrder: 2}),
			option("bold", {icon: "fal:bold", displayOrder: 3}),
			option("italic", {icon: "fal:italic", displayOrder: 3}),
			option("underline", {icon: "fal:underline", displayOrder: 3}),
			option("strikethrough", {icon: "fal:strikethrough", displayOrder: 3}),
			option("code", {icon: "fal:code", displayOrder: 3}),
		],
		"highlight:": COLORS.map((color) => option(color, {icon: {swatch: "background", color}, displayOrder: 1})),
		"date:": [
			option("past", {icon: calendar}),
			option("future", {icon: calendar}),
			...dateAutocompleteValues(now, dateFormat, timeFormat).map((value) => option(value, {icon: calendar})),
		],
		"day-of-week:": DAYS.map((day) => option(day, {label: capitalize(day), icon: calendar})),
		"changed:": relative(),
		"created:": relative(),
		"in:": [option("note", {insert: {suffix: ':""', trailingSpace: false, caretOffset: -1}})],
	};
}

/** Upstream `zw.autocomplete`: value rows for an `operator:partial` word, or none. */
export function operatorAutocomplete(word: string, options: AutocompleteOptions): AutocompleteRow[] {
	if (!word.includes(":")) {
		return [];
	}
	const [operator = "", typed = ""] = word.split(":");
	if (word.length > operator.length + typed.length + 1) {
		return [];
	}
	const candidates = optionTable(options)[`${operator}:`] ?? [];
	const prefix = typed.toLowerCase();
	return candidates
		.toSorted((a, b) => a.displayOrder - b.displayOrder)
		.filter((candidate) => {
			const value = capitalize(candidate.value);
			return (
				value !== typed &&
				(value.toLowerCase().startsWith(prefix) || candidate.label.toLowerCase().startsWith(prefix))
			);
		})
		.map(({value, label, icon, insert}) => ({
			type: "row",
			label,
			value: `${operator}:${capitalize(value)}`.toLowerCase(),
			...(icon === undefined ? {} : {icon}),
			...(insert === undefined ? {} : {insert}),
		}));
}

/** Upstream's `tags` hook: rows for `#`/`@` words, with a Tags header before `@` rows. */
export function tagAutocompleteRows(word: string, tags: readonly string[]): (AutocompleteRow | AutocompleteHeader)[] {
	if (!word.startsWith("#") && !word.startsWith("@")) {
		return [];
	}
	const rows: AutocompleteRow[] = tags.map((tag) => ({type: "row", label: tag, value: tag}));
	return word.startsWith("@") && rows.length > 0 ? [{type: "header", label: "Tags"}, ...rows] : rows;
}
