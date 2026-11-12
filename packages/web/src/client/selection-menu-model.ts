import {assembleMenu} from "./app-menu.js";
import {APP_MENU_CONFIG} from "./app-menu-config.js";
import type {FaIconKey} from "./components/fa-icons.js";

interface SelectionMenuDef
{
	label: string;
	icon: FaIconKey;
	/** The command whose hotkey chip the row shows; defaults to the row's own id. */
	shortcutCommand?: string;
	/** Rows with no hotkey chip. */
	noShortcut?: true;
}

/** Labels, light icons and shortcut sources of upstream's 27 `multi_select_menu` commands. */
const SELECTION_MENU_DEFS: Readonly<Record<string, SelectionMenuDef>> =
{
	toggle_h1:
	{
		label: "Heading 1",
		icon: "fal:h1",
	},
	toggle_h2:
	{
		label: "Heading 2",
		icon: "fal:h2",
	},
	toggle_h3:
	{
		label: "Heading 3",
		icon: "fal:h3",
	},
	toggle_paragraph:
	{
		label: "Paragraph",
		icon: "fal:paragraph",
	},
	toggle_code_block:
	{
		label: "Code Block",
		icon: "fal:rectangle-code",
	},
	toggle_quote_block:
	{
		label: "Quote",
		icon: "fal:block-quote",
	},
	toggle_bullet:
	{
		label: "Bullets",
		icon: "fal:list-ul",
	},
	toggle_todo_mode:
	{
		label: "To-do",
		icon: "fal:list-check",
		shortcutCommand: "toggle_todo",
	},
	toggle_numbered:
	{
		label: "Number",
		icon: "fal:list-ol",
	},
	toggle_bold:
	{
		label: "Bold",
		icon: "fal:bold",
	},
	toggle_italic:
	{
		label: "Italic",
		icon: "fal:italic",
	},
	toggle_underline:
	{
		label: "Underline",
		icon: "fal:underline",
	},
	toggle_strikethrough:
	{
		label: "Strikethrough",
		icon: "fal:strikethrough",
	},
	toggle_code:
	{
		label: "Code",
		icon: "fal:code",
	},
	show_color_popup:
	{
		label: "Text/Highlight Color",
		icon: "fal:font",
		noShortcut: true,
	},
	complete:
	{
		label: "Complete",
		icon: "fal:check",
	},
	move_to:
	{
		label: "Move To...",
		icon: "fal:arrow-right-long",
	},
	move_to_today:
	{
		label: "Move to Today",
		icon: "fal:calendar-day",
		noShortcut: true,
	},
	move_to_tomorrow:
	{
		label: "Move to Tomorrow",
		icon: "fal:calendar-circle-plus",
		noShortcut: true,
	},
	move_to_next_week:
	{
		label: "Move to Next Week",
		icon: "fal:calendar-week",
		noShortcut: true,
	},
	move_to_date:
	{
		label: "Move to Date...",
		icon: "fal:calendar-days",
		noShortcut: true,
	},
	mirror:
	{
		label: "Mirror",
		icon: "fal:diamond",
	},
	mirror_to:
	{
		label: "Mirror To...",
		icon: "fal:diamond-turn-right",
		noShortcut: true,
	},
	mirror_to_today:
	{
		label: "Mirror to Today",
		icon: "fal:diamond-turn-right",
		noShortcut: true,
	},
	mirror_to_date:
	{
		label: "Mirror to Date...",
		icon: "fal:diamond-turn-right",
		noShortcut: true,
	},
	show_export:
	{
		label: "Export",
		icon: "fal:file-export",
		noShortcut: true,
	},
	delete:
	{
		label: "Delete",
		icon: "fal:trash-can",
	},
};

export interface SelectionMenuContext
{
	available: (id: string) => boolean;
	/** Every selected item is completed: Complete reads "Uncomplete". */
	allCompleted: boolean;
	/** The first selected item is embedded: Delete reads "Remove". */
	firstEmbedded: boolean;
	/** `has_table_cell`, `has_pane_item`, `all_comment_paragraphs`, `has_calendar_search_container`. */
	qualifiers: ReadonlySet<string>;
}

export type SelectionMenuEntry =
	|
	  {
			kind: "command";
			id: string;
			label: string;
			icon: FaIconKey;
			shortcutCommand: string | null;
	  }
	|
	  {
			kind: "separator";
	  };

/** Upstream `WF.AppMenu.assemble("multi_select_menu", ...)` over the shared menu config. */
export function buildSelectionMenu(ctx: SelectionMenuContext): SelectionMenuEntry[]
{
	const entries = assembleMenu(
		"multi_select_menu",
		ctx.qualifiers,
		(id) => (SELECTION_MENU_DEFS[id] !== undefined && ctx.available(id) ? id : null),
		APP_MENU_CONFIG,
	);
	return entries.flatMap((entry): SelectionMenuEntry[] =>
	{
		if (entry.kind !== "command")
		{
			return entry.kind === "separator"
				? [
						{
							kind: "separator",
						},
					]
				: [];
		}
		const def = SELECTION_MENU_DEFS[entry.id];
		if (def === undefined)
		{
			return [];
		}
		let {label} = def;
		if (entry.id === "complete" && ctx.allCompleted)
		{
			label = "Uncomplete";
		}
		if (entry.id === "delete" && ctx.firstEmbedded)
		{
			label = "Remove";
		}
		return [
			{
				kind: "command",
				id: entry.id,
				label,
				icon: def.icon,
				shortcutCommand: def.noShortcut === true ? null : (def.shortcutCommand ?? entry.id),
			},
		];
	});
}
