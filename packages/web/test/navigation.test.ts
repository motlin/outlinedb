import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import type {ScrollWindow} from "../src/client/scroll-restoration.js";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
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

const
{
	cleanupEmptyDayOnLeave,
	closeMainPane,
	goToNode,
	movePane,
	navigateToSearch,
	nodeUrl,
	resolveZoomTarget,
	stepNav,
	syncNavLocation,
	zoomToCachedLocation,
} = await import("../src/client/navigation.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {initialNavState} = await import("../src/client/nav-stack.js");
const {encodeWorkspace} = await import("../src/client/pane-url.js");
const {installScrollRestoration, poppedScrollY} = await import("../src/client/scroll-restoration.js");

const FULL_ID = "4823cefa-5fc0-478c-88ac-35035d443bf1";

function testNode(id: string, fields: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: "",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: false,
		...fields,
	};
}

describe("resolveZoomTarget", () =>
{
	const lookup = (id: string) => (id === "35035d443bf1" ? FULL_ID : null);

	it("treats a missing id as home", () =>
	{
		expect(resolveZoomTarget(null, lookup)).toBe("home");
	});

	it("returns a full uuid as is", () =>
	{
		expect(resolveZoomTarget(FULL_ID, () => null)).toBe(FULL_ID);
	});

	it("resolves a 12-hex short id through the lookup", () =>
	{
		expect(resolveZoomTarget("35035d443bf1", lookup)).toBe(FULL_ID);
	});

	it("returns null for an unknown short id", () =>
	{
		expect(resolveZoomTarget("ffffffffffff", lookup)).toBeNull();
	});
});

describe("nodeUrl", () =>
{
	it("routes to the upstream short-id hash URL", () =>
	{
		expect(nodeUrl(FULL_ID)).toBe("/#/35035d443bf1");
	});
});

const noCachedNodes = new Map<string, string>();
const unresolved = (locationId: string) => noCachedNodes.get(locationId);

describe("in-app navigation stacks", () =>
{
	const A = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
	const B = "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb";

	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
			},
		);
	});

	function visitAB()
	{
		const navigate = vi.fn<(to: string) => void>();
		goToNode(navigate, A);
		goToNode(navigate, B);
		return navigate;
	}

	it("goToNode records the move and pushes the node URL", () =>
	{
		const navigate = visitAB();
		expect(
			{
				urls: navigate.mock.calls,
				nav: useOutlineStore.getState().nav,
			},
		).toStrictEqual(
			{
				urls: [["/#/aaaaaaaaaaaa"], ["/#/bbbbbbbbbbbb"]],
				nav:
				{
					current:
					{
						id: "bbbbbbbbbbbb",
						query: null,
					},
					back: [
						{
							id: "aaaaaaaaaaaa",
							query: null,
						},
					],
					forward: [],
				},
			},
		);
	});

	it("stepNav back pops the stack and pushes a new browser entry", () =>
	{
		visitAB();
		const navigate = vi.fn<(to: string) => void>();
		stepNav(navigate, "back", unresolved);
		expect(
			{
				urls: navigate.mock.calls,
				nav: useOutlineStore.getState().nav,
			},
		).toStrictEqual(
			{
				urls: [["/#/aaaaaaaaaaaa"]],
				nav:
				{
					current:
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					back: [],
					forward: [
						{
							id: "bbbbbbbbbbbb",
							query: null,
						},
					],
				},
			},
		);
	});

	it("stepNav zooms the outline to a target the cache resolves before it pushes the URL", () =>
	{
		visitAB();
		const zoomedWhenPushed: (string | null)[] = [];
		stepNav(
			() =>
			{
				zoomedWhenPushed.push(useOutlineStore.getState().zoomedNodeId);
			},
			"back",
			(id) => (id === "aaaaaaaaaaaa" ? A : undefined),
		);
		expect(zoomedWhenPushed).toStrictEqual([A]);
	});

	it("stepNav back owes the outline the scroll its target was left at, though it pushes a new entry", () =>
	{
		const history: ScrollWindow["history"] =
		{
			state: null,
			scrollRestoration: "auto",
		};
		const win = Object.assign(
			new EventTarget(),
			{
				scrollY: 0,
				scrollTo: () =>
				{
				},
				history,
				location:
				{
					href: "http://localhost/",
					hash: "",
				},
			},
		);
		const navigate = (to: string) =>
		{
			win.location =
			{
				href: `http://localhost${to}`,
				hash: to.slice(1),
			};
		};
		const scroll = (y: number) =>
		{
			win.scrollY = y;
			win.dispatchEvent(new Event("scroll"));
		};
		const uninstall = installScrollRestoration(win);
		goToNode(navigate, A);
		scroll(300);
		goToNode(navigate, B);
		scroll(0);
		stepNav(navigate, "back", unresolved);
		const owed = poppedScrollY(A, win);
		uninstall();
		expect(owed).toBe(300);
	});

	it("stepNav does nothing when the stack in that direction is empty", () =>
	{
		visitAB();
		const navigate = vi.fn<(to: string) => void>();
		stepNav(navigate, "forward", unresolved);
		expect(navigate.mock.calls).toStrictEqual([]);
	});

	it("stepNav home goes to the root URL", () =>
	{
		const navigate = vi.fn<(to: string) => void>();
		goToNode(navigate, null);
		goToNode(navigate, A);
		stepNav(navigate, "back", unresolved);
		expect(navigate.mock.calls.at(-1)).toStrictEqual(["/"]);
	});

	it("syncNavLocation ignores the URL the app just pushed, even in full-uuid form", () =>
	{
		visitAB();
		const before = useOutlineStore.getState().nav;
		syncNavLocation(`#/${B}`, false);
		expect(useOutlineStore.getState().nav).toBe(before);
	});

	it("syncNavLocation records a link click as a navigation and a popstate as current only", () =>
	{
		visitAB();
		syncNavLocation("#/cccccccccccc", false);
		syncNavLocation("#/aaaaaaaaaaaa", true);
		expect(useOutlineStore.getState().nav).toStrictEqual(
			{
				current:
				{
					id: "aaaaaaaaaaaa",
					query: null,
				},
				back: [
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					{
						id: "bbbbbbbbbbbb",
						query: null,
					},
				],
				forward: [],
			},
		);
	});
});

