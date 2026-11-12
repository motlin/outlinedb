// @vitest-environment happy-dom
import {renders} from "./helpers/render-counter.js"; // Before react-dom, which looks for the DevTools hook it installs when it loads.
import {afterEach, beforeEach, describe, expect, it, vi, afterAll, beforeAll} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse, OutlineViewList, OutlineViewResponse} from "../src/node-types.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MemoryRouter} from "react-router-dom";
import {OutlineView} from "../src/client/app.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {initialRowBudget} from "../src/client/render-window.js";
import {OutlineRow} from "../src/client/components/outline-node.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {fetchChildren} from "../src/client/hooks/use-nodes.js";
import {queryClientDefaults} from "../src/client/query-retry.js";
import {loadExpansion} from "../src/client/hooks/use-expansion-sync.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("outline expand subtree", () =>
{
	function row(id: string, parentId: string | null, priority: number, hasChildren: boolean): NodeResponse
	{
		return {
			id,
			parent_id: parentId,
			name: id,
			note: null,
			priority,
			data:
			{
				layoutMode: null,
			},
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren,
			hasUncompletedChildren: hasChildren,
		};
	}

	const NO_BACKLINKS =
	{
		rootId: null,
		items: [],
	};

	// Home holds collapsed alice and zed; alice > {bob > carol > dan, erin > fay} and zed > yan > xia, with bob, carol,
	// erin and yan expanded.
	const children: Record<string, NodeResponse[]> =
	{
		alice: [row("bob", "alice", 0, true), row("erin", "alice", 1, true)],
		bob: [row("carol", "bob", 0, true)],
		carol: [row("dan", "carol", 0, false)],
		erin: [row("fay", "erin", 0, false)],
		zed: [row("yan", "zed", 0, true)],
		yan: [row("xia", "yan", 0, false)],
	};
	const homeList: OutlineViewList =
	{
		parentId: null,
		nodes: [row("alice", null, 0, true), row("zed", null, 1, true)],
		backlinks: null,
	};
	const list = (parentId: string): OutlineViewList => (
	{
		parentId,
		nodes: children[parentId] ?? [],
		backlinks: NO_BACKLINKS,
	});
	// Both answer later than one settle() step, as on a loaded machine, so no test may assert before the views land.
	const views: Record<
		string,
		{
			lists: OutlineViewList[];
			delayMs: number;
		}
	> =
	{
		alice:
		{
			lists: [list("alice"), list("bob"), list("carol"), list("erin")],
			delayMs: 60,
		},
		// Answers later than alice's, so two subtree loads that each committed alone would show as two commits.
		zed:
		{
			lists: [list("zed"), list("yan")],
			delayMs: 70,
		},
	};

	let root: Root | undefined;
	let queryClient: InstanceType<typeof QueryClient> | undefined;
	let requests: string[] = [];
	let viewBodies: unknown[] = [];

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		viewBodies = [];
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		useOutlineStore.setState(
			{
				expandedIds: new Set(["bob", "carol", "erin", "yan"]),
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) =>
			{
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requests.push(url);
				if (url.endsWith("/api/v1/nodes/view"))
				{
					const body = JSON.parse(init?.body as string) as
					{
						rootId: string | null;
					};
					viewBodies.push(body);
					const view = body.rootId === null ? undefined : views[body.rootId];
					await new Promise((resolve) =>
					{
						setTimeout(resolve, view?.delayMs ?? 0);
					});
					return Response.json(
						{
							lists: view?.lists ?? [homeList],
						},
					);
				}
				if (url.endsWith("/api/v1/nodes/children"))
				{
					const {parentIds} = JSON.parse(init?.body as string) as
					{
						parentIds: string[];
					};
					return Response.json(
						{
							children: Object.fromEntries(parentIds.map((id) => [id, children[id] ?? []])),
						},
					);
				}
				if (url.endsWith("/api/v1/expansion"))
				{
					return Response.json({});
				}
				if (url.endsWith("/backlinks"))
				{
					return Response.json(NO_BACKLINKS);
				}
				if (url.endsWith("/api/v1/nodes"))
				{
					return Response.json(
						{
							nodes: homeList.nodes,
						},
					);
				}
				return Response.json(
					{},
					{
						status: 404,
					},
				);
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
		queryClient = undefined;
		vi.unstubAllGlobals();
	});

	function busy(): boolean
	{
		return (queryClient?.isFetching() ?? 0) > 0 || (queryClient?.isMutating() ?? 0) > 0;
	}

	/**
	 * Wait out every in-flight query and mutation plus one more render window after the last lands, so a view reply that
	 * arrives late on a loaded machine still commits before the test asserts.
	 */
	async function settle(): Promise<void>
	{
		let wasBusy: boolean;
		do
		{
			wasBusy = busy();
			await act(async () =>
			{
				await new Promise((resolve) =>
				{
					setTimeout(resolve, 20);
				});
			});
		}
		while (wasBusy || busy());
	}

	function shownRows(container: HTMLElement): string[]
	{
		const ids = [...container.querySelectorAll("[data-node-id]")].map((element) =>
			element.getAttribute("data-node-id"),
		);
		return [...new Set(ids.filter((id) => id !== null))];
	}

	/** Mount the outline on Home and wait for its first view to load. */
	async function mountHome(): Promise<HTMLElement>
	{
		const container = document.createElement("div");
		document.body.append(container);
		const client = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						retry: false,
						staleTime: 60_000,
					},
				},
			},
		);
		queryClient = client;
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client,
					},
					createElement(MemoryRouter, null, createElement(OutlineView)),
				),
			);
		});
		await settle();
		return container;
	}

	/** Run `action`, wait for the loads it starts to settle, and return the rows each commit that changed them showed. */
	async function commitsAfter(container: HTMLElement, action: () => void): Promise<string[][]>
	{
		requests = [];
		viewBodies = [];
		// Each mutation batch is one React commit.
		const commits: string[][] = [shownRows(container)];
		const observer = new MutationObserver(() =>
		{
			const ids = shownRows(container);
			if (JSON.stringify(ids) !== JSON.stringify(commits.at(-1)))
			{
				commits.push(ids);
			}
		});
		observer.observe(
			container,
			{
				childList: true,
				subtree: true,
			},
		);
		act(action);
		await settle();
		observer.disconnect();
		return commits.slice(1);
	}

	function viewBody(rootId: string, expandedIds: string[])
	{
		return {
			rootId,
			expandedIds,
			limit: initialRowBudget(window.innerHeight),
			showCompleted: useOutlineStore.getState().showCompleted,
		};
	}

	describe("expanding a row", () =>
	{
		it("loads the row's expanded subtree in one request and mounts every level in one commit", async () =>
		{
			const container = await mountHome();
			const arrow = container
				.querySelector('[data-node-id="alice"]')
				?.closest(".name")
				?.querySelector('button[aria-expanded="false"]');
			if (!(arrow instanceof HTMLElement))
			{
				throw new TypeError("alice's expand arrow did not render");
			}

			const commits = await commitsAfter(container, () =>
			{
				arrow.click();
			});

			expect(
				{
					commits,
					treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
					viewBodies,
				},
			).toStrictEqual(
				{
					commits: [["alice", "bob", "carol", "dan", "erin", "fay", "zed"]],
					treeRequests: [],
					viewBodies: [viewBody("alice", ["bob", "carol", "erin", "yan", "alice"])],
				},
			);
		});

		it("mounts sibling rows expanded together in one commit, one subtree request each", async () =>
		{
			const container = await mountHome();

			const commits = await commitsAfter(container, () =>
			{
				useOutlineStore.getState().replaceExpanded(new Set(["bob", "carol", "erin", "yan", "alice", "zed"]));
			});

			const expanded = ["bob", "carol", "erin", "yan", "alice", "zed"];
			expect(
				{
					commits,
					treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
					viewBodies,
				},
			).toStrictEqual(
				{
					commits: [["alice", "bob", "carol", "dan", "erin", "fay", "zed", "yan", "xia"]],
					treeRequests: [],
					viewBodies: [viewBody("alice", expanded), viewBody("zed", expanded)],
				},
			);
		});
	});
});

