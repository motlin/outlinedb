/**
 * Registry of item types ("Turn into" targets) cloned from upstream `ITEM_TYPES`,
 * plus the rules that decide which types an item may become and which icon the
 * type-menu header shows for the item's current layout.
 */
import {dashboardsOn} from "./dashboard.js";
import {isFeatureOn} from "./features.js";

export interface ItemType
{
	key: string;
	label: string;
	/** Value stored in `metadata.layoutMode` for this type. */
	layoutModeKey: string;
	/** Font Awesome icon name. */
	icon: string;
	/** Upstream `turn_into_*` command id: the row's handbook key in the node-type menu. */
	command: string;
}

export interface ItemTypeContext
{
	isRoot: boolean;
	isMainDocumentRoot: boolean;
	readOnly: boolean;
	isTableCell: boolean;
}

export const ITEM_TYPES: readonly ItemType[] = [
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
];

const MAIN_DOCUMENT_ROOT_EXCLUDED = new Set([
	"h1",
	"h2",
	"h3",
	"p",
	"numbered",
	"table",
	"quote-block",
	"code-block",
	"divider",
]);

const TABLE_CELL_ALLOWED = new Set([
	"bullets",
	"todo",
	"board",
	"table",
	"dashboard",
	"h1",
	"h2",
	"h3",
	"p",
	"numbered",
]);

/** Types an item may be turned into, in menu order. */
export function availableItemTypes(ctx: ItemTypeContext, flagOn: boolean = dashboardsOn()): ItemType[]
{
	if (ctx.readOnly)
	{
		return [];
	}
	return ITEM_TYPES.filter(
		(type) =>
			!(type.layoutModeKey === "dashboard" && !flagOn) &&
			!(type.layoutModeKey === "table" && !isFeatureOn("table")) &&
			!(type.layoutModeKey === "numbered" && !isFeatureOn("numbered_list")) &&
			!(ctx.isRoot && type.layoutModeKey === "todo") &&
			!(ctx.isMainDocumentRoot && MAIN_DOCUMENT_ROOT_EXCLUDED.has(type.layoutModeKey)) &&
			!(ctx.isTableCell && !TABLE_CELL_ALLOWED.has(type.layoutModeKey)),
	);
}

/** Legacy stored values that upstream still reads as a current type. */
const LEGACY_LAYOUT_ALIASES: Record<string, string> =
{
	check: "todo",
	paragraph: "p",
	quote: "quote-block",
};

/** The stored layout mode with legacy aliases resolved, or null for none. */
export function normalizeLayoutMode(layoutMode: string | null | undefined): string | null
{
	return layoutMode ? (LEGACY_LAYOUT_ALIASES[layoutMode] ?? layoutMode) : null;
}

/** Upstream's divider has no note, so its note editor never opens (Shift+Enter, Add note). */
export function canHaveNote(layoutMode: string | null | undefined): boolean
{
	return normalizeLayoutMode(layoutMode) !== "divider";
}

/** Icon for the item's current type; anything unrecognized shows the bullets icon. */
export function currentTypeIcon(layoutMode: string | null | undefined): string
{
	const key = normalizeLayoutMode(layoutMode);
	return ITEM_TYPES.find((type) => type.layoutModeKey === key)?.icon ?? "list-ul";
}

export type LayoutToggleCommand =
	| "toggle_h1"
	| "toggle_h2"
	| "toggle_h3"
	| "toggle_paragraph"
	| "toggle_todo"
	| "toggle_bullet"
	| "toggle_numbered"
	| "toggle_code_block"
	| "toggle_quote_block"
	| "toggle_divider";

export interface LayoutToggleItem
{
	id: string;
	layoutMode: string | null;
	numberedStart: number | null;
	name: string;
	plainName: string;
	hasChildren: boolean;
	hasNote: boolean;
}