describe("goToNode in one frame", () =>
{
	const A = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
	const ws =
	{
		mainPaneId: "AAAAAAAAAAA",
		panes: [
			{
				paneId: "BBBBBBBBBBB",
				location: null,
			},
		],
	};

	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
				zoomedNodeId: null,
				panes: [],
				mainPaneUrlId: null,
			},
		);
	});

	it("zooms the store before pushing the URL, so the outline swaps without waiting for the route", () =>
	{
		const zoomedWhenPushed: (string | null)[] = [];
		goToNode(() =>
		{
			zoomedWhenPushed.push(useOutlineStore.getState().zoomedNodeId);
		}, A);
		expect(zoomedWhenPushed).toStrictEqual([A]);
	});

	it("carries the open panes' panes param so the pane sync has nothing to restore", () =>
	{
		useOutlineStore.setState(
			{
				panes: [
					{
						id: "BBBBBBBBBBB",
						zoomedId: null,
						backLocations: [],
						forwardLocations: [],
						query: "",
						expandedIds: new Set<string>(),
					},
				],
				mainPaneUrlId: "AAAAAAAAAAA",
			},
		);
		const navigate = vi.fn<(to: string) => void>();
		goToNode(navigate, A);
		expect(navigate.mock.calls).toStrictEqual([
			[
				`/#/aaaaaaaaaaaa?panes=${encodeURIComponent(encodeWorkspace(ws) ?? "")}`,
				{
					replace: true,
				},
			],
		]);
	});

	it("carries the open panes on an in-app Back", () =>
	{
		goToNode(() => {}, null);
		useOutlineStore.setState(
			{
				panes: [
					{
						id: "BBBBBBBBBBB",
						zoomedId: null,
						backLocations: [],
						forwardLocations: [],
						query: "",
						expandedIds: new Set<string>(),
					},
				],
				mainPaneUrlId: "AAAAAAAAAAA",
			},
		);
		goToNode(() => {}, A);
		const navigate = vi.fn<(to: string) => void>();
		stepNav(navigate, "back", unresolved);
		expect(navigate.mock.calls).toStrictEqual([[`/#?panes=${encodeURIComponent(encodeWorkspace(ws) ?? "")}`]]);
	});

	it("carries the open panes on a search push too", () =>
	{
		useOutlineStore.setState(
			{
				zoomedNodeId: A,
				panes: [
					{
						id: "BBBBBBBBBBB",
						zoomedId: null,
						backLocations: [],
						forwardLocations: [],
						query: "",
						expandedIds: new Set<string>(),
					},
				],
				mainPaneUrlId: "AAAAAAAAAAA",
			},
		);
		const navigate = vi.fn<
			(
				to: string,
				options?:
				{
					replace?: boolean;
				},
			) => void
		>();
		navigateToSearch(navigate, "x");
		expect(navigate.mock.calls).toStrictEqual([
			[
				`/#/aaaaaaaaaaaa?q=x&panes=${encodeURIComponent(encodeWorkspace(ws) ?? "")}`,
				{
					replace: true,
				},
			],
		]);
	});
});

