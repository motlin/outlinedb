// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi, beforeEach} from "vite-plus/test";
import {runZoomAnimation} from "../src/client/zoom-animation.js";
import {setZoomViewLoader, zoomWhenViewReady} from "../src/client/zoom-gate.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {outlineViewKey} from "../src/client/outline-view.js";
import {StableNavigateProvider} from "../src/client/hooks/use-stable-navigate.js";
import {useZoomTo} from "../src/client/hooks/use-zoom-to.js";
import {prefetchZoomView, useAncestors, useNode} from "../src/client/hooks/use-nodes.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("zoom animation dom", () =>
{
	interface Box
	{
		left: number;
		top: number;
		width?: number;
	}

	/** Make `el` report `box` as its bounding rect. */
	function place(el: Element, {left, top, width = 400}: Box): void
	{
		vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
			{
				left,
				top,
				x: left,
				y: top,
				width,
				height: 20,
				right: left + width,
				bottom: top + 20,
				toJSON: () => ({}),
			},
		);
	}

	function row(id: string, text: string, rowBox: Box, nameBox: Box, children: HTMLElement[] = []): HTMLElement
	{
		const el = document.createElement("div");
		el.className = "project";
		const name = document.createElement("div");
		name.className = "name";
		const bullet = document.createElement("a");
		bullet.className = "bullet";
		bullet.dataset.itemId = id;
		const content = document.createElement("div");
		content.className = "content";
		content.textContent = text;
		content.style.fontSize = "16px";
		name.append(bullet, content);
		const kids = document.createElement("div");
		kids.className = "children";
		kids.append(...children);
		el.append(name, kids);
		place(el, rowBox);
		place(name, nameBox);
		place(
			content,
			{
				left: rowBox.left + 24,
				top: rowBox.top,
			},
		);
		return el;
	}

	/** Each animated element's label and its two keyframes. */
	function recordAnimations(): string[]
	{
		const seen: string[] = [];
		vi.spyOn(Element.prototype, "animate").mockImplementation(function animate(this: Element, keyframes)
		{
			const frames = keyframes as Keyframe[];
			const label =
				this.parentElement === document.body
					? `clone ${(this as HTMLElement).style.fontSize}`
					: this.textContent.slice(0, 8);
			seen.push(`${label}: ${frames.map((k) => `${String(k.opacity)} ${String(k.transform)}`).join(" -> ")}`);
			return {
				finished: Promise.resolve(),
				cancel: () =>
				{
				},
			} as unknown as Animation;
		});
		return seen;
	}

	afterEach(() =>
	{
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	describe("runZoomAnimation", () =>
	{
		it("zooming in slides the title, row, siblings and children by the rows' offset, whatever the .name boxes span", async () =>
		{
			const child = row(
				"c",
				"Child",
				{
					left: 116,
					top: 280,
				},
				{
					left: -384,
					top: 280,
				},
			);
			const moving = row(
				"m",
				"Moving",
				{
					left: 80,
					top: 252,
				},
				{
					left: -420,
					top: 252,
				},
				[child],
			);
			const sibling = row(
				"s",
				"Sibling",
				{
					left: 80,
					top: 140,
				},
				{
					left: -420,
					top: 140,
				},
			);
			const title = row(
				"t",
				"Title",
				{
					left: 80,
					top: 96,
				},
				{
					left: -20,
					top: 96,
				},
			);
			title.classList.add("root");
			title.querySelector<HTMLElement>(":scope > .name > .content")!.style.fontSize = "27px";
			title.querySelector(":scope > .children")!.append(sibling, moving);
			document.body.append(title);
			const seen = recordAnimations();

			await runZoomAnimation(false, "m");

			const away = "0 translate(-36px, -136px)";
			expect(seen).toStrictEqual([
				"clone 16px: 1 none -> 0 translate(0px, -156px) scale(1.6875)",
				"clone 27px: 1 scale(0.5925925925925926) -> 1 translate(0px, -156px)",
				`Title: 1 none -> ${away}`,
				`Moving: 1 none -> ${away}`,
				"Child: 1 none -> 1 translate(-36px, -136px)",
				`Sibling: 1 none -> ${away}`,
			]);
			expect(document.body.children).toHaveLength(1);
		});
	});
});

