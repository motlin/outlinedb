import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {findCalendarDays, findTaggedCalendarRoot} from "../src/cache/calendar-lookup.js";
import {CacheService} from "../src/cache/index.js";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

/** A migrated database that records every statement it runs against calendar_metadata. */
function recordingDb()
{
	const queries:
	{
		sql: string;
		params: unknown[];
	}[] = [];
	const sqlite = new DatabaseConstructor(":memory:");
	const database = drizzle(
		sqlite,
		{
			schema,
			logger:
			{
				logQuery(sql, params)
				{
					if (sql.includes(`from "calendar_metadata"`))
					{
						queries.push(
							{
								sql,
								params,
							},
						);
					}
				},
			},
		},
	);
	migrate(
		database,
		{
			migrationsFolder,
		},
	);
	return {
		sqlite,
		database,
		queries,
	};
}

/** The plan detail lines that scan calendar_metadata itself, not the node_content liveness subquery. */
function calendarMetadataPlan(
	sqlite: DatabaseConstructor.Database,
	query:
	{
		sql: string;
		params: unknown[];
	},
)
{
	const plan:
	{
		detail: string;
	}[] = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as
	{
		detail: string;
	}[];
	return plan.map(({detail}) => detail).filter((detail) => detail.includes("calendar_metadata"));
}

describe("calendar_metadata live-row indexes", () =>
{
	it("finds the tagged calendar root through the root index", () =>
	{
		const {sqlite, database, queries} = recordingDb();

		findTaggedCalendarRoot(
			{
				db: database,
			},
		);

		expect(queries.map((query) => calendarMetadataPlan(sqlite, query))).toStrictEqual([
			["SEARCH calendar_metadata USING INDEX calendar_metadata_root_idx (root=? AND system_to=?)"],
		]);
	});

	it("scans a month's tagged days through the day index", () =>
	{
		const {sqlite, database, queries} = recordingDb();
		sqlite
			.prepare("INSERT INTO node_content (id, name, parent_id, system_from, system_to) VALUES (?, ?, NULL, ?, ?)")
			.run("cal", "📆 Calendar", "2026-10-01 00:00:00.000", FAR_FUTURE_DATE);

		findCalendarDays(
			{
				db: database,
				cache: new CacheService(database),
			},
			[20_261_017],
		);

		expect(queries.map((query) => calendarMetadataPlan(sqlite, query))).toStrictEqual([
			["SEARCH calendar_metadata USING INDEX calendar_metadata_root_idx (root=? AND system_to=?)"],
			[
				"SEARCH calendar_metadata USING INDEX calendar_metadata_level_idx (level=? AND system_to=? AND date_id>? AND date_id<?)",
			],
		]);
	});
});
