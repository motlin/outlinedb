import type {QueryClient} from "@tanstack/react-query";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useContext, useEffect} from "react";
import {useShallow} from "zustand/react/shallow";
import type {TreeSearchResult} from "../../server/tree-search.js";
import {readJson} from "../read-json.js";
import {prefetchSearchAncestors} from "../search-prefetch.js";
import type {SearchFilter} from "../search-filter.js";
import {searchFilter} from "../search-filter.js";
import {PaneContext} from "../components/pane-context.js";
import {MAIN_PANE_ID, findPane} from "../pane-ids.js";
import {useOutlineStore} from "../stores/outline.js";
import {fetchChildren} from "./use-nodes.js";

async function fetchTreeSearch(query: string, rootId: string | null): Promise<TreeSearchResult>
{
	const response = await fetch(
		"/api/search/tree",
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					query,
					rootId,
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error(`Tree search failed: ${response.statusText}`);
	}
	return readJson<TreeSearchResult>(response);
}

/** The tree-search query key; the session scopes which earlier results may stand in while a new one loads. */
export function treeSearchKey(session: number, zoomedNodeId: string | null, query: string, run: number)
{
	return ["tree-search", session, zoomedNodeId, query, run] as const;
}

/** The most recently fetched result of this search session, shown while a changed or re-run query loads. */
function latestSessionResult(queryClient: QueryClient, session: number): TreeSearchResult | undefined
{
	let latest:
		|
		  {
				result: TreeSearchResult;
				updatedAt: number;
		  }
		| undefined;
	for (const [key, result] of queryClient.getQueriesData<TreeSearchResult>(
		{
			queryKey: ["tree-search", session],
		},
	))
	{
		const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
		if (result !== undefined && (latest === undefined || updatedAt > latest.updatedAt))
		{
			latest =
			{
				result,
				updatedAt,
			};
		}
	}
	return latest?.result;
}

interface SearchState
{
	zoomedNodeId: string | null;
	searchQuery: string;
	searchRun: number;
	searchSession: number;
}

/**
 * The tree-search query: the committed search's matches under the zoomed node, re-fetched when the query is re-run.
 * While a new result loads, the session's previous result stays in place so the unfiltered outline never flashes.
 * Every row reads this query and that lookup scans the whole query cache, so it is left out once the search is
 * cleared: run per row on Back, it froze the tab for seconds.
 */
export function treeSearchOptions(
	queryClient: QueryClient,
	{zoomedNodeId, searchQuery, searchRun, searchSession}: SearchState,
)
{
	return {
		queryKey: treeSearchKey(searchSession, zoomedNodeId, searchQuery, searchRun),
		queryFn: async () => fetchTreeSearch(searchQuery, zoomedNodeId),
		enabled: searchQuery !== "",
		placeholderData: searchQuery === "" ? undefined : () => latestSessionResult(queryClient, searchSession),
	};
}

/** The panes' searches share one session of their own, so a main-outline result never stands in for one. */
export const PANE_SEARCH_SESSION = -1;
const NO_CREATED_IDS: ReadonlySet<string> = new Set();
const NO_EXPANSION: ReadonlyMap<string, boolean> = new Map();

export interface PaneSearchState extends SearchState
{
	createdIds: ReadonlySet<string>;
	expansion: ReadonlyMap<string, boolean>;
}

interface PaneSearchSource extends SearchState
{
	searchCreatedIds: ReadonlySet<string>;
	searchExpansion: ReadonlyMap<string, boolean>;
	panes: readonly
	{
		id: string;
		zoomedId: string | null;
		query: string;
	}[];
}

/**
 * The search a pane's outline filters by: the main outline's in the main pane, and an open pane's own query under its
 * own zoom in that pane (upstream's per-pane search box), so one pane's search never filters another.
 */
export function paneSearchState(state: PaneSearchSource, paneId: string): PaneSearchState
{
	const pane = findPane(state.panes, paneId);
	if (pane !== undefined)
	{
		return {
			zoomedNodeId: pane.zoomedId,
			searchQuery: pane.query,
			searchRun: 0,
			searchSession: PANE_SEARCH_SESSION,
			createdIds: NO_CREATED_IDS,
			expansion: NO_EXPANSION,
		};
	}
	return {
		zoomedNodeId: state.zoomedNodeId,
		searchQuery: state.searchQuery,
		searchRun: state.searchRun,
		searchSession: state.searchSession,
		createdIds: state.searchCreatedIds,
		expansion: state.searchExpansion,
	};
}

/** `paneSearchState` for the pane the caller renders in. */
function usePaneSearch(): PaneSearchState
{
	const paneId = useContext(PaneContext)?.id ?? MAIN_PANE_ID;
	return useOutlineStore(useShallow((state) => paneSearchState(state, paneId)));
}

/** The committed search query of the pane the caller renders in ("" for none). */
export function usePaneSearchQuery(): string
{
	const paneId = useContext(PaneContext)?.id ?? MAIN_PANE_ID;
	// Only the query: a zoom replaces the pane's other search state, and every row's text reads this.
	return useOutlineStore((state) => paneSearchState(state, paneId).searchQuery);
}

function useTreeSearch()
{
	const queryClient = useQueryClient();
	const {zoomedNodeId, searchQuery, searchRun, searchSession} = usePaneSearch();
	return useQuery(
		treeSearchOptions(
			queryClient,
			{
				zoomedNodeId,
				searchQuery,
				searchRun,
				searchSession,
			},
		),
	);
}

/** The in-place filter for the pane's outline, or null when no search is committed or no result has arrived yet. */
export function useSearchFilter(): SearchFilter | null
{
	const {searchQuery, createdIds, expansion} = usePaneSearch();
	const {data} = useTreeSearch();
	return searchQuery === "" || data === undefined ? null : searchFilter(data, createdIds, expansion);
}

/**
 * `useSearchFilter` read from the store and cache at call time, for commands such as the caret walk: the search of
 * `paneId`, by default the active pane the keyboard acts in.
 */
export function currentSearchFilter(
	queryClient: QueryClient,
	paneId: string = useOutlineStore.getState().activePaneId,
): SearchFilter | null
{
	const {zoomedNodeId, searchQuery, searchRun, searchSession, createdIds, expansion} = paneSearchState(
		useOutlineStore.getState(),
		paneId,
	);
	if (searchQuery === "")
	{
		return null;
	}
	const result =
		queryClient.getQueryData<TreeSearchResult>(
			treeSearchKey(searchSession, zoomedNodeId, searchQuery, searchRun),
		) ?? latestSessionResult(queryClient, searchSession);
	return result === undefined ? null : searchFilter(result, createdIds, expansion);
}

/**
 * Prefetch the children of the first search-expanded ancestors, a few at a time, rather than level by level as rows
 * render. Runs in an effect without subscribing, so a resolved prefetch re-renders only the rows that show it.
 */
export function usePrefetchSearchAncestors(search: SearchFilter | null): void
{
	const queryClient = useQueryClient();
	const result = search?.result;
	useEffect(() =>
	{
		const controller = new AbortController();
		void prefetchSearchAncestors(queryClient, result?.ancestorIds ?? [], fetchChildren, controller.signal);
		return () =>
		{
			controller.abort();
		};
	}, [queryClient, result]);
}

/** The committed search's latest result, and whether the result for the current query is still on its way. */
export function useSearchProgress():
{
	result: TreeSearchResult | undefined;
	searching: boolean;
}
{
	const {data, isPending, isPlaceholderData} = useTreeSearch();
	return {
		result: data,
		searching: isPending || isPlaceholderData,
	};
}
