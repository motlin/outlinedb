import {sql} from "drizzle-orm";
import {mirrors, nodeContent, referencesRoots} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {withdrawNodeComposites} from "./node-composite.js";
import type {UnitOfWork} from "./node-composite.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/**
 * Relationship rows that outlived what they relate. Upstream has none: deleting
 * a backlink source deletes its backlink items, and a deleted node takes its
 * mirror and references root rows with it.
 */
export interface StrandedRowCounts
{
	/** Current children of a current references root with no current mirror row naming a current original. */
	backlinkItems: number;
	/** Current mirror rows whose mirror or original is not a current node. */
	mirrors: number;
	/** Current references root rows whose node is not current. */
	referencesRoots: number;
}

const notCurrentNode = (column: unknown) =>
	sql`NOT EXISTS (SELECT 1 FROM ${nodeContent} n WHERE n.id = ${column} AND n.system_to = ${FAR_FUTURE_DATE})`;

/** The current backlink items with no current original, sorted by id. */
function strandedBacklinkItemIds(tx: TemporalTransaction): string[]
{
	return tx
		.all<
		{
			id: string;
		}>(
			sql`SELECT c.id AS id FROM ${nodeContent} c
				JOIN ${referencesRoots} r ON r.node_id = c.parent_id AND r.system_to = ${FAR_FUTURE_DATE}
				JOIN ${nodeContent} root ON root.id = r.node_id AND root.system_to = ${FAR_FUTURE_DATE}
				WHERE c.system_to = ${FAR_FUTURE_DATE}
				AND NOT EXISTS (
					SELECT 1 FROM ${mirrors} m
					JOIN ${nodeContent} o ON o.id = m.original_id AND o.system_to = ${FAR_FUTURE_DATE}
					WHERE m.mirror_id = c.id AND m.system_to = ${FAR_FUTURE_DATE}
				)
				ORDER BY c.id`,
		)
		.map((row) => row.id);
}

/** Count the stranded relationship rows; read-only. */
export function countStrandedRows(tx: TemporalTransaction): StrandedRowCounts
{
	const strandedMirrors = tx.get<
		|
		  {
				count: number;
		  }
		| undefined
	>(
		sql`SELECT COUNT(*) AS count FROM ${mirrors} WHERE ${mirrors.systemTo} = ${FAR_FUTURE_DATE}
			AND (${notCurrentNode(mirrors.mirrorId)} OR ${notCurrentNode(mirrors.originalId)})`,
	);
	const strandedRoots = tx.get<
		|
		  {
				count: number;
		  }
		| undefined
	>(
		sql`SELECT COUNT(*) AS count FROM ${referencesRoots} WHERE ${referencesRoots.systemTo} = ${FAR_FUTURE_DATE}
			AND ${notCurrentNode(referencesRoots.nodeId)}`,
	);
	return {
		backlinkItems: strandedBacklinkItemIds(tx).length,
		mirrors: strandedMirrors?.count ?? 0,
		referencesRoots: strandedRoots?.count ?? 0,
	};
}

/**
 * End every stranded backlink item's composite in the caller's unit of work,
 * as an import does once its relationships are merged, so a rebuilt cache holds
 * none (upstream has none). An item this unit of work inserted is withdrawn.
 * Returns the ended ids, sorted.
 */
export function endStrandedBacklinkItems(unitOfWork: UnitOfWork): string[]
{
	const ids = strandedBacklinkItemIds(unitOfWork.tx);
	withdrawNodeComposites(unitOfWork, ids);
	return ids;
}
