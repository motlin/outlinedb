import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "../src/db/schema.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");
const TAG = "0045_drop_config";

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
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-0045-"));
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: migrationsBefore(TAG, tempDir)});
		setup(sqlite);
		migrate(db, {migrationsFolder});
		return sqlite;
	}

	const accountRows = (sqlite: DatabaseConstructor.Database) =>
		sqlite
			.prepare("SELECT user_id, full_name, date_joined_sec, entropy_key, username, email, system_to FROM account")
			.all();
	const configTable = (sqlite: DatabaseConstructor.Database) =>
		sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'config'").all();

	it("moves config.workflowy_epoch into a placeholder account row when none exists, then drops config", () => {
		const sqlite = migratedFrom((db) => {
			db.prepare(
				"INSERT INTO config (key, value, created_at, updated_at) VALUES ('workflowy_epoch', '1324752241', 'x', 'x')",
			).run();
		});

		expect({account: accountRows(sqlite), config: configTable(sqlite)}).toStrictEqual({
			account: [
				{
					user_id: 0,
					full_name: null,
					date_joined_sec: 1_324_752_241,
					entropy_key: null,
					username: null,
					email: null,
					system_to: "9999-12-31 23:59:59",
				},
			],
			config: [],
		});
	});

	it("keeps an existing live account row as is, then drops config", () => {
		const sqlite = migratedFrom((db) => {
			db.prepare(
				"INSERT INTO config (key, value, created_at, updated_at) VALUES ('workflowy_epoch', '1', 'x', 'x')",
			).run();
			db.prepare(
				"INSERT INTO account (user_id, full_name, date_joined_sec, system_from, system_to) VALUES (107, 'Alice Smith', 1324752241, '2026-10-01 00:00:00.000', '9999-12-31 23:59:59')",
			).run();
		});

		expect({account: accountRows(sqlite), config: configTable(sqlite)}).toStrictEqual({
			account: [
				{
					user_id: 107,
					full_name: "Alice Smith",
					date_joined_sec: 1_324_752_241,
					entropy_key: null,
					username: null,
					email: null,
					system_to: "9999-12-31 23:59:59",
				},
			],
			config: [],
		});
	});

	it("drops an empty config without creating an account row", () => {
		const sqlite = migratedFrom(() => {});

		expect({account: accountRows(sqlite), config: configTable(sqlite)}).toStrictEqual({account: [], config: []});
	});
});
