import {getTableName, inArray, sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import type {SQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import {
	accountState,
	aiMetadata,
	apiImportTimestamp,
	backlinks,
	backupImports,
	calendarLevels,
	calendarMetadata,
	changesMetadata,
	config,
	fileBlobs,
	localSettings,
	mirrors,
	nodeContent,
	nodeEmbeddings,
	nodeInternalMetadata,
	nodeMetadata,
	nodeTags,
	referencesRoots,
	s3Files,
	virtualRootIds,
} from "../db/schema.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import {assertWithinTransactionTimeout, startUnitOfWork} from "./system-time.js";
import type {UnitOfWorkStart} from "./system-time.js";
import {syncNodeTags} from "./node-tags.js";
import {closeCurrentVersions} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/**
 * A node is a composite root (https://liftwizard.io/docs/temporal-data/versioning#composites).
 * Each entry names the column that owns a row (the leading primary-key column)
 * and the node-id columns that merely reference another composite and are never
 * cascaded.
 */
export interface CompositeEntry {
	table: SQLiteTable;
	owner: SQLiteColumn;
	references: SQLiteColumn[];
}

export interface CompositePart extends CompositeEntry {
	/**
	 * References whose death also ends the row. Only mirrors: a mirror row closes
	 * when either side dies (design Q2), and import-api rebuilds it from upstream.
	 */
	endsWithReferences?: SQLiteColumn[];
	/** Non-temporal table: rows are deleted instead of closed. */
	hardDelete?: boolean;
}

export const NODE_COMPOSITE_ROOT: CompositeEntry = {
	table: nodeContent,
	owner: nodeContent.id,
	references: [nodeContent.parentId],
};

/** Every table owned by a node composite. Ending a node ends all of these rows with it. */
export const NODE_COMPOSITE_PARTS: readonly CompositePart[] = [
	{table: nodeMetadata, owner: nodeMetadata.nodeId, references: []},
	{table: calendarMetadata, owner: calendarMetadata.nodeId, references: []},
	{table: calendarLevels, owner: calendarLevels.nodeId, references: []},
	{table: nodeEmbeddings, owner: nodeEmbeddings.nodeId, references: []},
	{table: aiMetadata, owner: aiMetadata.nodeId, references: []},
	{table: s3Files, owner: s3Files.nodeId, references: []},
	{table: changesMetadata, owner: changesMetadata.nodeId, references: []},
	{table: referencesRoots, owner: referencesRoots.nodeId, references: []},
	{table: virtualRootIds, owner: virtualRootIds.nodeId, references: [virtualRootIds.virtualRootId]},
	{table: backlinks, owner: backlinks.nodeId, references: [backlinks.sourceId, backlinks.targetId]},
	{
		table: mirrors,
		owner: mirrors.mirrorId,
		references: [mirrors.originalId],
		endsWithReferences: [mirrors.originalId],
	},
	{table: nodeInternalMetadata, owner: nodeInternalMetadata.nodeId, references: [], hardDelete: true},
	// Derived from the live content and rewritten by every unit of work; ending the node drops its tags too.
	{table: nodeTags, owner: nodeTags.nodeId, references: [], hardDelete: true},
];

/** Tables outside every node composite, with the reason. */
export const NON_NODE_TABLES: Readonly<Record<string, string>> = {
	[getTableName(backupImports)]: "import bookkeeping keyed by backup filename",
	[getTableName(apiImportTimestamp)]: "import bookkeeping keyed by pipeline name",
	[getTableName(config)]: "local key-value settings",
	[getTableName(accountState)]: "account-level key-value state",
	[getTableName(localSettings)]: "durable local copy of settings written to workflowy.com",
	[getTableName(fileBlobs)]: "local copies of attachment bytes, kept after the attachment's node ends",
};

/** Columns named like node ids that hold something else, with the reason. */
export const NON_NODE_ID_COLUMNS: Readonly<Record<string, string>> = {
	"node_metadata.short_id": "the owner's own id suffix, not a link to another node",
	"calendar_metadata.date_id": "a calendar date number, not a node id",
};

/**
 * One logical operation: one transaction and one system time. Every row it ends
 * gets `systemTime` as `system_to` and every row it inserts gets it as
 * `system_from`, across every table and composite it touches.
 */
export interface UnitOfWork {
	tx: TemporalTransaction;
	systemTime: string;
}

/**
 * Run `work` as one unit of work: one transaction, one system time read once
 * from the application's UTC clock (or `start` when given, for a unit split
 * across several transactions). Before committing it rewrites the derived
 * `node_tags` of every node it touched. A throw rolls back every composite the work
 * touched, and so does finishing past {@link TRANSACTION_TIMEOUT_MS} after the
 * start, which throws {@link TransactionTimeoutError}.
 */
export function runUnitOfWork<T>(
	database: TemporalTransaction,
	work: (unitOfWork: UnitOfWork) => T,
	start: UnitOfWorkStart = startUnitOfWork(),
): T {
	return database.transaction((tx) => {
		const result = work({tx, systemTime: start.systemTime});
		syncNodeTags(tx, start.systemTime);
		assertWithinTransactionTimeout(start);
		return result;
	});
}

const ID_BATCH_SIZE = 500;

const ROOT_AND_PARTS: readonly CompositePart[] = [NODE_COMPOSITE_ROOT, ...NODE_COMPOSITE_PARTS];

function endRows(unitOfWork: UnitOfWork, part: CompositePart, where: SQL): void {
	const {tx, systemTime} = unitOfWork;
	if (part.hardDelete) {
		tx.run(sql`DELETE FROM ${part.table} WHERE ${where}`);
		return;
	}
	closeCurrentVersions(tx, part.table, systemTime, where);
}

/**
 * End the composites rooted at `nodeIds`: close each node's content, metadata
 * and every owned part at the unit of work's system time. Rows of other nodes
 * that merely reference these ids are left alone, except mirror rows, which
 * close when either side dies.
 */
export function endNodeComposites(unitOfWork: UnitOfWork, nodeIds: readonly string[]): void {
	for (let start = 0; start < nodeIds.length; start += ID_BATCH_SIZE) {
		const batch = nodeIds.slice(start, start + ID_BATCH_SIZE);
		for (const part of ROOT_AND_PARTS) {
			const columns = [part.owner, ...(part.endsWithReferences ?? [])];
			endRows(
				unitOfWork,
				part,
				sql.join(
					columns.map((column) => inArray(column, batch)),
					sql` OR `,
				),
			);
		}
	}
}

/**
 * End every owned row whose owner (or, for mirrors, original) has no current
 * node. The sweep after a global merge, in the caller's unit of work.
 */
export function endOrphanedParts(unitOfWork: UnitOfWork): void {
	for (const part of NODE_COMPOSITE_PARTS) {
		const columns = [part.owner, ...(part.endsWithReferences ?? [])];
		const orphaned = columns.map(
			(column) =>
				sql`NOT EXISTS (SELECT 1 FROM ${nodeContent} WHERE ${nodeContent.id} = ${column} AND ${nodeContent.systemTo} = ${FAR_FUTURE_DATE})`,
		);
		endRows(unitOfWork, part, sql.join(orphaned, sql` OR `));
	}
}
