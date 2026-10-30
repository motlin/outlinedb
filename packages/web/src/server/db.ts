import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {ensureNodeTags} from "@workflowy/shared/cache";
import * as schema from "@workflowy/shared/db";
import {join} from "node:path";
import {nodeTreeHost} from "./node-host.js";
import {createSqlLogger} from "./sql-logger.js";
import {bindTreeHost} from "./tree-snapshot.js";

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDatabase() {
	if (dbInstance) {
		return dbInstance;
	}

	const dbPath = (process.env.WORKFLOWY_DB_PATH ?? "") || "workflowy.sqlite";
	const sqlite = new Database(dbPath);

	sqliteVec.load(sqlite);

	if (!process.env.WORKFLOWY_DB_PATH) {
		sqlite.pragma("journal_mode = WAL");
	}

	dbInstance = drizzle(sqlite, {
		schema,
		logger: createSqlLogger(process.env.WORKFLOWY_SQL_QUERY_LOGGING === "true"),
	});

	bindTreeHost(dbInstance, nodeTreeHost(sqlite));

	if (process.env.WORKFLOWY_SKIP_MIGRATIONS !== "true") {
		const migrationsFolder = join(import.meta.dirname, "../../../shared/dist/db/migrations");
		migrate(dbInstance, {migrationsFolder});
		ensureNodeTags(dbInstance);
	}

	if (process.env.WORKFLOWY_TEST_DISABLE_FK !== "true") {
		sqlite.pragma("foreign_keys = ON");
	}

	return dbInstance;
}
