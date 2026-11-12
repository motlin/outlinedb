import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const fetchMock = vi.fn<typeof fetch>();

/** Alpha>{A1>{A1a}, A2 (completed)>{A2x}} and Beta>{B1}. */
const ALPHA_ITEMS = [
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
		hasChildren: false,
	},
	{
		id: "A2",
		parentId: "Alpha",
		completed: true,
		hasChildren: true,
	},
	{
		id: "A2x",
		parentId: "A2",
		completed: false,
		hasChildren: false,
	},
];
const HOME_ITEMS = [
	{
		id: "Alpha",
		parentId: null,
		completed: false,
		hasChildren: true,
	},
	...ALPHA_ITEMS,
	{
		id: "Beta",
		parentId: null,
		completed: false,
		hasChildren: true,
	},
	{
		id: "B1",
		parentId: "Beta",
		completed: false,
		hasChildren: false,
	},
];

function stubGlobals(): void
{
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
}

async function loadModules(expanded: string[], showCompleted = false)
{
	vi.resetModules();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	const {expandOrCollapseSubtree} = await import("../src/client/hooks/use-nodes.js");
	useOutlineStore.setState(
		{
			expandedIds: new Set(expanded),
			showCompleted,
		},
	);
	return {
		store: useOutlineStore,
		expandOrCollapseSubtree,
	};
}

function calls():
{
	url: unknown;
	method: unknown;
	body: unknown;
}[]
{
	return fetchMock.mock.calls.map(([url, init]) => (
	{
		url,
		method: init?.method,
		body: init?.body,
	}));
}

function patch(changes: Record<string, boolean>)
{
	return {
		url: "/api/v1/expansion",
		method: "PATCH",
		body: JSON.stringify(
			{
				changes,
			},
		),
	};
}

beforeEach(() =>
{
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (url) =>
	{
		if (url === "/api/v1/nodes/Alpha/subtree-ids")
		{
			return Promise.resolve(
				Response.json(
					{
						items: ALPHA_ITEMS,
					},
				),
			);
		}
		if (url === "/api/v1/nodes/home/subtree-ids")
		{
			return Promise.resolve(
				Response.json(
					{
						items: HOME_ITEMS,
					},
				),
			);
		}
		return Promise.resolve(
			new Response(
				null,
				{
					status: 204,
				},
			),
		);
	});
	stubGlobals();
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("expandOrCollapseSubtree", () =>
{
	it("expands the item and its uncached visible descendants, skipping completed subtrees", async () =>
	{
		const {store, expandOrCollapseSubtree} = await loadModules(["Beta"]);

		await expandOrCollapseSubtree("Alpha", true);

		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["Beta", "Alpha", "A1"]),
				calls: [
					{
						url: "/api/v1/nodes/Alpha/subtree-ids",
						method: undefined,
						body: undefined,
					},
					patch(
						{
							Alpha: true,
							A1: true,
						},
					),
				],
			},
		);
	});

	it("expands completed subtrees too while Show completed is on", async () =>
	{
		const {store, expandOrCollapseSubtree} = await loadModules([], true);

		await expandOrCollapseSubtree("Alpha", true);

		expect(store.getState().expandedIds).toStrictEqual(new Set(["Alpha", "A1", "A2"]));
	});

	it("collapses only the item's subtree", async () =>
	{
		const {store, expandOrCollapseSubtree} = await loadModules(["Alpha", "A1", "Beta"]);

		await expandOrCollapseSubtree("Alpha", false);

		expect(store.getState().expandedIds).toStrictEqual(new Set(["Beta"]));
	});

	it("acts on every top-level item for Home without expanding a home id", async () =>
	{
		const {store, expandOrCollapseSubtree} = await loadModules([]);

		await expandOrCollapseSubtree(null, true);

		expect(store.getState().expandedIds).toStrictEqual(new Set(["Alpha", "A1", "Beta"]));
	});
});
