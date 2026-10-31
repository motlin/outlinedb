import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "../src/db/schema.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");
const TAG = "0046_make_file_blobs_temporal";

/** A copy of the migrations folder whose journal stops before `tag`. */
function migrationsBefore(tag: string, tempDir: string): string {
	fs.cpSync(migrationsFolder, tempDir, {recursive: true});
	const journalPath = path.join(tempDir, "meta/_journal.json");
	const journal: {entries: {tag: string}[]} = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	const index = journal.entries.findIndex((entry) => entry.tag === tag);
	if (index === -1) {
		throw new Error(`no migration ${tag}`);
	}
	fs.writeFileSync(journalPath, JSON.stringify({...journal, entries: journal.entries.slice(0, index)}));
	return tempDir;
}

describe(`migration ${TAG}`, () => {
	let tempDir: string | undefined;
	afterEach(() => {
		if (tempDir !== undefined) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	function migratedFrom(setup: (sqlite: DatabaseConstructor.Database) => void): DatabaseConstructor.Database {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-0046-"));
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: migrationsBefore(TAG, tempDir)});
		setup(sqlite);
		migrate(db, {migrationsFolder});
		return sqlite;
	}

	it("keeps each row as a live version whose system_from is its fetched_at, and drops fetched_at", () => {
		const sqlite = migratedFrom((db) => {
			db.prepare(
				`INSERT INTO file_blobs (node_id, status, sha256, size, content_type, local_path, error, fetched_at) VALUES
					('node-a', 'ok', 'abc', 3, 'image/png', 'blobs/ab/abc', NULL, 1790000000123),
					('node-b', 'error', NULL, NULL, NULL, NULL, 'HTTP 404 Not Found', 1790000000000)`,
			).run();
		});

		expect({
			columns: sqlite
				.prepare("SELECT name FROM pragma_table_info('file_blobs') ORDER BY cid")
				.all()
				.map((row) => (row as {name: string}).name),
			rows: sqlite.prepare("SELECT * FROM file_blobs ORDER BY node_id").all(),
		}).toStrictEqual({
			columns: [
				"node_id",
				"status",
				"sha256",
				"size",
				"content_type",
				"local_path",
				"error",
				"system_from",
				"system_to",
			],
			rows: [
				{
					node_id: "node-a",
					status: "ok",
					sha256: "abc",
					size: 3,
					content_type: "image/png",
					local_path: "blobs/ab/abc",
					error: null,
					system_from: "2026-09-21 14:13:20.123",
					system_to: "9999-12-31 23:59:59",
				},
				{
					node_id: "node-b",
					status: "error",
					sha256: null,
					size: null,
					content_type: null,
					local_path: null,
					error: "HTTP 404 Not Found",
					system_from: "2026-09-21 14:13:20.000",
					system_to: "9999-12-31 23:59:59",
				},
			],
		});
	});
});
