import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {resolveWidths} from "../src/client/pane-widths.js";

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
}

async function loadStore()
{
	vi.resetModules();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	return useOutlineStore;
}

interface PaneOverrides
{
	zoomedId?: string | null;
	backLocations?: (string | null)[];
	forwardLocations?: (string | null)[];
	query?: string;
	expandedIds?: Set<string>;
}

function pane(id: string, overrides: PaneOverrides = {})
{
	return {
		id,
		zoomedId: null,
		backLocations: [],
		forwardLocations: [],
		query: "",
		expandedIds: new Set<string>(),
		...overrides,
	};
}

const PANE_ID = /^[A-Za-z0-9_-]{11}$/u;

beforeEach(() =>
{
	stubGlobals();
});

describe("pane store", () =>
{
	it("starts with no panes", async () =>
	{
		const store = await loadStore();
		expect(store.getState().panes).toStrictEqual([]);
	});

	it("opens a pane zoomed to the given node under a fresh 11-character id", async () =>
	{
		const store = await loadStore();
		const id = store.getState().openPane("alice");
		expect(
			{
				valid: PANE_ID.test(id),
				panes: store.getState().panes,
			},
		).toStrictEqual(
			{
				valid: true,
				panes: [
					pane(
						id,
						{
							zoomedId: "alice",
						},
					),
				],
			},
		);
	});

	it("seeds the new pane's search query from OpenPaneOptions.query", async () =>
	{
		const store = await loadStore();
		const first = store.getState().openPane("alice");
		const second = store.getState().openPane(
			"bob",
			{
				index: 2,
				query: "date:past ",
			},
		);
		expect(store.getState().panes).toStrictEqual([
			pane(
				first,
				{
					zoomedId: "alice",
				},
			),
			pane(
				second,
				{
					zoomedId: "bob",
					query: "date:past ",
				},
			),
		]);
	});

	it("opens a pane at Home for a null zoom", async () =>
	{
		const store = await loadStore();
		const id = store.getState().openPane(null);
		expect(store.getState().panes).toStrictEqual([pane(id)]);
	});

	it("appends each new pane after the last one by default, like upstream's New pane", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		const c = store.getState().openPane("carol");
		expect(store.getState().panes.map((p) => [p.id, p.zoomedId])).toStrictEqual([
			[a, "alice"],
			[b, "bob"],
			[c, "carol"],
		]);
	});

	it("inserts a pane at the workspace index upstream counts with the main pane at 0", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		const c = store.getState().openPane(
			"carol",
			{
				index: 1,
			},
		);
		const d = store.getState().openPane(
			"dave",
			{
				index: 3,
			},
		);
		const e = store.getState().openPane(
			"eve",
			{
				index: 0,
			},
		);
		const f = store.getState().openPane(
			"frank",
			{
				index: 99,
			},
		);
		expect(store.getState().panes.map((p) => p.id)).toStrictEqual([e, c, a, d, b, f]);
	});

	it("gives every pane a distinct id", async () =>
	{
		const store = await loadStore();
		const ids = [null, "a", "b", "c"].map((zoom) => store.getState().openPane(zoom));
		const all = [store.getState().mainPaneUrlId, ...ids];
		expect(new Set(all).size).toBe(5);
	});

	it("zooms each pane independently of the main zoom and of the other panes", async () =>
	{
		const store = await loadStore();
		store.getState().zoom("main-node");
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().zoomPane(a, "carol");
		expect(
			{
				main: store.getState().zoomedNodeId,
				panes: store.getState().panes,
			},
		).toStrictEqual(
			{
				main: "main-node",
				panes: [
					pane(
						a,
						{
							zoomedId: "carol",
							backLocations: ["alice"],
						},
					),
					pane(
						b,
						{
							zoomedId: "bob",
						},
					),
				],
			},
		);
	});

	it("keeps each pane's own back and forward stacks, like upstream's payload backLocations/forwardLocations", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane(null);
		const b = store.getState().openPane("bob");
		store.getState().zoomPane(a, "alice");
		store.getState().zoomPane(a, "carol");
		store.getState().zoomPane(b, "dave");
		store.getState().paneBack(a);
		const afterBack = store.getState().panes;
		store.getState().paneBack(a);
		store.getState().paneForward(a);
		expect(
			{
				afterBack,
				afterForward: store.getState().panes,
			},
		).toStrictEqual(
			{
				afterBack: [
					pane(
						a,
						{
							zoomedId: "alice",
							backLocations: [null],
							forwardLocations: ["carol"],
						},
					),
					pane(
						b,
						{
							zoomedId: "dave",
							backLocations: ["bob"],
						},
					),
				],
				afterForward: [
					pane(
						a,
						{
							zoomedId: "alice",
							backLocations: [null],
							forwardLocations: ["carol"],
						},
					),
					pane(
						b,
						{
							zoomedId: "dave",
							backLocations: ["bob"],
						},
					),
				],
			},
		);
	});

	it("clears the forward stack on a new pane zoom and skips re-zooming to the same node", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().zoomPane(a, "bob");
		store.getState().paneBack(a);
		store.getState().zoomPane(a, "carol");
		store.getState().zoomPane(a, "carol");
		expect(store.getState().panes).toStrictEqual([
			pane(
				a,
				{
					zoomedId: "carol",
					backLocations: ["alice"],
				},
			),
		]);
	});

	it("ignores back and forward with empty stacks", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().paneBack(a);
		store.getState().paneForward(a);
		expect(store.getState().panes).toStrictEqual([
			pane(
				a,
				{
					zoomedId: "alice",
				},
			),
		]);
	});

	it("filters a pane by its own search query, leaving the main search and other panes alone", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().setPaneQuery(b, "#todo");
		expect(
			{
				panes: store.getState().panes,
				main: store.getState().searchQuery,
			},
		).toStrictEqual(
			{
				panes: [
					pane(
						a,
						{
							zoomedId: "alice",
						},
					),
					pane(
						b,
						{
							zoomedId: "bob",
							query: "#todo",
						},
					),
				],
				main: "",
			},
		);
	});

	it("ends the pane search when the pane zooms elsewhere, like a new upstream location", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setPaneQuery(a, "#todo");
		store.getState().zoomPane(a, "bob");
		expect(store.getState().panes).toStrictEqual([
			pane(
				a,
				{
					zoomedId: "bob",
					backLocations: ["alice"],
				},
			),
		]);
	});

	it("ignores zooms and searches for a pane that is not open", async () =>
	{
		const store = await loadStore();
		store.getState().setPaneQuery("BBBBBBBBBBB", "#todo");
		store.getState().zoomPane("BBBBBBBBBBB", "bob");
		store.getState().paneBack("BBBBBBBBBBB");
		expect(store.getState().panes).toStrictEqual([]);
	});

	it("closes a middle pane, keeping the panes on either side in order", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		const c = store.getState().openPane("carol");
		store.getState().closePane(b);
		expect(store.getState().panes.map((p) => p.id)).toStrictEqual([a, c]);
	});

	it("closes all panes", async () =>
	{
		const store = await loadStore();
		store.getState().openPane("alice");
		store.getState().openPane("bob");
		store.getState().closeAllPanes();
		const {panes, mainPaneUrlId, activePaneId} = store.getState();
		expect(
			{
				panes,
				mainPaneUrlId,
				activePaneId,
			},
		).toStrictEqual(
			{
				panes: [],
				mainPaneUrlId: null,
				activePaneId: "main",
			},
		);
	});
});

