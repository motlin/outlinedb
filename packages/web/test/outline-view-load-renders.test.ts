// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {OutlineView} = await import("../src/client/app.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {initialRowBudget} = await import("../src/client/render-window.js");
const {loadExpansion} = await import("../src/client/hooks/use-expansion-sync.js");

function row(id: string, parentId: string | null, hasChildren: boolean): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren,
		hasUncompletedChildren: hasChildren,
	};
}

const NO_BACKLINKS =
{
	rootId: null,
	items: [],
};

// Home holds alice > bob > carol, alice and bob expanded.
const view: OutlineViewResponse =
{
	lists: [
		{
			parentId: null,
			nodes: [row("alice", null, true)],
			backlinks: null,
		},
		{
			parentId: "alice",
			nodes: [row("bob", "alice", true)],
			backlinks: NO_BACKLINKS,
		},
		{
			parentId: "bob",
			nodes: [row("carol", "bob", false)],
			backlinks: NO_BACKLINKS,
		},
	],
};

let root: Root | undefined;
let requests: string[] = [];
let viewBodies: unknown[] = [];
let expansionResponse: Promise<Response> = Promise.resolve(
	Response.json(
		{},
		{
			status: 404,
		},
	),
);
let viewResponse: OutlineViewResponse = view;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	requests = [];
	viewBodies = [];
	viewResponse = view;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	useOutlineStore.setState(
		{
			expandedIds: new Set(["alice", "bob"]),
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) =>
		{
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push(url);
			if (url.endsWith("/api/v1/expansion"))
			{
				return expansionResponse;
			}
			if (url.endsWith("/api/v1/nodes/view"))
			{
				viewBodies.push(JSON.parse(init?.body as string));
				return Response.json(viewResponse);
			}
			if (url.endsWith("/api/v1/nodes"))
			{
				// Home's own children query races the view; a real server answers it, a 404 settles on its own timing.
				return Response.json(
					{
						nodes: view.lists[0]?.nodes ?? [],
					},
				);
			}
			return Response.json(
				{},
				{
					status: 404,
				},
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

/** Render the outline and record the rows each commit shows, until the loads settle. */
async function renderCommits(): Promise<string[][]>
{
	const container = document.createElement("div");
	document.body.append(container);
	// Each mutation batch is one React commit: the rows shown after each.
	const commits: string[][] = [];
	const observer = new MutationObserver(() =>
	{
		const ids = [...container.querySelectorAll("[data-node-id]")].map((element) =>
			element.getAttribute("data-node-id"),
		);
		commits.push([...new Set(ids.filter((id) => id !== null))]);
	});
	observer.observe(
		container,
		{
			childList: true,
			subtree: true,
		},
	);
	// The app's staleTime, so seeded lists do not refetch on mount.
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					retry: false,
					staleTime: 60_000,
				},
			},
		},
	);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(MemoryRouter, null, createElement(OutlineView)),
			),
		);
	});
	await act(async () =>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 50);
		});
	});
	observer.disconnect();
	return commits;
}

describe("outline view load", () =>
{
	it("loads a three-level expanded view in one request and mounts every level in the same commit", async () =>
	{
		const commits = await renderCommits();

		expect(
			{
				firstWithRows: commits.find((ids) => ids.length > 0),
				treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
				viewRequests: requests.filter((url) => url.endsWith("/api/v1/nodes/view")).length,
			},
		).toStrictEqual(
			{
				firstWithRows: ["alice", "bob", "carol"],
				treeRequests: [],
				viewRequests: 1,
			},
		);
	});

	it("loads the first view with the account's expansion without waiting on the expansion GET", async () =>
	{
		useOutlineStore.setState(
			{
				expandedIds: new Set(),
			},
		);
		let viewBodiesWhenExpansionSettled: unknown[] | undefined;
		expansionResponse = new Promise((resolve) =>
		{
			setTimeout(() =>
			{
				viewBodiesWhenExpansionSettled = [...viewBodies];
				resolve(
					Response.json(
						{
							expandedIds: ["alice", "bob", "elsewhere"],
						},
					),
				);
			}, 30);
		});
		viewResponse =
		{
			...view,
			expandedIds: ["alice", "bob"],
		};
		const expansion = loadExpansion();
		const commits = await renderCommits();
		await expansion;

		expect(
			{
				firstWithRows: commits.find((ids) => ids.length > 0),
				treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
				viewBodiesWhenExpansionSettled,
				expandedIds: useOutlineStore.getState().expandedIds,
			},
		).toStrictEqual(
			{
				firstWithRows: ["alice", "bob", "carol"],
				treeRequests: [],
				viewBodiesWhenExpansionSettled: [
					{
						rootId: null,
						expandedIds: null,
						limit: initialRowBudget(window.innerHeight),
						showCompleted: useOutlineStore.getState().showCompleted,
					},
				],
				expandedIds: new Set(["alice", "bob", "elsewhere"]),
			},
		);
	});
});
