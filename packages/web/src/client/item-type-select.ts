import {HOME_TARGET} from "@outlinedb/shared/types";
import {availableItemTypes, escapeBlockText, planBlockTypeChange} from "./layout-types.js";
import type {ItemType} from "./layout-types.js";

/** What choosing an item type needs from the outline: writes, expansion and the cached tree. */
export interface ItemTypeSelectDeps
{
	/** Write `layoutMode` to the node (`"home"` for Home; `"bullets"` removes the stored key). */
	update: (
		nodeId: string,
		layoutMode: string,
		extra?:
		{
			note?: "";
			name?: string;
		},
	) => void;
	/** The node's plain text: a multi-line code or quote block that changes type splits into one row per line. */
	plainName?: (nodeId: string) => string;
	/** Create a row per line after `nodeId`, in order (the split lines). */
	createAfter?: (
		nodeId: string,
		lines:
		{
			name: string;
			layoutMode: string;
		}[],
	) => void;
	/** Whether the node has a note; a node turned into a divider loses it. */
	hasNote?: (nodeId: string) => boolean;
	/** Expand each of `ids`. */
	expandAll: (ids: readonly string[]) => void;
	childIds: (nodeId: string) => readonly string[];
	/** Create an empty last child of `parentId` and return its id (Board turns a childless node into one empty column). */
	createChild?: (parentId: string) => string;
	/** The ids of the mirrors of `nodeId`, whose children Board also expands. */
	mirrorIds?: (nodeId: string) => readonly string[];
	/** Put the caret in the row. */
	startEditing?: (nodeId: string) => void;
	/** Table on or off: add or drop the Headers row, pad the rows and expand them (see `structureTable`). */
	structureTable?: (nodeId: string, on: boolean) => void;
	layoutMode: (nodeId: string) => string | null;
}

let tableCellProbe: (nodeId: string) => boolean = () => false;

/** Tells the picker which nodes are table cells (the app installs one over its query cache). */
export function setTableCellProbe(probe: (nodeId: string) => boolean): void
{
	tableCellProbe = probe;
}

/** The types the picker offers for `nodeIds`: Home is both the root and the main document root. */
export function pickerItemTypes(nodeIds: readonly string[], dashboardsOn?: boolean): ItemType[]
{
	const atHome = nodeIds.includes(HOME_TARGET);
	return availableItemTypes(
		{
			isRoot: atHome,
			isMainDocumentRoot: atHome,
			readOnly: false,
			isTableCell: nodeIds.some((id) => tableCellProbe(id)),
		},
		dashboardsOn,
	);
}

/**
 * Upstream's `turn_into_*` execute: it only touches nodes the type is available for (Home cannot become most
 * types), then sets the type; choosing the current type again keeps it, and Divider never toggles off. Board and
 * Table first expand every child of each node so the columns or rows show.
 */
export function selectItemType(type: ItemType, nodeIds: readonly string[], deps: ItemTypeSelectDeps): void
{
	const targets = nodeIds.filter((id) => pickerItemTypes([id], true).some((available) => available.key === type.key));
	if (type.layoutModeKey === "divider")
	{
		for (const id of targets)
		{
			if (deps.layoutMode(id) !== "divider")
			{
				// Upstream's divider has no note: turning a row into one clears it in the same write.
				deps.update(
					id,
					"divider",
					...(deps.hasNote?.(id) === true
						? [
								{
									note: "",
								} as const,
							]
						: []),
				);
			}
		}
		return;
	}
	if (type.layoutModeKey === "board" || type.layoutModeKey === "table" || type.layoutModeKey === "dashboard")
	{
		deps.expandAll(targets.flatMap((id) => expandTargets(id, deps, type.layoutModeKey === "board")));
	}
	for (const id of targets)
	{
		const change = planBlockTypeChange(
			{
				id,
				layoutMode: deps.layoutMode(id),
				plainName: deps.plainName?.(id) ?? "",
			},
			type.layoutModeKey,
		);
		if (change.update.name === undefined)
		{
			const wasTable = deps.layoutMode(id) === "table";
			deps.update(id, type.layoutModeKey);
			if (type.layoutModeKey === "board")
			{
				createFirstColumn(id, deps);
			}
			if (type.layoutModeKey === "table" && !wasTable)
			{
				deps.structureTable?.(id, true);
			}
			continue;
		}
		deps.update(
			id,
			type.layoutModeKey,
			{
				name: escapeBlockText(change.update.name),
			},
		);
		deps.createAfter?.(
			id,
			change.creates.map((line) => (
			{
				...line,
				name: escapeBlockText(line.name),
			})),
		);
	}
}

/** Children of the node, plus (Board) those of each mirror of it, which show the same columns. */
function expandTargets(nodeId: string, deps: ItemTypeSelectDeps, includeMirrors: boolean): string[]
{
	const mirrors = includeMirrors ? (deps.mirrorIds?.(nodeId) ?? []) : [];
	return [nodeId, ...mirrors].flatMap((id) => deps.childIds(id));
}

/** Upstream `turn-item-into-board`: a childless node gets one empty column, expanded and focused. */
function createFirstColumn(nodeId: string, deps: ItemTypeSelectDeps): void
{
	if (deps.createChild === undefined || deps.childIds(nodeId).length > 0)
	{
		return;
	}
	const columnId = deps.createChild(nodeId);
	deps.expandAll([nodeId]);
	deps.startEditing?.(columnId);
}

/**
 * Upstream's palette/slash `toggle_board` and `toggle_table` on one node: Board always sets `board` (no
 * toggle-off); Table writes `bullets` when the node is already a table. Turning either on expands the children.
 */
export function toggleBoardOrTable(
	command: "toggle_board" | "toggle_table",
	nodeId: string,
	deps: ItemTypeSelectDeps,
): void
{
	if (command === "toggle_table" && deps.layoutMode(nodeId) === "table")
	{
		deps.update(nodeId, "bullets");
		deps.structureTable?.(nodeId, false);
		return;
	}
	deps.expandAll(expandTargets(nodeId, deps, command === "toggle_board"));
	deps.update(nodeId, command === "toggle_board" ? "board" : "table");
	if (command === "toggle_board")
	{
		createFirstColumn(nodeId, deps);
	}
	else
	{
		deps.structureTable?.(nodeId, true);
	}
}
