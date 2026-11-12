import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import type {DrizzleSqliteDODatabase} from "drizzle-orm/durable-sqlite";
import {describe, expectTypeOf, it} from "vite-plus/test";

import {CacheService} from "../src/cache/cache-service.js";
import type {AppDatabase} from "../src/db/types.js";
import type * as schema from "../src/db/schema.js";

describe("AppDatabase", () =>
{
	it("accepts better-sqlite3 and Durable Object drizzle databases", () =>
	{
		expectTypeOf<BetterSQLite3Database<typeof schema>>().toExtend<AppDatabase>();
		expectTypeOf<DrizzleSqliteDODatabase<typeof schema>>().toExtend<AppDatabase>();
	});

	it("lets CacheService be constructed over a Durable Object database", () =>
	{
		expectTypeOf(CacheService).constructorParameters.toEqualTypeOf<[AppDatabase]>();
		expectTypeOf<DrizzleSqliteDODatabase<typeof schema>>().toExtend<
			ConstructorParameters<typeof CacheService>[0]
		>();
	});
});
