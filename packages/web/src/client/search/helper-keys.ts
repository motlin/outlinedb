/** The search helper flyout's highlighted tab and chip (-1 means none) and whether the tab row has keyboard focus. */
export interface HelperSelection
{
	tab: number;
	chip: number;
	/** Upstream's `o1`: the keyboard is driving the tab row. */
	rowMode: boolean;
}

export const NO_HELPER_SELECTION: HelperSelection =
{
	tab: -1,
	chip: -1,
	rowMode: false,
};

export interface HelperKeyEvent
{
	/** `KeyboardEvent.code`, as upstream switches on it. */
	code: string;
	ctrl: boolean;
}

export interface HelperLayout
{
	tabCount: number;
	hasChips: (tab: number) => boolean;
	/** The selected tab's chip count. */
	chipCount: number;
	/** The chip above or below `chip` by geometry, or null when there is none. */
	neighbor: (chip: number, dir: "up" | "down") => number | null;
	/** The autocomplete flyout hides the helper flyout: tab steps stay at -1. */
	hidden?: boolean;
}

export interface HelperKeyResult
{
	sel: HelperSelection;
	preventDefault: boolean;
	/** Upstream's `stopImmediatePropagation`: the input's own key handler must not run. */
	stopPropagation: boolean;
	/** The chip index to insert. */
	select: number | null;
}

interface Pending extends HelperKeyResult
{
	/** The chip handler declined an ArrowUp, so the tab-row ArrowUp runs next. */
	fallThroughUp: boolean;
}

/** Upstream `g1`: step the tab, -1 reachable, no tab while the flyout is hidden. */
function stepTab(sel: HelperSelection, delta: number, layout: HelperLayout): HelperSelection
{
	if (layout.hidden === true)
	{
		return {
			...sel,
			tab: -1,
			chip: -1,
		};
	}
	if (sel.tab === -1)
	{
		return {
			...sel,
			tab: delta === -1 ? -1 : 0,
			chip: -1,
		};
	}
	return {
		...sel,
		tab: Math.min(layout.tabCount - 1, sel.tab + delta),
		chip: -1,
	};
}

/** Upstream `jN4`: the chip row's keys, attached while a tab with chips is selected; it ignores Ctrl. */
function chipKey(sel: HelperSelection, event: HelperKeyEvent, layout: HelperLayout): Pending
{
	const last = layout.chipCount - 1;
	const next = (
		patch: Partial<Pending> &
		{
			chip?: number;
		},
	): Pending =>
	{
		const {chip = sel.chip, ...rest} = patch;
		return {
			sel:
			{
				...sel,
				chip,
			},
			preventDefault: false,
			stopPropagation: false,
			select: null,
			fallThroughUp: false,
			...rest,
		};
	};
	switch (event.code)
	{
		case "ArrowLeft":
			return next(
				{
					chip: sel.chip === -1 ? last : Math.max(0, sel.chip - 1),
					preventDefault: true,
				},
			);
		case "ArrowRight":
			return next(
				{
					chip: sel.chip === -1 ? 0 : Math.min(last, sel.chip + 1),
					preventDefault: true,
				},
			);
		case "ArrowUp":
		{
			const target = sel.chip === -1 ? null : layout.neighbor(sel.chip, "up");
			return target === null
				? next(
						{
							chip: -1,
							preventDefault: true,
							fallThroughUp: true,
						},
					)
				: next(
						{
							chip: target,
							preventDefault: true,
							stopPropagation: true,
						},
					);
		}
		case "ArrowDown":
		{
			const target = sel.chip === -1 ? 0 : layout.neighbor(sel.chip, "down");
			return next(
				{
					chip: target ?? sel.chip,
					preventDefault: true,
				},
			);
		}
		case "Enter":
		case "Space":
		case "Tab":
			return next(
				{
					preventDefault: true,
					stopPropagation: event.code === "Tab",
					select: sel.chip >= 0 ? sel.chip : null,
				},
			);
		default:
			return next({});
	}
}

