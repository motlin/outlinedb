import {describe, expect, it, vi} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {loadOutlineView} from "../src/client/outline-view.js";
import type {OutlineViewRequest} from "../src/client/outline-view.js";

type FetchView = (request: OutlineViewRequest) => Promise<OutlineViewResponse>;

function node(id: string, parentId: string | null): NodeResponse
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
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
}

const NO_BACKLINKS =
{
	rootId: null,
	items: [],
};

// Home holds alice > bob > carol, every level expanded.
const response: OutlineViewResponse =
{
	lists: [
		{
			parentId: null,
			nodes: [node("alice", null)],
			backlinks: null,
		},
		{
			parentId: "alice",
			nodes: [node("bob", "alice")],
			backlinks: NO_BACKLINKS,
		},
		{
			parentId: "bob",
			nodes: [node("carol", "bob")],
			backlinks: NO_BACKLINKS,
		},
		{
			parentId: "carol",
			nodes: [],
			backlinks: NO_BACKLINKS,
		},
	],
};

const view =
{
	expandedIds: new Set(["alice", "bob", "carol"]),
	showCompleted: false,
	budget: 50,
};

function cached(queryClient: QueryClient)
{
	return {
		children: Object.fromEntries(
			["alice", "bob", "carol"].map((id) => [id, queryClient.getQueryData(nodeKeys.children(id))]),
		),
		home: queryClient.getQueryData(nodeKeys.children(null)),
		backlinks: ["alice", "bob", "carol"].map((id) => queryClient.getQueryData(nodeKeys.backlinks(id))),
	};
}

describe("loadOutlineView", () =>
{
	it("loads a three-level expanded view in one request, seeding every list and Backlinks section", async () =>
	{
		const queryClient = new QueryClient();
		const fetchView = vi.fn<FetchView>(async () => Promise.resolve(response));

		await loadOutlineView(queryClient, null, view, fetchView);

		expect(
			{
				calls: fetchView.mock.calls,
				cached: cached(queryClient),
			},
		).toStrictEqual(
			{
				calls: [
					[
						{
							rootId: null,
							expandedIds: ["alice", "bob", "carol"],
							limit: 50,
							showCompleted: false,
						},
					],
				],
				cached:
				{
					home: [node("alice", null)],
					children:
					{
						alice: [node("bob", "alice")],
						bob: [node("carol", "bob")],
						carol: [],
					},
					backlinks: [NO_BACKLINKS, NO_BACKLINKS, NO_BACKLINKS],
				},
			},
		);
	});

	it("keeps lists the cache already holds, which may carry optimistic writes", async () =>
	{
		const queryClient = new QueryClient();
		const optimistic = [node("bob", "alice"), node("new", "alice")];
		queryClient.setQueryData(nodeKeys.children("alice"), optimistic);

		await loadOutlineView(queryClient, null, view, async () => Promise.resolve(response));

		expect(queryClient.getQueryData(nodeKeys.children("alice"))).toStrictEqual(optimistic);
	});

	it("sends no request when the cache already holds the whole budgeted view", async () =>
	{
		const queryClient = new QueryClient();
		await loadOutlineView(queryClient, null, view, async () => Promise.resolve(response));
		const fetchView = vi.fn<FetchView>(async () => Promise.resolve(response));

		await loadOutlineView(queryClient, null, view, fetchView);

		expect(fetchView.mock.calls).toStrictEqual([]);
	});

	it("seeds a day page's Found Dates from the view, so they render in its swap", async () =>
	{
		const queryClient = new QueryClient();
		const foundDates =
		{
			items: [
				{
					node: node("found", "elsewhere"),
					crumbs: [],
				},
			],
		};
		const dayView: OutlineViewResponse =
		{
			lists: [
				{
					parentId: "day",
					nodes: [],
					backlinks: NO_BACKLINKS,
				},
			],
			foundDates,
		};

		await loadOutlineView(queryClient, "day", view, async () => Promise.resolve(dayView));

		expect(queryClient.getQueryData(nodeKeys.foundDates("day"))).toStrictEqual(foundDates);
	});

	it("loads a day page whose lists are cached but whose Found Dates are not", async () =>
	{
		const queryClient = new QueryClient();
		const day =
		{
			...node("day", null),
			calendar:
			{
				level: "day",
				dateId: 20_260_930,
				root: false,
				foundDates: null,
				dayPrefix: null,
			},
		};
		queryClient.setQueryData(nodeKeys.children(null), [day]);
		queryClient.setQueryData(nodeKeys.children("day"), []);
		queryClient.setQueryData(nodeKeys.backlinks("day"), NO_BACKLINKS);
		const fetchView = vi.fn<FetchView>(async () =>
			Promise.resolve(
				{
					lists: [],
					foundDates:
					{
						items: [],
					},
				},
			),
		);

		await loadOutlineView(queryClient, "day", view, fetchView);
		await loadOutlineView(queryClient, "day", view, fetchView);

		expect(fetchView.mock.calls).toHaveLength(1);
	});
});
