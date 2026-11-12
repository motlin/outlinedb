/**
 * Width-aware breadcrumb layout: a port of upstream Workflowy's `U20`.
 * Truncates the widest crumbs first, then collapses middle crumbs into "..." menus.
 * Group 0 is the left side (Home first), 1 is collapsed, 2 is the right side (current last).
 */

export type CrumbGroup = 0 | 1 | 2;

export interface CrumbInput
{
	id: string;
	label: string;
}

export interface LayoutCrumb extends CrumbInput
{
	group: CrumbGroup;
	isZoomed: boolean;
	truncateWidth: number | null;
}

export interface CrumbChunkWithOffset
{
	leftOffset: number;
	items: LayoutCrumb[];
}

export interface BreadcrumbLayoutOptions
{
	itemGap?: number;
	rightMargin?: number;
	minItemWidth?: number;
	ellipsisWidth?: number;
	threeDotPosition?: "middle" | "left";
}

/**
 * Upstream's side-pane header crumbs: tighter sizes under 500px, a width budget that leaves room for the pane's
 * buttons and search box, and the leftmost crumbs collapsing first.
 */
export function paneCrumbOptions(paneWidth: number):
{
	sizes: BreadcrumbLayoutOptions;
	maxWidth: number;
	threeDotPosition: "left";
}
{
	const compact = paneWidth < 500;
	return {
		sizes:
		{
			rightMargin: compact ? 4 : 8,
			itemGap: compact ? 14 : 18,
			ellipsisWidth: 28,
		},
		maxWidth: Math.max(120, paneWidth - (compact ? 260 : 360)),
		threeDotPosition: "left",
	};
}

export interface BreadcrumbLayout
{
	calculateVisibleItems(items: CrumbInput[], maxWidth: number, zoomedIds: string[]): LayoutCrumb[];
	getItemGroups(items: LayoutCrumb[]): LayoutCrumb[][];
	getItemGroupsWithLeftOffset(groups: LayoutCrumb[][]): CrumbChunkWithOffset[];
}

const FIELD_SEPARATOR = "\u0000";
const ITEM_SEPARATOR = "\u0001";

/** A string that is equal for equal trails, so a memo can key on the trail instead of a rebuilt array. */
export function crumbInputsKey(items: readonly CrumbInput[]): string
{
	return items.map(({id, label}) => `${id}${FIELD_SEPARATOR}${label}`).join(ITEM_SEPARATOR);
}

/** The trail `crumbInputsKey` encoded. */
export function crumbInputsFromKey(key: string): CrumbInput[]
{
	if (key === "")
	{
		return [];
	}
	return key.split(ITEM_SEPARATOR).map((item) =>
	{
		const [id = "", label = ""] = item.split(FIELD_SEPARATOR);
		return {
			id,
			label,
		};
	});
}

const MIN_WIDTH_WHEN_TWO_LEFT = 48;

/** Number of collapsed runs that are followed by a visible crumb. */
function collapsedRuns(items: LayoutCrumb[]): number
{
	let run = 0;
	let runs = 0;
	for (const {group} of items)
	{
		if (group === 1)
		{
			run++;
		}
		else
		{
			if (run !== 0)
			{
				runs++;
			}
			run = 0;
		}
	}
	return runs;
}

/** The first widest entry. */
function widest(widths: number[]):
{
	index: number;
	width: number;
}
{
	let best =
	{
		index: -1,
		width: Number.NEGATIVE_INFINITY,
	};
	for (const [index, width] of widths.entries())
	{
		if (width > best.width)
		{
			best =
			{
				index,
				width,
			};
		}
	}
	return best;
}

/** Collapses the last left candidate when the right has fewer, else the first right candidate. */
function collapseOne(items: LayoutCrumb[]): LayoutCrumb[]
{
	const zoomedLeft: LayoutCrumb[] = [];
	const plainLeft: LayoutCrumb[] = [];
	const zoomedRight: LayoutCrumb[] = [];
	const plainRight: LayoutCrumb[] = [];
	let home: LayoutCrumb | undefined;
	let lastRight: LayoutCrumb | undefined;
	for (const item of items)
	{
		if (item.group === 0)
		{
			if (home === undefined)
			{
				home = item;
				continue;
			}
			(item.isZoomed ? zoomedLeft : plainLeft).push(item);
		}
		if (item.group === 2)
		{
			if (lastRight !== undefined)
			{
				(lastRight.isZoomed ? zoomedRight : plainRight).push(lastRight);
			}
			lastRight = item;
		}
	}
	const [left, right] =
		plainLeft.length > 0 || plainRight.length > 0 ? [plainLeft, plainRight] : [zoomedLeft, zoomedRight];
	const target = right.length < left.length ? left.at(-1) : right[0];
	return items.map((item) =>
		item === target
			?
				{
					...item,
					group: 1,
				}
			: item,
	);
}

