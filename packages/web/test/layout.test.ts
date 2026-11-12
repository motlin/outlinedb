import {describe, expect, it} from "vite-plus/test";
import {LAYOUT_HOTKEY_COMMANDS, planLayoutHotkey, todoModeAvailable} from "../src/client/layout-hotkeys.js";
import {buildHotkeys} from "../src/client/keys/keymap.js";
import type {NodeResponse} from "../src/node-types.js";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {DIVIDER_CLASSES, resolveLayoutMode} from "../src/client/components/layout-mode.js";
import
{
	availableItemTypes,
	canHaveNote,
	currentTypeIcon,
	ITEM_TYPES,
	normalizeLayoutMode,
	planBlockTypeChange,
	planLayoutToggle,
} from "../src/client/layout-types.js";
import type {ItemTypeContext, LayoutToggleItem} from "../src/client/layout-types.js";

describe("layout hotkeys", () =>
{
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
});

describe("layout mode", () =>
{
	describe("resolveLayoutMode", () =>
	{
		it.each([
			[
				"bullets",
				{
					projectClasses: [],
					isTodo: false,
				},
			],
			[
				"h1",
				{
					projectClasses: ["header1"],
					isTodo: false,
				},
			],
			[
				"h2",
				{
					projectClasses: ["header2"],
					isTodo: false,
				},
			],
			[
				"h3",
				{
					projectClasses: ["header3"],
					isTodo: false,
				},
			],
			[
				"p",
				{
					projectClasses: ["paragraph"],
					isTodo: false,
				},
			],
			[
				"paragraph",
				{
					projectClasses: ["paragraph"],
					isTodo: false,
				},
			],
			[
				"todo",
				{
					projectClasses: ["checkmark"],
					isTodo: true,
				},
			],
			[
				"check",
				{
					projectClasses: ["checkmark"],
					isTodo: true,
				},
			],
			[
				"numbered",
				{
					projectClasses: [],
					isTodo: false,
				},
			],
			[
				"board",
				{
					projectClasses: ["board"],
					isTodo: false,
				},
			],
			[
				"table",
				{
					projectClasses: ["tableItem"],
					isTodo: false,
				},
			],
			[
				"quote-block",
				{
					projectClasses: ["quote-block", "multiline"],
					isTodo: false,
				},
			],
			[
				"quote",
				{
					projectClasses: ["quote-block", "multiline"],
					isTodo: false,
				},
			],
			[
				"code-block",
				{
					projectClasses: ["code-block", "multiline"],
					isTodo: false,
				},
			],
			[
				"divider",
				{
					projectClasses: DIVIDER_CLASSES,
					isTodo: false,
				},
			],
		])("resolves %s", (layoutMode, expected) =>
		{
			expect(resolveLayoutMode(layoutMode)).toStrictEqual(expected);
		});

		it("lists upstream's divider classes in order", () =>
		{
			expect(DIVIDER_CLASSES.join(" ")).toBe(
				"divider [&>.name]:items-center [&>.name>.content]:flex-none [&>.name>.content]:justify-center [&>.name>.content]:max-w-[calc(100%_-_48px)] [&>.name>.content]:min-w-0 [&>.name>.content]:!px-s [&>.name>.content]:text-center [&>.name>.content]:text-tertiary [&>.name>.content]:text-s [&>.name>.content>.innerContentContainer]:max-w-full [&>.name>.content>.innerContentContainer]:w-auto [&>.name.empty:not(.name--focused)>.content]:!px-0 [&>.name.empty:not(.name--focused)>.content]:!w-0 project--bullet-on-hover",
			);
		});
	});

	const CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));

	function clientSources(dir: string): string[]
	{
		return readdirSync(
			dir,
			{
				withFileTypes: true,
			},
		).flatMap((entry) =>
		{
			const full = join(dir, entry.name);
			if (entry.isDirectory())
			{
				return clientSources(full);
			}
			return /\.tsx?$/u.test(entry.name) ? [full] : [];
		});
	}

	describe("stored layoutMode writes", () =>
	{
		it("never writes the legacy paragraph/quote values upstream ignores", () =>
		{
			const legacyWrite =
				/layoutMode: "(paragraph|quote)"|setLayoutMode\([^)]*"(paragraph|quote)"\)|id: "(paragraph|quote)"/u;
			const offenders = clientSources(CLIENT_DIR).filter((file) => legacyWrite.test(readFileSync(file, "utf8")));
			expect(offenders).toStrictEqual([]);
		});
	});
});

