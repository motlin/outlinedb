import type {QueryClient} from "@tanstack/react-query";
import {setNavigableRowsReader} from "../backlink-edit.js";
import {isBacklinksSectionVisible} from "../backlinks.js";
import {nodeKeys} from "../node-cache.js";
import type {BacklinksResponse, NodeResponse} from "../../node-types.js";
import {activePaneView} from "../stores/outline.js";
import {rowHasChildren} from "../tree-ops.js";
import {rendersInstanceChildren, rendersInstanceRow} from "../render-window.js";
import type {ExpansionRow} from "../expansion.js";
import type {MirrorInstance} from "../../mirror-path.js";
import {childInstance} from "../../mirror-path.js";
import {navigableIds} from "../caret-navigation.js";
import type {SearchFilter} from "../search-filter.js";
import {currentSearchFilter} from "./use-tree-search.js";

/**
 * Builds a flattened list of visible node IDs in display order.
 * A node is visible if:
 * - It's a direct child of the zoomed node (or root if no zoom)
 * - All its ancestors are expanded
 * - It's not completed when showCompleted is false, unless its completion is still animating
 * - During a search, the search shows it, and expansion comes from the search rather than `expandedIds`
 *
 * Uses TanStack Query's cached data to traverse the tree.
 */
export function collectVisibleNodeIds(
	queryClient: QueryClient,
	zoomedNodeId: string | null,
	expandedIds: ReadonlySet<string>,
	showCompleted: boolean,
	animatingCompletionIds: ReadonlySet<string>,
	search: SearchFilter | null = currentSearchFilter(queryClient),
): string[]
{
	const visibleIds: string[] = [];

	/** The Backlinks section's rows after `parentId`'s children: its references row, then its items while it is open. */
	const collectBacklinks = (parentId: string | null) =>
	{
		if (parentId === null || search !== null)
		{
			return;
		}
		const backlinks = queryClient.getQueryData<BacklinksResponse>(nodeKeys.backlinks(parentId));
		if (backlinks?.rootId == null || !isBacklinksSectionVisible(backlinks, showCompleted))
		{
			return;
		}
		visibleIds.push(backlinks.rootId);
		if (expandedIds.has(backlinks.rootId))
		{
			for (const item of backlinks.items)
			{
				if (showCompleted || item.node.completedAt === null)
				{
					visibleIds.push(item.node.id);
				}
			}
		}
	};

	const collectVisibleNodes = (parentId: string | null, instance: MirrorInstance | null) =>
	{
		const children = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId));

		if (!children)
		{
			return;
		}

		const filteredChildren = children.filter((node) =>
			rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search),
		);

		for (const node of filteredChildren)
		{
			visibleIds.push(node.id);

			if (rendersInstanceChildren(node, instance, expandedIds, search))
			{
				collectVisibleNodes(node.id, childInstance(node, instance));
			}
		}
		collectBacklinks(parentId);
	};

	collectVisibleNodes(zoomedNodeId, null);
	return visibleIds;
}

/**
 * The nodes the caret can visit right now, in display order: the zoom root's
 * title (when zoomed) then the visible rows. Reads the store and cache at call
 * time, so commands see rows created since the last render.
 */
export function currentNavigableIds(queryClient: QueryClient): string[]
{
	const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
	return navigableIds(
		zoomedNodeId,
		collectVisibleNodeIds(queryClient, zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds),
	);
}

setNavigableRowsReader(currentNavigableIds);

/**
 * The rendered rows under the zoom root with their depth and whether each is a parent, read from the store and
 * cache at call time, for the zoom root's level-by-level ⌘↓ / ⌘↑ and page-wide ⌃Space.
 */
export function currentExpansionRows(queryClient: QueryClient): ExpansionRow[]
{
	const {zoomedNodeId, expandedIds, showCompleted, animatingCompletionIds} = activePaneView();
	const search = currentSearchFilter(queryClient);
	const rows: ExpansionRow[] = [];
	const walk = (parentId: string | null, depth: number, instance: MirrorInstance | null) =>
	{
		const children = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId)) ?? [];
		for (const node of children)
		{
			if (!rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search))
			{
				continue;
			}
			const cached = queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(node.id));
			const hasVisibleChildren =
				node.hasChildren === undefined
					? cached === undefined || cached.length > 0
					: rowHasChildren(node, showCompleted);
			rows.push(
				{
					id: node.id,
					depth,
					hasVisibleChildren,
				},
			);
			if (rendersInstanceChildren(node, instance, expandedIds, search))
			{
				walk(node.id, depth + 1, childInstance(node, instance));
			}
		}
	};
	walk(zoomedNodeId, 0, null);
	return rows;
}
