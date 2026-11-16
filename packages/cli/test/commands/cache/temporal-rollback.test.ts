import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {ACCOUNT_COMPOSITE_TABLES} from "@outlinedb/shared/cache";
import {rootPreferences} from "@outlinedb/shared/db";
import {captureOutput} from "@oclif/test";
import {getTableName} from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TemporalRollback, {TEMPORAL_TABLES} from "../../../src/commands/cache/temporal-rollback.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {FAR_FUTURE_DATE, systemTimeAt} from "@outlinedb/shared/temporal";

describe("cache:temporal-rollback command", () =>
{
	let tempDir: string;
	let testDatabase: TestDatabase;
	let originalDbPath: string | undefined;

	beforeEach(() =>
	{
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-rollback-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		originalDbPath = process.env.OUTLINEDB_DB_PATH;
		process.env.OUTLINEDB_DB_PATH = testDbPath;
	});

	afterEach(() =>
	{
		cleanupTestDatabase(testDatabase);
		if (originalDbPath === undefined)
		{
			delete process.env.OUTLINEDB_DB_PATH;
		}
		else
		{
			process.env.OUTLINEDB_DB_PATH = originalDbPath;
		}
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("rolls back every account table with the tree", () =>
	{
		const names = new Set<string>(TEMPORAL_TABLES);

		expect(
			ACCOUNT_COMPOSITE_TABLES.map((table) => getTableName(table)).filter((name) => !names.has(name)),
		).toStrictEqual([]);
	});

	it("rolls back every table with a system_to column", () =>
	{
		const temporal = testDatabase.sqlite
			.prepare(
				"SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'system_to' ORDER BY m.name",
			)
			.all()
			.map(
				(row) =>
					(
						row as
						{
							name: string;
						}
					).name,
			);

		expect(temporal.filter((name) => !(TEMPORAL_TABLES as readonly string[]).includes(name))).toStrictEqual([]);
	});

	// Readable UTC text, and the ISO text `cache status` and node JSON print, so output pastes back as a target.
	it.each(["2026-01-15 00:00:00", "2026-01-15T00:00:00.000000Z"])(
		"restores a preference to its value as of the target time %s",
		async (to) =>
		{
			testDatabase.db
				.insert(rootPreferences)
				.values([
					{
						userId: "1",
						dateFormat: "YYYY",
						systemFrom: systemTimeAt("2026-01-01 00:00:00.000"),
						systemTo: systemTimeAt("2026-02-01 00:00:00.000"),
					},
					{
						userId: "1",
						dateFormat: "MMM D",
						systemFrom: systemTimeAt("2026-02-01 00:00:00.000"),
						systemTo: FAR_FUTURE_DATE,
					},
				])
				.run();

			await captureOutput(async () => TemporalRollback.run(["--to", to, "--yes"]));

			expect(
				testDatabase.db
					.select(
						{
							dateFormat: rootPreferences.dateFormat,
							systemTo: rootPreferences.systemTo,
						},
					)
					.from(rootPreferences)
					.all(),
			).toStrictEqual([
				{
					dateFormat: "YYYY",
					systemTo: FAR_FUTURE_DATE,
				},
			]);
		},
	);
});
