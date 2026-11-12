import {describe, expect, it, beforeEach, vi} from "vite-plus/test";
import {paneClickModifier} from "../src/client/pane-click-routing.js";
import {processCombo} from "../src/client/keys/dispatch.js";
import {openInPane, paneCommands, paneNavCommands, paneNumberCommands} from "../src/client/pane-commands.js";
import type {OpenInPaneState, PaneCommandStore, PaneNavDeps, PaneNumberDeps} from "../src/client/pane-commands.js";
import {REORDER_THRESHOLD, autoScrollSpeed, reorderDrop} from "../src/client/pane-reorder.js";
import
{
	resolveWidths,
	DEFAULT_PANE_WIDTH,
	MIN_PANE_WIDTH,
	PANE_GUTTER,
	availablePaneWidth,
	beginDividerResize,
	cancelledDivider,
	minimumPaneWidth,
	paneWidth,
	resizedDivider,
} from "../src/client/pane-widths.js";
import
{
	applyPaneStorageUpdate,
	createPaneId,
	decodePanes,
	decodeWorkspace,
	encodePanes,
	encodeWorkspace,
	paneStorageUpdate,
	reconcilePaneUrl,
	restoredPaneWidth,
	restoredRuntime,
	sameWorkspace,
	storeWorkspaceUrl,
	withPanesFragment,
} from "../src/client/pane-url.js";
import type {PaneUrlAction, WorkspaceUrl} from "../src/client/pane-url.js";

describe("pane click routing", () =>
{
	const none =
	{
		button: 0,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	};

	describe("paneClickModifier", () =>
	{
		it("classifies the whole modifier table", () =>
		{
			expect(
				{
					alt: paneClickModifier(
						{
							...none,
							altKey: true,
						},
						true,
					),
					metaMac: paneClickModifier(
						{
							...none,
							metaKey: true,
						},
						true,
					),
					ctrlOther: paneClickModifier(
						{
							...none,
							ctrlKey: true,
						},
						false,
					),
					altOther: paneClickModifier(
						{
							...none,
							altKey: true,
						},
						false,
					),
					ctrlMac: paneClickModifier(
						{
							...none,
							ctrlKey: true,
						},
						true,
					),
					metaOther: paneClickModifier(
						{
							...none,
							metaKey: true,
						},
						false,
					),
					altShift: paneClickModifier(
						{
							...none,
							altKey: true,
							shiftKey: true,
						},
						true,
					),
					metaShift: paneClickModifier(
						{
							...none,
							metaKey: true,
							shiftKey: true,
						},
						true,
					),
					altMeta: paneClickModifier(
						{
							...none,
							altKey: true,
							metaKey: true,
						},
						true,
					),
					middle: paneClickModifier(
						{
							...none,
							button: 1,
							altKey: true,
						},
						true,
					),
					plain: paneClickModifier(none, true),
					middlePlain: paneClickModifier(
						{
							...none,
							button: 1,
						},
						true,
					),
					shiftOnly: paneClickModifier(
						{
							...none,
							shiftKey: true,
						},
						true,
					),
				},
			).toStrictEqual(
				{
					alt: "open",
					metaMac: "open",
					ctrlOther: "open",
					altOther: "open",
					ctrlMac: "other",
					metaOther: "other",
					altShift: "other",
					metaShift: "other",
					altMeta: "other",
					middle: "other",
					plain: "plain",
					middlePlain: "other",
					shiftOnly: "other",
				},
			);
		});
	});
});