describe("main pane history while panes are open", () =>
{
	const A = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
	const B = "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb";
	const C = "cccccccc-0000-0000-0000-cccccccccccc";
	const fragment = `panes=${encodeURIComponent(
		encodeWorkspace(
			{
				mainPaneId: "AAAAAAAAAAA",
				panes: [
					{
						paneId: "BBBBBBBBBBB",
						location: null,
					},
				],
			},
		) ?? "",
	)}`;

	function openPane(): void
	{
		useOutlineStore.setState(
			{
				panes: [
					{
						id: "BBBBBBBBBBB",
						zoomedId: null,
						backLocations: [],
						forwardLocations: [],
						query: "",
						expandedIds: new Set<string>(),
					},
				],
				mainPaneUrlId: "AAAAAAAAAAA",
			},
		);
	}

	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
				mainPaneHistory:
				{
					back: [],
					forward: [],
				},
				zoomedNodeId: null,
				panes: [],
				mainPaneUrlId: null,
			},
		);
	});

	it("starts empty when panes open, so Back does nothing for moves made before", () =>
	{
		goToNode(() => {}, A);
		goToNode(() => {}, B);
		openPane();
		const navigate = vi.fn<(to: string) => void>();
		stepNav(navigate, "back", unresolved);
		expect(
			{
				urls: navigate.mock.calls,
				history: useOutlineStore.getState().mainPaneHistory,
			},
		).toStrictEqual(
			{
				urls: [],
				history:
				{
					back: [],
					forward: [],
				},
			},
		);
	});

	it("goToNode replaces the entry and leaves the app stacks alone while a pane is open", () =>
	{
		const X =
		{
			id: "cccccccccccc",
			query: null,
		};
		useOutlineStore.setState(
			{
				nav:
				{
					current:
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					back: [X],
					forward: [],
				},
			},
		);
		openPane();
		const navigate = vi.fn<
			(
				to: string,
				options?:
				{
					replace?: boolean;
				},
			) => void
		>();
		goToNode(navigate, "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb");
		const {nav, mainPaneHistory} = useOutlineStore.getState();
		expect(
			{
				nav,
				mainPaneHistory,
				calls: navigate.mock.calls.map(([, options]) => options),
			},
		).toStrictEqual(
			{
				nav:
				{
					current:
					{
						id: "bbbbbbbbbbbb",
						query: null,
					},
					back: [X],
					forward: [],
				},
				mainPaneHistory:
				{
					back: [
						{
							id: "aaaaaaaaaaaa",
							query: null,
						},
					],
					forward: [],
				},
				calls: [
					{
						replace: true,
					},
				],
			},
		);
	});

	it("goToNode still pushes with no pane open", () =>
	{
		const navigate = vi.fn<
			(
				to: string,
				options?:
				{
					replace?: boolean;
				},
			) => void
		>();
		useOutlineStore.setState(
			{
				nav:
				{
					current:
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					back: [],
					forward: [],
				},
			},
		);
		goToNode(navigate, "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb");
		expect(
			{
				calls: navigate.mock.calls,
				back: useOutlineStore.getState().nav.back,
			},
		).toStrictEqual(
			{
				calls: [["/#/bbbbbbbbbbbb"]],
				back: [
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
				],
			},
		);
	});

	it("records main pane moves, not search-only changes, while panes are open", () =>
	{
		goToNode(() => {}, A);
		openPane();
		goToNode(() => {}, B);
		navigateToSearch(() => {}, "x");
		syncNavLocation("#/cccccccccccc", true);
		expect(useOutlineStore.getState().mainPaneHistory).toStrictEqual(
			{
				back: [
					{
						id: "aaaaaaaaaaaa",
						query: null,
					},
					{
						id: "bbbbbbbbbbbb",
						query: "x",
					},
				],
				forward: [],
			},
		);
	});

	it("Back and Forward step the main pane history, keeping the open panes in the URL", () =>
	{
		goToNode(() => {}, A);
		openPane();
		goToNode(() => {}, B);
		goToNode(() => {}, C);
		const navigate = vi.fn<(to: string) => void>();
		stepNav(navigate, "back", unresolved);
		stepNav(navigate, "back", unresolved);
		stepNav(navigate, "forward", unresolved);
		expect(
			{
				urls: navigate.mock.calls,
				history: useOutlineStore.getState().mainPaneHistory,
			},
		).toStrictEqual(
			{
				urls: [
					[`/#/bbbbbbbbbbbb?${fragment}`],
					[`/#/aaaaaaaaaaaa?${fragment}`],
					[`/#/bbbbbbbbbbbb?${fragment}`],
				],
				history:
				{
					back: [
						{
							id: "aaaaaaaaaaaa",
							query: null,
						},
					],
					forward: [
						{
							id: "cccccccccccc",
							query: null,
						},
					],
				},
			},
		);
	});

	it("clears when the workspace returns to one pane", () =>
	{
		goToNode(() => {}, A);
		openPane();
		goToNode(() => {}, B);
		useOutlineStore.getState().closeAllPanes();
		expect(useOutlineStore.getState().mainPaneHistory).toStrictEqual(
			{
				back: [],
				forward: [],
			},
		);
	});
});

