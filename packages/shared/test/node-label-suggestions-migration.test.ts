import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

describe("node_label_suggestions migration", () => {
	it("creates the temporal label-suggestion table with its key, live-row unique index, and closed-row partial index", () => {
		const sqlite = new DatabaseConstructor(":memory:");
		try {
			migrate(drizzle(sqlite), {migrationsFolder});

			expect({
				columns: sqlite
					.prepare(
						"SELECT name, type, \"notnull\", pk FROM pragma_table_info('node_label_suggestions') ORDER BY cid",
					)
					.all(),
				indexes: sqlite
					.prepare(
						"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'node_label_suggestions' AND sql IS NOT NULL ORDER BY name",
					)
					.all(),
			}).toStrictEqual({
				columns: [
					{name: "node_id", type: "TEXT", notnull: 1, pk: 1},
					{name: "label", type: "TEXT", notnull: 1, pk: 2},
					{name: "label_kind", type: "TEXT", notnull: 1, pk: 0},
					{name: "source", type: "TEXT", notnull: 1, pk: 3},
					{name: "score", type: "REAL", notnull: 1, pk: 0},
					{name: "content_from", type: "TEXT", notnull: 1, pk: 0},
					{name: "system_from", type: "TEXT", notnull: 1, pk: 4},
					{name: "system_to", type: "TEXT", notnull: 1, pk: 0},
				],
				indexes: [
					{
						name: "node_label_suggestions_closed_at_idx",
						sql: "CREATE INDEX `node_label_suggestions_closed_at_idx` ON `node_label_suggestions` (`system_to`) WHERE system_to < '9999-12-31 23:59:59'",
					},
					{
						name: "node_label_suggestions_system_to_idx",
						sql: "CREATE UNIQUE INDEX `node_label_suggestions_system_to_idx` ON `node_label_suggestions` (`node_id`,`label`,`source`,`system_to`)",
					},
				],
			});
		} finally {
			sqlite.close();
		}
	});
});
