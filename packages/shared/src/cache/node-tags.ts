/**
 * Keeps the derived `node_tags` table in step with live `node_content`: each live item's distinct tags by
 * {@link itemTags}, so tag autocomplete counts with GROUP BY instead of parsing every item's HTML.
 */

import {and, eq, sql} from "drizzle-orm";
import {nodeContent, nodeMetadata, nodeTags} from "../db/schema.js";
import {itemTags} from "../tags/item-tags.js";
import {closedVersionLiteral, currentVersion} from "./cache-temporal.js";
import {inIds} from "./in-ids.js";
import {WRITE_TRANSACTION} from "./temporal-merge.js";
import type {TemporalTransaction} from "./temporal-merge.js";

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
	return tx
		.select(
			{
				id: nodeContent.id,
				name: nodeContent.name,
				note: nodeContent.note,
				layoutMode: nodeMetadata.layoutMode,
			},
		)
		.from(nodeContent)
		.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), currentVersion(nodeMetadata)))
		.where(and(currentVersion(nodeContent), ids === undefined ? undefined : inIds(nodeContent.id, ids)))
		.all();
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
		// Raw SQL: Drizzle's insert binds every value, past a Durable Object's bound-parameter cap; json_each takes one.
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
		const batch = ids.slice(start, start + BATCH_SIZE);
		const stored = new Map<string, string>();
		for (const row of tx
			.select(
				{
					nodeId: nodeTags.nodeId,
					tagKey: nodeTags.tagKey,
					tag: nodeTags.tag,
				},
			)
			.from(nodeTags)
			.where(inIds(nodeTags.nodeId, batch))
			.all())
		{
			stored.set(`${row.nodeId}\u001F${row.tagKey}`, row.tag);
		}
		const changed: TagRow[] = [];
		for (const row of tagRows(liveText(tx, batch)))
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
			const keys = JSON.stringify(gone.slice(at, at + BATCH_SIZE));
			tx.delete(nodeTags)
				.where(
					sql`(${nodeTags.nodeId}, ${nodeTags.tagKey}) IN (
						SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${keys})
					)`,
				)
				.run();
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
			syncScannedTags(tx, systemTime, scope.slice(start, start + BATCH_SIZE));
		}
		return;
	}
	syncScannedTags(tx, systemTime, undefined);
}

/** {@link syncNodeTags} over the ids in `scope`, or over every row when it is undefined. */
function syncScannedTags(tx: TemporalTransaction, systemTime: number, scope: readonly string[] | undefined): void
{
	const ids = new Set<string>();
	for (const [table, id] of [
		[nodeContent, nodeContent.id],
		[nodeMetadata, nodeMetadata.nodeId],
	] as const)
	{
		const only = scope === undefined ? undefined : inIds(id, scope);
		for (const where of [
			eq(table.systemFrom, systemTime),
			and(closedVersionLiteral(table), eq(table.systemTo, systemTime)),
		])
		{
			for (const row of tx
				.select(
					{
						id,
					},
				)
				.from(table)
				.where(and(where, only))
				.all())
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
	tx.delete(nodeTags).run();
	insertTags(tx, tagRows(liveText(tx, undefined)));
}

/**
 * Backfill `node_tags` when it is empty but the tree is not: right after the migration that adds it, whose tag rules
 * live here in TypeScript rather than in SQL. Call it after migrating.
 */
export function ensureNodeTags(database: TemporalTransaction): void
{
	const untagged =
		database
			.select(
				{
					one: sql`1`,
				},
			)
			.from(nodeTags)
			.limit(1)
			.get() === undefined;
	if (
		untagged &&
		database
			.select(
				{
					one: sql`1`,
				},
			)
			.from(nodeContent)
			.where(currentVersion(nodeContent))
			.limit(1)
			.get() !== undefined
	)
	{
		database.transaction((tx) =>
		{
			rebuildNodeTags(tx);
		}, WRITE_TRANSACTION);
	}
}
