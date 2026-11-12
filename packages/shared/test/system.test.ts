import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs, {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import os, {tmpdir} from "node:os";
import path, {join} from "node:path";
import {describe, expect, it, beforeEach, vi, afterEach} from "vite-plus/test";
import {CacheService} from "../src/cache/cache-service.js";
import * as schema from "../src/db/schema.js";
import {nodeContent} from "../src/db/schema.js";
import type {WorkflowyNode} from "../src/types/workflowy.js";
import {FAR_FUTURE_DATE} from "../src/temporal/constants.js";
import {SameMillisecondOverwriteError} from "../src/cache/temporal-merge.js";

describe("system target placeholder migration", () => {
	const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");
	const FAR_FUTURE = "9999-12-31 23:59:59";

	/** A folder holding every migration before the placeholder cleanup, so a database can be migrated to that point. */
	function beforeCleanupFolder(): string {
		const folder = mkdtempSync(path.join(tmpdir(), "before-cleanup-"));
		mkdirSync(path.join(folder, "meta"));
		const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
			entries: {tag: string}[];
		};
		// Drizzle skips any migration older than the newest applied one, so stop before the cleanup, not just without it.
		const entries = journal.entries.slice(
			0,
			journal.entries.findIndex((entry) => entry.tag === "0002_close_system_target_placeholders"),
		);
		writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({...journal, entries}));
		for (const {tag} of entries) {
			copyFileSync(path.join(migrationsFolder, `${tag}.sql`), path.join(folder, `${tag}.sql`));
		}
		return folder;
	}

	describe("system target placeholder migration", () => {
		it("closes the current blank node row a cached 'inbox' child list left at Home, and nothing else", () => {
			const sqlite = new DatabaseConstructor(":memory:");
			migrate(drizzle(sqlite), {migrationsFolder: beforeCleanupFolder()});
			sqlite.exec(`
			INSERT INTO node_content (id, name, note, parent_id, system_from, system_to) VALUES
				('inbox', NULL, NULL, NULL, '2026-11-02 20:43:19.861', '${FAR_FUTURE}'),
				('c1e6ea1d-3a54-4206-9ea6-41bd95477fbc', 'Inbox', NULL, NULL, '2026-10-01 00:00:00.000', '${FAR_FUTURE}');
			INSERT INTO node_metadata (node_id, short_id, system_from, system_to) VALUES
				('inbox', 'inbox', '2026-11-02 20:43:19.861', '${FAR_FUTURE}'),
				('c1e6ea1d-3a54-4206-9ea6-41bd95477fbc', '41bd95477fbc', '2026-10-01 00:00:00.000', '${FAR_FUTURE}');
		`);

			migrate(drizzle(sqlite), {migrationsFolder});

			expect({
				content: sqlite.prepare("SELECT id, system_from, system_to FROM node_content ORDER BY id").all(),
				metadata: sqlite
					.prepare("SELECT node_id, system_from, system_to FROM node_metadata ORDER BY node_id")
					.all(),
			}).toStrictEqual({
				content: [
					{
						id: "c1e6ea1d-3a54-4206-9ea6-41bd95477fbc",
						system_from: "2026-10-01 00:00:00.000",
						system_to: FAR_FUTURE,
					},
					{id: "inbox", system_from: "2026-11-02 20:43:19.861", system_to: "2026-11-02 20:43:19.861"},
				],
				metadata: [
					{
						node_id: "c1e6ea1d-3a54-4206-9ea6-41bd95477fbc",
						system_from: "2026-10-01 00:00:00.000",
						system_to: FAR_FUTURE,
					},
					{node_id: "inbox", system_from: "2026-11-02 20:43:19.861", system_to: "2026-11-02 20:43:19.861"},
				],
			});
		});
	});
});

describe("system time", () => {
	const migrationsFolder = join(import.meta.dirname, "../src/db/migrations");

	function apiNode(id: string, name: string): WorkflowyNode {
		return {id, name, priority: 0, createdAt: 1_767_225_600, modifiedAt: 1_767_225_600};
	}

	describe("one application UTC system time per unit of work", () => {
		let tempDir: string;
		let connections: DatabaseConstructor.Database[];

		beforeEach(() => {
			tempDir = fs.mkdtempSync(join(os.tmpdir(), "outlinedb-system-time-test-"));
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
});
