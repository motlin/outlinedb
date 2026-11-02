import type {FaIconKey} from "./components/fa-icons.js";

/** One row of upstream's more-menu sheet. */
export type MoreMenuRow =
	|
	  {
			kind: "undo-redo";
			canUndo: boolean;
			canRedo: boolean;
			onUndo: () => void;
			onRedo: () => void;
	  }
	|
	  {
			kind: "separator";
	  }
	|
	  {
			kind: "item";
			label: string;
			icon: FaIconKey;
			onSelect: () => void;
			/** A trailing chevron (a submenu) or toggle (the Show completed switch). */
			extra?: "chevron-right" | "toggle";
			toggled?: boolean;
			starred?: boolean;
	  };

export interface MoreMenuContext
{
	/** The zoomed node, or null at Home. */
	zoomedId: string | null;
	canUndo: boolean;
	canRedo: boolean;
	starred: boolean;
	starsAvailable: boolean;
	showCompleted: boolean;
	/** A revealing search forces completed rows, so upstream offers no toggle. */
	completedForced: boolean;
	canTurnInto: boolean;
	actions:
	{
		undo: () => void;
		redo: () => void;
		turnInto: () => void;
		toggleStar: () => void;
		share: () => void;
		exportZoomed: () => void;
		expandAll: () => void;
		collapseAll: () => void;
		deleteZoomed: () => void;
		adjustTextSize: () => void;
		toggleCompleted: () => void;
		openSettings: () => void;
	};
}

const SEPARATOR: MoreMenuRow =
{
	kind: "separator",
};

/**
 * Upstream's `config("ui.touch.menu.*")` order: Undo/Redo, Turn into, Starred, Share and Export, Expand/Collapse all,
 * Delete, then Adjust Text Size, Show completed and Settings. Trash is left out (no trash view locally). Empty groups
 * drop their separators, like upstream's `[&+&]:hidden`.
 */
export function moreMenuRows(context: MoreMenuContext): MoreMenuRow[]
{
	const {actions} = context;
	const home = context.zoomedId === null;
	const groups: MoreMenuRow[][] = [
		[
			{
				kind: "undo-redo",
				canUndo: context.canUndo,
				canRedo: context.canRedo,
				onUndo: actions.undo,
				onRedo: actions.redo,
			},
		],
		context.canTurnInto
			? [
					{
						kind: "item",
						label: "Turn into...",
						icon: "fal:diamond-turn-right",
						onSelect: actions.turnInto,
						extra: "chevron-right",
					},
				]
			: [],
		!home && context.starsAvailable
			? [
					{
						kind: "item",
						label: context.starred ? "Remove from Starred" : "Add to Starred",
						icon: context.starred ? "fas:star" : "fal:star",
						onSelect: actions.toggleStar,
						starred: context.starred,
					},
				]
			: [],
		[
			...(home
				? []
				: ([
						{
							kind: "item",
							label: "Share",
							icon: "fal:user-plus",
							onSelect: actions.share,
						},
					] as MoreMenuRow[])),
			{
				kind: "item",
				label: "Export",
				icon: "fal:file-export",
				onSelect: actions.exportZoomed,
			},
		],
		[
			{
				kind: "item",
				label: "Expand all",
				icon: "fal:up-right-and-down-left-from-center",
				onSelect: actions.expandAll,
			},
			{
				kind: "item",
				label: "Collapse all",
				icon: "fal:down-left-and-up-right-to-center",
				onSelect: actions.collapseAll,
			},
		],
		home
			? []
			: [
					{
						kind: "item",
						label: "Delete",
						icon: "fal:trash-can",
						onSelect: actions.deleteZoomed,
					},
				],
		[
			{
				kind: "item",
				label: "Adjust Text Size",
				icon: "fal:font",
				onSelect: actions.adjustTextSize,
			},
			...(context.completedForced
				? []
				: ([
						{
							kind: "item",
							label: "Show completed",
							icon: "fal:check",
							onSelect: actions.toggleCompleted,
							extra: "toggle",
							toggled: context.showCompleted,
						},
					] as MoreMenuRow[])),
			{
				kind: "item",
				label: "Settings",
				icon: "fal:gear",
				onSelect: actions.openSettings,
			},
		],
	];
	const rows: MoreMenuRow[] = [];
	for (const group of groups.filter((candidate) => candidate.length > 0))
	{
		rows.push(...group, SEPARATOR);
	}
	return rows;
}

/** The text of every row in order, for tests and the sheet's accessible names. */
export function moreMenuLabels(rows: readonly MoreMenuRow[]): string[]
{
	return rows.flatMap((row) =>
		row.kind === "undo-redo" ? ["Undo", "Redo"] : row.kind === "item" ? [row.label] : ["-"],
	);
}
