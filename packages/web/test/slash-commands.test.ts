import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";
import {FA_ICONS} from "../src/client/components/fa-icons.js";
import type {SlashCommandKey} from "../src/client/slash-commands.js";
import {LOCAL_SLASH_AVAILABLE, SLASH_COMMANDS, SLASH_MENU_KEYS, resolveSlash} from "../src/client/slash-commands.js";

const HIDDEN_ON_PLAIN_ROW: ReadonlySet<string> = new Set([
	"toggle_ai_item",
	"delete_file",
	"ask_ai",
	"show_mirror_breadcrumbs",
	"detach_mirror",
	"swap_mirror_origin",
	"insert_board_column_left",
	"insert_board_column_right",
	"ai_item_summarize",
	"ai_item_find_tasks",
	"ai_item_draft_outline",
	"ai_item_fix_grammar",
	"ai_item_shorten",
	"set_priority_default_top",
	"toggle_good_dashboard",
	"show_treemap",
]);

const plainRow =
{
	available: (key: SlashCommandKey) => !HIDDEN_ON_PLAIN_ROW.has(key),
};

const PLAIN_ROW_LABELS = [
	"Bullets",
	"Board",
	"Table",
	"To-do",
	"Heading 1",
	"Heading 2",
	"Heading 3",
	"Paragraph",
	"Quote",
	"Code Block",
	"Divider",
	"Shortcut",
	"Upload file",
	"Number",
	"Complete",
	"Add date",
	"Add comment",
	"Add note",
	"Open in Pane",
	"Duplicate",
	"Move To...",
	"Move Here...",
	"Move To Child...",
	"Move to Today",
	"Move to Tomorrow",
	"Move to Next Week",
	"Move to Date...",
	"Share",
	"Export",
	"Mirror",
	"Mirror To...",
	"Mirror To Child...",
	"Mirror Here...",
	"Mirror to Today",
	"Mirror to Date...",
	"Expand all",
	"Collapse all",
	"Sort A-Z",
	"Sort Z-A",
	"Copy internal link",
	"Add from template",
	"Delete",
	"Count",
	"Priority: Default to Bottom",
	"Show Command Palette",
];

describe("SLASH_MENU_KEYS", () =>
{
	it("has the 61 upstream keys, 45 of which render on a plain row", () =>
	{
		expect(SLASH_MENU_KEYS).toHaveLength(61);
		expect(SLASH_MENU_KEYS.filter((key) => plainRow.available(key))).toHaveLength(45);
	});

	it("maps every rendered command to an icon in the shared FA map", () =>
	{
		const missing = Object.values(SLASH_COMMANDS)
			.map((command) => command.icon)
			.filter((icon) => !(icon in FA_ICONS));
		expect(missing).toStrictEqual([]);
	});
});