describe("zoom gate", () =>
{
	const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
	const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
	const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";

	interface Load
	{
		target: string | null;
		resolve: () => void;
	}

	let loads: Load[] = [];
	let uninstall: (() => void) | undefined;

	/** A loader holding every target but `cached` until the test resolves its load. */
	function installLoader(cached: ReadonlySet<string | null> = new Set()): void
	{
		uninstall = setZoomViewLoader(
			{
				cached: (target) => cached.has(target),
				load: async (target) =>
					new Promise<void>((resolve) =>
					{
						loads.push(
							{
								target,
								resolve,
							},
						);
					}),
			},
		);
	}

	/** Resolve every pending load and let the gate's continuations run. */
	async function finishLoads(): Promise<void>
	{
		for (const load of loads.splice(0))
		{
			load.resolve();
		}
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 0);
		});
	}

	/** Zoom the store through the gate, recording each landing. */
	function gatedZoom(target: string | null, landed: (string | null)[]): void
	{
		zoomWhenViewReady(target, () =>
		{
			landed.push(target);
			useOutlineStore.getState().zoom(target);
		});
	}

	beforeEach(() =>
	{
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		loads = [];
	});

	afterEach(() =>
	{
		uninstall?.();
		uninstall = undefined;
	});

	describe("zoomWhenViewReady", () =>
	{
		it("lands at once with no loader registered", () =>
		{
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			expect(
				{
					landed,
					zoomed: useOutlineStore.getState().zoomedNodeId,
				},
			).toStrictEqual(
				{
					landed: [ALICE],
					zoomed: ALICE,
				},
			);
		});

		it("lands at once when the view is cached", () =>
		{
			installLoader(new Set([ALICE]));
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			expect(
				{
					landed,
					loads: loads.length,
				},
			).toStrictEqual(
				{
					landed: [ALICE],
					loads: 0,
				},
			);
		});

		it("holds the zoom on the shown view until an uncached view loads, then lands once", async () =>
		{
			installLoader();
			const changes: (string | null)[] = [];
			const unsubscribe = useOutlineStore.subscribe((state, previous) =>
			{
				if (state.zoomedNodeId !== previous.zoomedNodeId)
				{
					changes.push(state.zoomedNodeId);
				}
			});
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			const held =
			{
				landed: [...landed],
				changes: [...changes],
				loading: loads.map((load) => load.target),
			};
			await finishLoads();
			unsubscribe();
			expect(
				{
					held,
					landed,
					changes,
				},
			).toStrictEqual(
				{
					held:
					{
						landed: [],
						changes: [],
						loading: [ALICE],
					},
					landed: [ALICE],
					changes: [ALICE],
				},
			);
		});

		it("starts one load for a target asked again while it loads", async () =>
		{
			installLoader();
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			gatedZoom(ALICE, landed);
			const loading = loads.map((load) => load.target);
			await finishLoads();
			expect(
				{
					loading,
					landed,
				},
			).toStrictEqual(
				{
					loading: [ALICE],
					landed: [ALICE],
				},
			);
		});

		it("drops a held zoom a later one replaced", async () =>
		{
			installLoader();
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			gatedZoom(BOB, landed);
			await finishLoads();
			expect(
				{
					landed,
					zoomed: useOutlineStore.getState().zoomedNodeId,
				},
			).toStrictEqual(
				{
					landed: [BOB],
					zoomed: BOB,
				},
			);
		});

		it("drops a held zoom when a zoom back to the shown view cancels it", async () =>
		{
			installLoader();
			useOutlineStore.getState().zoom(CAROL);
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			gatedZoom(CAROL, landed);
			await finishLoads();
			expect(
				{
					landed,
					zoomed: useOutlineStore.getState().zoomedNodeId,
				},
			).toStrictEqual(
				{
					landed: [CAROL],
					zoomed: CAROL,
				},
			);
		});

		it("drops a held zoom when the outline zoomed elsewhere meanwhile", async () =>
		{
			installLoader();
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			useOutlineStore.getState().zoom(BOB);
			await finishLoads();
			expect(
				{
					landed,
					zoomed: useOutlineStore.getState().zoomedNodeId,
				},
			).toStrictEqual(
				{
					landed: [],
					zoomed: BOB,
				},
			);
		});

		it("lands a target asked again after the outline zoomed elsewhere while it loaded", async () =>
		{
			installLoader();
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			useOutlineStore.getState().zoom(BOB);
			gatedZoom(ALICE, landed);
			await finishLoads();
			expect(
				{
					landed,
					zoomed: useOutlineStore.getState().zoomedNodeId,
				},
			).toStrictEqual(
				{
					landed: [ALICE],
					zoomed: ALICE,
				},
			);
		});

		it("still lands when the load fails", async () =>
		{
			uninstall = setZoomViewLoader(
				{
					cached: () => false,
					load: async () => Promise.reject(new Error("offline")),
				},
			);
			const landed: (string | null)[] = [];
			gatedZoom(ALICE, landed);
			await new Promise((resolve) =>
			{
				setTimeout(resolve, 0);
			});
			expect(landed).toStrictEqual([ALICE]);
		});
	});
});