function getItemGroups(items: LayoutCrumb[]): LayoutCrumb[][]
{
	const chunks: LayoutCrumb[][] = [];
	let previousCollapsed: boolean | undefined;
	for (const item of items)
	{
		const collapsed = item.group === 1;
		const last = chunks.at(-1);
		if (last !== undefined && collapsed === previousCollapsed)
		{
			last.push(item);
		}
		else
		{
			chunks.push([item]);
		}
		previousCollapsed = collapsed;
	}
	return chunks;
}

export function createBreadcrumbLayout(
	{
		itemGap = 29,
		rightMargin = 24,
		minItemWidth = 96,
		ellipsisWidth = 35,
		threeDotPosition = "middle",
	}: BreadcrumbLayoutOptions,
	measure: (label: string) => number,
): BreadcrumbLayout
{
	function itemWidth(item: LayoutCrumb): number
	{
		if (item.group === 1)
		{
			return 0;
		}
		// Upstream truthiness: a zero truncateWidth falls back to measuring.
		if (item.truncateWidth !== null && item.truncateWidth !== 0)
		{
			return item.truncateWidth;
		}
		return measure(item.label);
	}

	function totalWidth(items: LayoutCrumb[]): number
	{
		const visible = items.filter((item) => item.group !== 1).length;
		const widths = items.map(itemWidth).reduce((sum, width) => sum + width, 0);
		return widths + (visible - 1) * itemGap + (visible < items.length ? ellipsisWidth * collapsedRuns(items) : 0);
	}

	/** Shaves the widest crumb one pixel at a time until the trail fits or the widest hits `minWidth`. */
	function truncate(items: LayoutCrumb[], max: number, minWidth = minItemWidth): LayoutCrumb[]
	{
		const widths = items.map(itemWidth);
		let total = totalWidth(items);
		let target = widest(widths);
		while (total > max && target.width > minWidth)
		{
			widths[target.index] = target.width - 1;
			total--;
			target = widest(widths);
		}
		return items.map((item, i) =>
		{
			const width = widths[i] ?? itemWidth(item);
			return width < itemWidth(item)
				?
					{
						...item,
						truncateWidth: width,
					}
				: item;
		});
	}

	function fit(items: LayoutCrumb[], max: number): LayoutCrumb[]
	{
		let current = items;
		while (totalWidth(current) > max)
		{
			const truncated = truncate(current, max);
			if (totalWidth(truncated) <= max)
			{
				return truncated;
			}
			if (current.filter((item) => item.group !== 1).length <= 2)
			{
				return truncate(current, max, MIN_WIDTH_WHEN_TWO_LEFT);
			}
			current = collapseOne(current);
		}
		return current;
	}

	function calculateVisibleItems(items: CrumbInput[], maxWidth: number, zoomedIds: string[]): LayoutCrumb[]
	{
		const isLeft = (i: number): boolean => threeDotPosition === "middle" && i < items.length / 2;
		const laidOut = items.map((item, i): LayoutCrumb => (
		{
			...item,
			group: isLeft(i) ? 0 : 2,
			isZoomed: zoomedIds.includes(item.id),
			truncateWidth: null,
		}));
		return fit(laidOut, maxWidth - rightMargin);
	}

	function getItemGroupsWithLeftOffset(groups: LayoutCrumb[][]): CrumbChunkWithOffset[]
	{
		const result: CrumbChunkWithOffset[] = [];
		for (const items of groups)
		{
			const previous = result.at(-1);
			const leftOffset = previous === undefined ? 0 : previous.leftOffset + totalWidth(previous.items);
			result.push(
				{
					leftOffset,
					items,
				},
			);
		}
		return result;
	}

	return {
		calculateVisibleItems,
		getItemGroups,
		getItemGroupsWithLeftOffset,
	};
}

const MEASURE_CACHE_SIZE = 512;
const measureCache = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;

/** Rendered width of a crumb label in the body font at 14.22px, cached LRU-style. */
export function measureCrumbLabel(label: string): number
{
	const cached = measureCache.get(label);
	if (cached !== undefined)
	{
		measureCache.delete(label);
		measureCache.set(label, cached);
		return cached;
	}
	measureContext ??= document.createElement("canvas").getContext("2d");
	if (!measureContext)
	{
		return 0;
	}
	measureContext.font = `14.22px ${getComputedStyle(document.body).fontFamily}`;
	const {width} = measureContext.measureText(label);
	measureCache.set(label, width);
	if (measureCache.size > MEASURE_CACHE_SIZE)
	{
		const oldest = measureCache.keys().next().value;
		if (oldest !== undefined)
		{
			measureCache.delete(oldest);
		}
	}
	return width;
}
