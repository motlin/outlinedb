import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {ACCOUNT_COMPOSITE_TABLES} from "@outlinedb/shared/cache";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ImportAccount from "../../../src/commands/cache/import-account.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";

const ENV_KEYS = ["OUTLINEDB_DB_PATH", "WORKFLOWY_USERNAME", "WORKFLOWY_PASSWORD", "OUTLINEDB_SESSION_FILE"];

describe("cache:import-account command", () =>
{
	let tempDir: string;
	let testDatabase: TestDatabase;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() =>
	{
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-import-account-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		for (const key of ENV_KEYS)
		{
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "no-session");
	});

	afterEach(() =>
	{
		cleanupTestDatabase(testDatabase);
		for (const [key, value] of Object.entries(savedEnv))
		{
			if (value === undefined)
			{
				Reflect.deleteProperty(process.env, key);
			}
			else
			{
				process.env[key] = value;
			}
		}
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("fails without touching the account tables when no internal-API credentials or session are configured", async () =>
	{
		const {error} = await captureOutput(async () => ImportAccount.run([]));

		expect(
			{
				message: error?.message,
				rows: ACCOUNT_COMPOSITE_TABLES.flatMap((table) => testDatabase.db.select().from(table).all()),
			},
		).toStrictEqual(
			{
				message:
					"Importing account state needs the internal API: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD (e.g. via op run)",
				rows: [],
			},
		);
	});
});
