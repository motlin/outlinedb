/**
 * Keeps the derived `node_tags` table in step with live `node_content`: each live item's distinct tags by
 * {@link itemTags}, so tag autocomplete counts with GROUP BY instead of parsing every item's HTML.
 */

import {sql} from "drizzle-orm";
import {itemTags} from "../tags/item-tags.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/**
 * Closed rows, as a literal so the partial `*_closed_at_idx` indexes (whose WHERE is this same term) apply;
 * SQLite matches a partial index's WHERE only against literal terms, never bound parameters.
 */
const CLOSED = sql.raw(`system_to < ${String(FAR_FUTURE_DATE)}`);

/** Ids per statement: each batch travels as one JSON parameter, as a Durable Object caps bound parameters. */
const BATCH_SIZE = 500;

interface LiveText
{
	id: string;
	name: string | null;
	note: string | null;
	layoutMode: string | null;
}

function liveText(tx: TemporalTransaction, ids: readonly string[] | undefined): LiveText[]
{
	const only = ids === undefined ? sql`` : sql`AND c.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
	return tx.all<LiveText>(sql`
		SELECT c.id AS id, c.name AS name, c.note AS note, m.layout_mode AS layoutMode FROM node_content c
		LEFT JOIN node_metadata m ON m.node_id = c.id AND m.system_to = ${FAR_FUTURE_DATE}
		WHERE c.system_to = ${FAR_FUTURE_DATE} ${only}
	`);
}

type TagRow = [nodeId: string, tagKey: string, tag: string];

function tagRows(rows: readonly LiveText[]): TagRow[]
{
	const tags: TagRow[] = [];
	for (const row of rows)
	{
		for (const [key, tag] of itemTags(row))
		{
			tags.push([row.id, key, tag]);
		}
	}
	return tags;
}

function insertTags(tx: TemporalTransaction, tags: readonly TagRow[]): void
{
	for (let start = 0; start < tags.length; start += BATCH_SIZE)
	{
		const batch = JSON.stringify(tags.slice(start, start + BATCH_SIZE));
		tx.run(sql`
			INSERT OR REPLACE INTO node_tags (node_id, tag_key, tag)
			SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
			FROM json_each(${batch})
		`);
	}
}

/**
 * Rewrite the `node_tags` rows of `ids` from their live text; an id with no live row loses its tags. Only rows that
 * differ are written, so rewriting an unchanged node's tags writes nothing.
 */
function rewriteTags(tx: TemporalTransaction, ids: readonly string[]): void
{
	for (let start = 0; start < ids.length; start += BATCH_SIZE)
	{
		const batch = JSON.stringify(ids.slice(start, start + BATCH_SIZE));
		const stored = new Map<string, string>();
		for (const row of tx.all<
		{
			nodeId: string;
			tagKey: string;
			tag: string;
		}>(
			sql`SELECT node_id AS nodeId, tag_key AS tagKey, tag FROM node_tags WHERE node_id IN (SELECT value FROM json_each(${batch}))`,
		))
		{
			stored.set(`${row.nodeId}\u001F${row.tagKey}`, row.tag);
		}
		const changed: TagRow[] = [];
		for (const row of tagRows(liveText(tx, ids.slice(start, start + BATCH_SIZE))))
		{
			const key = `${row[0]}\u001F${row[1]}`;
			if (stored.get(key) !== row[2])
			{
				changed.push(row);
			}
			stored.delete(key);
		}
		const gone = [...stored.keys()].map((key) => key.split("\u001F"));
		for (let at = 0; at < gone.length; at += BATCH_SIZE)
		{
			tx.run(sql`
				DELETE FROM node_tags WHERE (node_id, tag_key) IN (
					SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
					FROM json_each(${JSON.stringify(gone.slice(at, at + BATCH_SIZE))})
				)
			`);
		}
		insertTags(tx, changed);
	}
}

/**
 * Rewrite the tags of every node whose content or metadata a unit of work opened or closed at `systemTime`, inside
 * that unit's transaction. One query per table and column: a Durable Object's SQLite rejects compound selects with
 * more than a few terms. `scope`, when given, limits the scan to those ids: a unit of work split across several
 * transactions shares one system time, so without it each transaction would rescan every earlier one's nodes.
 */
export function syncNodeTags(tx: TemporalTransaction, systemTime: number, scope?: readonly string[]): void
{
	if (scope !== undefined)
	{
		for (let start = 0; start < scope.length; start += BATCH_SIZE)
		{
			syncScannedTags(tx, systemTime, JSON.stringify(scope.slice(start, start + BATCH_SIZE)));
		}
		return;
	}
	syncScannedTags(tx, systemTime, undefined);
}

/** {@link syncNodeTags} over the ids in `scope` (a JSON array), or over every row when it is undefined. */
function syncScannedTags(tx: TemporalTransaction, systemTime: number, scope: string | undefined): void
{
	const ids = new Set<string>();
	for (const [table, column] of [
		["node_content", "id"],
		["node_metadata", "node_id"],
	] as const)
	{
		const name = sql.identifier(table);
		const id = sql.identifier(column);
		const only = scope === undefined ? sql`` : sql`AND ${id} IN (SELECT value FROM json_each(${scope}))`;
		for (const where of [sql`system_from = ${systemTime}`, sql`${CLOSED} AND system_to = ${systemTime}`])
		{
			for (const row of tx.all<
			{
				id: string;
			}>(sql`SELECT ${id} AS id FROM ${name} WHERE ${where} ${only}`))
			{
				ids.add(row.id);
			}
		}
	}
	if (ids.size > 0)
	{
		rewriteTags(tx, [...ids]);
	}
}

/** Rebuild all of `node_tags` from the live tree, for writes that bypass a unit of work (temporal rollback). */
export function rebuildNodeTags(tx: TemporalTransaction): void
{
	tx.run(sql`DELETE FROM node_tags`);
	insertTags(tx, tagRows(liveText(tx, undefined)));
}

/**
 * Backfill `node_tags` when it is empty but the tree is not: right after the migration that adds it, whose tag rules
 * live here in TypeScript rather than in SQL. Call it after migrating.
 */
export function ensureNodeTags(database: TemporalTransaction): void
{
	const state = database.get<
	{
		tagged: number;
		live: number;
	}>(sql`
		SELECT EXISTS (SELECT 1 FROM node_tags) AS tagged,
			EXISTS (SELECT 1 FROM node_content WHERE system_to = ${FAR_FUTURE_DATE}) AS live
	`);
	if (state.tagged === 0 && state.live === 1)
	{
		database.transaction((tx) =>
		{
			rebuildNodeTags(tx);
		});
	}
}