describe("active pane", () =>
{
	it("starts on the main pane", async () =>
	{
		const store = await loadStore();
		expect(store.getState().activePaneId).toBe("main");
	});

	it("activates a new pane and stops editing in the previous one", async () =>
	{
		const store = await loadStore();
		store.getState().resumeEditing("carol", 3);
		const a = store.getState().openPane("alice");
		const {activePaneId, editingId, editingCaretOffset} = store.getState();
		expect(
			{
				activePaneId,
				editingId,
				editingCaretOffset,
			},
		).toStrictEqual(
			{
				activePaneId: a,
				editingId: null,
				editingCaretOffset: null,
			},
		);
	});

	it("switches the active pane among open panes", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().openPane("bob");
		store.getState().setActivePane(a);
		const first = store.getState().activePaneId;
		store.getState().setActivePane("main");
		expect(
			{
				first,
				second: store.getState().activePaneId,
			},
		).toStrictEqual(
			{
				first: a,
				second: "main",
			},
		);
	});

	it("activates the most recently active remaining pane when the active pane closes, like upstream's focus history", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		const c = store.getState().openPane("carol");
		store.getState().setActivePane(a);
		store.getState().setActivePane(c);
		store.getState().resumeEditing("dave", 0);
		store.getState().closePane(c);
		const {activePaneId, editingId} = store.getState();
		expect(
			{
				activePaneId,
				editingId,
				b: b !== a,
			},
		).toStrictEqual(
			{
				activePaneId: a,
				editingId: null,
				b: true,
			},
		);
	});

	it("returns to the main pane when the last pane closes", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().resumeEditing("bob", 0);
		store.getState().closePane(a);
		const {activePaneId, editingId, mainPaneUrlId} = store.getState();
		expect(
			{
				activePaneId,
				editingId,
				mainPaneUrlId,
			},
		).toStrictEqual(
			{
				activePaneId: "main",
				editingId: null,
				mainPaneUrlId: null,
			},
		);
	});

	it("keeps the active pane and its editing when an inactive pane closes", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().setActivePane(a);
		store.getState().resumeEditing("carol", 0);
		store.getState().closePane(b);
		const {activePaneId, editingId} = store.getState();
		expect(
			{
				activePaneId,
				editingId,
			},
		).toStrictEqual(
			{
				activePaneId: a,
				editingId: "carol",
			},
		);
	});

	it("ignores activating a pane that is not open", async () =>
	{
		const store = await loadStore();
		store.getState().setActivePane("BBBBBBBBBBB");
		expect(store.getState().activePaneId).toBe("main");
	});

	it("reads the active pane's zoom", async () =>
	{
		vi.resetModules();
		const
		{
			activeZoomedId,
			activePaneView,
			useOutlineStore: store,
		} = await import("../src/client/stores/outline.js");
		store.getState().zoom("main-node");
		const mainZoom = activeZoomedId(store.getState());
		const a = store.getState().openPane("alice");
		store.getState().openPane("bob");
		const bobZoom = activeZoomedId(store.getState());
		store.getState().setActivePane(a);
		const view = activePaneView();
		store.getState().setActivePane("main");
		expect(
			{
				mainZoom,
				bobZoom,
				viewZoom: view.zoomedNodeId,
				backToMain: activeZoomedId(store.getState()),
			},
		).toStrictEqual(
			{
				mainZoom: "main-node",
				bobZoom: "bob",
				viewZoom: "alice",
				backToMain: "main-node",
			},
		);
	});
});

