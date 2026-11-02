import {describe, expect, it} from "vite-plus/test";
import {processCombo} from "../src/client/keys/dispatch.js";
import {openInPane, paneCommands, paneNavCommands, paneNumberCommands} from "../src/client/pane-commands.js";
import type {OpenInPaneState, PaneCommandStore, PaneNavDeps, PaneNumberDeps} from "../src/client/pane-commands.js";

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
