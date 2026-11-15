import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {ensureNodeTags} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {join} from "node:path";
import {nodeTreeHost} from "./node-host.js";
import type {NodeServerConfig} from "./config.js";
import {createSqlLogger} from "./sql-logger.js";
import {bindTreeHost} from "./tree-snapshot.js";

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** The process database over `config.dbPath`; settings come from `readNodeConfig`, read once by the host. */
export function getDatabase(config: Pick<NodeServerConfig, "dbPath" | "sqlQueryLogging">)
{
	if (dbInstance)
	{
		return dbInstance;
	}

	const sqlite = new Database(config.dbPath ?? "outlinedb.sqlite");

	sqliteVec.load(sqlite);

	if (config.dbPath === undefined)
	{
		sqlite.pragma("journal_mode = WAL");
	}

	dbInstance = drizzle(
		sqlite,
		{
			schema,
			logger: createSqlLogger(config.sqlQueryLogging),
		},
	);

	bindTreeHost(dbInstance, nodeTreeHost(sqlite));

	if (process.env.OUTLINEDB_SKIP_MIGRATIONS !== "true")
	{
		const migrationsFolder = join(import.meta.dirname, "../../../shared/dist/db/migrations");
		migrate(
			dbInstance,
			{
				migrationsFolder,
			},
		);
		ensureNodeTags(dbInstance);
	}

	if (process.env.OUTLINEDB_TEST_DISABLE_FK !== "true")
	{
		sqlite.pragma("foreign_keys = ON");
	}

	return dbInstance;
}
