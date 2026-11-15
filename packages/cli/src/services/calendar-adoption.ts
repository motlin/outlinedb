import type {LocalTreeWriter} from "@outlinedb/shared/cache";
import {calendarParentContext, CALENDAR_ROOT_NAME} from "@outlinedb/shared/calendar-lookup";
import {adoptAfterCreate} from "@outlinedb/shared/internal";
import type {createDatabase} from "../db/index.js";
import type {CacheService} from "./cache.js";

/**
 * Tag rows just written under `parentId` the way upstream's `mb1` hook tags a dated row added under a 📆 Calendar
 * month in the web client, so workflowy.com recognises it as that day. The tag is local metadata, which the drain
 * delivers with the write. Parents outside the calendar, and rows with no date, are left alone.
 */
export async function adoptUnderCalendar(input: {
	rows: readonly
	{
		id: string;
		name: string;
	}[];
	parentId: string | null;
	database: ReturnType<typeof createDatabase>;
	cache: CacheService;
	local: LocalTreeWriter;
}): Promise<void>
{
	const {rows, parentId, database, cache, local} = input;
	if (parentId === null)
	{
		return;
	}
	for (const {id, name} of rows)
	{
		// Read per row: a row adopted as a day makes its date taken for the next one.
		await adoptAfterCreate(
			{
				id,
				name,
				context: calendarParentContext(
					{
						db: database,
						cache,
					},
					parentId,
				),
				adapter:
				{
					setNodeMetaValues: async (nodeId, changes) =>
					{
						local.setNodeMetaValues(nodeId, changes);
						return Promise.resolve();
					},
				},
			},
		);
	}
}

/** The `[YYYY, MM, ...rest]` of a `📆 Calendar,YYYY,MM[,...]` path, or undefined for any other path. */
export function calendarMonthPath(path: string):
	|
	  {
			year: number;
			month: number;
			rest: string[];
			dateId: number;
	  }
	| undefined
{
	const [root, year, month, ...rest] = path.split(",").map((part) => part.trim());
	if (root !== CALENDAR_ROOT_NAME || !/^\d{4}$/u.test(year ?? "") || !/^\d{1,2}$/u.test(month ?? ""))
	{
		return undefined;
	}
	const [y, m] = [Number(year), Number(month)];
	return m >= 1 && m <= 12
		?
			{
				year: y,
				month: m,
				rest,
				dateId: y * 10_000 + m * 100 + 1,
			}
		: undefined;
}
