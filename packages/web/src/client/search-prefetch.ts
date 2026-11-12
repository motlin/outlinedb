import type {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../node-types.js";
import {nodeKeys} from "./node-cache.js";

/** How many search ancestors, in document order, get their children prefetched; the rest load as rows render. */
export const SEARCH_PREFETCH_LIMIT = 100;
/** How many prefetches run at once, matching a browser's per-host connection limit. */
export const SEARCH_PREFETCH_CONCURRENCY = 6;

/**
 * Warm the children cache for the first search-expanded ancestors so the top of a filtered outline renders without a
 * level-by-level waterfall. Bounded in count and concurrency, never retried, and stopped by `signal`: a broad query
 * can have thousands of ancestors, and fetching them all at once floods the browser and freezes the tab.
 */
export async function prefetchSearchAncestors(
	queryClient: QueryClient,
	ancestorIds: readonly string[],
	fetchChildren: (parentId: string) => Promise<NodeResponse[]>,
	signal: AbortSignal,
): Promise<void>
{
	const pending = ancestorIds
		.filter((id) => queryClient.getQueryData(nodeKeys.children(id)) === undefined)
		.slice(0, SEARCH_PREFETCH_LIMIT);
	let next = 0;
	const worker = async (): Promise<void> =>
	{
		for (let id = pending[next]; !signal.aborted && id !== undefined; id = pending[next])
		{
			next += 1;
			const parentId = id;
			// A failed prefetch is dropped: the row fetches its own children when it renders.
			// oxlint-disable-next-line no-await-in-loop -- each worker runs its fetches one after another by design
			await queryClient
				.query(
					{
						queryKey: nodeKeys.children(parentId),
						queryFn: async () => fetchChildren(parentId),
						retry: false,
					},
				)
				.catch(() => {});
		}
	};
	await Promise.all(
		Array.from(
			{
				length: SEARCH_PREFETCH_CONCURRENCY,
			},
			worker,
		),
	);
}
