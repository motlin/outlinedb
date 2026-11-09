import {mostRecent} from "@outlinedb/shared";
import type {Star} from "@outlinedb/shared";
import {stripHtmlTags} from "@outlinedb/shared/html";

// Upstream's location-picker row list (results list `KM` + the bottomSticky create footer).
// An empty query lists recent then starred locations above two disabled create rows; a query
// lists up to `limit` results (with `More results` when cut, or a help row when empty) above
// two enabled create rows. The keyboard model lives in the shared menu reducer, which skips
// `disabled` rows.

export type PickerRowKind =
	| "result"
	| "related"
	| "recent"
	| "starred"
	| "more"
	| "create-default"
	| "create-elsewhere"
	| "help";

export type PickerIcon = "clock" | "star" | "ellipsis" | "plus" | "arrow-up" | null;

export interface PickerRow {
	kind: PickerRowKind;
	id?: string;
	labelHtml: string;
	disabled: boolean;
	icon: PickerIcon;
}

export interface PickerResult {
	id: string;
	labelHtml: string;
}

export interface PickerRowsInput {
	query: string;
	results: readonly PickerResult[];
	/** Local extra: semantically related nodes, listed first when the query is empty. */
	related?: readonly PickerResult[];
	/** Recent location ids, newest first. */
	recentIds: readonly string[];
	/** Starred page ids in `mostRecent` order (Home and searches already excluded). */
	starredIds: readonly string[];
	forItemId: string;
	expanded: boolean;
	/** Name HTML of the newest recent location, or the default `Notes` location. */
	recentLabel: string;
	/** Name HTML of a recent or starred location. */
	labelOf: (id: string) => string;
	/** `false` for a searcher without an action (`Select child...`): no create rows. */
	action?: boolean;
	/** A searcher that lists `search("")` results even with no query. */
	eager?: boolean;
	/** Replaces `New` in both create rows (`Mirror to`). */
	subActionName?: string;
	limit?: number;
	/** Step 2 (`New "q" in…`) has no create rows and no `More results`. */
	step?: 1 | 2;
	/** The search reply for a non-empty query has not landed: show neither results nor the help row. */
	pending?: boolean;
	/** Whether a recent location still exists; recents that do not are dropped. */
	exists?: (id: string) => boolean;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function locationRows(input: PickerRowsInput): PickerRow[] {
	const listed = new Set<string>();
	const rows: PickerRow[] = [];
	for (const {id, labelHtml} of input.related ?? []) {
		if (id === input.forItemId || listed.has(id)) {
			continue;
		}
		listed.add(id);
		rows.push({kind: "related", id, labelHtml, disabled: false, icon: null});
	}
	// Upstream checks the exclusion list only for starred locations, never for recents.
	for (const id of input.recentIds) {
		if (listed.has(id) || input.exists?.(id) === false) {
			continue;
		}
		listed.add(id);
		rows.push({kind: "recent", id, labelHtml: input.labelOf(id), disabled: false, icon: "clock"});
	}
	for (const id of input.starredIds) {
		if (listed.has(id) || id === input.forItemId) {
			continue;
		}
		listed.add(id);
		rows.push({kind: "starred", id, labelHtml: input.labelOf(id), disabled: false, icon: "star"});
	}
	return rows;
}

function resultRows(input: PickerRowsInput): PickerRow[] {
	const matches = input.results.filter((result) => result.id !== input.forItemId);
	if (input.pending === true) {
		return [];
	}
	if (matches.length === 0) {
		return [{kind: "help", labelHtml: "No matching locations found", disabled: true, icon: null}];
	}
	const limit = input.limit ?? 5;
	const cut = !input.expanded && input.step !== 2 && matches.length > limit;
	const shown = cut ? matches.slice(0, limit) : matches;
	const rows: PickerRow[] = shown.map((result) => ({
		kind: "result",
		id: result.id,
		labelHtml: result.labelHtml,
		disabled: false,
		icon: null,
	}));
	if (cut) {
		rows.push({kind: "more", labelHtml: "More results", disabled: false, icon: "ellipsis"});
	}
	return rows;
}

export function buildPickerRows(input: PickerRowsInput): PickerRow[] {
	const rows = input.query === "" && input.eager !== true ? locationRows(input) : resultRows(input);
	if (input.action === false || input.step === 2) {
		return rows;
	}
	const q = escapeHtml(input.query);
	const disabled = input.query === "";
	const verb = input.subActionName === undefined || input.subActionName === "" ? "New" : input.subActionName;
	return [
		...rows,
		{kind: "create-default", labelHtml: `${verb} "${q}" in: <b>${input.recentLabel}</b>`, disabled, icon: "plus"},
		{kind: "create-elsewhere", labelHtml: `${verb} "${q}" in…`, disabled, icon: "arrow-up"},
	];
}

/** The row active on open and after every filter change (`initialSelect` 0 over enabled rows). */
export function firstEnabledIndex(rows: readonly PickerRow[]): number {
	return rows.findIndex((row) => !row.disabled);
}

/** The picker's step machine. `active` indexes the enabled rows, as the shared menu reducer does. */
export interface PickerState {
	step: 1 | 2;
	query: string;
	expanded: boolean;
	active: number;
	/** Step 2: the name of the item `New "name" in…` creates. */
	name: string;
}

/** Arrows and Ctrl+N/P are the shared menu reducer's; it reports selections as `select` with the enabled index. */
export type PickerEvent =
	| {type: "query"; query: string}
	| {type: "key"; key: "Enter" | "Tab" | "Escape"; shiftKey?: boolean}
	| {type: "select"; index: number}
	| {type: "focus-leave"};

/** `sub-action` creates `name` under `id`, or under the default (newest recent) location when `id` is absent. */
export type PickerEffect =
	| {type: "none"}
	| {type: "close"}
	| {type: "action"; id: string}
	| {type: "sub-action"; id?: string; name: string};

export interface PickerTransition {
	state: PickerState;
	effect: PickerEffect;
}

export const INITIAL_PICKER_STATE: PickerState = {step: 1, query: "", expanded: false, active: 0, name: ""};

const NONE: PickerEffect = {type: "none"};

function selectRow(state: PickerState, index: number, rows: readonly PickerRow[]): PickerTransition {
	const row = rows.filter((candidate) => !candidate.disabled)[index];
	if (!row) {
		return {state, effect: NONE};
	}
	if (row.kind === "more") {
		return {state: {...state, expanded: true, active: index}, effect: NONE};
	}
	if (row.kind === "create-default") {
		return {state, effect: {type: "sub-action", name: state.query}};
	}
	if (row.kind === "create-elsewhere") {
		return {state: {...INITIAL_PICKER_STATE, step: 2, name: state.query}, effect: NONE};
	}
	if (row.id === undefined) {
		return {state, effect: NONE};
	}
	return {
		state,
		effect: state.step === 2 ? {type: "sub-action", id: row.id, name: state.name} : {type: "action", id: row.id},
	};
}

/** Upstream WF.InlineSearch steps (`Lm1` search, `Mm1` destination for `New "q" in…`). */
export function reducePicker(state: PickerState, event: PickerEvent, rows: readonly PickerRow[]): PickerTransition {
	if (event.type === "query") {
		return {state: {...state, query: event.query, expanded: false, active: 0}, effect: NONE};
	}
	if (event.type === "select") {
		return selectRow(state, event.index, rows);
	}
	if (event.type === "focus-leave") {
		return {state, effect: {type: "close"}};
	}
	if (event.key === "Escape") {
		return state.step === 2 ? {state: INITIAL_PICKER_STATE, effect: NONE} : {state, effect: {type: "close"}};
	}
	return selectRow(state, state.active, rows);
}

export interface DefaultLocationInput {
	/** Recent location ids, newest first. */
	recentIds: readonly string[];
	/** The account's `notesRootId` (or this session's lazily created Notes). */
	notesRootId: string | null;
	/** Whether a node is in the cache. */
	exists: (id: string) => boolean;
}

export type DefaultLocation = {id: string} | {create: "Notes"};

/** Footer A's target: the newest recent location, else the account's Notes node, else a Notes to create. */
export function resolveDefaultLocation({recentIds, notesRootId, exists}: DefaultLocationInput): DefaultLocation {
	const recentId = recentIds.find((id) => exists(id));
	if (recentId !== undefined) {
		return {id: recentId};
	}
	if (notesRootId !== null && exists(notesRootId)) {
		return {id: notesRootId};
	}
	return {create: "Notes"};
}

/** A location's subtext crumbs from its root-first ancestor chain (itself last): ancestors only, as plain text. */
export function ancestorCrumbs(chain: readonly {id: string; name: string | null}[]): {id: string; name: string}[] {
	return chain.slice(0, -1).map(({id, name}) => ({id, name: stripHtmlTags(name ?? "")}));
}

/** Every starred location, search stars included, as its page id: deduplicated, in the order given (see `starredPickerIds`), Home skipped. */
export function starRowIds(stars: readonly {nodeId: string | null; query: string | null}[]): string[] {
	return [...new Set(stars.flatMap((star) => (star.nodeId === null ? [] : [star.nodeId])))];
}

/**
 * The page ids of the starred rows, in upstream's `mostRecent` order (last viewed first, then key), search stars
 * included, deduplicated, Home skipped. `lastViewed` is the stored view stamps by location key.
 */
export function starredPickerIds(stars: readonly Star[], lastViewed: Readonly<Record<string, number>>): string[] {
	return starRowIds(mostRecent(stars, lastViewed));
}
