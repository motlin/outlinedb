import {describe, expect, it, vi} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse} from "../src/node-types.js";
import type {TreeSearchResult} from "../src/server/tree-search.js";

vi.stubGlobal("localStorage", {getItem: () => null, setItem: () => {}});
vi.stubGlobal("innerWidth", 1272);
vi.stubGlobal("matchMedia", () => ({matches: false, addEventListener: () => {}}));
vi.stubGlobal("document", {
	documentElement: {dataset: {}},
	body: {classList: {toggle: () => true, contains: () => false}},
});
vi.stubGlobal("addEventListener", () => {});

const {flattenTree} = await import("../src/client/hooks/use-flattened-tree.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {currentExpansionRows, currentNavigableIds} = await import("../src/client/hooks/use-visible-nodes.js");
const {currentSearchFilter, treeSearchKey} = await import("../src/client/hooks/use-tree-search.js");
const {searchFilter} = await import("../src/client/search-filter.js");
const {searchClasses} = await import("../src/client/search-classes.js");

function node(id: string, parentId: string, name: string, childCount: number, completedAt: number | null = null) {
	const result: NodeResponse = {
		id,
		parent_id: parentId,
		name,
		note: null,
		priority: 0,
		data: {layoutMode: null},
		createdAt: null,
		modifiedAt: null,
		completedAt,
		hasChildren: childCount > 0,
		hasUncompletedChildren: childCount > 0,
	};
	return result;
}

// SF root > [Fruit apple (note) > [Green apple pie, Banana split, Cherry tart > deep apple leaf],
// Vegetables > [Carrot zebra, Potato], Done apple item (completed), Plain item #fruitTag]
const ROOT_CHILDREN = [
	node("fruit", "root", "Fruit apple", 3),
	node("veg", "root", "Vegetables", 2),
	node("done", "root", "Done apple item", 0, 1000),
	node("plain", "root", "Plain item #fruitTag", 0),
];
const CHILDREN = new Map<string, NodeResponse[]>([
	[
		"fruit",
		[
			node("green", "fruit", "Green apple pie", 0),
			node("banana", "fruit", "Banana split", 0),
			node("cherry", "fruit", "Cherry tart", 1),
		],
	],
	["cherry", [node("deep", "cherry", "deep apple leaf", 0)]],
	["veg", [node("carrot", "veg", "Carrot zebra", 0), node("potato", "veg", "Potato", 0)]],
]);

// computeTreeSearch's result for "apple" on the same fixture (test/search.test.ts).
const APPLE: TreeSearchResult = {
	matchIds: ["fruit", "green", "deep", "done"],
	nameMatchIds: ["fruit", "green", "deep", "done"],
	noteMatchIds: [],
	metaMatchIds: [],
	ancestorIds: ["fruit", "cherry"],
	halfExpandedIds: ["fruit"],
	rootHalfExpanded: true,
	completedMatchCount: 1,
	matchCount: 4,
	revealsCompleted: false,
};

function visibleNames({
	expansion = new Map<string, boolean>(),
	createdIds = new Set<string>(),
	showCompleted = false,
	result = APPLE,
}: {
	expansion?: Map<string, boolean>;
	createdIds?: Set<string>;
	showCompleted?: boolean;
	result?: TreeSearchResult;
}) {
	// The persistent expansion is deliberately empty: search expansion replaces it.
	return flattenTree(
		ROOT_CHILDREN,
		new Set(),
		showCompleted,
		0,
		CHILDREN,
		new Set(),
		searchFilter(result, createdIds, expansion),
	).map((row) => row.node.name);
}

describe("flattenTree during a search", () => {
	it("keeps matches and their ancestors, expanding ancestors", () => {
		expect(visibleNames({})).toStrictEqual(["Fruit apple", "Green apple pie", "Cherry tart", "deep apple leaf"]);
	});

	it("collapses a half-expanded ancestor set to false", () => {
		expect(visibleNames({expansion: new Map([["fruit", false]])})).toStrictEqual(["Fruit apple"]);
	});

	it("renders every child of a fully expanded ancestor", () => {
		expect(visibleNames({expansion: new Map([["fruit", true]])})).toStrictEqual([
			"Fruit apple",
			"Green apple pie",
			"Banana split",
			"Cherry tart",
			"deep apple leaf",
		]);
	});

	it("shows a completed match last when completed rows are shown", () => {
		expect(visibleNames({showCompleted: true})).toStrictEqual([
			"Fruit apple",
			"Green apple pie",
			"Cherry tart",
			"deep apple leaf",
			"Done apple item",
		]);
	});

	it("shows a completed match when the query reveals completed rows", () => {
		expect(visibleNames({result: {...APPLE, revealsCompleted: true}})).toStrictEqual([
			"Fruit apple",
			"Green apple pie",
			"Cherry tart",
			"deep apple leaf",
			"Done apple item",
		]);
	});

	it("keeps rows created while searching", () => {
		expect(visibleNames({createdIds: new Set(["plain"])})).toStrictEqual([
			"Fruit apple",
			"Green apple pie",
			"Cherry tart",
			"deep apple leaf",
			"Plain item #fruitTag",
		]);
	});

	it("keeps a row created under a match right after the row it was created from", () => {
		const children = new Map([
			...CHILDREN,
			[
				"fruit",
				[
					node("green", "fruit", "Green apple pie", 0),
					node("zz", "fruit", "zz", 0),
					node("banana", "fruit", "Banana split", 0),
					node("cherry", "fruit", "Cherry tart", 1),
				],
			],
		]);
		const search = searchFilter(APPLE, new Set(["zz"]), new Map());
		const rows = flattenTree(ROOT_CHILDREN, new Set(), false, 0, children, new Set(), search);
		expect({
			names: rows.map((row) => row.node.name),
			matchCount: search.result.matchCount,
			classes: searchClasses({id: "zz", parentId: "fruit"}, search),
		}).toStrictEqual({
			names: ["Fruit apple", "Green apple pie", "zz", "Cherry tart", "deep apple leaf"],
			matchCount: 4,
			classes: {project: ["matches", "terminalMatch"], name: [], note: []},
		});
	});

	it("reports each row's search expansion", () => {
		expect(
			flattenTree(
				ROOT_CHILDREN,
				new Set(["veg"]),
				false,
				0,
				CHILDREN,
				new Set(),
				searchFilter(APPLE, new Set(), new Map([["fruit", true]])),
			).map((row) => [row.node.id, row.isExpanded]),
		).toStrictEqual([
			["fruit", true],
			["green", false],
			["banana", false],
			["cherry", true],
			["deep", false],
		]);
	});
});

describe("toggleSearchExpansion", () => {
	it("writes the opposite of the row's current search expansion and leaves expandedIds alone", () => {
		useOutlineStore.setState({expandedIds: new Set(["veg"]), searchExpansion: new Map()});
		useOutlineStore.getState().toggleSearchExpansion("fruit", true);
		const afterCollapse = new Map(useOutlineStore.getState().searchExpansion);
		useOutlineStore.getState().toggleSearchExpansion("fruit", false);
		const {searchExpansion, expandedIds} = useOutlineStore.getState();
		expect({afterCollapse, searchExpansion, expandedIds}).toStrictEqual({
			afterCollapse: new Map([["fruit", false]]),
			searchExpansion: new Map([["fruit", true]]),
			expandedIds: new Set(["veg"]),
		});
	});
});

/** A query client holding the fixture's children under zoom root "root" plus the given tree-search results. */
function searchCache(results: [key: readonly unknown[], result: TreeSearchResult][]) {
	const queryClient = new QueryClient();
	queryClient.setQueryData(nodeKeys.children("root"), ROOT_CHILDREN);
	for (const [id, children] of CHILDREN) {
		queryClient.setQueryData(nodeKeys.children(id), children);
	}
	for (const [key, result] of results) {
		queryClient.setQueryData(key, result);
	}
	return queryClient;
}

function searchState(searchQuery: string, searchSession = 0) {
	useOutlineStore.setState({
		zoomedNodeId: "root",
		expandedIds: new Set(["veg"]),
		showCompleted: false,
		animatingCompletionIds: new Set(),
		searchQuery,
		searchRun: 0,
		searchSession,
		searchCreatedIds: new Set(),
		searchExpansion: new Map([["cherry", false]]),
		panes: [],
		activePaneId: "main",
	});
}

/** A pane zoomed to the fixture root with its own `query`; `active` makes it the pane keyboard commands act in. */
function sidePaneState(query: string, active: boolean) {
	useOutlineStore.setState({
		panes: [
			{
				id: "BBBBBBBBBBB",
				zoomedId: "root",
				backLocations: [],
				forwardLocations: [],
				query,
				expandedIds: new Set(),
			},
		],
		activePaneId: active ? "BBBBBBBBBBB" : "main",
	});
}

describe("caret walk during a search", () => {
	it("visits only the rows the search shows, with search expansion replacing expandedIds", () => {
		searchState("apple");
		const queryClient = searchCache([[treeSearchKey(0, "root", "apple", 0), APPLE]]);
		expect(currentNavigableIds(queryClient)).toStrictEqual(["root", "fruit", "green", "cherry"]);
	});

	it("walks the side pane's own search when the side pane is active", () => {
		searchState("");
		sidePaneState("apple", true);
		const queryClient = searchCache([[treeSearchKey(-1, "root", "apple", 0), APPLE]]);
		expect(currentNavigableIds(queryClient)).toStrictEqual(["root", "fruit", "green", "cherry", "deep"]);
	});

	it("walks the main search, not the side pane's, when the main pane is active", () => {
		searchState("");
		sidePaneState("apple", false);
		const queryClient = searchCache([[treeSearchKey(-1, "root", "apple", 0), APPLE]]);
		expect(currentNavigableIds(queryClient)).toStrictEqual(["root", "fruit", "veg", "carrot", "potato", "plain"]);
	});

	it("builds the expansion rows from the search's rows and expansion", () => {
		searchState("apple");
		const queryClient = searchCache([[treeSearchKey(0, "root", "apple", 0), APPLE]]);
		expect(currentExpansionRows(queryClient)).toStrictEqual([
			{id: "fruit", depth: 0, hasVisibleChildren: true},
			{id: "green", depth: 1, hasVisibleChildren: false},
			{id: "cherry", depth: 1, hasVisibleChildren: true},
		]);
	});
});

describe("currentSearchFilter while a new query loads", () => {
	const ZEBRA: TreeSearchResult = {...APPLE, matchIds: ["carrot"], ancestorIds: ["veg"]};

	it("keeps the previous result of the same search session until the new one arrives", () => {
		searchState("apple pie");
		const queryClient = searchCache([[treeSearchKey(0, "root", "apple", 0), APPLE]]);
		expect(currentSearchFilter(queryClient)?.result).toBe(APPLE);
	});

	it("shows the new result once it arrives", () => {
		searchState("zebra");
		const queryClient = searchCache([
			[treeSearchKey(0, "root", "apple", 0), APPLE],
			[treeSearchKey(0, "root", "zebra", 0), ZEBRA],
		]);
		expect(currentSearchFilter(queryClient)?.result).toBe(ZEBRA);
	});

	it("does not carry a result over a cleared search", () => {
		searchState("zebra", 1);
		const queryClient = searchCache([[treeSearchKey(0, "root", "apple", 0), APPLE]]);
		expect(currentSearchFilter(queryClient)).toBeNull();
	});

	it("is null when no search is committed", () => {
		searchState("", 0);
		const queryClient = searchCache([[treeSearchKey(0, "root", "apple", 0), APPLE]]);
		expect(currentSearchFilter(queryClient)).toBeNull();
	});
});

describe("searchFilter", () => {
	it("indexes the matches and ancestors as Sets, built once per result", () => {
		const first = searchFilter(APPLE, new Set(), new Map());
		const second = searchFilter(APPLE, new Set(["plain"]), new Map());
		expect({
			matchIds: first.matchIds,
			ancestorIds: first.ancestorIds,
			sameMatchIds: first.matchIds === second.matchIds,
		}).toStrictEqual({
			matchIds: new Set(["fruit", "green", "deep", "done"]),
			ancestorIds: new Set(["fruit", "cherry"]),
			sameMatchIds: true,
		});
	});
});

describe("setUrlSearchQuery", () => {
	it("starts a new search session when the search is cleared", () => {
		useOutlineStore.setState({searchQuery: "apple", searchSession: 3});
		useOutlineStore.getState().setUrlSearchQuery("zebra");
		const afterChange = useOutlineStore.getState().searchSession;
		useOutlineStore.getState().setUrlSearchQuery(null);
		expect({afterChange, afterClear: useOutlineStore.getState().searchSession}).toStrictEqual({
			afterChange: 3,
			afterClear: 4,
		});
	});
});
