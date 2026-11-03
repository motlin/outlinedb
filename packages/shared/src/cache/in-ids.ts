import {sql} from "drizzle-orm";
import type {Column, SQL} from "drizzle-orm";

/**
 * `column IN ids`, binding the whole list as one JSON parameter: Durable Object
 * SQLite caps a statement at 100 bound parameters, so a plain `IN (?, ?, ...)`
 * list fails past that many ids.
 */
export function inIds(column: Column, ids: readonly string[]): SQL {
	return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}
