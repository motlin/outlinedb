import {describe, expect, it} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import
{
	SEARCH_PREFETCH_CONCURRENCY,
	SEARCH_PREFETCH_LIMIT,
	prefetchSearchAncestors,
} from "../src/client/search-prefetch.js";

function ids(count: number): string[]
{
	return Array.from(
		{
			length: count,
		},
		(_, index) => `ancestor-${index}`,
	);
}

/** A fetch that records every call and how many were in flight at once, resolving each on the next tick. */
function recordingFetch()
{
	const calls: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetchChildren = async (id: string | null): Promise<NodeResponse[]> =>
	{
		calls.push(String(id));
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 0);
		});
		inFlight -= 1;
		return [];
	};
	return {
		calls,
		fetchChildren,
		maxInFlight: () => maxInFlight,
	};
}

describe("prefetchSearchAncestors", () =>
{
	it("fetches only the first ancestors in document order, a few at a time", async () =>
	{
		const queryClient = new QueryClient();
		const recorder = recordingFetch();

		await prefetchSearchAncestors(queryClient, ids(6000), recorder.fetchChildren, new AbortController().signal);

		expect(
			{
				calls: recorder.calls,
				maxInFlight: recorder.maxInFlight(),
				concurrency: SEARCH_PREFETCH_CONCURRENCY,
			},
		).toStrictEqual(
			{
				calls: ids(SEARCH_PREFETCH_LIMIT),
				maxInFlight: SEARCH_PREFETCH_CONCURRENCY,
				concurrency: 6,
			},
		);
		expect(queryClient.getQueryData(nodeKeys.children("ancestor-0"))).toStrictEqual([]);
	});

	it("skips ancestors whose children are already cached", async () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children("ancestor-1"), []);
		const recorder = recordingFetch();

		await prefetchSearchAncestors(queryClient, ids(3), recorder.fetchChildren, new AbortController().signal);

		expect(recorder.calls).toStrictEqual(["ancestor-0", "ancestor-2"]);
	});

	it("starts no new fetches once aborted", async () =>
	{
		const queryClient = new QueryClient();
		const recorder = recordingFetch();
		const controller = new AbortController();

		const done = prefetchSearchAncestors(queryClient, ids(50), recorder.fetchChildren, controller.signal);
		controller.abort();
		await done;

		expect(recorder.calls).toStrictEqual(ids(SEARCH_PREFETCH_CONCURRENCY));
	});

	it("does not retry a failed prefetch", async () =>
	{
		const queryClient = new QueryClient();
		const calls: string[] = [];
		const failing = async (id: string | null): Promise<NodeResponse[]> =>
		{
			calls.push(String(id));
			return Promise.reject(new Error("net::ERR_INSUFFICIENT_RESOURCES"));
		};

		await prefetchSearchAncestors(queryClient, ids(2), failing, new AbortController().signal);

		expect(calls).toStrictEqual(["ancestor-0", "ancestor-1"]);
	});
});
