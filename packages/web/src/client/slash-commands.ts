// Slash-menu command catalog (upstream config.slash.menu) and the pure resolver behind the "/" chip.
import type {FaIconKey} from "./components/fa-icons.js";
import {fuzzyMatch, fuzzyScore} from "./std-fuzzy.js";

/** The keys of upstream `config.slash.menu.first()`, in menu order. */
export const SLASH_MENU_KEYS = [
	"toggle_bullet",
	"toggle_board",
	"toggle_table",
	"toggle_todo",
	"toggle_h1",
	"toggle_h2",
	"toggle_h3",
	"toggle_paragraph",
	"toggle_quote_block",
	"toggle_code_block",
	"toggle_divider",
	"toggle_ai_item",
	"assign_shortcut",
	"upload_file",
	"delete_file",
	"toggle_numbered",
	"complete",
	"ask_ai",
	"add_date",
	"comment",
	"add_note",
	"open_in_pane",
	"duplicate",
	"move_to",
	"move_here",
	"move_to_child",
	"move_to_today",
	"move_to_tomorrow",
	"move_to_next_week",
	"move_to_date",
	"share",
	"show_export",
	"mirror",
	"mirror_to",
	"mirror_to_child",
	"mirror_here",
	"mirror_to_today",
	"mirror_to_date",
	"show_mirror_breadcrumbs",
	"detach_mirror",
	"swap_mirror_origin",
	"expand_all",
	"collapse_all",
	"sort_children_asc",
	"sort_children_desc",
	"copy_link",
	"add_from_template",
	"insert_board_column_left",
	"insert_board_column_right",
	"delete",
	"count",
	"ai_item_summarize",
	"ai_item_find_tasks",
	"ai_item_draft_outline",
	"ai_item_fix_grammar",
	"ai_item_shorten",
	"set_priority_default_top",
	"set_priority_default_bottom",
	"toggle_good_dashboard",
	"show_treemap",
	"show_command_palette",
] as const;

export type SlashCommandKey = (typeof SLASH_MENU_KEYS)[number];

export interface SlashCommand
{
	label: string;
	icon: FaIconKey;
}

/** Label and rendered FA light icon for every command upstream renders on a plain row. */
export const SLASH_COMMANDS: Partial<Record<SlashCommandKey, SlashCommand>> =
{
	toggle_bullet:
	{
		label: "Bullets",
		icon: "fal:list-ul",
	},
	toggle_board:
	{
		label: "Board",
		icon: "fal:table-columns",
	},
	toggle_table:
	{
		label: "Table",
		icon: "fal:table-cells",
	},
	toggle_todo:
	{
		label: "To-do",
		icon: "fal:list-check",
	},
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
	toggle_quote_block:
	{
		label: "Quote",
		icon: "fal:block-quote",
	},
	toggle_code_block:
	{
		label: "Code Block",
		icon: "fal:rectangle-code",
	},
	toggle_divider:
	{
		label: "Divider",
		icon: "fal:horizontal-rule",
	},
	assign_shortcut:
	{
		label: "Shortcut",
		icon: "fal:bolt",
	},
	upload_file:
	{
		label: "Upload file",
		icon: "fal:file",
	},
	toggle_numbered:
	{
		label: "Number",
		icon: "fal:list-ol",
	},
	complete:
	{
		label: "Complete",
		icon: "fal:check",
	},
	add_date:
	{
		label: "Add date",
		icon: "fal:calendar-days",
	},
	comment:
	{
		label: "Add comment",
		icon: "fal:message-lines",
	},
	add_note:
	{
		label: "Add note",
		icon: "fal:pencil",
	},
	open_in_pane:
	{
		label: "Open in Pane",
		icon: "fal:table-columns",
	},
	duplicate:
	{
		label: "Duplicate",
		icon: "fal:copy",
	},
	move_to:
	{
		label: "Move To...",
		icon: "fal:arrow-right-long",
	},
	move_here:
	{
		label: "Move Here...",
		icon: "fal:arrow-down-long",
	},
	move_to_child:
	{
		label: "Move To Child...",
		icon: "fal:arrow-right-long",
	},
	move_to_today:
	{
		label: "Move to Today",
		icon: "fal:calendar-day",
	},
	move_to_tomorrow:
	{
		label: "Move to Tomorrow",
		icon: "fal:calendar-circle-plus",
	},
	move_to_next_week:
	{
		label: "Move to Next Week",
		icon: "fal:calendar-week",
	},
	move_to_date:
	{
		label: "Move to Date...",
		icon: "fal:calendar-days",
	},
	share:
	{
		label: "Share",
		icon: "fal:user-group",
	},
	show_export:
	{
		label: "Export",
		icon: "fal:file-export",
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
	},
	mirror_to_child:
	{
		label: "Mirror To Child...",
		icon: "fal:diamond-turn-right",
	},
	mirror_here:
	{
		label: "Mirror Here...",
		icon: "fal:diamond-turn-right",
	},
	mirror_to_today:
	{
		label: "Mirror to Today",
		icon: "fal:diamond-turn-right",
	},
	mirror_to_date:
	{
		label: "Mirror to Date...",
		icon: "fal:diamond-turn-right",
	},
	// Upstream draws `diamond-half-stroke`, which the local FontAwesome subset lacks.
	show_mirror_breadcrumbs:
	{
		label: "View mirrors",
		icon: "fal:diamond",
	},
	detach_mirror:
	{
		label: "Detach Mirror",
		icon: "fal:xmark",
	},
	expand_all:
	{
		label: "Expand all",
		icon: "fal:up-right-and-down-left-from-center",
	},
	collapse_all:
	{
		label: "Collapse all",
		icon: "fal:down-left-and-up-right-to-center",
	},
	sort_children_asc:
	{
		label: "Sort A-Z",
		icon: "fal:arrow-down-a-z",
	},
	sort_children_desc:
	{
		label: "Sort Z-A",
		icon: "fal:arrow-down-z-a",
	},
	copy_link:
	{
		label: "Copy internal link",
		icon: "fal:link",
	},
	add_from_template:
	{
		label: "Add from template",
		icon: "fal:puzzle-piece",
	},
	insert_board_column_left:
	{
		label: "Insert column left",
		icon: "fal:table-columns",
	},
	insert_board_column_right:
	{
		label: "Insert column right",
		icon: "fal:table-columns",
	},
	delete:
	{
		label: "Delete",
		icon: "fal:trash-can",
	},
	count:
	{
		label: "Count",
		icon: "fal:abacus",
	},
	set_priority_default_bottom:
	{
		label: "Priority: Default to Bottom",
		icon: "fal:arrow-down",
	},
	show_command_palette:
	{
		label: "Show Command Palette",
		icon: "fal:palette",
	},
};

