import {describe, expect, it, vi} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
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

const {treeSearchOptions} = await import("../src/client/hooks/use-tree-search.js");

const search =
{
	zoomedNodeId: null,
	searchRun: 0,
	searchSession: 3,
};

describe("treeSearchOptions", () =>
{
	it("scans the cache for the session's last result only while a search is committed", () =>
	{
		const queryClient = new QueryClient();

		const cleared = treeSearchOptions(
			queryClient,
			{
				...search,
				searchQuery: "",
			},
		);
		const committed = treeSearchOptions(
			queryClient,
			{
				...search,
				searchQuery: "e",
			},
		);

		expect(
			{
				cleared:
				{
					enabled: cleared.enabled,
					placeholderData: cleared.placeholderData,
				},
				committed:
				{
					enabled: committed.enabled,
					placeholderData: typeof committed.placeholderData,
				},
			},
		).toStrictEqual(
			{
				cleared:
				{
					enabled: false,
					placeholderData: undefined,
				},
				committed:
				{
					enabled: true,
					placeholderData: "function",
				},
			},
		);
	});
});

const {paneSearchState, PANE_SEARCH_SESSION} = await import("../src/client/hooks/use-tree-search.js");

describe("paneSearchState", () =>
{
	const created = new Set(["new"]);
	const expansion = new Map([["x", true]]);
	const state =
	{
		zoomedNodeId: "main-zoom",
		searchQuery: "main",
		searchRun: 4,
		searchSession: 2,
		searchCreatedIds: created,
		searchExpansion: expansion,
		panes: [
			{
				id: "BBBBBBBBBBB",
				zoomedId: "pane-zoom",
				query: "#todo",
			},
		],
	};

	it("reads the main outline's search in the main pane", () =>
	{
		expect(paneSearchState(state, "main")).toStrictEqual(
			{
				zoomedNodeId: "main-zoom",
				searchQuery: "main",
				searchRun: 4,
				searchSession: 2,
				createdIds: created,
				expansion,
			},
		);
	});

	it("reads only an open pane's own query and zoom inside that pane", () =>
	{
		expect(paneSearchState(state, "BBBBBBBBBBB")).toStrictEqual(
			{
				zoomedNodeId: "pane-zoom",
				searchQuery: "#todo",
				searchRun: 0,
				searchSession: PANE_SEARCH_SESSION,
				createdIds: new Set(),
				expansion: new Map(),
			},
		);
	});

	it("reads the main outline's search for a pane that has closed", () =>
	{
		expect(
			paneSearchState(
				{
					...state,
					panes: [],
				},
				"BBBBBBBBBBB",
			).searchQuery,
		).toBe("main");
	});
});
