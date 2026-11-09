// Upstream's switcher row list: an empty filter lists the starred locations (`useMostRecentStarred`);
// a filter lists the starred entries that match it, then the server's results without their duplicates.

import {label} from "@outlinedb/shared";
import {stripHtmlTags} from "@outlinedb/shared/html";
import type {Star} from "@outlinedb/shared";
import {matchSwitcherRow} from "@outlinedb/shared/search";
import type {SwitcherAncestor, SwitcherResult} from "../server/switcher-search.js";

/** A starred location with its node's text; callers pass these in `mostRecent` order. */
export interface StarredEntry {
	star: Star;
	/** The node's raw name HTML ("" for Home). */
	name: string;
	note: string;
	completed: boolean;
	/** Root-first, without Home and without the node itself. */
	ancestors: SwitcherAncestor[];
}

/**
 * Each starred node id once, in first-seen order, without Home. A node can be starred both bare and with a query, and
 * `useQueries` warns about duplicate keys when the ancestor queries repeat one.
 */
export function starredNodeIds(stars: readonly Star[]): string[] {
	return [...new Set(stars.flatMap((star) => (star.nodeId === null ? [] : [star.nodeId])))];
}

/**
 * `idle` until the first request of this opening answers; `pending` once that request is slow enough to say so.
 * Later requests keep the previous results.
 */
export type SwitcherSearchStatus = "idle" | "pending" | "done" | "error";

export interface SwitcherServerResults {
	status: SwitcherSearchStatus;
	results: readonly SwitcherResult[];
}

export interface SwitcherRow extends SwitcherResult {
	/** The location key (a page's key is its node id), unique among the rows. */
	key: string;
	nodeId: string | null;
	/** Set for a starred search; used for navigation only. */
	query: string | null;
	/** Upstream's `match.search`: the highlighted star label of a starred row, null for server rows. */
	search: string | null;
}

/** Upstream's `batchSize`: rows per page, counting the starred matches. */
const SWITCHER_PAGE_SIZE = 20;

export interface SwitcherRows {
	rows: SwitcherRow[];
	/** Plain text shown after the list, or null for none. */
	emptyText: string | null;
	/** Show the spinner beside the indexing message. */
	indexing: boolean;
}

const STARRED_HINT = "Your starred pages will appear here.";
const NO_MATCHES = "No matches found. Try adjusting your search.";
const INDEXING = "Indexing your data! One sec …";
const SEARCH_UNAVAILABLE = "Search is unavailable right now.";

function starredRow(entry: StarredEntry, filter: string): SwitcherRow | null {
	const {star} = entry;
	const starLabel = label(star, () => entry.name);
	const match = matchSwitcherRow({name: entry.name, note: entry.note, starLabel}, filter);
	if (match === null) {
		return null;
	}
	const isSearch = star.query !== null && star.query !== "";
	const self = star.nodeId === null ? [] : [{id: star.nodeId, name: stripHtmlTags(entry.name)}];
	const search = match.searchHtml ?? starLabel;
	return {
		key: star.key,
		id: star.nodeId ?? "",
		nodeId: star.nodeId,
		query: isSearch ? star.query : null,
		search,
		labelHtml: isSearch || star.nodeId === null ? search : match.labelHtml,
		completed: entry.completed,
		starred: true,
		// Every starred location's crumbs end in the page itself.
		ancestors: [...entry.ancestors, ...self],
	};
}

function emptyState(
	filter: string,
	listed: number,
	starredCount: number,
	status: SwitcherSearchStatus,
): {emptyText: string | null; indexing: boolean} {
	if (listed > 0) {
		return {emptyText: null, indexing: false};
	}
	if (filter === "") {
		return {emptyText: STARRED_HINT, indexing: false};
	}
	if (status === "error") {
		return {emptyText: SEARCH_UNAVAILABLE, indexing: false};
	}
	if (status === "idle") {
		return {emptyText: null, indexing: false};
	}
	if (status === "pending") {
		return {emptyText: INDEXING, indexing: true};
	}
	return {emptyText: starredCount === 0 ? STARRED_HINT : NO_MATCHES, indexing: false};
}

/**
 * `pages` pages of `SWITCHER_PAGE_SIZE` rows over the combined starred and server rows; `specialCount` is the number of
 * `..` / `-` rows listed above, which count as matches for the empty state.
 */
export function buildSwitcherRows(
	starred: readonly StarredEntry[],
	server: SwitcherServerResults,
	filter: string,
	pages = 1,
	specialCount = 0,
): SwitcherRows {
	const trimmed = filter.trim();
	const starredRows = starred.flatMap((entry) => starredRow(entry, trimmed) ?? []);
	const listed = new Set(starredRows.map((row) => row.key));
	const serverRows: SwitcherRow[] =
		trimmed === ""
			? []
			: server.results
					.filter((result) => !listed.has(result.id))
					.map((result) => ({...result, key: result.id, nodeId: result.id, query: null, search: null}));
	const rows = [...starredRows, ...serverRows].slice(0, SWITCHER_PAGE_SIZE * pages);
	return {rows, ...emptyState(trimmed, rows.length + specialCount, starred.length, server.status)};
}

/** Whether two rows show the same thing, so a rebuilt row list can skip re-rendering the rows a keystroke left alone. */
export function sameSwitcherRow(a: SwitcherRow, b: SwitcherRow): boolean {
	return (
		a === b ||
		(a.key === b.key &&
			a.id === b.id &&
			a.nodeId === b.nodeId &&
			a.query === b.query &&
			a.search === b.search &&
			a.labelHtml === b.labelHtml &&
			a.completed === b.completed &&
			a.starred === b.starred &&
			a.ancestors.length === b.ancestors.length &&
			a.ancestors.every((ancestor, index) => {
				const other = b.ancestors.at(index);
				return ancestor.id === other?.id && ancestor.name === other.name;
			}))
	);
}
