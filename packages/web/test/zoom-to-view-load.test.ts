// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {StableNavigateProvider} from "../src/client/hooks/use-stable-navigate.js";
import {useZoomTo} from "../src/client/hooks/use-zoom-to.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";
const DAVE = "5e6f7a8b-0b7d-4e5a-8c3f-dddddddddddd";

function row(id: string, parentId: string | null): NodeResponse
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
		hasChildren: true,
	};
}

const NO_BACKLINKS =
{
	rootId: null,
	items: [],
};

// alice > bob > carol > dave, bob and carol expanded.
const view: OutlineViewResponse =
{
	lists: [
		{
			parentId: ALICE,
			nodes: [row(BOB, ALICE)],
			backlinks: NO_BACKLINKS,
		},
		{
			parentId: BOB,
			nodes: [row(CAROL, BOB)],
			backlinks: NO_BACKLINKS,
		},
		{
			parentId: CAROL,
			nodes: [row(DAVE, CAROL)],
			backlinks: NO_BACKLINKS,
		},
	],
};

let root: Root | undefined;
let requests: string[] = [];

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	requests = [];
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	useOutlineStore.setState(
		{
			expandedIds: new Set([BOB, CAROL]),
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 0));
	vi.stubGlobal(
		"fetch",
		vi.fn<(url: string) => Promise<Response>>(async (url) =>
		{
			requests.push(url);
			return Promise.resolve(Response.json(url.endsWith("/api/v1/nodes/view") ? view : NO_BACKLINKS));
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

describe("useZoomTo view load", () =>
{
	it("loads a three-level expanded zoom target in one request before the swap", async () =>
	{
		const queryClient = new QueryClient();
		queryClient.setQueryData(nodeKeys.children(null), [row(ALICE, null)]);
		const probe:
		{
			zoomTo?: ReturnType<typeof useZoomTo>;
		} = {};
		function Probe({capture}: {capture: (zoomTo: ReturnType<typeof useZoomTo>) => void})
		{
			capture(useZoomTo());
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
						null,
						createElement(
							StableNavigateProvider,
							null,
							createElement(
								Probe,
								{
									capture: (zoomTo) =>
									{
										probe.zoomTo = zoomTo;
									},
								},
							),
						),
					),
				),
			);
		});

		await act(async () =>
		{
			await probe.zoomTo?.(ALICE, "first_child");
		});

		expect(
			{
				zoomed: useOutlineStore.getState().zoomedNodeId,
				lists: [ALICE, BOB, CAROL].map((id) => queryClient.getQueryData(nodeKeys.children(id))),
				treeRequests: requests.filter(
					(url) => url.includes("/children") || url.endsWith("/backlinks") || url === "/api/v1/nodes/view",
				),
			},
		).toStrictEqual(
			{
				zoomed: ALICE,
				lists: [[row(BOB, ALICE)], [row(CAROL, BOB)], [row(DAVE, CAROL)]],
				treeRequests: ["/api/v1/nodes/view"],
			},
		);
	});
});