describe("main pane URL id", () =>
{
	it("starts with none", async () =>
	{
		const store = await loadStore();
		expect(store.getState().mainPaneUrlId).toBeNull();
	});

	it("gives the main pane an 11-character id once the first pane opens, and keeps it for later panes", async () =>
	{
		const store = await loadStore();
		store.getState().openPane("alice");
		const first = store.getState().mainPaneUrlId;
		store.getState().openPane("bob");
		expect(
			{
				valid: PANE_ID.test(first ?? ""),
				kept: store.getState().mainPaneUrlId === first,
			},
		).toStrictEqual(
			{
				valid: true,
				kept: true,
			},
		);
	});
});

describe("closeMainPane", () =>
{
	it("makes the first pane the main pane: it takes the main id and leaves the list, the rest shift left", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		const promoted = store.getState().closeMainPane();
		const {panes, mainPaneUrlId, activePaneId} = store.getState();
		expect(
			{
				promoted,
				panes,
				mainPaneUrlId,
				activePaneId,
			},
		).toStrictEqual(
			{
				promoted: pane(
					a,
					{
						zoomedId: "alice",
					},
				),
				panes: [
					pane(
						b,
						{
							zoomedId: "bob",
						},
					),
				],
				mainPaneUrlId: a,
				activePaneId: b,
			},
		);
	});

	it("returns to a single document when the only pane is promoted", async () =>
	{
		const store = await loadStore();
		store.getState().openPane("alice");
		store.getState().closeMainPane();
		const {panes, mainPaneUrlId} = store.getState();
		expect(
			{
				panes,
				mainPaneUrlId,
			},
		).toStrictEqual(
			{
				panes: [],
				mainPaneUrlId: null,
			},
		);
	});

	it("does nothing with no panes open", async () =>
	{
		const store = await loadStore();
		expect(store.getState().closeMainPane()).toBeNull();
	});
});

describe("restorePanes", () =>
{
	const main = "AAAAAAAAAAA";
	const b = "BBBBBBBBBBB";
	const c = "CCCCCCCCCCC";

	it("opens every pane the URL names, in order, inactive, keeping main editing", async () =>
	{
		const store = await loadStore();
		store.getState().resumeEditing("bob", 0);
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes: [
					{
						id: b,
						zoomedId: "alice",
						query: null,
					},
					{
						id: c,
						zoomedId: null,
						query: "todo",
					},
				],
				activePaneId: null,
			},
		);
		const {panes, mainPaneUrlId, activePaneId, editingId} = store.getState();
		expect(
			{
				panes,
				mainPaneUrlId,
				activePaneId,
				editingId,
			},
		).toStrictEqual(
			{
				panes: [
					pane(
						b,
						{
							zoomedId: "alice",
						},
					),
					pane(
						c,
						{
							query: "todo",
						},
					),
				],
				mainPaneUrlId: main,
				activePaneId: "main",
				editingId: "bob",
			},
		);
	});

	it("activates the named pane and stops editing", async () =>
	{
		const store = await loadStore();
		store.getState().resumeEditing("bob", 0);
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes: [
					{
						id: b,
						zoomedId: "alice",
						query: null,
					},
					{
						id: c,
						zoomedId: null,
						query: null,
					},
				],
				activePaneId: c,
			},
		);
		const {activePaneId, editingId} = store.getState();
		expect(
			{
				activePaneId,
				editingId,
			},
		).toStrictEqual(
			{
				activePaneId: c,
				editingId: null,
			},
		);
	});

	it("re-zooms open panes by id without touching their history and drops panes the URL no longer names", async () =>
	{
		const store = await loadStore();
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes: [
					{
						id: b,
						zoomedId: "alice",
						query: null,
					},
					{
						id: c,
						zoomedId: "carol",
						query: null,
					},
				],
				activePaneId: c,
			},
		);
		store.getState().zoomPane(b, "bob");
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes: [
					{
						id: b,
						zoomedId: "alice",
						query: null,
					},
				],
				activePaneId: null,
			},
		);
		const {panes, activePaneId} = store.getState();
		expect(
			{
				panes,
				activePaneId,
			},
		).toStrictEqual(
			{
				panes: [
					pane(
						b,
						{
							zoomedId: "alice",
							backLocations: ["alice"],
						},
					),
				],
				activePaneId: "main",
			},
		);
	});
});