describe("pane commands", () =>
{
	const A = "AAAAAAAAAAA";
	const B = "BBBBBBBBBBB";

	function fakeStore(
		panes:
		{
			id: string;
			zoomedId: string | null;
		}[],
		activePaneId = "main",
	)
	{
		const calls: string[] = [];
		const store: PaneCommandStore =
		{
			getState: () => (
			{
				panes,
				activePaneId,
				zoomedNodeId: "main-zoom",
				openPane: (zoomedId, options) =>
				{
					calls.push(`open:${zoomedId ?? "home"}:${options?.sourcePaneId ?? "?"}:${options?.index ?? "end"}`);
					return "NEW";
				},
				closePane: (paneId) =>
				{
					calls.push(`close:${paneId}`);
				},
				closeAllPanes: () =>
				{
					calls.push("close-all");
				},
			}),
			closeMainPane: () =>
			{
				calls.push("close-main");
			},
			movePane: (paneId, index) =>
			{
				calls.push(`move:${paneId}:${index}`);
			},
		};
		return {
			calls,
			store,
		};
	}

	const ctx =
	{
		items: [],
		zoomedId: "main-zoom",
	};

	describe("toggle_panes", () =>
	{
		it("closes every pane while any pane is open", () =>
		{
			const {calls, store} = fakeStore(
				[
					{
						id: A,
						zoomedId: "alice",
					},
				],
				A,
			);
			paneCommands(store).toggle_panes.execute(ctx);
			expect(calls).toStrictEqual(["close-all"]);
		});

		it("opens the focused item in a pane when none is open, else the zoomed one", () =>
		{
			const {calls, store} = fakeStore([]);
			const commands = paneCommands(store);
			commands.toggle_panes.execute(
				{
					items: ["focused"],
					zoomedId: "main-zoom",
				},
			);
			commands.toggle_panes.execute(ctx);
			expect(calls).toStrictEqual(["open:focused:main:end", "open:main-zoom:main:end"]);
		});
	});

	describe("pane commands", () =>
	{
		it("⌃R opens a pane on the main outline's zoom, after the last pane, when the main pane is active", () =>
		{
			const {calls, store} = fakeStore([]);
			const result = processCombo("ctrl+r", paneCommands(store), ctx, true);
			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result: "claimed",
					calls: ["open:main-zoom:main:end"],
				},
			);
		});

		it("⌃R opens another pane on the active pane's zoom while panes are open, like upstream's new_pane", () =>
		{
			const {calls, store} = fakeStore(
				[
					{
						id: A,
						zoomedId: "alice",
					},
					{
						id: B,
						zoomedId: null,
					},
				],
				A,
			);
			processCombo("ctrl+r", paneCommands(store), ctx, true);
			expect(calls).toStrictEqual([`open:alice:${A}:end`]);
		});

		it("⌃R opens a pane at Home from a pane at Home", () =>
		{
			const {calls, store} = fakeStore(
				[
					{
						id: B,
						zoomedId: null,
					},
				],
				B,
			);
			processCombo("ctrl+r", paneCommands(store), ctx, true);
			expect(calls).toStrictEqual([`open:home:${B}:end`]);
		});

		it("⌃⌘W closes the active pane", () =>
		{
			const {calls, store} = fakeStore(
				[
					{
						id: A,
						zoomedId: "alice",
					},
					{
						id: B,
						zoomedId: "bob",
					},
				],
				A,
			);
			const result = processCombo("ctrl+meta+w", paneCommands(store), ctx, true);
			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result: "claimed",
					calls: [`close:${A}`],
				},
			);
		});

		it("⌃⌘W closes the main pane while it is active, so the first pane becomes the main outline", () =>
		{
			const {calls, store} = fakeStore([
				{
					id: A,
					zoomedId: "alice",
				},
			]);
			processCombo("ctrl+meta+w", paneCommands(store), ctx, true);
			expect(calls).toStrictEqual(["close-main"]);
		});

		it("⌃⌘W with no pane open changes nothing and still claims the combo", () =>
		{
			const {calls, store} = fakeStore([]);
			const result = processCombo("ctrl+meta+w", paneCommands(store), ctx, true);
			expect(
				{
					result,
					calls,
				},
			).toStrictEqual(
				{
					result: "claimed",
					calls: [],
				},
			);
		});
	});

	describe("move pane commands", () =>
	{
		const ctx2 =
		{
			items: [],
			zoomedId: null,
		};
		function run(
			panes:
			{
				id: string;
				zoomedId: string | null;
			}[],
			activePaneId: string,
		)
		{
			const {calls, store} = fakeStore(panes, activePaneId);
			const commands = paneCommands(store);
			const available =
			{
				left: commands.move_pane_left.available?.(ctx2),
				right: commands.move_pane_right.available?.(ctx2),
			};
			commands.move_pane_left.execute(ctx2);
			commands.move_pane_right.execute(ctx2);
			return {
				available,
				calls,
			};
		}

		it("moves the active pane one place left or right, the main pane included", () =>
		{
			expect(
				run(
					[
						{
							id: A,
							zoomedId: "alice",
						},
					],
					A,
				),
			).toStrictEqual(
				{
					available:
					{
						left: true,
						right: false,
					},
					calls: [`move:${A}:0`],
				},
			);
			expect(
				run(
					[
						{
							id: A,
							zoomedId: "alice",
						},
					],
					"main",
				),
			).toStrictEqual(
				{
					available:
					{
						left: false,
						right: true,
					},
					calls: ["move:main:1"],
				},
			);
			expect(
				run(
					[
						{
							id: A,
							zoomedId: "alice",
						},
						{
							id: B,
							zoomedId: "bob",
						},
					],
					A,
				),
			).toStrictEqual(
				{
					available:
					{
						left: true,
						right: true,
					},
					calls: [`move:${A}:0`, `move:${A}:2`],
				},
			);
		});

		it("is unavailable with no pane open", () =>
		{
			expect(run([], "main")).toStrictEqual(
				{
					available:
					{
						left: false,
						right: false,
					},
					calls: [],
				},
			);
		});
	});

	function fakeOpenInPaneState(
		panes:
		{
			id: string;
		}[],
		activePaneId = "main",
	)
	{
		const calls: string[] = [];
		const state: OpenInPaneState =
		{
			panes,
			activePaneId,
			openPane: (zoomedId, options) =>
			{
				calls.push(
					`open:${zoomedId ?? "home"}:${options?.sourcePaneId ?? "?"}:${options?.index ?? "end"}${options?.query === undefined ? "" : `:${options.query}`}`,
				);
				return "NEW";
			},
		};
		return {
			calls,
			state,
		};
	}

	describe("openInPane", () =>
	{
		it("opens a pane right after the main pane when it is the source", () =>
		{
			const {calls, state} = fakeOpenInPaneState([
				{
					id: A,
				},
				{
					id: B,
				},
			]);
			openInPane(state, "alice");
			expect(calls).toStrictEqual(["open:alice:main:1"]);
		});

		it("opens a new pane right after the active pane, even with panes open, like upstream", () =>
		{
			const {calls, state} = fakeOpenInPaneState(
				[
					{
						id: A,
					},
					{
						id: B,
					},
				],
				A,
			);
			openInPane(state, "alice");
			expect(calls).toStrictEqual([`open:alice:${A}:2`]);
		});

		it("opens next to the given source pane (the pane a ⌘-clicked link sits in)", () =>
		{
			const {calls, state} = fakeOpenInPaneState(
				[
					{
						id: A,
					},
					{
						id: B,
					},
				],
				A,
			);
			openInPane(state, "alice", B);
			expect(calls).toStrictEqual([`open:alice:${B}:3`]);
		});

		it("carries a starred search's query into the new pane", () =>
		{
			const {calls, state} = fakeOpenInPaneState(
				[
					{
						id: A,
					},
				],
				A,
			);
			openInPane(state, "alice", undefined, "foo ");
			expect(calls).toStrictEqual([`open:alice:${A}:2:foo `]);
		});

		it("opens after the main pane for a source pane that is no longer open", () =>
		{
			const {calls, state} = fakeOpenInPaneState(
				[
					{
						id: A,
					},
				],
				"CCCCCCCCCCC",
			);
			openInPane(state, "alice");
			expect(calls).toStrictEqual(["open:alice:main:1"]);
		});
	});

	function fakeNav(
		activePaneId: string,
		panes:
		{
			id: string;
			zoomedId: string | null;
		}[] = [
			{
				id: B,
				zoomedId: "bob",
			},
		],
	)
	{
		const calls: string[] = [];
		const deps: PaneNavDeps =
		{
			getState: () => (
			{
				activePaneId,
				panes,
				zoomPane: (paneId, id) =>
				{
					calls.push(`pane:${paneId}:${id ?? "home"}`);
				},
				paneBack: (paneId) =>
				{
					calls.push(`pane-back:${paneId}`);
				},
				paneForward: (paneId) =>
				{
					calls.push(`pane-forward:${paneId}`);
				},
			}),
			commitEdit: () =>
			{
				calls.push("commit");
			},
			goHome: () =>
			{
				calls.push("main-home");
			},
			stepMain: (direction) =>
			{
				calls.push(`main-${direction}`);
			},
			navigateToToday: async (paneId) =>
			{
				calls.push(paneId === null ? "main-today" : `pane-today:${paneId}`);
				return Promise.resolve();
			},
			jumpToSibling: async (step, paneId) =>
			{
				calls.push(`${paneId ?? "main"}-sibling:${step}`);
				return Promise.resolve();
			},
		};
		return {
			calls,
			registry: paneNavCommands(deps),
		};
	}

	describe("pane navigation commands", () =>
	{
		it("⌘' zooms the active pane home instead of navigating the main outline", () =>
		{
			const {calls, registry} = fakeNav(B);
			expect(
				{
					result: processCombo("meta+'", registry, ctx, true),
					calls,
				},
			).toStrictEqual(
				{
					result: "claimed",
					calls: ["commit", `pane:${B}:home`],
				},
			);
		});

		it("⌘' navigates the main outline home while the main pane is active", () =>
		{
			const {calls, registry} = fakeNav("main");
			expect(
				{
					result: processCombo("meta+'", registry, ctx, true),
					calls,
				},
			).toStrictEqual(
				{
					result: "claimed",
					calls: ["commit", "main-home"],
				},
			);
		});

		it("⌘' navigates the main outline when the active pane id is stale and no pane is open", () =>
		{
			const {calls, registry} = fakeNav(B, []);
			processCombo("meta+'", registry, ctx, true);
			expect(calls).toStrictEqual(["commit", "main-home"]);
		});

		it("⌃T opens today in the active pane", () =>
		{
			const {calls, registry} = fakeNav(B);
			processCombo("ctrl+t", registry, ctx, true);
			expect(calls).toStrictEqual([`pane-today:${B}`]);
		});

		it("⌃T opens today in the main outline while the main pane is active", () =>
		{
			const {calls, registry} = fakeNav("main");
			processCombo("ctrl+t", registry, ctx, true);
			expect(calls).toStrictEqual(["main-today"]);
		});

		it("⇧⌘9 / ⇧⌘0 jump the active pane to its zoom's siblings", () =>
		{
			const {calls, registry} = fakeNav(B);
			processCombo("meta+shift+9", registry, ctx, true);
			processCombo("meta+shift+0", registry, ctx, true);
			expect(calls).toStrictEqual([`${B}-sibling:-1`, `${B}-sibling:1`]);
		});

		it("⇧⌘9 / ⇧⌘0 jump the main outline while the main pane is active", () =>
		{
			const {calls, registry} = fakeNav("main");
			processCombo("meta+shift+9", registry, ctx, true);
			processCombo("meta+shift+0", registry, ctx, true);
			expect(calls).toStrictEqual(["main-sibling:-1", "main-sibling:1"]);
		});

		it("Back / Forward step the active pane's own history", () =>
		{
			const {calls, registry} = fakeNav(B);
			registry.navigate_backward.execute(ctx);
			registry.navigate_forward.execute(ctx);
			expect(calls).toStrictEqual(["commit", `pane-back:${B}`, "commit", `pane-forward:${B}`]);
		});

		it("Back / Forward step the main outline's history while the main pane is active", () =>
		{
			const {calls, registry} = fakeNav("main");
			registry.navigate_backward.execute(ctx);
			registry.navigate_forward.execute(ctx);
			expect(calls).toStrictEqual(["commit", "main-back", "commit", "main-forward"]);
		});
	});

	function fakeNumbered(
		panes:
		{
			id: string;
			zoomedId: string | null;
			query?: string;
		}[],
		activePaneId = "main",
	)
	{
		const calls: string[] = [];
		const deps: PaneNumberDeps =
		{
			getState: () => (
			{
				panes,
				activePaneId,
				openPane: (zoomedId, options) =>
				{
					calls.push(`open:${zoomedId ?? "home"}:${options?.sourcePaneId ?? "?"}:${options?.index ?? "end"}`);
					return "NEW";
				},
			}),
			focusPane: (paneId, caret) =>
			{
				calls.push(`focus:${paneId}:${caret}`);
			},
			zoomPaneTo: (paneId, nodeId) =>
			{
				calls.push(`zoom:${paneId}:${nodeId ?? "home"}`);
			},
		};
		return {
			calls,
			registry: paneNumberCommands(deps),
		};
	}

	const twoPanes = [
		{
			id: A,
			zoomedId: "alice",
		},
		{
			id: B,
			zoomedId: "bob",
		},
	];
	const onItem =
	{
		items: ["item"],
		zoomedId: "zoom",
	};
	const atZoom =
	{
		items: [],
		zoomedId: "zoom",
	};
	const atHome =
	{
		items: [],
		zoomedId: null,
	};

	describe("focus_or_open_pane_N (⌃1–8)", () =>
	{
		it("binds ⌃1–8 to pane N, counting the main pane as 1", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes, B);
			expect(
				["ctrl+1", "ctrl+2", "ctrl+3"].map((combo) => processCombo(combo, registry, onItem, true)),
			).toStrictEqual(["claimed", "claimed", "claimed"]);
			expect(calls).toStrictEqual(["focus:main:title", `focus:${A}:title`]);
		});

		it("leaves the already active pane alone", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes, A);
			registry.focus_or_open_pane_2.execute(onItem);
			const main = fakeNumbered(twoPanes);
			main.registry.focus_or_open_pane_1.execute(onItem);
			expect([...calls, ...main.calls]).toStrictEqual([]);
		});

		it("⌃1 with no pane open puts the caret on the main outline's first child", () =>
		{
			const {calls, registry} = fakeNumbered([]);
			registry.focus_or_open_pane_1.execute(onItem);
			expect(calls).toStrictEqual(["focus:main:first_child"]);
		});

		it("past the last pane opens the focused item in a new last pane, from the active pane", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes, A);
			registry.focus_or_open_pane_5.execute(onItem);
			expect(calls).toStrictEqual([`open:item:${A}:end`]);
		});

		it("opens the zoomed item without a focused one, Home included", () =>
		{
			const {calls, registry} = fakeNumbered([]);
			registry.focus_or_open_pane_2.execute(atZoom);
			registry.focus_or_open_pane_2.execute(atHome);
			expect(calls).toStrictEqual(["open:zoom:main:end", "open:home:main:end"]);
		});
	});

	describe("open_in_pane_N (⌃⇧1–8)", () =>
	{
		it("binds ⌃⇧1–8", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes, A);
			expect(processCombo("ctrl+shift+1", registry, onItem, true)).toBe("claimed");
			expect(calls).toStrictEqual(["zoom:main:item"]);
		});

		it("pane 1 zooms the main outline to the item, with or without panes open", () =>
		{
			const {calls, registry} = fakeNumbered([]);
			registry.open_in_pane_1.execute(atHome);
			expect(calls).toStrictEqual(["zoom:main:home"]);
		});

		it("zooms open pane N to the item and focuses it", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes);
			registry.open_in_pane_3.execute(onItem);
			expect(calls).toStrictEqual([`zoom:${B}:item`]);
		});

		it("only focuses pane N when it already shows the item", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes);
			registry.open_in_pane_2.execute(
				{
					items: ["alice"],
					zoomedId: "zoom",
				},
			);
			expect(calls).toStrictEqual([`focus:${A}:title`]);
		});

		it("treats a pane showing the item with a search as a different location and navigates it", () =>
		{
			const {calls, registry} = fakeNumbered([
				{
					id: A,
					zoomedId: "alice",
					query: "foo",
				},
			]);
			registry.open_in_pane_2.execute(
				{
					items: ["alice"],
					zoomedId: "zoom",
				},
			);
			expect(calls).toStrictEqual([`zoom:${A}:alice`]);
		});

		it("past the last pane opens the item in a new last pane", () =>
		{
			const {calls, registry} = fakeNumbered(twoPanes, B);
			registry.open_in_pane_8.execute(atZoom);
			const none = fakeNumbered([]);
			none.registry.open_in_pane_2.execute(onItem);
			expect([...calls, ...none.calls]).toStrictEqual([`open:zoom:${B}:end`, "open:item:main:end"]);
		});
	});
});

