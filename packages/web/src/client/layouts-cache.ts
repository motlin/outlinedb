// Reads a node's layout ancestors out of the query cache, for callers outside the React tree (commands, drag, export).
import type {QueryClient} from "@tanstack/react-query";
import {dashboardsOn} from "./dashboard.js";
import {canRenderLayout} from "./layouts.js";
import {readNode} from "./node-cache.js";
import {activePaneView} from "./stores/outline.js";

export interface CachedAncestorLayouts
{
	/** Ancestor layouts, nearest first, up to and including the zoomed item (the render root). */
	layouts:
	{
		layoutMode: string | null;
	}[];
	/** The walk stopped at the render root, or the node is the render root itself. */
	reachedRoot: boolean;
}

export function cachedAncestorLayouts(
	queryClient: QueryClient,
	nodeId: string,
	zoomedId: string | null = activePaneView().zoomedNodeId,
): CachedAncestorLayouts
{
	const layouts:
	{
		layoutMode: string | null;
	}[] = [];
	let reachedRoot = nodeId === zoomedId;
	let current = readNode(queryClient, nodeId);
	while (!reachedRoot && current?.parent_id !== null && current?.parent_id !== undefined)
	{
		const parent = readNode(queryClient, current.parent_id);
		if (parent === undefined)
		{
			break;
		}
		layouts.push(
			{
				layoutMode: parent.data.layoutMode ?? null,
			},
		);
		if (parent.id === zoomedId)
		{
			reachedRoot = true;
		}
		current = parent;
	}
	return {
		layouts,
		reachedRoot,
	};
}

/** `WF.Layouts.canRender(layout, node)` against the cached ancestors, for callers outside the React tree. */
export function cachedCanRender(
	queryClient: QueryClient,
	nodeId: string,
	layout: string,
	zoomedId: string | null = activePaneView().zoomedNodeId,
): boolean
{
	const node = readNode(queryClient, nodeId);
	// Callers ask whether the node draws AS this layout; a layout the flag leaves unregistered (dashboard, flag off) is
	// not "complex", so canRenderLayout would answer true for any node.
	if (node === undefined || (node.data.layoutMode ?? null) !== layout)
	{
		return false;
	}
	const {layouts, reachedRoot} = cachedAncestorLayouts(queryClient, nodeId, zoomedId);
	return canRenderLayout(
		layout,
		{
			layoutMode: node.data.layoutMode ?? null,
		},
		layouts,
		{
			reachedRoot,
			dashboardsFlag: dashboardsOn(),
		},
	);
}
