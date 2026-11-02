import {describe, expect, it} from "vite-plus/test";
import
{
	buildItemMenu,
	hasFooter,
	internalLinkUrl,
	itemMenuCommand,
	itemMenuLeft,
	localItemMenuAvailable,
} from "../src/client/item-menu-model.js";
import type {ItemMenuEntry} from "../src/client/item-menu-model.js";
import {qualifyItemMenu} from "../src/client/app-menu.js";

const plain =
{
	id: "alice",
	completedAt: null,
	isMirror: false,
};
const everything = (): boolean => true;

function tokens(entries: ItemMenuEntry[]): string
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

function menu(layoutMode: string | null, isMirror = false): string
{
	return tokens(
		buildItemMenu(
			{
				...plain,
				isMirror,
			},
			qualifyItemMenu(
				{
					data:
					{
						layoutMode,
					},
				},
			),
			localItemMenuAvailable,
		),
	);
}

describe("buildItemMenu with local availability", () =>
{
	it("lists the plain bullet menu in the engine's order with group separators", () =>
	{
		expect(menu(null)).toBe(
			"[node_type_picker] | open_in_pane complete add_note add_date present_it move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror_to mirror duplicate | show_export copy_link make_template | delete | expand_all collapse_all sort_children_asc sort_children_desc",
		);
	});

	it("shows the full upstream group order when everything is available", () =>
	{
		expect(
			tokens(
				buildItemMenu(
					plain,
					qualifyItemMenu(
						{
							data:
							{
								layoutMode: null,
							},
						},
					),
					everything,
				),
			),
		).toBe(
			"[node_type_picker] | open_in_pane complete add_note add_date present_it comment move_to move_to_today move_to_tomorrow move_to_next_week move_to_date upload_file mirror_to mirror duplicate | share show_export copy_link make_template | delete | expand_all collapse_all sort_children_asc sort_children_desc",
		);
	});

	it("narrows a table cell to upstream's cell menu, with Delete column on the header row", () =>
	{
		const cellMenu = (role: string) =>
			tokens(
				buildItemMenu(
					plain,
					qualifyItemMenu(
						{
							data:
							{
								layoutMode: null,
							},
						},
						[role],
					),
					localItemMenuAvailable,
				),
			);
		expect(
			{
				header: cellMenu("is_table_header_cell"),
				body: cellMenu("is_table_body_cell"),
			},
		).toStrictEqual(
			{
				header: "[node_type_picker] | complete add_note add_date duplicate_table_column | delete_table_column",
				body: "[node_type_picker] | complete add_note add_date duplicate_table_column | delete",
			},
		);
	});

	it("labels the column commands as upstream does", () =>
	{
		expect([
			itemMenuCommand("duplicate_table_column", plain, everything)?.label,
			itemMenuCommand("delete_table_column", plain, everything)?.label,
		]).toStrictEqual(["Duplicate column", "Delete column"]);
	});

	it("narrows a divider to its active set", () =>
	{
		expect(menu("divider")).toBe(
			"[node_type_picker] | move_to duplicate | copy_link | delete | expand_all collapse_all",
		);
	});

	it("drops add_date, present_it and make_template for code blocks", () =>
	{
		expect(menu("code-block")).toBe(
			"[node_type_picker] | open_in_pane complete add_note move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror_to mirror duplicate | show_export copy_link | delete | expand_all collapse_all sort_children_asc sort_children_desc",
		);
	});

	it("drops present_it and make_template for quote blocks", () =>
	{
		expect(menu("quote-block")).toBe(
			"[node_type_picker] | open_in_pane complete add_note add_date move_to move_to_today move_to_tomorrow move_to_next_week move_to_date mirror_to mirror duplicate | show_export copy_link | delete | expand_all collapse_all sort_children_asc sort_children_desc",
		);
	});

	it("reduces a dangling node to Delete", () =>
	{
		expect(
			tokens(
				buildItemMenu(
					plain,
					qualifyItemMenu(
						{
							isOriginalNotFound: true,
							data:
							{
								layoutMode: null,
							},
						},
					),
				),
			),
		).toBe("delete");
	});

	it("never lists delete_dates, even for a dated node", () =>
	{
		expect(menu(null)).not.toContain("delete_dates");
	});

	it("offers Detach Mirror only for a mirror root", () =>
	{
		const detach = (isMirror: boolean) =>
			tokens(
				buildItemMenu(
					{
						...plain,
						isMirror,
					},
					qualifyItemMenu(
						{
							data:
							{
								layoutMode: null,
							},
						},
					),
					everything,
				),
			).includes("detach_mirror");
		expect([detach(false), detach(true)]).toStrictEqual([false, true]);
	});
});

