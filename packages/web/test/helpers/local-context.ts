import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {provisionLocalAccount} from "@outlinedb/shared/cache";
import type {LocalIdentity} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import type {ServerMode} from "../../src/server/config.js";
import {buildServerContext} from "../../src/server/context.js";
import type {ServerContext} from "../../src/server/context.js";
import {LadderEventBus} from "../../src/server/ladder-events.js";

const migrationsFolder = join(import.meta.dirname, "../../../shared/src/db/migrations");

/** The identity {@link standaloneContext} provisions by default. */
const TEST_IDENTITY: LocalIdentity = {
	userId: "user-a",
	email: "a@example.com",
	joinedAt: new Date("2023-11-14T22:13:20.000Z"),
};

function contextIn(mode: ServerMode): ServerContext {
	const db = drizzle(new DatabaseConstructor(":memory:"), {schema});
	migrate(db, {migrationsFolder});
	return buildServerContext({
		db,
		config: {
			mode,
			accountEmail: "",
			sqlQueryLogging: false,
			calendarEnsureEnabled: false,
			calendarLayoutEnabled: false,
			features: {embeddings: false, treeSnapshot: false},
		},
		ladderEvents: new LadderEventBus(),
	});
}

/**
 * A standalone context over a fresh in-memory database, provisioned for `identity` (no account row when null): no
 * internal API, so account state lives in the local tables.
 */
export function standaloneContext(identity: LocalIdentity | null = TEST_IDENTITY): ServerContext {
	const ctx = contextIn("standalone");
	if (identity !== null) {
		provisionLocalAccount(ctx.db, identity);
	}
	return ctx;
}

/** A mirror context over a fresh in-memory database with no internal-API auth: account state must answer 503. */
export function mirrorWithoutInternalApi(): ServerContext {
	return contextIn("mirror");
}
