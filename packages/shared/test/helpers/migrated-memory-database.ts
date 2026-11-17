import DatabaseConstructor from "better-sqlite3";
import type {Database, Options} from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";

const migrationsFolder = join(import.meta.dirname, "../../src/db/migrations");

let template: Buffer | undefined;

/**
 * A fresh in-memory database with every migration applied. The first call in a test file migrates one database and
 * keeps its bytes; every call opens its own copy of them, since migrating per test cost tens of milliseconds a time.
 */
export function migratedMemoryDatabase(options?: Options): Database
{
	if (template === undefined)
	{
		const sqlite = new DatabaseConstructor(":memory:");
		migrate(
			drizzle(sqlite),
			{
				migrationsFolder,
			},
		);
		template = sqlite.serialize();
		sqlite.close();
	}
	return new DatabaseConstructor(template, options);
}