describe("layout types", () =>
{
	const NORMAL: ItemTypeContext =
	{
		isRoot: false,
		isMainDocumentRoot: false,
		readOnly: false,
		isTableCell: false,
	};

	describe("ITEM_TYPES", () =>
	{
		it("lists the upstream turn-into types in menu order", () =>
		{
			expect(ITEM_TYPES).toStrictEqual([
				{
					key: "bullet",
					label: "Bullets",
					layoutModeKey: "bullets",
					icon: "list-ul",
					command: "turn_into_bullet",
				},
				{
					key: "h1",
					label: "Heading 1",
					layoutModeKey: "h1",
					icon: "h1",
					command: "turn_into_h1",
				},
				{
					key: "h2",
					label: "Heading 2",
					layoutModeKey: "h2",
					icon: "h2",
					command: "turn_into_h2",
				},
				{
					key: "h3",
					label: "Heading 3",
					layoutModeKey: "h3",
					icon: "h3",
					command: "turn_into_h3",
				},
				{
					key: "p",
					label: "Paragraph",
					layoutModeKey: "p",
					icon: "paragraph",
					command: "turn_into_paragraph",
				},
				{
					key: "todo",
					label: "To-do",
					layoutModeKey: "todo",
					icon: "list-check",
					command: "turn_into_todo",
				},
				{
					key: "numbered",
					label: "Number",
					layoutModeKey: "numbered",
					icon: "list-ol",
					command: "turn_into_numbered",
				},
				{
					key: "board",
					label: "Board",
					layoutModeKey: "board",
					icon: "columns-3",
					command: "turn_into_board",
				},
				{
					key: "table",
					label: "Table",
					layoutModeKey: "table",
					icon: "table-cells",
					command: "turn_into_table",
				},
				{
					key: "dashboard",
					label: "Dashboard",
					layoutModeKey: "dashboard",
					icon: "grid-horizontal",
					command: "turn_into_dashboard",
				},
				{
					key: "quote-block",
					label: "Quote",
					layoutModeKey: "quote-block",
					icon: "block-quote",
					command: "turn_into_quote_block",
				},
				{
					key: "code-block",
					label: "Code Block",
					layoutModeKey: "code-block",
					icon: "rectangle-code",
					command: "turn_into_code_block",
				},
				{
					key: "divider",
					label: "Divider",
					layoutModeKey: "divider",
					icon: "horizontal-rule",
					command: "turn_into_divider",
				},
			]);
		});
	});

	describe("availableItemTypes", () =>
	{
		const labels = (ctx: ItemTypeContext): string[] => availableItemTypes(ctx).map((type) => type.label);

		it("offers only Bullets and Board on Home", () =>
		{
			expect(
				labels(
					{
						isRoot: true,
						isMainDocumentRoot: true,
						readOnly: false,
						isTableCell: false,
					},
				),
			).toStrictEqual(["Bullets", "Board"]);
		});

		it("drops To-do on a zoomed root", () =>
		{
			expect(
				labels(
					{
						...NORMAL,
						isRoot: true,
					},
				),
			).toStrictEqual([
				"Bullets",
				"Heading 1",
				"Heading 2",
				"Heading 3",
				"Paragraph",
				"Number",
				"Board",
				"Table",
				"Quote",
				"Code Block",
				"Divider",
			]);
		});

		it("offers all twelve types on a normal item", () =>
		{
			expect(labels(NORMAL)).toStrictEqual([
				"Bullets",
				"Heading 1",
				"Heading 2",
				"Heading 3",
				"Paragraph",
				"To-do",
				"Number",
				"Board",
				"Table",
				"Quote",
				"Code Block",
				"Divider",
			]);
		});

		it("offers nine types in a table cell", () =>
		{
			expect(
				labels(
					{
						...NORMAL,
						isTableCell: true,
					},
				),
			).toStrictEqual([
				"Bullets",
				"Heading 1",
				"Heading 2",
				"Heading 3",
				"Paragraph",
				"To-do",
				"Number",
				"Board",
				"Table",
			]);
		});

		it("offers nothing when read-only", () =>
		{
			expect(
				labels(
					{
						...NORMAL,
						readOnly: true,
					},
				),
			).toStrictEqual([]);
		});
	});

	describe("currentTypeIcon", () =>
	{
		it("maps each layout mode to its type icon", () =>
		{
			expect(
				[null, undefined, "bullets", "h2", "todo", "numbered", "board", "code-block", "divider", "unknown"].map(
					(mode) => currentTypeIcon(mode),
				),
			).toStrictEqual([
				"list-ul",
				"list-ul",
				"list-ul",
				"h2",
				"list-check",
				"list-ol",
				"columns-3",
				"rectangle-code",
				"horizontal-rule",
				"list-ul",
			]);
		});

		it("reads legacy check, paragraph and quote values", () =>
		{
			expect(["check", "paragraph", "quote"].map((mode) => currentTypeIcon(mode))).toStrictEqual([
				"list-check",
				"paragraph",
				"block-quote",
			]);
		});
	});

	function item(id: string, overrides: Partial<LayoutToggleItem> = {}): LayoutToggleItem
	{
		return {
			id,
			layoutMode: null,
			numberedStart: null,
			name: id,
			plainName: id,
			hasChildren: false,
			hasNote: false,
			...overrides,
		};
	}

	describe("planLayoutToggle", () =>
	{
		it("turns every item back to bullets when all already have the target type", () =>
		{
			expect(
				planLayoutToggle("toggle_h1", [
					item(
						"a",
						{
							layoutMode: "h1",
						},
					),
					item(
						"b",
						{
							layoutMode: "h1",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "bullets",
						},
						{
							id: "b",
							layoutMode: "bullets",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("turns every item into the target when any item differs", () =>
		{
			expect(
				planLayoutToggle("toggle_h1", [
					item(
						"a",
						{
							layoutMode: "h1",
						},
					),
					item(
						"b",
						{
							layoutMode: "bullets",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "h1",
						},
						{
							id: "b",
							layoutMode: "h1",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("reads legacy check as to-do", () =>
		{
			expect(
				planLayoutToggle("toggle_todo", [
					item(
						"a",
						{
							layoutMode: "check",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "bullets",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it.each([
			[
				"toggle_h1",
				{
					layoutMode: "h1",
				},
				"bullets",
			],
			[
				"toggle_h1",
				{
					layoutMode: "bullets",
				},
				"h1",
			],
			[
				"toggle_paragraph",
				{
					layoutMode: "h2",
				},
				"p",
			],
			[
				"toggle_paragraph",
				{
					layoutMode: "paragraph",
				},
				"bullets",
			],
		] as const)("toggles text type %s over %o to %s, storing p never paragraph", (command, current, layoutMode) =>
		{
			expect(planLayoutToggle(command, [item("a", current)])).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode,
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("always sets bullets for toggle_bullet", () =>
		{
			expect(
				planLayoutToggle("toggle_bullet", [
					item(
						"a",
						{
							layoutMode: "bullets",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "bullets",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("stores a typed start number and strips the prefix when numbering", () =>
		{
			expect(
				planLayoutToggle("toggle_numbered", [
					item(
						"a",
						{
							name: "3. Buy milk",
							plainName: "3. Buy milk",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "numbered",
							numberedStart: 3,
							name: "Buy milk",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("clears the start number when un-numbering", () =>
		{
			expect(
				planLayoutToggle("toggle_numbered", [
					item(
						"a",
						{
							layoutMode: "numbered",
							numberedStart: 3,
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "bullets",
							numberedStart: null,
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("takes the start number from the first item only", () =>
		{
			expect(
				planLayoutToggle("toggle_numbered", [
					item(
						"a",
						{
							name: "2. A",
							plainName: "2. A",
						},
					),
					item(
						"b",
						{
							name: "B",
							plainName: "B",
						},
					),
					item(
						"c",
						{
							name: "7. C",
							plainName: "7. C",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "numbered",
							numberedStart: 2,
							name: "A",
						},
						{
							id: "b",
							layoutMode: "numbered",
						},
						{
							id: "c",
							layoutMode: "numbered",
							name: "C",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("leaves prefixes alone when the first item has none", () =>
		{
			expect(
				planLayoutToggle("toggle_numbered", [
					item("a"),
					item(
						"b",
						{
							name: "7. C",
							plainName: "7. C",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "numbered",
						},
						{
							id: "b",
							layoutMode: "numbered",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("merges a run of leaf items into one code block", () =>
		{
			expect(
				planLayoutToggle("toggle_code_block", [
					item(
						"A",
						{
							name: "<b>A</b>",
							plainName: "A",
						},
					),
					item(
						"B",
						{
							name: "B",
							plainName: "B",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "A",
							layoutMode: "code-block",
							name: "A\nB",
						},
					],
					deletes: ["B"],
					clearSelection: true,
				},
			);
		});

		it("turns a single code block back to bullets", () =>
		{
			expect(
				planLayoutToggle("toggle_code_block", [
					item(
						"a",
						{
							layoutMode: "code-block",
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "bullets",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("sets plain text when turning a single item into a code block", () =>
		{
			expect(
				planLayoutToggle("toggle_code_block", [
					item(
						"a",
						{
							name: "<b>x</b>",
							plainName: "x",
							hasChildren: true,
						},
					),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "code-block",
							name: "x",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("splits quote runs at items with children or notes and keeps their names", () =>
		{
			expect(
				planLayoutToggle("toggle_quote_block", [
					item("a"),
					item("b"),
					item(
						"c",
						{
							hasNote: true,
						},
					),
					item("d"),
				]),
			).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "quote-block",
							name: "a\nb",
						},
						{
							id: "c",
							layoutMode: "quote-block",
						},
						{
							id: "d",
							layoutMode: "quote-block",
						},
					],
					deletes: ["b"],
					clearSelection: true,
				},
			);
		});

		it("toggles only the first item for a divider", () =>
		{
			expect(planLayoutToggle("toggle_divider", [item("a"), item("b")])).toStrictEqual(
				{
					updates: [
						{
							id: "a",
							layoutMode: "divider",
						},
					],
					deletes: [],
					clearSelection: false,
				},
			);
		});

		it("plans nothing for an empty selection", () =>
		{
			expect(planLayoutToggle("toggle_divider", [])).toStrictEqual(
				{
					updates: [],
					deletes: [],
					clearSelection: false,
				},
			);
		});
	});

	describe("normalizeLayoutMode", () =>
	{
		it("maps legacy aliases and passes null through", () =>
		{
			expect([
				normalizeLayoutMode("paragraph"),
				normalizeLayoutMode("quote"),
				normalizeLayoutMode("h1"),
				normalizeLayoutMode(null),
			]).toStrictEqual(["p", "quote-block", "h1", null]);
		});
	});

	describe("dividers drop their note", () =>
	{
		const noted = (overrides: Partial<LayoutToggleItem> = {}): LayoutToggleItem => (
		{
			id: "d",
			layoutMode: null,
			numberedStart: null,
			name: "x",
			plainName: "x",
			hasChildren: false,
			hasNote: true,
			...overrides,
		});

		it("clears the note when a row becomes a divider and leaves it alone otherwise", () =>
		{
			expect([
				planLayoutToggle("toggle_divider", [noted()]).updates,
				planLayoutToggle("toggle_divider", [
					noted(
						{
							hasNote: false,
						},
					),
				]).updates,
				planLayoutToggle("toggle_divider", [
					noted(
						{
							layoutMode: "divider",
						},
					),
				]).updates,
			]).toStrictEqual([
				[
					{
						id: "d",
						layoutMode: "divider",
						note: "",
					},
				],
				[
					{
						id: "d",
						layoutMode: "divider",
					},
				],
				[
					{
						id: "d",
						layoutMode: "bullets",
					},
				],
			]);
		});

		it("never opens the note editor on a divider", () =>
		{
			expect([canHaveNote("divider"), canHaveNote("h1"), canHaveNote(null)]).toStrictEqual([false, true, true]);
		});
	});

	describe("planBlockTypeChange", () =>
	{
		it("splits a multi-line code block into rows when it leaves for another type", () =>
		{
			expect(
				planBlockTypeChange(
					{
						id: "c",
						layoutMode: "code-block",
						plainName: "x\n  y\nz",
					},
					"bullets",
				),
			).toStrictEqual(
				{
					update:
					{
						id: "c",
						layoutMode: "bullets",
						name: "x",
					},
					creates: [
						{
							name: "  y",
							layoutMode: "bullets",
						},
						{
							name: "z",
							layoutMode: "bullets",
						},
					],
				},
			);
		});

		it("keeps every line between code and quote, and for a single line", () =>
		{
			expect([
				planBlockTypeChange(
					{
						id: "c",
						layoutMode: "code-block",
						plainName: "x\ny",
					},
					"quote-block",
				),
				planBlockTypeChange(
					{
						id: "c",
						layoutMode: "code-block",
						plainName: "x",
					},
					"h1",
				),
				planBlockTypeChange(
					{
						id: "c",
						layoutMode: null,
						plainName: "x\ny",
					},
					"h1",
				),
			]).toStrictEqual([
				{
					update:
					{
						id: "c",
						layoutMode: "quote-block",
					},
					creates: [],
				},
				{
					update:
					{
						id: "c",
						layoutMode: "h1",
					},
					creates: [],
				},
				{
					update:
					{
						id: "c",
						layoutMode: "h1",
					},
					creates: [],
				},
			]);
		});

		it("carries the split through a toggle plan with escaped text", () =>
		{
			const block =
			{
				id: "c",
				layoutMode: "quote-block",
				numberedStart: null,
				name: "a &lt; b\nc",
				plainName: "a < b\nc",
				hasChildren: false,
				hasNote: false,
			};
			expect(planLayoutToggle("toggle_h1", [block])).toStrictEqual(
				{
					updates: [
						{
							id: "c",
							layoutMode: "h1",
							name: "a &lt; b",
						},
					],
					deletes: [],
					clearSelection: false,
					creates: [
						{
							afterId: "c",
							name: "c",
							layoutMode: "h1",
						},
					],
				},
			);
		});
	});
});