describe("outline row renders", () =>
{
	function restingRow(hasChildren: boolean): NodeResponse
	{
		return {
			id: "alice",
			parent_id: null,
			name: "Alice",
			note: null,
			priority: 0,
			data:
			{
				layoutMode: null,
			},
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren,
			hasUncompletedChildren: hasChildren,
		};
	}

	let root: Root | undefined;

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () =>
				Promise.resolve(
					Response.json(
						{},
						{
							status: 404,
						},
					),
				),
			),
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

	/** The test's providers, which mount alongside the row. */
	const PROVIDERS =
	{
		QueryClientProvider: 1,
		MemoryRouter: 1,
		Router: 1,
	};

	/** Components rendered, by name, mounting one row. */
	function mountRenders(node: NodeResponse): Record<string, number>
	{
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						retry: false,
					},
				},
			},
		);
		root = createRoot(document.createElement("div"));
		renders.clear();
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
							OutlineRow,
							{
								node,
							},
						),
					),
				),
			);
		});
		return Object.fromEntries(renders);
	}

	describe("resting OutlineRow components", () =>
	{
		it("mounts a resting leaf row as three components: the row, its name, and its resting text", () =>
		{
			expect(mountRenders(restingRow(false))).toStrictEqual(
				{
					...PROVIDERS,
					OutlineRow: 1,
					NodeName: 1,
					RestingText: 1,
				},
			);
		});

		it("mounts a resting collapsed parent row as the same three components", () =>
		{
			expect(mountRenders(restingRow(true))).toStrictEqual(
				{
					...PROVIDERS,
					OutlineRow: 1,
					NodeName: 1,
					RestingText: 1,
				},
			);
		});
	});

	describe("code block rows", () =>
	{
		function nameHtml(node: NodeResponse): string
		{
			const host = document.createElement("div");
			root = createRoot(host);
			const queryClient = new QueryClient(
				{
					defaultOptions:
					{
						queries:
						{
							retry: false,
						},
					},
				},
			);
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
								OutlineRow,
								{
									node,
								},
							),
						),
					),
				);
			});
			return host.querySelector(".name .content")?.innerHTML ?? "";
		}

		it("renders no tag pill or link in a code block, but still renders them in a bullet", () =>
		{
			const name = "x #tag https://example.com";
			const code = nameHtml(
				{
					...restingRow(false),
					name,
					data:
					{
						layoutMode: "code-block",
					},
				},
			);
			act(() =>
			{
				root?.unmount();
			});
			const bullet = nameHtml(
				{
					...restingRow(false),
					name,
				},
			);
			expect(
				{
					code: [code.includes("contentTag"), code.includes("contentLink")],
					bullet: [bullet.includes("contentTag"), bullet.includes("contentLink")],
				},
			).toStrictEqual(
				{
					code: [false, false],
					bullet: [true, true],
				},
			);
		});
	});

	describe("calendar day OutlineRow", () =>
	{
		const PREFIX_CLASS =
			"flex h-[var(--line-height)] whitespace-nowrap items-center pr-m pt-[--wf-content-padding-top] pb-[--wf-content-padding-bottom]";

		beforeEach(() =>
		{
			vi.useFakeTimers(
				{
					toFake: ["Date"],
				},
			);
			vi.setSystemTime(new Date(2026, 9, 22, 10, 0));
		});
		afterEach(() =>
		{
			vi.useRealTimers();
		});

		function dayRow(dateId: number): NodeResponse
		{
			return {
				...restingRow(false),
				id: `d${dateId}`,
				parent_id: "m10",
				name: "day",
				calendar:
				{
					level: "day",
					dateId,
					root: false,
					foundDates: null,
					dayPrefix: null,
					restorableUniqueNode: false,
				},
			};
		}

		/** Mount `node` under a cached 📆 Calendar > 2026 > 10 chain whose root sets `dayPrefix`; its prefix span, components and ancestor requests. */
		function mountDay(
			node: NodeResponse,
			dayPrefix: boolean,
		):
		{
			html: string;
			components: Record<string, number>;
			ancestorRequests: string[];
		}
		{
			const queryClient = new QueryClient(
				{
					defaultOptions:
					{
						queries:
						{
							retry: false,
							staleTime: 60_000,
						},
					},
				},
			);
			const chainNode = (id: string, parent: string | null, calendar: NodeResponse["calendar"]): NodeResponse => (
			{
				...restingRow(true),
				id,
				parent_id: parent,
				calendar,
			});
			queryClient.setQueryData(nodeKeys.ancestors("m10"), [
				chainNode(
					"cal",
					null,
					{
						level: null,
						dateId: null,
						root: true,
						foundDates: true,
						dayPrefix,
						restorableUniqueNode: false,
					},
				),
				chainNode(
					"y2026",
					"cal",
					{
						level: "year",
						dateId: 20_260_000,
						root: false,
						foundDates: null,
						dayPrefix: null,
						restorableUniqueNode: false,
					},
				),
				chainNode(
					"m10",
					"y2026",
					{
						level: "month",
						dateId: 20_261_000,
						root: false,
						foundDates: null,
						dayPrefix: null,
						restorableUniqueNode: false,
					},
				),
			]);
			queryClient.setQueryData(nodeKeys.children("m10"), [node]);
			act(() =>
			{
				root?.unmount();
			});
			const container = document.createElement("div");
			root = createRoot(container);
			renders.clear();
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
								OutlineRow,
								{
									node,
								},
							),
						),
					),
				);
			});
			const span = container.querySelector(`span[class="${PREFIX_CLASS}"]`);
			return {
				html: span?.outerHTML ?? "",
				components: Object.fromEntries(renders),
				ancestorRequests: vi
					.mocked(fetch)
					.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString()))
					.filter((url) => url.includes("ancestors")),
			};
		}

		it("renders upstream's friendly day name before yesterday's, today's and tomorrow's date, mounting one prefix component and building its ancestors from the cache", () =>
		{
			expect([
				mountDay(dayRow(20_261_021), true),
				mountDay(dayRow(20_261_022), true),
				mountDay(dayRow(20_261_023), true),
			]).toStrictEqual(
				["Yesterday,", "Today,", "Tomorrow,"].map((prefix) => (
				{
					html: `<span class="${PREFIX_CLASS}">${prefix}</span>`,
					components:
					{
						...PROVIDERS,
						OutlineRow: 1,
						NodeName: 1,
						RestingText: 1,
						DayTitlePrefix: 1,
					},
					ancestorRequests: [],
				})),
			);
		});

		it("renders no prefix on other days or when the root turns Friendly day names off", () =>
		{
			expect([mountDay(dayRow(20_261_020), true).html, mountDay(dayRow(20_261_021), false).html]).toStrictEqual([
				"",
				"",
			]);
		});
	});
});

