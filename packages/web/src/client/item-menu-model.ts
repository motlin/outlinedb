/**
 * Pure model of the bullet (item) context menu, matching upstream Workflowy's
 * `single_node_menu`. Rows, order, separators and per-layout filtering come from the config
 * engine (`app-menu.ts`); this module supplies the command table and local availability.
 */
import type {NodeResponse} from "../node-types.js";
import type {FaIconKey} from "./components/fa-icons.js";
import {assembleMenu} from "./app-menu.js";
import type {AssembledEntry} from "./app-menu.js";
import {APP_MENU_CONFIG} from "./app-menu-config.js";
import {pickerItemTypes} from "./item-type-select.js";
import {isMirrorRoot} from "./components/row-classes.js";

const NODE_TYPE_PICKER = "node_type_picker";

/** A light (`fal:`) FontAwesome icon name from the shared registry. */
export type ItemMenuIcon = FaIconKey extends infer K ? (K extends `fal:${infer N}` ? N : never) : never;

export type ItemMenuKey =
	| "open_in_pane"
	| "complete"
	| "add_note"
	| "add_date"
	| "present_it"
	| "comment"
	| "move_to"
	| "move_to_today"
	| "move_to_tomorrow"
	| "move_to_next_week"
	| "move_to_date"
	| "upload_file"
	| "mirror_to"
	| "mirror"
	| "detach_mirror"
	| "duplicate"
	| "duplicate_table_column"
	| "delete_table_column"
	| "share"
	| "show_export"
	| "copy_link"
	| "make_template"
	| "delete"
	| "expand_all"
	| "collapse_all"
	| "sort_children_asc"
	| "sort_children_desc";

interface ItemMenuDef
{
	label: string;
	icon: ItemMenuIcon;
	shortcut?: string;
}

const ITEM_MENU_DEFS: Record<ItemMenuKey, ItemMenuDef> =
{
	open_in_pane:
	{
		label: "Open in Pane",
		icon: "table-columns",
	},
	complete:
	{
		label: "Complete",
		icon: "check",
		shortcut: "⌘↵",
	},
	add_note:
	{
		label: "Add note",
		icon: "pencil",
		shortcut: "⇧↵",
	},
	add_date:
	{
		label: "Add date",
		icon: "calendar-days",
		shortcut: "!!",
	},
	present_it:
	{
		label: "Present",
		icon: "play",
		shortcut: "⇧⌘P",
	},
	comment:
	{
		label: "Add comment",
		icon: "message-lines",
		shortcut: "⌃M",
	},
	move_to:
	{
		label: "Move To...",
		icon: "arrow-right-long",
		shortcut: "⌃⌘M",
	},
	move_to_today:
	{
		label: "Move to Today",
		icon: "calendar-day",
	},
	move_to_tomorrow:
	{
		label: "Move to Tomorrow",
		icon: "calendar-circle-plus",
	},
	move_to_next_week:
	{
		label: "Move to Next Week",
		icon: "calendar-week",
	},
	move_to_date:
	{
		label: "Move to Date...",
		icon: "calendar-days",
	},
	upload_file:
	{
		label: "Upload file",
		icon: "file",
	},
	mirror_to:
	{
		label: "Mirror To...",
		icon: "diamond-turn-right",
	},
	mirror:
	{
		label: "Mirror",
		icon: "diamond",
		shortcut: "⇧⌘M",
	},
	detach_mirror:
	{
		label: "Detach Mirror",
		icon: "xmark",
	},
	duplicate:
	{
		label: "Duplicate",
		icon: "copy",
		shortcut: "⇧⌘D",
	},
	duplicate_table_column:
	{
		label: "Duplicate column",
		icon: "copy",
		shortcut: "⇧⌘D",
	},
	delete_table_column:
	{
		label: "Delete column",
		icon: "trash-can",
		shortcut: "⇧⌘⌫",
	},
	share:
	{
		label: "Share",
		icon: "user-group",
	},
	show_export:
	{
		label: "Export",
		icon: "file-export",
	},
	copy_link:
	{
		label: "Copy internal link",
		icon: "link",
		shortcut: "⇧⌘L",
	},
	make_template:
	{
		label: "Make template",
		icon: "puzzle-piece",
	},
	delete:
	{
		label: "Delete",
		icon: "trash-can",
		shortcut: "⇧⌘⌫",
	},
	expand_all:
	{
		label: "Expand all",
		icon: "up-right-and-down-left-from-center",
	},
	collapse_all:
	{
		label: "Collapse all",
		icon: "down-left-and-up-right-to-center",
	},
	sort_children_asc:
	{
		label: "Sort A-Z",
		icon: "arrow-down-a-z",
	},
	sort_children_desc:
	{
		label: "Sort Z-A",
		icon: "arrow-down-z-a",
	},
};

