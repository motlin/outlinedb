import {describe, expect, it} from "vite-plus/test";
import {LAYOUT_HOTKEY_COMMANDS, planLayoutHotkey, todoModeAvailable} from "../src/client/layout-hotkeys.js";
import {buildHotkeys} from "../src/client/keys/keymap.js";
import type {NodeResponse} from "../src/node-types.js";

function node(id: string, overrides: Partial<NodeResponse> = {}): NodeResponse
{
	return {
		id,
		parent_id: null,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		numberedStart: null,
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: false,
		...overrides,
	};
}

describe("LAYOUT_HOTKEY_COMMANDS", () =>
{
	it("lists upstream's ⌥⌘ digit layout toggles, each bound in the Mac keymap", () =>
	{
		const bound = new Map(
			buildHotkeys(
				{
					mac: true,
					safari: false,
					windows: false,
					linux: false,
					chromeos: false,
					electron: false,
				},
			).map(([combo, command]) => [command, combo]),
		);
		expect(LAYOUT_HOTKEY_COMMANDS.map((command) => [command, bound.get(command)])).toStrictEqual([
			["toggle_h1", "alt+meta+1"],
			["toggle_h2", "alt+meta+2"],
			["toggle_h3", "alt+meta+3"],
			["toggle_paragraph", "alt+meta+4"],
			["toggle_code_block", "alt+meta+6"],
			["toggle_quote_block", "alt+meta+7"],
			["toggle_bullet", "alt+meta+8"],
			["toggle_todo", "alt+meta+9"],
			["toggle_numbered", "alt+meta+0"],
		]);
	});
});

describe("planLayoutHotkey", () =>
{
	it("toggles the edited h1 back to bullets", () =>
	{
		expect(
			planLayoutHotkey("toggle_h1", [
				node(
					"alice",
					{
						data:
						{
							layoutMode: "h1",
						},
					},
				),
			]),
		).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "bullets",
					},
				],
				deletes: [],
				clearSelection: false,
				creates: [],
			},
		);
	});

	it("numbers the edited row from its typed start, stripping the prefix", () =>
	{
		expect(
			planLayoutHotkey("toggle_numbered", [
				node(
					"alice",
					{
						name: "3. Buy milk",
					},
				),
			]),
		).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "numbered",
						numberedStart: 3,
						name: "Buy milk",
					},
				],
				deletes: [],
				clearSelection: false,
				creates: [],
			},
		);
	});

	it("plans from the editor's unsaved text when given", () =>
	{
		expect(
			planLayoutHotkey(
				"toggle_numbered",
				[
					node(
						"alice",
						{
							name: "Buy",
						},
					),
				],
				{
					nodeId: "alice",
					name: "3. <b>Buy</b>",
				},
			),
		).toStrictEqual(
			{
				updates: [
					{
						nodeId: "alice",
						layoutMode: "numbered",
						numberedStart: 3,
						name: "<b>Buy</b>",
					},
				],
				deletes: [],
				clearSelection: false,
				creates: [],
			},
		);
	});

	it("merges plain leaves into one quote block with escaped text, deleting the rest", () =>
	{
		expect(
			planLayoutHotkey("toggle_quote_block", [
				node(
					"a",
					{
						name: "x &lt; <i>y</i>",
					},
				),
				node("b"),
				node(
					"c",
					{
						note: "n",
					},
				),
				node(
					"d",
					{
						hasChildren: true,
					},
				),
			]),
		).toStrictEqual(
			{
				updates: [
					{
						nodeId: "a",
						layoutMode: "quote-block",
						name: "x &lt; y\nb",
					},
					{
						nodeId: "c",
						layoutMode: "quote-block",
					},
					{
						nodeId: "d",
						layoutMode: "quote-block",
					},
				],
				deletes: ["b"],
				clearSelection: true,
				creates: [],
			},
		);
	});

	it("writes a lone code block's text as escaped plain text", () =>
	{
		expect(
			planLayoutHotkey("toggle_code_block", [
				node(
					"a",
					{
						name: "<b>a &amp; b</b>",
					},
				),
			]),
		).toStrictEqual(
			{
				updates: [
					{
						nodeId: "a",
						layoutMode: "code-block",
						name: "a &amp; b",
					},
				],
				deletes: [],
				clearSelection: false,
				creates: [],
			},
		);
	});

	it("turns numbered rows back to bullets, clearing their start", () =>
	{
		expect(
			planLayoutHotkey("toggle_numbered", [
				node(
					"a",
					{
						data:
						{
							layoutMode: "numbered",
						},
						numberedStart: 4,
					},
				),
			]),
		).toStrictEqual(
			{
				updates: [
					{
						nodeId: "a",
						layoutMode: "bullets",
						numberedStart: null,
					},
				],
				deletes: [],
				clearSelection: false,
				creates: [],
			},
		);
	});
});

describe("todoModeAvailable", () =>
{
	it("is true when some target is writable and can take the to-do layout", () =>
	{
		expect(
			todoModeAvailable([
				node(
					"a",
					{
						readOnly: true,
					},
				),
				node("b"),
				node(
					"c",
					{
						data:
						{
							layoutMode: "code-block",
						},
					},
				),
			]),
		).toBe(true);
	});

	it("is false when every target is read-only or cannot take the to-do layout, or there are none", () =>
	{
		expect([
			todoModeAvailable([
				node(
					"a",
					{
						readOnly: true,
					},
				),
				node(
					"b",
					{
						readOnly: true,
					},
				),
			]),
			todoModeAvailable([
				node(
					"a",
					{
						data:
						{
							layoutMode: "divider",
						},
					},
				),
				node(
					"b",
					{
						data:
						{
							layoutMode: "quote-block",
						},
					},
				),
			]),
			todoModeAvailable([]),
		]).toStrictEqual([false, false, false]);
	});
});