describe("outline store caret range", () =>
{
	const caretState = ():
	{
		offset: number | null;
		end: number | null;
		reversed: boolean;
	} =>
	{
		const {editingCaretOffset, editingCaretEnd, editingCaretReversed} = useOutlineStore.getState();
		return {
			offset: editingCaretOffset,
			end: editingCaretEnd,
			reversed: editingCaretReversed,
		};
	};

	beforeEach(() =>
	{
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	});

	describe("editing caret range", () =>
	{
		it("holdEditing keeps a selection range and its direction", () =>
		{
			useOutlineStore.getState().holdEditing(1, 3, true);

			expect(caretState()).toStrictEqual(
				{
					offset: 1,
					end: 3,
					reversed: true,
				},
			);
		});

		it("holdEditing with a bare offset holds a collapsed caret", () =>
		{
			useOutlineStore.getState().holdEditing(0, 2);
			useOutlineStore.getState().holdEditing(5);

			expect(caretState()).toStrictEqual(
				{
					offset: 5,
					end: null,
					reversed: false,
				},
			);
		});

		it("resumeEditing restores a range", () =>
		{
			useOutlineStore.getState().resumeEditing(
				"a",
				3,
				{
					end: 7,
				},
			);

			expect(caretState()).toStrictEqual(
				{
					offset: 3,
					end: 7,
					reversed: false,
				},
			);
		});

		it("moving the caret elsewhere drops the range", () =>
		{
			useOutlineStore.getState().resumeEditing(
				"a",
				3,
				{
					end: 7,
				},
			);
			useOutlineStore.getState().focusName("a", "end");

			expect(caretState().end).toBeNull();
		});
	});
});

