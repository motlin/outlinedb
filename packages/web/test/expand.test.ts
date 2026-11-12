import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {renderToStaticMarkup} from "react-dom/server";
import {expandArrow} from "../src/client/components/expand-arrow.js";

describe("expand all fallback", () =>
{
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
		client.setQueryData(
			["nodes", "children", "Alpha"],
			[node("A1", "Alpha", true), node("A2", "Alpha", true, true)],
		);
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
});

describe("expand all subtree", () =>
{
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
});

describe("expand arrow", () =>
{
	type Click = (event: {preventDefault: () => void; stopPropagation: () => void; timeStamp: number}) => void;

	function setup(overrides: Partial<Parameters<typeof expandArrow>[0]> = {})
	{
		const calls: [string, string][] = [];
		const element = expandArrow(
			{
				nodeId: "a",
				hasChildren: true,
				isExpanded: false,
				alwaysVisible: true,
				onToggle: (id) =>
				{
					calls.push(["toggle", id]);
				},
				onExpandAll: (id) =>
				{
					calls.push(["all", id]);
				},
				onFocusRow: (id) =>
				{
					calls.push(["focus", id]);
				},
				...overrides,
			},
		);
		const props = element.props as
		{
			onClick: Click;
			onMouseDown?: (event: {preventDefault: () => void}) => void;
		};
		return {
			element,
			props,
			calls,
		};
	}

	const click = (
		props:
		{
			onClick: Click;
		},
		timeStamp = 1000,
	): void =>
	{
		props.onClick(
			{
				preventDefault()
				{
				},
				stopPropagation()
				{
				},
				timeStamp,
			},
		);
	};

	describe("expandArrow", () =>
	{
		it("puts the caret at the row start after toggling", () =>
		{
			const {props, calls} = setup();
			click(props);
			expect(calls).toStrictEqual([
				["toggle", "a"],
				["focus", "a"],
			]);
		});

		it("does not focus the row for a leaf", () =>
		{
			const {props, calls} = setup(
				{
					hasChildren: false,
					nodeId: "leaf",
				},
			);
			click(props, 5000);
			expect(calls).toStrictEqual([]);
		});

		it("does not focus the row where expanding all is unavailable (search)", () =>
		{
			const {props, calls} = setup(
				{
					onExpandAll: undefined,
					nodeId: "searched",
				},
			);
			click(props, 9000);
			expect(calls).toStrictEqual([["toggle", "searched"]]);
		});

		it("keeps mousedown from moving focus to the button", () =>
		{
			const {props} = setup();
			let prevented = false;
			props.onMouseDown?.(
				{
					preventDefault()
					{
						prevented = true;
					},
				},
			);
			expect(prevented).toBe(true);
		});

		it("draws the arrow in quinary while the controls are always visible, transparent otherwise", () =>
		{
			const style = (alwaysVisible: boolean): string | undefined =>
				/style="([^"]*)"/u.exec(
					renderToStaticMarkup(
						setup(
							{
								alwaysVisible,
							},
						).element,
					),
				)?.[1];
			expect([style(true), style(false)]).toStrictEqual(["color:var(--wf-text-quinary)", "color:transparent"]);
		});
	});
});