describe("closeMainPane", () =>
{
	const B = "BBBBBBBBBBB";
	const C = "CCCCCCCCCCC";
	const pane = (id: string, zoomedId: string | null, query: string) => (
	{
		id,
		zoomedId,
		backLocations: [],
		forwardLocations: [],
		query,
		expandedIds: new Set<string>(),
	});

	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
				zoomedNodeId: null,
				activePaneId: "main",
			},
		);
	});

	it("navigates the main outline to the first pane's zoom and search, keeping the remaining panes in the URL", () =>
	{
		useOutlineStore.setState(
			{
				panes: [pane(B, FULL_ID, "#todo"), pane(C, null, "")],
				mainPaneUrlId: "AAAAAAAAAAA",
			},
		);
		const navigate = vi.fn<(to: string) => void>();
		closeMainPane(navigate);
		const {zoomedNodeId, panes, mainPaneUrlId} = useOutlineStore.getState();
		expect(
			{
				urls: navigate.mock.calls,
				zoomedNodeId,
				panes: panes.map((p) => p.id),
				mainPaneUrlId,
			},
		).toStrictEqual(
			{
				urls: [
					[
						`/#/35035d443bf1?q=%23todo&panes=${encodeURIComponent(
							encodeWorkspace(
								{
									mainPaneId: B,
									panes: [
										{
											paneId: C,
											location: null,
										},
									],
								},
							) ?? "",
						)}`,
					],
				],
				zoomedNodeId: FULL_ID,
				panes: [C],
				mainPaneUrlId: B,
			},
		);
	});

	it("returns to the single document when the only pane becomes the main outline", () =>
	{
		useOutlineStore.setState(
			{
				panes: [pane(B, FULL_ID, "")],
				mainPaneUrlId: "AAAAAAAAAAA",
			},
		);
		const navigate = vi.fn<(to: string) => void>();
		closeMainPane(navigate);
		expect(navigate.mock.calls).toStrictEqual([["/#/35035d443bf1"]]);
	});

	it("does nothing with no pane open", () =>
	{
		useOutlineStore.setState(
			{
				panes: [],
				mainPaneUrlId: null,
			},
		);
		const navigate = vi.fn<(to: string) => void>();
		closeMainPane(navigate);
		expect(navigate.mock.calls).toStrictEqual([]);
	});
});

describe("movePane", () =>
{
	const A = "AAAAAAAAAAA";
	const B = "BBBBBBBBBBB";
	const C = "CCCCCCCCCCC";
	const pane = (id: string, zoomedId: string | null, query: string) => (
	{
		id,
		zoomedId,
		backLocations: [],
		forwardLocations: [],
		query,
		expandedIds: new Set<string>(),
	});

	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
				zoomedNodeId: null,
				searchQuery: "",
				activePaneId: "main",
				panes: [pane(B, FULL_ID, "#todo"), pane(C, null, "")],
				mainPaneUrlId: A,
				paneWidths:
				{
					main: 400,
					[B]: 500,
					[C]: 600,
				},
			},
		);
	});

	it("navigates the main outline to a pane moved into the main slot, the old main outline now a pane", () =>
	{
		const navigate = vi.fn<(to: string) => void>();
		movePane(navigate, B, 0);
		const {zoomedNodeId, panes, mainPaneUrlId} = useOutlineStore.getState();
		expect(
			{
				urls: navigate.mock.calls,
				zoomedNodeId,
				panes: panes.map((p) => p.id),
				mainPaneUrlId,
			},
		).toStrictEqual(
			{
				urls: [
					[
						`/#/35035d443bf1?q=%23todo&panes=${encodeURIComponent(
							encodeWorkspace(
								{
									mainPaneId: B,
									panes: [
										{
											paneId: A,
											location: null,
										},
										{
											paneId: C,
											location: null,
										},
									],
								},
							) ?? "",
						)}`,
					],
				],
				zoomedNodeId: FULL_ID,
				panes: [A, C],
				mainPaneUrlId: B,
			},
		);
	});

	it("leaves the URL to the pane sync when the main pane stays first", () =>
	{
		const navigate = vi.fn<(to: string) => void>();
		movePane(navigate, C, 1);
		expect(
			{
				urls: navigate.mock.calls,
				panes: useOutlineStore.getState().panes.map((p) => p.id),
			},
		).toStrictEqual(
			{
				urls: [],
				panes: [C, B],
			},
		);
	});
});

