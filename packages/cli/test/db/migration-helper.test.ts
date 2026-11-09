import {beforeEach, afterEach, describe, expect, inject, it} from "vite-plus/test";
import Database from "better-sqlite3";
import {nodeContent} from "@outlinedb/shared/db";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createTestNode} from "../helpers/node-fixtures.js";
import {
	cleanupTestDatabase,
	createInMemoryTestDatabase,
	createTestDatabase,
	nodeFixtures,
	seedTestData,
} from "./migration-helper.js";

/**
 * Guards the contract every database-backed test leans on. The helper reuses a
 * migrated template file rather than replaying the migrations per test, so these
 * assertions pin down that the reused schema is complete, empty, and isolated.
 */
describe("migration-helper", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-helper-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	function tableNames(database: ReturnType<typeof createTestDatabase>): string[] {
		return database.sqlite
			.prepare<[], {name: string}>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
			.all()
			.map((row) => row.name);
	}

	it("applies every migration to a file database", () => {
		const database = createTestDatabase(path.join(tempDir, "schema.sqlite"));

		try {
			const names = tableNames(database);
			expect(names).toContain("node_content");
			expect(names).toContain("node_metadata");
			expect(names).toContain("s3_files");
			expect(names).toContain("mirrors");
			// A vec0 virtual table: proves the sqlite-vec extension loaded against
			// the reused schema, not just that the tables were copied.
			expect(names).toContain("node_embeddings");
			expect(database.db.select().from(nodeContent).all()).toStrictEqual([]);
		} finally {
			cleanupTestDatabase(database);
		}
	});

	it("drops the dead local tags table, since tag colors live in root metadata.color.tags", () => {
		const database = createTestDatabase(path.join(tempDir, "schema.sqlite"));

		try {
			expect(tableNames(database).filter((name) => name === "tags")).toStrictEqual([]);
		} finally {
			cleanupTestDatabase(database);
		}
	});

	it("migrates the shared template once per run in global setup, before any test file opens a database", () => {
		// With per-file module isolation a module-level cache rebuilt the template in every database-backed file,
		// replaying all migrations inside the first beforeEach; under a loaded parallel run that blew the 10s hook timeout.
		const templatePath = inject("migratedDatabaseTemplate");
		const journal: {entries: unknown[]} = JSON.parse(
			fs.readFileSync(
				path.join(import.meta.dirname, "../../../shared/dist/db/migrations/meta/_journal.json"),
				"utf8",
			),
		);
		const template = new Database(templatePath, {readonly: true});
		try {
			expect(
				template.prepare<[], {count: number}>("SELECT count(*) AS count FROM __drizzle_migrations").get(),
			).toStrictEqual({count: journal.entries.length});
		} finally {
			template.close();
		}
	});

	it("applies every migration to an in-memory database", () => {
		const database = createInMemoryTestDatabase();

		try {
			expect(tableNames(database)).toContain("node_content");
			expect(database.db.select().from(nodeContent).all()).toStrictEqual([]);
		} finally {
			cleanupTestDatabase(database);
		}
	});

	it("isolates each database from the others", () => {
		const first = createTestDatabase(path.join(tempDir, "first.sqlite"));
		const second = createTestDatabase(path.join(tempDir, "second.sqlite"));

		try {
			seedTestData(first, nodeFixtures([createTestNode({id: "only-in-first", name: "First", parentId: null})]));

			expect(
				first.db
					.select()
					.from(nodeContent)
					.all()
					.map((row) => row.id),
			).toStrictEqual(["only-in-first"]);
			expect(second.db.select().from(nodeContent).all()).toStrictEqual([]);
		} finally {
			cleanupTestDatabase(first);
			cleanupTestDatabase(second);
		}
	});

	it("splits test nodes into nodeContent and nodeMetadata fixtures", () => {
		const node = createTestNode({
			id: "split-id",
			shortId: "split",
			name: "Split",
			note: "Note",
			parentId: "parent",
		});

		expect(nodeFixtures([node])).toStrictEqual({
			nodeContent: [
				{
					id: "split-id",
					name: "Split",
					note: "Note",
					parentId: "parent",
					systemFrom: node.systemFrom,
					systemTo: node.systemTo,
				},
			],
			nodeMetadata: [
				{
					nodeId: "split-id",
					shortId: "split",
					priority: node.priority,
					createdAt: node.createdAt,
					modifiedAt: node.modifiedAt,
					completedAt: node.completedAt,
					layoutMode: node.layoutMode,
					systemFrom: node.systemFrom,
					systemTo: node.systemTo,
				},
			],
		});
	});

	it("leaves no journal sidecar files behind after cleanup", () => {
		const database = createTestDatabase(path.join(tempDir, "sidecars.sqlite"));
		seedTestData(database, nodeFixtures([createTestNode({id: "node", name: "Node", parentId: null})]));
		cleanupTestDatabase(database);

		expect(fs.readdirSync(tempDir)).toStrictEqual([]);
	});
});