describe("pane reorder", () =>
{
	const A = "AAAAAAAAAAA";
	const B = "BBBBBBBBBBB";
	const state =
	{
		panes: [
			{
				id: A,
			},
			{
				id: B,
			},
		],
	};

	function box(paneId: string, left: number)
	{
		return {
			paneId,
			rect:
			{
				left,
				right: left + 400,
				top: 0,
				bottom: 40,
				width: 400,
				height: 40,
			},
		};
	}
	const headers = [box("main", 0), box(A, 400), box(B, 800)];

	describe("reorderDrop", () =>
	{
		it("drops before a header's left half and after its right half, at that header's edge", () =>
		{
			expect(
				{
					beforeB: reorderDrop(state, "main", headers, 850, 20),
					afterB: reorderDrop(state, "main", headers, 1150, 20),
					beforeMain: reorderDrop(state, B, headers, 100, 20),
					afterMain: reorderDrop(state, B, headers, 300, 20),
				},
			).toStrictEqual(
				{
					beforeB:
					{
						insertionIndex: 1,
						dropLine:
						{
							left: 800,
							top: 0,
							height: 40,
						},
					},
					afterB:
					{
						insertionIndex: 2,
						dropLine:
						{
							left: 1200,
							top: 0,
							height: 40,
						},
					},
					beforeMain:
					{
						insertionIndex: 0,
						dropLine:
						{
							left: 0,
							top: 0,
							height: 40,
						},
					},
					afterMain:
					{
						insertionIndex: 1,
						dropLine:
						{
							left: 400,
							top: 0,
							height: 40,
						},
					},
				},
			);
		});

		it("has no drop over the dragged pane's own header or off every header", () =>
		{
			expect(
				{
					own: reorderDrop(state, A, headers, 500, 20),
					below: reorderDrop(state, A, headers, 100, 60),
				},
			).toStrictEqual(
				{
					own: null,
					below: null,
				},
			);
		});
	});

	describe("autoScrollSpeed", () =>
	{
		const workspace =
		{
			left: 0,
			right: 1000,
			top: 0,
			bottom: 800,
			width: 1000,
			height: 800,
		};
		const header =
		{
			left: 0,
			right: 400,
			top: 0,
			bottom: 40,
			width: 400,
			height: 40,
		};

		it("scrolls faster toward the workspace edge, within 75px of it and the source header's band", () =>
		{
			expect(
				{
					threshold: REORDER_THRESHOLD,
					leftEdge: autoScrollSpeed(0, 20, workspace, header),
					left: autoScrollSpeed(37.5, 20, workspace, header),
					middle: autoScrollSpeed(500, 20, workspace, header),
					right: autoScrollSpeed(1000, 20, workspace, header),
					belowHeader: autoScrollSpeed(1000, 60, workspace, header),
				},
			).toStrictEqual(
				{
					threshold: 4,
					leftEdge: -10,
					left: -6,
					middle: 0,
					right: 10,
					belowHeader: 0,
				},
			);
		});
	});
});

