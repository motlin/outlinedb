import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");
const FAR_FUTURE = "9999-12-31 23:59:59";

/** A folder holding every migration before the placeholder cleanup, so a database can be migrated to that point. */
function beforeCleanupFolder(): string {
	const folder = mkdtempSync(path.join(tmpdir(), "before-cleanup-"));
	mkdirSync(path.join(folder, "meta"));
	const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
		entries: {tag: string}[];
	};
	const entries = journal.entries.filter((entry) => entry.tag !== "0002_close_system_target_placeholders");
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
