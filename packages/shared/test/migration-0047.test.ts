import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "../src/db/schema.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");
const TAG = "0047_drop_virtual_root_ids_and_backlinks";
const FAR = "9999-12-31 23:59:59";
const SEEDED = "2026-10-01 00:00:00.000";

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

	it("drops virtual_root_ids and backlinks and keeps the mirrors and references_roots they duplicate", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-0047-"));
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: migrationsBefore(TAG, tempDir)});
		sqlite.exec(`
			INSERT INTO mirrors VALUES ('item', 'source', '${SEEDED}', '${FAR}');
			INSERT INTO references_roots VALUES ('refs', '${SEEDED}', '${FAR}');
			INSERT INTO backlinks VALUES ('item', 'source', 'target', '${SEEDED}', '${FAR}');
			INSERT INTO virtual_root_ids VALUES ('source', 'item', '${SEEDED}', '${FAR}');
		`);
		migrate(db, {migrationsFolder});

		expect({
			tables: sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE name IN ('backlinks', 'virtual_root_ids', 'mirrors', 'references_roots') ORDER BY name",
				)
				.all(),
			mirrors: sqlite.prepare("SELECT mirror_id, original_id FROM mirrors").all(),
			referencesRoots: sqlite.prepare("SELECT node_id FROM references_roots").all(),
		}).toStrictEqual({
			tables: [{name: "mirrors"}, {name: "references_roots"}],
			mirrors: [{mirror_id: "item", original_id: "source"}],
			referencesRoots: [{node_id: "refs"}],
		});
	});
});
