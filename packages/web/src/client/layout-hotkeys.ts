import type {NodeResponse} from "../node-types.js";
import {planLayoutToggle} from "./layout-types.js";
import type {LayoutToggleCommand, LayoutToggleItem, LineSplitCreate} from "./layout-types.js";
import {plainText} from "./rich-text.js";

/** Upstream's ⌥⌘ digit layout toggles (⌥⌘1-4, 6-9, 0), in keymap order. */
export const LAYOUT_HOTKEY_COMMANDS = [
	"toggle_h1",
	"toggle_h2",
	"toggle_h3",
	"toggle_paragraph",
	"toggle_code_block",
	"toggle_quote_block",
	"toggle_bullet",
	"toggle_todo",
	"toggle_numbered",
] as const satisfies readonly LayoutToggleCommand[];

export type LayoutHotkeyCommand = (typeof LAYOUT_HOTKEY_COMMANDS)[number];

/** One node's layout write: name, layoutMode and numberedStart in one update request. */
export interface LayoutUpdateRequest
{
	nodeId: string;
	layoutMode: string;
	numberedStart?: number | null;
	name?: string;
	note?: "";
}

export interface LayoutHotkeyWrites
{
	updates: LayoutUpdateRequest[];
	deletes: string[];
	clearSelection: boolean;
	/** Rows for the lines of a multi-line block that changed type, each after its row. */
	creates: LineSplitCreate[];
}

/** The edited row's unsaved text, which replaces its cached name. */
export interface EditedName
{
	nodeId: string;
	name: string;
}

function toggleItem(node: NodeResponse, edited: EditedName | undefined): LayoutToggleItem
{
	const name = edited?.nodeId === node.id ? edited.name : (node.name ?? "");
	return {
		id: node.id,
		layoutMode: node.data.layoutMode,
		numberedStart: node.numberedStart ?? null,
		name,
		plainName: plainText(name, ""),
		hasChildren: node.hasChildren ?? false,
		hasNote: (node.note ?? "") !== "",
	};
}

/**
 * The writes a layout hotkey makes to `nodes` (the command targets), via `planLayoutToggle`. Code and quote blocks
 * store plain text, escaped back to HTML for the name field.
 */
export function planLayoutHotkey(
	command: LayoutToggleCommand,
	nodes: readonly NodeResponse[],
	edited?: EditedName,
): LayoutHotkeyWrites
{
	const plan = planLayoutToggle(
		command,
		nodes.map((node) => toggleItem(node, edited)),
	);
	return {
		updates: plan.updates.map(({id, ...rest}) => (
		{
			nodeId: id,
			...rest,
		})),
		deletes: plan.deletes,
		clearSelection: plan.clearSelection,
		creates: plan.creates ?? [],
	};
}

/** Layout modes that keep their own structure and cannot become a to-do. */
const NO_TODO_LAYOUTS = new Set(["code-block", "quote-block", "divider"]);

/**
 * Upstream `toggle_todo_mode` availability (`xL1`): hidden when every target is read-only or no target can take the
 * to-do layout.
 */
export function todoModeAvailable(nodes: readonly NodeResponse[]): boolean
{
	return nodes.some((node) => node.readOnly !== true && !NO_TODO_LAYOUTS.has(node.data.layoutMode ?? ""));
}
