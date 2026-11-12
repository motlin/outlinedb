import {sql} from "drizzle-orm";
import type {AnySQLiteColumn} from "drizzle-orm/sqlite-core";
import type {SQL} from "drizzle-orm";
import {mirrors, nodeMetadata} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";

/**
 * SQL for a node's effective completed_at. A mirror is completed exactly when its
 * original is, so its own stored value is ignored (the public API can leave a stale
 * one on a mirror); every other node uses `ownCompletedAt`. Pass the node's id column
 * and its joined `node_metadata.completed_at` column.
 */
export function effectiveCompletedAt(idColumn: AnySQLiteColumn, ownCompletedAt: AnySQLiteColumn): SQL<Date | null>
{
	return sql<Date | null>`CASE WHEN EXISTS (SELECT 1 FROM ${mirrors} WHERE ${mirrors.mirrorId} = ${idColumn} AND ${mirrors.systemTo} = ${FAR_FUTURE_DATE})
		THEN (SELECT om.completed_at FROM ${mirrors} mi
			INNER JOIN ${nodeMetadata} om ON om.node_id = mi.original_id AND om.system_to = ${FAR_FUTURE_DATE}
			WHERE mi.mirror_id = ${idColumn} AND mi.system_to = ${FAR_FUTURE_DATE} LIMIT 1)
		ELSE ${ownCompletedAt} END`.mapWith(nodeMetadata.completedAt);
}
