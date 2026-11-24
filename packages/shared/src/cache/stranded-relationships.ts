import {and, count, eq, notExists, or, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import {alias} from "drizzle-orm/sqlite-core";
import type {SQLiteColumn} from "drizzle-orm/sqlite-core";
import {mirrors, nodeContent, referencesRoots} from "../db/schema.js";
import {currentVersion} from "./cache-temporal.js";
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

const n = alias(nodeContent, "n");
const c = alias(nodeContent, "c");
const r = alias(referencesRoots, "r");
const root = alias(nodeContent, "root");
const m = alias(mirrors, "m");
const o = alias(nodeContent, "o");

function notCurrentNode(tx: TemporalTransaction, column: SQLiteColumn): SQL
{
	return notExists(
		tx
			.select(
				{
					one: sql`1`,
				},
			)
			.from(n)
			.where(and(eq(n.id, column), currentVersion(n))),
	);
}

/** The current backlink items with no current original, sorted by id. */
function strandedBacklinkItemIds(tx: TemporalTransaction): string[]
{
	return tx
		.select(
			{
				id: c.id,
			},
		)
		.from(c)
		.innerJoin(r, and(eq(r.nodeId, c.parentId), currentVersion(r)))
		.innerJoin(root, and(eq(root.id, r.nodeId), currentVersion(root)))
		.where(
			and(
				currentVersion(c),
				notExists(
					tx
						.select(
							{
								one: sql`1`,
							},
						)
						.from(m)
						.innerJoin(o, and(eq(o.id, m.originalId), currentVersion(o)))
						.where(and(eq(m.mirrorId, c.id), currentVersion(m))),
				),
			),
		)
		.orderBy(c.id)
		.all()
		.map((row) => row.id);
}

/** Count the stranded relationship rows; read-only. */
export function countStrandedRows(tx: TemporalTransaction): StrandedRowCounts
{
	const strandedMirrors = tx
		.select(
			{
				count: count(),
			},
		)
		.from(mirrors)
		.where(
			and(
				currentVersion(mirrors),
				or(notCurrentNode(tx, mirrors.mirrorId), notCurrentNode(tx, mirrors.originalId)),
			),
		)
		.get();
	const strandedRoots = tx
		.select(
			{
				count: count(),
			},
		)
		.from(referencesRoots)
		.where(and(currentVersion(referencesRoots), notCurrentNode(tx, referencesRoots.nodeId)))
		.get();
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
