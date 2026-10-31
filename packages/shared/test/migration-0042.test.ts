import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as schema from "../src/db/schema.js";
import {FAR_FUTURE_DATE} from "../src/temporal/index.js";

const migrationsFolder = path.join(import.meta.dirname, "../src/db/migrations");

/** A copy of the migrations folder whose journal stops before `tag`. */
function migrationsBefore(tag: string, tempDir: string): string {
	fs.cpSync(migrationsFolder, tempDir, {recursive: true});
	const journalPath = path.join(tempDir, "meta/_journal.json");
	const journal: {entries: {tag: string}[]} = JSON.parse(fs.readFileSync(journalPath, "utf8"));
	const index = journal.entries.findIndex((entry) => entry.tag === tag);
	fs.writeFileSync(journalPath, JSON.stringify({...journal, entries: journal.entries.slice(0, index)}));
	return tempDir;
}

describe("migration 0042_replace_node_internal_metadata", () => {
	let tempDir: string | undefined;
	afterEach(() => {
		if (tempDir !== undefined) {
			fs.rmSync(tempDir, {recursive: true, force: true});
		}
	});

	it("backfills typed temporal rows from node_internal_metadata, re-versions differing calendar rows, and drops the JSON table", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-0042-"));
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder: migrationsBefore("0042_replace_node_internal_metadata", tempDir)});
		const insertJson = sqlite.prepare(
			"INSERT INTO node_internal_metadata (node_id, metadata_json, fetched_at) VALUES (?, ?, 0)",
		);
		insertJson.run("numbered", JSON.stringify({numbered_start: 5, layoutMode: "numbered"}));
		insertJson.run("bullets", JSON.stringify({layoutMode: "bullets"}));
		insertJson.run(
			"table",
			JSON.stringify({
				layoutMode: "table",
				table: {headers: true, skipHeaders: false, bg: "red", sizes: {c1: 200, c2: 80.5}},
			}),
		);
		insertJson.run("bottom", JSON.stringify({priority: {defaultToBottom: true}}));
		insertJson.run(
			"day",
			JSON.stringify({
				restorableUniqueNode: true,
				calendar: {level: "day", value: "5", timestamp: 1, dateId: 20_261_005},
			}),
		);
		insertJson.run(
			"root",
			JSON.stringify({
				calendar: {
					root: true,
					found_dates: true,
					day_prefix: false,
					levels: {day: true, year: true, month: true},
				},
			}),
		);
		insertJson.run(
			"same",
			JSON.stringify({calendar: {level: "year", value: "2026", timestamp: 0, dateId: 20_260_000}}),
		);
		const old = {systemFrom: "2026-01-01 00:00:00.000", systemTo: FAR_FUTURE_DATE};
		db.insert(schema.calendarMetadata)
			.values([
				{nodeId: "day", level: "day", value: "4", timestamp: 1, dateId: 20_261_004, ...old},
				{nodeId: "same", level: "year", value: "2026", timestamp: 0, dateId: 20_260_000, ...old},
				{nodeId: "backup-only", level: "month", value: "1", ...old},
			])
			.run();
		db.insert(schema.calendarLevels)
			.values({nodeId: "root", day: 1, week: 0, month: 1, year: 1, ...old})
			.run();

		migrate(db, {migrationsFolder});

		const live = (table: string) =>
			sqlite
				.prepare(`SELECT * FROM ${table} WHERE system_to = '${FAR_FUTURE_DATE}' ORDER BY 1, 2`)
				.all() as Record<string, unknown>[];
		const systemTimes = new Set(
			["node_display_metadata", "node_table_cell_sizes"].flatMap((table) =>
				live(table).map((row) => row.system_from),
			),
		);
		const [migratedAt] = systemTimes;
		const strip = (rows: Record<string, unknown>[]) =>
			rows.map(({system_from: systemFrom, system_to: _systemTo, ...row}) => ({
				...row,
				at: systemFrom === migratedAt ? "migration" : systemFrom,
			}));
		expect({
			systemTimes: systemTimes.size,
			display: strip(live("node_display_metadata")),
			sizes: strip(live("node_table_cell_sizes")),
			calendar: strip(live("calendar_metadata")),
			levels: strip(live("calendar_levels")),
			closedCalendar: sqlite
				.prepare(`SELECT node_id, value FROM calendar_metadata WHERE system_to = ?`)
				.all(migratedAt),
			jsonTable: sqlite
				.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'node_internal%' OR name LIKE 'migration_%'")
				.all(),
		}).toStrictEqual({
			systemTimes: 1,
			display: [
				{
					node_id: "bottom",
					numbered_start: null,
					restorable_unique_node: null,
					table_headers: null,
					table_skip_headers: null,
					table_bg: null,
					priority_default_to_bottom: 1,
					at: "migration",
				},
				{
					node_id: "day",
					numbered_start: null,
					restorable_unique_node: 1,
					table_headers: null,
					table_skip_headers: null,
					table_bg: null,
					priority_default_to_bottom: null,
					at: "migration",
				},
				{
					node_id: "numbered",
					numbered_start: 5,
					restorable_unique_node: null,
					table_headers: null,
					table_skip_headers: null,
					table_bg: null,
					priority_default_to_bottom: null,
					at: "migration",
				},
				{
					node_id: "table",
					numbered_start: null,
					restorable_unique_node: null,
					table_headers: 1,
					table_skip_headers: 0,
					table_bg: "red",
					priority_default_to_bottom: null,
					at: "migration",
				},
			],
			sizes: [
				{node_id: "table", cell_id: "c1", size: 200, at: "migration"},
				{node_id: "table", cell_id: "c2", size: 80.5, at: "migration"},
			],
			calendar: [
				{
					node_id: "backup-only",
					root: null,
					level: "month",
					value: "1",
					date_id: null,
					timestamp: null,
					found_dates: null,
					day_prefix: null,
					at: old.systemFrom,
				},
				{
					node_id: "day",
					root: null,
					level: "day",
					value: "5",
					date_id: 20_261_005,
					timestamp: 1,
					found_dates: null,
					day_prefix: null,
					at: "migration",
				},
				{
					node_id: "root",
					root: 1,
					level: null,
					value: null,
					date_id: null,
					timestamp: null,
					found_dates: 1,
					day_prefix: 0,
					at: "migration",
				},
				{
					node_id: "same",
					root: null,
					level: "year",
					value: "2026",
					date_id: 20_260_000,
					timestamp: 0,
					found_dates: null,
					day_prefix: null,
					at: old.systemFrom,
				},
			],
			levels: [{node_id: "root", day: 1, week: null, month: 1, year: 1, at: "migration"}],
			closedCalendar: [{node_id: "day", value: "4"}],
			jsonTable: [],
		});
		sqlite.close();
	});
});