/** Upstream `EN4.b1`: the tab row's keys, attached while nothing is selected or the row has keyboard focus. */
function tabKey(sel: HelperSelection, event: HelperKeyEvent, layout: HelperLayout): Partial<HelperKeyResult>
{
	if (event.ctrl)
	{
		if (event.code === "KeyP" || event.code === "KeyN")
		{
			return {
				sel: stepTab(sel, event.code === "KeyP" ? -1 : 1, layout),
				preventDefault: true,
			};
		}
		return {};
	}
	switch (event.code)
	{
		case "ArrowLeft":
			return sel.tab === 0 || !sel.rowMode
				? {}
				:
					{
						sel: stepTab(sel, -1, layout),
						preventDefault: true,
					};
		case "ArrowRight":
			return sel.rowMode
				?
					{
						sel: stepTab(sel, 1, layout),
						preventDefault: true,
					}
				: {};
		case "ArrowUp":
			return {
				sel: sel.rowMode
					? NO_HELPER_SELECTION
					:
						{
							...sel,
							rowMode: true,
						},
				preventDefault: true,
				stopPropagation: sel.tab !== -1,
			};
		case "ArrowDown":
			if (sel.tab === -1)
			{
				return {
					sel: stepTab(
						{
							...sel,
							rowMode: true,
						},
						1,
						layout,
					),
					preventDefault: true,
				};
			}
			return {
				sel: sel.rowMode
					?
						{
							...sel,
							rowMode: false,
						}
					: sel,
				preventDefault: true,
			};
		default:
			return {};
	}
}

/**
 * Upstream's helper flyout key machine as a pure step: the chip row's handler runs first (on a tab with chips), then the
 * tab row's (while nothing is selected or the tab row is armed), so `rowMode` on a chip tab runs both.
 */
export function helperKey(sel: HelperSelection, event: HelperKeyEvent, layout: HelperLayout): HelperKeyResult
{
	const chip =
		sel.tab > -1 && layout.hasChips(sel.tab) && !event.ctrl
			? chipKey(sel, event, layout)
			: (
				{
					sel,
					preventDefault: false,
					stopPropagation: false,
					select: null,
					fallThroughUp: false,
				} satisfies Pending);
	if (chip.stopPropagation && chip.select === null && event.code !== "Tab")
	{
		return {
			sel: chip.sel,
			preventDefault: chip.preventDefault,
			stopPropagation: true,
			select: null,
		};
	}
	const tabRowAttached = sel.tab === -1 || sel.rowMode;
	if (!tabRowAttached && !chip.fallThroughUp)
	{
		return {
			sel: chip.sel,
			preventDefault: chip.preventDefault,
			stopPropagation: chip.stopPropagation,
			select: chip.select,
		};
	}
	const tab = tabKey(chip.sel, event, layout);
	return {
		sel: tab.sel ?? chip.sel,
		preventDefault: chip.preventDefault || tab.preventDefault === true,
		stopPropagation: chip.stopPropagation || tab.stopPropagation === true,
		select: chip.select,
	};
}

export interface RectLike
{
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface ChipGeometry
{
	/** The chip's `div.min-w-0.py-xs.px-px` wrapper. */
	wrapper: RectLike;
	/** The inner `a.menuItem`. */
	item: RectLike;
	offsetTop: number;
}

const FIRST_ROW_OFFSET = 20;
const MIN_ROOM_BELOW = 10;
const DOWN_PROBES = 10;
const DOWN_PROBE_STEP = 20;

function contains(rect: RectLike, x: number, y: number): boolean
{
	return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

/**
 * Upstream `ON4`/`BN4`: the chip above or below `active`, found by probing a point of the row above or below
 * (Down also probes left in steps) and taking the first wrapper that contains it. `hit` defaults to a rect test;
 * the browser passes `elementFromPoint` so visibility clipping matches upstream.
 */
export function chipNeighbor(
	chips: readonly ChipGeometry[],
	containerBottom: number,
	active: number,
	dir: "up" | "down",
	hit: (x: number, y: number) => number = (x, y) => chips.findIndex(({wrapper}) => contains(wrapper, x, y)),
): number | null
{
	const current = chips[active];
	if (current === undefined)
	{
		return null;
	}
	const {item} = current;
	if (dir === "up")
	{
		if (current.offsetTop < FIRST_ROW_OFFSET)
		{
			return null;
		}
		const index = hit(item.left + item.width / 4, item.top - item.height / 2);
		return index === -1 ? null : index;
	}
	const bottom = item.top + item.height;
	if (containerBottom - bottom <= MIN_ROOM_BELOW)
	{
		return null;
	}
	for (let probe = 0; probe <= DOWN_PROBES; probe++)
	{
		const index = hit(item.left + item.width / 4 - probe * DOWN_PROBE_STEP, bottom + item.height / 2);
		if (index !== -1)
		{
			return index;
		}
	}
	return null;
}
