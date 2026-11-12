/**
 * Which cached rows changed since a system time, for caches that patch themselves after a write
 * instead of reloading the whole tree. Every cache write versions rows bitemporally: it opens a row
 * at its system time and closes the replaced one at the same time, so the rows a write touched are
 * exactly those with `system_from` or a closing `system_to` after the cache's last system time.
 */

import {bulkImportLeaseStart, TRANSACTION_TIMEOUT_MS} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import {sql} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import type {AppDatabase} from "@outlinedb/shared/db";

type Database = AppDatabase;

/**
 * Closed rows, as a literal so the partial `*_closed_at_idx` indexes (whose WHERE is this same term) apply;
 * SQLite matches a partial index's WHERE only against literal terms, never bound parameters.
 */
const CLOSED = sql.raw(`system_to < '${FAR_FUTURE_DATE}'`);

/**
 * The newest system time any node, metadata, mirror, references-root or AI-metadata row was opened or closed at.
 * One query per table and column: a Durable Object's SQLite rejects compound selects with more than a few terms.
 */
export function latestSystemTime(database: Database): string
{
	let latest = "";
	for (const table of ["node_content", "node_metadata", "mirrors", "references_roots", "ai_metadata"])
	{
		const name = sql.identifier(table);
		const {opened, closed} = database.get<
		{
			opened: string | null;
			closed: string | null;
		}>(sql`
			SELECT
				(SELECT max(system_from) FROM ${name}) AS opened,
				(SELECT max(system_to) FROM ${name} WHERE ${CLOSED}) AS closed
		`);
		for (const at of [opened, closed])
		{
			if (at !== null && at > latest)
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
export function changesSince(latest: string): string
{
	const ms = Date.parse(`${latest.replace(" ", "T")}Z`);
	return Number.isNaN(ms) ? "" : formatTemporalTimestamp(new Date(ms - TRANSACTION_TIMEOUT_MS));
}

/**
 * The ids of `table` rows opened or closed after `since`, possibly repeated. UNION ALL keeps each leg a range
 * seek on its system-time index; a deduplicating UNION lets newer SQLite plan a merge over a full key scan.
 */
function changedIn(table: string, column: string, since: string): SQL
{
	const name = sql.identifier(table);
	const id = sql.identifier(column);
	return sql`
		SELECT ${id} AS id FROM ${name} WHERE system_from > ${since}
		UNION ALL SELECT ${id} FROM ${name} WHERE ${CLOSED} AND system_to > ${since}
	`;
}

/**
 * Ids of nodes whose search row may have changed after `since`, or undefined when more than `limit` did:
 * changed content, metadata, mirror links, references roots or AI metadata, plus live mirrors of a changed original
 * (a mirror shows its original's text). Each leg is its own query, because a Durable Object's SQLite rejects
 * compound selects with more than a few terms.
 */
export function changedNodeIds(database: Database, since: string, limit: number): Set<string> | undefined
{
	const ids = new Set<string>();
	const collect = (query: SQL): boolean =>
	{
		const rows = database.all<
		{
			id: string;
		}>(sql`${query} LIMIT ${limit + 1}`);
		for (const {id} of rows)
		{
			ids.add(id);
		}
		return rows.length <= limit && ids.size <= limit;
	};
	const content = changedIn("node_content", "id", since);
	return collect(content) &&
		collect(sql`
			WITH content(id) AS (${content})
			SELECT mirror_id AS id FROM mirrors
			WHERE system_to = ${FAR_FUTURE_DATE} AND original_id IN (SELECT id FROM content)
		`) &&
		collect(changedIn("node_metadata", "node_id", since)) &&
		collect(changedIn("mirrors", "mirror_id", since)) &&
		collect(changedIn("references_roots", "node_id", since)) &&
		collect(changedIn("ai_metadata", "node_id", since))
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
 * A bulk import may run longer, so while its lease is open the watermark stays a millisecond before the lease, and
 * the import's rows, all stamped at or after the lease, land after it.
 */
export function changeWatermark(database: Database): string
{
	const watermark = formatTemporalTimestamp(new Date(Date.now() - TRANSACTION_TIMEOUT_MS));
	const lease = bulkImportLeaseStart(database);
	if (lease === undefined)
	{
		return watermark;
	}
	const beforeLease = formatTemporalTimestamp(new Date(Date.parse(`${lease.replace(" ", "T")}Z`) - 1));
	return beforeLease < watermark ? beforeLease : watermark;
}

/** A temporal timestamp as {@link changeWatermark} formats it. */
const WATERMARK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u;

/** What changed after a {@link changeWatermark}. */
export interface ChangesAfter
{
	/** The changed node ids, each once, plus live mirrors of a changed original (a mirror shows its original's text). */
	ids: Set<string>;
	/** The parents of changed node_content versions closed after the watermark: what a move or delete left. */
	formerParents: Set<string | null>;
}

/**
 * {@link ChangesAfter} the watermark `after`, or undefined when the client must refetch everything instead: the
 * watermark is not one this server issued (not a timestamp, or past the current watermark), or more than `limit`
 * nodes changed. Rows re-read from the last timeout window repeat across polls; the id set reports each node once.
 */
export function changesAfter(database: Database, after: string, limit: number): ChangesAfter | undefined
{
	if (!WATERMARK.test(after) || after > changeWatermark(database))
	{
		return undefined;
	}
	const ids = changedNodeIds(database, after, limit);
	if (ids === undefined)
	{
		return undefined;
	}
	const former = database.all<
	{
		parent_id: string | null;
	}>(sql`
		SELECT DISTINCT parent_id FROM node_content
		WHERE ${CLOSED} AND system_to > ${after} AND id IN (SELECT value FROM json_each(${JSON.stringify([...ids])}))
	`);
	return {
		ids,
		formerParents: new Set(former.map((row) => row.parent_id)),
	};
}

/** Each live node of `ids` with its current parent (null: Home), in one query: the id set is one JSON parameter. */
export function liveParents(database: Database, ids: readonly string[]): Map<string, string | null>
{
	const live = database.all<
	{
		id: string;
		parent_id: string | null;
	}>(sql`
		SELECT id, parent_id FROM node_content
		WHERE system_to = ${FAR_FUTURE_DATE} AND id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
	`);
	return new Map(live.map((row) => [row.id, row.parent_id]));
}