describe("per-pane expansion", () =>
{
	function stubFetch(): string[]
	{
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			async (
				_url: string,
				init?:
				{
					body?: string;
				},
			) =>
			{
				bodies.push(init?.body ?? "");
				return Promise.resolve(
					{
						ok: true,
						status: 200,
					},
				);
			},
		);
		return bodies;
	}

	it("seeds a new pane's expansion from the pane it opens from", async () =>
	{
		stubFetch();
		const store = await loadStore();
		store.getState().setExpanded(new Set(["alice"]));
		const a = store.getState().openPane(null);
		store.getState().expand("bob");
		const b = store.getState().openPane(
			null,
			{
				sourcePaneId: a,
			},
		);
		const c = store.getState().openPane(
			null,
			{
				sourcePaneId: "main",
			},
		);
		const byId = new Map(store.getState().panes.map((p) => [p.id, p.expandedIds]));
		expect([byId.get(a), byId.get(b), byId.get(c)]).toStrictEqual([
			new Set(["alice", "bob"]),
			new Set(["alice", "bob"]),
			new Set(["alice"]),
		]);
	});

	it("toggles a row only in the active pane and never saves a pane's expansion to the server", async () =>
	{
		const bodies = stubFetch();
		const store = await loadStore();
		store.getState().setExpanded(new Set(["alice"]));
		const a = store.getState().openPane(null);
		const b = store.getState().openPane(null);
		store.getState().toggleExpand("alice");
		store.getState().expand("bob");
		store.getState().setActivePane(a);
		store.getState().expand("carol");
		const byId = new Map(store.getState().panes.map((p) => [p.id, p.expandedIds]));
		expect(
			{
				main: store.getState().expandedIds,
				a: byId.get(a),
				b: byId.get(b),
				bodies,
			},
		).toStrictEqual(
			{
				main: new Set(["alice"]),
				a: new Set(["alice", "carol"]),
				b: new Set(["bob"]),
				bodies: [],
			},
		);
	});

	it("toggles a row only in the main outline while it is active", async () =>
	{
		stubFetch();
		const store = await loadStore();
		store.getState().openPane(null);
		store.getState().setActivePane("main");
		store.getState().toggleExpand("alice");
		expect(
			{
				main: store.getState().expandedIds,
				pane: store.getState().panes[0]?.expandedIds,
			},
		).toStrictEqual(
			{
				main: new Set(["alice"]),
				pane: new Set(),
			},
		);
	});

	it("keeps the pane's expansion across its zooms and history steps", async () =>
	{
		stubFetch();
		const store = await loadStore();
		const a = store.getState().openPane(null);
		store.getState().expand("alice");
		store.getState().zoomPane(a, "bob");
		store.getState().paneBack(a);
		store.getState().paneForward(a);
		store.getState().setPaneQuery(a, "todo");
		expect(store.getState().panes[0]?.expandedIds).toStrictEqual(new Set(["alice"]));
	});

	it("reads each pane's expansion and the active pane's in its view", async () =>
	{
		stubFetch();
		vi.resetModules();
		const {activePaneView, useOutlineStore: store} = await import("../src/client/stores/outline.js");
		const {paneExpandedIds} = await import("../src/client/pane-ids.js");
		store.getState().setExpanded(new Set(["main-row"]));
		const a = store.getState().openPane(null);
		store.getState().toggleExpand("main-row");
		store.getState().expand("pane-row");
		const paneView = activePaneView().expandedIds;
		store.getState().setActivePane("main");
		const state = store.getState();
		expect(
			{
				main: paneExpandedIds(state, "main"),
				pane: paneExpandedIds(state, a),
				paneView,
				mainView: activePaneView().expandedIds,
			},
		).toStrictEqual(
			{
				main: new Set(["main-row"]),
				pane: new Set(["pane-row"]),
				paneView: new Set(["pane-row"]),
				mainView: new Set(["main-row"]),
			},
		);
	});

	it("reads the main expansion for a pane id that is not open", async () =>
	{
		stubFetch();
		vi.resetModules();
		const {useOutlineStore: store} = await import("../src/client/stores/outline.js");
		const {paneExpandedIds} = await import("../src/client/pane-ids.js");
		store.getState().setExpanded(new Set(["alice"]));
		expect(paneExpandedIds(store.getState(), "BBBBBBBBBBB")).toStrictEqual(new Set(["alice"]));
	});

	it("seeds a pane restored from the URL from the main outline's expansion", async () =>
	{
		stubFetch();
		const store = await loadStore();
		store.getState().setExpanded(new Set(["alice"]));
		store.getState().restorePanes(
			{
				mainPaneId: "AAAAAAAAAAA",
				panes: [
					{
						id: "BBBBBBBBBBB",
						zoomedId: null,
						query: null,
					},
				],
				activePaneId: null,
			},
		);
		expect(store.getState().panes[0]?.expandedIds).toStrictEqual(new Set(["alice"]));
	});
});

