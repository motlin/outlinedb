/**
 * The layout applied under each calendar root that can still be undone (`calendar_layout_applies`): the system time
 * just before its writes, from which an undo reads the subtree as it was.
 */

import {and, eq} from "drizzle-orm";
import {calendarLayoutApplies, nodeContent} from "../db/schema.js";
import type {LayoutWrite} from "../internal/calendar-layout-apply.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {runUnitOfWork} from "./node-composite.js";
import {closeCurrentVersions} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** When the layout waiting to be undone under `rootId` was applied, or undefined when there is none. */
export function layoutAppliedAt(db: TemporalTransaction, rootId: string): string | undefined
{
	return db
		.select(
			{
				appliedAt: calendarLayoutApplies.appliedAtSystemTime,
			},
		)
		.from(calendarLayoutApplies)
		.where(and(eq(calendarLayoutApplies.rootId, rootId), eq(calendarLayoutApplies.systemTo, FAR_FUTURE_DATE)))
		.get()?.appliedAt;
}

/** Record that a layout under `rootId` was applied at `appliedAt`, replacing any earlier one there. */
export function recordLayoutApplied(db: TemporalTransaction, rootId: string, appliedAt: string): void
{
	runUnitOfWork(db, ({tx, systemTime}) =>
	{
		closeCurrentVersions(tx, calendarLayoutApplies, systemTime, eq(calendarLayoutApplies.rootId, rootId));
		tx.insert(calendarLayoutApplies)
			.values(
				{
					rootId,
					appliedAtSystemTime: appliedAt,
					systemFrom: systemTime,
					systemTo: FAR_FUTURE_DATE,
				},
			)
			.run();
	});
}

/** Phase out the applied layout under `rootId`, keeping it in history. */
export function endLayoutApplied(db: TemporalTransaction, rootId: string): void
{
	runUnitOfWork(db, ({tx, systemTime}) =>
	{
		closeCurrentVersions(tx, calendarLayoutApplies, systemTime, eq(calendarLayoutApplies.rootId, rootId));
	});
}

function isLive(db: TemporalTransaction, id: string): boolean
{
	return (
		db
			.select(
				{
					id: nodeContent.id,
				},
			)
			.from(nodeContent)
			.where(and(eq(nodeContent.id, id), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
			.get() !== undefined
	);
}

/**
 * Throw unless every node `writes` touch (each written node and every
 * parent it leaves or enters) lies under `rootId` in the local tables, or is a
 * node an earlier write in the batch creates or undeletes there. An
 * undeleted node is in the trash, so only its new parent is checked.
 */
export function assertLayoutWritesUnder(db: TemporalTransaction, rootId: string, writes: readonly LayoutWrite[]): void
{
	const verdicts = new Map<string, boolean>([[rootId, true]]);
	const cachedUnder = (id: string): boolean =>
	{
		const path: string[] = [];
		let current: string | null | undefined = id;
		let verdict = false;
		while (current !== null && current !== undefined)
		{
			const known = verdicts.get(current);
			if (known !== undefined)
			{
				verdict = known;
				break;
			}
			path.push(current);
			current = db
				.select(
					{
						parentId: nodeContent.parentId,
					},
				)
				.from(nodeContent)
				.where(and(eq(nodeContent.id, current), eq(nodeContent.systemTo, FAR_FUTURE_DATE)))
				.get()?.parentId;
		}
		for (const visited of path)
		{
			verdicts.set(visited, verdict);
		}
		return verdict;
	};
	const added = new Set<string>();
	const inside = (id: string) => added.has(id) || cachedUnder(id);
	const check = (id: string, ok: boolean) =>
	{
		if (!ok)
		{
			throw new Error(`calendar layout: a write to ${id} lies outside the calendar root ${rootId}`);
		}
	};
	for (const write of writes)
	{
		if (write.op === "move" || write.op === "delete")
		{
			check(write.from.parentId, inside(write.from.parentId));
		}
		if (write.op === "create" || write.op === "move" || write.op === "undelete")
		{
			check(write.parentId, inside(write.parentId));
		}
		if (write.op === "create" || write.op === "undelete")
		{
			check(write.id, !isLive(db, write.id) || cachedUnder(write.id));
			added.add(write.id);
		}
		else
		{
			check(write.id, inside(write.id));
		}
	}
}