describe("navigateToSearch", () =>
{
	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
				zoomedNodeId: FULL_ID,
				urlSearchQuery: null,
				panes: [],
				mainPaneUrlId: null,
			},
		);
	});

	it("pushes the zoomed node's URL with ?q= and records a non-deduped navigation", () =>
	{
		const navigate = vi.fn<(to: string) => void>();
		goToNode(navigate, FULL_ID);
		navigateToSearch(navigate, "x");
		expect(
			{
				urls: navigate.mock.calls,
				nav: useOutlineStore.getState().nav,
			},
		).toStrictEqual(
			{
				urls: [["/#/35035d443bf1"], ["/#/35035d443bf1?q=x"]],
				nav:
				{
					current:
					{
						id: "35035d443bf1",
						query: "x",
					},
					back: [
						{
							id: "35035d443bf1",
							query: null,
						},
					],
					forward: [],
				},
			},
		);
	});

	it("searches from home without an id", () =>
	{
		useOutlineStore.setState(
			{
				zoomedNodeId: null,
			},
		);
		const navigate = vi.fn<(to: string) => void>();
		navigateToSearch(navigate, "a b");
		expect(
			{
				urls: navigate.mock.calls,
				current: useOutlineStore.getState().nav.current,
			},
		).toStrictEqual(
			{
				urls: [["/#?q=a%20b"]],
				current:
				{
					id: null,
					query: "a b",
				},
			},
		);
	});

	it("an empty query clears the search back to the bare node URL", () =>
	{
		const navigate = vi.fn<(to: string) => void>();
		navigateToSearch(navigate, "");
		expect(
			{
				urls: navigate.mock.calls,
				current: useOutlineStore.getState().nav.current,
			},
		).toStrictEqual(
			{
				urls: [["/#/35035d443bf1"]],
				current:
				{
					id: "35035d443bf1",
					query: null,
				},
			},
		);
	});
});

describe("urlSearchQuery", () =>
{
	it("starts null and is set through setUrlSearchQuery", () =>
	{
		useOutlineStore.setState(
			{
				urlSearchQuery: null,
			},
		);
		const initial = useOutlineStore.getState().urlSearchQuery;
		useOutlineStore.getState().setUrlSearchQuery("x");
		expect(
			{
				initial,
				after: useOutlineStore.getState().urlSearchQuery,
			},
		).toStrictEqual(
			{
				initial: null,
				after: "x",
			},
		);
	});
});

