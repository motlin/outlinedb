import {describe, expect, it} from "vite-plus/test";
import {assembleFlatForId, assembleMenu, qualifyItemMenu, qualifyMultiSelect} from "../src/client/app-menu.js";
import type {AssembledEntry, MenuConfig} from "../src/client/app-menu.js";
import fixture from "./fixtures/upstream-menu-config.json" with {type: "json"};

function fromDump(dump: typeof fixture): MenuConfig
{
	return {
		orderedUi: Object.fromEntries(
			Object.entries(dump.ordered_ui).map(([menu, keys]) => [
				menu,
				keys.map((key): [string, boolean] =>
				{
					const [id = "", flag] = key.split(":");
					return [id, flag !== "false"];
				}),
			]),
		),
		isSubmenu: new Set(Object.keys(dump.is_submenu)),
		activeSets: Object.fromEntries(
			Object.entries(dump.menu_active_set).map(([key, set]) => [key, Object.keys(set)]),
		),
		blockSets: Object.fromEntries(Object.entries(dump.menu_block_set).map(([key, set]) => [key, Object.keys(set)])),
		labels: dump.ui_label,
		icons: dump.icon,
	};
}

const config: MenuConfig =
{
	...fromDump(fixture),
};
const probeConfig: MenuConfig =
{
	...config,
	activeSets:
	{
		...config.activeSets,
		"single_node_menu :: probe_q": ["delete", "delete_dates", "expand_all", "node_type_picker"],
		"single_node_menu :: empty_q": [],
	},
};

const UNAVAILABLE = new Set([
	"ask_ai",
	"mark_read",
	"mark_unread",
	"take_photo",
	"upload_image",
	"detach_mirror",
	"mcp_agents",
	"toggle_todo_mode",
]);
const lookup = (id: string): string | null => (UNAVAILABLE.has(id) ? null : id);

function tokens(entries: AssembledEntry<string>[]): string
{
	return entries
		.map((entry) =>
		{
			if (entry.kind === "separator")
			{
				return "|";
			}
			return entry.kind === "submenu" ? `[${entry.id}]` : entry.id;
		})
		.join(" ")
		.replaceAll(/ ?\| ?/gu, " | ")
		.trim();
}

function single(qualifiers: string[], cfg: MenuConfig = probeConfig): string
{
	return tokens(assembleMenu("single_node_menu", qualifiers, lookup, cfg));
}

describe("assembleMenu single_node_menu", () =>
{
	it("lists the full menu in config order with one separator between groups", () =>
	{
		expect(single([])).toBe(
			"[node_type_picker] | open_in_pane complete add_note add_date present_it comment move_to move_to_today move_to_tomorrow move_to_next_week move_to_date upload_file mirror_to mirror duplicate | share show_export copy_link make_template | delete | expand_all collapse_all sort_children_asc sort_children_desc",
		);
	});

	it("shows only the active set for a divider", () =>
	{
		expect(single(["is_divider"])).toBe(
			"[node_type_picker] | move_to duplicate | copy_link | delete | expand_all collapse_all",
		);
	});

	it("removes blocked ids for code blocks", () =>
	{
		expect(single(["is_code_block"])).toBe(
			"[node_type_picker] | open_in_pane complete add_note comment move_to move_to_today move_to_tomorrow move_to_next_week move_to_date upload_file mirror_to mirror duplicate | share show_export copy_link | delete | expand_all collapse_all sort_children_asc sort_children_desc",
		);
	});

	it("shows only Delete for dangling nodes, whatever else applies", () =>
	{
		expect([single(["is_dangling"]), single(["is_divider", "is_dangling"])]).toStrictEqual(["delete", "delete"]);
	});

	it("intersects the active sets of several qualifiers", () =>
	{
		expect(single(["is_ai_item", "is_divider"])).toBe("[node_type_picker] | move_to duplicate | delete");
	});

	it("unions block sets with active sets", () =>
	{
		expect(single(["is_divider", "is_readonly"])).toBe(
			"move_to duplicate | copy_link | delete | expand_all collapse_all",
		);
	});

	it("lets an active set override a base false flag", () =>
	{
		expect(single(["is_table_header_cell"])).toBe(
			"[node_type_picker] | complete add_note add_date upload_file duplicate_table_column | delete_table_column",
		);
	});

	it("shows the comment menu", () =>
	{
		expect(single(["is_bullets", "is_comment", "is_comment_not_draft"])).toBe(
			"focus_name add_note mirror_to mirror | share show_export copy_link | delete",
		);
	});

	it("appends active ids missing from the config walk after one separator", () =>
	{
		expect(single(["probe_q"])).toBe("[node_type_picker] | delete | expand_all | delete_dates");
	});

	it("yields nothing for an empty active set and an unknown menu", () =>
	{
		expect([single(["empty_q"]), tokens(assembleMenu("nope", [], lookup, config))]).toStrictEqual(["", ""]);
	});

	it("ignores qualifiers with no table entry", () =>
	{
		expect(single(["is_bullets"])).toBe(single([]));
	});
});