describe("zoom to prefetch", () =>
{
	const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
	const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";

	const alice: NodeResponse =
	{
		id: ALICE,
		parent_id: null,
		name: "alice",
		note: null,
		priority: 100,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
	};
	const bob: NodeResponse =
	{
		...alice,
		id: BOB,
		parent_id: ALICE,
		name: "bob",
	};

	let root: Root | undefined;
	let releaseView: () => void = () =>
	{
	};
	const NO_BACKLINKS =
	{
		rootId: null,
		items: [],
	};

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
			{
				if (url.endsWith("/api/v1/nodes/view"))
				{
					await new Promise<void>((resolve) =>
					{
						releaseView = resolve;
					});
					return Response.json(
						{
							lists: [
								{
									parentId: ALICE,
									nodes: [bob],
									backlinks: NO_BACKLINKS,
								},
							],
						},
					);
				}
				return Response.json(NO_BACKLINKS);
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

	describe("useZoomTo", () =>
	{
		it("swaps to the new zoom once its view load has brought its Backlinks section, then edits its first child after that paint", async () =>
		{
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children(null), [alice]);
			queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
			const probe:
			{
				zoomTo?: ReturnType<typeof useZoomTo>;
			} = {};
			function Probe({capture}: {capture: (zoomTo: ReturnType<typeof useZoomTo>) => void})
			{
				capture(useZoomTo());
				return null;
			}
			root = createRoot(document.createElement("div"));
			act(() =>
			{
				root?.render(
					createElement(
						QueryClientProvider,
						{
							client: queryClient,
						},
						createElement(
							MemoryRouter,
							null,
							createElement(
								StableNavigateProvider,
								null,
								createElement(
									Probe,
									{
										capture: (zoomTo) =>
										{
											probe.zoomTo = zoomTo;
										},
									},
								),
							),
						),
					),
				);
			});
			let zoomed: Promise<void> | undefined;
			await act(async () =>
			{
				zoomed = probe.zoomTo?.(ALICE, "first_child");
				await vi.waitFor(() =>
				{
					expect(
						queryClient.isFetching(
							{
								queryKey: outlineViewKey(ALICE),
							},
						),
					).toBe(1);
				});
			});
			const beforeBacklinks = useOutlineStore.getState().zoomedNodeId;
			const frames: FrameRequestCallback[] = [];
			vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
			await act(async () =>
			{
				releaseView();
				await vi.waitFor(() =>
				{
					expect(useOutlineStore.getState().zoomedNodeId).toBe(ALICE);
				});
			});
			const editingAtSwap = useOutlineStore.getState().editingId;
			await act(async () =>
			{
				for (const frame of frames.splice(0))
				{
					frame(0);
				}
				await zoomed;
			});
			expect(
				{
					beforeBacklinks,
					backlinks: queryClient.getQueryData(nodeKeys.backlinks(ALICE)),
					editingAtSwap,
					editingAfterPaint: useOutlineStore.getState().editingId,
				},
			).toStrictEqual(
				{
					beforeBacklinks: null,
					backlinks: NO_BACKLINKS,
					editingAtSwap: null,
					editingAfterPaint: BOB,
				},
			);
		});
	});
});