export interface SlashCommandOption extends SlashCommand
{
	key: SlashCommandKey;
}

export interface SlashMathOption
{
	label: string;
	noop?: true;
}

export type SlashGroup =
	|
	  {
			name: "Actions";
			options: SlashCommandOption[];
	  }
	|
	  {
			name: "=";
			options: SlashMathOption[];
	  };

export interface SlashContext
{
	available(key: SlashCommandKey): boolean;
	/** Evaluates a math expression: its result, the literal "incomplete" while still being typed, or null when it is not math. */
	evalMath?(expression: string): string | null;
}

function commandOptions(term: string, ctx: SlashContext): SlashCommandOption[]
{
	if (/^\s/u.test(term))
	{
		return [];
	}
	const options: SlashCommandOption[] = [];
	for (const key of SLASH_MENU_KEYS)
	{
		const command = SLASH_COMMANDS[key];
		if (command && ctx.available(key) && (term === "" || fuzzyMatch(term, command.label)))
		{
			options.push(
				{
					key,
					...command,
				},
			);
		}
	}
	if (term !== "")
	{
		options.sort((a, b) => fuzzyScore(term, b.label) - fuzzyScore(term, a.label));
	}
	return options;
}

/**
 * Resolves the slash chip's text (" /term" or "/term") into menu groups: matching commands first,
 * else the math result, else null so the caller disarms the chip.
 */
export function resolveSlash(chipText: string, ctx: SlashContext): SlashGroup[] | null
{
	const term = chipText.trimStart().slice(1);
	const options = commandOptions(term, ctx);
	if (options.length > 0)
	{
		return [
			{
				name: "Actions",
				options,
			},
		];
	}
	const result = ctx.evalMath?.(term) ?? null;
	if (result === null)
	{
		return null;
	}
	return [
		{
			name: "=",
			options: [
				result === "incomplete"
					?
						{
							label: "...",
							noop: true,
						}
					:
						{
							label: result,
						},
			],
		},
	];
}

/**
 * The slash commands this app can run (upstream allows hiding a command, never reordering or relabelling one);
 * every other key stays hidden until its feature lands.
 */
const LOCAL_SLASH_KEYS: ReadonlySet<SlashCommandKey> = new Set<SlashCommandKey>([
	"toggle_bullet",
	"toggle_board",
	"toggle_table",
	"toggle_todo",
	"toggle_h1",
	"toggle_h2",
	"toggle_h3",
	"toggle_paragraph",
	"toggle_quote_block",
	"toggle_code_block",
	"toggle_divider",
	"toggle_numbered",
	"complete",
	"add_date",
	"add_note",
	"open_in_pane",
	"duplicate",
	"move_to",
	"move_to_today",
	"move_to_tomorrow",
	"move_to_next_week",
	"move_to_date",
	"show_export",
	"mirror",
	"mirror_to",
	"mirror_to_child",
	"mirror_here",
	"mirror_to_today",
	"mirror_to_date",
	"show_mirror_breadcrumbs",
	"detach_mirror",
	"expand_all",
	"collapse_all",
	"sort_children_asc",
	"sort_children_desc",
	"copy_link",
	"insert_board_column_left",
	"insert_board_column_right",
	"delete",
	"show_command_palette",
]);

export function LOCAL_SLASH_AVAILABLE(key: SlashCommandKey): boolean
{
	return LOCAL_SLASH_KEYS.has(key);
}
