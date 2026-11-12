import {CALENDAR_LEVELS, dateId} from "@outlinedb/shared";
import type {CalendarLevel} from "@outlinedb/shared";
import type {CalendarInfo} from "../node-types.js";
import type {AppMessageAction, AppMessageType} from "./stores/outline.js";
import {defaultIndexIn} from "./tree-ops.js";
import type {BlockMove} from "./tree-ops.js";

export interface MoveToTarget
{
	id: string;
	name: string;
	defaultToBottom?: boolean;
}

export interface MoveToToast
{
	text: string;
	timeout: number;
	actions: AppMessageAction[];
	type?: AppMessageType;
}

const MOVE_TOAST_TIMEOUT = 5000;

/** Upstream `canMoveUnder`: false when `targetId` is the item itself or anywhere beneath it. */
export function canMoveUnder(parentOf: (id: string) => string | null, itemId: string, targetId: string): boolean
{
	for (let id: string | null = targetId; id !== null; id = parentOf(id))
	{
		if (id === itemId)
		{
			return false;
		}
	}
	return true;
}

/** Upstream's levels for a calendar root that sets none. */
export const DEFAULT_CALENDAR_LEVELS: Readonly<Record<CalendarLevel, boolean>> =
{
	year: true,
	month: true,
	week: false,
	day: true,
};

/**
 * Upstream `item.can_move_under.calendar_levels`: a restorable (app-created) 📆 Calendar level node, other than a
 * mirror, moves only to its parent level. The first enabled level (year) needs the calendar root as the target; any
 * other level needs a target of the previous enabled level for the same period. Adopted nodes, which lack
 * `restorableUniqueNode`, and every other row move freely.
 */
export function canMoveUnderCalendar(
	item:
	{
		calendar?: CalendarInfo | null;
		isMirror?: boolean;
	},
	target:
	{
		calendar?: CalendarInfo | null;
	},
	levels: Readonly<Record<CalendarLevel, boolean>>,
): boolean
{
	const {calendar} = item;
	if (calendar === null || calendar === undefined || calendar.root || item.isMirror === true)
	{
		return true;
	}
	if (!calendar.restorableUniqueNode || calendar.dateId === null)
	{
		return true;
	}
	const enabled = CALENDAR_LEVELS.filter((level) => levels[level]);
	const index = enabled.findIndex((level) => level === calendar.level);
	if (index === -1)
	{
		return true;
	}
	if (index === 0)
	{
		return target.calendar?.root === true;
	}
	const previous = enabled[index - 1];
	const {dateId: id} = calendar;
	const date = new Date(Math.floor(id / 10_000), (Math.floor(id / 100) % 100 || 1) - 1, id % 100 || 1);
	return (
		previous !== undefined &&
		target.calendar?.level === previous &&
		target.calendar.dateId === dateId(previous, date)
	);
}

/** One block move of `items` (document order) into `target` at upstream's `WF.Priority.defaultIn` slot (top unless `defaultToBottom`). */
export function planMoveTo({
	items,
	target,
	childCount,
}: {
	items: readonly string[];
	target: Pick<MoveToTarget, "id" | "defaultToBottom">;
	childCount: number;
}): BlockMove
{
	return {
		ids: [...items],
		parentId: target.id,
		index: defaultIndexIn(target, childCount),
	};
}

export interface MoveVerb
{
	verb: string;
	verbPast: string;
}

export const MOVE_VERB: MoveVerb =
{
	verb: "move",
	verbPast: "moved",
};

/** Upstream's literal toast text: lowercase success (the toast CSS capitalizes it) and `Can't <verb> to '<name>'`. */
export function moveToastText(kind: "ok" | "cant", {verb, verbPast}: MoveVerb, name: string): string
{
	return kind === "ok" ? `${verbPast} to '${name}'` : `Can't ${verb} to '${name}'`;
}

