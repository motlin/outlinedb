import {describe, expect, it, vi} from "vite-plus/test";
import {ITEM_TYPES} from "../src/client/layout-types.js";
import type {ItemType} from "../src/client/layout-types.js";
import type {ItemTypeSelectDeps} from "../src/client/item-type-select.js";

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

const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {pickerItemTypes, selectItemType, toggleBoardOrTable} = await import("../src/client/item-type-select.js");

function itemType(key: string): ItemType
{
	const type = ITEM_TYPES.find((candidate) => candidate.key === key);
	if (type === undefined)
	{
		throw new Error(`No item type ${key}`);
	}
	return type;
}

interface Calls
{
	updates:
	{
		nodeId: string;
		layoutMode: string;
	}[];
	expanded: string[][];
}

function recordingDeps(children: Record<string, string[]>, layoutModes: Record<string, string | null> = {})
{
	const calls: Calls =
	{
		updates: [],
		expanded: [],
	};
	const deps: ItemTypeSelectDeps =
	{
		update: (nodeId, layoutMode) =>
		{
			calls.updates.push(
				{
					nodeId,
					layoutMode,
				},
			);
		},
		expandAll: (ids) =>
		{
			calls.expanded.push([...ids]);
		},
		childIds: (nodeId) => children[nodeId] ?? [],
		layoutMode: (nodeId) => layoutModes[nodeId] ?? null,
	};
	return {
		calls,
		deps,
	};
}

describe("requested menus store", () =>
{
	it("opens the Turn into picker by id at a point, and clears it on hide", () =>
	{
		expect(useOutlineStore.getState().requestedMenus.size).toBe(0);
		useOutlineStore.getState().showItemTypePicker(
			{
				nodeIds: ["alice"],
				position:
				{
					top: 46,
					left: 1131,
				},
			},
		);
		expect([...useOutlineStore.getState().requestedMenus]).toStrictEqual([
			[
				"node_type_picker",
				{
					target:
					{
						top: 46,
						left: 1131,
					},
					cmdContext:
					{
						nodeIds: ["alice"],
					},
					qualifiers: [],
				},
			],
		]);
		useOutlineStore.getState().hideMenu("node_type_picker");
		expect(useOutlineStore.getState().requestedMenus.size).toBe(0);
	});

	it("warns and opens nothing when a menu has no rows", () =>
	{
		useOutlineStore.getState().showMenuById(
			"nope",
			{
				top: 1,
				left: 2,
			},
			{
				nodeIds: ["alice"],
			},
			[],
		);
		expect(
			{
				menus: useOutlineStore.getState().requestedMenus.size,
				message: useOutlineStore.getState().appMessage?.text,
			},
		).toStrictEqual(
			{
				menus: 0,
				message: "Couldn't assemble menu: nope",
			},
		);
	});
});

describe("pickerItemTypes", () =>
{
	it("offers only Bullets and Board at Home, and all twelve types elsewhere", () =>
	{
		expect(pickerItemTypes(["home"]).map((type) => type.label)).toStrictEqual(["Bullets", "Board"]);
		expect(pickerItemTypes(["alice"])).toStrictEqual(ITEM_TYPES.filter((type) => type.key !== "dashboard"));
	});
});

describe("selectItemType", () =>
{
	it("writes Board and expands every child of the node", () =>
	{
		const {calls, deps} = recordingDeps(
			{
				alice: ["bob", "carol"],
			},
		);
		selectItemType(itemType("board"), ["alice"], deps);
		expect(calls).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "board",
					},
				],
				expanded: [["bob", "carol"]],
			},
		);
	});

	it("writes Board at Home through the home node id", () =>
	{
		const {calls, deps} = recordingDeps(
			{
				home: ["r1"],
			},
		);
		selectItemType(itemType("board"), ["home"], deps);
		expect(calls).toStrictEqual(
			{
				updates: [
					{
						nodeId: "home",
						layoutMode: "board",
					},
				],
				expanded: [["r1"]],
			},
		);
	});

	it("writes a plain type without expanding", () =>
	{
		const {calls, deps} = recordingDeps(
			{
				alice: ["bob"],
			},
		);
		selectItemType(itemType("h2"), ["alice"], deps);
		expect(calls).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "h2",
					},
				],
				expanded: [],
			},
		);
	});

	it("splits a multi-line code block into one row per line when it becomes another type", () =>
	{
		const updates: unknown[] = [];
		const creates: unknown[] = [];
		const deps: ItemTypeSelectDeps =
		{
			update: (nodeId, layoutMode, extra) =>
			{
				updates.push([nodeId, layoutMode, extra]);
			},
			plainName: () => "a < b\n  c",
			createAfter: (nodeId, lines) =>
			{
				creates.push([nodeId, lines]);
			},
			expandAll: () =>
			{
			},
			childIds: () => [],
			layoutMode: () => "code-block",
		};
		selectItemType(itemType("h2"), ["alice"], deps);
		expect(
			{
				updates,
				creates,
			},
		).toStrictEqual(
			{
				updates: [
					[
						"alice",
						"h2",
						{
							name: "a &lt; b",
						},
					],
				],
				creates: [
					[
						"alice",
						[
							{
								name: "  c",
								layoutMode: "h2",
							},
						],
					],
				],
			},
		);
	});

	it("clears the note of a row turned into a divider", () =>
	{
		const extras: unknown[] = [];
		const deps: ItemTypeSelectDeps =
		{
			update: (_nodeId, _layoutMode, extra) =>
			{
				extras.push(extra);
			},
			hasNote: (nodeId) => nodeId === "alice",
			expandAll: () =>
			{
			},
			childIds: () => [],
			layoutMode: () => null,
		};
		selectItemType(itemType("divider"), ["alice", "bob"], deps);
		expect(extras).toStrictEqual([
			{
				note: "",
			},
			undefined,
		]);
	});

	it("sets Divider on a node that is not one, and keeps an existing divider", () =>
	{
		const on = recordingDeps(
			{},
			{
				bob: "h2",
			},
		);
		selectItemType(itemType("divider"), ["alice", "bob"], on.deps);
		const off = recordingDeps(
			{},
			{
				alice: "divider",
			},
		);
		selectItemType(itemType("divider"), ["alice"], off.deps);
		expect([on.calls, off.calls]).toStrictEqual([
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "divider",
					},
					{
						nodeId: "bob",
						layoutMode: "divider",
					},
				],
				expanded: [],
			},
			{
				updates: [],
				expanded: [],
			},
		]);
	});

	it("keeps the current type when chosen again", () =>
	{
		const {calls, deps} = recordingDeps(
			{},
			{
				alice: "h2",
			},
		);
		selectItemType(itemType("h2"), ["alice"], deps);
		expect(calls).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "h2",
					},
				],
				expanded: [],
			},
		);
	});

	it("skips Home for types Home cannot become, and writes the rest", () =>
	{
		const {calls, deps} = recordingDeps({});
		selectItemType(itemType("h1"), ["home", "alice"], deps);
		selectItemType(itemType("todo"), ["home"], deps);
		selectItemType(itemType("board"), ["home"], deps);
		expect(calls).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "h1",
					},
					{
						nodeId: "home",
						layoutMode: "board",
					},
				],
				expanded: [[]],
			},
		);
	});
});

