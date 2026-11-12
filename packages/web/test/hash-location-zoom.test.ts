// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {StrictMode, act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {BrowserRouter, MemoryRouter} from "react-router-dom";
import type {NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {useHashLocationZoom} from "../src/client/hooks/use-hash-location-zoom.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";

function treeRow(id: string): NodeResponse
{
	return {
		id,
		parent_id: null,
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
	};
}

let root: Root | undefined;
let requests: string[] = [];

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
		{
			requests.push(url);
			return Promise.resolve(
				new Response(
					"{}",
					{
						status: 404,
					},
				),
			);
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

function mountAt(url: string): QueryClient
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children(null), [treeRow(ALICE), treeRow(BOB)]);
	function Probe()
	{
		useHashLocationZoom();
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
				createElement(
					MemoryRouter,
					{
						initialEntries: [url],
					},
					createElement(Probe),
				),
			),
		);
	});
	return queryClient;
}

describe("useHashLocationZoom", () =>
{
	it("zooms to a short id any cached row carries without a lookup request", () =>
	{
		mountAt("/#/aaaaaaaaaaaa");
		expect(
			{
				zoomed: useOutlineStore.getState().zoomedNodeId,
				requests,
			},
		).toStrictEqual(
			{
				zoomed: ALICE,
				requests: [],
			},
		);
	});

	it("zooms from the popstate event itself when the cache resolves the new hash and holds its view", () =>
	{
		const queryClient = mountAt("/#/aaaaaaaaaaaa");
		queryClient.setQueryData(nodeKeys.children(BOB), []);
		queryClient.setQueryData(
			nodeKeys.backlinks(BOB),
			{
				rootId: BOB,
				items: [],
			},
		);
		globalThis.location.hash = "#/bbbbbbbbbbbb";
		const zoomed: (string | null)[] = [];
		// Read inside the event, before React renders anything for it.
		globalThis.addEventListener("popstate", () =>
		{
			zoomed.push(useOutlineStore.getState().zoomedNodeId);
		});
		act(() =>
		{
			globalThis.dispatchEvent(new PopStateEvent("popstate"));
		});
		expect(
			{
				zoomed,
				requests,
			},
		).toStrictEqual(
			{
				zoomed: [BOB],
				requests: [],
			},
		);
	});

	it("pushes the canonical URL exactly once when effects re-run under StrictMode", () =>
	{
		globalThis.history.replaceState(null, "", `/#/${ALICE}`);
		const before = globalThis.history.length;
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(null), [treeRow(ALICE), treeRow(BOB)]);
		function Probe()
		{
			useHashLocationZoom();
			return null;
		}
		root = createRoot(document.createElement("div"));
		act(() =>
		{
			root?.render(
				createElement(
					StrictMode,
					null,
					createElement(
						QueryClientProvider,
						{
							client: queryClient,
						},
						createElement(BrowserRouter, null, createElement(Probe)),
					),
				),
			);
		});
		expect(
			{
				grew: globalThis.history.length - before,
				hash: globalThis.location.hash,
			},
		).toStrictEqual(
			{
				grew: 1,
				hash: "#/aaaaaaaaaaaa",
			},
		);
	});
});
