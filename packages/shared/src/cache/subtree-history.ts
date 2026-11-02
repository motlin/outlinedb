import {and, asc, eq, gt, inArray, lte} from "drizzle-orm";
import type {SQL} from "drizzle-orm";
import type {AnySQLiteColumn} from "drizzle-orm/sqlite-core";
import {nodeContent, nodeMetadata} from "../db/schema.js";
import {formatTemporalTimestamp} from "../temporal/constants.js";
import {FAR_FUTURE_DATE} from "../temporal/index.js";
import {systemFromToDate} from "./cache-temporal.js";
import {readInternalMetadata} from "./internal-metadata.js";
import type {InternalMetadata} from "./internal-metadata.js";
import type {TemporalTransaction} from "./temporal-merge.js";

/** Durable Object SQLite caps a statement at 100 bound parameters. */
const ID_CHUNK = 90;

/** A cached subtree at one system time: every node's children in order (leaves map to `[]`) and its kept metadata. */
export interface SubtreeAt
{
	children: Map<string, string[]>;
	metadata: Map<string, InternalMetadata>;
}

/** The system time one millisecond before `systemTime`: reading as of it sees the rows a unit at `systemTime` replaced. */
export function systemTimeJustBefore(systemTime: string): string
{
	return formatTemporalTimestamp(new Date(systemFromToDate(systemTime).getTime() - 1));
}

function versionAt(
	table:
	{
		systemFrom: AnySQLiteColumn;
		systemTo: AnySQLiteColumn;
	},
	asOf: string | undefined,
): SQL
{
	if (asOf === undefined)
	{
		return eq(table.systemTo, FAR_FUTURE_DATE);
	}
	const at = and(lte(table.systemFrom, asOf), gt(table.systemTo, asOf));
	if (at === undefined)
	{
		throw new TypeError("unreachable: and() of two conditions");
	}
	return at;
}

/**
 * The cached subtree under `rootId` (the root included), read level by level:
 * the live rows by default, or the rows current at system time `asOf`.
 * Children are ordered by priority, then creation time, like the cache's reads.
 */
export function readSubtreeAt(database: TemporalTransaction, rootId: string, asOf?: string): SubtreeAt
{
	const children = new Map<string, string[]>([[rootId, []]]);
	let level = [rootId];
	while (level.length > 0)
	{
		const next: string[] = [];
		for (let start = 0; start < level.length; start += ID_CHUNK)
		{
			const rows = database
				.select(
					{
						id: nodeContent.id,
						parentId: nodeContent.parentId,
					},
				)
				.from(nodeContent)
				.leftJoin(nodeMetadata, and(eq(nodeMetadata.nodeId, nodeContent.id), versionAt(nodeMetadata, asOf)))
				.where(
					and(
						inArray(nodeContent.parentId, level.slice(start, start + ID_CHUNK)),
						versionAt(nodeContent, asOf),
					),
				)
				.orderBy(asc(nodeMetadata.priority), asc(nodeMetadata.createdAt))
				.all();
			for (const {id, parentId} of rows)
			{
				if (parentId !== null && !children.has(id))
				{
					children.get(parentId)?.push(id);
					children.set(id, []);
					next.push(id);
				}
			}
		}
		level = next;
	}
	return {
		children,
		metadata: readInternalMetadata(database, [...children.keys()], asOf),
	};
}