describe("cleanupEmptyDayOnLeave", () =>
{
	const DAY = "dddddddd-0000-0000-0000-dddddddddddd";
	const CHILD = "cccccccc-0000-0000-0000-cccccccccccc";
	const OTHER = "eeeeeeee-0000-0000-0000-eeeeeeeeeeee";
	const day = testNode(
		DAY,
		{
			name: '<time startYear="2026" startMonth="10" startDay="20">Tue, Oct 20, 2026</time>',
			hasChildren: true,
			calendar:
			{
				level: "day",
				dateId: 20_261_020,
				root: false,
				foundDates: null,
				dayPrefix: null,
				restorableUniqueNode: false,
			},
		},
	);

	function leave(from: NodeResponse | undefined, children: NodeResponse[] | undefined, toId: string | null)
	{
		const deleteNode = vi.fn<(id: string) => void>();
		cleanupEmptyDayOnLeave(
			from?.id ?? null,
			toId,
			{
				getNode: (id) => (id === from?.id ? from : undefined),
				getChildren: (id) => (id === from?.id ? children : undefined),
				deleteNode,
			},
		);
		return deleteNode.mock.calls;
	}

	it("deletes the lone empty child when leaving a day for a node outside it", () =>
	{
		expect(
			leave(
				day,
				[
					testNode(
						CHILD,
						{
							parent_id: DAY,
						},
					),
				],
				OTHER,
			),
		).toStrictEqual([[CHILD]]);
	});

	it("deletes the lone empty child when leaving a day for home", () =>
	{
		expect(
			leave(
				day,
				[
					testNode(
						CHILD,
						{
							parent_id: DAY,
							note: "",
						},
					),
				],
				null,
			),
		).toStrictEqual([[CHILD]]);
	});

	it("keeps a lone child that has a name, a note or children", () =>
	{
		expect([
			leave(
				day,
				[
					testNode(
						CHILD,
						{
							name: "x",
						},
					),
				],
				OTHER,
			),
			leave(
				day,
				[
					testNode(
						CHILD,
						{
							note: "x",
						},
					),
				],
				OTHER,
			),
			leave(
				day,
				[
					testNode(
						CHILD,
						{
							hasChildren: true,
						},
					),
				],
				OTHER,
			),
		]).toStrictEqual([[], [], []]);
	});

	it("keeps an empty child that has a sibling", () =>
	{
		expect(leave(day, [testNode(CHILD), testNode(OTHER)], OTHER)).toStrictEqual([]);
	});

	it("keeps the child when navigating into it or staying on the day", () =>
	{
		expect([leave(day, [testNode(CHILD)], CHILD), leave(day, [testNode(CHILD)], DAY)]).toStrictEqual([[], []]);
	});

	it("ignores nodes that are not day pages, read-only mirrors and uncached children", () =>
	{
		const month =
		{
			...day,
			calendar:
			{
				...day.calendar!,
				level: "month",
				dateId: 20_261_000,
			},
		};
		expect([
			leave(testNode(DAY), [testNode(CHILD)], OTHER),
			leave(month, [testNode(CHILD)], OTHER),
			leave(
				day,
				[
					testNode(
						CHILD,
						{
							isMirror: true,
						},
					),
				],
				OTHER,
			),
			leave(day, undefined, OTHER),
			leave(undefined, undefined, OTHER),
		]).toStrictEqual([[], [], [], [], []]);
	});
});

describe("zoomToCachedLocation", () =>
{
	const A = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
	const resolve = (id: string) => (id === "aaaaaaaaaaaa" ? A : undefined);

	it("zooms to the node a browser Back lands on when the cache resolves it, home for no id, and waits otherwise", () =>
	{
		const zoomed: (string | null)[] = [];
		useOutlineStore.setState(
			{
				zoomedNodeId: "other",
			},
		);
		zoomToCachedLocation("#/aaaaaaaaaaaa?q=x", resolve);
		zoomed.push(useOutlineStore.getState().zoomedNodeId);
		zoomToCachedLocation("", resolve);
		zoomed.push(useOutlineStore.getState().zoomedNodeId);
		zoomToCachedLocation("#/cccccccccccc", resolve);
		zoomed.push(useOutlineStore.getState().zoomedNodeId);
		expect(zoomed).toStrictEqual([A, null, null]);
	});
});

describe("the unknown-id redirect", () =>
{
	const home =
	{
		id: null,
		query: null,
	};
	const a =
	{
		id: "aaaaaaaaaaaa",
		query: null,
	};
	const b =
	{
		id: "bbbbbbbbbbbb",
		query: null,
	};
	const dead =
	{
		id: "deaddeaddead",
		query: null,
	};

	it("does not record the dead location on a page load that redirects home", () =>
	{
		useOutlineStore.setState(
			{
				nav: initialNavState,
			},
		);
		syncNavLocation("#/deaddeaddead", true);
		syncNavLocation("", false, true);
		expect(useOutlineStore.getState().nav).toStrictEqual(
			{
				current: home,
				back: [],
				forward: [],
			},
		);
	});

	it("does not loop Back through the dead location", () =>
	{
		useOutlineStore.setState(
			{
				nav:
				{
					current: b,
					back: [a, dead],
					forward: [],
				},
			},
		);
		useOutlineStore.getState().dispatchNav(
			{
				type: "back",
			},
		);
		syncNavLocation("", false, true);
		expect(useOutlineStore.getState().nav).toStrictEqual(
			{
				current: home,
				back: [a],
				forward: [b],
			},
		);
	});
});