describe("resolveSlash", () =>
{
	it("lists the 45 plain-row commands in upstream order for a bare slash", () =>
	{
		const groups = resolveSlash(" /", plainRow);
		expect(groups?.map((group) => group.name)).toStrictEqual(["Actions"]);
		expect(groups?.[0]?.options.map((option) => option.label)).toStrictEqual(PLAIN_ROW_LABELS);
	});

	it("carries key and icon on each option", () =>
	{
		expect(resolveSlash("/h1", plainRow)).toStrictEqual([
			{
				name: "Actions",
				options: [
					{
						key: "toggle_h1",
						label: "Heading 1",
						icon: "fal:h1",
					},
				],
			},
		]);
	});

	it("filters fuzzily and ranks by score with a stable sort", () =>
	{
		expect(resolveSlash(" /mo", plainRow)?.[0]?.options.map((option) => option.label)).toStrictEqual([
			"Move To...",
			"Move Here...",
			"Move To Child...",
			"Move to Today",
			"Move to Tomorrow",
			"Move to Next Week",
			"Move to Date...",
			"Mirror",
			"Mirror To...",
			"Mirror To Child...",
			"Mirror Here...",
			"Mirror to Today",
			"Mirror to Date...",
		]);
		expect(resolveSlash(" /ex", plainRow)?.[0]?.options.map((option) => option.label)).toStrictEqual([
			"Export",
			"Expand all",
			"Move to Next Week",
		]);
	});

	it("drops unavailable commands", () =>
	{
		expect(
			resolveSlash(
				"/",
				{
					available: (key) => key === "complete" || key === "ask_ai",
				},
			),
		).toStrictEqual([
			{
				name: "Actions",
				options: [
					{
						key: "complete",
						label: "Complete",
						icon: "fal:check",
					},
				],
			},
		]);
	});

	it("returns null when the term starts with whitespace", () =>
	{
		expect(resolveSlash("/ x", plainRow)).toBeNull();
	});

	it("falls back to the math group", () =>
	{
		expect(
			resolveSlash(
				" /2*3",
				{
					...plainRow,
					evalMath: () => "6",
				},
			),
		).toStrictEqual([
			{
				name: "=",
				options: [
					{
						label: "6",
					},
				],
			},
		]);
		expect(
			resolveSlash(
				" /2*",
				{
					...plainRow,
					evalMath: () => "incomplete",
				},
			),
		).toStrictEqual([
			{
				name: "=",
				options: [
					{
						label: "...",
						noop: true,
					},
				],
			},
		]);
	});

	it("returns null when neither commands nor math match", () =>
	{
		expect(resolveSlash(" /moq", plainRow)).toBeNull();
		expect(
			resolveSlash(
				" /moq",
				{
					...plainRow,
					evalMath: () => null,
				},
			),
		).toBeNull();
	});
});

describe("LOCAL_SLASH_AVAILABLE", () =>
{
	it("offers only the commands with a local executor, in upstream order", () =>
	{
		expect(
			resolveSlash(
				" /",
				{
					available: LOCAL_SLASH_AVAILABLE,
				},
			)?.[0]?.options.map((o) => o.label),
		).toStrictEqual([
			"Bullets",
			"Board",
			"Table",
			"To-do",
			"Heading 1",
			"Heading 2",
			"Heading 3",
			"Paragraph",
			"Quote",
			"Code Block",
			"Divider",
			"Number",
			"Complete",
			"Add date",
			"Add note",
			"Open in Pane",
			"Duplicate",
			"Move To...",
			"Move to Today",
			"Move to Tomorrow",
			"Move to Next Week",
			"Move to Date...",
			"Export",
			"Mirror",
			"Mirror To...",
			"Mirror To Child...",
			"Mirror Here...",
			"Mirror to Today",
			"Mirror to Date...",
			"View mirrors",
			"Detach Mirror",
			"Expand all",
			"Collapse all",
			"Sort A-Z",
			"Sort Z-A",
			"Copy internal link",
			"Insert column left",
			"Insert column right",
			"Delete",
			"Show Command Palette",
		]);
	});

	it("carries key and icon for /palette", () =>
	{
		expect(
			resolveSlash(
				"/palette",
				{
					available: LOCAL_SLASH_AVAILABLE,
				},
			),
		).toStrictEqual([
			{
				name: "Actions",
				options: [
					{
						key: "show_command_palette",
						label: "Show Command Palette",
						icon: "fal:palette",
					},
				],
			},
		]);
	});

	it("matches Add date for /add d", () =>
	{
		expect(
			resolveSlash(
				" /add d",
				{
					available: LOCAL_SLASH_AVAILABLE,
				},
			)?.[0]?.options.map((o) => o.label),
		).toStrictEqual(["Add date"]);
	});

	it("has a command-registry executor for every locally available key, and the slash hook gates on it", () =>
	{
		const registry = readFileSync(new URL("../src/client/hooks/use-command-registry.ts", import.meta.url), "utf8");
		const hook = readFileSync(new URL("../src/client/hooks/use-slash-menu.tsx", import.meta.url), "utf8");
		expect(
			{
				missing: SLASH_MENU_KEYS.filter(
					(key) => LOCAL_SLASH_AVAILABLE(key) && !new RegExp(`^\\t\\t${key}:(?: |$)`, "mu").test(registry),
				),
				gated: hook.includes("LOCAL_SLASH_AVAILABLE(key)"),
			},
		).toStrictEqual(
			{
				missing: [],
				gated: true,
			},
		);
	});
});
