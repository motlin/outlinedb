import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {describe, expect, it} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import * as serverApp from "../src/server/app.js";
import type {ServerConfig} from "../src/server/config.js";
import {buildServerContext} from "../src/server/context.js";
import {LadderEventBus} from "../src/server/ladder-events.js";

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

const baseConfig: ServerConfig = {
	mode: "mirror",
	accountEmail: "",
	sqlQueryLogging: false,
	calendarEnsureEnabled: false,
	calendarLayoutEnabled: false,
	features: {embeddings: false, treeSnapshot: true},
};

function memoryDb() {
	const db = drizzle(new DatabaseConstructor(":memory:"), {schema});
	migrate(db, {migrationsFolder});
	return db;
}

describe("server-app exports", () => {
	it("are the ops, store, http and context pieces only, with no Hono app of their own", () => {
		// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
		expect(Object.keys(serverApp).sort()).toStrictEqual([
			"LadderEventBus",
			"MemoryEmbeddingIndex",
			"TreeEventBus",
			"accountChangePublisher",
			"bindTreeHost",
			"buildServerContext",
			"changeWatermark",
			"createHttpApp",
			"inProcessStore",
			"peekTreeSnapshotRows",
		]);
	});
});

describe("buildServerContext", () => {
	it("derives the flags from its dependencies, with no internal adapter without auth", () => {
		const db = memoryDb();
		const ladderEvents = new LadderEventBus();
		const ctx = buildServerContext({
			db,
			config: {...baseConfig, apiKey: "key", calendarEnsureEnabled: true, calendarLayoutEnabled: false},
			ladderEvents,
		});
		expect({
			db: ctx.db === db,
			bus: ctx.ladderEvents === ladderEvents,
			mode: ctx.mode,
			apiKey: ctx.apiKey,
			ensure: ctx.calendarEnsureEnabled,
			layout: ctx.calendarLayoutEnabled,
			internalAuth: ctx.internalAuth,
			adapter: ctx.internalAdapter?.(),
		}).toStrictEqual({
			db: true,
			bus: true,
			mode: "mirror",
			apiKey: "key",
			ensure: true,
			layout: false,
			internalAuth: undefined,
			adapter: undefined,
		});
	});
});
