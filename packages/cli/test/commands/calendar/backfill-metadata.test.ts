import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {captureOutput} from "@oclif/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readAccountSnapshot, readPendingAccountOutbox} from "@outlinedb/shared/cache";
import CalendarBackfillMetadata from "../../../src/commands/calendar/backfill-metadata.js";
import {cleanupTestDatabase, createTestDatabase} from "../../db/migration-helper.js";
import type {TestDatabase} from "../../db/migration-helper.js";
import {fakeUpstream} from "../../helpers/upstream-outbox.js";

describe("calendar backfill-metadata command", () =>
{
	let originalEnv: typeof process.env;
	let tempDir: string;
	let testDatabase: TestDatabase;

	beforeEach(() =>
	{
		originalEnv =
		{
			...process.env,
		};
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-calendar-backfill-test-"));
		const testDbPath = path.join(tempDir, "test.sqlite");
		testDatabase = createTestDatabase(testDbPath);
		process.env.OUTLINEDB_DB_PATH = testDbPath;
		delete process.env.WORKFLOWY_USERNAME;
		delete process.env.WORKFLOWY_PASSWORD;
		delete process.env.OUTLINEDB_SESSION_FILE;
		process.env.WORKFLOWY_API_KEY = "test-api-key";
	});

	afterEach(() =>
	{
		vi.restoreAllMocks();
		process.env = originalEnv;
		cleanupTestDatabase(testDatabase);
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("runs the flag-gated backfills locally, prints the result, and keeps the flags pending when workflowy.com rejects the drain", async () =>
	{
		const upstream = fakeUpstream(
			vi.spyOn(globalThis, "fetch"),
			testDatabase,
			tempDir,
			{
				failPush: true,
			},
		);

		const {stdout, error} = await captureOutput(async () =>
		{
			await CalendarBackfillMetadata.run(["--json"]);
		});

		expect(
			{
				out: JSON.parse(stdout),
				exit: error?.oclif?.exit,
				pushes: upstream.pushes,
				pending: readPendingAccountOutbox(testDatabase.db).map(({subject, key}) => [
					subject,
					key.replaceAll("\u001F", "."),
				]),
				calendar: readAccountSnapshot(testDatabase.db)?.rootMetadata.calendar,
			},
		).toStrictEqual(
			{
				out:
				{
					timestamps: [],
					dateIds: [],
				},
				exit: 1,
				pushes: [],
				pending: [
					["root_metadata", "calendar.ts_added_v2"],
					["root_metadata", "calendar.dateId_added_v1"],
				],
				calendar:
				{
					ts_added_v2: true,
					dateId_added_v1: true,
				},
			},
		);
	});

	it("errors before any write without internal auth", async () =>
	{
		process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "no-session.json");

		const {error} = await captureOutput(async () =>
		{
			await CalendarBackfillMetadata.run([]);
		});

		expect(
			{
				message: error?.message,
				pending: readPendingAccountOutbox(testDatabase.db),
			},
		).toStrictEqual(
			{
				message:
					"Writing needs the internal API to deliver the write to workflowy.com: set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD (e.g. from .envrc), or run 'internal login'.",
				pending: [],
			},
		);
	});
});
