// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {useHashLocationZoom} from "../src/client/hooks/use-hash-location-zoom.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";

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

// Alice holds Bob, expanded, who holds Carol.
const aliceView: OutlineViewResponse =
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
	],
};

let root: Root | undefined;
let requests: string[] = [];
let releaseView: (() => void) | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	requests = [];
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	useOutlineStore.setState(
		{
			expandedIds: new Set([BOB]),
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn<(url: string) => Promise<Response>>(async (url) =>
		{
			requests.push(url);
			if (url === "/api/v1/nodes/view")
			{
				await new Promise<void>((resolve) =>
				{
					releaseView = resolve;
				});
				return Response.json(aliceView);
			}
			return Response.json(NO_BACKLINKS);
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
	releaseView = undefined;
	globalThis.history.replaceState(null, "", "/");
	vi.unstubAllGlobals();
});

function mountAtHome(): QueryClient
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children(null), [row(ALICE, null)]);
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
						initialEntries: ["/"],
					},
					createElement(Probe),
				),
			),
		);
	});
	return queryClient;
}

/** Browser Back/Forward to `hash`: the URL changes, then `popstate` fires. */
function popTo(hash: string): void
{
	act(() =>
	{
		globalThis.history.replaceState(null, "", `/${hash}`);
		globalThis.dispatchEvent(
			new PopStateEvent(
				"popstate",
				{
					state: null,
				},
			),
		);
	});
}

describe("Back/Forward into an uncached view", () =>
{
	it("keeps the shown zoom until the view's one request lands, then zooms once", async () =>
	{
		const queryClient = mountAtHome();
		const changes: (string | null)[] = [];
		const unsubscribe = useOutlineStore.subscribe((state, previous) =>
		{
			if (state.zoomedNodeId !== previous.zoomedNodeId)
			{
				changes.push(state.zoomedNodeId);
			}
		});
		popTo("#/aaaaaaaaaaaa");
		await act(async () =>
		{
			await vi.waitFor(() =>
			{
				expect(releaseView).toBeDefined();
			});
		});
		const whileLoading =
		{
			zoomed: useOutlineStore.getState().zoomedNodeId,
			changes: [...changes],
		};
		await act(async () =>
		{
			releaseView?.();
			await vi.waitFor(() =>
			{
				expect(useOutlineStore.getState().zoomedNodeId).toBe(ALICE);
			});
		});
		unsubscribe();
		expect(
			{
				whileLoading,
				changes,
				lists: [ALICE, BOB].map((id) => queryClient.getQueryData(nodeKeys.children(id))),
				viewRequests: requests.filter((url) => url === "/api/v1/nodes/view"),
			},
		).toStrictEqual(
			{
				whileLoading:
				{
					zoomed: null,
					changes: [],
				},
				changes: [ALICE],
				lists: [[row(BOB, ALICE)], [row(CAROL, BOB)]],
				viewRequests: ["/api/v1/nodes/view"],
			},
		);
	});

	it("zooms in the popstate itself when the view is cached", () =>
	{
		const queryClient = mountAtHome();
		queryClient.setQueryData(nodeKeys.children(ALICE), [row(BOB, ALICE)]);
		queryClient.setQueryData(nodeKeys.children(BOB), [row(CAROL, BOB)]);
		queryClient.setQueryData(nodeKeys.backlinks(ALICE), NO_BACKLINKS);
		queryClient.setQueryData(nodeKeys.backlinks(BOB), NO_BACKLINKS);
		popTo("#/aaaaaaaaaaaa");
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
});
