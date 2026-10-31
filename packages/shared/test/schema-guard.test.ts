import DatabaseConstructor from "better-sqlite3";
import type {Database} from "better-sqlite3";
import {runUnitOfWork} from "@workflowy/shared/cache";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {writeAccountSnapshot} from "../src/cache/account-store.js";
import {buildTestDb, bulkImportWithWatermarkGuard, loadFixtureBackup} from "./helpers/round-trip-helpers.js";

/**
 * Schema guard: every table is temporal and nothing stores JSON.
 *
 * Only derived or framework tables are exempt: the full-text index and its
 * shadow tables, the derived node_tags, and SQLite/Drizzle bookkeeping.
 */
const NON_TEMPORAL_ALLOWLIST = new Set(["__drizzle_migrations", "sqlite_sequence", "node_tags"]);

function isAllowlisted(table: string): boolean {
	return NON_TEMPORAL_ALLOWLIST.has(table) || table === "node_fts" || table.startsWith("node_fts_");
}

function tableNames(sqlite: Database): string[] {
	return sqlite
		.prepare<[], {name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row) => row.name);
}

function columns(sqlite: Database, table: string): {name: string; type: string}[] {
	return sqlite
		.prepare<[string], {name: string; type: string}>("SELECT name, type FROM pragma_table_info(?)")
		.all(table);
}

/** Tables outside the allowlist that lack system_from or system_to. */
function nonTemporalTables(sqlite: Database): string[] {
	return tableNames(sqlite)
		.filter((table) => !isAllowlisted(table))
		.filter((table) => {
			const names = new Set(columns(sqlite, table).map((column) => column.name));
			return !names.has("system_from") || !names.has("system_to");
		});
}

/** `table.column` for every column whose name ends in json, in any table. */
function jsonNamedColumns(sqlite: Database): string[] {
	return tableNames(sqlite).flatMap((table) =>
		columns(sqlite, table)
			.filter((column) => column.name.toLowerCase().endsWith("json"))
			.map((column) => `${table}.${column.name}`),
	);
}

/** `table.column` for every column outside the allowlist holding a value that starts with { or [. */
function jsonValuedColumns(sqlite: Database): string[] {
	return tableNames(sqlite)
		.filter((table) => !isAllowlisted(table))
		.flatMap((table) =>
			columns(sqlite, table)
				.filter((column) => {
					const quoted = `"${column.name.replaceAll('"', '""')}"`;
					const hit = sqlite
						.prepare(
							`SELECT 1 FROM "${table}" WHERE typeof(${quoted}) = 'text' AND (ltrim(${quoted}) LIKE '{%' OR ltrim(${quoted}) LIKE '[%') LIMIT 1`,
						)
						.get();
					return hit !== undefined;
				})
				.map((column) => `${table}.${column.name}`),
		);
}

describe("schema guard", () => {
	let open: Database[] = [];
	afterEach(() => {
		for (const sqlite of open) {
			sqlite.close();
		}
		open = [];
	});

	function seededDb(): Database {
		const {database, sqlite} = buildTestDb();
		open.push(sqlite);
		bulkImportWithWatermarkGuard(
			database,
			loadFixtureBackup("equivalence-backup"),
			new Date("2026-10-01T00:00:00Z"),
		);
		bulkImportWithWatermarkGuard(database, loadFixtureBackup("mirror-backup"), new Date("2026-10-02T00:00:00Z"));
		runUnitOfWork(database, (unitOfWork) => {
			writeAccountSnapshot(unitOfWork, {
				account: {userId: 107, dateJoinedSec: 1_324_752_241, fullName: "Alice Smith"},
				rootMetadata: {starring: {locations: {n1: "None", n2: "None"}, order: "None/n2/,None/n1/"}},
				settings: {theme: "dark", font: "default"},
				visibleFeatures: [],
			});
		});
		return sqlite;
	}

	it("gives every non-derived table system_from and system_to", () => {
		expect(nonTemporalTables(seededDb())).toStrictEqual([]);
	});

	it("names no column *json", () => {
		expect(jsonNamedColumns(seededDb())).toStrictEqual([]);
	});

	it("stores no value that starts with { or [", () => {
		expect(jsonValuedColumns(seededDb())).toStrictEqual([]);
	});

	it("flags a table without system time, a *_json column, and a JSON-shaped value", () => {
		const sqlite = new DatabaseConstructor(":memory:");
		open.push(sqlite);
		sqlite.exec(`
			CREATE TABLE plain (id TEXT PRIMARY KEY, payload_json TEXT);
			CREATE TABLE versioned (id TEXT, value TEXT, system_from TEXT NOT NULL, system_to TEXT NOT NULL);
			CREATE TABLE node_tags (node_id TEXT, tag TEXT);
			INSERT INTO plain VALUES ('a', 'x');
			INSERT INTO versioned VALUES ('a', ' [1, 2]', '2026-10-01', '9999-12-31');
			INSERT INTO node_tags VALUES ('a', '{derived}');
		`);

		expect({
			nonTemporal: nonTemporalTables(sqlite),
			jsonNamed: jsonNamedColumns(sqlite),
			jsonValued: jsonValuedColumns(sqlite),
		}).toStrictEqual({
			nonTemporal: ["plain"],
			jsonNamed: ["plain.payload_json"],
			jsonValued: ["versioned.value"],
		});
	});
});