describe("outline tab renders", () =>
{
	const ROWS = 300;

	function row(index: number): NodeResponse
	{
		return {
			id: `n${index}`,
			parent_id: null,
			name: `Row ${index}`,
			note: null,
			priority: index,
			data:
			{
				layoutMode: null,
			},
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren: false,
		};
	}

	const rows = Array.from(
		{
			length: ROWS,
		},
		(_, index) => row(index),
	);
	// The app's query defaults (60 s staleness, rows shared by id), without retries.
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				...queryClientDefaults,
				queries:
				{
					...queryClientDefaults.queries,
					retry: false,
				},
			},
		},
	);
	const requests: string[] = [];
	let root: Root | undefined;

	/** A `.children` slide still running: it holds its inline `will-change` until the slide ends. */
	function sliding(): boolean
	{
		return [...document.querySelectorAll<HTMLElement>(".children")].some((el) => el.style.willChange !== "");
	}

	/**
	 * Wait out pending renders, every in-flight query and every running slide, so neither a late response nor a slide
	 * ending (a 220 ms fallback timer, which a loaded CI runner stretches) lands outside the measured window.
	 */
	async function settle(): Promise<void>
	{
		do
		{
			await act(async () =>
			{
				await new Promise((resolve) =>
				{
					setTimeout(resolve, 50);
				});
			});
		}
		while (queryClient.isFetching() > 0 || queryClient.isMutating() > 0 || sliding());
	}

	beforeAll(async () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) =>
			{
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requests.push(`${init?.method ?? "GET"} ${url}`);
				// The server agrees with the optimistic splice: it answers the lists the cache already shows.
				const cached = (parentId: string | null) =>
					queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(parentId)) ?? [];
				if (url.includes("/move"))
				{
					return Response.json(
						{
							nodes: cached("n9"),
						},
					);
				}
				if (url.endsWith("/api/v1/preferences"))
				{
					// Preferences unavailable: a settled answer, unlike a 404 that every new observer would refetch.
					return Response.json(
						{
							error: null,
						},
						{
							status: 503,
						},
					);
				}
				if (url.includes("/backlinks"))
				{
					return Response.json(
						{
							rootId: null,
							items: [],
						},
					);
				}
				if (url.includes("/expansion"))
				{
					return Response.json({});
				}
				if (url.endsWith("/api/v1/nodes"))
				{
					return Response.json(
						{
							nodes: rows,
						},
					);
				}
				if (url.includes("/changes"))
				{
					const since = url.includes("since=");
					return Response.json(
						{
							latest: since ? "2" : "1",
							reset: false,
							changedIds: since ? ["n10"] : [],
							deletedIds: [],
							children: since
								? [
										{
											parentId: null,
											nodes: cached(null),
										},
										{
											parentId: "n9",
											nodes: cached("n9"),
										},
									]
								: [],
						},
					);
				}
				return Promise.resolve(
					url.includes("/children")
						? Response.json(rows)
						: Response.json(
								{},
								{
									status: 404,
								},
							),
				);
			}),
		);
		// A loaded outline has taken the change feed's mark, so a write reads only what changed since.
		await fetchChildren(null);
		queryClient.setQueryData(nodeKeys.children(null), rows);
		queryClient.setQueryData(nodeKeys.children("n9"), []);
		for (const node of rows)
		{
			queryClient.setQueryData(nodeKeys.detail(node.id), node);
		}
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(MemoryRouter, null, createElement(OutlineView)),
				),
			);
		});
		await settle();
		act(() =>
		{
			useOutlineStore.setState(
				{
					editingId: "n10",
				},
			);
		});
		await settle();
	});

	afterAll(() =>
	{
		act(() =>
		{
			root?.unmount();
		});
		vi.unstubAllGlobals();
	});

	describe("Tab render and request count on a large outline", () =>
	{
		it("expands the previous sibling in the same commit as the splice, re-rendering only the two rows involved", async () =>
		{
			const editor = document.querySelector<HTMLElement>('.innerContentContainer.editing[data-node-id="n10"]');
			renders.clear();
			requests.length = 0;
			act(() =>
			{
				editor?.dispatchEvent(
					new KeyboardEvent(
						"keydown",
						{
							key: "Tab",
							code: "Tab",
							// oxlint-disable-next-line typescript/no-deprecated -- the keymap reads `which`, which happy-dom fills from `keyCode`.
							keyCode: 9,
							bubbles: true,
							cancelable: true,
						},
					),
				);
			});
			await settle();
			expect(
				{
					editing: editor !== null,
					newParentChildren: queryClient
						.getQueryData<NodeResponse[]>(nodeKeys.children("n9"))
						?.map((node) => node.id),
					// The previous sibling once as it opens with the row spliced in and the row once as it mounts under it,
					// then the previous sibling once as its `.children` element mounts and starts the slide-down and once
					// more when the slide ends; no other row of the 300.
					outlineRows: renders.get("OutlineRow") ?? 0,
					nodeRequests: requests.filter((request) => request.includes("/api/v1/nodes")),
				},
			).toStrictEqual(
				{
					editing: true,
					newParentChildren: ["n10"],
					outlineRows: 4,
					nodeRequests: [
						"GET /api/v1/nodes/n9/backlinks",
						"POST /api/v1/nodes/n10/move",
						"GET /api/v1/nodes/changes?since=1",
					],
				},
			);
		});
	});
});

