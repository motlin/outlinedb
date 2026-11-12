import {describe, expect, it, afterEach, beforeEach, vi} from "vite-plus/test";
import {PROJECT_INDENT_WIDTH, resolveDropTarget} from "../src/client/outline-drop-target.js";
import type {DropRows} from "../src/client/outline-drop-target.js";
import {QueryClient} from "@tanstack/react-query";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {loadOutlineView} from "../src/client/outline-view.js";
import type {OutlineViewRequest} from "../src/client/outline-view.js";

describe("outline drop target", () =>
{
	interface FixtureNode
	{
		readonly id: string;
		readonly children?: readonly FixtureNode[];
	}

	const BASE_LEFT = 80;

	function fixtureRows(root: FixtureNode, collapsed: ReadonlySet<string>): DropRows
	{
		const order: string[] = [];
		const parents = new Map<string, string>();
		const indexes = new Map<string, number>();
		const depths = new Map<string, number>();
		const walk = (node: FixtureNode, depth: number): void =>
		{
			order.push(node.id);
			depths.set(node.id, depth);
			(node.children ?? []).forEach((child, index) =>
			{
				parents.set(child.id, node.id);
				indexes.set(child.id, index);
				walk(child, depth + 1);
			});
		};
		walk(root, -1);
		const parentOf = (id: string): string | null => parents.get(id) ?? null;
		const isDescendantOf = (id: string, ancestorId: string): boolean =>
		{
			for (let current = parentOf(id); current !== null; current = parentOf(current))
			{
				if (current === ancestorId)
				{
					return true;
				}
			}
			return false;
		};
		const step = (id: string, delta: number): string | null => order[order.indexOf(id) + delta] ?? null;
		return {
			left: (id) => (depths.get(id) ?? 0) * PROJECT_INDENT_WIDTH + BASE_LEFT,
			parentOf,
			indexOf: (id) => indexes.get(id) ?? 0,
			isRendered: (id) => ![...collapsed].some((collapsedId) => isDescendantOf(id, collapsedId)),
			nextInDocument: (id) => step(id, 1),
			previousInDocument: (id) => step(id, -1),
			isCollapsed: (id) => collapsed.has(id),
			isDescendantOf,
		};
	}

	const dnd: FixtureNode =
	{
		id: "DnD",
		children: [
			{
				id: "Alpha",
				children: [
					{
						id: "A1",
					},
					{
						id: "A2",
					},
				],
			},
			{
				id: "Bravo",
				children: [
					{
						id: "B1",
					},
				],
			},
			{
				id: "Charlie",
			},
			{
				id: "Delta",
			},
		],
	};

	const collapsedRows = fixtureRows(dnd, new Set(["Alpha", "Bravo"]));
	const expandedAlphaRows = fixtureRows(dnd, new Set(["Bravo"]));

	function resolve(rows: DropRows, predecessorId: string | null, x: number, movingIds: readonly string[] = ["Delta"])
	{
		return resolveDropTarget(
			{
				x,
				rows,
				predecessorId,
				movingIds: new Set(movingIds),
				zoomRootId: "DnD",
			},
		);
	}

	describe("resolveDropTarget", () =>
	{
		it("uses upstream's desktop indent width", () =>
		{
			expect(PROJECT_INDENT_WIDTH).toBe(36);
		});

		it("drops after a collapsed predecessor when the pointer is left of its indent threshold", () =>
		{
			expect(resolve(collapsedRows, "Alpha", 90)).toStrictEqual(
				{
					parentId: "DnD",
					index: 1,
					ambiguous: false,
				},
			);
		});

		it("drops into a collapsed predecessor as its first child, flagged ambiguous", () =>
		{
			expect(resolve(collapsedRows, "Alpha", 110)).toStrictEqual(
				{
					parentId: "Alpha",
					index: 0,
					ambiguous: true,
				},
			);
		});

		it("treats the zoom root as a container", () =>
		{
			expect(resolve(collapsedRows, "DnD", 90)).toStrictEqual(
				{
					parentId: "DnD",
					index: 0,
					ambiguous: false,
				},
			);
		});

		it("drops into a leaf predecessor past the indent threshold", () =>
		{
			expect(resolve(collapsedRows, "Charlie", 110)).toStrictEqual(
				{
					parentId: "Charlie",
					index: 0,
					ambiguous: false,
				},
			);
		});

		it("walks back past a moving predecessor", () =>
		{
			expect(resolve(collapsedRows, "Delta", 90)).toStrictEqual(
				{
					parentId: "DnD",
					index: 3,
					ambiguous: false,
				},
			);
		});

		it("outdents one level per ancestor while the pointer stays left of the threshold", () =>
		{
			expect(resolve(expandedAlphaRows, "A2", 90)).toStrictEqual(
				{
					parentId: "DnD",
					index: 1,
					ambiguous: false,
				},
			);
		});

		it("cannot move past a deeper successor", () =>
		{
			expect(resolve(expandedAlphaRows, "Alpha", 90)).toStrictEqual(
				{
					parentId: "Alpha",
					index: 0,
					ambiguous: false,
				},
			);
		});

		it("refuses a drop inside the moving subtree", () =>
		{
			expect(
				{
					left: resolve(expandedAlphaRows, "A1", 90, ["Alpha"]),
					deep: resolve(expandedAlphaRows, "A1", 150, ["Alpha"]),
				},
			).toStrictEqual(
				{
					left: null,
					deep: null,
				},
			);
		});

		it("inserts at the successor's place when no predecessor is left", () =>
		{
			const rows: DropRows =
			{
				...collapsedRows,
				previousInDocument: (id) => (id === "Alpha" ? null : collapsedRows.previousInDocument(id)),
			};
			expect(
				{
					walkedOff: resolve(rows, "Alpha", 90, ["Alpha"]),
					missing: resolve(collapsedRows, null, 90),
				},
			).toStrictEqual(
				{
					walkedOff:
					{
						parentId: "DnD",
						index: 1,
						ambiguous: false,
					},
					missing: null,
				},
			);
		});
	});
});

