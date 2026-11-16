/**
 * Upstream's two one-time calendar boot migrations, run on the local tables: each writes node metadata through a
 * {@link LocalTreeWriter} and its root metadata flag through the account, so a mirror's writer and account record
 * outbox rows that a drain later delivers to workflowy.com.
 */

import {z} from "zod";
import {backfilledCalendarDateId, backfilledCalendarTimestamp} from "../internal/calendar-backfill.js";
import type {MetadataChange} from "../internal/metadata-patch.js";
import type {AppDatabase} from "../db/types.js";
import {CacheService} from "./cache-service.js";
import {readNodeInternalMetadata} from "./internal-metadata.js";
import {currentChildIds} from "./local-tree-writer.js";
import type {LocalMetaChange, LocalTreeWriter} from "./local-tree-writer.js";

const CalendarMetadataSchema = z.object(
	{
		calendar: z
			.object(
				{
					root: z.boolean().optional(),
					level: z.string().optional(),
					value: z.unknown().optional(),
					timestamp: z.number().optional(),
					dateId: z.number().optional(),
				},
			)
			.loose(),
	},
);

type CalendarNodeMetadata = z.infer<typeof CalendarMetadataSchema>["calendar"];

/** Where the backfill reads and writes root metadata: its `calendar.rootId` and the two migration flags. */
export interface CalendarBackfillAccount
{
	getRootMeta(path: string[]): Promise<unknown>;
	setRootMetaValues(changes: MetadataChange[]): Promise<void>;
}

export interface CalendarBackfillResult
{
	/** The nodes that gained a `calendar.timestamp`. */
	timestamps: string[];
	/** The nodes that gained a `calendar.dateId`. */
	dateIds: string[];
}

function calendarOf(db: AppDatabase, id: string): CalendarNodeMetadata | undefined
{
	const parsed = CalendarMetadataSchema.safeParse(readNodeInternalMetadata(db, id));
	return parsed.success ? parsed.data.calendar : undefined;
}

/**
 * Visit every live descendant of `rootId` that has non-root calendar metadata, depth first in sibling order, with its
 * calendar chain (the node, then each calendar ancestor below the root).
 */
function walkCalendar(
	db: AppDatabase,
	rootId: string,
	visit: (id: string, calendar: CalendarNodeMetadata, chain: CalendarNodeMetadata[]) => void,
): void
{
	const walk = (id: string, ancestors: CalendarNodeMetadata[]): void =>
	{
		const own = calendarOf(db, id);
		const calendar = own?.root === true ? undefined : own;
		const chain = calendar === undefined ? ancestors : [calendar, ...ancestors];
		if (calendar !== undefined)
		{
			visit(id, calendar, chain);
		}
		for (const child of currentChildIds(db, id))
		{
			walk(child, chain);
		}
	};
	for (const child of currentChildIds(db, rootId))
	{
		walk(child, []);
	}
}

/**
 * The live node root metadata `calendar.rootId` names, when it is tagged `calendar.root`. With `tagUntagged`, a named
 * node without calendar metadata is tagged `{root: true}` first, as upstream's timestamp migration does.
 */
async function taggedCalendarRootId(
	db: AppDatabase,
	writer: LocalTreeWriter,
	account: CalendarBackfillAccount,
	tagUntagged: boolean,
): Promise<string | undefined>
{
	const rootId = await account.getRootMeta(["calendar", "rootId"]);
	if (typeof rootId !== "string" || new CacheService(db).getNode(rootId) === undefined)
	{
		return undefined;
	}
	const calendar = calendarOf(db, rootId);
	if (tagUntagged && readNodeInternalMetadata(db, rootId).calendar === undefined)
	{
		writer.setNodeMetaValues(rootId, [
			{
				path: ["calendar"],
				value:
				{
					root: true,
				},
			},
		]);
		return rootId;
	}
	return calendar?.root === true ? rootId : undefined;
}

/** Set a migration's root metadata flag, unless a forced rerun finds it already set. */
async function setFlag(account: CalendarBackfillAccount, key: string): Promise<void>
{
	if ((await account.getRootMeta(["calendar", key])) !== true)
	{
		await account.setRootMetaValues([
			{
				path: ["calendar", key],
				value: true,
			},
		]);
	}
}

/**
 * Upstream's `calendar.ts_added_v2` (`_S2`/`f10`) and `calendar.dateId_added_v1` (`IS2`/`h10`) migrations, each run
 * unless root metadata already holds its flag (or with `force`), then flagged: the first adds `calendar.timestamp` to
 * every level node under the tagged calendar root that lacks one, rebuilt from the chain's values, after tagging an
 * untagged root `{root: true}`; the second adds `calendar.dateId` from each timestamp. Each migration's node edits are
 * one unit of work.
 */
export async function backfillCalendarMetadata(input: {
	db: AppDatabase;
	writer: LocalTreeWriter;
	account: CalendarBackfillAccount;
	force?: boolean;
}): Promise<CalendarBackfillResult>
{
	const {db, writer, account, force = false} = input;
	const timestamps: string[] = [];
	const dateIds: string[] = [];
	if (force || (await account.getRootMeta(["calendar", "ts_added_v2"])) !== true)
	{
		const rootId = await taggedCalendarRootId(db, writer, account, true);
		if (rootId !== undefined)
		{
			const changes = new Map<string, LocalMetaChange[]>();
			walkCalendar(db, rootId, (id, calendar, chain) =>
			{
				const timestamp = calendar.timestamp === undefined ? backfilledCalendarTimestamp(chain) : undefined;
				if (timestamp !== undefined)
				{
					changes.set(id, [
						{
							path: ["calendar", "timestamp"],
							value: timestamp,
						},
					]);
				}
			});
			writer.setNodesMetaValues(changes);
			timestamps.push(...changes.keys());
		}
		await setFlag(account, "ts_added_v2");
	}
	if (force || (await account.getRootMeta(["calendar", "dateId_added_v1"])) !== true)
	{
		const rootId = await taggedCalendarRootId(db, writer, account, false);
		if (rootId !== undefined)
		{
			const changes = new Map<string, LocalMetaChange[]>();
			walkCalendar(db, rootId, (id, calendar) =>
			{
				const dateId =
					calendar.dateId === undefined && typeof calendar.timestamp === "number"
						? backfilledCalendarDateId(calendar.level, calendar.timestamp)
						: undefined;
				if (dateId !== undefined)
				{
					changes.set(id, [
						{
							path: ["calendar", "dateId"],
							value: dateId,
						},
					]);
				}
			});
			writer.setNodesMetaValues(changes);
			dateIds.push(...changes.keys());
		}
		await setFlag(account, "dateId_added_v1");
	}
	return {
		timestamps,
		dateIds,
	};
}