describe("outline view load renders", () =>
{
	function row(id: string, parentId: string | null, hasChildren: boolean): NodeResponse
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
			completedAt: null,
			createdAt: 0,
			modifiedAt: 0,
			hasChildren,
			hasUncompletedChildren: hasChildren,
		};
	}

	const NO_BACKLINKS =
	{
		rootId: null,
		items: [],
	};

	// Home holds alice > bob > carol, alice and bob expanded.
	const view: OutlineViewResponse =
	{
		lists: [
			{
				parentId: null,
				nodes: [row("alice", null, true)],
				backlinks: null,
			},
			{
				parentId: "alice",
				nodes: [row("bob", "alice", true)],
				backlinks: NO_BACKLINKS,
			},
			{
				parentId: "bob",
				nodes: [row("carol", "bob", false)],
				backlinks: NO_BACKLINKS,
			},
		],
	};

	let root: Root | undefined;
	let requests: string[] = [];
	let viewBodies: unknown[] = [];
	let expansionResponse: Promise<Response> = Promise.resolve(
		Response.json(
			{},
			{
				status: 404,
			},
		),
	);
	let viewResponse: OutlineViewResponse = view;

	beforeEach(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		viewBodies = [];
		viewResponse = view;
		useOutlineStore.setState(useOutlineStore.getInitialState(), true);
		useOutlineStore.setState(
			{
				expandedIds: new Set(["alice", "bob"]),
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) =>
			{
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				requests.push(url);
				if (url.endsWith("/api/v1/expansion"))
				{
					return expansionResponse;
				}
				if (url.endsWith("/api/v1/nodes/view"))
				{
					viewBodies.push(JSON.parse(init?.body as string));
					return Response.json(viewResponse);
				}
				if (url.endsWith("/api/v1/nodes"))
				{
					// Home's own children query races the view; a real server answers it, a 404 settles on its own timing.
					return Response.json(
						{
							nodes: view.lists[0]?.nodes ?? [],
						},
					);
				}
				return Response.json(
					{},
					{
						status: 404,
					},
				);
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

	/** Render the outline and record the rows each commit shows, until the loads settle. */
	async function renderCommits(): Promise<string[][]>
	{
		const container = document.createElement("div");
		document.body.append(container);
		// Each mutation batch is one React commit: the rows shown after each.
		const commits: string[][] = [];
		const observer = new MutationObserver(() =>
		{
			const ids = [...container.querySelectorAll("[data-node-id]")].map((element) =>
				element.getAttribute("data-node-id"),
			);
			commits.push([...new Set(ids.filter((id) => id !== null))]);
		});
		observer.observe(
			container,
			{
				childList: true,
				subtree: true,
			},
		);
		// The app's staleTime, so seeded lists do not refetch on mount.
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						retry: false,
						staleTime: 60_000,
					},
				},
			},
		);
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(MemoryRouter, null, createElement(OutlineView)),
				),
			);
		});
		await act(async () =>
		{
			await new Promise((resolve) =>
			{
				setTimeout(resolve, 50);
			});
		});
		observer.disconnect();
		return commits;
	}

	describe("outline view load", () =>
	{
		it("loads a three-level expanded view in one request and mounts every level in the same commit", async () =>
		{
			const commits = await renderCommits();

			expect(
				{
					firstWithRows: commits.find((ids) => ids.length > 0),
					treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
					viewRequests: requests.filter((url) => url.endsWith("/api/v1/nodes/view")).length,
				},
			).toStrictEqual(
				{
					firstWithRows: ["alice", "bob", "carol"],
					treeRequests: [],
					viewRequests: 1,
				},
			);
		});

		it("loads the first view with the account's expansion without waiting on the expansion GET", async () =>
		{
			useOutlineStore.setState(
				{
					expandedIds: new Set(),
				},
			);
			let viewBodiesWhenExpansionSettled: unknown[] | undefined;
			expansionResponse = new Promise((resolve) =>
			{
				setTimeout(() =>
				{
					viewBodiesWhenExpansionSettled = [...viewBodies];
					resolve(
						Response.json(
							{
								expandedIds: ["alice", "bob", "elsewhere"],
							},
						),
					);
				}, 30);
			});
			viewResponse =
			{
				...view,
				expandedIds: ["alice", "bob"],
			};
			const expansion = loadExpansion();
			const commits = await renderCommits();
			await expansion;

			expect(
				{
					firstWithRows: commits.find((ids) => ids.length > 0),
					treeRequests: requests.filter((url) => url.includes("/children") || url.endsWith("/backlinks")),
					viewBodiesWhenExpansionSettled,
					expandedIds: useOutlineStore.getState().expandedIds,
				},
			).toStrictEqual(
				{
					firstWithRows: ["alice", "bob", "carol"],
					treeRequests: [],
					viewBodiesWhenExpansionSettled: [
						{
							rootId: null,
							expandedIds: null,
							limit: initialRowBudget(window.innerHeight),
							showCompleted: useOutlineStore.getState().showCompleted,
						},
					],
					expandedIds: new Set(["alice", "bob", "elsewhere"]),
				},
			);
		});
	});
});