describe("tag clicks route to the clicked pane's search", () =>
{
	async function load()
	{
		const store = await loadStore();
		const {togglePaneTagSearch} = await import("../src/client/hooks/use-commit-search.js");
		return {
			store,
			togglePaneTagSearch,
		};
	}

	it("toggles a tag clicked in a pane into that pane's query, leaving the main search and other panes alone", async () =>
	{
		const {store, togglePaneTagSearch} = await load();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().setPaneQuery(b, "#work ");
		const navigate = vi.fn<(to: string) => void>();
		togglePaneTagSearch(b, "@bob", navigate);
		expect(
			{
				queries: store.getState().panes.map((p) => [p.id, p.query]),
				main: store.getState().searchQuery,
				navigated: navigate.mock.calls,
			},
		).toStrictEqual(
			{
				queries: [
					[a, ""],
					[b, "#work @bob "],
				],
				main: "",
				navigated: [],
			},
		);
	});

	it("removes a tag clicked again in a pane from that pane's query", async () =>
	{
		const {store, togglePaneTagSearch} = await load();
		const a = store.getState().openPane("alice");
		store.getState().setPaneQuery(a, "#work @bob ");
		togglePaneTagSearch(a, "@bob", vi.fn<(to: string) => void>());
		expect(store.getState().panes[0]?.query).toBe("#work ");
	});

	it("commits a tag clicked in the main pane as the main search, leaving the pane's query alone", async () =>
	{
		const {store, togglePaneTagSearch} = await load();
		const a = store.getState().openPane("alice");
		store.getState().setPaneQuery(a, "#work ");
		const navigate = vi.fn<(to: string) => void>();
		togglePaneTagSearch("main", "@bob", navigate);
		const queries = navigate.mock.calls.map(([url]) => new URLSearchParams(url.split("#")[1]).get("q"));
		expect(
			{
				pane: store.getState().panes[0]?.query,
				queries,
			},
		).toStrictEqual(
			{
				pane: "#work ",
				queries: ["@bob "],
			},
		);
	});
});

describe("pane widths", () =>
{
	const main = "AAAAAAAAAAA";
	const b = "BBBBBBBBBBB";
	const c = "CCCCCCCCCCC";

	/** Upstream's `available()` with no measured workspace: the window beside the left bar, less the 8px gutter. */
	async function available(): Promise<number>
	{
		const store = await loadStore();
		return 1272 - store.getState().leftBarOffset() - 8;
	}

	it("has no widths with no pane open", async () =>
	{
		const store = await loadStore();
		expect(store.getState().paneWidths).toStrictEqual({});
	});

	it("gives a new pane an equal share, keeps the others while they fill the workspace, and refits on close", async () =>
	{
		const store = await loadStore();
		const total = await available();
		const a = store.getState().openPane("alice");
		const afterOne = store.getState().paneWidths;
		const two = store.getState().openPane("bob");
		const afterTwo = store.getState().paneWidths;
		store.getState().closePane(a);
		const afterClose = store.getState().paneWidths;
		store.getState().closeAllPanes();
		const [closedMain = 0, closedTwo = 0] = resolveWidths([total / 2, total / 3], [], total, false);
		expect(
			{
				afterOne,
				afterTwo,
				afterClose,
				afterAll: store.getState().paneWidths,
			},
		).toStrictEqual(
			{
				afterOne:
				{
					main: total / 2,
					[a]: total / 2,
				},
				afterTwo:
				{
					main: total / 2,
					[a]: total / 2,
					[two]: total / 3,
				},
				afterClose:
				{
					main: closedMain,
					[two]: closedTwo,
				},
				afterAll: {},
			},
		);
	});

	it("keeps widths when a pane only zooms", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setPaneWidths([500, 700]);
		store.getState().zoomPane(a, "bob");
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 500,
				[a]: 700,
			},
		);
	});

	it("sets widths in workspace order, main first, and ignores a list that does not match the panes", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const two = store.getState().openPane("bob");
		store.getState().setPaneWidths([400, 500, 600]);
		const set = store.getState().paneWidths;
		store.getState().setPaneWidths([1, 2]);
		expect(
			{
				set,
				after: store.getState().paneWidths,
			},
		).toStrictEqual(
			{
				set:
				{
					main: 400,
					[a]: 500,
					[two]: 600,
				},
				after:
				{
					main: 400,
					[a]: 500,
					[two]: 600,
				},
			},
		);
	});

	it("reads the widths in workspace order", async () =>
	{
		const store = await loadStore();
		const {workspaceWidths} = await import("../src/client/stores/outline.js");
		store.getState().openPane("alice");
		store.getState().openPane("bob");
		store.getState().setPaneWidths([400, 500, 600]);
		expect(workspaceWidths(store.getState())).toStrictEqual([400, 500, 600]);
	});

	it("restores stored pane widths, giving a pane with none an equal share", async () =>
	{
		const store = await loadStore();
		const total = await available();
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes: [
					{
						id: b,
						zoomedId: "alice",
						query: null,
					},
					{
						id: c,
						zoomedId: null,
						query: null,
					},
				],
				activePaneId: null,
				widths: [700, 500, null],
			},
		);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 700,
				[b]: 500,
				[c]: total / 3,
			},
		);
	});

	it("shares the workspace equally when a restore has no stored widths", async () =>
	{
		const store = await loadStore();
		const total = await available();
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes: [
					{
						id: b,
						zoomedId: "alice",
						query: null,
					},
				],
				activePaneId: null,
				widths: null,
			},
		);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: total / 2,
				[b]: total / 2,
			},
		);
	});

	it("keeps widths when the URL re-applies the same panes", async () =>
	{
		const store = await loadStore();
		const panes = [
			{
				id: b,
				zoomedId: "alice",
				query: null,
			},
		];
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes,
				activePaneId: null,
			},
		);
		store.getState().setPaneWidths([400, 800]);
		store.getState().restorePanes(
			{
				mainPaneId: main,
				panes,
				activePaneId: null,
			},
		);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 400,
				[b]: 800,
			},
		);
	});

	it("keeps the promoted pane's own width when the main pane closes", async () =>
	{
		const store = await loadStore();
		const total = await available();
		store.getState().openPane("alice");
		const two = store.getState().openPane("bob");
		store.getState().setPaneWidths([400, 500, 600]);
		store.getState().closeMainPane();
		const [first = 0, second = 0] = resolveWidths([500, 600], [], total, false);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: first,
				[two]: second,
			},
		);
	});
});

