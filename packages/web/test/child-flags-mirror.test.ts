import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {childFlags} from "../src/server/backlinks.js";

const {CacheService} = await import("@outlinedb/shared/cache");

const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

function apiNode(id: string, parentId: string | null, priority: number, completedAt?: number): WorkflowyNode {
	return {
		id,
		name: id,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 100,
		modifiedAt: 200,
		completed: completedAt !== undefined,
		...(completedAt === undefined ? {} : {completedAt}),
	};
}

/** Parents P1 (mirror of a done original), P2 (mirror with a stale own completion of an open original), P3 (plain done child). */
function setup() {
	const sqlite = new DatabaseConstructor(":memory:");
	const db = drizzle(sqlite, {schema});
	migrate(db, {migrationsFolder});
	const cacheService = new CacheService(db);
	cacheService.insertNode(apiNode("Elsewhere", null, 0), null);
	cacheService.insertNode(apiNode("DoneOrig", "Elsewhere", 0, 300), "Elsewhere");
	cacheService.insertNode(apiNode("OpenOrig", "Elsewhere", 1), "Elsewhere");
	for (const parent of ["P1", "P2", "P3"]) {
		cacheService.insertNode(apiNode(parent, null, 1), null);
	}
	cacheService.insertNode(apiNode("M1", "P1", 0), "P1");
	cacheService.insertNode(apiNode("M2", "P2", 0, 400), "P2");
	cacheService.insertNode(apiNode("C3", "P3", 0, 500), "P3");
	const link = sqlite.prepare(
		"INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)",
	);
	link.run("M1", "DoneOrig", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	link.run("M2", "OpenOrig", "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
	return {db} as unknown as ServerContext;
}

describe("childFlags with mirror children", () => {
	it("counts a mirror as completed exactly when its original is, ignoring the mirror's own completion", () => {
		const {db} = setup();

		expect(childFlags(db, ["P1", "P2", "P3"])).toStrictEqual({
			withChildren: new Set(["P1", "P2", "P3"]),
			withUncompletedChildren: new Set(["P2"]),
		});
	});
});
