import {and, eq} from "drizzle-orm";
import {treeTransactions} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {runUnitOfWork} from "./node-composite.js";
import type {UnitOfWork} from "./node-composite.js";
import {temporalMerge} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/**
 * `tree_transactions` id of the main tree, whose transaction id the cache is
 * current to: the edge tables match upstream as of this transaction, and every
 * `/push_and_poll` starts from it.
 */
export const MAIN_TREE_ID = "main";

/** The stored tree transaction id, or undefined before the first whole-tree import. */
export function readTreeTxId(tx: TemporalTransaction): string | undefined
{
	return tx
		.select(
			{
				transactionId: treeTransactions.transactionId,
			},
		)
		.from(treeTransactions)
		.where(and(eq(treeTransactions.treeId, MAIN_TREE_ID), eq(treeTransactions.systemTo, FAR_FUTURE_DATE)))
		.get()?.transactionId;
}

const byTree = (row: {treeId: string}) => row.treeId;

/** Replace the stored tree transaction id, as a whole-tree import does, in the caller's unit of work. */
export function replaceTreeTxId({tx, systemTime}: UnitOfWork, txId: string): void
{
	temporalMerge(
		tx,
		{
			table: treeTransactions,
			keyColumn: treeTransactions.treeId,
			incomingKey: byTree,
			currentKey: byTree,
			contentMatches: (
				current:
				{
					transactionId: string;
				},
				incoming:
				{
					transactionId: string;
				},
			) => current.transactionId === incoming.transactionId,
			buildInsertRow: (row) => (
			{
				treeId: row.treeId,
				transactionId: row.transactionId,
			}),
		},
		[
			{
				treeId: MAIN_TREE_ID,
				transactionId: txId,
			},
		],
		tx
			.select(
				{
					treeId: treeTransactions.treeId,
					transactionId: treeTransactions.transactionId,
				},
			)
			.from(treeTransactions)
			.where(and(eq(treeTransactions.treeId, MAIN_TREE_ID), eq(treeTransactions.systemTo, FAR_FUTURE_DATE)))
			.all(),
		systemTime,
	);
}

/**
 * Store `txId` unless the stored id is already larger, in the caller's unit of
 * work. Only ids the server returned are ever stored, so with CLI and web
 * processes sharing one cache the larger id is always the later point in the
 * tree's log.
 */
export function advanceTreeTxId(unitOfWork: UnitOfWork, txId: string): void
{
	const current = readTreeTxId(unitOfWork.tx);
	if (current === undefined || BigInt(txId) > BigInt(current))
	{
		replaceTreeTxId(unitOfWork, txId);
	}
}

/** {@link replaceTreeTxId} in a unit of work of its own, for a seed outside any import. */
export function storeTreeTxId(database: TemporalTransaction, txId: string): void
{
	runUnitOfWork(database, (unitOfWork) =>
	{
		replaceTreeTxId(unitOfWork, txId);
	});
}
