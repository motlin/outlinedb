/**
 * Which cached rows changed since a system time, for caches that patch themselves after a write
 * instead of reloading the whole tree. Every cache write versions rows bitemporally: it opens a row
 * at its system time and closes the replaced one at the same time, so the rows a write touched are
 * exactly those with `system_from` or a closing `system_to` after the cache's last system time.
 */

import
{
	bulkImportLeaseStart,
	closedVersionLiteral,
	currentVersion,
	inIds,
	newSystemTimestamp,
	TRANSACTION_TIMEOUT_MS,
} from "@outlinedb/shared/cache";
import {aiMetadata, mirrors, nodeContent, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";
import {temporalTimestampJustBefore} from "@outlinedb/shared/temporal";
import {and, gt, inArray, max} from "drizzle-orm";
import type {AnySQLiteColumn, SQLiteTable} from "drizzle-orm/sqlite-core";
import type {AppDatabase} from "@outlinedb/shared/db";

type Database = AppDatabase;

/** A system-versioned table: every row is open from `system_from` until `system_to`. */
type VersionedTable = SQLiteTable &
{
	systemFrom: AnySQLiteColumn;
	systemTo: AnySQLiteColumn;
};

/** The tables whose changes reach a node's search row, each with the column naming its node. */
const SEARCH_ROW_TABLES: readonly [VersionedTable, AnySQLiteColumn][] = [
	[nodeContent, nodeContent.id],
	[nodeMetadata, nodeMetadata.nodeId],
	[mirrors, mirrors.mirrorId],
	[referencesRoots, referencesRoots.nodeId],
	[aiMetadata, aiMetadata.nodeId],
];

/**
 * The newest system time any node, metadata, mirror, references-root or AI-metadata row was opened or closed at.
 * Separate queries per table and column, each an index lookup: a Durable Object's SQLite rejects compound selects
 * with more than a few terms.
 */
export function latestSystemTime(database: Database): number
{
	let latest = 0;
	for (const [table] of SEARCH_ROW_TABLES)
	{
		const opened = database
			.select(
				{
					at: max(table.systemFrom),
				},
			)
			.from(table)
			.get()?.at;
		const closed = database
			.select(
				{
					at: max(table.systemTo),
				},
			)
			.from(table)
			.where(closedVersionLiteral(table))
			.get()?.at;
		for (const at of [opened, closed])
		{
			if (typeof at === "number" && at > latest)
			{
				latest = at;
			}
		}
	}
	return latest;
}

/**
 * The system time to read changes from for a cache built at `latest`. A writer can take its system time up to
 * {@link TRANSACTION_TIMEOUT_MS} before it commits, so a cache built between the two would otherwise miss that write.
 * Re-reading that window is cheap and patching a row twice is harmless.
 */
export function changesSince(latest: number): number
{
	return latest - TRANSACTION_TIMEOUT_MS * 1000;
}

/**
 * The ids of `table` rows opened or closed after `since`, possibly repeated. UNION ALL keeps each leg a range
 * seek on its system-time index; a deduplicating UNION lets newer SQLite plan a merge over a full key scan.
 */
function changedIn(database: Database, table: VersionedTable, id: AnySQLiteColumn, since: number)
{
	return database
		.select(
			{
				id,
			},
		)
		.from(table)
		.where(gt(table.systemFrom, since))
		.unionAll(
			database
				.select(
					{
						id,
					},
				)
				.from(table)
				.where(and(closedVersionLiteral(table), gt(table.systemTo, since))),
		);
}

/** The live mirrors of the nodes `content` names, whose search rows show their original's text. */
function mirrorsOf(database: Database, content: ReturnType<typeof changedIn>)
{
	const changed = database.$with("content").as(content);
	return database
		.with(changed)
		.select(
			{
				id: mirrors.mirrorId,
			},
		)
		.from(mirrors)
		.where(
			and(
				currentVersion(mirrors),
				inArray(
					mirrors.originalId,
					database
						.select(
							{
								id: changed.id,
							},
						)
						.from(changed),
				),
			),
		);
}

/**
 * Ids of nodes whose search row may have changed after `since`, or undefined when more than `limit` did:
 * changed content, metadata, mirror links, references roots or AI metadata, plus live mirrors of a changed original
 * (a mirror shows its original's text). Each leg is its own query, because a Durable Object's SQLite rejects
 * compound selects with more than a few terms.
 */
export function changedNodeIds(database: Database, since: number, limit: number): Set<string> | undefined
{
	const ids = new Set<string>();
	// Each leg repeats a node per version it opened or closed, so the limit counts distinct ids.
	const collect = (query: ReturnType<typeof changedIn> | ReturnType<typeof mirrorsOf>): boolean =>
	{
		const changed = query.as("changed");
		const rows = database
			.selectDistinct(
				{
					id: changed.id,
				},
			)
			.from(changed)
			.limit(limit + 1)
			.all();
		for (const {id} of rows)
		{
			ids.add(String(id));
		}
		return rows.length <= limit && ids.size <= limit;
	};
	const content = changedIn(database, nodeContent, nodeContent.id, since);
	const others = SEARCH_ROW_TABLES.slice(1).map(([table, id]) => changedIn(database, table, id, since));
	return collect(content) && collect(mirrorsOf(database, content)) && others.every((query) => collect(query))
		? ids
		: undefined;
}

/** Run `read` in one transaction, so every query in it sees the same committed state. */
export function readConsistently<T>(database: Database, read: () => T): T
{
	return database.transaction(() => read());
}

/**
 * The nodes changes feed's watermark, following Reladomo's change notification: the clock less
 * {@link TRANSACTION_TIMEOUT_MS}. A unit of work that would commit later than that after reading its system time rolls
 * back, so every row stamped at or before the watermark has already committed or never will; a reader that next asks
 * for rows opened or closed after it cannot miss a late commit. The price is re-reading the last timeout window.
 * A bulk import may run longer, so while its lease is open the watermark stays a microsecond before the lease, and
 * the import's rows, all stamped at or after the lease, land after it.
 */
export function changeWatermark(database: Database): number
{
	const watermark = newSystemTimestamp() - TRANSACTION_TIMEOUT_MS * 1000;
	const lease = bulkImportLeaseStart(database);
	if (lease === undefined)
	{
		return watermark;
	}
	const beforeLease = temporalTimestampJustBefore(lease);
	return beforeLease < watermark ? beforeLease : watermark;
}

/** A {@link changeWatermark} as clients send it back: its microseconds in decimal. */
const WATERMARK = /^\d{1,16}$/u;

/** What changed after a {@link changeWatermark}. */
export interface ChangesAfter
{
	/** The changed node ids, each once, plus live mirrors of a changed original (a mirror shows its original's text). */
	ids: Set<string>;
	/** The parents of changed node_content versions closed after the watermark: what a move or delete left. */
	formerParents: Set<string | null>;
}

/**
 * {@link ChangesAfter} the watermark `mark`, or undefined when the client must refetch everything instead: the
 * watermark is not one this server issued (not a decimal system time, or past the current watermark), or more than `limit`
 * nodes changed. Rows re-read from the last timeout window repeat across polls; the id set reports each node once.
 */
export function changesAfter(database: Database, mark: string, limit: number): ChangesAfter | undefined
{
	const after = Number(mark);
	if (!WATERMARK.test(mark) || after > changeWatermark(database))
	{
		return undefined;
	}
	const ids = changedNodeIds(database, after, limit);
	if (ids === undefined)
	{
		return undefined;
	}
	const former = database
		.selectDistinct(
			{
				parentId: nodeContent.parentId,
			},
		)
		.from(nodeContent)
		.where(and(closedVersionLiteral(nodeContent), gt(nodeContent.systemTo, after), inIds(nodeContent.id, [...ids])))
		.all();
	return {
		ids,
		formerParents: new Set(former.map((row) => row.parentId)),
	};
}

/** Each live node of `ids` with its current parent (null: Home), in one query: the id set is one JSON parameter. */
export function liveParents(database: Database, ids: readonly string[]): Map<string, string | null>
{
	const live = database
		.select(
			{
				id: nodeContent.id,
				parentId: nodeContent.parentId,
			},
		)
		.from(nodeContent)
		.where(and(currentVersion(nodeContent), inIds(nodeContent.id, ids)))
		.all();
	return new Map(live.map((row) => [row.id, row.parentId]));
}
