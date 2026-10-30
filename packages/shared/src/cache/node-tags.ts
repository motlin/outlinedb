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
const CLOSED = sql.raw(`system_to < '${FAR_FUTURE_DATE}'`);

/** Ids per statement: each batch travels as one JSON parameter, as a Durable Object caps bound parameters. */
const BATCH_SIZE = 500;

interface LiveText {
	id: string;
	name: string | null;
	note: string | null;
	layoutMode: string | null;
}

function liveText(tx: TemporalTransaction, ids: readonly string[] | undefined): LiveText[] {
	const only = ids === undefined ? sql`` : sql`AND c.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
	return tx.all<LiveText>(sql`
		SELECT c.id AS id, c.name AS name, c.note AS note, m.layout_mode AS layoutMode FROM node_content c
		LEFT JOIN node_metadata m ON m.node_id = c.id AND m.system_to = ${FAR_FUTURE_DATE}
		WHERE c.system_to = ${FAR_FUTURE_DATE} ${only}
	`);
}

function insertTags(tx: TemporalTransaction, rows: readonly LiveText[]): void {
	const tags: [string, string, string][] = [];
	for (const row of rows) {
		for (const [key, tag] of itemTags(row)) {
			tags.push([row.id, key, tag]);
		}
	}
	for (let start = 0; start < tags.length; start += BATCH_SIZE) {
		const batch = JSON.stringify(tags.slice(start, start + BATCH_SIZE));
		tx.run(sql`
			INSERT INTO node_tags (node_id, tag_key, tag)
			SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
			FROM json_each(${batch})
		`);
	}
}

/** Rewrite the `node_tags` rows of `ids` from their live text; an id with no live row loses its tags. */
function rewriteTags(tx: TemporalTransaction, ids: readonly string[]): void {
	for (let start = 0; start < ids.length; start += BATCH_SIZE) {
		const batch = ids.slice(start, start + BATCH_SIZE);
		tx.run(sql`DELETE FROM node_tags WHERE node_id IN (SELECT value FROM json_each(${JSON.stringify(batch)}))`);
		insertTags(tx, liveText(tx, batch));
	}
}

/**
 * Rewrite the tags of every node whose content or metadata a unit of work opened or closed at `systemTime`, inside
 * that unit's transaction. One query per table and column: a Durable Object's SQLite rejects compound selects with
 * more than a few terms.
 */
export function syncNodeTags(tx: TemporalTransaction, systemTime: string): void {
	const ids = new Set<string>();
	for (const [table, column] of [
		["node_content", "id"],
		["node_metadata", "node_id"],
	] as const) {
		const name = sql.identifier(table);
		const id = sql.identifier(column);
		for (const where of [sql`system_from = ${systemTime}`, sql`${CLOSED} AND system_to = ${systemTime}`]) {
			for (const row of tx.all<{id: string}>(sql`SELECT ${id} AS id FROM ${name} WHERE ${where}`)) {
				ids.add(row.id);
			}
		}
	}
	if (ids.size > 0) {
		rewriteTags(tx, [...ids]);
	}
}

/** Rebuild all of `node_tags` from the live tree, for writes that bypass a unit of work (temporal rollback). */
export function rebuildNodeTags(tx: TemporalTransaction): void {
	tx.run(sql`DELETE FROM node_tags`);
	insertTags(tx, liveText(tx, undefined));
}

/**
 * Backfill `node_tags` when it is empty but the tree is not: right after the migration that adds it, whose tag rules
 * live here in TypeScript rather than in SQL. Call it after migrating.
 */
export function ensureNodeTags(database: TemporalTransaction): void {
	const state = database.get<{tagged: number; live: number}>(sql`
		SELECT EXISTS (SELECT 1 FROM node_tags) AS tagged,
			EXISTS (SELECT 1 FROM node_content WHERE system_to = ${FAR_FUTURE_DATE}) AS live
	`);
	if (state.tagged === 0 && state.live === 1) {
		database.transaction((tx) => {
			rebuildNodeTags(tx);
		});
	}
}
