import {matchField, splitIntoWords} from "@outlinedb/shared/search";
import {rankSwitcher} from "./switcher-search.js";
import type {RankSwitcherOptions, SwitcherAncestor, SwitcherResponse} from "./switcher-search.js";
import type {TreeSearchRow} from "./tree-search.js";

export interface LocationResult {
	id: string;
	labelHtml: string;
	/** Root-first, without Home. */
	ancestors: SwitcherAncestor[];
}

export interface LocationResponse {
	results: LocationResult[];
	hasMore: boolean;
}

export interface FilterLocationsOptions {
	query: string;
	excludeId?: string;
	offset?: number;
	limit?: number;
	joinedSec?: number;
	nowSec?: number;
	/** Page ids that get upstream's star boost (search stars' pages included). */
	starredIds?: readonly string[];
	showCompleted?: boolean;
	/** The ranking, {@link rankSwitcher} unless the host pages the text (see {@link rankSwitcherPaged}). */
	rank?: (
		rows: readonly TreeSearchRow[],
		query: string,
		starredIds: readonly string[],
		nowSec: number,
		options: RankSwitcherOptions,
	) => SwitcherResponse;
}

/** The query's word-start hits in `text`, each wrapped in `<b><u>`, with the rest HTML-escaped. */
export function highlightLabel(query: string, text: string): string {
	return matchField(splitIntoWords(query), text).html;
}

/**
 * Upstream's move-to location search: the switcher's word-start match and ranking with the star boost, dropping
 * completed nodes (unless `showCompleted`), nodes under a completed ancestor and the item being moved.
 */
export function filterLocations(
	rows: readonly TreeSearchRow[],
	{
		query,
		excludeId,
		offset,
		limit,
		joinedSec = 0,
		nowSec = Math.floor(Date.now() / 1000),
		starredIds = [],
		showCompleted,
		rank = rankSwitcher,
	}: FilterLocationsOptions,
): LocationResponse {
	const {results, hasMore} = rank(rows, query, starredIds, nowSec, {
		joinedSec,
		offset,
		limit,
		excludeId,
		showCompleted,
	});
	return {results: results.map(({id, labelHtml, ancestors}) => ({id, labelHtml, ancestors})), hasMore};
}
