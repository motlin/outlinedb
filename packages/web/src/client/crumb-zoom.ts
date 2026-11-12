import {useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useCallback} from "react";
import {useStableNavigate} from "./hooks/use-stable-navigate.js";
import {goToNode} from "./navigation.js";
import {readNode} from "./node-cache.js";
import {useOutlineStore} from "./stores/outline.js";
import type {NavigateFn} from "./stores/outline.js";
import {ZOOMING_CLASS, runZoomAnimation, waitForAnyZoomRow, zoomAnimationEnabled} from "./zoom-animation.js";

/** How long a crumb's zoom out waits for its view to load before giving up on the animation. */
const LAND_TIMEOUT_MS = 5000;

/**
 * The rows a zoom out to the crumb `ancestorId` can animate, deepest first: the trail's nodes below it, down to the
 * zoomed node (`trailIds` runs from the top-level ancestor to the zoomed node). Empty for a crumb off the trail.
 */
export function crumbZoomOutRows(trailIds: readonly string[], ancestorId: string): string[]
{
	const index = trailIds.indexOf(ancestorId);
	return index === -1 ? [] : trailIds.slice(index + 1).toReversed();
}

/**
 * Resolve true once the main outline zooms to `target` (at once when it shows it), calling `onLand` inside that
 * zoom's store update, before React renders it; false when it zooms elsewhere first or never lands.
 */
export async function whenZoomLands(target: string | null, onLand: () => void): Promise<boolean>
{
	if (useOutlineStore.getState().zoomedNodeId === target)
	{
		onLand();
		return true;
	}
	return new Promise((resolve) =>
	{
		const settle = (landed: boolean) =>
		{
			unsubscribe();
			clearTimeout(timer);
			resolve(landed);
		};
		const unsubscribe = useOutlineStore.subscribe((state, previous) =>
		{
			if (state.zoomedNodeId === previous.zoomedNodeId)
			{
				return;
			}
			if (state.zoomedNodeId === target)
			{
				onLand();
			}
			settle(state.zoomedNodeId === target);
		});
		const timer = setTimeout(() =>
		{
			settle(false);
		}, LAND_TIMEOUT_MS);
	});
}

function addZooming(): void
{
	document.body.classList.add(ZOOMING_CLASS);
}

/**
 * Upstream's breadcrumb click to an ancestor of the zoomed node: the view swaps (once loaded, like any zoom), then
 * plays the zoom-out animation from the deepest trail row it renders (`rows`, see `crumbZoomOutRows`).
 */
async function zoomOutToCrumb(
	queryClient: QueryClient,
	navigate: NavigateFn,
	ancestorId: string,
	rows: readonly string[],
): Promise<void>
{
	const from = useOutlineStore.getState().zoomedNodeId;
	goToNode(navigate, ancestorId);
	const isBoard = (id: string | null) => id !== null && readNode(queryClient, id)?.data.layoutMode === "board";
	if (rows.length === 0 || !zoomAnimationEnabled(isBoard(from) || isBoard(ancestorId)))
	{
		return;
	}
	if (!(await whenZoomLands(ancestorId, addZooming)))
	{
		return;
	}
	try
	{
		const rendered = await waitForAnyZoomRow(rows);
		if (rendered !== null && useOutlineStore.getState().zoomedNodeId === ancestorId)
		{
			await runZoomAnimation(true, rendered);
		}
	}
	finally
	{
		document.body.classList.remove(ZOOMING_CLASS);
	}
}

/** `zoomOutToCrumb` for the main outline's crumbs: zoom out to `ancestorId`, animating from the trail's rows below it. */
export function useCrumbZoomOut(): (trailIds: readonly string[], ancestorId: string) => void
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	return useCallback(
		(trailIds: readonly string[], ancestorId: string) =>
		{
			void zoomOutToCrumb(queryClient, navigate, ancestorId, crumbZoomOutRows(trailIds, ancestorId));
		},
		[queryClient, navigate],
	);
}
