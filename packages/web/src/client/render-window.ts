import type {NodeResponse} from "../node-types.js";
import {isPotentiallyVisible} from "./tree-ops.js";
import {sortByPriority} from "./tree-position.js";
import type {SearchFilter} from "./search-filter.js";
import type {MirrorInstance} from "../mirror-path.js";
import {childInstance, expansionId, instanceKey, isCyclical} from "../mirror-path.js";
import {isSearchExpanded, searchShowsCompleted, searchShowsNode} from "./search-filter.js";

/**
 * Row windowing, after upstream `WF.VirtualScrolling.useMaxToRender` / `useScrollableItem`: one row budget for the
 * whole outline, spent depth-first in document order, so a tree with thousands of visible rows (a broad search, a
 * deeply expanded page) mounts, and on Back unmounts, a bounded number of them. Upstream starts at a viewport of
 * minimal-height rows and adds 24 rows per screen scrolled; the local sentinel after the last row adds one step each
 * time it scrolls into view.
 */
const MINIMAL_ROW_HEIGHT = 24;
const ROW_STEP = 24;

/** A viewport of minimal-height rows plus one step of slack below the fold. */
export function initialRowBudget(viewportHeight: number): number
{
	return Math.ceil(viewportHeight / MINIMAL_ROW_HEIGHT) + ROW_STEP;
}

/**
 * The rows a new view mounts in the commit that swaps it in: just a viewport of minimal-height rows. The step of
 * slack below the fold (`initialRowBudget`) mounts after that paint, so the swap's frame does not pay for rows
 * nobody sees yet. An unknown viewport (no window) gets one step.
 */
export function firstPaintRowBudget(viewportHeight: number): number
{
	return Math.max(ROW_STEP, Math.ceil(viewportHeight / MINIMAL_ROW_HEIGHT));
}

/** Upstream's `appState.printing ? Infinity : maxToRender`: a print renders every row. */
export function printRowBudget(rows: number, printing: boolean): number
{
	return printing ? Number.POSITIVE_INFINITY : rows;
}

export function nextRowBudget(current: number): number
{
	return current + ROW_STEP;
}

/** What decides which rows the outline shows: expansion and completion, or the search while one is applied. */
export interface RowView
{
	expandedIds: ReadonlySet<string>;
	showCompleted: boolean;
	animatingCompletionIds: ReadonlySet<string>;
	search: SearchFilter | null;
}

/** Whether `node` renders as a row: completion visibility, then the search filter when one is applied. */
function rendersRow(
	node: NodeResponse,
	showCompleted: boolean,
	animatingCompletionIds: ReadonlySet<string>,
	search: SearchFilter | null,
): boolean
{
	return (
		isPotentiallyVisible(node, searchShowsCompleted(showCompleted, search), animatingCompletionIds) &&
		(search === null || searchShowsNode(node, search))
	);
}

/**
 * The ids of `nodes` a sibling-focus command can reach, in priority order: the rows that render, so a search that hides
 * a sibling (or completion that hides one) never gets the caret.
 */
export function focusableSiblingIds(
	nodes: readonly NodeResponse[] | undefined,
	view:
	{
		showCompleted: boolean;
		animatingCompletionIds: ReadonlySet<string>;
		search: SearchFilter | null;
	},
): string[]
{
	return sortByPriority([...(nodes ?? [])])
		.filter((node) => rendersRow(node, view.showCompleted, view.animatingCompletionIds, view.search))
		.map((node) => node.id);
}

/**
 * Whether `node` renders as a row in `instance`: as `rendersRow`, but a cyclical mirror instance is never a search
 * match (upstream `isSearchable` is false for it), so a search leaves it out.
 */
export function rendersInstanceRow(
	node: NodeResponse,
	instance: MirrorInstance | null,
	showCompleted: boolean,
	animatingCompletionIds: ReadonlySet<string>,
	search: SearchFilter | null,
): boolean
{
	return (
		rendersRow(node, showCompleted, animatingCompletionIds, search) &&
		(search === null || !isCyclical(node, instance))
	);
}

/**
 * Whether `node`'s children render in `instance`: the search's expansion during a search, else the row's own expansion,
 * which is per mirror instance (a row inside a mirror is collapsed until that instance is expanded).
 */
export function rendersInstanceChildren(
	node: NodeResponse,
	instance: MirrorInstance | null,
	expandedIds: ReadonlySet<string>,
	search: SearchFilter | null,
): boolean
{
	return search === null ? expandedIds.has(expansionId(node.id, instance)) : isSearchExpanded(node.id, search);
}

