import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import DatabaseConstructor from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {ensureNodeTags} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {join} from "node:path";
import {sqlLogger} from "../services/sql-logger.js";
import {nonEmpty} from "../utils/non-empty.js";
import {DEFAULT_DB_FILE} from "./default-db-file.js";

/** Open (and migrate) the cache database; a Buffer opens an in-memory copy of that serialized database. */
export function createDatabase(dbPath?: string | Buffer) {
	const source = Buffer.isBuffer(dbPath)
		? dbPath
		: (nonEmpty(dbPath) ?? nonEmpty(process.env.WORKFLOWY_DB_PATH) ?? DEFAULT_DB_FILE);
	const sqlite = new DatabaseConstructor(source);

	sqliteVec.load(sqlite);

	if (!process.env.WORKFLOWY_DB_PATH) {
		sqlite.pragma("journal_mode = WAL");
	}

	const db = drizzle(sqlite, {
		schema,
		logger: sqlLogger,
	});

	if (process.env.WORKFLOWY_SKIP_MIGRATIONS !== "true") {
		const migrationsFolder = join(import.meta.dirname, "../../../shared/dist/db/migrations");
		migrate(db, {migrationsFolder});
		ensureNodeTags(db);
	}

	if (process.env.WORKFLOWY_TEST_DISABLE_FK !== "true") {
		sqlite.pragma("foreign_keys = ON");
	}

	return db;
}