describe("turning into a board", () =>
{
	function orderedDeps(children: Record<string, string[]>, mirrors: Record<string, string[]> = {})
	{
		const log: unknown[] = [];
		const deps: ItemTypeSelectDeps =
		{
			update: (nodeId, layoutMode) => void log.push(["update", nodeId, layoutMode]),
			expandAll: (ids) => void log.push(["expandAll", [...ids]]),
			childIds: (nodeId) => children[nodeId] ?? [],
			mirrorIds: (nodeId) => mirrors[nodeId] ?? [],
			createChild: (parentId) =>
			{
				log.push(["create", parentId]);
				return "new1";
			},
			startEditing: (nodeId) => void log.push(["startEditing", nodeId]),
			layoutMode: () => null,
		};
		return {
			log,
			deps,
		};
	}

	it("creates, expands and edits one empty column on a childless node", () =>
	{
		const picker = orderedDeps(
			{
				alice: [],
			},
		);
		selectItemType(itemType("board"), ["alice"], picker.deps);
		const toggle = orderedDeps(
			{
				alice: [],
			},
		);
		toggleBoardOrTable("toggle_board", "alice", toggle.deps);
		expect([picker.log, toggle.log]).toStrictEqual([
			[
				["expandAll", []],
				["update", "alice", "board"],
				["create", "alice"],
				["expandAll", ["alice"]],
				["startEditing", "new1"],
			],
			[
				["expandAll", []],
				["update", "alice", "board"],
				["create", "alice"],
				["expandAll", ["alice"]],
				["startEditing", "new1"],
			],
		]);
	});

	it("creates nothing when the node has columns, and expands its mirrors' children", () =>
	{
		const {log, deps} = orderedDeps(
			{
				alice: ["bob", "carol"],
				alice2: ["dan"],
			},
			{
				alice: ["alice2"],
			},
		);
		selectItemType(itemType("board"), ["alice"], deps);
		expect(log).toStrictEqual([
			["expandAll", ["bob", "carol", "dan"]],
			["update", "alice", "board"],
		]);
	});
});

describe("toggleBoardOrTable", () =>
{
	it("sets Board without toggling off and expands the children", () =>
	{
		const on = recordingDeps(
			{
				alice: ["bob", "carol"],
			},
		);
		toggleBoardOrTable("toggle_board", "alice", on.deps);
		const again = recordingDeps(
			{
				alice: ["bob"],
			},
			{
				alice: "board",
			},
		);
		toggleBoardOrTable("toggle_board", "alice", again.deps);
		expect([on.calls, again.calls]).toStrictEqual([
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "board",
					},
				],
				expanded: [["bob", "carol"]],
			},
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "board",
					},
				],
				expanded: [["bob"]],
			},
		]);
	});

	it("toggles Table: on expands the rows, off writes bullets", () =>
	{
		const on = recordingDeps(
			{
				alice: ["bob"],
			},
		);
		toggleBoardOrTable("toggle_table", "alice", on.deps);
		const off = recordingDeps(
			{
				alice: ["bob"],
			},
			{
				alice: "table",
			},
		);
		toggleBoardOrTable("toggle_table", "alice", off.deps);
		expect([on.calls, off.calls]).toStrictEqual([
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "table",
					},
				],
				expanded: [["bob"]],
			},
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "bullets",
					},
				],
				expanded: [],
			},
		]);
	});
});