/** What the bullet menu shows for one command row. */
export interface ItemMenuCommand
{
	key: ItemMenuKey | typeof NODE_TYPE_PICKER;
	label: string;
	icon: ItemMenuIcon;
	shortcut?: string;
}

export type ItemMenuEntry = AssembledEntry<ItemMenuCommand>;

export type ItemMenuNode = Pick<NodeResponse, "id" | "completedAt" | "isMirror" | "hasMirrors">;

/** Commands the local app runs; the menu hides the rest. `delete_dates` stays palette-only, like upstream. */
const LOCAL_ITEM_MENU_KEYS: ReadonlySet<string> = new Set([
	"open_in_pane",
	"complete",
	"add_note",
	"add_date",
	"present_it",
	"move_to",
	"move_to_today",
	"move_to_tomorrow",
	"move_to_next_week",
	"move_to_date",
	"mirror_to",
	"mirror",
	"detach_mirror",
	"duplicate",
	"duplicate_table_column",
	"delete_table_column",
	"show_export",
	"copy_link",
	"make_template",
	"delete",
	"expand_all",
	"collapse_all",
	"sort_children_asc",
	"sort_children_desc",
]);

export function localItemMenuAvailable(key: string): boolean
{
	return LOCAL_ITEM_MENU_KEYS.has(key);
}

function isItemMenuKey(id: string): id is ItemMenuKey
{
	return Object.hasOwn(ITEM_MENU_DEFS, id);
}

/** Upstream's `WF.Cmd.get` for the bullet menu: null when the command is unknown, unavailable, or not for this node. */
export function itemMenuCommand(
	id: string,
	node: Pick<NodeResponse, "completedAt" | "isMirror" | "hasMirrors">,
	available: (key: string) => boolean,
): ItemMenuCommand | null
{
	if (!isItemMenuKey(id) || !available(id) || (id === "detach_mirror" && !isMirrorRoot(node)))
	{
		return null;
	}
	const key = id;
	const {label, icon, shortcut} = ITEM_MENU_DEFS[key];
	const finalLabel = key === "complete" && node.completedAt !== null ? "Uncomplete" : label;
	return shortcut === undefined
		?
			{
				key,
				label: finalLabel,
				icon,
			}
		:
			{
				key,
				label: finalLabel,
				icon,
				shortcut,
			};
}

/** The bullet menu's rows: `single_node_menu` assembled by the config engine for the node's qualifiers. */
export function buildItemMenu(
	node: ItemMenuNode,
	qualifiers: readonly string[],
	available: (key: string) => boolean = localItemMenuAvailable,
): ItemMenuEntry[]
{
	return assembleMenu(
		"single_node_menu",
		qualifiers,
		(id): ItemMenuCommand | null =>
			id === NODE_TYPE_PICKER
				? pickerItemTypes([node.id]).length > 0
					?
						{
							key: NODE_TYPE_PICKER,
							label: "Turn into...",
							icon: "list-ul",
						}
					: null
				: itemMenuCommand(id, node, available),
		APP_MENU_CONFIG,
	);
}

/** A node's workflowy.com URL (upstream's internal link), keyed by the last 12 hex digits of its id. */
export function internalLinkUrl(nodeId: string): string
{
	return `https://workflowy.com/#/${nodeId.replaceAll("-", "").slice(-12)}`;
}

export function hasFooter(node: Pick<NodeResponse, "modifiedAt">): boolean
{
	return node.modifiedAt !== null;
}

/** Upstream's `--item-menu-left`: where the bullet-menu trigger sits, left of the expand arrow. */
export function itemMenuLeft(hasVisibleChildren: boolean, visualDepth: number): string
{
	if (!hasVisibleChildren)
	{
		return "calc(var(--name-left-overhang) - 23px)";
	}
	return visualDepth > 1 ? "calc(var(--name-left-overhang) - 55px)" : "calc(var(--name-left-overhang) - 46px)";
}