describe("outline view renders", () =>
{
	const alice: NodeResponse =
	{
		id: "alice",
		parent_id: null,
		name: "Alice",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren: false,
	};

	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					retry: false,
					staleTime: Number.POSITIVE_INFINITY,
				},
			},
		},
	);
	let root: Root | undefined;
	const slowResponseMs = 300;

	/** Wait out pending renders and every in-flight query, so a late response never lands in the next measured window. */
	async function settle(): Promise<void>
	{
		do
		{
			await act(async () =>
			{
				await new Promise((resolve) =>
				{
					setTimeout(resolve, 20);
				});
			});
		}
		while (queryClient.isFetching() > 0);
	}

	beforeAll(async () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input) =>
			{
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				// Only the root's children answer; every other endpoint is missing, so its query errors and stays empty.
				// The misses answer later than one settle(), as on a loaded CI runner, so no test may measure before they land.
				if (url.includes("/children"))
				{
					return Response.json([alice]);
				}
				await new Promise((resolve) =>
				{
					setTimeout(resolve, slowResponseMs);
				});
				return Response.json(
					{},
					{
						status: 404,
					},
				);
			}),
		);
		queryClient.setQueryData(nodeKeys.children(null), [alice]);
		queryClient.setQueryData(nodeKeys.detail("alice"), alice);
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(MemoryRouter, null, createElement(OutlineView)),
				),
			);
		});
		await settle();
	});

	afterAll(() =>
	{
		act(() =>
		{
			root?.unmount();
		});
		vi.unstubAllGlobals();
	});

	describe("OutlineView render count", () =>
	{
		it("does not re-render the page shell when editing moves to a row", async () =>
		{
			renders.clear();
			act(() =>
			{
				useOutlineStore.setState(
					{
						editingId: "alice",
					},
				);
			});
			await settle();
			expect(renders.get("OutlineView") ?? 0).toBe(0);
		});

		it("renders the outline rows it is given", () =>
		{
			expect(document.querySelectorAll('[data-node-id="alice"]').length).toBeGreaterThan(0);
		});

		it("re-renders only the new row when a sibling joins an unchanged list", async () =>
		{
			const bob: NodeResponse =
			{
				...alice,
				id: "bob",
				name: "Bob",
				priority: 1,
			};
			renders.clear();
			act(() =>
			{
				queryClient.setQueryData(nodeKeys.children(null), [
					queryClient.getQueryData<NodeResponse[]>(nodeKeys.children(null))?.[0] ?? alice,
					bob,
				]);
			});
			await settle();
			expect(renders.get("OutlineRow") ?? 0).toBe(1);
		});

		it("does not re-render the page shell when the edited row's text is saved", async () =>
		{
			renders.clear();
			act(() =>
			{
				queryClient.setQueryData(
					nodeKeys.detail("alice"),
					{
						...alice,
						name: "Alice!",
					},
				);
			});
			await settle();
			expect(renders.get("OutlineView") ?? 0).toBe(0);
		});

		it("re-renders no component when a keystroke types into the edited row", async () =>
		{
			const editor = document.querySelector<HTMLElement>('.innerContentContainer.editing[data-node-id="alice"]');
			const fetchingWhenMeasured = queryClient.isFetching();
			renders.clear();
			act(() =>
			{
				editor?.append("x");
				editor?.dispatchEvent(
					new InputEvent(
						"input",
						{
							bubbles: true,
							data: "x",
							inputType: "insertText",
						},
					),
				);
			});
			await settle();
			expect(
				{
					fetchingWhenMeasured,
					editing: editor !== null,
					renders: Object.fromEntries(renders),
				},
			).toStrictEqual(
				{
					fetchingWhenMeasured: 0,
					editing: true,
					renders: {},
				},
			);
		});
	});
});
