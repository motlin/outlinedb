import DatabaseConstructor from "better-sqlite3";
import {Command, Flags} from "@oclif/core";
import {ACCOUNT_COMPOSITE_TABLES, ACCOUNT_IMPORT_NAME, EXPANDED_NODES_IMPORT_NAME} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {account, apiImportTimestamp, fileBlobs} from "@outlinedb/shared/db";
import {getTableName, inArray} from "drizzle-orm";
import type {SQLiteTable} from "drizzle-orm/sqlite-core";
import {drizzle} from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import {createDatabase} from "../../db/index.js";

export interface ImportLocalStateResult {
	/** Rows copied per account table (every version, so the account's history carries over). */
	accountTables: Record<string, number>;
	/** file_blobs rows copied, every version. */
	fileBlobs: number;
}

/** The `api_import_timestamp` rows that belong to the account tables. */
const ACCOUNT_IMPORT_NAMES = [ACCOUNT_IMPORT_NAME, EXPANDED_NODES_IMPORT_NAME];

/** Keeps each statement well under SQLite's bound-parameter limit. */
const ROWS_PER_INSERT = 50;

export default class ImportLocalState extends Command {
	static override enableJsonFlag = true;

	static override description =
		"Copy the state no Workflowy backup can rebuild from an old cache database, opened read-only, into this one: every version of the account tables and file_blobs (so their history carries over). Run it on a new database before import-api and import-account, which then merge the current values on top";

	static override examples = ["<%= config.bin %> cache:import-local-state --from outlinedb.pre-rebuild.sqlite"];

	static override flags = {
		from: Flags.string({description: "Old cache database to copy from (opened read-only)", required: true}),
	};

	public async run(): Promise<ImportLocalStateResult> {
		const {flags} = await this.parse(ImportLocalState);
		if (!fs.existsSync(flags.from)) {
			this.error(`Old database not found: ${flags.from}`);
		}
		const database = createDatabase();
		const occupied = [...ACCOUNT_COMPOSITE_TABLES, fileBlobs].filter(
			(table) => database.select().from(table).limit(1).all().length > 0,
		);
		if (occupied.length > 0) {
			this.error(
				`The local-state tables already hold rows (${occupied.map((table) => getTableName(table)).join(", ")}); run import-local-state on a new database, before import-api and import-account`,
			);
		}

		const sqlite = new DatabaseConstructor(flags.from, {readonly: true, fileMustExist: true});
		const migrated =
			sqlite
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(getTableName(account)) !== undefined &&
			sqlite
				.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'system_from'")
				.get(getTableName(fileBlobs)) !== undefined;
		if (!migrated) {
			sqlite.close();
			this.error(
				`${flags.from} predates the current schema; migrate it first by opening it once: WORKFLOWY_DB_PATH=${flags.from} ./bin/run.js cache status`,
			);
		}
		let accountRows: [SQLiteTable, Record<string, unknown>[]][];
		let importRows: (typeof apiImportTimestamp.$inferSelect)[];
		let blobRows: (typeof fileBlobs.$inferSelect)[];
		try {
			const old = drizzle(sqlite, {schema});
			accountRows = ACCOUNT_COMPOSITE_TABLES.map((table) => [table, old.select().from(table).all()]);
			importRows = old
				.select()
				.from(apiImportTimestamp)
				.where(inArray(apiImportTimestamp.name, ACCOUNT_IMPORT_NAMES))
				.all();
			blobRows = old.select().from(fileBlobs).all();
		} finally {
			sqlite.close();
		}

		database.transaction((tx) => {
			for (const [table, rows] of accountRows) {
				for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
					tx.insert(table)
						.values(rows.slice(start, start + ROWS_PER_INSERT))
						.run();
				}
			}
			tx.delete(apiImportTimestamp).where(inArray(apiImportTimestamp.name, ACCOUNT_IMPORT_NAMES)).run();
			if (importRows.length > 0) {
				tx.insert(apiImportTimestamp).values(importRows).run();
			}
			for (let start = 0; start < blobRows.length; start += ROWS_PER_INSERT) {
				tx.insert(fileBlobs)
					.values(blobRows.slice(start, start + ROWS_PER_INSERT))
					.run();
			}
		});

		const result = {
			accountTables: Object.fromEntries(accountRows.map(([table, rows]) => [getTableName(table), rows.length])),
			fileBlobs: blobRows.length,
		};
		const accountTotal = Object.values(result.accountTables).reduce((sum, count) => sum + count, 0);
		this.log(`Carried over ${accountTotal} account-table rows and ${result.fileBlobs} file_blobs rows`);
		return result;
	}
}
