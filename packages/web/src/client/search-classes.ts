import type {SearchFilter} from "./search-filter.js";
import {isSearchExpanded} from "./search-filter.js";

/** Classes a search appends to a row's `.project`, `.name` and `.notes` class lists. */
export interface SearchClasses
{
	project: string[];
	name: string[];
	note: string[];
}

const NO_CLASSES: SearchClasses =
{
	project: [],
	name: [],
	note: [],
};

/** Whether a search shows `id` expanded but not every child: upstream gives such a bullet its halo. */
export function isSearchHalfExpanded(id: string, search: SearchFilter): boolean
{
	return search.halfExpandedIds.has(id) && isSearchExpanded(id, search) && search.expansion.get(id) !== true;
}

/**
 * Upstream's `cw.getAdditionalClassesForSearch` for an outline row. A row created during the search, or a
 * non-matching row shown because its parent was fully expanded, counts as created-for-search: `matches
 * terminalMatch` without `fullMatch`.
 */
export function searchClasses(
	row:
	{
		id: string;
		parentId: string | null;
	},
	search: SearchFilter | null,
): SearchClasses
{
	if (search === null)
	{
		return NO_CLASSES;
	}
	const {id, parentId} = row;
	const isMatch = search.matchIds.has(id);
	const isCreatedForSearch =
		search.createdIds.has(id) || (!isMatch && parentId !== null && search.expansion.get(parentId) === true);
	const isShownAsMatch = isMatch || isCreatedForSearch;
	const halfExpanded = isSearchHalfExpanded(id, search);
	const nameMatches = search.nameMatchIds.has(id);
	const noteMatches = search.noteMatchIds.has(id);
	return {
		project: [
			isShownAsMatch && "matches",
			isShownAsMatch && (isCreatedForSearch || !search.ancestorIds.has(id)) && "terminalMatch",
			halfExpanded && "halfExpanded",
			halfExpanded && "half-open",
			search.metaMatchIds.has(id) && !nameMatches && !noteMatches && "metaMatches",
		].filter((name) => name !== false),
		name: [isMatch && "fullMatch", nameMatches && "matches"].filter((name) => name !== false),
		note: noteMatches ? ["matches", "fullMatch"] : [],
	};
}

/** The zoom-root title's search classes: half-expanded when some child neither matches nor leads to a match. */
export function rootSearchClasses(search: SearchFilter | null): string[]
{
	return search?.result.rootHalfExpanded === true ? ["half-open", "halfExpanded"] : [];
}

/** Upstream's `.page.searching`: the local page wrapper gets `searching` while a query is active. */
export function outlineViewClassName(searchQuery: string): string
{
	return searchQuery === "" ? "outline-view" : "outline-view searching";
}

/** Upstream shows no add-child button during a search. */
export function shouldRenderAddChildButton(searchQuery: string): boolean
{
	return searchQuery === "";
}

/** `base` plus extra classes, space-joined. */
export function withClasses(base: string, extra: readonly string[]): string
{
	return extra.length === 0 ? base : `${base} ${extra.join(" ")}`;
}
