import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import {Ops} from "../src/server/ops/index.js";
import type {ServerContext} from "../src/server/context.js";

// From the registry, which the web setup wraps to check each op output against its schema.
const searchText = Ops["search.text"];

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");
const SEEDED_AT = "2026-01-01 00:00:00.000";

const open: DatabaseConstructor.Database[] = [];
afterEach(() => {
	for (const sqlite of open.splice(0)) {
		sqlite.close();
	}
});

function seededContext(): ServerContext {
	const sqlite = new DatabaseConstructor(":memory:");
	open.push(sqlite);
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const live = {systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE};
	db.insert(nodeContent)
		.values([
			{id: "parent", name: "Parent", note: null, parentId: null, ...live},
			{id: "done", name: "Needle done", note: null, parentId: "parent", ...live},
			{id: "open", name: "Needle open", note: "a note", parentId: "parent", ...live},
		])
		.run();
	db.insert(nodeMetadata)
		.values([
			{nodeId: "done", priority: 0, completedAt: new Date(1_600_000_100_000), ...live},
			{nodeId: "open", priority: 1, completedAt: null, ...live},
		])
		.run();
	return {db} as unknown as ServerContext;
}

describe("search.text", () => {
	it("returns completedAt in epoch seconds, or null when incomplete", async () => {
		const ctx = seededContext();

		const result = await Promise.resolve(searchText.run(ctx, {query: "Needle", limit: 10, offset: 0}));

		expect(result).toStrictEqual({
			ok: true,
			value: {
				results: [
					{id: "done", name: "Needle done", note: null, parentPath: "Parent", completedAt: 1_600_000_100},
					{id: "open", name: "Needle open", note: "a note", parentPath: "Parent", completedAt: null},
				],
				totalCount: 2,
			},
		});
	});

	it("returns completedAt when the query joins metadata", async () => {
		const ctx = seededContext();

		const result = await Promise.resolve(searchText.run(ctx, {query: "Needle is:complete", limit: 10, offset: 0}));

		expect(result).toStrictEqual({
			ok: true,
			value: {
				results: [
					{id: "done", name: "Needle done", note: null, parentPath: "Parent", completedAt: 1_600_000_100},
				],
				totalCount: 1,
			},
		});
	});
});
