import {isFeatureOn} from "./features.js";
import {executeMirrorTo} from "./mirror-commands.js";
import {runMoveTo} from "./move-to.js";
import type {LoadedMoveTarget} from "./move-to.js";
import {findOrEnsureCalendarNode, pageLabel} from "./today.js";
import type {NavigateToCalendarDeps} from "./today.js";

export interface MoveToDateCommand
{
	label: string;
	icon: string;
	aliases: string[];
	verb: "move" | "mirror";
	verbPast: "moved" | "mirrored";
}

export type MoveToDateKey =
	| "move_to_today"
	| "move_to_tomorrow"
	| "move_to_next_week"
	| "move_7_days_out"
	| "move_to_date"
	| "mirror_to_today"
	| "mirror_to_date";

const MOVE =
{
	verb: "move",
	verbPast: "moved",
} as const;
const MIRROR =
{
	verb: "mirror",
	verbPast: "mirrored",
} as const;

/** Upstream's `calendar.move-to-today` module (`C30`): labels, icons, aliases and verbs. */
export const MOVE_TO_DATE_COMMANDS: Record<MoveToDateKey, MoveToDateCommand> =
{
	move_to_today:
	{
		label: "Move to Today",
		icon: "calendar-day",
		aliases: ["move", "today"],
		...MOVE,
	},
	move_to_tomorrow:
	{
		label: "Move to Tomorrow",
		icon: "calendar-circle-plus",
		aliases: ["move", "tomorrow"],
		...MOVE,
	},
	move_to_next_week:
	{
		label: "Move to Next Week",
		icon: "calendar-week",
		aliases: ["move", "next week"],
		...MOVE,
	},
	move_7_days_out:
	{
		label: "Move 7 Days Out",
		icon: "calendar-week",
		aliases: ["move", "7 days out"],
		...MOVE,
	},
	move_to_date:
	{
		label: "Move to Date...",
		icon: "calendar-days",
		aliases: ["move", "date", "today"],
		...MOVE,
	},
	mirror_to_today:
	{
		label: "Mirror to Today",
		icon: "diamond-turn-right",
		aliases: ["mirror", "today"],
		...MIRROR,
	},
	mirror_to_date:
	{
		label: "Mirror to Date...",
		icon: "diamond-turn-right",
		aliases: ["mirror", "date"],
		...MIRROR,
	},
};

function daysAhead(now: Date, days: number): Date
{
	const date = new Date(now);
	date.setDate(date.getDate() + days);
	return date;
}

/** The day each preset command targets, keeping `now`'s time of day (upstream `new Date()` + N days). */
export function moveToDateDestination(
	key: "move_to_today" | "move_to_tomorrow" | "move_to_next_week" | "move_7_days_out",
	now: Date,
	weekStartDay: number,
): Date
{
	const days =
	{
		move_to_today: 0,
		move_to_tomorrow: 1,
		move_to_next_week: (7 + weekStartDay - now.getDay()) % 7 || 7,
		move_7_days_out: 7,
	}[key];
	return daysAhead(now, days);
}

/**
 * Upstream Move to Today/Tomorrow/Next Week/Date: commit the edit, clear the selection, find or create the day (no
 * empty child), then run the Move To pipeline into it. Returns whether the items moved.
 */
export async function executeMoveToDate({
	date,
	fetch,
	commitEdit,
	clearSelection,
	notify,
	loadTarget,
	onMoved,
	...move
}: Omit<Parameters<typeof runMoveTo>[0], "target" | "childCount" | "parentOf"> &
{
	date: Date;
	fetch: NavigateToCalendarDeps["fetch"];
	commitEdit: () => void;
	clearSelection: () => void;
	notify: (message: string, type: "info") => void;
	loadTarget: (id: string) => Promise<LoadedMoveTarget>;
	/** Runs after the items moved (the calendar strip's dots are stale). */
	onMoved?: () => void;
}): Promise<boolean>
{
	if (!isFeatureOn("calendar_node"))
	{
		return false;
	}
	commitEdit();
	clearSelection();
	const day = await findOrEnsureCalendarNode(
		{
			date,
			createChild: false,
		},
		fetch,
	);
	if (day === null)
	{
		notify(`No calendar page for ${pageLabel(date, "day")} yet`, "info");
		return false;
	}
	const loaded = await loadTarget(day.dayId);
	const moved = runMoveTo(
		{
			...move,
			...loaded,
		},
	);
	if (moved)
	{
		onMoved?.();
	}
	return moved;
}

/**
 * Upstream Mirror to Today/Date...: like Move to Date, but the items are mirrored into the day (no `canMoveUnder`
 * check) and the toast reads `mirrored to '<day>'`. Returns whether any mirror was made.
 */
export async function executeMirrorToDate({
	date,
	fetch,
	commitEdit,
	clearSelection,
	notify,
	loadTarget,
	onMirrored,
	...mirror
}: Omit<Parameters<typeof executeMirrorTo>[0], "pick" | "loadTarget"> &
{
	date: Date;
	fetch: NavigateToCalendarDeps["fetch"];
	commitEdit: () => void;
	clearSelection: () => void;
	notify: (message: string, type: "info") => void;
	loadTarget: (id: string) => Promise<LoadedMoveTarget>;
	/** Runs after the mirrors were made (the calendar strip's dots are stale). */
	onMirrored?: () => void;
}): Promise<boolean>
{
	if (!isFeatureOn("calendar_node"))
	{
		return false;
	}
	commitEdit();
	clearSelection();
	const day = await findOrEnsureCalendarNode(
		{
			date,
			createChild: false,
		},
		fetch,
	);
	if (day === null)
	{
		notify(`No calendar page for ${pageLabel(date, "day")} yet`, "info");
		return false;
	}
	const mirrored = await executeMirrorTo(
		{
			...mirror,
			pick: async () =>
				Promise.resolve(
					{
						id: day.dayId,
					},
				),
			loadTarget,
		},
	);
	if (mirrored)
	{
		onMirrored?.();
	}
	return mirrored;
}
