import {beforeEach, vi, afterEach, describe, expect, it} from "vite-plus/test";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import {join} from "node:path";
import {CacheService} from "../src/cache/cache-service.js";
import * as schema from "../src/db/schema.js";
import {nodeContent} from "../src/db/schema.js";
import type {WorkflowyNode} from "../src/types/workflowy.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import {SameMillisecondOverwriteError} from "../src/cache/temporal-merge.js";

const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

function apiNode(id: string, name: string): WorkflowyNode {
	return {id, name, priority: 0, createdAt: 1_767_225_600, modifiedAt: 1_767_225_600};
}

describe("one application UTC system time per unit of work", () => {
	let tempDir: string;
	let connections: DatabaseConstructor.Database[];

	beforeEach(() => {
		tempDir = fs.mkdtempSync(join(os.tmpdir(), "workflowy-system-time-test-"));
		connections = [];
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const connection of connections) {
			connection.close();
		}
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	/** A separate connection to one database file, as another process would open it. */
	function openDatabase() {
		const sqlite = new DatabaseConstructor(join(tempDir, "cache.sqlite"));
		connections.push(sqlite);
		const database = drizzle(sqlite, {schema});
		migrate(database, {migrationsFolder});
		return database;
	}

	it("stamps every row of one unit of work with the same Date.now(), across several parents", () => {
		vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:00.000Z")});
		const database = openDatabase();

		new CacheService(database).storeApiResponses([
			{nodes: [apiNode("node-1", "First")], parentId: null},
			{nodes: [apiNode("node-2", "Second")], parentId: "node-1"},
		]);

		expect(database.select().from(nodeContent).all()).toStrictEqual([
			{
				id: "node-1",
				name: "First",
				note: null,
				parentId: null,
				systemFrom: "2026-02-01 00:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
			{
				id: "node-2",
				name: "Second",
				note: null,
				parentId: "node-1",
				systemFrom: "2026-02-01 00:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("stores a child list ahead of the list naming its uncached parent in one unit, with no placeholder version for the parent", () => {
		vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:00.000Z")});
		const database = openDatabase();

		new CacheService(database).storeApiResponses([
			{nodes: [apiNode("node-2", "Child")], parentId: "node-1"},
			{nodes: [apiNode("node-1", "Parent")], parentId: null},
		]);

		expect(database.select().from(nodeContent).all()).toStrictEqual([
			{
				id: "node-2",
				name: "Child",
				note: null,
				parentId: "node-1",
				systemFrom: "2026-02-01 00:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
			{
				id: "node-1",
				name: "Parent",
				note: null,
				parentId: null,
				systemFrom: "2026-02-01 00:00:00.000",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("fails a unit closing a version stamped at its own millisecond, naming the table, key and system time, and rolls the unit back", () => {
		vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:00.000Z")});
		const first = openDatabase();
		const second = openDatabase();
		new CacheService(first).insertNode(apiNode("node-1", "Original"), null);
		vi.setSystemTime(new Date("2026-02-01T00:00:05.000Z"));
		new CacheService(first).insertNode(apiNode("node-1", "Renamed"), null);

		expect(() => {
			new CacheService(second).insertNode(apiNode("node-1", "Renamed again"), null);
		}).toThrow(new SameMillisecondOverwriteError("node_content", "id=node-1", "2026-02-01 00:00:05.000"));
		expect(first.select().from(nodeContent).all()).toStrictEqual([
			{
				id: "node-1",
				name: "Original",
				note: null,
				parentId: null,
				systemFrom: "2026-02-01 00:00:00.000",
				systemTo: "2026-02-01 00:00:05.000",
			},
			{
				id: "node-1",
				name: "Renamed",
				note: null,
				parentId: null,
				systemFrom: "2026-02-01 00:00:05.000",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});

	it("lets a unit of work stamped earlier than the row it closes land out of order", () => {
		vi.useFakeTimers({toFake: ["Date"], now: new Date("2026-02-01T00:00:05.000Z")});
		const database = openDatabase();
		new CacheService(database).insertNode(apiNode("node-1", "Original"), null);
		vi.setSystemTime(new Date("2026-02-01T00:00:04.000Z"));

		new CacheService(database).insertNode(apiNode("node-1", "Renamed"), null);

		expect(database.select().from(nodeContent).all()).toStrictEqual([
			{
				id: "node-1",
				name: "Original",
				note: null,
				parentId: null,
				systemFrom: "2026-02-01 00:00:05.000",
				systemTo: "2026-02-01 00:00:04.000",
			},
			{
				id: "node-1",
				name: "Renamed",
				note: null,
				parentId: null,
				systemFrom: "2026-02-01 00:00:04.000",
				systemTo: FAR_FUTURE_DATE,
			},
		]);
	});
});