describe("workspaceRuntimeState", () =>
{
	it("records the pane URL ids, the active one and the widths, or nothing with no pane open", async () =>
	{
		const store = await loadStore();
		const {workspaceRuntimeState} = await import("../src/client/stores/outline.js");
		const none = workspaceRuntimeState(store.getState());
		const a = store.getState().openPane("alice");
		store.getState().setPaneWidths([400, 600]);
		const paneActive = workspaceRuntimeState(store.getState());
		store.getState().setActivePane("main");
		const main = store.getState().mainPaneUrlId;
		expect(
			{
				none,
				paneActive,
				mainActive: workspaceRuntimeState(store.getState()),
			},
		).toStrictEqual(
			{
				none: null,
				paneActive:
				{
					ids: [main, a],
					activePaneId: a,
					widths: [400, 600],
				},
				mainActive:
				{
					ids: [main, a],
					activePaneId: main,
					widths: [400, 600],
				},
			},
		);
	});
});

describe("setWorkspaceWidth", () =>
{
	it("keeps widths that fill the first measured workspace", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setPaneWidths([500, 700]);
		store.getState().setWorkspaceWidth(1200);
		expect(
			{
				widths: store.getState().paneWidths,
				measured: store.getState().workspaceWidth,
			},
		).toStrictEqual(
			{
				widths:
				{
					main: 500,
					[a]: 700,
				},
				measured: 1200,
			},
		);
	});

	it("scales panes that filled the workspace to its new width, keeping their shares", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setWorkspaceWidth(1200);
		store.getState().setPaneWidths([500, 700]);
		store.getState().setWorkspaceWidth(1800);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 750,
				[a]: 1050,
			},
		);
	});

	it("leaves panes that already overflowed the workspace alone when it grows but still overflows", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setWorkspaceWidth(1200);
		store.getState().setPaneWidths([800, 800]);
		store.getState().setWorkspaceWidth(1500);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 800,
				[a]: 800,
			},
		);
	});

	it("stretches panes that no longer fill a grown workspace", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setWorkspaceWidth(1200);
		store.getState().setPaneWidths([800, 800]);
		store.getState().setWorkspaceWidth(2000);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 1000,
				[a]: 1000,
			},
		);
	});

	it("only remembers the width with no pane open", async () =>
	{
		const store = await loadStore();
		store.getState().setWorkspaceWidth(1200);
		expect(
			{
				widths: store.getState().paneWidths,
				measured: store.getState().workspaceWidth,
			},
		).toStrictEqual(
			{
				widths: {},
				measured: 1200,
			},
		);
	});

	it("does not touch widths while a divider drag is under way", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setWorkspaceWidth(1200);
		store.getState().setPaneWidths([500, 700]);
		store.getState().setPaneResizing(true);
		store.getState().setWorkspaceWidth(1800);
		expect(store.getState().paneWidths).toStrictEqual(
			{
				main: 500,
				[a]: 700,
			},
		);
	});

	it("uses the measured workspace width as the available width for a new pane", async () =>
	{
		const store = await loadStore();
		store.getState().setWorkspaceWidth(1416);
		store.getState().openPane("alice");
		store.getState().setPaneWidths([716, 716]);
		const three = store.getState().openPane("bob");
		expect(store.getState().paneWidths[three]).toBe(472);
	});
});