export interface RowLimits
{
	/** How many of each loaded, rendered parent's visible children render. */
	limits: ReadonlyMap<string | null, number>;
	/** The budget left after every loaded row, for a parent whose children have not loaded yet. */
	remaining: number;
}

/** Spends `budget` rows depth-first over the loaded tree under `rootId`, filtering rows as `OutlineChildren` does. */
export function rowLimits(
	getChildren: (parentId: string | null) => NodeResponse[] | undefined,
	rootId: string | null,
	budget: number,
	{expandedIds, showCompleted, animatingCompletionIds, search}: RowView,
): RowLimits
{
	const limits = new Map<string | null, number>();
	let used = 0;
	const visit = (parentId: string | null, instance: MirrorInstance | null) =>
	{
		const children = getChildren(parentId);
		if (children === undefined)
		{
			return;
		}
		let count = 0;
		for (const node of children)
		{
			if (used >= budget)
			{
				break;
			}
			if (!rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search))
			{
				continue;
			}
			used += 1;
			count += 1;
			if (rendersInstanceChildren(node, instance, expandedIds, search))
			{
				visit(node.id, childInstance(node, instance));
			}
		}
		limits.set(instanceKey(parentId, instance), count);
	};
	visit(rootId, null);
	return {
		limits,
		remaining: budget - used,
	};
}

/**
 * The parents whose children the view under `rootId` renders within `budget` rows, in document order (the root first),
 * filtering rows as `rowLimits` does; undefined when one of them has not loaded its children yet.
 */
export function viewParentIds(
	getChildren: (parentId: string | null) => NodeResponse[] | undefined,
	rootId: string | null,
	budget: number,
	{expandedIds, showCompleted, animatingCompletionIds, search}: RowView,
): (string | null)[] | undefined
{
	const parentIds: (string | null)[] = [];
	let used = 0;
	const visit = (parentId: string | null, instance: MirrorInstance | null): boolean =>
	{
		parentIds.push(parentId);
		const children = getChildren(parentId);
		if (children === undefined)
		{
			return false;
		}
		for (const node of children)
		{
			if (used >= budget)
			{
				return true;
			}
			if (!rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search))
			{
				continue;
			}
			used += 1;
			if (
				rendersInstanceChildren(node, instance, expandedIds, search) &&
				!visit(node.id, childInstance(node, instance))
			)
			{
				return false;
			}
		}
		return true;
	};
	return visit(rootId, null) ? parentIds : undefined;
}

/**
 * The budget that renders `targetId`'s row: `budget` grown a step at a time until it reaches the row's place in
 * document order, or `budget` itself when the row already renders or does not show at all. Arrow keys move the caret
 * through cached rows, not mounted ones, so a move past the last mounted row grows the budget instead of waiting for
 * a scroll to reach the sentinel.
 */
export function rowBudgetToShow(
	getChildren: (parentId: string | null) => NodeResponse[] | undefined,
	rootId: string | null,
	budget: number,
	{expandedIds, showCompleted, animatingCompletionIds, search}: RowView,
	targetId: string,
): number
{
	let position = 0;
	const find = (parentId: string | null, instance: MirrorInstance | null): boolean =>
	{
		for (const node of getChildren(parentId) ?? [])
		{
			if (!rendersInstanceRow(node, instance, showCompleted, animatingCompletionIds, search))
			{
				continue;
			}
			position += 1;
			if (
				node.id === targetId ||
				(rendersInstanceChildren(node, instance, expandedIds, search) &&
					find(node.id, childInstance(node, instance)))
			)
			{
				return true;
			}
		}
		return false;
	};
	if (!find(rootId, null) || position <= budget)
	{
		return budget;
	}
	return budget + Math.ceil((position - budget) / ROW_STEP) * ROW_STEP;
}

/**
 * The rows the parent may render: its share when loaded, else whatever budget is left. `key` is `instanceKey`, so a
 * parent shown at several places inside mirrors has a share for each.
 */
export function rowLimit(limits: RowLimits, key: string | null): number
{
	return limits.limits.get(key) ?? limits.remaining;
}

/** A value that changes exactly when some parent's limit or the remaining budget does. */
export function rowLimitsKey({limits, remaining}: RowLimits): string
{
	return `${remaining}|${[...limits].map(([id, limit]) => `${id}:${limit}`).join(",")}`;
}
