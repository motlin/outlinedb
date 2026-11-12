export interface SwitcherSelectionState
{
	selected: number;
	filter: string;
	count: number;
}

export interface SwitcherSelection
{
	getState: () => SwitcherSelectionState;
	/** Sets the filter and moves the selection back to the first row. */
	search: (filter: string) => void;
	hover: (index: number) => void;
	/** Moves down one row, wrapping from the last row to the first. */
	selectNext: () => void;
	/** Moves up one row, wrapping from the first row to the last. */
	selectPrev: () => void;
	setCount: (count: number) => void;
	reset: () => void;
}

const EMPTY: SwitcherSelectionState =
{
	selected: 0,
	filter: "",
	count: 0,
};

/** Upstream's jump-menu selection: the highlighted row wraps at both ends instead of clamping. */
export function createSwitcherSelection(): SwitcherSelection
{
	let state = EMPTY;

	return {
		getState: () => state,
		search: (filter) =>
		{
			state =
			{
				...state,
				filter,
				selected: 0,
			};
		},
		hover: (index) =>
		{
			state =
			{
				...state,
				selected: index,
			};
		},
		selectNext: () =>
		{
			const {selected, count} = state;
			state =
			{
				...state,
				selected: count === 0 ? 0 : (selected + 1) % count,
			};
		},
		selectPrev: () =>
		{
			const {selected, count} = state;
			state =
			{
				...state,
				selected: count === 0 ? 0 : selected <= 0 ? count - 1 : selected - 1,
			};
		},
		setCount: (count) =>
		{
			state =
			{
				...state,
				count,
			};
		},
		reset: () =>
		{
			state = EMPTY;
		},
	};
}

const CRUMB_LENGTH = 20;

/** Upstream's switcher crumb: the first 20 characters, with an ellipsis once the name reaches 20. */
export function switcherCrumb(name: string): string
{
	return name.length >= CRUMB_LENGTH ? `${name.slice(0, CRUMB_LENGTH)}…` : name;
}

/** A page the switcher can return to: a node id (null for Home) and its plain-text name. */
export interface SwitcherLocation
{
	id: string | null;
	name: string;
}

/** Upstream's `..` and `-` rows; they never show crumbs or action buttons. */
export interface SpecialRow
{
	kind: "up" | "previous";
	label: string;
	/** The page to zoom to (null for Home). */
	targetId: string | null;
}

export interface SpecialContext
{
	/** The zoomed node (null or absent at Home). */
	zoomId?: string | null;
	/** The zoomed node's parent (null for a top-level page). */
	parentId?: string | null;
	/** Defaults to the location remembered by the last `..` or `-` jump. */
	previous?: SwitcherLocation | null;
}

// Upstream keeps this at module scope: it outlives each opening, and a normal jump leaves it alone.
let previousLocation: SwitcherLocation | null = null;

export function getPreviousLocation(): SwitcherLocation | null
{
	return previousLocation;
}

export function resetPreviousLocation(): void
{
	previousLocation = null;
}

/** True for a filter that shows a special row instead of searching; the list below keeps its previous results. */
export function isSpecialFilter(filter: string): boolean
{
	const trimmed = filter.trim();
	return trimmed === ".." || trimmed === "-";
}

/** The rows upstream prepends for the `..` (zoom one level up) and `-` (previous location) filters. */
export function specialRows(filter: string, context: SpecialContext): SpecialRow[]
{
	const trimmed = filter.trim();
	const {zoomId = null, parentId = null} = context;
	if (trimmed === "..")
	{
		return zoomId === null
			? []
			: [
					{
						kind: "up",
						label: "Zoom one level up",
						targetId: parentId,
					},
				];
	}
	if (trimmed === "-")
	{
		const previous = context.previous === undefined ? previousLocation : context.previous;
		return previous === null
			? []
			: [
					{
						kind: "previous",
						label: `Previous location: ${previous.name}`,
						targetId: previous.id,
					},
				];
	}
	return [];
}

/** Remembers `current` as the previous location and returns the page to zoom to; `-` thereby swaps the two. */
export function applySpecial(row: SpecialRow, current: SwitcherLocation): string | null
{
	previousLocation = current;
	return row.targetId;
}