/**
 * Upstream Move To (`WF.SendTo`): move the items (the selection in document order, or the one row) into the chosen
 * location as one block without expanding it, then toast `Moved to '<name>'` with View (zoom to the target) and Undo
 * (upstream `WF.Undo.undo`: the undo stack, which waits for the move to land). A target at or under any item stays
 * listed upstream; choosing it only toasts `Can't move to`. Returns whether the items moved.
 */
export function runMoveTo({
	items,
	target,
	childCount,
	parentOf,
	moveNodes,
	showToast,
	view,
	undo,
	leaveItem,
	verb = MOVE_VERB,
	allowed = () => true,
}: {
	/** The item ids in document order. */
	items: readonly string[];
	target: MoveToTarget;
	/** The target's current child count. */
	childCount: number;
	parentOf: (id: string) => string | null;
	moveNodes: (moves: BlockMove[]) => void;
	showToast: (toast: MoveToToast) => void;
	view: (targetId: string) => void;
	/** Pops the undo stack (the toast's Undo). */
	undo: () => void;
	/** Runs just before the move, while the item's row is still in place (caret to the previous visible row). */
	leaveItem?: () => void;
	/** Wording for the toast (default move/moved). */
	verb?: MoveVerb;
	/** An extra per-item rule beyond the ancestry check, such as the 📆 Calendar level guard. */
	allowed?: (itemId: string, targetId: string) => boolean;
}): boolean
{
	if (!items.every((item) => canMoveUnder(parentOf, item, target.id) && allowed(item, target.id)))
	{
		showToast(
			{
				text: moveToastText("cant", verb, target.name),
				timeout: MOVE_TOAST_TIMEOUT,
				actions: [],
				type: "failure",
			},
		);
		return false;
	}
	leaveItem?.();
	moveNodes([
		planMoveTo(
			{
				items,
				target,
				childCount,
			},
		),
	]);
	showToast(
		{
			text: moveToastText("ok", verb, target.name),
			timeout: MOVE_TOAST_TIMEOUT,
			actions: [
				{
					label: "View",
					shortcut: "shift+return",
					run: () =>
					{
						view(target.id);
					},
				},
				{
					label: "Undo",
					run: undo,
				},
			],
		},
	);
	return true;
}

/** A loaded Move To location: its name and priority default, child count and ancestry. */
export interface LoadedMoveTarget
{
	target: MoveToTarget;
	childCount: number;
	parentOf: (id: string) => string | null;
}

/**
 * The Move To caller (`⌃⌘M`, bullet menu): open the location picker, load what it chose (an existing location,
 * or the one its create-and-move just made), then `runMoveTo`. Returns whether the item moved.
 */
export async function executeMoveTo({
	pick,
	loadTarget,
	...move
}: Omit<Parameters<typeof runMoveTo>[0], "target" | "childCount" | "parentOf"> &
{
	pick: () => Promise<
		|
		  {
				id: string;
		  }
		|
		  {
				createdId: string;
		  }
		| undefined
	>;
	loadTarget: (id: string) => Promise<LoadedMoveTarget>;
}): Promise<boolean>
{
	const picked = await pick();
	if (picked === undefined)
	{
		return false;
	}
	const loaded = await loadTarget("id" in picked ? picked.id : picked.createdId);
	return runMoveTo(
		{
			...move,
			...loaded,
		},
	);
}

/**
 * Upstream routes the toast's View through `WF.Panes.handleCommand({command: "navigate_to_item"})` first: it zooms
 * the pane that held the caret when Move To ran (`paneId`, null for the main outline), else the main outline.
 */
export function viewMovedTarget(
	targetId: string,
	paneId: string | null,
	actions:
	{
		zoomPane: (paneId: string, targetId: string) => void;
		zoomMain: (targetId: string) => void;
	},
): void
{
	if (paneId === null)
	{
		actions.zoomMain(targetId);
	}
	else
	{
		actions.zoomPane(paneId, targetId);
	}
}