describe("pane store", () =>
{
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
});

describe("pane url", () =>
{
	const MAIN = "AAAAAAAAAAA";
	const SIDE = "BBBBBBBBBBB";
	const THIRD = "DDDDDDDDDDD";

	function base64url(text: string): string
	{
		return Buffer.from(text, "utf8")
			.toString("base64")
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/u, "");
	}

	describe("encodePanes", () =>
	{
		it("prefixes v2. to base64url JSON of the pane state, like upstream $92", () =>
		{
			const state = [
				[MAIN, "item-tree"],
				[SIDE, "item-tree", ["35035d443bf1"]],
			];
			expect(encodePanes(state)).toBe(`v2.${base64url(JSON.stringify(state))}`);
		});

		it("encodes non-ASCII search queries as UTF-8", () =>
		{
			const state = [
				[MAIN, "item-tree"],
				[SIDE, "item-tree", ["None", "café ✓"]],
			];
			expect(encodePanes(state)).toBe(`v2.${base64url(JSON.stringify(state))}`);
		});
	});

	describe("decodePanes", () =>
	{
		it("is absent for a missing value", () =>
		{
			expect(decodePanes(undefined)).toStrictEqual(
				{
					kind: "absent",
				},
			);
		});

		it("round-trips an encoded state", () =>
		{
			const state: [string, string, ...unknown[]][] = [
				[MAIN, "item-tree"],
				[SIDE, "item-tree", ["35035d443bf1", "q"]],
			];
			expect(decodePanes(encodePanes(state))).toStrictEqual(
				{
					kind: "valid",
					state,
				},
			);
		});

		it.each([
			["no v2. prefix", "v1.W10"],
			["an empty payload", "v2."],
			["non-base64url characters", "v2.ab+c"],
			["an impossible base64 length", "v2.abcde"],
			["non-JSON", `v2.${base64url("{")}`],
			["a non-array", `v2.${base64url("{}")}`],
			["an empty array", `v2.${base64url("[]")}`],
			["a main entry of the wrong length", `v2.${base64url(JSON.stringify([[MAIN]]))}`],
			["a main entry that is not item-tree", `v2.${base64url(JSON.stringify([[MAIN, "board"]]))}`],
			["a malformed main pane id", `v2.${base64url(JSON.stringify([["short", "item-tree"]]))}`],
			[
				"a pane entry of the wrong length",
				`v2.${base64url(
					JSON.stringify([
						[MAIN, "item-tree"],
						[SIDE, "item-tree"],
					]),
				)}`,
			],
			[
				"a malformed pane id",
				`v2.${base64url(
					JSON.stringify([
						[MAIN, "item-tree"],
						["bad!", "item-tree", []],
					]),
				)}`,
			],
			[
				"a duplicate pane id",
				`v2.${base64url(
					JSON.stringify([
						[MAIN, "item-tree"],
						[MAIN, "item-tree", []],
					]),
				)}`,
			],
			[
				"an empty pane type",
				`v2.${base64url(
					JSON.stringify([
						[MAIN, "item-tree"],
						[SIDE, "", []],
					]),
				)}`,
			],
		])("is invalid for %s", (_label, value) =>
		{
			expect(decodePanes(value)).toStrictEqual(
				{
					kind: "invalid",
				},
			);
		});

		it("is invalid past upstream's 65536-character cap", () =>
		{
			expect(decodePanes(`v2.${"a".repeat(65_536)}`)).toStrictEqual(
				{
					kind: "invalid",
				},
			);
		});
	});

	describe("encodeWorkspace / decodeWorkspace", () =>
	{
		it("encodes each pane's zoom as its short id, main first", () =>
		{
			const encoded = encodeWorkspace(
				{
					mainPaneId: MAIN,
					panes: [
						{
							paneId: SIDE,
							location: "4823cefa-5fc0-478c-88ac-35035d443bf1",
						},
						{
							paneId: THIRD,
							location: "7f3e2a1b9c0d",
						},
					],
				},
			);
			expect(decodePanes(encoded)).toStrictEqual(
				{
					kind: "valid",
					state: [
						[MAIN, "item-tree"],
						[SIDE, "item-tree", ["35035d443bf1"]],
						[THIRD, "item-tree", ["7f3e2a1b9c0d"]],
					],
				},
			);
		});

		it("encodes a Home zoom as upstream's None", () =>
		{
			const encoded = encodeWorkspace(
				{
					mainPaneId: MAIN,
					panes: [
						{
							paneId: SIDE,
							location: null,
						},
					],
				},
			);
			expect(decodePanes(encoded)).toStrictEqual(
				{
					kind: "valid",
					state: [
						[MAIN, "item-tree"],
						[SIDE, "item-tree", ["None"]],
					],
				},
			);
		});

		it("writes a pane's search query after its zoom, like upstream's [shortId, searchQuery], leaving empty ones out", () =>
		{
			const encoded = encodeWorkspace(
				{
					mainPaneId: MAIN,
					panes: [
						{
							paneId: SIDE,
							location: null,
							query: "#todo",
						},
						{
							paneId: THIRD,
							location: null,
							query: "",
						},
					],
				},
			);
			expect(decodePanes(encoded)).toStrictEqual(
				{
					kind: "valid",
					state: [
						[MAIN, "item-tree"],
						[SIDE, "item-tree", ["None", "#todo"]],
						[THIRD, "item-tree", ["None"]],
					],
				},
			);
		});

		it("decodes every extra item-tree pane, with None as Home and an optional query", () =>
		{
			const value = encodePanes([
				[MAIN, "item-tree"],
				[SIDE, "item-tree", ["None"]],
				[THIRD, "item-tree", ["35035d443bf1", "todo"]],
			]);
			expect(decodeWorkspace(value)).toStrictEqual(
				{
					mainPaneId: MAIN,
					panes: [
						{
							paneId: SIDE,
							location: null,
							query: null,
						},
						{
							paneId: THIRD,
							location: "35035d443bf1",
							query: "todo",
						},
					],
				},
			);
		});

		it.each([
			["absent", undefined],
			["invalid", "v2."],
			["main pane only", encodePanes([[MAIN, "item-tree"]])],
			[
				"an unknown pane type after a valid pane",
				encodePanes([
					[MAIN, "item-tree"],
					[SIDE, "item-tree", ["None"]],
					[THIRD, "board", ["None"]],
				]),
			],
			[
				"a non-array urlState",
				encodePanes([
					[MAIN, "item-tree"],
					[SIDE, "item-tree", "None"],
				]),
			],
			[
				"a non-string id",
				encodePanes([
					[MAIN, "item-tree"],
					[SIDE, "item-tree", [7]],
				]),
			],
			[
				"a non-string query",
				encodePanes([
					[MAIN, "item-tree"],
					[SIDE, "item-tree", ["None", 7]],
				]),
			],
			[
				"an empty id",
				encodePanes([
					[MAIN, "item-tree"],
					[SIDE, "item-tree", [""]],
				]),
			],
		])("is null for %s", (_label, value) =>
		{
			expect(decodeWorkspace(value)).toBeNull();
		});
	});

	describe("sameWorkspace", () =>
	{
		const zoomed =
		{
			paneId: SIDE,
			location: "4823cefa-5fc0-478c-88ac-35035d443bf1",
		};

		it("compares pane ids in order and each zoom's short id", () =>
		{
			const a =
			{
				mainPaneId: MAIN,
				panes: [
					zoomed,
					{
						paneId: THIRD,
						location: null,
					},
				],
			};
			expect(
				{
					same: sameWorkspace(
						a,
						{
							mainPaneId: MAIN,
							panes: [
								{
									paneId: SIDE,
									location: "35035d443bf1",
								},
								{
									paneId: THIRD,
									location: null,
								},
							],
						},
					),
					otherZoom: sameWorkspace(
						a,
						{
							mainPaneId: MAIN,
							panes: [
								{
									paneId: SIDE,
									location: null,
								},
								{
									paneId: THIRD,
									location: null,
								},
							],
						},
					),
					reordered: sameWorkspace(
						a,
						{
							mainPaneId: MAIN,
							panes: [
								{
									paneId: THIRD,
									location: null,
								},
								zoomed,
							],
						},
					),
					fewer: sameWorkspace(
						a,
						{
							mainPaneId: MAIN,
							panes: [zoomed],
						},
					),
					otherMain: sameWorkspace(
						a,
						{
							...a,
							mainPaneId: THIRD,
						},
					),
					bothNull: sameWorkspace(null, null),
					oneNull: sameWorkspace(a, null),
				},
			).toStrictEqual(
				{
					same: true,
					otherZoom: false,
					reordered: false,
					fewer: false,
					otherMain: false,
					bothNull: true,
					oneNull: false,
				},
			);
		});

		it("tells pane searches apart, with no query the same as an empty one", () =>
		{
			const a =
			{
				paneId: SIDE,
				location: null,
			};
			const ws = (pane: {paneId: string; location: null; query?: string | null}) => (
			{
				mainPaneId: MAIN,
				panes: [pane],
			});
			expect(
				{
					otherQuery: sameWorkspace(
						ws(
							{
								...a,
								query: "x",
							},
						),
						ws(
							{
								...a,
								query: "y",
							},
						),
					),
					addedQuery: sameWorkspace(
						ws(a),
						ws(
							{
								...a,
								query: "x",
							},
						),
					),
					emptyQuery: sameWorkspace(
						ws(
							{
								...a,
								query: null,
							},
						),
						ws(
							{
								...a,
								query: "",
							},
						),
					),
				},
			).toStrictEqual(
				{
					otherQuery: false,
					addedQuery: false,
					emptyQuery: true,
				},
			);
		});
	});

	describe("storeWorkspaceUrl", () =>
	{
		it("names every open pane in order with its committed search query", () =>
		{
			expect(
				storeWorkspaceUrl(
					[
						{
							id: SIDE,
							zoomedId: "alice",
							query: "todo",
						},
						{
							id: THIRD,
							zoomedId: null,
							query: "",
						},
					],
					MAIN,
				),
			).toStrictEqual(
				{
					mainPaneId: MAIN,
					panes: [
						{
							paneId: SIDE,
							location: "alice",
							query: "todo",
						},
						{
							paneId: THIRD,
							location: null,
							query: null,
						},
					],
				},
			);
		});

		it("is null with no pane open", () =>
		{
			expect(storeWorkspaceUrl([], null)).toBeNull();
		});
	});

	describe("reconcilePaneUrl", () =>
	{
		const ws: WorkspaceUrl =
		{
			mainPaneId: MAIN,
			panes: [
				{
					paneId: SIDE,
					location: "35035d443bf1",
				},
			],
		};

		it.each<[string, WorkspaceUrl | null, WorkspaceUrl | null, boolean, PaneUrlAction]>([
			["nothing anywhere", null, null, false, "none"],
			["URL and store agree", ws, ws, false, "none"],
			["the URL names panes the store lacks (reload)", ws, null, true, "apply"],
			[
				"the URL names another zoom (Back)",
				{
					mainPaneId: MAIN,
					panes: [
						{
							paneId: SIDE,
							location: null,
						},
					],
				},
				ws,
				true,
				"apply",
			],
			[
				"the URL names one more pane (Forward)",
				{
					mainPaneId: MAIN,
					panes: [
						...ws.panes,
						{
							paneId: THIRD,
							location: null,
						},
					],
				},
				ws,
				true,
				"apply",
			],
			["Back reaches an entry without panes", null, ws, true, "close"],
			["an in-app link drops the param while panes are open", null, ws, false, "restore-url"],
		])("%s", (_label, url, store, isPop, expected) =>
		{
			expect(
				reconcilePaneUrl(
					{
						url,
						store,
						isPop,
					},
				),
			).toBe(expected);
		});
	});

	describe("createPaneId", () =>
	{
		it("makes an 11-character base64url id from 8 random bytes", () =>
		{
			const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01, 0x02, 0x03, 0x04]);
			expect(createPaneId(() => bytes)).toBe(Buffer.from(bytes).toString("base64url"));
		});

		it("makes a well-formed id from crypto by default", () =>
		{
			expect(createPaneId()).toMatch(/^[A-Za-z0-9_-]{11}$/u);
		});
	});

	describe("paneStorageUpdate", () =>
	{
		it("writes the active pane and a width key per pane, like pane-workspace-runtime:v2", () =>
		{
			expect(
				paneStorageUpdate(
					{
						previousIds: [],
						ids: [MAIN, SIDE, THIRD],
						activePaneId: SIDE,
						widths: [716, 716, 472],
					},
				),
			).toStrictEqual(
				{
					set:
					{
						"pane-workspace-runtime:v2": JSON.stringify(
							{
								activePaneId: SIDE,
							},
						),
						[`pane-width:${MAIN}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 716,
							},
						),
						[`pane-width:${SIDE}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 716,
							},
						),
						[`pane-width:${THIRD}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 472,
							},
						),
					},
					remove: [],
				},
			);
		});

		it("removes the width key of a pane that closed", () =>
		{
			expect(
				paneStorageUpdate(
					{
						previousIds: [MAIN, SIDE, THIRD],
						ids: [MAIN, SIDE],
						activePaneId: MAIN,
						widths: [800, 616],
					},
				),
			).toStrictEqual(
				{
					set:
					{
						"pane-workspace-runtime:v2": JSON.stringify(
							{
								activePaneId: MAIN,
							},
						),
						[`pane-width:${MAIN}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 800,
							},
						),
						[`pane-width:${SIDE}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 616,
							},
						),
					},
					remove: [`pane-width:${THIRD}`],
				},
			);
		});

		it("writes no width key for an unusable width", () =>
		{
			expect(
				paneStorageUpdate(
					{
						previousIds: [],
						ids: [MAIN, SIDE],
						activePaneId: MAIN,
						widths: [Number.NaN, 0],
					},
				),
			).toStrictEqual(
				{
					set:
					{
						"pane-workspace-runtime:v2": JSON.stringify(
							{
								activePaneId: MAIN,
							},
						),
					},
					remove: [`pane-width:${MAIN}`, `pane-width:${SIDE}`],
				},
			);
		});

		it("removes every key once no pane is left", () =>
		{
			expect(
				paneStorageUpdate(
					{
						previousIds: [MAIN, SIDE],
						ids: [],
						activePaneId: MAIN,
						widths: [],
					},
				),
			).toStrictEqual(
				{
					set: {},
					remove: ["pane-workspace-runtime:v2", `pane-width:${MAIN}`, `pane-width:${SIDE}`],
				},
			);
		});
	});

	describe("applyPaneStorageUpdate", () =>
	{
		function fakeStorage()
		{
			const entries = new Map<string, string>();
			return {
				entries,
				setItem: (key: string, value: string) =>
				{
					entries.set(key, value);
				},
				removeItem: (key: string) =>
				{
					entries.delete(key);
				},
			};
		}

		it("leaves a runtime key and a width key per pane while panes are open, and no pane key once they close", () =>
		{
			const storage = fakeStorage();
			const ids = [MAIN, SIDE, THIRD];
			applyPaneStorageUpdate(
				storage,
				paneStorageUpdate(
					{
						previousIds: [],
						ids,
						activePaneId: MAIN,
						widths: [716, 716, 472],
					},
				),
			);
			const open = Object.fromEntries(storage.entries);
			applyPaneStorageUpdate(
				storage,
				paneStorageUpdate(
					{
						previousIds: ids,
						ids: [],
						activePaneId: MAIN,
						widths: [],
					},
				),
			);
			expect(
				{
					open,
					closed: Object.fromEntries(storage.entries),
				},
			).toStrictEqual(
				{
					open:
					{
						"pane-workspace-runtime:v2": JSON.stringify(
							{
								activePaneId: MAIN,
							},
						),
						[`pane-width:${MAIN}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 716,
							},
						),
						[`pane-width:${SIDE}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 716,
							},
						),
						[`pane-width:${THIRD}`]: JSON.stringify(
							{
								type: "item-tree",
								width: 472,
							},
						),
					},
					closed: {},
				},
			);
		});
	});

	describe("restoredRuntime / restoredPaneWidth", () =>
	{
		it("restores the stored active pane only when it is one of the URL's panes", () =>
		{
			const stored = JSON.stringify(
				{
					activePaneId: THIRD,
				},
			);
			expect(
				{
					match: restoredRuntime(stored, [MAIN, SIDE, THIRD]),
					notInUrl: restoredRuntime(stored, [MAIN, SIDE]),
					missing: restoredRuntime(null, [MAIN]),
					garbage: restoredRuntime("{", [MAIN]),
					legacy: restoredRuntime(
						JSON.stringify(
							{
								panes: [],
							},
						),
						[MAIN],
					),
				},
			).toStrictEqual(
				{
					match:
					{
						activePaneId: THIRD,
					},
					notInUrl: null,
					missing: null,
					garbage: null,
					legacy: null,
				},
			);
		});

		it("restores a pane's width only for an item-tree record with a positive width", () =>
		{
			expect([
				restoredPaneWidth(
					JSON.stringify(
						{
							type: "item-tree",
							width: 716.5,
						},
					),
				),
				restoredPaneWidth(
					JSON.stringify(
						{
							type: "inbox",
							width: 716,
						},
					),
				),
				restoredPaneWidth(
					JSON.stringify(
						{
							type: "item-tree",
							width: 0,
						},
					),
				),
				restoredPaneWidth(
					JSON.stringify(
						{
							type: "item-tree",
							width: "wide",
						},
					),
				),
				restoredPaneWidth(null),
				restoredPaneWidth("{"),
			]).toStrictEqual([716.5, null, null, null, null, null]);
		});
	});

	describe("withPanesFragment", () =>
	{
		it("sets the panes param after the main location and its query", () =>
		{
			expect(withPanesFragment("#/4823cefa-5fc0-478c-88ac-35035d443bf1?q=x", "v2.abc")).toBe(
				"/#/35035d443bf1?q=x&panes=v2.abc",
			);
		});

		it("sets it at Home", () =>
		{
			expect(withPanesFragment("", "v2.abc")).toBe("/#?panes=v2.abc");
		});

		it("drops the param, keeping other fragments", () =>
		{
			expect(withPanesFragment("#/35035d443bf1?view=board&panes=v2.abc", null)).toBe(
				"/#/35035d443bf1?view=board",
			);
		});

		it("drops it back to plain Home", () =>
		{
			expect(withPanesFragment("#?panes=v2.abc", null)).toBe("/");
		});
	});
});

describe("pane widths", () =>
{
	describe("pane width constants", () =>
	{
		it("uses upstream's 350px pane minimum, 8px gutter and 380px fallback width", () =>
		{
			expect(
				{
					min: MIN_PANE_WIDTH,
					gutter: PANE_GUTTER,
					fallback: DEFAULT_PANE_WIDTH,
				},
			).toStrictEqual(
				{
					min: 350,
					gutter: 8,
					fallback: 380,
				},
			);
		});
	});

	describe("availablePaneWidth", () =>
	{
		it("is the measured workspace width when there is one", () =>
		{
			expect(availablePaneWidth(1416, 1680, 264)).toBe(1416);
		});

		it("falls back to the window beside the left bar and the gutter, never negative", () =>
		{
			expect([availablePaneWidth(null, 1680, 256), availablePaneWidth(null, 100, 256)]).toStrictEqual([1416, 0]);
		});
	});

	describe("paneWidth", () =>
	{
		it("floors finite widths at the minimum and falls back to 380 for anything else, like upstream's normalize", () =>
		{
			expect([paneWidth(500), paneWidth(100), paneWidth(Number.NaN), paneWidth(undefined)]).toStrictEqual([
				500, 350, 380, 380,
			]);
		});
	});

	describe("minimumPaneWidth", () =>
	{
		it("is 350 for every pane but the last, which must leave the workspace filled", () =>
		{
			expect([
				minimumPaneWidth([716, 716], 0, 1416),
				minimumPaneWidth([716, 716], 1, 1416),
				minimumPaneWidth([638, 0], 1, 1360),
				minimumPaneWidth([1500, 1500], 1, 1416),
			]).toStrictEqual([350, 700, 722, 350]);
		});
	});

	describe("resolveWidths", () =>
	{
		it("gives a new pane an equal share of the workspace and keeps the others while they fill it", () =>
		{
			expect(resolveWidths([716, 716, 0], [2], 1416, false)).toStrictEqual([716, 716, 472]);
		});

		it("leaves the widths alone when the panes already overfill and the workspace is not being refit", () =>
		{
			expect(resolveWidths([350, 1010], [], 1360, false)).toStrictEqual([350, 1010]);
		});

		it("scales panes up in proportion when they no longer fill the workspace, like closing a pane", () =>
		{
			expect(resolveWidths([716, 472], [], 1416, false)).toStrictEqual([853.4141414141413, 562.5858585858585]);
		});

		it("rescales panes that overfill when asked to fit the workspace", () =>
		{
			expect(resolveWidths([800, 800], [], 1000, true)).toStrictEqual([500, 500]);
		});

		it("splits the workspace equally among all-new panes", () =>
		{
			expect(resolveWidths([0, 0, 0], [0, 1, 2], 1200, false)).toStrictEqual([400, 400, 400]);
		});

		it("never takes a pane under the minimum", () =>
		{
			expect(resolveWidths([0, 0, 0], [0, 1, 2], 600, false)).toStrictEqual([350, 350, 350]);
		});

		it("returns nothing for no panes", () =>
		{
			expect(resolveWidths([], [], 1000, false)).toStrictEqual([]);
		});
	});

	describe("divider resize", () =>
	{
		const available = 1416;

		it("begins on a pane with its right neighbour's width, and refuses an unknown pane", () =>
		{
			expect([
				beginDividerResize([716, 716], 0),
				beginDividerResize([716, 716], 1),
				beginDividerResize([716, 716], 2),
			]).toStrictEqual([
				{
					index: 0,
					width: 716,
					rightWidth: 716,
				},
				{
					index: 1,
					width: 716,
					rightWidth: null,
				},
				null,
			]);
		});

		it("shrinks the pane and grows the right neighbour to keep the row filling the workspace", () =>
		{
			const first = resizedDivider(
				[716, 716],
				{
					index: 0,
					width: 716,
					rightWidth: 716,
				},
				-10,
				available,
			);
			const second = resizedDivider(
				first,
				{
					index: 0,
					width: 706,
					rightWidth: 716,
				},
				-50,
				available,
			);
			expect(
				{
					first,
					second,
				},
			).toStrictEqual(
				{
					first: [706, 716],
					second: [656, 760],
				},
			);
		});

		it("grows the pane without shrinking its right neighbour, so the workspace overflows", () =>
		{
			expect(
				resizedDivider(
					[656, 760],
					{
						index: 0,
						width: 656,
						rightWidth: 760,
					},
					50,
					available,
				),
			).toStrictEqual([706, 760]);
		});

		it("stops at the pane's minimum", () =>
		{
			expect(
				resizedDivider(
					[706, 760],
					{
						index: 0,
						width: 706,
						rightWidth: 760,
					},
					350 - 706,
					available,
				),
			).toStrictEqual([350, 1066]);
			expect(
				resizedDivider(
					[350, 1066],
					{
						index: 1,
						width: 1066,
						rightWidth: null,
					},
					-10,
					available,
				),
			).toStrictEqual([350, 1066]);
			expect(
				resizedDivider(
					[350, 1066],
					{
						index: 1,
						width: 1066,
						rightWidth: null,
					},
					50,
					available,
				),
			).toStrictEqual([350, 1116]);
		});

		it("ignores a non-finite delta", () =>
		{
			expect(
				resizedDivider(
					[716, 716],
					{
						index: 0,
						width: 716,
						rightWidth: 716,
					},
					Number.NaN,
					available,
				),
			).toStrictEqual([716, 716]);
		});

		it("restores both start widths when cancelled", () =>
		{
			expect(
				cancelledDivider(
					[350, 1066, 400],
					{
						index: 0,
						width: 716,
						rightWidth: 716,
					},
				),
			).toStrictEqual([716, 716, 400]);
			expect(
				cancelledDivider(
					[350, 1066],
					{
						index: 1,
						width: 900,
						rightWidth: null,
					},
				),
			).toStrictEqual([350, 900]);
		});
	});
});
