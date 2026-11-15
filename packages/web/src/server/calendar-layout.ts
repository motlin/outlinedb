/**
 * The 📆 Calendar root's subtree as the snapshot upstream's Calendar Layout
 * restructure (`JX4`) walks, read from the cache. Level nodes are read in
 * full; a day's children only as placeholders (the restructure never looks
 * inside a day, but files nodes at its end); the root's other children are
 * read in full, since dated nodes are searched for inside them.
 */

import {and, eq} from "drizzle-orm";
import {calendarLevels} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {CalendarLayoutLevels, CalendarLayoutSnapshot, LayoutNode} from "@outlinedb/shared/internal";
import {LocalCalendar} from "@outlinedb/shared/local-calendar";
import type {Node} from "@outlinedb/shared/types";
import {findTaggedCalendarRoot, loadCalendarInfo} from "./calendar-day.js";
import type {CalendarDayDeps} from "./calendar-day.js";
import type {ServerContext} from "./context.js";
import {getAdapter, mirrorOutbox} from "./ops/nodes-shared.js";

function rootLevels(deps: Pick<CalendarDayDeps, "db">, rootId: string): CalendarLayoutLevels | undefined
{
	const row = deps.db
		.select()
		.from(calendarLevels)
		.where(and(eq(calendarLevels.nodeId, rootId), eq(calendarLevels.systemTo, FAR_FUTURE_DATE)))
		.get();
	if (row === undefined)
	{
		return undefined;
	}
	const levels: CalendarLayoutLevels = {};
	for (const level of ["day", "week", "month", "year"] as const)
	{
		if (row[level] !== null)
		{
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
): CalendarLayoutSnapshot | undefined
{
	const rootId = explicitRootId ?? findTaggedCalendarRoot(deps);
	const rootNode = rootId === undefined ? undefined : deps.cache.getNode(rootId);
	if (rootId === undefined || rootNode === undefined)
	{
		return undefined;
	}
	const toLayout = (nodes: Node[]): LayoutNode[] =>
	{
		// Only stored metadata: applying reads it from the internal API, where a day-named node is no day unless tagged.
		const info = loadCalendarInfo(
			deps,
			nodes,
			{
				fromNames: false,
			},
		);
		return nodes.map((node) =>
		{
			const calendar = info.get(node.id);
			const level = calendar?.level ?? undefined;
			const dateId = calendar?.dateId ?? undefined;
			const isLevel = level !== undefined && dateId !== undefined;
			const children = deps.cache.getChildren(node.id);
			return {
				id: node.id,
				name: node.name ?? "",
				note: node.note ?? "",
				...(isLevel
					?
						{
							calendar:
							{
								level,
								dateId,
							},
						}
					: {}),
				...(node.mirror.isMirror
					?
						{
							isMirror: true,
						}
					: {}),
				children:
					isLevel && level === "day"
						? children.map((child) => (
							{
								id: child.id,
								name: "",
								note: "",
								children: [],
							}))
						: toLayout(children),
			};
		});
	};
	return {
		root:
		{
			id: rootId,
			name: rootNode.name ?? "",
			note: rootNode.note ?? "",
			children: toLayout(deps.cache.getChildren(rootId)),
		},
		levels: rootLevels(deps, rootId),
	};
}

/**
 * What writes the calendar: the local tables in both modes. A mirror's writes also record outbox rows, which a drain
 * delivers to workflowy.com, and its account state (root metadata, the entropy key) still comes from the internal API.
 * Undefined for a mirror without the internal API, which reads that account state and drains its outbox.
 */
export function calendarWriter(ctx: ServerContext): LocalCalendar | undefined
{
	if (ctx.mode === "standalone")
	{
		return new LocalCalendar(ctx.db);
	}
	const adapter = getAdapter(ctx);
	return adapter === undefined
		? undefined
		: new LocalCalendar(
				ctx.db,
				{
					outbox: mirrorOutbox(ctx),
					account: adapter,
					createRoot: false,
				},
			);
}

/**
 * Re-applies the tagged calendar root's current levels so week nodes move to the new week start: upstream does this
 * when Start of week changes under a week-level calendar. Does nothing when layouts are disabled, no cached root is
 * tagged, the root has no week level, or a mirror has no internal API.
 */
export async function reapplyWeekLayout(ctx: ServerContext): Promise<void>
{
	const writer = calendarWriter(ctx);
	if (ctx.calendarLayoutEnabled === false || writer === undefined)
	{
		return;
	}
	const deps =
	{
		db: ctx.db,
		cache: ctx.cacheService,
	};
	const rootId = findTaggedCalendarRoot(deps);
	const levels = rootId === undefined ? undefined : loadCalendarLayout(deps, rootId)?.levels;
	if (rootId === undefined || levels?.week !== true)
	{
		return;
	}
	await writer.applyCalendarLayout(
		levels,
		{
			rootId,
			loadSnapshot: () => loadCalendarLayout(deps, rootId),
		},
	);
}
