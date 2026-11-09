import {inject} from "vite-plus/test";
import * as schema from "@outlinedb/shared/db";
import type {
	NewAiMetadata,
	NewBackupImport,
	NewChangesMetadata,
	NewMirror,
	NewNodeContent,
	NewNodeMetadata,
	NewReferencesRoot,
	NewS3File,
} from "@outlinedb/shared/db";
import {splitNodeIntoContentAndMetadata} from "../helpers/node-fixtures.js";
import type {TestNode} from "../helpers/node-fixtures.js";
import type Database from "better-sqlite3";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import {createDatabase} from "../../src/db/index.js";

export interface TestDatabase {
	db: BetterSQLite3Database<typeof schema>;
	sqlite: Database.Database;
	path: string;
}

export interface TestFixtures {
	nodeContent?: NewNodeContent[];
	nodeMetadata?: NewNodeMetadata[];
	mirrors?: NewMirror[];
	aiMetadata?: NewAiMetadata[];
	s3Files?: NewS3File[];
	changesMetadata?: NewChangesMetadata[];
	referencesRoots?: NewReferencesRoot[];
	backupImports?: NewBackupImport[];
}

/**
 * Split combined test nodes into the `nodeContent` and `nodeMetadata` rows they are stored as.
 */
export function nodeFixtures(nodes: TestNode[]): Required<Pick<TestFixtures, "nodeContent" | "nodeMetadata">> {
	const split = nodes.map((node) => splitNodeIntoContentAndMetadata(node));
	return {nodeContent: split.map(({content}) => content), nodeMetadata: split.map(({metadata}) => metadata)};
}

/**
 * Create a test database with migrations applied
 */
export function createTestDatabase(dbPath = ":memory:"): TestDatabase {
	// Starting from the run-wide template (see test/setup/migrated-template.ts) makes drizzle's migrate() a no-op.
	const template = inject("migratedDatabaseTemplate");
	if (dbPath !== ":memory:") {
		fs.copyFileSync(template, dbPath);
	}

	const db = createDatabase(dbPath === ":memory:" ? fs.readFileSync(template) : dbPath);

	return {db, sqlite: db.$client, path: dbPath};
}

/**
 * Create an in-memory test database
 */
export function createInMemoryTestDatabase(): TestDatabase {
	return createTestDatabase(":memory:");
}

/**
 * Clean up a test database
 */
export function cleanupTestDatabase(testDb: TestDatabase): void {
	testDb.sqlite.close();
	if (testDb.path !== ":memory:" && fs.existsSync(testDb.path)) {
		fs.unlinkSync(testDb.path);
	}
}

/**
 * Clear all tables in the test database.
 * Disables foreign keys temporarily to avoid constraint violations.
 */
function clearAllTables(testDb: TestDatabase): void {
	testDb.sqlite.exec("PRAGMA foreign_keys = OFF");

	testDb.db.delete(schema.nodeEmbeddings).run();
	testDb.db.delete(schema.aiMetadata).run();
	testDb.db.delete(schema.s3Files).run();
	testDb.db.delete(schema.changesMetadata).run();
	testDb.db.delete(schema.referencesRoots).run();
	testDb.db.delete(schema.mirrors).run();
	testDb.db.delete(schema.nodeContent).run();
	testDb.db.delete(schema.nodeMetadata).run();
	testDb.db.delete(schema.backupImports).run();

	testDb.sqlite.exec("PRAGMA foreign_keys = ON");
}

/**
 * Seed test data into the database.
 * Clears existing data first, then inserts fixtures.
 */
export function seedTestData(testDb: TestDatabase, fixtures: TestFixtures): void {
	clearAllTables(testDb);

	if (fixtures.nodeContent && fixtures.nodeContent.length > 0) {
		testDb.db.insert(schema.nodeContent).values(fixtures.nodeContent).run();
	}

	if (fixtures.nodeMetadata && fixtures.nodeMetadata.length > 0) {
		testDb.db.insert(schema.nodeMetadata).values(fixtures.nodeMetadata).run();
	}

	if (fixtures.mirrors && fixtures.mirrors.length > 0) {
		testDb.db.insert(schema.mirrors).values(fixtures.mirrors).run();
	}

	if (fixtures.aiMetadata && fixtures.aiMetadata.length > 0) {
		testDb.db.insert(schema.aiMetadata).values(fixtures.aiMetadata).run();
	}

	if (fixtures.s3Files && fixtures.s3Files.length > 0) {
		testDb.db.insert(schema.s3Files).values(fixtures.s3Files).run();
	}

	if (fixtures.changesMetadata && fixtures.changesMetadata.length > 0) {
		testDb.db.insert(schema.changesMetadata).values(fixtures.changesMetadata).run();
	}

	if (fixtures.referencesRoots && fixtures.referencesRoots.length > 0) {
		testDb.db.insert(schema.referencesRoots).values(fixtures.referencesRoots).run();
	}

	if (fixtures.backupImports && fixtures.backupImports.length > 0) {
		testDb.db.insert(schema.backupImports).values(fixtures.backupImports).run();
	}
}
