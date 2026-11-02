import type {NodeResponse} from "../node-types.js";
import type {TreeSearchResult} from "../server/tree-search.js";

/** A committed search applied to the outline in place: the server's result plus the per-search client state. */
export interface SearchFilter
{
	result: TreeSearchResult;
	/** `result.matchIds` as a Set, so per-row lookups stay fast with thousands of matches. */
	matchIds: ReadonlySet<string>;
	/** `result.ancestorIds` as a Set. */
	ancestorIds: ReadonlySet<string>;
	/** `result.nameMatchIds` as a Set. */
	nameMatchIds: ReadonlySet<string>;
	/** `result.noteMatchIds` as a Set. */
	noteMatchIds: ReadonlySet<string>;
	/** `result.metaMatchIds` as a Set. */
	metaMatchIds: ReadonlySet<string>;
	/** `result.halfExpandedIds` as a Set. */
	halfExpandedIds: ReadonlySet<string>;
	/** Items created while searching stay visible though they do not match. */
	createdIds: ReadonlySet<string>;
	/** Per-item expansion overrides while searching: false collapses, true shows every child. */
	expansion: ReadonlyMap<string, boolean>;
}

type IdSets = Pick<
	SearchFilter,
	"matchIds" | "ancestorIds" | "nameMatchIds" | "noteMatchIds" | "metaMatchIds" | "halfExpandedIds"
>;

const idSetsByResult = new WeakMap<TreeSearchResult, IdSets>();

/** The filter for `result`, indexing its ids once per result rather than once per rendered row. */
export function searchFilter(
	result: TreeSearchResult,
	createdIds: ReadonlySet<string>,
	expansion: ReadonlyMap<string, boolean>,
): SearchFilter
{
	let idSets = idSetsByResult.get(result);
	if (idSets === undefined)
	{
		idSets =
		{
			matchIds: new Set(result.matchIds),
			ancestorIds: new Set(result.ancestorIds),
			nameMatchIds: new Set(result.nameMatchIds),
			noteMatchIds: new Set(result.noteMatchIds),
			metaMatchIds: new Set(result.metaMatchIds),
			halfExpandedIds: new Set(result.halfExpandedIds),
		};
		idSetsByResult.set(result, idSets);
	}
	return {
		result,
		...idSets,
		createdIds,
		expansion,
	};
}

/** Upstream's expansion during a search: an override wins, else matching-descendant ancestors are open. */
export function isSearchExpanded(id: string, search: SearchFilter): boolean
{
	return search.expansion.get(id) ?? search.ancestorIds.has(id);
}

/**
 * Whether `node` is rendered during the search: it matches, has matching descendants, was created during the
 * search, or its parent was fully expanded by an arrow click.
 */
export function searchShowsNode(node: NodeResponse, search: SearchFilter): boolean
{
	return (
		search.matchIds.has(node.id) ||
		search.ancestorIds.has(node.id) ||
		search.createdIds.has(node.id) ||
		(node.parent_id !== null && search.expansion.get(node.parent_id) === true)
	);
}

/** Completed matches stay hidden while completed rows are hidden, unless the query asks for them (is:complete). */
export function searchShowsCompleted(showCompleted: boolean, search: SearchFilter | null): boolean
{
	return showCompleted || search?.result.revealsCompleted === true;
}