describe("outline store expansion", () =>
{
	const fetchMock = vi.fn<typeof fetch>();

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

	async function loadModules()
	{
		vi.resetModules();
		const {useOutlineStore} = await import("../src/client/stores/outline.js");
		const {loadExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
		return {
			store: useOutlineStore,
			loadExpansion,
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
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				new Response(
					null,
					{
						status: 204,
					},
				),
			),
		);
		stubGlobals();
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	describe("expansion deltas", () =>
	{
		it("expand then toggleExpand send one delta each", async () =>
		{
			const {store} = await loadModules();
			store.getState().expand("a");
			store.getState().toggleExpand("a");
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(),
					calls: [
						patch(
							{
								a: true,
							},
						),
						patch(
							{
								a: false,
							},
						),
					],
				},
			);
		});

		it("replaceExpanded sends the whole delta in one PATCH", async () =>
		{
			const {store} = await loadModules();
			store.getState().replaceExpanded(new Set(["a", "b"]));
			fetchMock.mockClear();
			store.getState().replaceExpanded(new Set(["c"]));
			expect(calls()).toStrictEqual([
				patch(
					{
						c: true,
						a: false,
						b: false,
					},
				),
			]);
		});

		it("sends nothing when the set does not change", async () =>
		{
			const {store} = await loadModules();
			store.getState().expand("a");
			fetchMock.mockClear();
			store.getState().expand("a");
			store.getState().collapse("b");
			expect(calls()).toStrictEqual([]);
		});

		it("stops sending after a 503 PATCH", async () =>
		{
			const {store} = await loadModules();
			fetchMock.mockImplementation(async () =>
				Promise.resolve(
					Response.json(
						{
							error: "not configured",
						},
						{
							status: 503,
						},
					),
				),
			);
			store.getState().expand("a");
			await vi.waitFor(() =>
			{
				expect(fetchMock).toHaveBeenCalledOnce();
			});
			await new Promise((resolve) =>
			{
				setTimeout(resolve, 0);
			});
			store.getState().expand("b");
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["a", "b"]),
					calls: [
						patch(
							{
								a: true,
							},
						),
					],
				},
			);
		});
	});

	describe("loadExpansion", () =>
	{
		it("hydrates expandedIds from GET without sending a PATCH", async () =>
		{
			const {store, loadExpansion} = await loadModules();
			fetchMock.mockImplementation(async () =>
				Promise.resolve(
					Response.json(
						{
							version: "aaaaaaaaaaaaaaaa",
							expandedIds: ["a", "b"],
						},
					),
				),
			);
			await loadExpansion();
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["a", "b"]),
					calls: [
						{
							url: "/api/v1/expansion",
							method: undefined,
							body: undefined,
						},
					],
				},
			);
		});

		it("shares one GET between repeated loads, as StrictMode's double effect does", async () =>
		{
			const {store, loadExpansion} = await loadModules();
			fetchMock.mockImplementation(async () =>
				Promise.resolve(
					Response.json(
						{
							version: "aaaaaaaaaaaaaaaa",
							expandedIds: ["a"],
						},
					),
				),
			);
			await Promise.all([loadExpansion(), loadExpansion()]);
			await loadExpansion();
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["a"]),
					calls: [
						{
							url: "/api/v1/expansion",
							method: undefined,
							body: undefined,
						},
					],
				},
			);
		});

		it("retries a page-load GET through an API restart (502, refused connection) without logging", async () =>
		{
			const {store, loadExpansion} = await loadModules();
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.useFakeTimers();
			fetchMock
				.mockImplementationOnce(async () =>
					Promise.resolve(
						new Response(
							"Bad Gateway",
							{
								status: 502,
							},
						),
					),
				)
				.mockImplementationOnce(async () => Promise.reject(new TypeError("Failed to fetch")))
				.mockImplementationOnce(async () =>
					Promise.resolve(
						Response.json(
							{
								version: "aaaaaaaaaaaaaaaa",
								expandedIds: ["a"],
							},
						),
					),
				);
			const loading = loadExpansion();
			await vi.runAllTimersAsync();
			await loading;
			const logged = [...errors.mock.calls];
			vi.useRealTimers();
			errors.mockRestore();
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
					errors: logged,
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["a"]),
					calls: [
						{
							url: "/api/v1/expansion",
							method: undefined,
							body: undefined,
						},
						{
							url: "/api/v1/expansion",
							method: undefined,
							body: undefined,
						},
						{
							url: "/api/v1/expansion",
							method: undefined,
							body: undefined,
						},
					],
					errors: [],
				},
			);
		});

		it("leaves an empty set on 503 and keeps later changes in memory", async () =>
		{
			const {store, loadExpansion} = await loadModules();
			fetchMock.mockImplementation(async () =>
				Promise.resolve(
					Response.json(
						{
							error: "not configured",
						},
						{
							status: 503,
						},
					),
				),
			);
			await loadExpansion();
			const afterLoad = new Set(store.getState().expandedIds);
			store.getState().expand("a");
			expect(
				{
					afterLoad,
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					afterLoad: new Set(),
					expandedIds: new Set(["a"]),
					calls: [
						{
							url: "/api/v1/expansion",
							method: undefined,
							body: undefined,
						},
					],
				},
			);
		});
	});

	describe("pollExpansion", () =>
	{
		/** Past the grace a poll waits out after a local change. */
		const LOCAL_GRACE_PASSED_MS = 10_000;
		const V100 = "0000000000000100";
		const V200 = "0000000000000200";
		const asked = (version: string) => (
		{
			url: `/api/v1/expansion?version=${version}`,
			method: undefined,
			body: undefined,
		});

		async function loaded(ids: string[], version = V100)
		{
			const modules = await loadModules();
			const {pollExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
			serve(version, ids);
			await modules.loadExpansion();
			fetchMock.mockClear();
			return {
				...modules,
				pollExpansion,
			};
		}

		function serve(version: string, expandedIds: string[] | null): void
		{
			fetchMock.mockImplementation(async () =>
				Promise.resolve(
					Response.json(
						{
							version,
							expandedIds,
						},
					),
				),
			);
		}

		it("asks whether the keys differ from the page load's version and applies them without PATCHing them back", async () =>
		{
			const {store, pollExpansion} = await loaded(["a", "b"]);
			serve(V200, ["b", "c"]);
			await pollExpansion();
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["b", "c"]),
					calls: [asked(V100)],
				},
			);
		});

		it("adopts each answer's version, even one the server stamped earlier", async () =>
		{
			const {pollExpansion} = await loaded(["a"], V200);
			serve(V100, ["a", "b"]);
			await pollExpansion();
			serve(V100, null);
			await pollExpansion();
			expect(calls()).toStrictEqual([asked(V200), asked(V100)]);
		});

		it("keeps the same set instance when the keys still match the version", async () =>
		{
			const {store, pollExpansion} = await loaded(["a"]);
			const before = store.getState().expandedIds;
			serve(V100, null);
			await pollExpansion();
			expect(
				{
					same: store.getState().expandedIds === before,
					calls: calls(),
				},
			).toStrictEqual(
				{
					same: true,
					calls: [asked(V100)],
				},
			);
		});

		it("does not poll before the page load has set a version", async () =>
		{
			await loadModules();
			const {pollExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
			await pollExpansion();
			expect(calls()).toStrictEqual([]);
		});

		it("discards a response, keeping the version, when a local change happened while it was in flight", async () =>
		{
			const {store, pollExpansion} = await loaded(["a"]);
			let resolve: (response: Response) => void = () =>
			{
			};
			fetchMock.mockImplementationOnce(
				async () =>
					new Promise<Response>((r) =>
					{
						resolve = r;
					}),
			);
			const polling = pollExpansion(60_000);
			store.getState().expand("z");
			resolve(
				Response.json(
					{
						version: V200,
						expandedIds: [],
					},
				),
			);
			await polling;
			fetchMock.mockClear();
			serve(V200, null);
			await pollExpansion(Date.now() + LOCAL_GRACE_PASSED_MS);
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["a", "z"]),
					calls: [asked(V100)],
				},
			);
		});

		it("skips the poll shortly after a local change the server may not have pushed yet", async () =>
		{
			vi.spyOn(Date, "now").mockReturnValue(28_000);
			const {store, pollExpansion} = await loaded(["a"]);
			store.getState().expand("z");
			fetchMock.mockClear();
			await pollExpansion(30_000);
			vi.restoreAllMocks();
			expect(
				{
					expandedIds: store.getState().expandedIds,
					calls: calls(),
				},
			).toStrictEqual(
				{
					expandedIds: new Set(["a", "z"]),
					calls: [],
				},
			);
		});

		it("does nothing once expansion persistence is disabled", async () =>
		{
			const {loadExpansion} = await loadModules();
			const {pollExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
			fetchMock.mockImplementation(async () =>
				Promise.resolve(
					Response.json(
						{
							error: "not configured",
						},
						{
							status: 503,
						},
					),
				),
			);
			await loadExpansion();
			fetchMock.mockClear();
			await pollExpansion();
			expect(calls()).toStrictEqual([]);
		});

		it("aborts a poll that has not answered in 30s and keeps the expanded set", async () =>
		{
			const {store, pollExpansion} = await loaded(["a"]);
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.useFakeTimers();
			fetchMock.mockImplementationOnce(
				async (_url, init) =>
					new Promise<Response>((_resolve, reject) =>
					{
						init?.signal?.addEventListener("abort", () =>
						{
							reject(new DOMException("aborted", "AbortError"));
						});
					}),
			);
			let settled = false;
			const polling = pollExpansion(60_000).then(() =>
			{
				settled = true;
				return settled;
			});
			await vi.advanceTimersByTimeAsync(29_999);
			const early = settled;
			await vi.advanceTimersByTimeAsync(1);
			await polling;
			vi.useRealTimers();
			const logged = errors.mock.calls.length;
			errors.mockRestore();
			expect(
				{
					early,
					settled,
					expandedIds: store.getState().expandedIds,
					logged,
				},
			).toStrictEqual(
				{
					early: false,
					settled: true,
					expandedIds: new Set(["a"]),
					logged: 1,
				},
			);
		});
	});
});

describe("outline view load", () =>
{
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
});
