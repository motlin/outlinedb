import {describe, expect, it} from "vite-plus/test";
import {buildSelectionMenu} from "../src/client/selection-menu-model.js";
import type {SelectionMenuContext} from "../src/client/selection-menu-model.js";

const LOCAL = new Set([
	"toggle_h1",
	"toggle_h2",
	"toggle_h3",
	"toggle_paragraph",
	"toggle_code_block",
	"toggle_quote_block",
	"toggle_bullet",
	"toggle_numbered",
	"complete",
	"move_to",
	"show_export",
	"delete",
]);

function menu(overrides: Partial<SelectionMenuContext> = {})
{
	return buildSelectionMenu(
		{
			available: () => true,
			allCompleted: false,
			firstEmbedded: false,
			qualifiers: new Set(),
			...overrides,
		},
	).map((entry) => (entry.kind === "separator" ? "sep" : entry.id));
}

describe("buildSelectionMenu", () =>
{
	it("lists all 26 commands in upstream order with a separator between each pair of groups", () =>
	{
		expect(menu()).toStrictEqual([
			"toggle_h1",
			"toggle_h2",
			"toggle_h3",
			"toggle_paragraph",
			"toggle_code_block",
			"toggle_quote_block",
			"toggle_bullet",
			"toggle_todo_mode",
			"toggle_numbered",
			"sep",
			"toggle_bold",
			"toggle_italic",
			"toggle_underline",
			"toggle_strikethrough",
			"toggle_code",
			"show_color_popup",
			"sep",
			"complete",
			"move_to",
			"move_to_today",
			"move_to_tomorrow",
			"move_to_next_week",
			"move_to_date",
			"mirror",
			"mirror_to",
			"mirror_to_today",
			"mirror_to_date",
			"show_export",
			"sep",
			"delete",
		]);
	});

	it("shows only the registered commands, with one separator where a group is empty", () =>
	{
		expect(
			menu(
				{
					available: (id) => LOCAL.has(id),
				},
			),
		).toStrictEqual([
			"toggle_h1",
			"toggle_h2",
			"toggle_h3",
			"toggle_paragraph",
			"toggle_code_block",
			"toggle_quote_block",
			"toggle_bullet",
			"toggle_numbered",
			"sep",
			"complete",
			"move_to",
			"show_export",
			"sep",
			"delete",
		]);
	});

	it("shows only the table-cell rows for has_table_cell", () =>
	{
		expect(
			menu(
				{
					qualifiers: new Set(["has_table_cell"]),
				},
			),
		).toStrictEqual([
			"toggle_bullet",
			"toggle_todo_mode",
			"sep",
			"toggle_bold",
			"toggle_italic",
			"toggle_underline",
			"toggle_strikethrough",
			"sep",
			"complete",
			"move_to",
			"mirror",
			"mirror_to",
			"show_export",
			"sep",
			"delete",
		]);
	});

	it("drops the move and mirror rows for has_pane_item", () =>
	{
		const ids = menu(
			{
				qualifiers: new Set(["has_pane_item"]),
			},
		);
		expect(ids.filter((id) => id.startsWith("move_to") || id.startsWith("mirror"))).toStrictEqual([]);
	});

	it("is empty for the comment-paragraph and calendar-search qualifiers", () =>
	{
		expect([
			menu(
				{
					qualifiers: new Set(["all_comment_paragraphs"]),
				},
			),
			menu(
				{
					qualifiers: new Set(["has_calendar_search_container"]),
				},
			),
		]).toStrictEqual([[], []]);
	});

	it("reads Uncomplete and Remove, and carries icons and shortcut sources", () =>
	{
		const entries = buildSelectionMenu(
			{
				available: (id) => ["toggle_todo_mode", "complete", "move_to_today", "delete"].includes(id),
				allCompleted: true,
				firstEmbedded: true,
				qualifiers: new Set(),
			},
		);
		expect(entries).toStrictEqual([
			{
				kind: "command",
				id: "toggle_todo_mode",
				label: "To-do",
				icon: "fal:list-check",
				shortcutCommand: "toggle_todo",
			},
			{
				kind: "separator",
			},
			{
				kind: "command",
				id: "complete",
				label: "Uncomplete",
				icon: "fal:check",
				shortcutCommand: "complete",
			},
			{
				kind: "command",
				id: "move_to_today",
				label: "Move to Today",
				icon: "fal:calendar-day",
				shortcutCommand: null,
			},
			{
				kind: "separator",
			},
			{
				kind: "command",
				id: "delete",
				label: "Remove",
				icon: "fal:trash-can",
				shortcutCommand: "delete",
			},
		]);
	});
});
