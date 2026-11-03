import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

/** The (key, system_to) indexes that databases migrated before the 0000 baseline still have as non-unique. */
const LEGACY_NON_UNIQUE: Record<string, string> = {
	ai_metadata_system_to_idx: "ai_metadata (node_id, system_to)",
	backup_imports_system_to_idx: "backup_imports (filename, system_to)",
	calendar_levels_system_to_idx: "calendar_levels (node_id, system_to)",
	changes_metadata_system_to_idx: "changes_metadata (node_id, system_to)",
	node_embeddings_system_to_idx: "node_embeddings (node_id, model, system_to)",
	node_metadata_system_to_idx: "node_metadata (node_id, system_to)",
	references_roots_system_to_idx: "references_roots (node_id, system_to)",
	s3_files_system_to_idx: "s3_files (node_id, system_to)",
};

/** A folder holding only the 0000 baseline, so a database can be migrated to exactly that point. */
function baselineOnlyFolder(): string {
	const folder = mkdtempSync(path.join(tmpdir(), "baseline-only-"));
	mkdirSync(path.join(folder, "meta"));
	const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
		entries: {tag: string}[];
	};
	const baseline = {...journal, entries: journal.entries.filter((entry) => entry.tag === "0000_initial")};
	writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(baseline));
	copyFileSync(path.join(migrationsFolder, "0000_initial.sql"), path.join(folder, "0000_initial.sql"));
	return folder;
}

function indexes(sqlite: DatabaseConstructor.Database) {
	return sqlite
		.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
		.all() as {name: string; sql: string}[];
}

/** A database shaped like one that ran the old 0000-0050 chain: non-unique system_to indexes and overlapping rows. */
function legacyDatabase() {
	const sqlite = new DatabaseConstructor(":memory:");
	migrate(drizzle(sqlite), {migrationsFolder: baselineOnlyFolder()});
	for (const [name, target] of Object.entries(LEGACY_NON_UNIQUE)) {
		sqlite.exec(`DROP INDEX ${name}; CREATE INDEX ${name} ON ${target};`);
	}
	sqlite.exec(`
		DROP INDEX mirrors_system_to_idx;
		DROP INDEX calendar_metadata_system_to_idx;
		CREATE INDEX calendar_metadata_new_system_to_idx ON calendar_metadata (node_id, system_to);
		INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES
			('m1', 'o1', '2026-10-29 20:02:08.971', '2026-10-29 20:05:35.365'),
			('m1', 'o1', '2026-10-29 20:02:09.019', '2026-10-29 20:05:35.365'),
			('m1', 'o1', '2026-10-29 20:03:00.000', '2026-10-29 20:05:35.365'),
			('m2', 'o2', '2026-10-29 20:00:00.000', '9999-12-31 23:59:59');
		INSERT INTO references_roots (node_id, system_from, system_to) VALUES
			('r1', '2026-10-29 20:02:08.971', '2026-10-29 20:13:30.705'),
			('r1', '2026-10-29 20:02:09.019', '2026-10-29 20:13:30.705');
	`);
	return sqlite;
}

describe("unique system_to migration", () => {
	it("gives a database migrated before the baseline the same indexes a fresh database gets", () => {
		const fresh = new DatabaseConstructor(":memory:");
		migrate(drizzle(fresh), {migrationsFolder});
		const legacy = legacyDatabase();

		migrate(drizzle(legacy), {migrationsFolder});

		expect(indexes(legacy)).toStrictEqual(indexes(fresh));
	});

	it("closes each overlapping version at the next one's system_from instead of failing on duplicates", () => {
		const legacy = legacyDatabase();

		migrate(drizzle(legacy), {migrationsFolder});

		expect({
			mirrors: legacy.prepare("SELECT * FROM mirrors ORDER BY mirror_id, system_from").all(),
			referencesRoots: legacy.prepare("SELECT * FROM references_roots ORDER BY system_from").all(),
		}).toStrictEqual({
			mirrors: [
				{
					mirror_id: "m1",
					original_id: "o1",
					system_from: "2026-10-29 20:02:08.971",
					system_to: "2026-10-29 20:02:09.019",
				},
				{
					mirror_id: "m1",
					original_id: "o1",
					system_from: "2026-10-29 20:02:09.019",
					system_to: "2026-10-29 20:03:00.000",
				},
				{
					mirror_id: "m1",
					original_id: "o1",
					system_from: "2026-10-29 20:03:00.000",
					system_to: "2026-10-29 20:05:35.365",
				},
				{
					mirror_id: "m2",
					original_id: "o2",
					system_from: "2026-10-29 20:00:00.000",
					system_to: "9999-12-31 23:59:59",
				},
			],
			referencesRoots: [
				{node_id: "r1", system_from: "2026-10-29 20:02:08.971", system_to: "2026-10-29 20:02:09.019"},
				{node_id: "r1", system_from: "2026-10-29 20:02:09.019", system_to: "2026-10-29 20:13:30.705"},
			],
		});
	});
});
