import {describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {childFlags, childFlagsFromRows} from "../src/server/backlinks.js";
import {CacheService} from "@outlinedb/shared/cache";
import {mirrors, nodeContent, nodeMetadata, referencesRoots} from "@outlinedb/shared/db";

describe("child flags mirror", () => {
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
});

describe("child flags", () => {
	describe("childFlagsFromRows", () => {
		it("flags a parent with only completed children as having children but no uncompleted children", () => {
			expect(
				childFlagsFromRows([
					{parentId: "p", completedAt: new Date(1000)},
					{parentId: "p", completedAt: new Date(2000)},
					{parentId: "q", completedAt: new Date(1000)},
					{parentId: "q", completedAt: null},
					{parentId: "r", completedAt: null},
					{parentId: null, completedAt: null},
				]),
			).toStrictEqual({
				withChildren: new Set(["p", "q", "r"]),
				withUncompletedChildren: new Set(["q", "r"]),
			});
		});
	});

	describe("childFlags with a references root", () => {
		const TARGET = "00000000-0000-4000-8000-0000000000aa";
		const SOURCE = "00000000-0000-4000-8000-0000000000bb";
		const ROOT = "00000000-0000-4000-8000-0000000000cc";
		const ITEM = "00000000-0000-4000-8000-0000000000dd";
		const SEEDED_AT = "2026-01-01 00:00:00.000";

		function fixture({withItem, sourceCompleted}: {withItem: boolean; sourceCompleted: boolean}) {
			const db = drizzle(new DatabaseConstructor(":memory:"), {schema});
			migrate(db, {migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations")});
			const rows: [string, string | null][] = [
				[TARGET, null],
				[SOURCE, null],
				[ROOT, TARGET],
				...(withItem ? [[ITEM, ROOT] as [string, string | null]] : []),
			];
			for (const [id, parentId] of rows) {
				db.insert(nodeContent)
					.values({id, name: "x", note: null, parentId, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
					.run();
				db.insert(nodeMetadata)
					.values({
						nodeId: id,
						priority: 0,
						completedAt: id === SOURCE && sourceCompleted ? new Date("2026-02-01T00:00:00Z") : null,
						systemFrom: SEEDED_AT,
						systemTo: FAR_FUTURE_DATE,
					})
					.run();
			}
			db.insert(referencesRoots).values({nodeId: ROOT, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE}).run();
			if (withItem) {
				db.insert(mirrors)
					.values({mirrorId: ITEM, originalId: SOURCE, systemFrom: SEEDED_AT, systemTo: FAR_FUTURE_DATE})
					.run();
			}
			return db;
		}

		it("counts a root holding a current-source backlink as an uncompleted child", () => {
			expect(childFlags(fixture({withItem: true, sourceCompleted: false}), [TARGET])).toStrictEqual({
				withChildren: new Set([TARGET]),
				withUncompletedChildren: new Set([TARGET]),
			});
		});

		it("counts it as a completed child when the source is completed", () => {
			expect(childFlags(fixture({withItem: true, sourceCompleted: true}), [TARGET])).toStrictEqual({
				withChildren: new Set([TARGET]),
				withUncompletedChildren: new Set(),
			});
		});

		it("counts nothing for a root without backlink items", () => {
			expect(childFlags(fixture({withItem: false, sourceCompleted: false}), [TARGET])).toStrictEqual({
				withChildren: new Set(),
				withUncompletedChildren: new Set(),
			});
		});
	});
});
