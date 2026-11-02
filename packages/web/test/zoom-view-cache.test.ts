// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {prefetchZoomView, useAncestors, useNode} from "../src/client/hooks/use-nodes.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ALICE = "4823cefa-5fc0-478c-88ac-35035d443bf1";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-aaaaaaaaaaaa";

function treeRow(id: string, parentId: string | null): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority: 100,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
		originalNodeId: null,
	};
}

const alice = treeRow(ALICE, null);
const bob = treeRow(BOB, ALICE);
const aliceLink =
{
	...alice,
	hasChildren: true,
	hasUncompletedChildren: true,
};
const bobLink =
{
	...bob,
	hasChildren: true,
	hasUncompletedChildren: true,
};

let root: Root | undefined;
let requests: string[] = [];

function respond(url: string): unknown
{
	if (url.endsWith("/backlinks"))
	{
		return {
			rootId: null,
			items: [],
		};
	}
	if (url.endsWith("/ancestors"))
	{
		return {
			ancestors: [aliceLink, bobLink],
		};
	}
	return {
		node: bob,
	};
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
		{
			requests.push(url);
			return Promise.resolve(Response.json(respond(url)));
		}),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
});

function cacheWithAliceExpanded(): QueryClient
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					staleTime: 60_000,
				},
			},
		},
	);
	queryClient.setQueryData(nodeKeys.children(null), [alice]);
	queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
	return queryClient;
}

/** The data `hook` returns on its first render, under a provider for `queryClient`. */
function firstRender<T>(queryClient: QueryClient, hook: () => T): T | undefined
{
	let first:
		|
		  {
				value: T;
		  }
		| undefined;
	function Probe()
	{
		const value = hook();
		first ??=
		{
			value,
		};
		return null;
	}
	root = createRoot(document.createElement("div"));
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(Probe),
			),
		);
	});
	return first?.value;
}

describe("zoom view from the cache", () =>
{
	it("renders a cached row's detail and ancestor chain on the first render, without a request", () =>
	{
		const queryClient = cacheWithAliceExpanded();
		const data = firstRender(queryClient, () => (
		{
			node: useNode(BOB).data,
			ancestors: useAncestors(BOB).data,
		}));
		expect(
			{
				data,
				requests,
			},
		).toStrictEqual(
			{
				data:
				{
					node: bob,
					ancestors: [aliceLink, bobLink],
				},
				requests: [],
			},
		);
	});

	it("leaves a cached zoom target's detail and chain to the cache, and its backlinks to the view load", async () =>
	{
		const queryClient = cacheWithAliceExpanded();
		await prefetchZoomView(queryClient, BOB);
		expect(requests).toStrictEqual([]);
	});

	it("prefetches the detail and chain of a target the cache does not hold", async () =>
	{
		const queryClient = new QueryClient();
		await prefetchZoomView(queryClient, BOB);
		expect(
			{
				detail: queryClient.getQueryData(nodeKeys.detail(BOB)),
				ancestors: queryClient.getQueryData(nodeKeys.ancestors(BOB)),
				requests: new Set(requests),
			},
		).toStrictEqual(
			{
				detail: bob,
				ancestors: [aliceLink, bobLink],
				requests: new Set([`/api/v1/nodes/${BOB}`, `/api/v1/nodes/${BOB}/ancestors`]),
			},
		);
	});
});