describe("assembleMenu multi_select_menu", () =>
{
	const multi = (qualifiers: string[]): string =>
		tokens(assembleMenu("multi_select_menu", qualifiers, lookup, config));

	it("separates the four groups", () =>
	{
		expect(multi([])).toBe(
			"toggle_h1 toggle_h2 toggle_h3 toggle_paragraph toggle_code_block toggle_quote_block toggle_bullet toggle_numbered | toggle_bold toggle_italic toggle_underline toggle_strikethrough toggle_code show_color_popup | complete move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror mirror_to mirror_to_today mirror_to_date show_export | delete",
		);
	});

	it("drops move and mirror commands when an item is in a pane", () =>
	{
		expect(multi(["has_pane_item"])).toBe(
			"toggle_h1 toggle_h2 toggle_h3 toggle_paragraph toggle_code_block toggle_quote_block toggle_bullet toggle_numbered | toggle_bold toggle_italic toggle_underline toggle_strikethrough toggle_code show_color_popup | complete show_export | delete",
		);
	});

	it("restricts the menu for table cells", () =>
	{
		expect(multi(["has_table_cell"])).toBe(
			"toggle_bullet | toggle_bold toggle_italic toggle_underline toggle_strikethrough | complete move_to mirror mirror_to show_export | delete",
		);
	});

	it("hides the whole menu for comment paragraphs", () =>
	{
		expect(multi(["all_comment_paragraphs"])).toBe("");
	});
});

describe("assembleFlatForId", () =>
{
	it("returns nothing for a menu made of groups", () =>
	{
		expect(assembleFlatForId("single_node_menu", [], lookup, config)).toStrictEqual([]);
	});

	it("applies block sets only", () =>
	{
		const flat = (qualifiers: string[]) =>
			assembleFlatForId("node_type_picker", qualifiers, lookup, config).map((entry) =>
				entry.kind === "command" ? entry.id : "?",
			);
		expect([
			flat([]).includes("turn_into_dashboard"),
			flat(["is_inside_side_pane"]).includes("turn_into_dashboard"),
		]).toStrictEqual([true, false]);
		expect(flat(["is_divider"])).toStrictEqual(flat([]));
	});
});

describe("qualifyItemMenu", () =>
{
	it("derives the layout qualifier", () =>
	{
		expect([
			qualifyItemMenu(
				{
					data:
					{
						layoutMode: null,
					},
				},
			),
			qualifyItemMenu(
				{
					data:
					{
						layoutMode: "quote-block",
					},
				},
			),
			qualifyItemMenu(
				{
					data:
					{
						layoutMode: "code-block",
					},
				},
			),
		]).toStrictEqual([["is_bullets"], ["is_quote_block"], ["is_code_block"]]);
	});

	it("returns only is_dangling when the original is missing", () =>
	{
		expect(
			qualifyItemMenu(
				{
					isOriginalNotFound: true,
					data:
					{
						layoutMode: "divider",
					},
				},
				["is_comment"],
			),
		).toStrictEqual(["is_dangling"]);
	});

	it("adds is_readonly except on the main document root", () =>
	{
		expect([
			qualifyItemMenu(
				{
					readOnly: true,
					data:
					{
						layoutMode: null,
					},
				},
			),
			qualifyItemMenu(
				{
					readOnly: true,
					isMainDocumentRoot: true,
					data:
					{
						layoutMode: null,
					},
				},
			),
		]).toStrictEqual([["is_bullets", "is_readonly"], ["is_bullets"]]);
	});

	it("adds is_comment_not_draft for comments that are not drafts", () =>
	{
		expect([
			qualifyItemMenu(
				{
					data:
					{
						layoutMode: null,
					},
				},
				["is_comment"],
			),
			qualifyItemMenu(
				{
					data:
					{
						layoutMode: null,
					},
				},
				["is_comment", "is_draft"],
			),
		]).toStrictEqual([
			["is_comment", "is_bullets", "is_comment_not_draft"],
			["is_comment", "is_draft", "is_bullets"],
		]);
	});
});

describe("qualifyMultiSelect", () =>
{
	const flags =
	{
		inSidePane: (id: string) => id === "pane",
		isTableCell: (id: string) => id === "cell",
	};

	it("flags pane items and table cells", () =>
	{
		expect([
			qualifyMultiSelect(["a", "b"], flags),
			qualifyMultiSelect(["a", "pane"], flags),
			qualifyMultiSelect(["cell", "pane"], flags),
		]).toStrictEqual([[], ["has_pane_item"], ["has_pane_item", "has_table_cell"]]);
	});
});
