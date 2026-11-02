import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";

const fetchMock = vi.fn<typeof fetch>();

function node(id: string, parentId: string | null, hasChildren: boolean, completed = false): NodeResponse
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
		completedAt: completed ? 1 : null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren,
	};
}

/** What the client holds: Alpha>{A1>{A1a}, A2 (completed)>{A2x}}; B1 under Beta was never loaded. */
function cachedClient(): QueryClient
{
	const client = new QueryClient();
	client.setQueryData(["nodes", "children", "Alpha"], [node("A1", "Alpha", true), node("A2", "Alpha", true, true)]);
	client.setQueryData(["nodes", "children", "A1"], [node("A1a", "A1", false)]);
	client.setQueryData(["nodes", "children", "A2"], [node("A2x", "A2", false)]);
	return client;
}

const FULL_ITEMS = [
	{
		id: "A1",
		parentId: "Alpha",
		completed: false,
		hasChildren: true,
	},
	{
		id: "A1a",
		parentId: "A1",
		completed: false,
		hasChildren: true,
	},
	{
		id: "A1b",
		parentId: "A1a",
		completed: false,
		hasChildren: false,
	},
];

async function loadModules()
{
	vi.resetModules();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	const {nodeKeys} = await import("../src/client/node-cache.js");
	const {expandOrCollapseSubtree} = await import("../src/client/hooks/use-nodes.js");
	useOutlineStore.setState(
		{
			expandedIds: new Set<string>(),
			showCompleted: false,
		},
	);
	return {
		store: useOutlineStore,
		nodeKeys,
		expandOrCollapseSubtree,
	};
}

beforeEach(() =>
{
	vi.useFakeTimers();
	fetchMock.mockReset();
	vi.stubGlobal(
		"localStorage",
		{
			getItem: () => null,
			setItem: () =>
			{
			},
			removeItem: () =>
			{
			},
		},
	);
	vi.stubGlobal("innerWidth", 1272);
	vi.stubGlobal("matchMedia", () => (
	{
		matches: false,
		addEventListener: () =>
		{
		},
	}));
	vi.stubGlobal(
		"document",
		{
			documentElement:
			{
				dataset: {},
			},
			body:
			{
				classList:
				{
					toggle: () => true,
					contains: () => false,
				},
			},
		},
	);
	vi.stubGlobal("addEventListener", () => {});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() =>
{
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("expandOrCollapseSubtree with a slow subtree fetch", () =>
{
	it("expands the cached subtree after 3 seconds, then the full one when the fetch lands unchanged", async () =>
	{
		let answer: (response: Response) => void = () =>
		{
		};
		fetchMock.mockImplementation(async (url) =>
			url === "/api/v1/nodes/Alpha/subtree-ids"
				? new Promise<Response>((resolve) =>
					{
						answer = resolve;
					})
				: Promise.resolve(
						new Response(
							null,
							{
								status: 204,
							},
						),
					),
		);
		const {store, expandOrCollapseSubtree} = await loadModules();

		const finished = expandOrCollapseSubtree("Alpha", true, cachedClient());
		await vi.advanceTimersByTimeAsync(2999);
		const before = new Set(store.getState().expandedIds);
		await vi.advanceTimersByTimeAsync(1);
		const afterTimeout = new Set(store.getState().expandedIds);
		await vi.advanceTimersByTimeAsync(1000);
		answer(
			Response.json(
				{
					items: FULL_ITEMS,
				},
			),
		);
		await finished;

		expect(
			{
				before,
				afterTimeout,
				final: store.getState().expandedIds,
			},
		).toStrictEqual(
			{
				before: new Set(),
				afterTimeout: new Set(["Alpha", "A1"]),
				final: new Set(["Alpha", "A1", "A1a"]),
			},
		);
	});

	it("keeps the cached result when the user changed expansion before the fetch landed", async () =>
	{
		let answer: (response: Response) => void = () =>
		{
		};
		fetchMock.mockImplementation(async (url) =>
			url === "/api/v1/nodes/Alpha/subtree-ids"
				? new Promise<Response>((resolve) =>
					{
						answer = resolve;
					})
				: Promise.resolve(
						new Response(
							null,
							{
								status: 204,
							},
						),
					),
		);
		const {store, expandOrCollapseSubtree} = await loadModules();

		const finished = expandOrCollapseSubtree("Alpha", true, cachedClient());
		await vi.advanceTimersByTimeAsync(3000);
		store.getState().toggleExpand("A1");
		answer(
			Response.json(
				{
					items: FULL_ITEMS,
				},
			),
		);
		await finished;

		expect(store.getState().expandedIds).toStrictEqual(new Set(["Alpha"]));
	});
});