describe("itemMenuCommand", () =>
{
	it("labels complete as Uncomplete for a completed node", () =>
	{
		expect(
			itemMenuCommand(
				"complete",
				{
					completedAt: 1_700_000_000,
					isMirror: false,
				},
				everything,
			),
		).toStrictEqual(
			{
				key: "complete",
				label: "Uncomplete",
				icon: "check",
				shortcut: "⌘↵",
			},
		);
	});

	it("returns null for unknown or unavailable commands", () =>
	{
		expect([
			itemMenuCommand("ask_ai", plain, everything),
			itemMenuCommand("share", plain, () => false),
			itemMenuCommand("detach_mirror", plain, everything),
		]).toStrictEqual([null, null, null]);
	});

	it("uses the upstream shortcuts", () =>
	{
		const ids = [
			"complete",
			"add_note",
			"add_date",
			"present_it",
			"comment",
			"move_to",
			"mirror",
			"duplicate",
			"copy_link",
			"delete",
			"expand_all",
		];
		expect(
			Object.fromEntries(
				ids.map((id) => [
					id,
					itemMenuCommand(
						id,
						{
							...plain,
							isMirror: true,
						},
						everything,
					)?.shortcut ?? null,
				]),
			),
		).toStrictEqual(
			{
				complete: "⌘↵",
				add_note: "⇧↵",
				add_date: "!!",
				present_it: "⇧⌘P",
				comment: "⌃M",
				move_to: "⌃⌘M",
				mirror: "⇧⌘M",
				duplicate: "⇧⌘D",
				copy_link: "⇧⌘L",
				delete: "⇧⌘⌫",
				expand_all: null,
			},
		);
	});

	it("uses the upstream FA light icon names", () =>
	{
		const ids = [
			"open_in_pane",
			"complete",
			"add_note",
			"add_date",
			"present_it",
			"comment",
			"move_to",
			"move_to_today",
			"move_to_tomorrow",
			"move_to_next_week",
			"move_to_date",
			"upload_file",
			"mirror_to",
			"mirror",
			"detach_mirror",
			"duplicate",
			"share",
			"show_export",
			"copy_link",
			"make_template",
			"delete",
			"expand_all",
			"collapse_all",
			"sort_children_asc",
			"sort_children_desc",
		];
		expect(
			Object.fromEntries(
				ids.map((id) => [
					id,
					itemMenuCommand(
						id,
						{
							...plain,
							isMirror: true,
						},
						everything,
					)?.icon,
				]),
			),
		).toStrictEqual(
			{
				open_in_pane: "table-columns",
				complete: "check",
				add_note: "pencil",
				add_date: "calendar-days",
				present_it: "play",
				comment: "message-lines",
				move_to: "arrow-right-long",
				move_to_today: "calendar-day",
				move_to_tomorrow: "calendar-circle-plus",
				move_to_next_week: "calendar-week",
				move_to_date: "calendar-days",
				upload_file: "file",
				mirror_to: "diamond-turn-right",
				mirror: "diamond",
				detach_mirror: "xmark",
				duplicate: "copy",
				share: "user-group",
				show_export: "file-export",
				copy_link: "link",
				make_template: "puzzle-piece",
				delete: "trash-can",
				expand_all: "up-right-and-down-left-from-center",
				collapse_all: "down-left-and-up-right-to-center",
				sort_children_asc: "arrow-down-a-z",
				sort_children_desc: "arrow-down-z-a",
			},
		);
	});
});

describe("hasFooter", () =>
{
	it("shows the footer only when the node has a modified time", () =>
	{
		expect(
			hasFooter(
				{
					modifiedAt: null,
				},
			),
		).toBe(false);
		expect(
			hasFooter(
				{
					modifiedAt: 1_700_000_000,
				},
			),
		).toBe(true);
	});
});

describe("itemMenuLeft", () =>
{
	it("offsets the trigger by visible children and depth", () =>
	{
		expect([
			itemMenuLeft(false, 0),
			itemMenuLeft(false, 3),
			itemMenuLeft(true, 1),
			itemMenuLeft(true, 2),
		]).toStrictEqual([
			"calc(var(--name-left-overhang) - 23px)",
			"calc(var(--name-left-overhang) - 23px)",
			"calc(var(--name-left-overhang) - 46px)",
			"calc(var(--name-left-overhang) - 55px)",
		]);
	});
});

describe("internalLinkUrl", () =>
{
	it("links to the last 12 hex digits of the id", () =>
	{
		expect(internalLinkUrl("7aed376b-80c8-42c5-8065-ab03ee6d2ae0")).toBe("https://workflowy.com/#/ab03ee6d2ae0");
	});
});

describe("Detach Mirror in the bullet menu", () =>
{
	it("is listed between Mirror and Duplicate for a mirror and for an original that has mirrors, not for a plain row", () =>
	{
		const rows = (node: {isMirror: boolean; hasMirrors: boolean}) =>
			tokens(
				buildItemMenu(
					{
						...plain,
						...node,
					},
					qualifyItemMenu(
						{
							data:
							{
								layoutMode: null,
							},
						},
					),
					localItemMenuAvailable,
				),
			)
				.split(" | ")[1]
				?.split(" ")
				.filter((id) => ["mirror_to", "mirror", "detach_mirror", "duplicate"].includes(id));
		expect([
			rows(
				{
					isMirror: true,
					hasMirrors: false,
				},
			),
			rows(
				{
					isMirror: false,
					hasMirrors: true,
				},
			),
			rows(
				{
					isMirror: false,
					hasMirrors: false,
				},
			),
		]).toStrictEqual([
			["mirror_to", "mirror", "detach_mirror", "duplicate"],
			["mirror_to", "mirror", "detach_mirror", "duplicate"],
			["mirror_to", "mirror", "duplicate"],
		]);
	});
});