describe("zoom to view load", () =>
{
	const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
	const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
	const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";
	const DAVE = "5e6f7a8b-0b7d-4e5a-8c3f-dddddddddddd";

	function row(id: string, parentId: string | null): NodeResponse
	{
		return {
			id,
			parent_id: parentId,
			name: id,
			note: null,
			priority: 100,
			data:
			{
				layoutMode: null,
			},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
			hasChildren: true,
		};
	}

	const NO_BACKLINKS =
	{
		rootId: null,
		items: [],
	};

	// alice > bob > carol > dave, bob and carol expanded.
	const view: OutlineViewResponse =
	{
		lists: [
			{
				parentId: ALICE,
				nodes: [row(BOB, ALICE)],
				backlinks: NO_BACKLINKS,
			},
			{
				parentId: BOB,
				nodes: [row(CAROL, BOB)],
				backlinks: NO_BACKLINKS,
			},
			{
				parentId: CAROL,
				nodes: [row(DAVE, CAROL)],
				backlinks: NO_BACKLINKS,
			},
		],
	};

	let root: Root | undefined;
	let requests: string[] = [];

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		useOutlineStore.setState(
			{
				expandedIds: new Set([BOB, CAROL]),
			},
		);
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 0));
		vi.stubGlobal(
			"fetch",
			vi.fn<(url: string) => Promise<Response>>(async (url) =>
			{
				requests.push(url);
				return Promise.resolve(Response.json(url.endsWith("/api/v1/nodes/view") ? view : NO_BACKLINKS));
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

	describe("useZoomTo view load", () =>
	{
		it("loads a three-level expanded zoom target in one request before the swap", async () =>
		{
			const queryClient = new QueryClient();
			queryClient.setQueryData(nodeKeys.children(null), [row(ALICE, null)]);
			const probe:
			{
				zoomTo?: ReturnType<typeof useZoomTo>;
			} = {};
			function Probe({capture}: {capture: (zoomTo: ReturnType<typeof useZoomTo>) => void})
			{
				capture(useZoomTo());
				return null;
			}
			root = createRoot(document.createElement("div"));
			act(() =>
			{
				root?.render(
					createElement(
						QueryClientProvider,
						{
							client: queryClient,
						},
						createElement(
							MemoryRouter,
							null,
							createElement(
								StableNavigateProvider,
								null,
								createElement(
									Probe,
									{
										capture: (zoomTo) =>
										{
											probe.zoomTo = zoomTo;
										},
									},
								),
							),
						),
					),
				);
			});

			await act(async () =>
			{
				await probe.zoomTo?.(ALICE, "first_child");
			});

			expect(
				{
					zoomed: useOutlineStore.getState().zoomedNodeId,
					lists: [ALICE, BOB, CAROL].map((id) => queryClient.getQueryData(nodeKeys.children(id))),
					treeRequests: requests.filter(
						(url) =>
							url.includes("/children") || url.endsWith("/backlinks") || url === "/api/v1/nodes/view",
					),
				},
			).toStrictEqual(
				{
					zoomed: ALICE,
					lists: [[row(BOB, ALICE)], [row(CAROL, BOB)], [row(DAVE, CAROL)]],
					treeRequests: ["/api/v1/nodes/view"],
				},
			);
		});
	});
});

describe("zoom view cache", () =>
{
	const ALICE = "4823cefa-5fc0-478c-88ac-35035d443bf1";
	const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-aaaaaaaaaaaa";

	function treeRow(id: string, parentId: string | null): NodeResponse
	{
		return {
			id,
			parent_id: parentId,
			name: id,
			note: null,
			priority: 100,
			data:
			{
				layoutMode: null,
			},
			createdAt: null,
			modifiedAt: null,
			completedAt: null,
			hasChildren: false,
			hasUncompletedChildren: false,
			isMirror: false,
			originalNodeId: null,
		};
	}

	const alice = treeRow(ALICE, null);
	const bob = treeRow(BOB, ALICE);
	const aliceLink =
	{
		...alice,
		hasChildren: true,
		hasUncompletedChildren: true,
	};
	const bobLink =
	{
		...bob,
		hasChildren: true,
		hasUncompletedChildren: true,
	};

	let root: Root | undefined;
	let requests: string[] = [];

	function respond(url: string): unknown
	{
		if (url.endsWith("/backlinks"))
		{
			return {
				rootId: null,
				items: [],
			};
		}
		if (url.endsWith("/ancestors"))
		{
			return {
				ancestors: [aliceLink, bobLink],
			};
		}
		return {
			node: bob,
		};
	}

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
			{
				requests.push(url);
				return Promise.resolve(Response.json(respond(url)));
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

	function cacheWithAliceExpanded(): QueryClient
	{
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						staleTime: 60_000,
					},
				},
			},
		);
		queryClient.setQueryData(nodeKeys.children(null), [alice]);
		queryClient.setQueryData(nodeKeys.children(ALICE), [bob]);
		return queryClient;
	}

	/** The data `hook` returns on its first render, under a provider for `queryClient`. */
	function firstRender<T>(queryClient: QueryClient, hook: () => T): T | undefined
	{
		let first:
			|
			  {
					value: T;
			  }
			| undefined;
		function Probe()
		{
			const value = hook();
			first ??=
			{
				value,
			};
			return null;
		}
		root = createRoot(document.createElement("div"));
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(Probe),
				),
			);
		});
		return first?.value;
	}

	describe("zoom view from the cache", () =>
	{
		it("renders a cached row's detail and ancestor chain on the first render, without a request", () =>
		{
			const queryClient = cacheWithAliceExpanded();
			const data = firstRender(queryClient, () => (
			{
				node: useNode(BOB).data,
				ancestors: useAncestors(BOB).data,
			}));
			expect(
				{
					data,
					requests,
				},
			).toStrictEqual(
				{
					data:
					{
						node: bob,
						ancestors: [aliceLink, bobLink],
					},
					requests: [],
				},
			);
		});

		it("leaves a cached zoom target's detail and chain to the cache, and its backlinks to the view load", async () =>
		{
			const queryClient = cacheWithAliceExpanded();
			await prefetchZoomView(queryClient, BOB);
			expect(requests).toStrictEqual([]);
		});

		it("prefetches the detail and chain of a target the cache does not hold", async () =>
		{
			const queryClient = new QueryClient();
			await prefetchZoomView(queryClient, BOB);
			expect(
				{
					detail: queryClient.getQueryData(nodeKeys.detail(BOB)),
					ancestors: queryClient.getQueryData(nodeKeys.ancestors(BOB)),
					requests: new Set(requests),
				},
			).toStrictEqual(
				{
					detail: bob,
					ancestors: [aliceLink, bobLink],
					requests: new Set([`/api/v1/nodes/${BOB}`, `/api/v1/nodes/${BOB}/ancestors`]),
				},
			);
		});
	});
});