describe("resizePaneDivider", () =>
{
	it("moves a divider by the delta, growing the right neighbour back to fill the workspace on a shrink", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().setWorkspaceWidth(1416);
		store.getState().setPaneWidths([716, 716]);
		store.getState().resizePaneDivider(0, -10);
		const first = store.getState().paneWidths;
		store.getState().resizePaneDivider(0, -50);
		const second = store.getState().paneWidths;
		store.getState().resizePaneDivider(0, 50);
		expect(
			{
				first,
				second,
				third: store.getState().paneWidths,
			},
		).toStrictEqual(
			{
				first:
				{
					main: 706,
					[a]: 716,
				},
				second:
				{
					main: 656,
					[a]: 760,
				},
				third:
				{
					main: 706,
					[a]: 760,
				},
			},
		);
	});

	it("ignores a pane that is not open", async () =>
	{
		const store = await loadStore();
		store.getState().resizePaneDivider(3, -10);
		expect(store.getState().paneWidths).toStrictEqual({});
	});
});

describe("canPlacePane", () =>
{
	it("allows any workspace index for an open pane or the main pane, like upstream's all item-tree workspace", async () =>
	{
		const store = await loadStore();
		const {canPlacePane} = await import("../src/client/pane-ids.js");
		const none = canPlacePane(store.getState(), "main", 0);
		const a = store.getState().openPane("alice");
		const state = store.getState();
		expect(
			{
				none,
				mainRight: canPlacePane(state, "main", 1),
				paneLeft: canPlacePane(state, a, 0),
				pastEnd: canPlacePane(state, a, 2),
				negative: canPlacePane(state, "main", -1),
				fraction: canPlacePane(state, a, 0.5),
				unknown: canPlacePane(state, "XXXXXXXXXXX", 0),
			},
		).toStrictEqual(
			{
				none: false,
				mainRight: true,
				paneLeft: true,
				pastEnd: false,
				negative: false,
				fraction: false,
				unknown: false,
			},
		);
	});
});

describe("movePane", () =>
{
	it("reorders open panes without rebalancing: each width travels with its pane", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().setPaneWidths([400, 500, 600]);
		const result = store.getState().movePane(b, 1);
		const {panes, paneWidths, mainPaneUrlId, activePaneId} = store.getState();
		expect(
			{
				result,
				panes,
				paneWidths,
				activePaneId,
				sameMain: mainPaneUrlId !== null,
			},
		).toStrictEqual(
			{
				result:
				{
					promoted: null,
				},
				panes: [
					pane(
						b,
						{
							zoomedId: "bob",
						},
					),
					pane(
						a,
						{
							zoomedId: "alice",
						},
					),
				],
				paneWidths:
				{
					main: 400,
					[a]: 500,
					[b]: 600,
				},
				activePaneId: b,
				sameMain: true,
			},
		);
	});

	it("promotes a pane moved into the main slot: the main outline becomes a pane under its URL id", async () =>
	{
		const store = await loadStore();
		store.getState().zoom("home-zoom");
		store.setState(
			{
				searchQuery: "#tag",
				expandedIds: new Set(["x"]),
			},
		);
		const a = store.getState().openPane("alice");
		const mainId = store.getState().mainPaneUrlId ?? "";
		store.getState().setPaneQuery(a, "bob");
		store.getState().setPaneWidths([400, 600]);
		const result = store.getState().movePane(a, 0);
		const {panes, paneWidths, mainPaneUrlId, activePaneId, paneFocusHistory, editingId} = store.getState();
		expect(
			{
				result,
				panes,
				paneWidths,
				mainPaneUrlId,
				activePaneId,
				paneFocusHistory,
				editingId,
			},
		).toStrictEqual(
			{
				result:
				{
					promoted: pane(
						a,
						{
							zoomedId: "alice",
							query: "bob",
							expandedIds: new Set(["x"]),
						},
					),
				},
				panes: [
					pane(
						mainId,
						{
							zoomedId: "home-zoom",
							query: "#tag",
							expandedIds: new Set(["x"]),
						},
					),
				],
				paneWidths:
				{
					main: 600,
					[mainId]: 400,
				},
				mainPaneUrlId: a,
				activePaneId: "main",
				paneFocusHistory: ["main"],
				editingId: null,
			},
		);
	});

	it("moves the main pane right: the pane it passes becomes the main outline", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		const mainId = store.getState().mainPaneUrlId ?? "";
		store.getState().setActivePane("main");
		store.getState().setPaneWidths([400, 500, 600]);
		const result = store.getState().movePane("main", 2);
		const {panes, paneWidths, activePaneId} = store.getState();
		expect(
			{
				promoted: result?.promoted?.id,
				panes: panes.map((open) => open.id),
				paneWidths,
				activePaneId,
			},
		).toStrictEqual(
			{
				promoted: a,
				panes: [b, mainId],
				paneWidths:
				{
					main: 500,
					[b]: 600,
					[mainId]: 400,
				},
				activePaneId: mainId,
			},
		);
	});

	it("does nothing for a place it cannot take or the pane's own place", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const before = store.getState().panes;
		expect(
			{
				pastEnd: store.getState().movePane(a, 2),
				own: store.getState().movePane(a, 1),
				same: store.getState().panes === before,
			},
		).toStrictEqual(
			{
				pastEnd: null,
				own:
				{
					promoted: null,
				},
				same: true,
			},
		);
	});
});