/** `layoutMode: "bullets"` means the stored layoutMode should be removed. */
export interface LayoutToggleUpdate
{
	id: string;
	layoutMode: string;
	numberedStart?: number | null;
	name?: string;
	/** Upstream's divider has no note: becoming one clears it. */
	note?: "";
}

/** A row made from one more line of a code or quote block that changed type, placed after the row `afterId`. */
export interface LineSplitCreate
{
	afterId: string;
	/** The line as plain text. */
	name: string;
	layoutMode: string;
}

export interface LayoutTogglePlan
{
	updates: LayoutToggleUpdate[];
	deletes: string[];
	clearSelection: boolean;
	/** The lines of a multi-line block that left its type, one new row each, in order. */
	creates?: LineSplitCreate[];
}

const MULTILINE_TYPES: ReadonlySet<string> = new Set(["code-block", "quote-block"]);

/**
 * Upstream's type change of a multi-line code or quote block: leaving for a type that is neither of those, the row keeps
 * its first line and every further line becomes a row after it with the new type. Any other change is a plain update.
 */
export function planBlockTypeChange(
	item:
	{
		id: string;
		layoutMode: string | null;
		plainName: string;
	},
	target: string,
):
{
	update:
	{
		id: string;
		layoutMode: string;
		name?: string;
	};
	creates:
	{
		name: string;
		layoutMode: string;
	}[];
}
{
	const from = normalizeLayoutMode(item.layoutMode) ?? "";
	const lines = item.plainName.split("\n");
	if (!MULTILINE_TYPES.has(from) || MULTILINE_TYPES.has(target) || lines.length < 2)
	{
		return {
			update:
			{
				id: item.id,
				layoutMode: target,
			},
			creates: [],
		};
	}
	const [first = "", ...rest] = lines;
	return {
		update:
		{
			id: item.id,
			layoutMode: target,
			name: first,
		},
		creates: rest.map((name) => (
		{
			name,
			layoutMode: target,
		})),
	};
}

