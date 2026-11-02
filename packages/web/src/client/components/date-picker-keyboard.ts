export type CalendarFocusKind = "header" | "day" | "grid" | "other";

export interface CalendarFocusTarget
{
	kind: "header" | "grid";
	index: number;
}

export interface CalendarFocusCounts
{
	headers: number;
	grid: number;
	days: number;
}

/** A grid button's top edge and horizontal centre, for the month/year nearest-button search. */
export interface CalendarButtonRect
{
	top: number;
	centerX: number;
}

export const CALENDAR_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"]);

function header(index: number, counts: CalendarFocusCounts): CalendarFocusTarget | undefined
{
	return index >= 0 && index < counts.headers
		?
			{
				kind: "header",
				index,
			}
		: undefined;
}

function grid(index: number, counts: CalendarFocusCounts): CalendarFocusTarget | undefined
{
	return index >= 0 && index < counts.grid
		?
			{
				kind: "grid",
				index,
			}
		: undefined;
}

/** Upstream `ZK`'s nearest month/year button above or below: score `dy * 1000 + |dx|`, ignoring rows within 1px. */
function nearestGridButton(index: number, down: boolean, rects: readonly CalendarButtonRect[]): number | undefined
{
	const from = rects[index];
	if (!from)
	{
		return undefined;
	}
	let best = Number.POSITIVE_INFINITY;
	let found: number | undefined;
	for (const [candidate, rect] of rects.entries())
	{
		const dy = down ? rect.top - from.top : from.top - rect.top;
		const score = dy * 1000 + Math.abs(rect.centerX - from.centerX);
		if (candidate !== index && dy > 1 && score < best)
		{
			best = score;
			found = candidate;
		}
	}
	return found;
}

/**
 * Upstream `ZK`'s capture-phase arrow handling inside the calendar, as a pure step.
 * `index` is the focused button's position among its kind; day buttons are also the DATE view's grid buttons.
 * Returns undefined when the key is left to the menu.
 */
export function nextCalendarFocus(
	kind: CalendarFocusKind,
	index: number,
	key: string,
	counts: CalendarFocusCounts,
	gridRects: readonly CalendarButtonRect[] = [],
): CalendarFocusTarget | undefined
{
	if (!CALENDAR_KEYS.has(key) || counts.grid === 0)
	{
		return undefined;
	}
	if (kind === "header")
	{
		if (key === "ArrowDown")
		{
			return grid(0, counts);
		}
		if (key === "ArrowLeft")
		{
			return header(index - 1, counts) ?? header(counts.headers - 1, counts);
		}
		return key === "ArrowRight" ? (header(index + 1, counts) ?? header(0, counts)) : undefined;
	}
	if (kind === "other")
	{
		return key === "ArrowDown" ? (header(0, counts) ?? grid(0, counts)) : grid(counts.grid - 1, counts);
	}
	if (key === "ArrowLeft" || key === "ArrowRight")
	{
		return grid(index + (key === "ArrowLeft" ? -1 : 1), counts);
	}
	if (kind === "day")
	{
		return key === "ArrowDown" ? grid(index + 7, counts) : (grid(index - 7, counts) ?? header(0, counts));
	}
	const nearest = nearestGridButton(index, key === "ArrowDown", gridRects);
	if (nearest !== undefined)
	{
		return grid(nearest, counts);
	}
	return key === "ArrowUp" ? header(0, counts) : undefined;
}
