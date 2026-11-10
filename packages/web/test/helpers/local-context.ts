import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import {buildServerContext} from "../../src/server/context.js";
import type {LocalIdentity, ServerContext} from "../../src/server/context.js";
import {LadderEventBus} from "../../src/server/ladder-events.js";

const migrationsFolder = join(import.meta.dirname, "../../../shared/src/db/migrations");

/** A standalone context over a fresh in-memory database: no internal API, so account state lives in the local tables. */
export function standaloneContext(identity?: LocalIdentity): ServerContext {
	const db = drizzle(new DatabaseConstructor(":memory:"), {schema});
	migrate(db, {migrationsFolder});
	return buildServerContext({
		db,
		config: {
			mode: "standalone",
			accountEmail: "",
			sqlQueryLogging: false,
			calendarEnsureEnabled: false,
			calendarLayoutEnabled: false,
			features: {embeddings: false, treeSnapshot: false},
		},
		ladderEvents: new LadderEventBus(),
		...(identity === undefined ? {} : {identity: () => identity}),
	});
}
