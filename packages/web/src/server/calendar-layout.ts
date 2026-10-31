/**
 * The 📆 Calendar root's subtree as the snapshot upstream's Calendar Layout
 * restructure (`JX4`) walks, read from the cache. Level nodes are read in
 * full; a day's children only as placeholders (the restructure never looks
 * inside a day, but files nodes at its end); the root's other children are
 * read in full, since dated nodes are searched for inside them.
 */

import {and, eq} from "drizzle-orm";
import {calendarLevels} from "@workflowy/shared/db";
import {FAR_FUTURE_DATE} from "@workflowy/shared/temporal";
import type {
	CalendarLayoutLevels,
	CalendarLayoutSnapshot,
	LayoutNode,
	WorkflowyInternalAdapter,
} from "@workflowy/shared/internal";
import type {Node} from "@workflowy/shared/types";
import {findTaggedCalendarRoot, loadCalendarInfo} from "./calendar-day.js";
import type {CalendarDayDeps} from "./calendar-day.js";
import type {ServerContext} from "./context.js";

function rootLevels(deps: Pick<CalendarDayDeps, "db">, rootId: string): CalendarLayoutLevels | undefined {
	const row = deps.db
		.select()
		.from(calendarLevels)
		.where(and(eq(calendarLevels.nodeId, rootId), eq(calendarLevels.systemTo, FAR_FUTURE_DATE)))
		.get();
	if (row === undefined) {
		return undefined;
	}
	const levels: CalendarLayoutLevels = {};
	for (const level of ["day", "week", "month", "year"] as const) {
		if (row[level] !== null) {
			levels[level] = row[level] === 1;
		}
	}
	return levels;
}

/**
 * The calendar snapshot under `explicitRootId` (a sandbox copy), else under the tagged root; undefined when that root
 * is not cached or no root is tagged in the cached internal metadata.
 */
export function loadCalendarLayout(
	deps: Pick<CalendarDayDeps, "db" | "cache">,
	explicitRootId?: string,
): CalendarLayoutSnapshot | undefined {
	const rootId = explicitRootId ?? findTaggedCalendarRoot(deps);
	const rootNode = rootId === undefined ? undefined : deps.cache.getNode(rootId);
	if (rootId === undefined || rootNode === undefined) {
		return undefined;
	}
	const toLayout = (nodes: Node[]): LayoutNode[] => {
		// Only stored metadata: applying reads it from the internal API, where a day-named node is no day unless tagged.
		const info = loadCalendarInfo(deps, nodes, {fromNames: false});
		return nodes.map((node) => {
			const calendar = info.get(node.id);
			const level = calendar?.level ?? undefined;
			const dateId = calendar?.dateId ?? undefined;
			const isLevel = level !== undefined && dateId !== undefined;
			const children = deps.cache.getChildren(node.id);
			return {
				id: node.id,
				name: node.name ?? "",
				note: node.note ?? "",
				...(isLevel ? {calendar: {level, dateId}} : {}),
				...(node.mirror.isMirror ? {isMirror: true} : {}),
				children:
					isLevel && level === "day"
						? children.map((child) => ({id: child.id, name: "", note: "", children: []}))
						: toLayout(children),
			};
		});
	};
	return {
		root: {
			id: rootId,
			name: rootNode.name ?? "",
			note: rootNode.note ?? "",
			children: toLayout(deps.cache.getChildren(rootId)),
		},
		levels: rootLevels(deps, rootId),
	};
}

/**
 * Re-applies the tagged calendar root's current levels so week nodes move to the new week start: upstream does this
 * when Start of week changes under a week-level calendar. Does nothing when layouts are disabled, no cached root is
 * tagged, or the root has no week level.
 */
export async function reapplyWeekLayout(ctx: ServerContext, adapter: WorkflowyInternalAdapter): Promise<void> {
	if (ctx.calendarLayoutEnabled === false) {
		return;
	}
	const deps = {db: ctx.db, cache: ctx.cacheService};
	const rootId = findTaggedCalendarRoot(deps);
	const levels = rootId === undefined ? undefined : loadCalendarLayout(deps, rootId)?.levels;
	if (rootId === undefined || levels?.week !== true) {
		return;
	}
	await adapter.applyCalendarLayout(levels, {rootId, loadSnapshot: () => loadCalendarLayout(deps, rootId)});
}
