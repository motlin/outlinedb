import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {loadOutlineView, outlineViewCached, outlineViewKey} from "../outline-view.js";
import type {OutlineViewShape} from "../outline-view.js";
import {initialRowBudget} from "../render-window.js";
import {poppedScrollY} from "../scroll-restoration.js";
import {useOutlineStore} from "../stores/outline.js";
import {usePaneExpandedIds, usePaneId} from "../components/pane-context.js";
import {MAIN_PANE_ID, paneExpandedIds} from "../pane-ids.js";
import {cachedAncestors, readNode} from "../node-cache.js";
import {adoptViewExpansion, initialExpansionPending} from "./use-expansion-sync.js";
import {fetchOutlineView, prefetchZoomView} from "./use-nodes.js";

/**
 * The view a pane with `expandedIds` shows now: the first row budget a new view reaches after its first paint, down
 * to `scrollY` below the top when Back/Forward will restore the view scrolled there.
 */
export function outlineViewShape(
	expandedIds: ReadonlySet<string>,
	showCompleted: boolean,
	scrollY = 0,
): OutlineViewShape
{
	return {
		expandedIds,
		showCompleted,
		budget: initialRowBudget((typeof window === "undefined" ? 0 : window.innerHeight) + scrollY),
	};
}

/**
 * While the page load's expansion GET is in flight, the main outline's view expands the account's rows on the server
 * instead of waiting on it, and adopts the ones it reached, so the first view still loads every level it expands.
 */
function viewQuery(queryClient: QueryClient, rootId: string | null, shape: () => OutlineViewShape)
{
	return {
		queryKey: outlineViewKey(rootId),
		// A failed load leaves each level to its own children query.
		queryFn: async () =>
		{
			const current = shape();
			const accountExpansion =
				initialExpansionPending() && current.expandedIds === useOutlineStore.getState().expandedIds
					? adoptViewExpansion
					: undefined;
			await loadOutlineView(queryClient, rootId, current, fetchOutlineView, accountExpansion).catch(
				ignoreFailure,
			);
			return true;
		},
		// Loaded once per visit: a later expand loads its own level, and leaving the view drops the entry, so the next
		// visit loads what the cache is missing then.
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
	} as const;
}

function ignoreFailure(): void
{
}

/** Load the outline view under `rootId` (see `loadOutlineView`) through the query the outline waits on. */
export async function queryOutlineView(
	queryClient: QueryClient,
	rootId: string | null,
	shape: OutlineViewShape,
): Promise<void>
{
	await queryClient.query(viewQuery(queryClient, rootId, () => shape));
}

/**
 * Whether the outline view under `rootId` is still loading in one request, for the outline to keep the previous view
 * on screen until the new one renders whole. Already cached, it is loaded from the first render.
 */
export function useOutlineViewPending(rootId: string | null): boolean
{
	const queryClient = useQueryClient();
	const paneId = usePaneId();
	const expandedIds = usePaneExpandedIds();
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const shape = outlineViewShape(expandedIds, showCompleted, poppedScrollY(rootId));
	const currentShape = () =>
	{
		const state = useOutlineStore.getState();
		return outlineViewShape(paneExpandedIds(state, paneId), state.showCompleted, poppedScrollY(rootId));
	};
	return useQuery(
		{
			...viewQuery(queryClient, rootId, currentShape),
			initialData: () => (outlineViewCached(queryClient, rootId, shape) ? true : undefined),
		},
	).isPending;
}

/** The main outline's view zoomed into `target`, rows down to the scroll Back/Forward will restore there. */
function mainZoomShape(target: string | null): OutlineViewShape
{
	const state = useOutlineStore.getState();
	return outlineViewShape(paneExpandedIds(state, MAIN_PANE_ID), state.showCompleted, poppedScrollY(target));
}

/** Whether the cache holds everything the main outline renders zoomed into `target`: tree, title and breadcrumbs. */
export function mainZoomViewCached(queryClient: QueryClient, target: string | null): boolean
{
	const headerCached =
		target === null ||
		(readNode(queryClient, target) !== undefined && cachedAncestors(queryClient, target) !== undefined);
	return headerCached && outlineViewCached(queryClient, target, mainZoomShape(target));
}

/** Load everything the main outline renders zoomed into `target`, as a bullet click's zoom does; never rejects. */
export async function loadMainZoomView(queryClient: QueryClient, target: string | null): Promise<void>
{
	await Promise.all([
		target === null ? undefined : prefetchZoomView(queryClient, target),
		queryOutlineView(queryClient, target, mainZoomShape(target)),
	]);
}
