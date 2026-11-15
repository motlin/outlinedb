/**
 * The layout applied under each calendar root that can still be undone (`calendar_layout_applies`): the system time
 * just before its writes, from which an undo reads the subtree as it was.
 */

import {and, eq} from "drizzle-orm";
import {calendarLayoutApplies} from "../db/schema.js";
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
