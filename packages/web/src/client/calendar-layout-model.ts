/** The Calendar Layout view's data and pure helpers (upstream `P10`). */

/** The levels a checkbox controls, in upstream's order (`WF.Calendar.levels.all()` without day). */
export const LEVELS = ["year", "month", "week"] as const;
export type LayoutLevel = (typeof LEVELS)[number];

export type LayoutLevels = Partial<Record<LayoutLevel | "day", boolean>>;

/** The text of upstream's "Move nodes into your Calendar?" dialog, for the local confirm. */
export const MOVE_NODES_CONFIRM = [
	"Move nodes into your Calendar?",
	"",
	"Dated nodes will move into their matching days.",
	"Undated nodes will appear at the top of your calendar.",
	"You can undo this change if you don’t like the result.",
].join("\n");

/**
 * The message for a layout preview (`POST /api/v1/calendar/layout/preview`): how many nodes upstream's restructure
 * would move, create, delete and retag (calendar metadata set or removed). Update Layout only previews while
 * applying is disabled.
 */
export function layoutPreviewMessage(
	steps: readonly
	{
		op: string;
	}[],
): string
{
	const count = (op: string) => steps.filter((step) => step.op === op).length;
	return `Calendar Layout would move ${count("move")} nodes, create ${count("create")}, delete ${count("delete")} and retag ${count("set-calendar")}. Applying layouts is not enabled yet.`;
}

/** The message after `PUT /api/v1/calendar/layout`, which offers Undo when anything changed. */
export function layoutAppliedMessage(writes: number): string
{
	return writes === 0
		? "Calendar layout already up to date."
		: `Calendar layout updated (${writes} ${writes === 1 ? "change" : "changes"}).`;
}

/** The custom levels the checked state turns off (upstream P10's `Object.keys(l).filter(i => !c[i])`), in level order. */
export function layoutWarningLevels(customLevels: readonly string[], checked: LayoutLevels): LayoutLevel[]
{
	return LEVELS.filter((level) => customLevels.includes(level) && checked[level] !== true);
}

/** A level's checkbox label (upstream `RS2`). */
export function capitalize(level: string): string
{
	return level.charAt(0).toUpperCase() + level.slice(1);
}