describe("pane history travels with the pane", () =>
{
	it("hands the promoted pane's own history to the main pane and the old main history to the demoted pane", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const mainId = store.getState().mainPaneUrlId ?? "";
		store.setState(
			{
				mainPaneHistory:
				{
					back: [
						{
							id: "xxxxxxxxxxxx",
							query: null,
						},
					],
					forward: [
						{
							id: "zzzzzzzzzzzz",
							query: null,
						},
					],
				},
				panes: [
					pane(
						a,
						{
							zoomedId: "alice",
							backLocations: ["yyyyyyyyyyyy"],
							forwardLocations: [null],
						},
					),
				],
			},
		);
		store.getState().movePane(a, 0);
		const {mainPaneHistory, panes} = store.getState();
		expect(
			{
				mainPaneHistory,
				demoted: panes.map(({id, backLocations, forwardLocations}) => (
				{
					id,
					backLocations,
					forwardLocations,
				})),
			},
		).toStrictEqual(
			{
				mainPaneHistory:
				{
					back: [
						{
							id: "yyyyyyyyyyyy",
							query: null,
						},
					],
					forward: [
						{
							id: null,
							query: null,
						},
					],
				},
				demoted: [
					{
						id: mainId,
						backLocations: ["xxxxxxxxxxxx"],
						forwardLocations: ["zzzzzzzzzzzz"],
					},
				],
			},
		);
	});

	it("resolves short location ids to node ids when a resolver is given", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.setState(
			{
				mainPaneHistory:
				{
					back: [
						{
							id: "short",
							query: null,
						},
					],
					forward: [],
				},
			},
		);
		store.getState().movePane(a, 0, (id) => `full-${id}`);
		expect(store.getState().panes[0]?.backLocations).toStrictEqual(["full-short"]);
	});
});

describe("pane focus requests", () =>
{
	it("requests the new pane's title when a pane opens, revealing it", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: a,
				zoomedId: "alice",
				reveal: true,
				seq: 1,
			},
		);
		const b = store.getState().openPane("bob");
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: b,
				zoomedId: "bob",
				reveal: true,
				seq: 2,
			},
		);
	});

	it("requests the zoomed pane after zoom, back and forward, but not when nothing changed", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().zoomPane(a, "bob");
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: a,
				zoomedId: "bob",
				reveal: true,
				seq: 2,
			},
		);
		store.getState().paneBack(a);
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: a,
				zoomedId: "alice",
				reveal: true,
				seq: 3,
			},
		);
		store.getState().paneForward(a);
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: a,
				zoomedId: "bob",
				reveal: true,
				seq: 4,
			},
		);
		store.getState().zoomPane(a, "bob");
		expect(store.getState().paneFocusRequest?.seq).toBe(4);
	});

	it("requests the surviving active pane after a close without revealing it", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().closePane(b);
		expect(
			{
				active: store.getState().activePaneId,
				request: store.getState().paneFocusRequest,
			},
		).toStrictEqual(
			{
				active: a,
				request:
				{
					paneId: a,
					zoomedId: "alice",
					reveal: false,
					seq: 3,
				},
			},
		);
	});

	it("requests the moved pane, which stays active", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().movePane(b, 1);
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: b,
				zoomedId: "bob",
				reveal: true,
				seq: 3,
			},
		);
		expect(store.getState().panes.map((open) => open.id)).toStrictEqual([b, a]);
	});

	it("keeps a side pane active when the main pane closes", async () =>
	{
		const store = await loadStore();
		store.getState().openPane("alice");
		const b = store.getState().openPane("bob");
		store.getState().closeMainPane();
		expect(
			{
				active: store.getState().activePaneId,
				history: store.getState().paneFocusHistory,
			},
		).toStrictEqual(
			{
				active: b,
				history: ["main", b],
			},
		);
		expect(store.getState().paneFocusRequest).toStrictEqual(
			{
				paneId: b,
				zoomedId: "bob",
				reveal: false,
				seq: 3,
			},
		);
	});

	it("renames the active pane to main when it was the promoted one", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("alice");
		store.getState().openPane("bob");
		store.getState().setActivePane(a);
		store.getState().closeMainPane();
		expect(store.getState().activePaneId).toBe("main");
		expect(store.getState().paneFocusHistory.at(-1)).toBe("main");
	});
});

describe("zoomPane on a searched pane", () =>
{
	it("treats the same zoom with a search as a different location: clears the query and pushes history", async () =>
	{
		const store = await loadStore();
		const a = store.getState().openPane("A");
		store.getState().setPaneQuery(a, "foo");
		store.getState().zoomPane(a, "A");
		expect(store.getState().panes).toStrictEqual([
			pane(
				a,
				{
					zoomedId: "A",
					backLocations: ["A"],
					query: "",
				},
			),
		]);
	});
});