/** Plain block text as the name field stores it. */
export function escapeBlockText(text: string): string
{
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** `plan` with each multi-line block that left its type split into rows (`planBlockTypeChange`). */
function withLineSplits(plan: LayoutTogglePlan, items: readonly LayoutToggleItem[]): LayoutTogglePlan
{
	const byId = new Map(items.map((item) => [item.id, item]));
	const creates: LineSplitCreate[] = [];
	const updates = plan.updates.map((update) =>
	{
		const item = byId.get(update.id);
		if (item === undefined || update.name !== undefined)
		{
			return update;
		}
		const change = planBlockTypeChange(item, update.layoutMode);
		creates.push(
			...change.creates.map((line) => (
			{
				afterId: update.id,
				...line,
				name: escapeBlockText(line.name),
			})),
		);
		return change.update.name === undefined
			? update
			:
				{
					...update,
					name: escapeBlockText(change.update.name),
				};
	});
	return creates.length === 0
		? plan
		:
			{
				...plan,
				updates,
				creates,
			};
}

type SimpleToggleCommand = "toggle_h1" | "toggle_h2" | "toggle_h3" | "toggle_paragraph" | "toggle_todo";

const SIMPLE_TOGGLE_TARGETS: Record<SimpleToggleCommand, string> =
{
	toggle_h1: "h1",
	toggle_h2: "h2",
	toggle_h3: "h3",
	toggle_paragraph: "p",
	toggle_todo: "todo",
};

const NUMBER_PREFIX = /^(\d+)\. /u;

function effectiveType(item: LayoutToggleItem): string
{
	return item.layoutMode ? (LEGACY_LAYOUT_ALIASES[item.layoutMode] ?? item.layoutMode) : "bullets";
}

function toggledType(item: LayoutToggleItem, target: string): string
{
	return effectiveType(item) === target ? "bullets" : target;
}

function planNumbered(items: readonly LayoutToggleItem[]): LayoutToggleUpdate[]
{
	const start = NUMBER_PREFIX.exec(items[0]?.plainName ?? "");
	return items.map((item, index) =>
	{
		if (effectiveType(item) === "numbered")
		{
			return {
				id: item.id,
				layoutMode: "bullets",
				numberedStart: null,
			};
		}
		const update: LayoutToggleUpdate =
		{
			id: item.id,
			layoutMode: "numbered",
		};
		if (start)
		{
			if (index === 0)
			{
				update.numberedStart = Number(start[1]);
			}
			if (NUMBER_PREFIX.test(item.plainName))
			{
				update.name = item.name.replace(NUMBER_PREFIX, "");
			}
		}
		return update;
	});
}

function planBlock(items: readonly LayoutToggleItem[], target: string): LayoutTogglePlan
{
	const plan: LayoutTogglePlan =
	{
		updates: [],
		deletes: [],
		clearSelection: false,
	};
	const runs: [LayoutToggleItem, ...LayoutToggleItem[]][] = [];
	let mergeable = false;
	for (const item of items)
	{
		const leaf = !item.hasChildren && !item.hasNote;
		const run = runs.at(-1);
		if (leaf && mergeable && run)
		{
			run.push(item);
		}
		else
		{
			runs.push([item]);
		}
		mergeable = leaf;
	}
	for (const [first, ...rest] of runs)
	{
		const update: LayoutToggleUpdate =
		{
			id: first.id,
			layoutMode: toggledType(first, target),
		};
		if (rest.length > 0)
		{
			update.name = escapeBlockText([first, ...rest].map((item) => item.plainName).join("\n"));
			plan.deletes.push(...rest.map((item) => item.id));
			plan.clearSelection = true;
		}
		else if (target === "code-block" && update.layoutMode === target)
		{
			update.name = escapeBlockText(first.plainName);
		}
		plan.updates.push(update);
	}
	return plan;
}

/**
 * Plan the layout writes for a handbook toggle over the selected items, cloning
 * upstream: simple types toggle all-or-nothing, numbering toggles per item and
 * captures a typed `N. ` start, code/quote blocks merge runs of plain leaves.
 */
export function planLayoutToggle(command: LayoutToggleCommand, items: readonly LayoutToggleItem[]): LayoutTogglePlan
{
	return withLineSplits(planToggle(command, items), items);
}

function planToggle(command: LayoutToggleCommand, items: readonly LayoutToggleItem[]): LayoutTogglePlan
{
	switch (command)
	{
		case "toggle_bullet":
			return {
				updates: items.map((item) => (
				{
					id: item.id,
					layoutMode: "bullets",
				})),
				deletes: [],
				clearSelection: false,
			};
		case "toggle_numbered":
			return {
				updates: planNumbered(items),
				deletes: [],
				clearSelection: false,
			};
		case "toggle_code_block":
			return planBlock(items, "code-block");
		case "toggle_quote_block":
			return planBlock(items, "quote-block");
		case "toggle_divider":
			return {
				updates: items.slice(0, 1).map((item) =>
				{
					const layoutMode = toggledType(item, "divider");
					return {
						id: item.id,
						layoutMode,
						...(layoutMode === "divider" && item.hasNote
							?
								{
									note: "",
								}
							: {}),
					};
				}),
				deletes: [],
				clearSelection: false,
			};
		case "toggle_h1":
		case "toggle_h2":
		case "toggle_h3":
		case "toggle_paragraph":
		case "toggle_todo":
		{
			const target = SIMPLE_TOGGLE_TARGETS[command];
			const layoutMode = items.every((item) => effectiveType(item) === target) ? "bullets" : target;
			return {
				updates: items.map((item) => (
				{
					id: item.id,
					layoutMode,
				})),
				deletes: [],
				clearSelection: false,
			};
		}
		default:
		{
			const unknownCommand: never = command;
			throw new Error(`Unknown layout toggle: ${String(unknownCommand)}`);
		}
	}
}
