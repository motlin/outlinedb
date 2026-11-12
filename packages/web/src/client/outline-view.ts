import {notifyManager} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import type {BacklinksResponse, FoundDatesResponse, NodeResponse, OutlineViewResponse} from "../node-types.js";
import {nodeKeys, readNode} from "./node-cache.js";
import {pendingCreates} from "./pending-creates.js";
import {pendingMoves} from "./pending-moves.js";
import {viewParentIds} from "./render-window.js";

/** What an outline view under a root renders: expansion, completion, and the rows it mounts at most. */
export interface OutlineViewShape
{
	expandedIds: ReadonlySet<string>;
	showCompleted: boolean;
	budget: number;
}

/** The body of `POST /api/v1/nodes/view`; `expandedIds: null` expands the account's expanded rows. */
export interface OutlineViewRequest
{
	rootId: string | null;
	expandedIds: string[] | null;
	limit: number;
	showCompleted: boolean;
}

/** The query an outline view's load runs under; outside `nodes`, so a tree write's invalidation does not rerun it. */
export function outlineViewKey(rootId: string | null)
{
	return ["outline-view", rootId] as const;
}

/**
 * Whether the cache holds every list and Backlinks section the view under `rootId` renders within its budget, and a
 * day page's Found Dates.
 */
export function outlineViewCached(queryClient: QueryClient, rootId: string | null, shape: OutlineViewShape): boolean
{
	if (
		rootId !== null &&
		readNode(queryClient, rootId)?.calendar?.level === "day" &&
		!foundDatesCached(queryClient, rootId)
	)
	{
		return false;
	}
	const parentIds = viewParentIds(
		(parentId) => queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId)),
		rootId,
		shape.budget,
		{
			expandedIds: shape.expandedIds,
			showCompleted: shape.showCompleted,
			animatingCompletionIds: new Set(),
			search: null,
		},
	);
	return (
		parentIds?.every(
			(parentId) =>
				parentId === null ||
				queryClient.getQueryData<BacklinksResponse>(nodeKeys.backlinks(parentId)) !== undefined,
		) ?? false
	);
}

function foundDatesCached(queryClient: QueryClient, dayId: string): boolean
{
	return queryClient.getQueryData<FoundDatesResponse>(nodeKeys.foundDates(dayId)) !== undefined;
}

/**
 * Load the outline view under `rootId` in one request: the root's children and those of every expanded row the row
 * budget reaches, with their Backlinks sections, so the view renders whole instead of one depth level per round
 * trip, and a day page's Found Dates with them. Lists the cache already holds stay (they may carry optimistic
 * writes), as does a list a pending move touches; with the whole view cached, nothing is sent.
 *
 * With `accountExpansion`, the server expands the account's expanded rows in place of `shape.expandedIds` (which the
 * page load has yet to fill), and `accountExpansion` receives the listed rows it expanded before the lists are seeded.
 */
export async function loadOutlineView(
	queryClient: QueryClient,
	rootId: string | null,
	shape: OutlineViewShape,
	fetchView: (request: OutlineViewRequest) => Promise<OutlineViewResponse>,
	accountExpansion?: (expandedIds: string[]) => void,
): Promise<void>
{
	if (accountExpansion === undefined && outlineViewCached(queryClient, rootId, shape))
	{
		return;
	}
	await pendingMoves.settled(rootId);
	const {lists, expandedIds, foundDates} = await fetchView(
		{
			rootId,
			expandedIds: accountExpansion === undefined ? [...shape.expandedIds] : null,
			limit: shape.budget,
			showCompleted: shape.showCompleted,
		},
	);
	notifyManager.batch(() =>
	{
		accountExpansion?.(expandedIds ?? []);
		seedOutlineView(
			queryClient,
			rootId,
			{
				lists,
				foundDates,
			},
		);
	});
}

/**
 * Seed the cache with a view's lists, Backlinks sections and Found Dates, keeping the lists it already holds (they may
 * carry optimistic writes) and a list a pending move touches. Call inside `notifyManager.batch` to render once.
 */
export function seedOutlineView(
	queryClient: QueryClient,
	rootId: string | null,
	{lists, foundDates}: Pick<OutlineViewResponse, "lists" | "foundDates">,
): void
{
	for (const {parentId, nodes, backlinks} of lists)
	{
		if (queryClient.getQueryData(nodeKeys.children(parentId)) === undefined && !pendingMoves.has(parentId))
		{
			queryClient.setQueryData(nodeKeys.children(parentId), pendingCreates.withPending(parentId, nodes));
		}
		if (
			parentId !== null &&
			backlinks !== null &&
			queryClient.getQueryData(nodeKeys.backlinks(parentId)) === undefined
		)
		{
			queryClient.setQueryData(nodeKeys.backlinks(parentId), backlinks);
		}
	}
	if (rootId !== null && foundDates !== undefined && !foundDatesCached(queryClient, rootId))
	{
		queryClient.setQueryData(nodeKeys.foundDates(rootId), foundDates);
	}
}
